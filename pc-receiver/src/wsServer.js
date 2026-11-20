const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WebSocketConnection extends EventEmitter {
  constructor(socket, request) {
    super();
    this.socket = socket;
    this.request = request;
    this.id = crypto.randomUUID();
    this.readyState = 1; // OPEN
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.meta = {};

    this.socket.setNoDelay(true);

    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('close', () => {
      if (this.readyState !== 3) {
        this.readyState = 3;
        this.emit('close');
      }
    });
    this.socket.on('error', (err) => {
      this.emit('error', err);
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];

      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < 4) return;
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        const bigLen = this.buffer.readBigUInt64BE(2);
        payloadLength = Number(bigLen);
        offset = 10;
      }

      const maskLength = isMasked ? 4 : 0;
      const totalFrameLength = offset + maskLength + payloadLength;
      if (this.buffer.length < totalFrameLength) return;

      let maskKey = null;
      if (isMasked) {
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLength));
      this.buffer = this.buffer.subarray(totalFrameLength);

      if (isMasked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    // Control frames (Close = 0x8, Ping = 0x9, Pong = 0xA)
    if (opcode === 0x8) {
      let code = 1000;
      let reason = '';
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.subarray(2).toString('utf8');
      }
      this.close(code, reason);
      return;
    }

    if (opcode === 0x9) {
      this._sendFrame(0xA, payload);
      this.emit('ping', payload);
      return;
    }

    if (opcode === 0xA) {
      this.emit('pong', payload);
      return;
    }

    // Data frames (Continuation = 0x0, Text = 0x1, Binary = 0x2)
    if (opcode === 0x1 || opcode === 0x2) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
    } else if (opcode === 0x0) {
      this.fragments.push(payload);
    }

    if (fin && this.fragments.length > 0) {
      const fullPayload = Buffer.concat(this.fragments);
      const currentOpcode = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentOpcode = 0;

      if (currentOpcode === 0x1) {
        this.emit('message', fullPayload.toString('utf8'), false);
      } else if (currentOpcode === 0x2) {
        this.emit('message', fullPayload, true);
      }
    }
  }

  send(data) {
    if (this.readyState !== 1) return false;
    if (Buffer.isBuffer(data)) {
      return this._sendFrame(0x2, data);
    }
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return this._sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  sendJson(obj) {
    return this.send(JSON.stringify(obj));
  }

  _sendFrame(opcode, payloadBuffer) {
    if (this.readyState !== 1 || this.socket.destroyed) return false;

    const length = payloadBuffer.length;
    let header;

    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    try {
      this.socket.write(Buffer.concat([header, payloadBuffer]));
      return true;
    } catch {
      return false;
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    if (this.readyState === 1) {
      this.readyState = 2; // CLOSING
      const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8');
      const payload = Buffer.alloc(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      this._sendFrame(0x8, payload);
    }
    this.readyState = 3;
    try {
      this.socket.end();
    } catch {
      // ignore
    }
    this.emit('close', code, reason);
  }
}

class WebSocketServer extends EventEmitter {
  constructor({ path = '/ws' } = {}) {
    super();
    this.path = path;
    this.clients = new Set();
  }

  attach(httpServer) {
    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (this.path && url.pathname !== this.path) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      const acceptKey = crypto
        .createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');

      const responseHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '\r\n'
      ].join('\r\n');

      socket.write(responseHeaders);

      const ws = new WebSocketConnection(socket, req);
      this.clients.add(ws);

      if (head && head.length > 0) {
        ws._onData(head);
      }

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      this.emit('connection', ws, req, url);
    });
  }

  closeAll() {
    for (const client of this.clients) {
      client.close(1001, 'Server shutting down');
    }
    this.clients.clear();
  }
}

module.exports = {
  WebSocketServer,
  WebSocketConnection
};
