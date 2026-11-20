import Foundation
import VideoToolbox
import CoreMedia
import CoreVideo

public protocol HardwareH264EncoderDelegate: AnyObject {
    func h264Encoder(
        _ encoder: HardwareH264Encoder,
        didOutputAnnexBData data: Data,
        isKeyFrame: Bool,
        presentationTimeMicros: UInt64
    )
}

/// Low-Latency Hardware H.264 Encoder powered by Apple `VideoToolbox` (`VTCompressionSession`).
/// - Enforces Zero B-Frames (`kVTCompressionPropertyKey_AllowFrameReordering = false`)
/// - Real-time hardware compression (`kVTCompressionPropertyKey_RealTime = true`)
/// - Dynamic Bitrate adjustment (4–15 Mbps) without interrupting stream
/// - Dynamic Portrait (`1080x1920`) <-> Landscape (`1920x1080`) reconfiguration
public final class HardwareH264Encoder {
    public weak var delegate: HardwareH264EncoderDelegate?

    private var compressionSession: VTCompressionSession?
    private let encoderQueue = DispatchQueue(label: "com.wirelessgamemirror.videotoolbox.encoder", qos: .userInteractive)

    public private(set) var currentWidth: Int32 = 1920
    public private(set) var currentHeight: Int32 = 1080
    public private(set) var currentBitrateKbps: Int = 8000
    public private(set) var currentFps: Int = 60
    private var forceNextKeyframe: Bool = false

    public init(width: Int32 = 1920, height: Int32 = 1080, bitrateKbps: Int = 8000, fps: Int = 60) {
        self.currentWidth = width
        self.currentHeight = height
        self.currentBitrateKbps = bitrateKbps
        self.currentFps = fps
    }

    deinit {
        invalidateSession()
    }

    public func configureSession(width: Int32, height: Int32, bitrateKbps: Int, fps: Int) {
        encoderQueue.sync {
            createOrResetSessionLocked(width: width, height: height, bitrateKbps: bitrateKbps, fps: fps)
        }
    }

    public func updateBitrate(kbps: Int) {
        let clampedKbps = max(1000, min(25000, kbps))
        encoderQueue.async { [weak self] in
            guard let self = self, let session = self.compressionSession else { return }
            self.currentBitrateKbps = clampedKbps
            let bitRateBps = clampedKbps * 1000
            let byteLimitPerSec = bitRateBps / 8

            VTSessionSetProperty(
                session,
                key: kVTCompressionPropertyKey_AverageBitRate,
                value: NSNumber(value: bitRateBps)
            )
            let dataRateLimits: [NSNumber] = [NSNumber(value: byteLimitPerSec * 3 / 2), NSNumber(value: 1)]
            VTSessionSetProperty(
                session,
                key: kVTCompressionPropertyKey_DataRateLimits,
                value: dataRateLimits as CFArray
            )
        }
    }

    public func updateFps(_ fps: Int) {
        let clampedFps = max(24, min(120, fps))
        encoderQueue.async { [weak self] in
            guard let self = self, let session = self.compressionSession else { return }
            self.currentFps = clampedFps
            VTSessionSetProperty(
                session,
                key: kVTCompressionPropertyKey_ExpectedFrameRate,
                value: NSNumber(value: clampedFps)
            )
            VTSessionSetProperty(
                session,
                key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
                value: NSNumber(value: clampedFps)
            )
        }
    }

    public func requestKeyframe() {
        encoderQueue.async { [weak self] in
            self?.forceNextKeyframe = true
        }
    }

    public func encode(pixelBuffer: CVPixelBuffer, timestampMicros: UInt64) {
        encoderQueue.async { [weak self] in
            guard let self = self else { return }
            let bufW = Int32(CVPixelBufferGetWidth(pixelBuffer))
            let bufH = Int32(CVPixelBufferGetHeight(pixelBuffer))

            // Dynamic Orientation: Automatically recreate VTCompressionSession if Portrait <-> Landscape dimensions swap
            if self.compressionSession == nil || bufW != self.currentWidth || bufH != self.currentHeight {
                self.createOrResetSessionLocked(
                    width: bufW,
                    height: bufH,
                    bitrateKbps: self.currentBitrateKbps,
                    fps: self.currentFps
                )
            }

            guard let session = self.compressionSession else { return }

            let pts = CMTime(value: CMTimeValue(timestampMicros), timescale: 1_000_000)
            let duration = CMTime(value: 1, timescale: CMTimeScale(self.currentFps))

            var frameProperties: CFDictionary?
            if self.forceNextKeyframe {
                self.forceNextKeyframe = false
                let opts: [CFString: Any] = [
                    kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue as Any
                ]
                frameProperties = opts as CFDictionary
            }

            VTCompressionSessionEncodeFrame(
                session,
                imageBuffer: pixelBuffer,
                presentationTimeStamp: pts,
                duration: duration,
                frameProperties: frameProperties,
                sourceFrameRefcon: nil,
                infoFlagsOut: nil
            )
        }
    }

    private func createOrResetSessionLocked(width: Int32, height: Int32, bitrateKbps: Int, fps: Int) {
        invalidateSession()

        self.currentWidth = width
        self.currentHeight = height
        self.currentBitrateKbps = bitrateKbps
        self.currentFps = fps

        let callback: VTCompressionOutputCallback = { outputCallbackRefCon, _, status, _, sampleBuffer in
            guard status == noErr,
                  let sampleBuffer = sampleBuffer,
                  CMSampleBufferDataIsReady(sampleBuffer),
                  let refCon = outputCallbackRefCon else {
                return
            }
            let encoder = Unmanaged<HardwareH264Encoder>.fromOpaque(refCon).takeUnretainedValue()
            encoder.handleCompressedSampleBuffer(sampleBuffer)
        }

        var session: VTCompressionSession?
        let refCon = Unmanaged.passUnretained(self).toOpaque()
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: callback,
            refcon: refCon,
            compressionSessionOut: &session
        )

        guard status == noErr, let activeSession = session else { return }

        // Ultra-Low-Latency Streamer Properties
        VTSessionSetProperty(activeSession, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(activeSession, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse) // Zero B-Frames!
        VTSessionSetProperty(activeSession, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(activeSession, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: bitrateKbps * 1000))
        VTSessionSetProperty(activeSession, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: fps))
        VTSessionSetProperty(activeSession, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: fps))
        VTSessionSetProperty(activeSession, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: NSNumber(value: 1.0))

        VTCompressionSessionPrepareToEncodeFrames(activeSession)
        self.compressionSession = activeSession
        self.forceNextKeyframe = true
    }

    private func handleCompressedSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        let isKeyFrame = Self.isSampleBufferKeyFrame(sampleBuffer)
        var annexB = Data()
        let startCode = Data([0x00, 0x00, 0x00, 0x01])

        // Prepend SPS & PPS on every IDR keyframe
        if isKeyFrame, let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) {
            var spsSize: Int = 0
            var spsCount: Int = 0
            var spsPtr: UnsafePointer<UInt8>?
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                formatDesc,
                parameterSetIndex: 0,
                parameterSetPointerOut: &spsPtr,
                parameterSetSizeOut: &spsSize,
                parameterSetCountOut: &spsCount,
                nalUnitHeaderLengthOut: nil
            ) == noErr, let sps = spsPtr {
                annexB.append(startCode)
                annexB.append(sps, count: spsSize)
            }

            var ppsSize: Int = 0
            var ppsPtr: UnsafePointer<UInt8>?
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                formatDesc,
                parameterSetIndex: 1,
                parameterSetPointerOut: &ppsPtr,
                parameterSetSizeOut: &ppsSize,
                parameterSetCountOut: nil,
                nalUnitHeaderLengthOut: nil
            ) == noErr, let pps = ppsPtr {
                annexB.append(startCode)
                annexB.append(pps, count: ppsSize)
            }
        }

        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var totalLength: Int = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            dataBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer
        ) == noErr, let rawPtr = dataPointer else {
            return
        }

        // Convert AVCC 4-byte length-prefixed NALUs to Annex-B start codes
        var offset = 0
        while offset + 4 <= totalLength {
            var naluLength: UInt32 = 0
            memcpy(&naluLength, rawPtr.advanced(by: offset), 4)
            naluLength = CFSwapInt32BigToHost(naluLength)
            offset += 4

            guard offset + Int(naluLength) <= totalLength else { break }
            annexB.append(startCode)
            annexB.append(UnsafeRawPointer(rawPtr.advanced(by: offset)).assumingMemoryBound(to: UInt8.self), count: Int(naluLength))
            offset += Int(naluLength)
        }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let ptsMicros = UInt64(max(0, CMTimeGetSeconds(pts)) * 1_000_000)

        delegate?.h264Encoder(
            self,
            didOutputAnnexBData: annexB,
            isKeyFrame: isKeyFrame,
            presentationTimeMicros: ptsMicros
        )
    }

    private static func isSampleBufferKeyFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]],
              let first = attachments.first else {
            return true
        }
        let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
        return !notSync
    }

    private func invalidateSession() {
        if let session = compressionSession {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
            compressionSession = nil
        }
    }
}
