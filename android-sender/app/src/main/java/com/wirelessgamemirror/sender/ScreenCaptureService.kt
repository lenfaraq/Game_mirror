package com.wirelessgamemirror.sender

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

/**
 * Foreground Service managing:
 * 1. `MediaProjection` + `VirtualDisplay` + `HardwareH264Encoder` (Zero B-frames low-latency H.264)
 * 2. `AudioPlaybackCapture` (Android 10+ 48kHz Stereo Game Audio) with automatic Video-Only Fallback & Warning
 *    when a game blocks internal audio capture (`android:allowAudioPlaybackCapture="false"`)
 * 3. Dynamic Orientation Rotation (`1080x1920` Portrait <-> `1920x1080` Landscape) via `onConfigurationChanged`
 * 4. Multi-Viewer WebRTC streaming + real-time Bitrate/FPS/Resolution control from PC Dashboard
 */
class ScreenCaptureService : Service(), SignalingListener {

    companion object {
        const val CHANNEL_ID = "wgm_capture_channel"
        const val NOTIFICATION_ID = 1001

        const val ACTION_START_CAPTURE = "com.wirelessgamemirror.sender.ACTION_START_CAPTURE"
        const val ACTION_STOP_CAPTURE = "com.wirelessgamemirror.sender.ACTION_STOP_CAPTURE"
        const val ACTION_STATE_UPDATE = "com.wirelessgamemirror.sender.ACTION_STATE_UPDATE"
        const val ACTION_AUDIO_CAPTURE_BLOCKED = "com.wirelessgamemirror.sender.ACTION_AUDIO_CAPTURE_BLOCKED"

        const val EXTRA_RESULT_CODE = "extra_result_code"
        const val EXTRA_RESULT_DATA = "extra_result_data"
        const val EXTRA_PC_HOST = "extra_pc_host"
        const val EXTRA_PC_PORT = "extra_pc_port"
        const val EXTRA_PC_NAME = "extra_pc_name"
        const val EXTRA_SESSION_TOKEN = "extra_session_token"
        const val EXTRA_STATUS_TEXT = "extra_status_text"
        const val EXTRA_WARNING_TEXT = "extra_warning_text"
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var signalingClient: SignalingClient? = null
    private var webRTCManager: WebRTCManager? = null
    private var h264Encoder: HardwareH264Encoder? = null
    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null

    private var audioRecord: AudioRecord? = null
    private var audioCaptureThread: Thread? = null
    private val isAudioCapturing = AtomicBoolean(false)
    private var hasNotifiedAudioBlocked = false

    private var permissionResultData: Intent? = null
    private var permissionResultCode: Int = Activity.RESULT_CANCELED

    private var currentOrientation: String = "landscape"
    private var targetResolution: String = "1080p"
    private var currentWidth: Int = 1920
    private var currentHeight: Int = 1080
    private var currentBitrateKbps: Int = 8000
    private var currentFps: Int = 60

    private var telemetryRunnable: Runnable? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START_CAPTURE -> {
                startForegroundWithNotification("กำลังเชื่อมต่อกับเครื่อง PC Receiver...")
                permissionResultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
                permissionResultData = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(EXTRA_RESULT_DATA)
                }

                val host = intent.getStringExtra(EXTRA_PC_HOST) ?: return START_NOT_STICKY
                val port = intent.getIntExtra(EXTRA_PC_PORT, 8080)
                val name = intent.getStringExtra(EXTRA_PC_NAME) ?: "PC Receiver"
                val token = intent.getStringExtra(EXTRA_SESSION_TOKEN)

                updateDimensionsFromConfiguration(resources.configuration)

                val receiver = DiscoveredPCReceiver(
                    id = "$host:$port",
                    name = name,
                    host = host,
                    port = port,
                    sessionToken = token
                )

                val sig = SignalingClient(this)
                signalingClient = sig
                webRTCManager = WebRTCManager(this, sig) { bitrate, fps, res, forceKeyframe ->
                    applyEncoderControls(bitrate, fps, res, forceKeyframe)
                }

                sig.connect(
                    receiver = receiver,
                    initialOrientation = currentOrientation,
                    width = currentWidth,
                    height = currentHeight
                )
            }

            ACTION_STOP_CAPTURE -> {
                stopCaptureAndSelf()
            }
        }
        return START_NOT_STICKY
    }

    /**
     * Dynamically handles Portrait (`1080x1920`) <-> Landscape (`1920x1080`) rotation while gaming.
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        val prevOrientation = currentOrientation
        updateDimensionsFromConfiguration(newConfig)

        if (prevOrientation != currentOrientation) {
            val rotationDegrees = if (currentOrientation == "portrait") 0 else 90
            signalingClient?.sendOrientationChange(
                orientation = currentOrientation,
                width = currentWidth,
                height = currentHeight,
                rotationDegrees = rotationDegrees
            )

            // Resize HardwareH264Encoder, VirtualDisplay, and WebRTC VideoSource without dropping session
            h264Encoder?.reconfigure(currentWidth, currentHeight, currentFps)
            webRTCManager?.changeCaptureFormat(
                currentWidth,
                currentHeight,
                currentFps,
                resources.displayMetrics.densityDpi
            )
            broadcastStateToActivity("กำลังสตรีม (${currentOrientation.uppercase()} ${currentWidth}x${currentHeight})")
        }
    }

    private fun updateDimensionsFromConfiguration(config: Configuration) {
        val isPortrait = config.orientation == Configuration.ORIENTATION_PORTRAIT
        currentOrientation = if (isPortrait) "portrait" else "landscape"
        val longSide = if (targetResolution == "720p") 1280 else 1920
        val shortSide = if (targetResolution == "720p") 720 else 1080

        if (isPortrait) {
            currentWidth = shortSide
            currentHeight = longSide
        } else {
            currentWidth = longSide
            currentHeight = shortSide
        }
    }

    private fun startMediaProjectionAndAudioCapture() {
        val resultData = permissionResultData ?: return
        val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val projection = projectionManager.getMediaProjection(permissionResultCode, resultData) ?: return

        val projectionCallback = object : MediaProjection.Callback() {
            override fun onStop() {
                mainHandler.post { stopCaptureAndSelf() }
            }
        }
        projection.registerCallback(projectionCallback, mainHandler)
        this.mediaProjection = projection

        // 1. Initialize Low-Latency Hardware H.264 MediaCodec (Zero B-frames)
        val encoder = HardwareH264Encoder(
            width = currentWidth,
            height = currentHeight,
            bitrateKbps = currentBitrateKbps,
            fps = currentFps
        ) { _, _, _ ->
            // Hardware H.264 NAL units encoded with Zero B-frames
        }
        encoder.start()
        this.h264Encoder = encoder

        // 2. Start WebRTC Video & Audio tracks sharing the single MediaProjection instance
        webRTCManager?.startLocalMediaCapture(
            mediaProjection = projection,
            width = currentWidth,
            height = currentHeight,
            fps = currentFps,
            densityDpi = resources.displayMetrics.densityDpi
        )

        // 3. Start Internal Game Audio Capture (`AudioPlaybackCapture` API 29+) with Block Fallback
        startInternalGameAudioCapture(projection)

        // 4. Start Telemetry Loop (Battery, Thermal, FPS, Bitrate)
        startTelemetryLoop()
    }

    /**
     * Captures internal game audio via `AudioPlaybackCaptureConfiguration` (Android 10+).
     * If a game blocks audio capture (`android:allowAudioPlaybackCapture="false"`), falls back
     * gracefully to Video-Only mode and notifies both the Android UI and PC Receiver Dashboard.
     */
    private fun startInternalGameAudioCapture(projection: MediaProjection) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            notifyAudioCaptureBlocked("Android เวอร์ชันต่ำกว่า 10 ไม่รองรับ AudioPlaybackCapture (ส่งเฉพาะภาพ)")
            return
        }

        try {
            val playbackConfig = AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build()

            val audioFormat = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(48000)
                .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                .build()

            val minBufSize = AudioRecord.getMinBufferSize(
                48000,
                AudioFormat.CHANNEL_IN_STEREO,
                AudioFormat.ENCODING_PCM_16BIT
            ).coerceAtLeast(4096)

            val record = AudioRecord.Builder()
                .setAudioFormat(audioFormat)
                .setBufferSizeInBytes(minBufSize * 2)
                .setAudioPlaybackCaptureConfig(playbackConfig)
                .build()

            if (record.state != AudioRecord.STATE_INITIALIZED) {
                record.release()
                notifyAudioCaptureBlocked("เกมไม่อนุญาตให้จับเสียงภายใน (AudioRecord init blocked) ระบบกำลังส่งเฉพาะภาพ")
                return
            }

            record.startRecording()
            this.audioRecord = record
            isAudioCapturing.set(true)
            signalingClient?.sendAudioCaptureStatus(captured = true)

            audioCaptureThread = Thread({
                monitorAndReadGameAudioLoop(record)
            }, "WGM-GameAudioCaptureThread").apply {
                priority = Thread.MAX_PRIORITY
                start()
            }
        } catch (e: SecurityException) {
            notifyAudioCaptureBlocked("ไม่มีสิทธิ์ RECORD_AUDIO สำหรับจับเสียงเกม ระบบกำลังส่งเฉพาะภาพ")
        } catch (e: UnsupportedOperationException) {
            notifyAudioCaptureBlocked("เกมนี้บล็อกการอัดเสียงภายใน (allowAudioPlaybackCapture=false) ระบบกำลังส่งเฉพาะภาพ")
        } catch (e: IllegalStateException) {
            notifyAudioCaptureBlocked("ระบบเสียงของเกมปฏิเสธการจับเสียงภายใน ระบบกำลังส่งเฉพาะภาพ")
        }
    }

    private fun monitorAndReadGameAudioLoop(record: AudioRecord) {
        val pcmBuffer = ShortArray(2048)
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        var consecutiveSilentReadsWhileMusicActive = 0

        while (isAudioCapturing.get()) {
            val readCount = try {
                record.read(pcmBuffer, 0, pcmBuffer.size)
            } catch (_: Exception) {
                -1
            }

            if (readCount < 0) {
                mainHandler.post {
                    notifyAudioCaptureBlocked("การอ่านเสียงภายในเกมถูกตัดการทำงาน ระบบกำลังสตรีมเฉพาะภาพ")
                }
                break
            }

            if (readCount > 0 && !hasNotifiedAudioBlocked) {
                var peakAmplitude = 0
                for (i in 0 until readCount) {
                    val sample = abs(pcmBuffer[i].toInt())
                    if (sample > peakAmplitude) peakAmplitude = sample
                }

                // If system reports active game/media audio playback but AudioPlaybackCapture receives 100% zeros
                // for ~4 seconds (~100 buffers), the foreground game has allowAudioPlaybackCapture="false"
                if (peakAmplitude == 0 && audioManager.isMusicActive) {
                    consecutiveSilentReadsWhileMusicActive++
                    if (consecutiveSilentReadsWhileMusicActive == 100) {
                        mainHandler.post {
                            notifyAudioCaptureBlocked(
                                "เกมกำลังเล่นเสียงแต่บล็อก AudioPlaybackCapture (allowAudioPlaybackCapture=false) — กำลังส่งเฉพาะภาพ"
                            )
                        }
                    }
                } else if (peakAmplitude > 0) {
                    consecutiveSilentReadsWhileMusicActive = 0
                    if (hasNotifiedAudioBlocked) {
                        hasNotifiedAudioBlocked = false
                        mainHandler.post {
                            signalingClient?.sendAudioCaptureStatus(captured = true)
                        }
                    }
                }
            }
        }
    }

    private fun notifyAudioCaptureBlocked(warningMessage: String) {
        hasNotifiedAudioBlocked = true
        signalingClient?.sendAudioCaptureStatus(
            captured = false,
            warningMessage = warningMessage
        )
        startForegroundWithNotification("⚠️ ส่งเฉพาะภาพ: $warningMessage")

        val intent = Intent(ACTION_AUDIO_CAPTURE_BLOCKED).apply {
            setPackage(packageName)
            putExtra(EXTRA_WARNING_TEXT, warningMessage)
        }
        sendBroadcast(intent)
    }

    private fun applyEncoderControls(
        bitrateKbps: Int?,
        fps: Int?,
        resolution: String?,
        forceKeyframe: Boolean
    ) {
        if (bitrateKbps != null) {
            currentBitrateKbps = bitrateKbps.coerceIn(1000, 25000)
            h264Encoder?.updateBitrateKbps(currentBitrateKbps)
            webRTCManager?.applyBitrateKbps(currentBitrateKbps)
        }

        var needsResize = false
        if (fps != null && fps != currentFps) {
            currentFps = fps
            needsResize = true
        }
        if (resolution != null && (resolution == "720p" || resolution == "1080p") && resolution != targetResolution) {
            targetResolution = resolution
            updateDimensionsFromConfiguration(resources.configuration)
            needsResize = true
        }

        if (needsResize) {
            h264Encoder?.reconfigure(currentWidth, currentHeight, currentFps)
            webRTCManager?.changeCaptureFormat(
                currentWidth,
                currentHeight,
                currentFps,
                resources.displayMetrics.densityDpi
            )
        }

        if (forceKeyframe) {
            h264Encoder?.requestKeyframe()
        }
    }

    private fun startTelemetryLoop() {
        val runnable = object : Runnable {
            override fun run() {
                val batteryIntent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
                val level = batteryIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, 100) ?: 100
                val scale = batteryIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
                val batteryPct = if (scale > 0) (level * 100) / scale else 100
                val tempTenths = batteryIntent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 350) ?: 350
                val tempCelsius = tempTenths / 10.0

                val runtime = Runtime.getRuntime()
                val usedMemMb = (runtime.totalMemory() - runtime.freeMemory()) / (1024.0 * 1024.0)

                signalingClient?.sendTelemetry(
                    fps = currentFps,
                    bitrateKbps = currentBitrateKbps,
                    batteryPct = batteryPct,
                    tempCelsius = tempCelsius,
                    memoryMb = usedMemMb
                )

                val dcPayload = JSONObject().apply {
                    put("type", "telemetry")
                    put("fps", currentFps)
                    put("bitrateKbps", currentBitrateKbps)
                    put("batteryPct", batteryPct)
                    put("tempCelsius", tempCelsius)
                    put("memoryMb", usedMemMb)
                }
                webRTCManager?.sendDataChannelTelemetry(dcPayload)

                mainHandler.postDelayed(this, 2000)
            }
        }
        telemetryRunnable = runnable
        mainHandler.postDelayed(runnable, 1000)
    }

    // SignalingListener Implementation
    override fun onSessionApproved(sessionToken: String, targetConfig: JSONObject) {
        if (targetConfig.has("bitrateKbps")) {
            currentBitrateKbps = targetConfig.optInt("bitrateKbps", 8000)
        }
        if (targetConfig.has("fps")) {
            currentFps = targetConfig.optInt("fps", 60)
        }
        startForegroundWithNotification("กำลังสตรีมหน้าจอเกมเข้า PC & OBS (${currentWidth}x${currentHeight} @ ${currentFps}fps)")
        broadcastStateToActivity("เชื่อมต่อสำเร็จ กำลังสตรีมสด (${currentBitrateKbps / 1000} Mbps @ ${currentFps}fps)")
        startMediaProjectionAndAudioCapture()
    }

    override fun onAwaitingPcApproval(message: String) {
        startForegroundWithNotification(message)
        broadcastStateToActivity(message)
    }

    override fun onSessionRejected(reason: String) {
        broadcastStateToActivity("ถูกปฏิเสธ/ตัดการเชื่อมต่อ: $reason")
        stopCaptureAndSelf()
    }

    override fun onViewerJoined(viewerId: String, role: String) {
        webRTCManager?.createOfferForViewer(viewerId)
    }

    override fun onViewerLeft(viewerId: String) {
        webRTCManager?.handleViewerLeft(viewerId)
    }

    override fun onRemoteAnswerReceived(sdp: String, viewerId: String) {
        webRTCManager?.handleRemoteAnswer(sdp, viewerId)
    }

    override fun onRemoteIceCandidateReceived(candidate: JSONObject, viewerId: String) {
        webRTCManager?.handleRemoteIceCandidate(candidate, viewerId)
    }

    override fun onEncoderControlReceived(
        bitrateKbps: Int?,
        fps: Int?,
        resolution: String?,
        forceKeyframe: Boolean
    ) {
        applyEncoderControls(bitrateKbps, fps, resolution, forceKeyframe)
    }

    private fun broadcastStateToActivity(statusText: String) {
        val intent = Intent(ACTION_STATE_UPDATE).apply {
            setPackage(packageName)
            putExtra(EXTRA_STATUS_TEXT, statusText)
        }
        sendBroadcast(intent)
    }

    private fun stopCaptureAndSelf() {
        telemetryRunnable?.let { mainHandler.removeCallbacks(it) }
        telemetryRunnable = null

        isAudioCapturing.set(false)
        try { audioCaptureThread?.join(250) } catch (_: Exception) {}
        audioCaptureThread = null
        try { audioRecord?.stop() } catch (_: Exception) {}
        try { audioRecord?.release() } catch (_: Exception) {}
        audioRecord = null

        try { virtualDisplay?.release() } catch (_: Exception) {}
        virtualDisplay = null

        h264Encoder?.stop()
        h264Encoder = null

        webRTCManager?.release()
        webRTCManager = null

        signalingClient?.disconnect()
        signalingClient = null

        try { mediaProjection?.stop() } catch (_: Exception) {}
        mediaProjection = null

        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Wireless Game Mirror Streaming",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun startForegroundWithNotification(contentText: String) {
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Wireless Game Mirror (60FPS Low-Latency)")
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopCaptureAndSelf()
        super.onDestroy()
    }
}
