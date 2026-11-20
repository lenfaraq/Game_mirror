package com.wirelessgamemirror.sender

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.view.Surface
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Low-Latency Hardware H.264 Encoder powered by Android `MediaCodec` (`video/avc`).
 * - Enforces Zero B-Frames (`KEY_MAX_B_FRAMES = 0`) and Baseline Profile
 * - Enables Hardware Low-Latency mode (`KEY_LOW_LATENCY = 1`, `KEY_PRIORITY = 0`)
 * - Supports live Bitrate tuning (`PARAMETER_KEY_VIDEO_BITRATE`) without encoder restart
 * - Supports Dynamic Portrait (`1080x1920`) <-> Landscape (`1920x1080`) reconfiguration
 */
class HardwareH264Encoder(
    width: Int = 1920,
    height: Int = 1080,
    bitrateKbps: Int = 8000,
    fps: Int = 60,
    private val onEncodedNal: (data: ByteArray, isKeyFrame: Boolean, presentationTimeUs: Long) -> Unit
) {
    var currentWidth: Int = width
        private set
    var currentHeight: Int = height
        private set
    var currentBitrateKbps: Int = bitrateKbps
        private set
    var currentFps: Int = fps
        private set

    var inputSurface: Surface? = null
        private set

    private var mediaCodec: MediaCodec? = null
    private val isRunning = AtomicBoolean(false)
    private var drainThread: Thread? = null

    fun start(): Surface {
        stop()

        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, currentWidth, currentHeight).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, currentBitrateKbps * 1000)
            setInteger(MediaFormat.KEY_FRAME_RATE, currentFps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1) // Keyframe every 1s for fast recovery
            setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
            setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel42)
            setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0) // Zero B-frames for minimum latency
            setInteger(MediaFormat.KEY_PRIORITY, 0) // Real-time priority
            setInteger(MediaFormat.KEY_LATENCY, 0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
            }
        }

        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val surface = codec.createInputSurface()
        codec.start()

        this.mediaCodec = codec
        this.inputSurface = surface
        isRunning.set(true)

        drainThread = Thread({ drainEncoderLoop(codec) }, "WGM-H264DrainThread").apply {
            priority = Thread.MAX_PRIORITY
            start()
        }

        return surface
    }

    /**
     * Dynamically adjusts H.264 encoder bitrate in real-time (4–15 Mbps) via `PARAMETER_KEY_VIDEO_BITRATE`.
     */
    fun updateBitrateKbps(bitrateKbps: Int) {
        val clamped = bitrateKbps.coerceIn(1000, 25000)
        currentBitrateKbps = clamped
        val codec = mediaCodec ?: return
        try {
            val params = Bundle().apply {
                putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, clamped * 1000)
            }
            codec.setParameters(params)
        } catch (_: Exception) {
        }
    }

    /**
     * Forces an immediate IDR Keyframe (`PARAMETER_KEY_REQUEST_SYNC_FRAME`).
     */
    fun requestKeyframe() {
        val codec = mediaCodec ?: return
        try {
            val params = Bundle().apply {
                putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
            }
            codec.setParameters(params)
        } catch (_: Exception) {
        }
    }

    /**
     * Reconfigures encoder dimensions when the gamer rotates phone between Portrait (`1080x1920`)
     * and Landscape (`1920x1080`) or changes target resolution (`720p` / `1080p`).
     */
    fun reconfigure(width: Int, height: Int, fps: Int = currentFps): Surface {
        currentWidth = width
        currentHeight = height
        currentFps = fps
        return start()
    }

    fun stop() {
        isRunning.set(false)
        try {
            drainThread?.join(300)
        } catch (_: InterruptedException) {
        }
        drainThread = null

        try {
            mediaCodec?.stop()
        } catch (_: Exception) {
        }
        try {
            mediaCodec?.release()
        } catch (_: Exception) {
        }
        mediaCodec = null

        try {
            inputSurface?.release()
        } catch (_: Exception) {
        }
        inputSurface = null
    }

    private fun drainEncoderLoop(codec: MediaCodec) {
        val bufferInfo = MediaCodec.BufferInfo()
        var configBytes: ByteArray? = null

        while (isRunning.get()) {
            val outputIndex = try {
                codec.dequeueOutputBuffer(bufferInfo, 10_000)
            } catch (_: Exception) {
                break
            }

            if (outputIndex >= 0) {
                val encodedBuffer: ByteBuffer? = codec.getOutputBuffer(outputIndex)
                if (encodedBuffer != null && bufferInfo.size > 0) {
                    encodedBuffer.position(bufferInfo.offset)
                    encodedBuffer.limit(bufferInfo.offset + bufferInfo.size)

                    val rawBytes = ByteArray(bufferInfo.size)
                    encodedBuffer.get(rawBytes)

                    val isConfig = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                    val isKeyFrame = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0

                    if (isConfig) {
                        configBytes = rawBytes
                    } else {
                        val payload = if (isKeyFrame && configBytes != null) {
                            ByteArray(configBytes.size + rawBytes.size).also { combined ->
                                System.arraycopy(configBytes, 0, combined, 0, configBytes.size)
                                System.arraycopy(rawBytes, 0, combined, configBytes.size, rawBytes.size)
                            }
                        } else {
                            rawBytes
                        }
                        onEncodedNal(payload, isKeyFrame, bufferInfo.presentationTimeUs)
                    }
                }
                try {
                    codec.releaseOutputBuffer(outputIndex, false)
                } catch (_: Exception) {
                    break
                }
            }
        }
    }
}
