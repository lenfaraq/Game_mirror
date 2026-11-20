(() => {
  const viewerId = `dashboard-${Math.random().toString(36).slice(2, 8)}`;

  const previewViewport = document.getElementById('preview-viewport');
  const previewVideo = document.getElementById('preview-video');
  const sessionPill = document.getElementById('session-status-pill');
  const orientationBadge = document.getElementById('orientation-badge');
  const btnToggleAudio = document.getElementById('btn-toggle-audio');
  const btnForceIdr = document.getElementById('btn-force-idr');
  const btnDisconnect = document.getElementById('btn-disconnect-device');
  const audioWarningBanner = document.getElementById('audio-warning-banner');
  const audioWarningText = document.getElementById('audio-warning-text');

  const qrSvgHolder = document.getElementById('qr-svg-holder');
  const lanIpSelect = document.getElementById('lan-ip-select');
  const obsUrlInput = document.getElementById('obs-url-input');
  const btnCopyObs = document.getElementById('btn-copy-obs');
  const btnRotateToken = document.getElementById('btn-rotate-token');

  const sliderBitrate = document.getElementById('slider-bitrate');
  const labelBitrateVal = document.getElementById('label-bitrate-val');
  const labelFpsVal = document.getElementById('label-fps-val');
  const labelResVal = document.getElementById('label-res-val');

  const statFps = document.getElementById('stat-fps');
  const statResolution = document.getElementById('stat-resolution');
  const statBitrate = document.getElementById('stat-bitrate');
  const statEncoder = document.getElementById('stat-encoder');
  const statLatency = document.getElementById('stat-latency');
  const statLoss = document.getElementById('stat-loss');
  const statBattery = document.getElementById('stat-battery');
  const statThermal = document.getElementById('stat-thermal');

  const approvalOverlay = document.getElementById('approval-overlay');
  const approvalList = document.getElementById('approval-list');

  let ws = null;
  let pc = null;
  let remoteDescriptionReady = false;
  let pendingCandidates = [];
  let dataChannel = null;
  let statsTimer = null;
  let lastBytesReceived = 0;
  let lastStatsTimestamp = 0;

  // Load Pairing Info & QR Code
  async function loadPairingInfo(selectedIp = '') {
    const query = selectedIp ? `?ip=${encodeURIComponent(selectedIp)}` : '';
    const res = await fetch(`/api/pairing-info${query}`);
    const data = await res.json();
    if (!data.ok) return;

    qrSvgHolder.innerHTML = data.qrSvg;
    obsUrlInput.value = data.obsUrl;

    if (Array.isArray(data.lanAddresses) && lanIpSelect.options.length === 0) {
      lanIpSelect.innerHTML = '';
      for (const item of data.lanAddresses) {
        const opt = document.createElement('option');
        opt.value = item.address;
        opt.textContent = `${item.address} (${item.name})`;
        if (item.address === data.ip) opt.selected = true;
        lanIpSelect.appendChild(opt);
      }
    }
  }

  lanIpSelect.addEventListener('change', () => {
    loadPairingInfo(lanIpSelect.value);
  });

  btnRotateToken.addEventListener('click', async () => {
    const ip = lanIpSelect.value || '';
    const res = await fetch(`/api/session/rotate-token?ip=${encodeURIComponent(ip)}`, {
      method: 'POST'
    });
    const data = await res.json();
    if (data.ok) {
      qrSvgHolder.innerHTML = data.qrSvg;
    }
  });

  btnCopyObs.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(obsUrlInput.value);
      btnCopyObs.textContent = 'คัดลอกแล้ว ✓';
      setTimeout(() => {
        btnCopyObs.textContent = 'คัดลอก';
      }, 1500);
    } catch {
      obsUrlInput.select();
    }
  });

  btnToggleAudio.addEventListener('click', () => {
    previewVideo.muted = !previewVideo.muted;
    btnToggleAudio.textContent = previewVideo.muted
      ? '🔇 เปิดฟังเสียงเกมบน PC'
      : '🔊 ปิดเสียงตัวอย่างบน PC';
  });

  btnForceIdr.addEventListener('click', () => {
    sendControlCommand({ action: 'request-keyframe' });
  });

  btnDisconnect.addEventListener('click', async () => {
    await fetch('/api/session/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'ผู้ใช้กดตัดการเชื่อมต่อจากหน้าจอ PC' })
    });
  });

  // Orientation & Audio Warning UI Helpers
  function updateOrientationUI(orientation, width, height) {
    const w = Number(width) || previewVideo.videoWidth || 1920;
    const h = Number(height) || previewVideo.videoHeight || 1080;
    const orient = orientation || (h > w ? 'portrait' : 'landscape');

    previewViewport.dataset.orientation = orient;
    orientationBadge.textContent = `${orient.toUpperCase()} ${w}x${h}`;
  }

  previewVideo.addEventListener('loadedmetadata', () => {
    if (previewVideo.videoWidth && previewVideo.videoHeight) {
      updateOrientationUI(null, previewVideo.videoWidth, previewVideo.videoHeight);
    }
  });

  previewVideo.addEventListener('resize', () => {
    if (previewVideo.videoWidth && previewVideo.videoHeight) {
      updateOrientationUI(null, previewVideo.videoWidth, previewVideo.videoHeight);
    }
  });

  function updateAudioWarningUI(audioStatus) {
    if (audioStatus && audioStatus.captured === false) {
      audioWarningBanner.classList.add('visible');
      audioWarningText.textContent =
        audioStatus.warning ||
        'เกมนี้บล็อกการอัดเสียงภายใน (AudioPlaybackCapture) ระบบกำลังส่งเฉพาะภาพหน้าจอ';
    } else {
      audioWarningBanner.classList.remove('visible');
    }
  }

  function updateTelemetryUI(telemetry) {
    if (!telemetry) return;
    if (typeof telemetry.fps === 'number') {
      statFps.textContent = `${Math.round(telemetry.fps)} fps`;
    }
    if (typeof telemetry.bitrateKbps === 'number') {
      statBitrate.textContent = `${(telemetry.bitrateKbps / 1000).toFixed(1)} Mbps`;
    }
    if (telemetry.encoder) {
      statEncoder.textContent = telemetry.encoder;
    }
    if (typeof telemetry.latencyMs === 'number') {
      statLatency.textContent = `${Math.round(telemetry.latencyMs)} ms`;
    }
    if (typeof telemetry.packetLossPct === 'number') {
      statLoss.textContent = `Packet Loss: ${telemetry.packetLossPct.toFixed(2)}%`;
    }
    if (typeof telemetry.batteryPct === 'number') {
      statBattery.textContent = `${Math.round(telemetry.batteryPct)}%`;
    }
    const temp = typeof telemetry.tempCelsius === 'number' ? `${telemetry.tempCelsius.toFixed(1)}°C` : '--°C';
    const mem = typeof telemetry.memoryMb === 'number' ? `${telemetry.memoryMb.toFixed(1)} MB` : '-- MB';
    statThermal.textContent = `อุณหภูมิ: ${temp} | RAM: ${mem}`;
  }

  function syncStateUI(state) {
    if (!state) return;

    if (state.hasActiveSender && state.activeSender) {
      const s = state.activeSender;
      sessionPill.className = 'pill online';
      sessionPill.textContent = `● กำลังสตรีม: ${s.deviceName} (${s.platform.toUpperCase()})`;
      btnDisconnect.style.display = 'inline-flex';
      updateOrientationUI(s.orientation, s.width, s.height);
      updateAudioWarningUI(s.audioStatus);
      updateTelemetryUI(s.telemetry);
    } else {
      sessionPill.className = 'pill waiting';
      sessionPill.textContent = '● รอการเชื่อมต่อมือถือ (1 เครื่อง)';
      btnDisconnect.style.display = 'none';
      audioWarningBanner.classList.remove('visible');
    }

    renderPendingApprovals(state.pendingApprovals || []);
  }

  // mDNS Allow / Deny Pending Approvals Modal
  function renderPendingApprovals(list) {
    if (!Array.isArray(list) || list.length === 0) {
      approvalOverlay.classList.remove('visible');
      approvalList.innerHTML = '';
      return;
    }

    approvalOverlay.classList.add('visible');
    approvalList.innerHTML = '';

    for (const item of list) {
      const box = document.createElement('div');
      box.className = 'approval-item';
      box.innerHTML = `
        <div style="font-weight: 700; font-size: 15px;">📱 ${escapeHtml(item.deviceName)} (${escapeHtml(item.platform.toUpperCase())})</div>
        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
          IP Address: <code>${escapeHtml(item.remoteAddress)}</code> | Device ID: <code>${escapeHtml(item.deviceId)}</code>
        </div>
        <div class="approval-actions">
          <button class="btn btn-success" data-approve="${escapeHtml(item.requestId)}">✓ อนุญาต (Allow)</button>
          <button class="btn btn-danger" data-deny="${escapeHtml(item.requestId)}">✖ ปฏิเสธ (Deny)</button>
        </div>
      `;
      approvalList.appendChild(box);
    }

    approvalList.querySelectorAll('[data-approve]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const requestId = btn.getAttribute('data-approve');
        await fetch('/api/session/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, forceReplace: true })
        });
      });
    });

    approvalList.querySelectorAll('[data-deny]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const requestId = btn.getAttribute('data-deny');
        await fetch('/api/session/deny', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId })
        });
      });
    });
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Real-Time Bitrate / FPS / Resolution Controls (DataChannel primary + single Server/WS sync)
  function sendControlCommand(payload) {
    const message = JSON.stringify({
      type: 'control',
      ...payload
    });

    let sentOverDataChannel = false;
    if (dataChannel && dataChannel.readyState === 'open') {
      try {
        dataChannel.send(message);
        sentOverDataChannel = true;
      } catch {
        sentOverDataChannel = false;
      }
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'control',
          syncOnly: sentOverDataChannel,
          ...payload
        })
      );
      return;
    }

    fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        syncOnly: sentOverDataChannel,
        ...payload
      })
    }).catch(() => {});
  }

  sliderBitrate.addEventListener('input', () => {
    const kbps = Number(sliderBitrate.value);
    labelBitrateVal.textContent = `${(kbps / 1000).toFixed(1)} Mbps (${kbps} kbps)`;
  });

  sliderBitrate.addEventListener('change', () => {
    const kbps = Number(sliderBitrate.value);
    setBitrateUI(kbps);
    sendControlCommand({ bitrateKbps: kbps });
  });

  function setBitrateUI(kbps) {
    sliderBitrate.value = String(kbps);
    labelBitrateVal.textContent = `${(kbps / 1000).toFixed(1)} Mbps (${kbps} kbps)`;
    document.querySelectorAll('.bitrate-preset').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.kbps) === kbps);
    });
  }

  document.querySelectorAll('.bitrate-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kbps = Number(btn.dataset.kbps);
      setBitrateUI(kbps);
      sendControlCommand({ bitrateKbps: kbps });
    });
  });

  document.querySelectorAll('.fps-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fps = Number(btn.dataset.fps);
      labelFpsVal.textContent = `${fps} FPS`;
      document.querySelectorAll('.fps-preset').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.fps) === fps);
      });
      sendControlCommand({ fps });
    });
  });

  document.querySelectorAll('.res-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const res = btn.dataset.res;
      labelResVal.textContent = res === '720p' ? '720p (HD)' : '1080p (Full HD)';
      statResolution.textContent = `เป้าหมาย: ${res}`;
      document.querySelectorAll('.res-preset').forEach((b) => {
        b.classList.toggle('active', b.dataset.res === res);
      });
      sendControlCommand({ resolution: res });
    });
  });

  // WebRTC PeerConnection for Dashboard Live Preview & DataChannel
  function cleanupPeerConnection() {
    remoteDescriptionReady = false;
    pendingCandidates = [];
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
    if (dataChannel) {
      try {
        dataChannel.close();
      } catch {
        // ignore
      }
      dataChannel = null;
    }
    if (pc) {
      try {
        pc.close();
      } catch {
        // ignore
      }
      pc = null;
    }
    previewVideo.srcObject = null;
    previewViewport.dataset.streaming = 'false';
  }

  async function handleOffer(msg) {
    cleanupPeerConnection();

    if (msg.orientation || (msg.width && msg.height)) {
      updateOrientationUI(msg.orientation, msg.width, msg.height);
    }

    const currentPc = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });
    pc = currentPc;

    const remoteStream = new MediaStream();
    previewVideo.srcObject = remoteStream;

    currentPc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        previewVideo.srcObject = event.streams[0];
      } else if (event.track) {
        remoteStream.addTrack(event.track);
      }
      previewViewport.dataset.streaming = 'true';
      previewVideo.play().catch(() => {});
    };

    currentPc.ondatachannel = (event) => {
      dataChannel = event.channel;
      dataChannel.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'telemetry') {
            updateTelemetryUI(data.telemetry || data);
          } else if (data.type === 'orientation') {
            updateOrientationUI(data.orientation, data.width, data.height);
          } else if (data.type === 'audio-status') {
            updateAudioWarningUI(data);
          }
        } catch {
          // ignore
        }
      };
    };

    currentPc.onicecandidate = (event) => {
      if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'ice-candidate',
            viewerId,
            candidate: event.candidate
          })
        );
      }
    };

    await currentPc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
    if (currentPc !== pc) return;

    remoteDescriptionReady = true;
    while (pendingCandidates.length > 0) {
      const queued = pendingCandidates.shift();
      try {
        await currentPc.addIceCandidate(new RTCIceCandidate(queued));
      } catch {
        // ignore
      }
    }

    const answer = await currentPc.createAnswer();
    await currentPc.setLocalDescription(answer);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'answer',
          viewerId,
          sdp: answer.sdp
        })
      );
    }

    startWebRTCStatsMonitor();
  }

  function startWebRTCStatsMonitor() {
    lastBytesReceived = 0;
    lastStatsTimestamp = performance.now();

    statsTimer = setInterval(async () => {
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        let fps = null;
        let bitrateKbps = null;
        let latencyMs = null;
        let packetLossPct = null;

        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            if (typeof report.framesPerSecond === 'number') {
              fps = report.framesPerSecond;
            }
            if (typeof report.bytesReceived === 'number') {
              const now = performance.now();
              const dtSec = (now - lastStatsTimestamp) / 1000;
              if (dtSec > 0 && lastBytesReceived > 0) {
                bitrateKbps = Math.round(((report.bytesReceived - lastBytesReceived) * 8) / 1000 / dtSec);
              }
              lastBytesReceived = report.bytesReceived;
              lastStatsTimestamp = now;
            }
            if (typeof report.packetsLost === 'number' && typeof report.packetsReceived === 'number') {
              const total = report.packetsLost + report.packetsReceived;
              if (total > 0) {
                packetLossPct = Math.max(0, (report.packetsLost / total) * 100);
              }
            }
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (typeof report.currentRoundTripTime === 'number') {
              latencyMs = report.currentRoundTripTime * 1000;
            }
          }
        });

        const partial = {};
        if (fps !== null) partial.fps = fps;
        if (bitrateKbps !== null) partial.bitrateKbps = bitrateKbps;
        if (latencyMs !== null) partial.latencyMs = latencyMs;
        if (packetLossPct !== null) partial.packetLossPct = packetLossPct;

        if (Object.keys(partial).length > 0 && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'receiver-telemetry', telemetry: partial }));
        }
      } catch {
        // ignore stats error
      }
    }, 1500);
  }

  // Signaling WebSocket Connection
  function connectSignaling() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${window.location.host}/ws?role=dashboard&viewerId=${encodeURIComponent(viewerId)}`);

    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'viewer-registered':
        case 'approval-requested':
        case 'approval-resolved':
        case 'sender-connected': {
          syncStateUI(msg.state);
          break;
        }

        case 'sender-disconnected': {
          cleanupPeerConnection();
          syncStateUI(msg.state);
          break;
        }

        case 'orientation-changed': {
          updateOrientationUI(msg.orientation, msg.width, msg.height);
          break;
        }

        case 'audio-status-changed': {
          updateAudioWarningUI(msg);
          break;
        }

        case 'telemetry-updated': {
          updateTelemetryUI(msg.telemetry);
          break;
        }

        case 'token-rotated': {
          if (msg.pairing && msg.pairing.qrSvg) {
            qrSvgHolder.innerHTML = msg.pairing.qrSvg;
          }
          break;
        }

        case 'offer': {
          if (!msg.viewerId || msg.viewerId === viewerId) {
            await handleOffer(msg);
          }
          break;
        }

        case 'ice-candidate': {
          if (pc && msg.candidate && (!msg.viewerId || msg.viewerId === viewerId)) {
            if (!remoteDescriptionReady) {
              pendingCandidates.push(msg.candidate);
            } else {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
              } catch {
                // ignore
              }
            }
          }
          break;
        }

        default:
          break;
      }
    };

    ws.onclose = () => {
      cleanupPeerConnection();
      setTimeout(connectSignaling, 1500);
    };
  }

  loadPairingInfo();
  connectSignaling();
})();
