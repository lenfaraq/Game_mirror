(() => {
  const videoEl = document.getElementById('obs-video');
  const hudEl = document.getElementById('obs-hud');
  const params = new URLSearchParams(window.location.search);
  const showHud = params.get('hud') === '1';
  const viewerId = params.get('viewerId') || `obs-${Math.random().toString(36).slice(2, 8)}`;

  if (showHud) {
    document.body.dataset.showHud = 'true';
  }

  let ws = null;
  let pc = null;
  let remoteDescriptionReady = false;
  let pendingCandidates = [];
  let reconnectTimer = null;

  function applyOrientation(orientation, width, height) {
    const w = Number(width) || videoEl.videoWidth || 1920;
    const h = Number(height) || videoEl.videoHeight || 1080;
    const resolved = orientation || (h > w ? 'portrait' : 'landscape');

    document.body.dataset.orientation = resolved;
    document.documentElement.style.setProperty('--stream-width', String(w));
    document.documentElement.style.setProperty('--stream-height', String(h));
    document.documentElement.style.setProperty(
      '--stream-aspect',
      resolved === 'portrait' ? '9 / 16' : '16 / 9'
    );

    if (hudEl) {
      hudEl.textContent = `${resolved.toUpperCase()} (${w}x${h})`;
    }
  }

  // Native HTML5 video track dimension listener (triggers automatically when WebRTC frame dimensions rotate)
  videoEl.addEventListener('loadedmetadata', () => {
    if (videoEl.videoWidth && videoEl.videoHeight) {
      const orient = videoEl.videoHeight > videoEl.videoWidth ? 'portrait' : 'landscape';
      applyOrientation(orient, videoEl.videoWidth, videoEl.videoHeight);
    }
  });

  videoEl.addEventListener('resize', () => {
    if (videoEl.videoWidth && videoEl.videoHeight) {
      const orient = videoEl.videoHeight > videoEl.videoWidth ? 'portrait' : 'landscape';
      applyOrientation(orient, videoEl.videoWidth, videoEl.videoHeight);
    }
  });

  function cleanupPeerConnection() {
    remoteDescriptionReady = false;
    pendingCandidates = [];
    if (pc) {
      try {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.close();
      } catch {
        // ignore
      }
      pc = null;
    }
    videoEl.srcObject = null;
    document.body.dataset.streaming = 'false';
  }

  async function handleOffer(msg) {
    cleanupPeerConnection();

    if (msg.orientation || (msg.width && msg.height)) {
      applyOrientation(msg.orientation, msg.width, msg.height);
    }

    const currentPc = new RTCPeerConnection({
      iceServers: [], // LAN Direct Host Candidates only
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });
    pc = currentPc;

    const remoteStream = new MediaStream();
    videoEl.srcObject = remoteStream;

    currentPc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        videoEl.srcObject = event.streams[0];
      } else if (event.track) {
        remoteStream.addTrack(event.track);
      }

      document.body.dataset.streaming = 'true';

      // Attempt unmuted playback for OBS Audio Mixer; fallback to muted if tested in regular desktop browser without gesture
      videoEl.muted = params.get('muted') === '1';
      const playPromise = videoEl.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {
          videoEl.muted = true;
          videoEl.play().catch(() => {});
        });
      }
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

    currentPc.onconnectionstatechange = () => {
      if (currentPc === pc && (currentPc.connectionState === 'disconnected' || currentPc.connectionState === 'failed' || currentPc.connectionState === 'closed')) {
        document.body.dataset.streaming = 'false';
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
        // ignore candidate error
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
  }

  function connectSignaling() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws?role=obs&viewerId=${encodeURIComponent(viewerId)}`;
    ws = new WebSocket(wsUrl);

    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'viewer-registered': {
          const active = msg.state && msg.state.activeSender;
          if (active) {
            applyOrientation(active.orientation, active.width, active.height);
          }
          break;
        }

        case 'sender-connected': {
          if (msg.sender) {
            applyOrientation(msg.sender.orientation, msg.sender.width, msg.sender.height);
          }
          break;
        }

        case 'orientation-changed': {
          applyOrientation(msg.orientation, msg.width, msg.height);
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
                // ignore candidate error
              }
            }
          }
          break;
        }

        case 'sender-disconnected': {
          cleanupPeerConnection();
          break;
        }

        default:
          break;
      }
    };

    ws.onclose = () => {
      cleanupPeerConnection();
      reconnectTimer = setTimeout(connectSignaling, 1500);
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
  }

  connectSignaling();
})();
