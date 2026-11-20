const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebSocketServer } = require('./wsServer');
const { SessionManager } = require('./sessionManager');
const { MdnsService } = require('./mdnsService');
const { createPairingPayload } = require('./qrGenerator');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const [name, list] of Object.entries(interfaces)) {
    if (!Array.isArray(list)) continue;
    for (const iface of list) {
      if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) {
        // Prioritize Wi-Fi, Ethernet, and USB Tethering interfaces
        const isVirtual = /vethernet|wsl|docker|vmware|virtualbox/i.test(name);
        addresses.push({
          name,
          address: iface.address,
          isVirtual
        });
      }
    }
  }

  addresses.sort((a, b) => Number(a.isVirtual) - Number(b.isVirtual));
  if (addresses.length === 0) {
    addresses.push({ name: 'Loopback', address: '127.0.0.1', isVirtual: false });
  }
  return addresses;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function createReceiverServer({
  port = 8080,
  host = '0.0.0.0',
  enableMdns = true,
  serverName = os.hostname() || 'WirelessGameMirror-PC'
} = {}) {
  const sessionManager = new SessionManager();
  const wsServer = new WebSocketServer({ path: '/ws' });
  const publicDir = path.join(__dirname, '..', 'public');
  const viewers = new Map(); // viewerId -> ws

  let currentPort = port;
  const lanAddresses = getLanAddresses();
  const primaryIp = lanAddresses[0].address;

  const mdnsService = new MdnsService({
    instanceName: serverName,
    port: currentPort,
    ip: primaryIp
  });

  function broadcastToViewers(payload, filterRole = null) {
    for (const viewerWs of viewers.values()) {
      if (viewerWs.readyState !== 1) continue;
      if (filterRole && viewerWs.meta.role !== filterRole) continue;
      viewerWs.sendJson(payload);
    }
  }

  // Forward SessionManager lifecycle events to all connected Dashboard & OBS viewers
  sessionManager.on('approval-requested', (req) => {
    broadcastToViewers({
      type: 'approval-requested',
      request: req,
      state: sessionManager.getPublicState()
    });
  });

  sessionManager.on('approval-resolved', (info) => {
    broadcastToViewers({
      type: 'approval-resolved',
      ...info,
      state: sessionManager.getPublicState()
    });
  });

  sessionManager.on('sender-connected', (sender) => {
    broadcastToViewers({
      type: 'sender-connected',
      sender,
      targetConfig: { ...sessionManager.targetConfig },
      state: sessionManager.getPublicState()
    });

    // Notify the newly authenticated sender about all currently open viewers (Dashboard & OBS)
    if (sessionManager.activeSender && sessionManager.activeSender.ws) {
      for (const [viewerId, viewerWs] of viewers.entries()) {
        if (viewerWs.readyState === 1) {
          sessionManager.activeSender.ws.sendJson({
            type: 'viewer-joined',
            viewerId,
            role: viewerWs.meta.role || 'viewer'
          });
        }
      }
    }
  });

  sessionManager.on('sender-disconnected', ({ sender, reason }) => {
    broadcastToViewers({
      type: 'sender-disconnected',
      sender,
      reason,
      state: sessionManager.getPublicState()
    });
  });

  sessionManager.on('orientation-changed', (orientationInfo) => {
    broadcastToViewers({
      type: 'orientation-changed',
      ...orientationInfo
    });
  });

  sessionManager.on('audio-status-changed', (audioInfo) => {
    broadcastToViewers({
      type: 'audio-status-changed',
      ...audioInfo
    });
  });

  sessionManager.on('telemetry-updated', (telemetryInfo) => {
    broadcastToViewers({
      type: 'telemetry-updated',
      ...telemetryInfo
    });
  });

  sessionManager.on('config-updated', (config) => {
    broadcastToViewers({
      type: 'config-updated',
      targetConfig: config
    });
  });

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    const sendJson = (status, data) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify(data));
    };

    try {
      // API Routes
      if (pathname === '/api/status' && req.method === 'GET') {
        const ips = getLanAddresses();
        const activeIp = ips[0].address;
        return sendJson(200, {
          ok: true,
          serverName,
          port: currentPort,
          lanAddresses: ips,
          obsUrl: `http://127.0.0.1:${currentPort}/obs`,
          lanObsUrl: `http://${activeIp}:${currentPort}/obs`,
          mdns: mdnsService.getServiceInfo(),
          ...sessionManager.getPublicState()
        });
      }

      if (pathname === '/api/pairing-info' && req.method === 'GET') {
        const ips = getLanAddresses();
        const selectedIp = url.searchParams.get('ip') || ips[0].address;
        const pairing = createPairingPayload({
          ip: selectedIp,
          port: currentPort,
          token: sessionManager.sessionToken,
          serverName
        });

        return sendJson(200, {
          ok: true,
          ...pairing,
          lanAddresses: ips,
          obsUrl: `http://127.0.0.1:${currentPort}/obs`,
          mdnsServiceType: '_gamestream._tcp.local'
        });
      }

      if (pathname === '/api/session/rotate-token' && req.method === 'POST') {
        const newToken = sessionManager.rotateToken();
        const ips = getLanAddresses();
        const selectedIp = url.searchParams.get('ip') || ips[0].address;
        const pairing = createPairingPayload({
          ip: selectedIp,
          port: currentPort,
          token: newToken,
          serverName
        });
        broadcastToViewers({
          type: 'token-rotated',
          pairing
        });
        return sendJson(200, { ok: true, ...pairing });
      }

      if (pathname === '/api/session/approve' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = sessionManager.approvePending(body.requestId, {
          forceReplace: Boolean(body.forceReplace)
        });
        return sendJson(result.ok ? 200 : 400, result);
      }

      if (pathname === '/api/session/deny' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = sessionManager.denyPending(body.requestId, body.reason);
        return sendJson(result.ok ? 200 : 400, result);
      }

      if (pathname === '/api/session/disconnect' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const disconnected = sessionManager.disconnectActiveSender(
          body.reason || 'ผู้ใช้กดตัดการเชื่อมต่อจาก PC Dashboard'
        );
        return sendJson(200, {
          ok: true,
          disconnected,
          state: sessionManager.getPublicState()
        });
      }

      if (pathname === '/api/control' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const notifySender = !body.syncOnly;
        if (body.action === 'request-keyframe') {
          if (notifySender && sessionManager.activeSender && sessionManager.activeSender.ws) {
            sessionManager.activeSender.ws.sendJson({
              type: 'control',
              action: 'request-keyframe'
            });
          }
          return sendJson(200, { ok: true, action: 'request-keyframe' });
        }

        const updatedConfig = sessionManager.updateTargetConfig(body, { notifySender });
        return sendJson(200, {
          ok: true,
          targetConfig: updatedConfig
        });
      }

      // Page & Static File Routes
      let filePath = null;
      if (pathname === '/' || pathname === '/index.html') {
        filePath = path.join(publicDir, 'index.html');
      } else if (pathname === '/obs' || pathname === '/obs.html') {
        filePath = path.join(publicDir, 'obs.html');
      } else if (pathname === '/simulator' || pathname === '/simulator.html' || pathname === '/connect') {
        filePath = path.join(publicDir, 'simulator.html');
      } else {
        const safeRel = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
        const candidate = path.join(publicDir, safeRel);
        if (candidate.startsWith(publicDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          filePath = candidate;
        }
      }

      if (filePath && fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const content = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache'
        });
        res.end(content);
        return;
      }

      sendJson(404, { ok: false, error: 'Not Found' });
    } catch (err) {
      sendJson(500, { ok: false, error: err.message || 'Internal Server Error' });
    }
  });

  // WebSocket Signaling Handler
  wsServer.attach(httpServer);

  wsServer.on('connection', (ws, req, url) => {
    const queryRole = url.searchParams.get('role');
    const queryToken = url.searchParams.get('token');
    const queryViewerId = url.searchParams.get('viewerId');
    const remoteAddress = req.socket.remoteAddress || '127.0.0.1';

    ws.meta = {
      role: queryRole || null,
      viewerId: queryViewerId || null,
      deviceId: null,
      authenticated: false,
      remoteAddress
    };

    // If connecting directly as a viewer via query string
    if (queryRole === 'dashboard' || queryRole === 'obs') {
      const viewerId = queryViewerId || `${queryRole}-${ws.id.slice(0, 8)}`;
      ws.meta.role = queryRole;
      ws.meta.viewerId = viewerId;
      viewers.set(viewerId, ws);

      ws.sendJson({
        type: 'viewer-registered',
        viewerId,
        role: queryRole,
        state: sessionManager.getPublicState()
      });

      if (sessionManager.activeSender && sessionManager.activeSender.ws) {
        sessionManager.activeSender.ws.sendJson({
          type: 'viewer-joined',
          viewerId,
          role: queryRole
        });
      }
    }

    ws.on('message', (rawMessage) => {
      if (Buffer.isBuffer(rawMessage)) return;
      let msg;
      try {
        msg = JSON.parse(rawMessage);
      } catch {
        ws.sendJson({ type: 'error', code: 'INVALID_JSON', message: 'รูปแบบ JSON ไม่ถูกต้อง' });
        return;
      }

      handleSignalingMessage(ws, msg, queryToken);
    });

    ws.on('close', () => {
      if (ws.meta.viewerId && viewers.get(ws.meta.viewerId) === ws) {
        const closedViewerId = ws.meta.viewerId;
        viewers.delete(closedViewerId);
        if (sessionManager.activeSender && sessionManager.activeSender.ws) {
          sessionManager.activeSender.ws.sendJson({
            type: 'viewer-left',
            viewerId: closedViewerId
          });
        }
      }
      sessionManager.handleSocketClose(ws);
    });
  });

  function isActiveSenderSocket(ws) {
    return Boolean(sessionManager.activeSender && sessionManager.activeSender.ws === ws);
  }

  function handleSignalingMessage(ws, msg, queryToken) {
    switch (msg.type) {
      case 'register-viewer': {
        const role = msg.role === 'obs' ? 'obs' : 'dashboard';
        const viewerId = msg.viewerId || ws.meta.viewerId || `${role}-${ws.id.slice(0, 8)}`;
        const alreadyRegistered = viewers.get(viewerId) === ws;
        ws.meta.role = role;
        ws.meta.viewerId = viewerId;
        viewers.set(viewerId, ws);

        ws.sendJson({
          type: 'viewer-registered',
          viewerId,
          role,
          state: sessionManager.getPublicState()
        });

        if (!alreadyRegistered && sessionManager.activeSender && sessionManager.activeSender.ws) {
          sessionManager.activeSender.ws.sendJson({
            type: 'viewer-joined',
            viewerId,
            role
          });
        }
        break;
      }

      case 'request-offer': {
        const viewerId = msg.viewerId || ws.meta.viewerId;
        if (viewerId && sessionManager.activeSender && sessionManager.activeSender.ws) {
          sessionManager.activeSender.ws.sendJson({
            type: 'viewer-joined',
            viewerId,
            role: ws.meta.role || 'viewer'
          });
        }
        break;
      }

      case 'join-sender':
      case 'hello': {
        ws.meta.role = 'sender';
        ws.meta.deviceId = msg.deviceId || ws.id;

        const joinResult = sessionManager.requestJoin({
          ws,
          deviceId: ws.meta.deviceId,
          deviceName: msg.deviceName || 'Mobile Game Sender',
          platform: msg.platform || 'ios',
          token: msg.token !== undefined ? msg.token : queryToken,
          authMethod: msg.authMethod || null,
          orientation: msg.orientation || 'landscape',
          width: msg.width || 1920,
          height: msg.height || 1080,
          forceReplace: Boolean(msg.forceReplace),
          remoteAddress: ws.meta.remoteAddress
        });

        if (!joinResult.ok) {
          ws.sendJson({
            type: 'auth-result',
            status: 'rejected',
            code: joinResult.code,
            message: joinResult.message,
            activeDevice: joinResult.activeDevice
          });
          return;
        }

        if (joinResult.status === 'approved') {
          ws.meta.authenticated = true;
          ws.sendJson({
            type: 'auth-result',
            status: 'approved',
            deviceId: ws.meta.deviceId,
            sessionToken: sessionManager.sessionToken,
            targetConfig: joinResult.targetConfig
          });
        } else if (joinResult.status === 'pending-approval') {
          ws.sendJson({
            type: 'auth-result',
            status: 'pending-approval',
            requestId: joinResult.requestId,
            message: joinResult.message
          });
        }
        break;
      }

      // WebRTC SDP Offer from Active Mobile Sender -> Viewer(s)
      case 'offer': {
        if (!isActiveSenderSocket(ws)) {
          ws.sendJson({
            type: 'error',
            code: 'UNAUTHORIZED_SENDER',
            message: 'ยังไม่ได้รับอนุมัติให้เป็น Active Sender'
          });
          return;
        }

        const payload = {
          type: 'offer',
          sdp: msg.sdp,
          viewerId: msg.viewerId || null,
          deviceId: sessionManager.activeSender.deviceId,
          orientation: sessionManager.activeSender.orientation,
          width: sessionManager.activeSender.width,
          height: sessionManager.activeSender.height
        };

        if (msg.viewerId && viewers.has(msg.viewerId)) {
          const targetViewer = viewers.get(msg.viewerId);
          if (targetViewer.readyState === 1) {
            targetViewer.sendJson(payload);
          }
        } else {
          broadcastToViewers(payload);
        }
        break;
      }

      // WebRTC SDP Answer from Viewer -> Active Mobile Sender
      case 'answer': {
        if (sessionManager.activeSender && sessionManager.activeSender.ws) {
          sessionManager.activeSender.ws.sendJson({
            type: 'answer',
            sdp: msg.sdp,
            viewerId: msg.viewerId || ws.meta.viewerId || 'default'
          });
        }
        break;
      }

      // WebRTC ICE Candidate exchange (LAN Host Candidates)
      case 'ice-candidate': {
        if (isActiveSenderSocket(ws)) {
          const payload = {
            type: 'ice-candidate',
            candidate: msg.candidate,
            viewerId: msg.viewerId || null,
            from: 'sender'
          };
          if (msg.viewerId && viewers.has(msg.viewerId)) {
            const v = viewers.get(msg.viewerId);
            if (v.readyState === 1) v.sendJson(payload);
          } else {
            broadcastToViewers(payload);
          }
        } else if (sessionManager.activeSender && sessionManager.activeSender.ws) {
          sessionManager.activeSender.ws.sendJson({
            type: 'ice-candidate',
            candidate: msg.candidate,
            viewerId: msg.viewerId || ws.meta.viewerId || 'default',
            from: 'viewer'
          });
        }
        break;
      }

      // Dynamic Orientation Event (Portrait 1080x1920 <-> Landscape 1920x1080)
      case 'orientation': {
        if (!isActiveSenderSocket(ws)) return;
        sessionManager.updateOrientation({
          orientation: msg.orientation,
          width: msg.width,
          height: msg.height,
          rotationDegrees: msg.rotationDegrees
        });
        break;
      }

      // Android / iOS Audio Capture Status (e.g., when a game blocks AudioPlaybackCapture)
      case 'audio-status': {
        if (!isActiveSenderSocket(ws)) return;
        sessionManager.updateAudioStatus({
          captured: msg.captured,
          mode: msg.mode,
          warning: msg.warning,
          blockedApp: msg.blockedApp
        });
        break;
      }

      // Mobile Telemetry (FPS, Bitrate, Latency, PacketLoss, Battery, Temp, RAM)
      case 'telemetry':
      case 'receiver-telemetry': {
        if (msg.type === 'telemetry' && !isActiveSenderSocket(ws)) return;
        sessionManager.updateTelemetry(msg.telemetry || msg);
        break;
      }

      // Real-time Bitrate / FPS / Resolution / Keyframe Controls from PC Dashboard
      case 'control': {
        const notifySender = !msg.syncOnly;
        if (msg.action === 'request-keyframe') {
          if (notifySender && sessionManager.activeSender && sessionManager.activeSender.ws) {
            sessionManager.activeSender.ws.sendJson({
              type: 'control',
              action: 'request-keyframe'
            });
          }
          return;
        }
        sessionManager.updateTargetConfig(msg.config || msg, { notifySender });
        break;
      }

      default:
        break;
    }
  }

  async function start() {
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        const addr = httpServer.address();
        currentPort = typeof addr === 'object' && addr ? addr.port : port;
        mdnsService.port = currentPort;
        resolve();
      });
    });

    if (enableMdns) {
      await mdnsService.start();
    }

    const ips = getLanAddresses();
    return {
      port: currentPort,
      host,
      lanAddresses: ips,
      dashboardUrl: `http://127.0.0.1:${currentPort}/`,
      obsUrl: `http://127.0.0.1:${currentPort}/obs`,
      sessionToken: sessionManager.sessionToken
    };
  }

  async function stop() {
    await mdnsService.stop();
    wsServer.closeAll();
    await new Promise((resolve) => {
      httpServer.close(() => resolve());
    });
  }

  return {
    httpServer,
    wsServer,
    sessionManager,
    mdnsService,
    start,
    stop,
    getPort: () => currentPort
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const receiver = createReceiverServer({ port });
  receiver.start().then((info) => {
    console.log('============================================================');
    console.log('🎮 Wireless Game Mirror - PC Receiver & Signaling Server');
    console.log('============================================================');
    console.log(`🖥️  PC Control Dashboard : ${info.dashboardUrl}`);
    console.log(`🎥 OBS Browser Source   : ${info.obsUrl}`);
    console.log(`📡 LAN IP Address       : ${info.lanAddresses.map((i) => `${i.address} (${i.name})`).join(', ')}`);
    console.log(`🔑 QR Session Token     : ${info.sessionToken}`);
    console.log('============================================================');
  });
}

module.exports = {
  createReceiverServer,
  getLanAddresses
};
