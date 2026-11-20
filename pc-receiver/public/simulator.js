(() => {
  const canvas = document.getElementById('sim-canvas');
  const ctx = canvas.getContext('2d');
  const btnRotate = document.getElementById('btn-rotate');
  const btnToggleAudioBlock = document.getElementById('btn-toggle-audio-block');
  const btnStart = document.getElementById('btn-start-stream');
  const btnStop = document.getElementById('btn-stop-stream');
  const inputDeviceName = document.getElementById('input-device-name');
  const selectPlatform = document.getElementById('select-platform');
  const selectAuthMode = document.getElementById('select-auth-mode');
  const statusPill = document.getElementById('sim-status-pill');
  const simLog = document.getElementById('sim-log');

  let orientation = 'landscape';
  let targetFps = 60;
  let targetBitrateKbps = 8000;
  let audioBlocked = false;
  let ws = null;
  let localStream = null;
  let telemetryTimer = null;
  const peerConnections = new Map(); // viewerId -> { pc, dc }
  const deviceId = `sim-${Math.random().toString(36).slice(2, 9)}`;

  function log(text) {
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    simLog.prepend(line);
  }

  // Animated 60FPS Game HUD Canvas
  let tick = 0;
  function renderFrame() {
    tick++;
    const w = canvas.width;
    const h = canvas.height;

    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#0f172a');
    grad.addColorStop(0.5, '#1e1b4b');
    grad.addColorStop(1, '#064e3b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Moving tactical grid & radar orb
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.16)';
    ctx.lineWidth = 1;
    const step = 60;
    for (let x = (tick * 2) % step; x < w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    const orbX = w / 2 + Math.cos(tick * 0.04) * (w * 0.25);
    const orbY = h / 2 + Math.sin(tick * 0.06) * (h * 0.22);
    ctx.beginPath();
    ctx.arc(orbX, orbY, 44, 0, Math.PI * 2);
    ctx.fillStyle = '#38bdf8';
    ctx.fill();

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 28px Segoe UI, sans-serif';
    ctx.fillText(`🎮 WIRELESS GAME MIRROR (${orientation.toUpperCase()})`, 36, 56);
    ctx.font = '20px monospace';
    ctx.fillStyle = '#38bdf8';
    ctx.fillText(`Resolution: ${w}x${h} @ ${targetFps}fps | Bitrate: ${(targetBitrateKbps / 1000).toFixed(1)} Mbps`, 36, 92);
    ctx.fillStyle = audioBlocked ? '#f59e0b' : '#10b981';
    ctx.fillText(
      audioBlocked
        ? '⚠️ AudioPlaybackCapture: BLOCKED BY GAME (Video-Only Mode)'
        : '🔊 Audio: Opus 48kHz Stereo Game Audio Active',
      36,
      126
    );

    requestAnimationFrame(renderFrame);
  }
  requestAnimationFrame(renderFrame);

  btnRotate.addEventListener('click', () => {
    if (orientation === 'landscape') {
      orientation = 'portrait';
      canvas.width = 720;
      canvas.height = 1280;
    } else {
      orientation = 'landscape';
      canvas.width = 1280;
      canvas.height = 720;
    }
    log(`หมุนหน้าจอเป็น ${orientation.toUpperCase()} (${canvas.width}x${canvas.height})`);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'orientation',
          orientation,
          width: canvas.width === 720 ? 1080 : 1920,
          height: canvas.height === 1280 ? 1920 : 1080,
          rotationDegrees: orientation === 'portrait' ? 0 : 90
        })
      );
    }
  });

  btnToggleAudioBlock.addEventListener('click', () => {
    audioBlocked = !audioBlocked;
    btnToggleAudioBlock.textContent = audioBlocked
      ? '🔇 ยกเลิกการจำลองบล็อกเสียง'
      : '🔊 จำลองเกมบล็อกเสียง (Android)';

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'audio-status',
          captured: !audioBlocked,
          mode: audioBlocked ? 'video-only-blocked' : 'game-audio',
          blockedApp: audioBlocked ? 'PUBG / Competitive Game' : null
        })
      );
      log(audioBlocked ? 'ส่งสถานะแจ้งเตือนเกมบล็อกเสียงภายในไปที่ PC' : 'กลับมาส่งเสียงเกมปกติ');
    }
  });

  async function createOfferForViewer(viewerId) {
    if (!localStream || !ws || ws.readyState !== WebSocket.OPEN) return;

    if (peerConnections.has(viewerId)) {
      try {
        peerConnections.get(viewerId).pc.close();
      } catch {
        // ignore
      }
      peerConnections.delete(viewerId);
    }

    const pc = new RTCPeerConnection({ iceServers: [] });
    const dc = pc.createDataChannel('telemetry');

    dc.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'control') {
          applyControl(msg);
        }
      } catch {
        // ignore
      }
    };

    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });

    pc.onicecandidate = (e) => {
      if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'ice-candidate',
            viewerId,
            candidate: e.candidate
          })
        );
      }
    };

    peerConnections.set(viewerId, {
      pc,
      dc,
      remoteDescriptionReady: false,
      pendingCandidates: []
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    ws.send(
      JSON.stringify({
        type: 'offer',
        viewerId,
        sdp: offer.sdp
      })
    );
    log(`ส่ง WebRTC SDP Offer ไปยัง Viewer [${viewerId}]`);
  }

  function applyControl(ctrl) {
    const cfg = ctrl.config || ctrl;
    if (cfg.bitrateKbps) targetBitrateKbps = Number(cfg.bitrateKbps);
    if (cfg.fps) targetFps = Number(cfg.fps);
    log(`รับคำสั่งจาก PC: Bitrate=${targetBitrateKbps}kbps, FPS=${targetFps}`);
  }

  btnStart.addEventListener('click', async () => {
    btnStart.disabled = true;
    btnStop.disabled = false;

    let token = null;
    const urlParams = new URLSearchParams(window.location.search || '');
    const queryToken = urlParams.get('token');
    if (selectAuthMode.value === 'qr') {
      if (queryToken) {
        token = queryToken;
        log(`ใช้ QR Session Token จากลิงก์ที่สแกน (${token.slice(0, 8)}...)`);
      } else {
        const res = await fetch('/api/pairing-info');
        const info = await res.json();
        token = info.token;
        log(`ดึง QR Session Token สำเร็จ (${token.slice(0, 8)}...)`);
      }
    } else {
      log('เชื่อมต่อแบบ mDNS Discovery (รอการกด Allow บนหน้าจอ PC Dashboard)');
    }

    localStream = canvas.captureStream(targetFps);
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${window.location.host}/ws`);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'join-sender',
          deviceId,
          deviceName: inputDeviceName.value || 'Mobile Streamer',
          platform: selectPlatform.value,
          token,
          orientation,
          width: orientation === 'portrait' ? 1080 : 1920,
          height: orientation === 'portrait' ? 1920 : 1080
        })
      );
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'auth-result': {
          if (msg.status === 'approved') {
            statusPill.className = 'pill online';
            statusPill.textContent = '● กำลังสตรีมสด (Approved)';
            log('ได้รับการอนุมัติเซสชัน เริ่มส่งสัญญาณ WebRTC...');

            telemetryTimer = setInterval(() => {
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: 'telemetry',
                    telemetry: {
                      fps: targetFps,
                      bitrateKbps: targetBitrateKbps,
                      latencyMs: 38,
                      packetLossPct: 0,
                      batteryPct: 88,
                      tempCelsius: 36.4,
                      memoryMb: selectPlatform.value === 'ios' ? 23.8 : 44.2,
                      encoder:
                        selectPlatform.value === 'ios'
                          ? 'VideoToolbox H.264 (Zero B-frames)'
                          : 'MediaCodec H.264 Low-Latency'
                    }
                  })
                );
              }
            }, 2000);
          } else if (msg.status === 'pending-approval') {
            statusPill.className = 'pill waiting';
            statusPill.textContent = '● รอกด Allow บนหน้าจอ PC';
            log(msg.message);
          } else {
            statusPill.className = 'pill waiting';
            statusPill.textContent = `● ถูกปฏิเสธ (${msg.status})`;
            log(`การเชื่อมต่อถูกปฏิเสธ: ${msg.message || msg.reason || msg.status}`);
            stopStream();
          }
          break;
        }

        case 'viewer-joined': {
          await createOfferForViewer(msg.viewerId);
          break;
        }

        case 'viewer-left': {
          const entry = peerConnections.get(msg.viewerId);
          if (entry) {
            try {
              if (entry.dc) entry.dc.close();
            } catch {
              // ignore
            }
            try {
              if (entry.pc) entry.pc.close();
            } catch {
              // ignore
            }
            peerConnections.delete(msg.viewerId);
            log(`Viewer [${msg.viewerId}] ตัดการเชื่อมต่อ ปิด PeerConnection เรียบร้อย`);
          }
          break;
        }

        case 'answer': {
          const entry = peerConnections.get(msg.viewerId);
          if (entry && entry.pc) {
            await entry.pc.setRemoteDescription(
              new RTCSessionDescription({ type: 'answer', sdp: msg.sdp })
            );
            entry.remoteDescriptionReady = true;
            while (entry.pendingCandidates.length > 0) {
              const queued = entry.pendingCandidates.shift();
              try {
                await entry.pc.addIceCandidate(new RTCIceCandidate(queued));
              } catch {
                // ignore
              }
            }
            log(`เชื่อมต่อ WebRTC กับ [${msg.viewerId}] สำเร็จ!`);
          }
          break;
        }

        case 'ice-candidate': {
          const entry = peerConnections.get(msg.viewerId);
          if (entry && entry.pc && msg.candidate) {
            if (!entry.remoteDescriptionReady) {
              entry.pendingCandidates.push(msg.candidate);
            } else {
              try {
                await entry.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
              } catch {
                // ignore
              }
            }
          }
          break;
        }

        case 'control': {
          applyControl(msg);
          break;
        }

        case 'session-ended':
        case 'session-replaced': {
          log(`เซสชันสิ้นสุด: ${msg.reason || msg.message}`);
          stopStream();
          break;
        }

        default:
          break;
      }
    };

    ws.onclose = () => {
      stopStream();
    };
  });

  function stopStream() {
    if (telemetryTimer) {
      clearInterval(telemetryTimer);
      telemetryTimer = null;
    }
    for (const { pc } of peerConnections.values()) {
      try {
        pc.close();
      } catch {
        // ignore
      }
    }
    peerConnections.clear();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    ws = null;
    btnStart.disabled = false;
    btnStop.disabled = true;
    statusPill.className = 'pill waiting';
    statusPill.textContent = '● ยังไม่ได้เชื่อมต่อ';
  }

  btnStop.addEventListener('click', stopStream);

  const btnOpenNativeApp = document.getElementById('btn-open-native-app');
  if (btnOpenNativeApp) {
    btnOpenNativeApp.addEventListener('click', async () => {
      const res = await fetch('/api/pairing-info');
      const info = await res.json();
      if (info && info.uri) {
        window.location.href = info.uri;
      }
    });
  }

  // Auto-connect immediately when opened by scanning the QR Code (/connect?token=...)
  const initParams = new URLSearchParams(window.location.search || '');
  if (initParams.get('token')) {
    selectAuthMode.value = 'qr';
    setTimeout(() => {
      if (!btnStart.disabled) {
        btnStart.click();
      }
    }, 150);
  }
})();
