const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createReceiverServer } = require('../src/server');
const { buildMatrix, decodeMatrix, generateQrSvg, createPairingPayload } = require('../src/qrGenerator');
const {
  encodeDnsName,
  decodeDnsName,
  buildAnnouncementPacket,
  parseDnsQuery,
  SERVICE_TYPE
} = require('../src/mdnsService');

function waitForWsOpen(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (err) => reject(err), { once: true });
  });
}

function createMessageQueue(ws) {
  const queue = [];
  const waiters = [];

  ws.addEventListener('message', (event) => {
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      parsed = event.data;
    }

    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].predicate(parsed)) {
        const waiter = waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
        return;
      }
    }
    queue.push(parsed);
  });

  function nextMessage(predicate = () => true, timeoutMs = 4000) {
    for (let i = 0; i < queue.length; i++) {
      if (predicate(queue[i])) {
        return Promise.resolve(queue.splice(i, 1)[0]);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for WebSocket message (${timeoutMs}ms)`));
      }, timeoutMs);
      waiters.push({ predicate, resolve, timer });
    });
  }

  return { nextMessage, queue };
}

describe('1. QR Code Generator & Pairing Payload Verification', () => {
  test('generates standards-compliant ISO/IEC 18004 QR matrix & SVG for pairing URI', () => {
    const payload = createPairingPayload({
      ip: '192.168.1.50',
      port: 8080,
      token: 'a1b2c3d4e5f6a1b2c3d4e5f6',
      serverName: 'Streamer-PC'
    });

    assert.ok(payload.uri.startsWith('gamemirror://connect?'));
    assert.ok(payload.uri.includes('ip=192.168.1.50'));
    assert.ok(payload.uri.includes('port=8080'));
    assert.ok(payload.uri.includes('token=a1b2c3d4e5f6a1b2c3d4e5f6'));
    assert.ok(payload.qrSvg.startsWith('<svg'));
    assert.ok(payload.qrSvg.includes('</svg>'));

    const matrix = buildMatrix(payload.uri);
    assert.equal(matrix.size, matrix.version * 4 + 17);
    // Verify top-left 7x7 finder pattern corners are dark
    assert.equal(matrix.modules[0][0], true);
    assert.equal(matrix.modules[0][6], true);
    assert.equal(matrix.modules[6][0], true);
    assert.equal(matrix.modules[6][6], true);
    assert.equal(matrix.modules[3][3], true);

    // Mathematically verify ISO/IEC 18004 Format Information (Copy 1 & Copy 2), BCH(15,5),
    // Reed-Solomon ECC codewords, and full round-trip decoding back to the original pairing URI!
    const decodedUri = decodeMatrix(matrix);
    assert.equal(decodedUri, payload.uri);

    // Verify Format Info MSB (bit 14) is at (row=8, col=0) and (row=size-1, col=8),
    // and LSB (bit 0) is at (row=0, col=8) and (row=8, col=size-1) for Level L + Mask 0 (0x77c4)
    const expectedFormatBits = 0x77c4;
    assert.equal(matrix.modules[8][0], ((expectedFormatBits >>> 14) & 1) !== 0);
    assert.equal(matrix.modules[matrix.size - 1][8], ((expectedFormatBits >>> 14) & 1) !== 0);
    assert.equal(matrix.modules[0][8], (expectedFormatBits & 1) !== 0);
    assert.equal(matrix.modules[8][matrix.size - 1], (expectedFormatBits & 1) !== 0);
  });

  test('rejects excessively long QR payloads beyond Version 10 capacity', () => {
    const hugeText = 'x'.repeat(400);
    assert.throws(() => generateQrSvg(hugeText), /QR payload too long/);
  });
});

describe('2. mDNS (_gamestream._tcp.local) DNS-SD Packet Encoding & Parsing', () => {
  test('encodes and decodes DNS labels accurately', () => {
    const encoded = encodeDnsName('_gamestream._tcp.local');
    const decoded = decodeDnsName(encoded, 0);
    assert.equal(decoded.name, '_gamestream._tcp.local');
    assert.equal(decoded.nextOffset, encoded.length);
  });

  test('builds authoritative mDNS announcement packet with PTR, SRV, TXT, and A records', () => {
    const packet = buildAnnouncementPacket({
      instanceName: 'GamingPC',
      hostName: 'GamingPC',
      ip: '192.168.1.100',
      port: 8080
    });

    assert.ok(Buffer.isBuffer(packet));
    const flags = packet.readUInt16BE(2);
    const anCount = packet.readUInt16BE(6);
    assert.equal(flags, 0x8400); // QR=1, AA=1
    assert.equal(anCount, 4); // PTR + SRV + TXT + A
  });

  test('parses incoming mDNS query packet for _gamestream._tcp.local', () => {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x1234, 0);
    header.writeUInt16BE(0x0000, 2); // Standard query
    header.writeUInt16BE(1, 4); // 1 Question
    const qName = encodeDnsName(SERVICE_TYPE);
    const qFooter = Buffer.alloc(4);
    qFooter.writeUInt16BE(12, 0); // PTR
    qFooter.writeUInt16BE(1, 2); // IN

    const queryPacket = Buffer.concat([header, qName, qFooter]);
    const parsed = parseDnsQuery(queryPacket);
    assert.ok(parsed);
    assert.equal(parsed.questions.length, 1);
    assert.equal(parsed.questions[0].name, '_gamestream._tcp.local');
    assert.equal(parsed.questions[0].qtype, 12);
  });
});

describe('3. PC Receiver Server, Single-Device Lock, QR Auth, mDNS Allow/Deny, Orientation & WebRTC Signaling', () => {
  let receiver;
  let baseUrl;
  let wsBaseUrl;

  before(async () => {
    receiver = createReceiverServer({
      port: 0, // Ephemeral port for isolated test execution
      host: '127.0.0.1',
      enableMdns: false,
      serverName: 'Test-PC-Receiver'
    });
    const info = await receiver.start();
    baseUrl = `http://127.0.0.1:${info.port}`;
    wsBaseUrl = `ws://127.0.0.1:${info.port}/ws`;
  });

  after(async () => {
    if (receiver) {
      await receiver.stop();
    }
  });

  test('serves Dashboard (/), OBS Browser Source (/obs with transparent background), and Pairing API', async () => {
    const dashRes = await fetch(`${baseUrl}/`);
    assert.equal(dashRes.status, 200);
    const dashHtml = await dashRes.text();
    assert.ok(dashHtml.includes('Wireless Game Mirror — PC Receiver'));

    const obsRes = await fetch(`${baseUrl}/obs`);
    assert.equal(obsRes.status, 200);
    const obsHtml = await obsRes.text();
    assert.ok(obsHtml.includes('background: transparent !important'));
    assert.ok(obsHtml.includes('data-orientation="portrait"'));
    assert.ok(obsHtml.includes('data-orientation="landscape"'));

    const pairRes = await fetch(`${baseUrl}/api/pairing-info`);
    assert.equal(pairRes.status, 200);
    const pairJson = await pairRes.json();
    assert.equal(pairJson.ok, true);
    assert.equal(pairJson.token, receiver.sessionManager.sessionToken);
    assert.ok(pairJson.qrSvg.includes('<svg'));
  });

  test('QR Token Auto-Auth approves first device and enforces Single-Device Session lock against second device', async () => {
    const token = receiver.sessionManager.sessionToken;

    const sender1 = new WebSocket(wsBaseUrl);
    const q1 = createMessageQueue(sender1);
    await waitForWsOpen(sender1);

    sender1.send(
      JSON.stringify({
        type: 'join-sender',
        deviceId: 'iphone-16-pro',
        deviceName: 'iPhone 16 Pro',
        platform: 'ios',
        token,
        orientation: 'landscape',
        width: 1920,
        height: 1080
      })
    );

    const auth1 = await q1.nextMessage((m) => m.type === 'auth-result');
    assert.equal(auth1.status, 'approved');
    assert.equal(auth1.targetConfig.bitrateKbps, 8000);
    assert.equal(auth1.targetConfig.fps, 60);

    // Second device attempts to join while first device is active (Single-Device lock!)
    const sender2 = new WebSocket(wsBaseUrl);
    const q2 = createMessageQueue(sender2);
    await waitForWsOpen(sender2);

    sender2.send(
      JSON.stringify({
        type: 'join-sender',
        deviceId: 'galaxy-s24-ultra',
        deviceName: 'Galaxy S24 Ultra',
        platform: 'android',
        token
      })
    );

    const auth2 = await q2.nextMessage((m) => m.type === 'auth-result');
    assert.equal(auth2.status, 'rejected');
    assert.equal(auth2.code, 'SESSION_BUSY');

    sender2.close();
    sender1.close();

    // Wait briefly for socket close cleanup
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(receiver.sessionManager.activeSender, null);
  });

  test('mDNS Discovery connection triggers PC Allow / Deny prompt workflow', async () => {
    const dashboardWs = new WebSocket(`${wsBaseUrl}?role=dashboard&viewerId=dash-main`);
    const dashQ = createMessageQueue(dashboardWs);
    await waitForWsOpen(dashboardWs);
    await dashQ.nextMessage((m) => m.type === 'viewer-registered');

    // Step 1: Mobile connects via mDNS (no QR token) -> should enter pending-approval and notify Dashboard
    const mdnsSenderDeny = new WebSocket(wsBaseUrl);
    const denySenderQ = createMessageQueue(mdnsSenderDeny);
    await waitForWsOpen(mdnsSenderDeny);

    mdnsSenderDeny.send(
      JSON.stringify({
        type: 'join-sender',
        deviceId: 'ipad-air-mdns',
        deviceName: 'iPad Air (mDNS)',
        platform: 'ios',
        token: null
      })
    );

    const pendingMsg1 = await denySenderQ.nextMessage((m) => m.type === 'auth-result');
    assert.equal(pendingMsg1.status, 'pending-approval');
    assert.ok(pendingMsg1.requestId);

    const dashAlert1 = await dashQ.nextMessage((m) => m.type === 'approval-requested');
    assert.equal(dashAlert1.request.deviceId, 'ipad-air-mdns');

    // PC user clicks Deny
    const denyRes = await fetch(`${baseUrl}/api/session/deny`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: pendingMsg1.requestId, reason: 'ไม่ใช่อุปกรณ์ของฉัน' })
    });
    assert.equal(denyRes.status, 200);

    const deniedResult = await denySenderQ.nextMessage((m) => m.type === 'auth-result');
    assert.equal(deniedResult.status, 'denied');
    mdnsSenderDeny.close();

    // Step 2: Mobile connects via mDNS and PC user clicks Allow
    const mdnsSenderAllow = new WebSocket(wsBaseUrl);
    const allowSenderQ = createMessageQueue(mdnsSenderAllow);
    await waitForWsOpen(mdnsSenderAllow);

    mdnsSenderAllow.send(
      JSON.stringify({
        type: 'join-sender',
        deviceId: 'rog-phone-8',
        deviceName: 'ROG Phone 8 Pro',
        platform: 'android',
        token: null
      })
    );

    const pendingMsg2 = await allowSenderQ.nextMessage((m) => m.type === 'auth-result');
    assert.equal(pendingMsg2.status, 'pending-approval');

    const approveRes = await fetch(`${baseUrl}/api/session/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: pendingMsg2.requestId })
    });
    assert.equal(approveRes.status, 200);

    const approvedResult = await allowSenderQ.nextMessage((m) => m.type === 'auth-result');
    assert.equal(approvedResult.status, 'approved');
    assert.equal(approvedResult.deviceId, 'rog-phone-8');

    // Active sender should also be notified that 'dash-main' viewer is ready
    const viewerJoined = await allowSenderQ.nextMessage((m) => m.type === 'viewer-joined');
    assert.equal(viewerJoined.viewerId, 'dash-main');

    mdnsSenderAllow.close();
    dashboardWs.close();
    await new Promise((r) => setTimeout(r, 80));
  });

  test('Multi-Viewer WebRTC Signaling (Dashboard + OBS), Dynamic Orientation, Audio-Blocked Warning, and Live Bitrate/FPS Controls', async () => {
    const token = receiver.sessionManager.sessionToken;

    const dashWs = new WebSocket(`${wsBaseUrl}?role=dashboard&viewerId=dashboard-1`);
    const dashQ = createMessageQueue(dashWs);
    await waitForWsOpen(dashWs);
    await dashQ.nextMessage((m) => m.type === 'viewer-registered');

    const obsWs = new WebSocket(`${wsBaseUrl}?role=obs&viewerId=obs-1`);
    const obsQ = createMessageQueue(obsWs);
    await waitForWsOpen(obsWs);
    await obsQ.nextMessage((m) => m.type === 'viewer-registered');

    const senderWs = new WebSocket(wsBaseUrl);
    const senderQ = createMessageQueue(senderWs);
    await waitForWsOpen(senderWs);

    senderWs.send(
      JSON.stringify({
        type: 'join-sender',
        deviceId: 'streamer-phone-1',
        deviceName: 'iPhone 16 Pro Max',
        platform: 'ios',
        token,
        orientation: 'landscape',
        width: 1920,
        height: 1080
      })
    );

    const auth = await senderQ.nextMessage((m) => m.type === 'auth-result');
    assert.equal(auth.status, 'approved');

    // Verify large SDP Offer (>20KB, testing 16-bit WebSocket framing) routes to OBS viewer specifically
    const largeFakeSdp = `v=0\r\no=- 12345 2 IN IP4 192.168.1.10\r\na=padding:${'A'.repeat(20000)}\r\n`;
    senderWs.send(
      JSON.stringify({
        type: 'offer',
        viewerId: 'obs-1',
        sdp: largeFakeSdp
      })
    );

    const obsOffer = await obsQ.nextMessage((m) => m.type === 'offer');
    assert.equal(obsOffer.viewerId, 'obs-1');
    assert.equal(obsOffer.sdp, largeFakeSdp);

    // OBS sends Answer + ICE Candidate back to Sender
    obsWs.send(
      JSON.stringify({
        type: 'answer',
        viewerId: 'obs-1',
        sdp: 'v=0\r\na=answer-from-obs\r\n'
      })
    );

    const senderAnswer = await senderQ.nextMessage((m) => m.type === 'answer');
    assert.equal(senderAnswer.viewerId, 'obs-1');
    assert.equal(senderAnswer.sdp, 'v=0\r\na=answer-from-obs\r\n');

    // Test Dynamic Orientation Rotation: Landscape (1920x1080) -> Portrait (1080x1920)
    senderWs.send(
      JSON.stringify({
        type: 'orientation',
        orientation: 'portrait',
        width: 1080,
        height: 1920,
        rotationDegrees: 0
      })
    );

    const obsOrient = await obsQ.nextMessage((m) => m.type === 'orientation-changed');
    const dashOrient = await dashQ.nextMessage((m) => m.type === 'orientation-changed');
    assert.equal(obsOrient.orientation, 'portrait');
    assert.equal(obsOrient.width, 1080);
    assert.equal(obsOrient.height, 1920);
    assert.equal(obsOrient.aspectRatio, '9 / 16');
    assert.equal(dashOrient.orientation, 'portrait');

    // Test Android Game Audio-Blocked Warning propagation
    senderWs.send(
      JSON.stringify({
        type: 'audio-status',
        captured: false,
        blockedApp: 'ArenaOfValor'
      })
    );

    const audioWarn = await dashQ.nextMessage((m) => m.type === 'audio-status-changed');
    assert.equal(audioWarn.captured, false);
    assert.equal(audioWarn.mode, 'video-only-blocked');
    assert.ok(audioWarn.warning.includes('ArenaOfValor'));
    assert.ok(audioWarn.warning.includes('AudioPlaybackCapture'));

    // Test Real-Time Bitrate / FPS / Resolution Control from PC Dashboard -> Mobile Sender
    const ctrlRes = await fetch(`${baseUrl}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bitrateKbps: 12000,
        fps: 60,
        resolution: '720p'
      })
    });
    assert.equal(ctrlRes.status, 200);

    const senderCtrl = await senderQ.nextMessage((m) => m.type === 'control');
    assert.equal(senderCtrl.action, 'configure-encoder');
    assert.equal(senderCtrl.config.bitrateKbps, 12000);
    // Since current orientation is portrait and resolution is 720p, target width x height must be 720x1280
    assert.equal(senderCtrl.config.width, 720);
    assert.equal(senderCtrl.config.height, 1280);

    // Test Force Keyframe request
    await fetch(`${baseUrl}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'request-keyframe' })
    });
    const keyframeCtrl = await senderQ.nextMessage(
      (m) => m.type === 'control' && m.action === 'request-keyframe'
    );
    assert.equal(keyframeCtrl.action, 'request-keyframe');

    senderWs.close();
    dashWs.close();
    obsWs.close();
    await new Promise((r) => setTimeout(r, 80));
  });

  test('Edge Cases: malformed JSON, non-existent approval IDs, bitrate boundaries, swapped orientation dimensions, token rotation invalidation, and unauthorized offer prevention', async () => {
    // 1. Non-existent approval requestId -> 400 REQUEST_NOT_FOUND
    const badApprove = await fetch(`${baseUrl}/api/session/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'non-existent-id' })
    });
    assert.equal(badApprove.status, 400);
    const badApproveJson = await badApprove.json();
    assert.equal(badApproveJson.code, 'REQUEST_NOT_FOUND');

    const badDeny = await fetch(`${baseUrl}/api/session/deny`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: '' })
    });
    assert.equal(badDeny.status, 400);

    // 2. Bitrate boundary clamping (min 1000 kbps, max 25000 kbps)
    const lowBrRes = await fetch(`${baseUrl}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bitrateKbps: 100 })
    });
    const lowBrJson = await lowBrRes.json();
    assert.equal(lowBrJson.targetConfig.bitrateKbps, 1000);

    const highBrRes = await fetch(`${baseUrl}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bitrateKbps: 999999 })
    });
    const highBrJson = await highBrRes.json();
    assert.equal(highBrJson.targetConfig.bitrateKbps, 25000);

    // Restore default 8000 kbps & 1080p
    await fetch(`${baseUrl}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bitrateKbps: 8000, resolution: '1080p', fps: 60 })
    });

    // 3. Token Rotation invalidates previous QR token
    const oldToken = receiver.sessionManager.sessionToken;
    const rotRes = await fetch(`${baseUrl}/api/session/rotate-token`, { method: 'POST' });
    const rotJson = await rotRes.json();
    assert.equal(rotJson.ok, true);
    assert.notEqual(rotJson.token, oldToken);

    // Connecting with old token must NOT auto-approve (enters pending-approval instead)
    const staleWs = new WebSocket(wsBaseUrl);
    const staleQ = createMessageQueue(staleWs);
    await waitForWsOpen(staleWs);

    // Test malformed JSON handling on the same socket first
    staleWs.send('{ invalid json');
    const errMsg = await staleQ.nextMessage((m) => m.type === 'error');
    assert.equal(errMsg.code, 'INVALID_JSON');

    // Attempt unauthorized offer before approval -> UNAUTHORIZED_SENDER
    staleWs.send(JSON.stringify({ type: 'offer', sdp: 'v=0...' }));
    const unauthErr = await staleQ.nextMessage((m) => m.type === 'error');
    assert.equal(unauthErr.code, 'UNAUTHORIZED_SENDER');

    staleWs.send(
      JSON.stringify({
        type: 'join-sender',
        deviceId: 'stale-token-phone',
        deviceName: 'Stale Token Phone',
        platform: 'ios',
        token: oldToken
      })
    );
    const staleAuth = await staleQ.nextMessage((m) => m.type === 'auth-result');
    assert.equal(staleAuth.status, 'pending-approval');
    staleWs.close();

    // 4. Swapped orientation dimensions normalization & forceReplace session takeover
    const validToken = receiver.sessionManager.sessionToken;
    const ws1 = new WebSocket(wsBaseUrl);
    const q1 = createMessageQueue(ws1);
    await waitForWsOpen(ws1);

    // Pass portrait with swapped width=1920, height=1080 -> should normalize to 1080x1920
    ws1.send(
      JSON.stringify({
        type: 'join-sender',
        deviceId: 'phone-a',
        deviceName: 'Phone A',
        platform: 'ios',
        token: validToken,
        orientation: 'portrait',
        width: 1920,
        height: 1080
      })
    );
    await q1.nextMessage((m) => m.type === 'auth-result' && m.status === 'approved');
    assert.equal(receiver.sessionManager.activeSender.orientation, 'portrait');
    assert.equal(receiver.sessionManager.activeSender.width, 1080);
    assert.equal(receiver.sessionManager.activeSender.height, 1920);

    // Phone B connects with forceReplace: true -> replaces Phone A
    const ws2 = new WebSocket(wsBaseUrl);
    const q2 = createMessageQueue(ws2);
    await waitForWsOpen(ws2);

    ws2.send(
      JSON.stringify({
        type: 'join-sender',
        deviceId: 'phone-b',
        deviceName: 'Phone B',
        platform: 'android',
        token: validToken,
        forceReplace: true
      })
    );

    const replacedMsg = await q1.nextMessage((m) => m.type === 'session-replaced');
    assert.ok(replacedMsg.message.includes('Phone B'));

    const authB = await q2.nextMessage((m) => m.type === 'auth-result');
    assert.equal(authB.status, 'approved');
    assert.equal(receiver.sessionManager.activeSender.deviceId, 'phone-b');

    // 5. Truncated / cyclic mDNS buffer safety
    assert.equal(parseDnsQuery(Buffer.alloc(4)), null);
    const cyclicBuf = Buffer.from([0xc0, 0x00]);
    const cyclicDecoded = decodeDnsName(cyclicBuf, 0);
    assert.equal(cyclicDecoded.name, '');

    // 6. Verify duplicate register-viewer does not emit duplicate viewer-joined,
    //    and syncOnly control updates server state without sending duplicate control packet to sender
    const obsDupWs = new WebSocket(`${wsBaseUrl}?role=obs&viewerId=obs-dedup-1`);
    const obsDupQ = createMessageQueue(obsDupWs);
    await waitForWsOpen(obsDupWs);
    await obsDupQ.nextMessage((m) => m.type === 'viewer-registered');

    const joined1 = await q2.nextMessage((m) => m.type === 'viewer-joined' && m.viewerId === 'obs-dedup-1');
    assert.equal(joined1.viewerId, 'obs-dedup-1');

    // Send register-viewer again on the same socket -> must NOT send a second viewer-joined to Phone B
    obsDupWs.send(JSON.stringify({ type: 'register-viewer', role: 'obs', viewerId: 'obs-dedup-1' }));
    await obsDupQ.nextMessage((m) => m.type === 'viewer-registered');

    // Send syncOnly control update -> updates targetConfig on server without forwarding duplicate WS message to sender
    const syncRes = await fetch(`${baseUrl}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bitrateKbps: 9500, syncOnly: true })
    });
    const syncJson = await syncRes.json();
    assert.equal(syncJson.targetConfig.bitrateKbps, 9500);
    assert.equal(
      q2.queue.some((m) => m.type === 'control' && m.config && m.config.bitrateKbps === 9500),
      false
    );

    // Closing obsDupWs emits viewer-left to Phone B
    obsDupWs.close();
    const leftMsg = await q2.nextMessage((m) => m.type === 'viewer-left' && m.viewerId === 'obs-dedup-1');
    assert.equal(leftMsg.viewerId, 'obs-dedup-1');

    ws2.close();
    ws1.close();
    await new Promise((r) => setTimeout(r, 80));
  });

  test('Frontend Scripts (obs.js & simulator.js): queues trickle ICE candidates arriving before async setRemoteDescription resolves and cleans up on viewer-left', async () => {
    const obsScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'obs.js'), 'utf8');

    let wsInstance = null;
    const addedCandidates = [];
    let resolveRemoteDesc = null;

    class MockWebSocket {
      static OPEN = 1;
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.sent = [];
        wsInstance = this;
      }
      send(data) {
        this.sent.push(JSON.parse(data));
      }
      close() {}
    }

    class MockRTCPeerConnection {
      constructor() {
        this.remoteDescription = null;
      }
      setRemoteDescription(desc) {
        return new Promise((resolve) => {
          resolveRemoteDesc = () => {
            this.remoteDescription = desc;
            resolve();
          };
        });
      }
      async addIceCandidate(cand) {
        if (!this.remoteDescription) {
          throw new Error('InvalidStateError: Remote description is not set');
        }
        addedCandidates.push(cand);
      }
      async createAnswer() {
        return { type: 'answer', sdp: 'v=0\r\na=mock-answer\r\n' };
      }
      async setLocalDescription() {}
      close() {}
    }

    const mockBody = { dataset: { orientation: 'landscape', streaming: 'false', showHud: 'false' } };
    const mockDoc = {
      body: mockBody,
      documentElement: { style: { setProperty() {} } },
      getElementById(id) {
        if (id === 'obs-video') {
          return {
            videoWidth: 1920,
            videoHeight: 1080,
            addEventListener() {},
            play: () => Promise.resolve()
          };
        }
        return { textContent: '' };
      }
    };

    const sandbox = {
      window: { location: { protocol: 'http:', host: '127.0.0.1:8080', search: '?viewerId=obs-vm-1' } },
      document: mockDoc,
      URLSearchParams,
      WebSocket: MockWebSocket,
      RTCPeerConnection: MockRTCPeerConnection,
      RTCSessionDescription: class { constructor(init) { Object.assign(this, init); } },
      RTCIceCandidate: class { constructor(init) { Object.assign(this, init); } },
      MediaStream: class {},
      setTimeout,
      clearTimeout
    };

    vm.runInNewContext(obsScript, sandbox);
    assert.ok(wsInstance);

    // 1. Dispatch Offer (setRemoteDescription stays pending until resolveRemoteDesc() is called)
    const offerPromise = wsInstance.onmessage({
      data: JSON.stringify({
        type: 'offer',
        viewerId: 'obs-vm-1',
        sdp: 'v=0\r\na=offer\r\n',
        orientation: 'portrait',
        width: 1080,
        height: 1920
      })
    });

    // 2. While setRemoteDescription is STILL pending, trickle ICE candidate arrives!
    await wsInstance.onmessage({
      data: JSON.stringify({
        type: 'ice-candidate',
        viewerId: 'obs-vm-1',
        candidate: { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.50 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 }
      })
    });

    // Candidate must be queued (not dropped and not added before remoteDescription is set)
    assert.equal(addedCandidates.length, 0);

    // 3. Now resolve setRemoteDescription -> queued candidate must be flushed automatically!
    resolveRemoteDesc();
    await offerPromise;

    assert.equal(addedCandidates.length, 1);
    assert.ok(addedCandidates[0].candidate.includes('192.168.1.50'));
    assert.equal(mockBody.dataset.orientation, 'portrait');
  });
});
