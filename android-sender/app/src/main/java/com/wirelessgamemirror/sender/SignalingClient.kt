package com.wirelessgamemirror.sender

import android.os.Build
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

interface SignalingListener {
    fun onSessionApproved(sessionToken: String, targetConfig: JSONObject)
    fun onAwaitingPcApproval(message: String)
    fun onSessionRejected(reason: String)
    fun onViewerJoined(viewerId: String, role: String)
    fun onViewerLeft(viewerId: String)
    fun onRemoteAnswerReceived(sdp: String, viewerId: String)
    fun onRemoteIceCandidateReceived(candidate: JSONObject, viewerId: String)
    fun onEncoderControlReceived(bitrateKbps: Int?, fps: Int?, resolution: String?, forceKeyframe: Boolean)
}

/**
 * WebSocket Signaling Client for Android Sender.
 * Supports QR Token Auto-Auth, mDNS Allow/Deny PC approval flow, dynamic Portrait/Landscape rotation events,
 * and Android AudioPlaybackCapture blocked warning propagation.
 */
class SignalingClient(
    private val listener: SignalingListener,
    private val deviceId: String = UUID.randomUUID().toString()
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val httpClient = OkHttpClient.Builder()
        .pingInterval(10, TimeUnit.SECONDS)
        .connectTimeout(5, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null

    fun connect(
        receiver: DiscoveredPCReceiver,
        initialOrientation: String = "landscape",
        width: Int = 1920,
        height: Int = 1080
    ) {
        disconnect()

        val request = Request.Builder()
            .url(receiver.wsUrl)
            .build()

        webSocket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val joinMsg = JSONObject().apply {
                    put("type", "join-sender")
                    put("deviceId", deviceId)
                    put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}")
                    put("platform", "android")
                    put("authMethod", receiver.authMethod)
                    put("orientation", initialOrientation)
                    put("width", width)
                    put("height", height)
                    if (!receiver.sessionToken.isNullOrBlank()) {
                        put("token", receiver.sessionToken)
                    }
                }
                webSocket.send(joinMsg.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val json = try {
                    JSONObject(text)
                } catch (_: Exception) {
                    return
                }
                mainHandler.post { handleMessage(json) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                mainHandler.post {
                    listener.onSessionRejected(t.message ?: "ไม่สามารถเชื่อมต่อ PC Receiver ได้")
                }
            }
        })
    }

    fun disconnect() {
        webSocket?.close(1000, "Android sender disconnected")
        webSocket = null
    }

    fun sendOffer(sdp: String, viewerId: String) {
        val msg = JSONObject().apply {
            put("type", "offer")
            put("viewerId", viewerId)
            put("sdp", sdp)
        }
        webSocket?.send(msg.toString())
    }

    fun sendIceCandidate(sdpMid: String?, sdpMLineIndex: Int, candidateSdp: String, viewerId: String) {
        val cand = JSONObject().apply {
            put("sdpMid", sdpMid ?: "0")
            put("sdpMLineIndex", sdpMLineIndex)
            put("candidate", candidateSdp)
        }
        val msg = JSONObject().apply {
            put("type", "ice-candidate")
            put("viewerId", viewerId)
            put("candidate", cand)
        }
        webSocket?.send(msg.toString())
    }

    fun sendOrientationChange(orientation: String, width: Int, height: Int, rotationDegrees: Int) {
        val msg = JSONObject().apply {
            put("type", "orientation")
            put("orientation", orientation)
            put("width", width)
            put("height", height)
            put("rotationDegrees", rotationDegrees)
        }
        webSocket?.send(msg.toString())
    }

    /**
     * Notifies PC Receiver & Dashboard when an Android game blocks internal audio capture
     * (`android:allowAudioPlaybackCapture="false"`), triggering the Video-Only warning banner.
     */
    fun sendAudioCaptureStatus(captured: Boolean, warningMessage: String? = null, blockedApp: String? = null) {
        val msg = JSONObject().apply {
            put("type", "audio-status")
            put("captured", captured)
            put("mode", if (captured) "game-audio" else "video-only-blocked")
            if (warningMessage != null) put("warning", warningMessage)
            if (blockedApp != null) put("blockedApp", blockedApp)
        }
        webSocket?.send(msg.toString())
    }

    fun sendTelemetry(fps: Int, bitrateKbps: Int, batteryPct: Int, tempCelsius: Double, memoryMb: Double) {
        val telemetry = JSONObject().apply {
            put("fps", fps)
            put("bitrateKbps", bitrateKbps)
            put("batteryPct", batteryPct)
            put("tempCelsius", tempCelsius)
            put("memoryMb", memoryMb)
            put("encoder", "MediaCodec H.264 Low-Latency (Zero B-Frames)")
        }
        val msg = JSONObject().apply {
            put("type", "telemetry")
            put("telemetry", telemetry)
        }
        webSocket?.send(msg.toString())
    }

    private fun handleMessage(json: JSONObject) {
        when (json.optString("type")) {
            "auth-result" -> {
                when (json.optString("status")) {
                    "approved" -> {
                        val token = json.optString("sessionToken", "")
                        val cfg = json.optJSONObject("targetConfig") ?: JSONObject()
                        listener.onSessionApproved(token, cfg)
                    }
                    "pending-approval" -> {
                        val msg = json.optString("message", "รอกด Allow บนหน้าจอ PC")
                        listener.onAwaitingPcApproval(msg)
                    }
                    else -> {
                        val reason = json.optString("message").ifEmpty {
                            json.optString("reason", "การเชื่อมต่อถูกปฏิเสธ")
                        }
                        listener.onSessionRejected(reason)
                    }
                }
            }

            "viewer-joined" -> {
                val viewerId = json.optString("viewerId")
                val role = json.optString("role", "viewer")
                if (viewerId.isNotEmpty()) {
                    listener.onViewerJoined(viewerId, role)
                }
            }

            "viewer-left" -> {
                val viewerId = json.optString("viewerId")
                if (viewerId.isNotEmpty()) {
                    listener.onViewerLeft(viewerId)
                }
            }

            "answer" -> {
                val sdp = json.optString("sdp")
                val viewerId = json.optString("viewerId", "default")
                if (sdp.isNotEmpty()) {
                    listener.onRemoteAnswerReceived(sdp, viewerId)
                }
            }

            "ice-candidate" -> {
                val cand = json.optJSONObject("candidate") ?: return
                val viewerId = json.optString("viewerId", "default")
                listener.onRemoteIceCandidateReceived(cand, viewerId)
            }

            "control" -> {
                val action = json.optString("action")
                val cfg = json.optJSONObject("config") ?: json
                val bitrate = if (cfg.has("bitrateKbps")) cfg.optInt("bitrateKbps") else null
                val fps = if (cfg.has("fps")) cfg.optInt("fps") else null
                val resolution = if (cfg.has("resolution")) cfg.optString("resolution") else null
                listener.onEncoderControlReceived(
                    bitrateKbps = bitrate,
                    fps = fps,
                    resolution = resolution,
                    forceKeyframe = action == "request-keyframe"
                )
            }

            "session-ended", "session-replaced" -> {
                val reason = json.optString("reason").ifEmpty {
                    json.optString("message", "เซสชันถูกตัดการเชื่อมต่อจากฝั่ง PC")
                }
                listener.onSessionRejected(reason)
            }
        }
    }
}
