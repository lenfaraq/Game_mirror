import ReplayKit
import CoreVideo
import CoreMedia
import ImageIO
import Darwin

/// ReplayKit Broadcast Upload Extension (`RPBroadcastSampleHandler`)
/// Split-Process Architecture:
/// - Does NOT run WebRTC or VideoToolbox inside the extension.
/// - Forwards raw NV12 video planes and game audio PCM buffers via zero-queue App Group Unix Domain Socket
///   to the Main App (`WirelessGameMirrorApp`), keeping extension RAM < 30MB (iOS limit is 50MB).
final class SampleHandler: RPBroadcastSampleHandler {

    private let socketClient = FrameSocketClient()
    private var lastOrientation: WGMPOrientation = .landscape
    private var lastWidth: UInt32 = 0
    private var lastHeight: UInt32 = 0

    override func broadcastStarted(withSetupInfo setupInfo: [String : NSObject]?) {
        _ = socketClient.connectIfNeeded()
    }

    override func broadcastPaused() {
        // No-op: keep socket open for instant resume
    }

    override func broadcastResumed() {
        _ = socketClient.connectIfNeeded()
    }

    override func broadcastFinished() {
        let stopHeader = WGMPFrameHeader(
            packetType: .streamStopped,
            orientation: lastOrientation
        )
        _ = socketClient.sendPacket(header: stopHeader, payload: nil, payloadLength: 0)
        socketClient.disconnect()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        // Explicit autoreleasepool on every callback to prevent CMSampleBuffer accumulation
        autoreleasepool {
            guard isMemoryBelowSafetyThreshold() else {
                // Drop frame immediately if approaching 35MB to avoid 50MB iOS Jetsam kill
                return
            }

            switch sampleBufferType {
            case .video:
                handleVideoSampleBuffer(sampleBuffer)
            case .audioApp:
                handleAppAudioSampleBuffer(sampleBuffer)
            case .audioMic:
                // MVP focuses on in-game audio (.audioApp)
                break
            @unknown default:
                break
            }
        }
    }

    private func handleVideoSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let rawWidth = UInt32(CVPixelBufferGetWidth(pixelBuffer))
        let rawHeight = UInt32(CVPixelBufferGetHeight(pixelBuffer))
        let rotationDegrees = extractRotationDegrees(from: sampleBuffer)

        let isRotated90or270 = (rotationDegrees == 90 || rotationDegrees == 270)
        let effectiveWidth = isRotated90or270 ? rawHeight : rawWidth
        let effectiveHeight = isRotated90or270 ? rawWidth : rawHeight
        let orientation: WGMPOrientation = effectiveHeight > effectiveWidth ? .portrait : .landscape

        // Notify Main App immediately when the gamer rotates phone between Portrait and Landscape
        if orientation != lastOrientation || effectiveWidth != lastWidth || effectiveHeight != lastHeight {
            lastOrientation = orientation
            lastWidth = effectiveWidth
            lastHeight = effectiveHeight

            let orientHeader = WGMPFrameHeader(
                packetType: .orientationChange,
                orientation: orientation,
                rotationDegrees: rotationDegrees,
                width: effectiveWidth,
                height: effectiveHeight,
                timestampMicros: currentTimestampMicros(from: sampleBuffer)
            )
            _ = socketClient.sendPacket(header: orientHeader, payload: nil, payloadLength: 0)
        }

        // Expect Bi-Planar NV12 (420YpCbCr8BiPlanarFullRange / VideoRange) from ReplayKit
        guard CVPixelBufferGetPlaneCount(pixelBuffer) >= 2,
              let yBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0),
              let uvBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1) else {
            return
        }

        let yBytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let yHeight = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let uvBytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1)
        let uvHeight = CVPixelBufferGetHeightOfPlane(pixelBuffer, 1)

        let yLength = yBytesPerRow * yHeight
        let uvLength = uvBytesPerRow * uvHeight

        let header = WGMPFrameHeader(
            packetType: .videoNV12,
            orientation: orientation,
            rotationDegrees: rotationDegrees,
            width: rawWidth,
            height: rawHeight,
            yPlaneBytes: UInt32(yLength),
            uvPlaneBytes: UInt32(uvLength),
            timestampMicros: currentTimestampMicros(from: sampleBuffer)
        )

        _ = socketClient.sendVideoPlanes(
            header: header,
            yBaseAddress: yBase,
            yLength: yLength,
            uvBaseAddress: uvBase,
            uvLength: uvLength
        )
    }

    private func handleAppAudioSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        var totalLength: Int = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer
        )

        guard status == kCMBlockBufferNoErr, let ptr = dataPointer, totalLength > 0 else {
            return
        }

        let header = WGMPFrameHeader(
            packetType: .audioPCM,
            orientation: lastOrientation,
            yPlaneBytes: UInt32(totalLength),
            uvPlaneBytes: 0,
            timestampMicros: currentTimestampMicros(from: sampleBuffer)
        )

        _ = socketClient.sendPacket(
            header: header,
            payload: UnsafeRawPointer(ptr),
            payloadLength: totalLength
        )
    }

    private func extractRotationDegrees(from sampleBuffer: CMSampleBuffer) -> UInt16 {
        guard let attachment = CMGetAttachment(
            sampleBuffer,
            key: RPVideoSampleOrientationKey as CFString,
            attachmentModeOut: nil
        ) as? NSNumber,
        let cgOrientation = CGImagePropertyOrientation(rawValue: attachment.uint32Value) else {
            return 0
        }

        switch cgOrientation {
        case .up, .upMirrored:
            return 0
        case .down, .downMirrored:
            return 180
        case .left, .leftMirrored:
            return 90
        case .right, .rightMirrored:
            return 270
        }
    }

    private func currentTimestampMicros(from sampleBuffer: CMSampleBuffer) -> UInt64 {
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let seconds = CMTimeGetSeconds(pts)
        guard seconds.isFinite && seconds >= 0 else { return 0 }
        return UInt64(seconds * 1_000_000)
    }

    /// Queries Mach `TASK_VM_INFO` physical footprint to verify we are safely under 35MB (limit is 50MB).
    private func isMemoryBelowSafetyThreshold() -> Bool {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kerr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        if kerr == KERN_SUCCESS {
            return info.phys_footprint < AppGroupConfig.maxExtensionMemoryBytes
        }
        return true
    }
}
