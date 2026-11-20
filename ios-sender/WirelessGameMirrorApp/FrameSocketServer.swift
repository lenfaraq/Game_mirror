import Foundation
import CoreVideo
import Darwin

public protocol FrameSocketServerDelegate: AnyObject {
    func socketServerDidReceiveVideoFrame(
        _ pixelBuffer: CVPixelBuffer,
        header: WGMPFrameHeader
    )
    func socketServerDidReceiveAudioPacket(
        _ pcmData: Data,
        timestampMicros: UInt64
    )
    func socketServerDidReceiveOrientationChange(
        orientation: WGMPOrientation,
        width: UInt32,
        height: UInt32,
        rotationDegrees: UInt16
    )
    func socketServerDidDetectBroadcastStop()
}

/// POSIX Unix Domain Socket Server running inside `WirelessGameMirrorApp` (Main App).
/// Listens on the shared App Group socket path (`AppGroupConfig.unixSocketPath`) for incoming
/// raw NV12 frames and game audio PCM packets sent by `BroadcastExtension`.
public final class FrameSocketServer {
    public weak var delegate: FrameSocketServerDelegate?

    private let socketPath: String
    private var listenFD: Int32 = -1
    private var isRunning = false
    private let acceptQueue = DispatchQueue(label: "com.wirelessgamemirror.socket.accept", qos: .userInteractive)
    private let clientQueue = DispatchQueue(label: "com.wirelessgamemirror.socket.client", qos: .userInteractive)

    private var pixelBufferPool: CVPixelBufferPool?
    private var poolWidth: Int = 0
    private var poolHeight: Int = 0

    public init(socketPath: String = AppGroupConfig.unixSocketPath) {
        self.socketPath = socketPath
    }

    deinit {
        stop()
    }

    public func start() -> Bool {
        guard !isRunning else { return true }

        unlink(socketPath)

        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        guard pathBytes.count < maxLen else {
            Darwin.close(fd)
            return false
        }

        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            let raw = UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: CChar.self)
            for i in 0..<pathBytes.count {
                raw[i] = pathBytes[i]
            }
        }

        let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bindRes = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, addrLen)
            }
        }

        guard bindRes == 0, Darwin.listen(fd, 2) == 0 else {
            Darwin.close(fd)
            return false
        }

        listenFD = fd
        isRunning = true

        acceptQueue.async { [weak self] in
            self?.acceptLoop()
        }

        return true
    }

    public func stop() {
        isRunning = false
        if listenFD >= 0 {
            Darwin.close(listenFD)
            listenFD = -1
        }
        unlink(socketPath)
    }

    private func acceptLoop() {
        while isRunning && listenFD >= 0 {
            var clientAddr = sockaddr_un()
            var clientLen = socklen_t(MemoryLayout<sockaddr_un>.size)
            let clientFD = withUnsafeMutablePointer(to: &clientAddr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.accept(listenFD, $0, &clientLen)
                }
            }

            if clientFD < 0 {
                if !isRunning { break }
                continue
            }

            var recvBufSize: Int32 = 1024 * 1024
            setsockopt(clientFD, SOL_SOCKET, SO_RCVBUF, &recvBufSize, socklen_t(MemoryLayout<Int32>.size))

            clientQueue.async { [weak self] in
                self?.readClientLoop(clientFD: clientFD)
            }
        }
    }

    private func readClientLoop(clientFD: Int32) {
        defer { Darwin.close(clientFD) }

        var headerBuf = Data(count: WGMPFrameHeader.headerSize)

        while isRunning {
            let headerRead = headerBuf.withUnsafeMutableBytes { raw -> Bool in
                guard let base = raw.baseAddress else { return false }
                return Self.readExact(fd: clientFD, buffer: base, length: WGMPFrameHeader.headerSize)
            }

            guard headerRead, let header = WGMPFrameHeader.deserialize(from: headerBuf) else {
                break
            }

            switch header.packetType {
            case .videoNV12:
                guard handleIncomingVideoFrame(clientFD: clientFD, header: header) else { return }

            case .audioPCM:
                let audioLen = Int(header.yPlaneBytes)
                guard audioLen > 0 && audioLen <= 512 * 1024 else { return }
                var audioData = Data(count: audioLen)
                let ok = audioData.withUnsafeMutableBytes { raw -> Bool in
                    guard let base = raw.baseAddress else { return false }
                    return Self.readExact(fd: clientFD, buffer: base, length: audioLen)
                }
                guard ok else { return }
                delegate?.socketServerDidReceiveAudioPacket(audioData, timestampMicros: header.timestampMicros)

            case .orientationChange:
                delegate?.socketServerDidReceiveOrientationChange(
                    orientation: header.orientation,
                    width: header.width,
                    height: header.height,
                    rotationDegrees: header.rotationDegrees
                )

            case .streamStopped:
                delegate?.socketServerDidDetectBroadcastStop()
                return
            }
        }
    }

    private func handleIncomingVideoFrame(clientFD: Int32, header: WGMPFrameHeader) -> Bool {
        let width = Int(header.width)
        let height = Int(header.height)
        let yBytes = Int(header.yPlaneBytes)
        let uvBytes = Int(header.uvPlaneBytes)

        guard width > 0, height > 0, yBytes > 0, uvBytes > 0 else { return false }

        guard let pixelBuffer = dequeuePixelBuffer(width: width, height: height) else {
            return false
        }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

        guard let yDest = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0),
              let uvDest = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1) else {
            return false
        }

        let yHeight = max(1, CVPixelBufferGetHeightOfPlane(pixelBuffer, 0))
        let dstYStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let srcYStride = yBytes / yHeight

        let uvHeight = max(1, CVPixelBufferGetHeightOfPlane(pixelBuffer, 1))
        let dstUVStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1)
        let srcUVStride = uvBytes / uvHeight

        guard Self.readPlane(
            fd: clientFD,
            destBase: yDest,
            dstStride: dstYStride,
            srcStride: srcYStride,
            rows: yHeight,
            totalBytes: yBytes
        ),
        Self.readPlane(
            fd: clientFD,
            destBase: uvDest,
            dstStride: dstUVStride,
            srcStride: srcUVStride,
            rows: uvHeight,
            totalBytes: uvBytes
        ) else {
            return false
        }

        delegate?.socketServerDidReceiveVideoFrame(pixelBuffer, header: header)
        return true
    }

    private static func readPlane(
        fd: Int32,
        destBase: UnsafeMutableRawPointer,
        dstStride: Int,
        srcStride: Int,
        rows: Int,
        totalBytes: Int
    ) -> Bool {
        // Fast zero-overhead path when source and destination plane strides match
        if srcStride == dstStride && totalBytes == dstStride * rows {
            return readExact(fd: fd, buffer: destBase, length: totalBytes)
        }

        // Safe row-by-row copy when IOSurface stride padding differs between Extension and Main App
        let copyWidth = min(srcStride, dstStride)
        let padBytes = max(0, srcStride - copyWidth)
        var scratchPad = Data(count: max(64, padBytes))
        var consumed = 0

        for row in 0..<rows {
            let rowDest = destBase.advanced(by: row * dstStride)
            guard readExact(fd: fd, buffer: rowDest, length: copyWidth) else { return false }
            consumed += copyWidth

            if padBytes > 0 {
                let drained = scratchPad.withUnsafeMutableBytes { raw -> Bool in
                    guard let base = raw.baseAddress else { return false }
                    return readExact(fd: fd, buffer: base, length: padBytes)
                }
                guard drained else { return false }
                consumed += padBytes
            }
        }

        let remainder = totalBytes - consumed
        if remainder > 0 {
            var tail = Data(count: remainder)
            let drained = tail.withUnsafeMutableBytes { raw -> Bool in
                guard let base = raw.baseAddress else { return false }
                return readExact(fd: fd, buffer: base, length: remainder)
            }
            guard drained else { return false }
        }

        return true
    }

    private func dequeuePixelBuffer(width: Int, height: Int) -> CVPixelBuffer? {
        if pixelBufferPool == nil || poolWidth != width || poolHeight != height {
            poolWidth = width
            poolHeight = height
            let poolAttrs: [CFString: Any] = [
                kCVPixelBufferPoolMinimumBufferCountKey: 4
            ]
            let bufferAttrs: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
                kCVPixelBufferWidthKey: width,
                kCVPixelBufferHeightKey: height,
                kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any]
            ]
            var newPool: CVPixelBufferPool?
            CVPixelBufferPoolCreate(
                kCFAllocatorDefault,
                poolAttrs as CFDictionary,
                bufferAttrs as CFDictionary,
                &newPool
            )
            pixelBufferPool = newPool
        }

        guard let pool = pixelBufferPool else { return nil }
        var pixelBuffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pixelBuffer)
        return pixelBuffer
    }

    private static func readExact(fd: Int32, buffer: UnsafeMutableRawPointer, length: Int) -> Bool {
        var totalRead = 0
        while totalRead < length {
            let ptr = buffer.advanced(by: totalRead)
            let count = Darwin.recv(fd, ptr, length - totalRead, 0)
            if count <= 0 {
                if count < 0 && errno == EINTR { continue }
                return false
            }
            totalRead += count
        }
        return true
    }
}
