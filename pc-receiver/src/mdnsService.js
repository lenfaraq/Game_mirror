const dgram = require('node:dgram');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const MDNS_MULTICAST_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE_TYPE = '_gamestream._tcp.local';
const DNS_SD_SERVICES = '_services._dns-sd._udp.local';

function encodeDnsName(name) {
  const clean = name.replace(/\.$/, '');
  if (!clean) return Buffer.from([0]);
  const labels = clean.split('.');
  const parts = [];
  for (const label of labels) {
    const buf = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([buf.length]), buf);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function decodeDnsName(buffer, offset) {
  const labels = [];
  let pos = offset;
  let jumped = false;
  let nextOffset = offset;
  let safety = 0;

  while (pos < buffer.length && safety++ < 64) {
    const len = buffer[pos];
    if (len === 0) {
      if (!jumped) nextOffset = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buffer.length) break;
      if (!jumped) nextOffset = pos + 2;
      pos = ((len & 0x3f) << 8) | buffer[pos + 1];
      jumped = true;
      continue;
    }
    pos += 1;
    if (pos + len > buffer.length) break;
    labels.push(buffer.subarray(pos, pos + len).toString('utf8'));
    pos += len;
    if (!jumped) nextOffset = pos;
  }

  return {
    name: labels.join('.'),
    nextOffset
  };
}

function encodeResourceRecord({ name, type, cls = 0x0001, ttl = 120, rdata }) {
  const nameBuf = encodeDnsName(name);
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(cls, 2);
  header.writeUInt32BE(ttl, 4);
  header.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameBuf, header, rdata]);
}

function buildAnnouncementPacket({ instanceName, hostName, ip, port, txtRecords = {}, ttl = 120 }) {
  const cleanInstance = instanceName.replace(/[^a-zA-Z0-9_-]/g, '-') || 'WirelessGameMirror-PC';
  const cleanHost = (hostName || cleanInstance).replace(/\.local$/i, '').replace(/[^a-zA-Z0-9-]/g, '-');
  const fullInstanceName = `${cleanInstance}.${SERVICE_TYPE}`;
  const fullHostName = `${cleanHost}.local`;

  // 1. PTR Record: _gamestream._tcp.local -> <Instance>._gamestream._tcp.local
  const ptrRdata = encodeDnsName(fullInstanceName);
  const ptrRecord = encodeResourceRecord({
    name: SERVICE_TYPE,
    type: 12, // PTR
    cls: 0x0001,
    ttl,
    rdata: ptrRdata
  });

  // 2. SRV Record: <Instance>._gamestream._tcp.local -> priority 0, weight 0, port, target
  const targetBuf = encodeDnsName(fullHostName);
  const srvHeader = Buffer.alloc(6);
  srvHeader.writeUInt16BE(0, 0); // priority
  srvHeader.writeUInt16BE(0, 2); // weight
  srvHeader.writeUInt16BE(port, 4); // port
  const srvRecord = encodeResourceRecord({
    name: fullInstanceName,
    type: 33, // SRV
    cls: 0x8001, // cache-flush + IN
    ttl,
    rdata: Buffer.concat([srvHeader, targetBuf])
  });

  // 3. TXT Record
  const txtEntries = Object.entries({
    version: '1',
    platform: 'windows',
    path: '/ws',
    obsPath: '/obs',
    auth: 'token-or-prompt',
    singleDevice: 'true',
    ...txtRecords
  });
  const txtParts = txtEntries.map(([k, v]) => {
    const str = Buffer.from(`${k}=${v}`, 'utf8');
    return Buffer.concat([Buffer.from([str.length]), str]);
  });
  const txtRecord = encodeResourceRecord({
    name: fullInstanceName,
    type: 16, // TXT
    cls: 0x8001,
    ttl,
    rdata: txtParts.length > 0 ? Buffer.concat(txtParts) : Buffer.from([0])
  });

  // 4. A Record: <Host>.local -> IPv4
  const ipOctets = (ip || '127.0.0.1').split('.').map((n) => Number(n) & 0xff);
  const aRdata = Buffer.from(ipOctets.length === 4 ? ipOctets : [127, 0, 0, 1]);
  const aRecord = encodeResourceRecord({
    name: fullHostName,
    type: 1, // A
    cls: 0x8001,
    ttl,
    rdata: aRdata
  });

  // DNS Header (QR=1, AA=1 -> flags 0x8400, 4 Answer RRs)
  const dnsHeader = Buffer.alloc(12);
  dnsHeader.writeUInt16BE(0x0000, 0); // ID = 0 for mDNS
  dnsHeader.writeUInt16BE(0x8400, 2); // Standard query response, Authoritative
  dnsHeader.writeUInt16BE(0, 4); // QDCOUNT
  dnsHeader.writeUInt16BE(4, 6); // ANCOUNT
  dnsHeader.writeUInt16BE(0, 8); // NSCOUNT
  dnsHeader.writeUInt16BE(0, 10); // ARCOUNT

  return Buffer.concat([dnsHeader, ptrRecord, srvRecord, txtRecord, aRecord]);
}

function parseDnsQuery(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const id = buffer.readUInt16BE(0);
  const flags = buffer.readUInt16BE(2);
  const isResponse = (flags & 0x8000) !== 0;
  const qdCount = buffer.readUInt16BE(4);

  if (isResponse || qdCount === 0) return null;

  const questions = [];
  let offset = 12;

  for (let i = 0; i < qdCount && offset < buffer.length; i++) {
    const decoded = decodeDnsName(buffer, offset);
    offset = decoded.nextOffset;
    if (offset + 4 > buffer.length) break;
    const qtype = buffer.readUInt16BE(offset);
    const qclass = buffer.readUInt16BE(offset + 2);
    offset += 4;
    questions.push({
      name: decoded.name.toLowerCase(),
      qtype,
      unicastResponse: (qclass & 0x8000) !== 0
    });
  }

  return { id, questions };
}

class MdnsService extends EventEmitter {
  constructor({
    instanceName = os.hostname() || 'WirelessGameMirror-PC',
    port = 8080,
    ip = '127.0.0.1',
    txtRecords = {}
  } = {}) {
    super();
    this.instanceName = instanceName;
    this.hostName = os.hostname() || 'gamemirror-pc';
    this.port = port;
    this.ip = ip;
    this.txtRecords = txtRecords;
    this.socket = null;
    this.running = false;
    this.intervalId = null;
  }

  getServiceInfo() {
    return {
      serviceType: SERVICE_TYPE,
      instanceName: this.instanceName,
      fullDomain: `${this.instanceName.replace(/[^a-zA-Z0-9_-]/g, '-')}.${SERVICE_TYPE}`,
      hostName: `${this.hostName.replace(/\.local$/i, '')}.local`,
      ip: this.ip,
      port: this.port,
      running: this.running
    };
  }

  buildPacket(ttl = 120) {
    return buildAnnouncementPacket({
      instanceName: this.instanceName,
      hostName: this.hostName,
      ip: this.ip,
      port: this.port,
      txtRecords: this.txtRecords,
      ttl
    });
  }

  async start({ bindPort = MDNS_PORT, announceIntervalMs = 15000 } = {}) {
    if (this.running) return this.getServiceInfo();

    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = socket;

      socket.on('error', (err) => {
        this.emit('warning', err);
        if (!this.running) {
          try {
            socket.close();
          } catch {
            // ignore
          }
          this.socket = null;
          resolve(this.getServiceInfo());
        }
      });

      socket.on('message', (msg, rinfo) => {
        const query = parseDnsQuery(msg);
        if (!query) return;

        const matchesService = query.questions.some(
          (q) =>
            q.name === SERVICE_TYPE ||
            q.name === DNS_SD_SERVICES ||
            q.name.endsWith(`.${SERVICE_TYPE}`)
        );

        if (matchesService) {
          this.emit('query', query, rinfo);
          this.announce(rinfo.port === MDNS_PORT ? null : rinfo);
        }
      });

      socket.bind(bindPort, '0.0.0.0', () => {
        try {
          socket.addMembership(MDNS_MULTICAST_ADDR);
          socket.setMulticastTTL(255);
          socket.setMulticastLoopback(true);
        } catch (err) {
          this.emit('warning', err);
        }

        this.running = true;
        this.announce();

        if (announceIntervalMs > 0) {
          this.intervalId = setInterval(() => {
            this.announce();
          }, announceIntervalMs);
          if (this.intervalId.unref) this.intervalId.unref();
        }

        resolve(this.getServiceInfo());
      });
    });
  }

  announce(targetRinfo = null) {
    if (!this.socket || !this.running) return false;
    const packet = this.buildPacket(120);
    const destPort = targetRinfo ? targetRinfo.port : MDNS_PORT;
    const destAddr = targetRinfo ? targetRinfo.address : MDNS_MULTICAST_ADDR;

    try {
      this.socket.send(packet, 0, packet.length, destPort, destAddr);
      return true;
    } catch {
      return false;
    }
  }

  async stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.socket && this.running) {
      // Send goodbye packet (TTL = 0)
      try {
        const goodbye = this.buildPacket(0);
        this.socket.send(goodbye, 0, goodbye.length, MDNS_PORT, MDNS_MULTICAST_ADDR);
      } catch {
        // ignore
      }
    }
    this.running = false;
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      await new Promise((resolve) => {
        try {
          sock.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  }
}

module.exports = {
  MDNS_MULTICAST_ADDR,
  MDNS_PORT,
  SERVICE_TYPE,
  encodeDnsName,
  decodeDnsName,
  buildAnnouncementPacket,
  parseDnsQuery,
  MdnsService
};
