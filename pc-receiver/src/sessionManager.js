const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessionToken = this._generateToken();
    this.activeSender = null;
    this.pendingApprovals = new Map();
    this.approvedDevices = new Set();

    this.targetConfig = {
      bitrateKbps: 8000,
      fps: 60,
      resolution: '1080p',
      width: 1920,
      height: 1080,
      codec: 'H264',
      profile: 'baseline-low-latency',
      zeroBFrames: true
    };
  }

  _generateToken() {
    return crypto.randomBytes(12).toString('hex');
  }

  rotateToken() {
    this.sessionToken = this._generateToken();
    this.approvedDevices.clear();
    this.emit('token-rotated', this.sessionToken);
    return this.sessionToken;
  }

  validateToken(token) {
    if (!token || typeof token !== 'string') return false;
    const a = Buffer.from(token);
    const b = Buffer.from(this.sessionToken);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  getPublicState() {
    return {
      hasActiveSender: Boolean(this.activeSender),
      activeSender: this.activeSender ? this._serializeSender(this.activeSender) : null,
      pendingApprovals: Array.from(this.pendingApprovals.values()).map((req) => ({
        requestId: req.requestId,
        deviceId: req.deviceId,
        deviceName: req.deviceName,
        platform: req.platform,
        remoteAddress: req.remoteAddress,
        requestedAt: req.requestedAt
      })),
      targetConfig: { ...this.targetConfig }
    };
  }

  _serializeSender(sender) {
    return {
      deviceId: sender.deviceId,
      deviceName: sender.deviceName,
      platform: sender.platform,
      authMethod: sender.authMethod,
      connectedAt: sender.connectedAt,
      orientation: sender.orientation,
      width: sender.width,
      height: sender.height,
      rotationDegrees: sender.rotationDegrees,
      audioStatus: { ...sender.audioStatus },
      telemetry: { ...sender.telemetry }
    };
  }

  /**
   * Handle a connection/join attempt from a mobile sender (QR Token or mDNS Discovery)
   */
  requestJoin({
    ws,
    deviceId,
    deviceName = 'Mobile Streamer',
    platform = 'ios',
    token = null,
    authMethod = null,
    orientation = 'landscape',
    width = 1920,
    height = 1080,
    forceReplace = false,
    remoteAddress = '127.0.0.1'
  }) {
    const cleanDeviceId = String(deviceId || crypto.randomUUID());
    const cleanPlatform = ['ios', 'android', 'simulator'].includes(String(platform).toLowerCase())
      ? String(platform).toLowerCase()
      : 'ios';

    // Single-Device Session Check: If another device is already active
    if (
      this.activeSender &&
      this.activeSender.deviceId !== cleanDeviceId &&
      !forceReplace
    ) {
      return {
        ok: false,
        status: 'busy',
        code: 'SESSION_BUSY',
        message: `มีอุปกรณ์ "${this.activeSender.deviceName}" กำลังสตรีมอยู่ (รองรับทีละ 1 เครื่อง)`,
        activeDevice: this._serializeSender(this.activeSender)
      };
    }

    const hasValidToken = this.validateToken(token);
    const isPreApproved = this.approvedDevices.has(cleanDeviceId);

    // Path 1: QR Code Token Auto-Auth (or already approved device reconnecting)
    if (hasValidToken || isPreApproved) {
      const sender = this._activateSender({
        ws,
        deviceId: cleanDeviceId,
        deviceName,
        platform: cleanPlatform,
        authMethod: hasValidToken ? 'qr-token' : (authMethod || 'mdns-approved'),
        orientation,
        width,
        height,
        remoteAddress
      });

      return {
        ok: true,
        status: 'approved',
        sender: this._serializeSender(sender),
        targetConfig: { ...this.targetConfig }
      };
    }

    // Path 2: mDNS Discovery Connection -> Requires PC Allow / Deny Prompt
    // Remove any older pending request from the same deviceId
    for (const [oldId, req] of this.pendingApprovals.entries()) {
      if (req.deviceId === cleanDeviceId) {
        this.pendingApprovals.delete(oldId);
      }
    }

    const requestId = crypto.randomUUID();
    const pendingReq = {
      requestId,
      ws,
      deviceId: cleanDeviceId,
      deviceName,
      platform: cleanPlatform,
      orientation,
      width,
      height,
      remoteAddress,
      requestedAt: new Date().toISOString()
    };

    this.pendingApprovals.set(requestId, pendingReq);
    this.emit('approval-requested', {
      requestId,
      deviceId: cleanDeviceId,
      deviceName,
      platform: cleanPlatform,
      remoteAddress,
      requestedAt: pendingReq.requestedAt
    });

    return {
      ok: true,
      status: 'pending-approval',
      requestId,
      message: 'รอการกดอนุญาต (Allow) บนหน้าจอ PC Receiver'
    };
  }

  approvePending(requestId, { forceReplace = false } = {}) {
    const req = this.pendingApprovals.get(requestId);
    if (!req) {
      return {
        ok: false,
        code: 'REQUEST_NOT_FOUND',
        message: 'ไม่พบคำขอเชื่อมต่อที่รออนุมัติ'
      };
    }

    if (
      this.activeSender &&
      this.activeSender.deviceId !== req.deviceId &&
      !forceReplace
    ) {
      return {
        ok: false,
        code: 'SESSION_BUSY',
        message: `มีอุปกรณ์ "${this.activeSender.deviceName}" กำลังสตรีมอยู่ กรุณาตัดการเชื่อมต่อเครื่องเดิมก่อน`
      };
    }

    this.pendingApprovals.delete(requestId);
    this.approvedDevices.add(req.deviceId);

    const sender = this._activateSender({
      ws: req.ws,
      deviceId: req.deviceId,
      deviceName: req.deviceName,
      platform: req.platform,
      authMethod: 'mdns-prompt',
      orientation: req.orientation,
      width: req.width,
      height: req.height,
      remoteAddress: req.remoteAddress
    });

    if (req.ws && req.ws.readyState === 1) {
      req.ws.sendJson({
        type: 'auth-result',
        status: 'approved',
        requestId,
        deviceId: req.deviceId,
        sessionToken: this.sessionToken,
        targetConfig: { ...this.targetConfig }
      });
    }

    this.emit('approval-resolved', {
      requestId,
      status: 'approved',
      sender: this._serializeSender(sender)
    });

    return {
      ok: true,
      status: 'approved',
      sender: this._serializeSender(sender)
    };
  }

  denyPending(requestId, reason = 'ผู้ใช้ปฏิเสธคำขอเชื่อมต่อจากหน้าจอ PC') {
    const req = this.pendingApprovals.get(requestId);
    if (!req) {
      return {
        ok: false,
        code: 'REQUEST_NOT_FOUND',
        message: 'ไม่พบคำขอเชื่อมต่อที่รออนุมัติ'
      };
    }

    this.pendingApprovals.delete(requestId);

    if (req.ws && req.ws.readyState === 1) {
      req.ws.sendJson({
        type: 'auth-result',
        status: 'denied',
        requestId,
        reason
      });
    }

    this.emit('approval-resolved', {
      requestId,
      status: 'denied',
      deviceId: req.deviceId,
      deviceName: req.deviceName,
      reason
    });

    return {
      ok: true,
      status: 'denied',
      requestId
    };
  }

  _activateSender({
    ws,
    deviceId,
    deviceName,
    platform,
    authMethod,
    orientation,
    width,
    height,
    remoteAddress
  }) {
    // If replacing an existing sender, notify and close the old sender
    if (this.activeSender && this.activeSender.ws && this.activeSender.ws !== ws) {
      try {
        this.activeSender.ws.sendJson({
          type: 'session-replaced',
          message: `เซสชันถูกแทนที่โดยอุปกรณ์ "${deviceName}"`
        });
        this.activeSender.ws.close(4000, 'Session replaced');
      } catch {
        // ignore
      }
    }

    const normalized = this._normalizeDimensions(orientation, width, height);

    this.activeSender = {
      ws,
      deviceId,
      deviceName,
      platform,
      authMethod,
      remoteAddress,
      connectedAt: new Date().toISOString(),
      orientation: normalized.orientation,
      width: normalized.width,
      height: normalized.height,
      rotationDegrees: normalized.orientation === 'portrait' ? 0 : 90,
      audioStatus: {
        captured: true,
        mode: 'game-audio',
        codec: 'opus-48khz-stereo',
        warning: null
      },
      telemetry: {
        fps: this.targetConfig.fps,
        bitrateKbps: this.targetConfig.bitrateKbps,
        latencyMs: 0,
        packetLossPct: 0,
        batteryPct: 100,
        tempCelsius: 34.0,
        encoder: platform === 'ios' ? 'VideoToolbox H.264' : 'MediaCodec H.264',
        memoryMb: platform === 'ios' ? 24.5 : 42.0,
        updatedAt: new Date().toISOString()
      }
    };

    // Sync targetConfig dimensions with the device's initial orientation
    this._syncTargetDimensions(normalized.orientation, this.targetConfig.resolution);

    this.emit('sender-connected', this._serializeSender(this.activeSender));
    return this.activeSender;
  }

  _normalizeDimensions(orientation, width, height) {
    let w = Number(width) || 1920;
    let h = Number(height) || 1080;
    let orient = orientation;

    if (orient === 'portrait' && w > h) {
      [w, h] = [h, w];
    } else if (orient === 'landscape' && h > w) {
      [w, h] = [h, w];
    } else if (orient !== 'portrait' && orient !== 'landscape') {
      orient = h > w ? 'portrait' : 'landscape';
    }

    return { orientation: orient, width: w, height: h };
  }

  _syncTargetDimensions(orientation, resolution) {
    const is720 = resolution === '720p';
    const longSide = is720 ? 1280 : 1920;
    const shortSide = is720 ? 720 : 1080;

    if (orientation === 'portrait') {
      this.targetConfig.width = shortSide;
      this.targetConfig.height = longSide;
    } else {
      this.targetConfig.width = longSide;
      this.targetConfig.height = shortSide;
    }
  }

  updateOrientation({ orientation, width, height, rotationDegrees = null }) {
    if (!this.activeSender) return null;

    let nextOrient = orientation;
    let nextW = Number(width) || this.activeSender.width;
    let nextH = Number(height) || this.activeSender.height;

    if (!nextOrient) {
      nextOrient = nextH > nextW ? 'portrait' : 'landscape';
    }

    const normalized = this._normalizeDimensions(nextOrient, nextW, nextH);
    this.activeSender.orientation = normalized.orientation;
    this.activeSender.width = normalized.width;
    this.activeSender.height = normalized.height;
    if (rotationDegrees !== null) {
      this.activeSender.rotationDegrees = Number(rotationDegrees) || 0;
    } else {
      this.activeSender.rotationDegrees = normalized.orientation === 'portrait' ? 0 : 90;
    }

    this._syncTargetDimensions(normalized.orientation, this.targetConfig.resolution);

    const payload = {
      deviceId: this.activeSender.deviceId,
      orientation: this.activeSender.orientation,
      width: this.activeSender.width,
      height: this.activeSender.height,
      rotationDegrees: this.activeSender.rotationDegrees,
      aspectRatio:
        this.activeSender.orientation === 'portrait' ? '9 / 16' : '16 / 9'
    };

    this.emit('orientation-changed', payload);
    return payload;
  }

  updateAudioStatus({ captured, mode, warning = null, blockedApp = null }) {
    if (!this.activeSender) return null;

    const isCaptured = Boolean(captured);
    const resolvedMode = mode || (isCaptured ? 'game-audio' : 'video-only-blocked');
    const resolvedWarning =
      warning ||
      (!isCaptured
        ? `เกม${blockedApp ? ` (${blockedApp})` : ''} บล็อกการอัดเสียงภายใน (AudioPlaybackCapture) ระบบกำลังสตรีมเฉพาะภาพ`
        : null);

    this.activeSender.audioStatus = {
      captured: isCaptured,
      mode: resolvedMode,
      codec: isCaptured ? 'opus-48khz-stereo' : 'none',
      blockedApp: blockedApp || null,
      warning: resolvedWarning
    };

    this.emit('audio-status-changed', {
      deviceId: this.activeSender.deviceId,
      ...this.activeSender.audioStatus
    });

    return { ...this.activeSender.audioStatus };
  }

  updateTelemetry(partial = {}) {
    if (!this.activeSender) return null;

    const current = this.activeSender.telemetry;
    const clampNum = (val, fallback) =>
      typeof val === 'number' && Number.isFinite(val) ? val : fallback;

    this.activeSender.telemetry = {
      fps: clampNum(partial.fps, current.fps),
      bitrateKbps: clampNum(partial.bitrateKbps, current.bitrateKbps),
      latencyMs: clampNum(partial.latencyMs, current.latencyMs),
      packetLossPct: clampNum(partial.packetLossPct, current.packetLossPct),
      batteryPct: clampNum(partial.batteryPct, current.batteryPct),
      tempCelsius: clampNum(partial.tempCelsius, current.tempCelsius),
      encoder: partial.encoder || current.encoder,
      memoryMb: clampNum(partial.memoryMb, current.memoryMb),
      updatedAt: new Date().toISOString()
    };

    this.emit('telemetry-updated', {
      deviceId: this.activeSender.deviceId,
      telemetry: { ...this.activeSender.telemetry }
    });

    return { ...this.activeSender.telemetry };
  }

  updateTargetConfig(changes = {}, { notifySender = true } = {}) {
    if (changes.bitrateKbps !== undefined) {
      const br = Number(changes.bitrateKbps);
      if (Number.isFinite(br)) {
        this.targetConfig.bitrateKbps = Math.max(1000, Math.min(25000, Math.round(br)));
      }
    }

    if (changes.fps !== undefined) {
      const fps = Number(changes.fps);
      if ([24, 30, 60, 120].includes(fps)) {
        this.targetConfig.fps = fps;
      }
    }

    if (changes.resolution !== undefined && ['720p', '1080p'].includes(changes.resolution)) {
      this.targetConfig.resolution = changes.resolution;
    }

    const currentOrient = this.activeSender ? this.activeSender.orientation : 'landscape';
    this._syncTargetDimensions(currentOrient, this.targetConfig.resolution);

    if (notifySender && this.activeSender && this.activeSender.ws && this.activeSender.ws.readyState === 1) {
      this.activeSender.ws.sendJson({
        type: 'control',
        action: 'configure-encoder',
        config: { ...this.targetConfig }
      });
    }

    this.emit('config-updated', { ...this.targetConfig });
    return { ...this.targetConfig };
  }

  disconnectActiveSender(reason = 'ตัดการเชื่อมต่อจากฝั่ง PC') {
    if (!this.activeSender) return false;
    const prev = this._serializeSender(this.activeSender);
    const ws = this.activeSender.ws;
    this.activeSender = null;

    if (ws && ws.readyState === 1) {
      try {
        ws.sendJson({
          type: 'session-ended',
          reason
        });
        ws.close(1000, reason);
      } catch {
        // ignore
      }
    }

    this.emit('sender-disconnected', { sender: prev, reason });
    return true;
  }

  handleSocketClose(ws) {
    // Clean up any pending requests for this socket
    for (const [reqId, req] of this.pendingApprovals.entries()) {
      if (req.ws === ws) {
        this.pendingApprovals.delete(reqId);
        this.emit('approval-resolved', {
          requestId: reqId,
          status: 'cancelled',
          deviceId: req.deviceId,
          deviceName: req.deviceName
        });
      }
    }

    // Clean up active sender if it matches this socket
    if (this.activeSender && this.activeSender.ws === ws) {
      const prev = this._serializeSender(this.activeSender);
      this.activeSender = null;
      this.emit('sender-disconnected', {
        sender: prev,
        reason: 'อุปกรณ์ตัดการเชื่อมต่อ'
      });
    }
  }
}

module.exports = {
  SessionManager
};
