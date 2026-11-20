package com.wirelessgamemirror.sender

import android.content.Context
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.view.Surface
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpParameters
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap

/**
 * Manages Multi-Viewer WebRTC PeerConnections (`peerConnections[viewerId]`) on Android
 * so both PC Dashboard (`/`) and OBS Browser Source (`/obs`) receive H.264 Video + Opus 48kHz Game Audio.
 * Shares the single `MediaProjection` instance created by `ScreenCaptureService` to avoid
 * duplicate `getMediaProjection()` token exhaustion on Android 14+.
 */
class WebRTCManager(
    private val context: Context,
    private val signalingClient: SignalingClient,
    private val onControlCommand: (bitrateKbps: Int?, fps: Int?, resolution: String?, forceKeyframe: Boolean) -> Unit
) {
    private val eglBase: EglBase = EglBase.create()
    private val peerConnections = ConcurrentHashMap<String, PeerConnection>()
    private val dataChannels = ConcurrentHashMap<String, DataChannel>()
    private val remoteDescriptionReady = ConcurrentHashMap<String, Boolean>()
    private val pendingIceCandidates = ConcurrentHashMap<String, MutableList<IceCandidate>>()

    private var peerConnectionFactory: PeerConnectionFactory? = null
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var captureSurface: Surface? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var videoSource: VideoSource? = null
    private var localVideoTrack: VideoTrack? = null
    private var audioSource: AudioSource? = null
    private var localAudioTrack: AudioTrack? = null

    private var currentBitrateKbps: Int = 8000
    private var currentFps: Int = 60

    init {
        initPeerConnectionFactory()
    }

    private fun initPeerConnectionFactory() {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
        )

        val encoderFactory = DefaultVideoEncoderFactory(
            eglBase.eglBaseContext,
            /* enableIntelVp8Encoder = */ false,
            /* enableH264HighProfile = */ true
        )
        val decoderFactory = DefaultVideoDecoderFactory(eglBase.eglBaseContext)

        peerConnectionFactory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .createPeerConnectionFactory()
    }

    fun startLocalMediaCapture(
        mediaProjection: MediaProjection,
        width: Int,
        height: Int,
        fps: Int,
        densityDpi: Int
    ) {
        val factory = peerConnectionFactory ?: return
        currentFps = fps

        val helper = SurfaceTextureHelper.create("WGM-CaptureThread", eglBase.eglBaseContext)
        helper.setTextureSize(width, height)
        val surface = Surface(helper.surfaceTexture)
        val vSource = factory.createVideoSource(/* isScreencast = */ true)
        vSource.adaptOutputFormat(width, height, fps)
        vSource.capturerObserver.onCapturerStarted(true)

        helper.startListening { videoFrame ->
            vSource.capturerObserver.onFrameCaptured(videoFrame)
        }

        val vDisplay = mediaProjection.createVirtualDisplay(
            "WGM-ScreenCaptureDisplay",
            width,
            height,
            densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            surface,
            null,
            null
        )

        surfaceTextureHelper = helper
        captureSurface = surface
        virtualDisplay = vDisplay
        videoSource = vSource
        localVideoTrack = factory.createVideoTrack("wgm_android_video0", vSource).apply {
            setEnabled(true)
        }

        val audioConstraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("googHighpassFilter", "false"))
        }
        val aSource = factory.createAudioSource(audioConstraints)
        audioSource = aSource
        localAudioTrack = factory.createAudioTrack("wgm_android_audio0", aSource).apply {
            setEnabled(true)
        }
    }

    /**
     * Dynamically adapts capture resolution & framerate when phone rotates between
     * Portrait (`1080x1920`) and Landscape (`1920x1080`) without dropping WebRTC connections.
     */
    fun changeCaptureFormat(width: Int, height: Int, fps: Int, densityDpi: Int) {
        currentFps = fps
        try {
            surfaceTextureHelper?.setTextureSize(width, height)
            virtualDisplay?.resize(width, height, densityDpi)
            videoSource?.adaptOutputFormat(width, height, fps)
        } catch (_: Exception) {
        }
    }

    /**
     * Dynamically updates WebRTC RTP Video Sender maxBitrateBps across all active viewers (Dashboard & OBS).
     */
    fun applyBitrateKbps(bitrateKbps: Int) {
        currentBitrateKbps = bitrateKbps.coerceIn(1000, 25000)
        val maxBps = currentBitrateKbps * 1000

        for (pc in peerConnections.values) {
            for (sender in pc.senders) {
                if (sender.track()?.kind() == MediaStreamTrack.VIDEO_TRACK_KIND) {
                    val params: RtpParameters = sender.parameters
                    if (params.encodings.isNotEmpty()) {
                        params.encodings[0].maxBitrateBps = maxBps
                        params.encodings[0].maxFramerate = currentFps
                        sender.parameters = params
                    }
                }
            }
        }
    }

    fun createOfferForViewer(viewerId: String) {
        val factory = peerConnectionFactory ?: return
        handleViewerLeft(viewerId)
        remoteDescriptionReady[viewerId] = false
        pendingIceCandidates[viewerId] = Collections.synchronizedList(mutableListOf())

        val rtcConfig = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }

        val pc = factory.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onSignalingChange(newState: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState?) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState?) {}

            override fun onIceCandidate(candidate: IceCandidate?) {
                if (candidate != null) {
                    signalingClient.sendIceCandidate(
                        sdpMid = candidate.sdpMid,
                        sdpMLineIndex = candidate.sdpMLineIndex,
                        candidateSdp = candidate.sdp,
                        viewerId = viewerId
                    )
                }
            }

            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
            override fun onAddStream(stream: org.webrtc.MediaStream?) {}
            override fun onRemoveStream(stream: org.webrtc.MediaStream?) {}
            override fun onDataChannel(dc: DataChannel?) {}
            override fun onRenegotiationNeeded() {}
        }) ?: return

        localVideoTrack?.let { pc.addTrack(it, listOf("wgm_stream0")) }
        localAudioTrack?.let { pc.addTrack(it, listOf("wgm_stream0")) }

        val dcInit = DataChannel.Init().apply { ordered = true }
        val dc = pc.createDataChannel("telemetry", dcInit)
        dc?.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}
            override fun onStateChange() {}
            override fun onMessage(buffer: DataChannel.Buffer) {
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                val text = String(bytes, StandardCharsets.UTF_8)
                try {
                    val json = JSONObject(text)
                    if (json.optString("type") == "control") {
                        val cfg = json.optJSONObject("config") ?: json
                        onControlCommand(
                            if (cfg.has("bitrateKbps")) cfg.optInt("bitrateKbps") else null,
                            if (cfg.has("fps")) cfg.optInt("fps") else null,
                            if (cfg.has("resolution")) cfg.optString("resolution") else null,
                            json.optString("action") == "request-keyframe"
                        )
                    }
                } catch (_: Exception) {
                }
            }
        })

        if (dc != null) {
            dataChannels[viewerId] = dc
        }
        peerConnections[viewerId] = pc
        applyBitrateKbps(currentBitrateKbps)

        val offerConstraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
        }

        pc.createOffer(object : SdpObserver {
            override fun onCreateSuccess(desc: SessionDescription?) {
                if (desc == null) return
                pc.setLocalDescription(object : SdpObserver {
                    override fun onCreateSuccess(p0: SessionDescription?) {}
                    override fun onSetSuccess() {
                        signalingClient.sendOffer(desc.description, viewerId)
                    }
                    override fun onCreateFailure(p0: String?) {}
                    override fun onSetFailure(p0: String?) {}
                }, desc)
            }
            override fun onSetSuccess() {}
            override fun onCreateFailure(error: String?) {}
            override fun onSetFailure(error: String?) {}
        }, offerConstraints)
    }

    fun handleViewerLeft(viewerId: String) {
        remoteDescriptionReady.remove(viewerId)
        pendingIceCandidates.remove(viewerId)
        try { dataChannels.remove(viewerId)?.close() } catch (_: Exception) {}
        try { peerConnections.remove(viewerId)?.close() } catch (_: Exception) {}
    }

    fun handleRemoteAnswer(sdp: String, viewerId: String) {
        val pc = peerConnections[viewerId] ?: return
        val answerDesc = SessionDescription(SessionDescription.Type.ANSWER, sdp)
        pc.setRemoteDescription(object : SdpObserver {
            override fun onCreateSuccess(p0: SessionDescription?) {}
            override fun onSetSuccess() {
                remoteDescriptionReady[viewerId] = true
                val queued = pendingIceCandidates.remove(viewerId)
                if (queued != null) {
                    synchronized(queued) {
                        for (cand in queued) {
                            pc.addIceCandidate(cand)
                        }
                    }
                }
            }
            override fun onCreateFailure(p0: String?) {}
            override fun onSetFailure(p0: String?) {}
        }, answerDesc)
    }

    fun handleRemoteIceCandidate(candJson: JSONObject, viewerId: String) {
        val pc = peerConnections[viewerId] ?: return
        val candidateSdp = candJson.optString("candidate")
        if (candidateSdp.isEmpty()) return
        val sdpMid = candJson.optString("sdpMid", "0")
        val sdpMLineIndex = candJson.optInt("sdpMLineIndex", 0)
        val ice = IceCandidate(sdpMid, sdpMLineIndex, candidateSdp)

        if (remoteDescriptionReady[viewerId] == true) {
            pc.addIceCandidate(ice)
        } else {
            val queue = pendingIceCandidates.getOrPut(viewerId) {
                Collections.synchronizedList(mutableListOf())
            }
            queue.add(ice)
        }
    }

    fun sendDataChannelTelemetry(jsonPayload: JSONObject) {
        val bytes = jsonPayload.toString().toByteArray(StandardCharsets.UTF_8)
        for (dc in dataChannels.values) {
            if (dc.state() == DataChannel.State.OPEN) {
                dc.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), false))
            }
        }
    }

    fun release() {
        remoteDescriptionReady.clear()
        pendingIceCandidates.clear()

        for (dc in dataChannels.values) {
            try { dc.close() } catch (_: Exception) {}
        }
        dataChannels.clear()

        for (pc in peerConnections.values) {
            try { pc.close() } catch (_: Exception) {}
        }
        peerConnections.clear()

        try { surfaceTextureHelper?.stopListening() } catch (_: Exception) {}
        try { virtualDisplay?.release() } catch (_: Exception) {}
        virtualDisplay = null
        try { captureSurface?.release() } catch (_: Exception) {}
        captureSurface = null

        try { localVideoTrack?.dispose() } catch (_: Exception) {}
        try { videoSource?.dispose() } catch (_: Exception) {}
        try { localAudioTrack?.dispose() } catch (_: Exception) {}
        try { audioSource?.dispose() } catch (_: Exception) {}
        try { surfaceTextureHelper?.dispose() } catch (_: Exception) {}
        try { peerConnectionFactory?.dispose() } catch (_: Exception) {}
        try { eglBase.release() } catch (_: Exception) {}
    }
}
