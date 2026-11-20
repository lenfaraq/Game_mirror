import Foundation
import Darwin

/// Ultra-lightweight POSIX Unix Domain Socket Client used inside the ReplayKit Broadcast Extension.
/// Uses non-blocking I/O and zero internal queues so RAM usage stays flat (<25 MB).
public final class FrameSocketClient {
    private var socketFD: Int32 = -1
    private let socketPath: String
    private let lock = NSLock()

    public init(socketPath: String = AppGroupConfig.unixSocketPath) {
        self.socketPath = socketPath
    }

    deinit {
        disconnect()
    }

    @discardableResult
    public func connectIfNeeded() -> Bool {
        lock.lock()
        defer { lock.unlock() }

        if socketFD >= 0 {
            return true
        }

        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }

        var noSigPipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))

        var sendBufSize: Int32 = 512 * 1024
        setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &sendBufSize, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)

        let maxPathLen = MemoryLayout.size(ofValue: addr.sun_path)
        let pathBytes = socketPath.utf8CString
        guard pathBytes.count < maxPathLen else {
            Darwin.close(fd)
            return false
        }

        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            let rawPtr = UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: CChar.self)
            for i in 0..<pathBytes.count {
                rawPtr[i] = pathBytes[i]
            }
        }

        let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connectResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, addrLen)
            }
        }

        guard connectResult == 0 else {
            Darwin.close(fd)
            return false
        }

        // Switch to non-blocking mode so slow downstream never stalls ReplayKit or buffers in RAM
        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)

        socketFD = fd
        return true
    }

    public func sendVideoPlanes(
        header: WGMPFrameHeader,
        yBaseAddress: UnsafeRawPointer,
        yLength: Int,
        uvBaseAddress: UnsafeRawPointer,
        uvLength: Int
    ) -> Bool {
        guard connectIfNeeded() else { return false }

        lock.lock()
        defer { lock.unlock() }

        let headerData = header.serialize()
        return headerData.withUnsafeBytes { headerRaw -> Bool in
            guard let headerPtr = headerRaw.baseAddress else { return false }

            var iov = [
                iovec(iov_base: UnsafeMutableRawPointer(mutating: headerPtr), iov_len: headerData.count),
                iovec(iov_base: UnsafeMutableRawPointer(mutating: yBaseAddress), iov_len: yLength),
                iovec(iov_base: UnsafeMutableRawPointer(mutating: uvBaseAddress), iov_len: uvLength)
            ]

            let expectedBytes = headerData.count + yLength + uvLength
            let written = Darwin.writev(socketFD, &iov, Int32(iov.count))

            if written < 0 {
                let err = errno
                if err == EAGAIN || err == EWOULDBLOCK {
                    // Backpressure: drop frame immediately to protect 50MB RAM limit
                    return false
                }
                closeLocked()
                return false
            }

            if written != expectedBytes {
                // Partial non-blocking write: reset socket so framing stays aligned
                closeLocked()
                return false
            }

            return true
        }
    }

    public func sendPacket(header: WGMPFrameHeader, payload: UnsafeRawPointer?, payloadLength: Int) -> Bool {
        guard connectIfNeeded() else { return false }

        lock.lock()
        defer { lock.unlock() }

        let headerData = header.serialize()
        return headerData.withUnsafeBytes { headerRaw -> Bool in
            guard let headerPtr = headerRaw.baseAddress else { return false }

            if let payload = payload, payloadLength > 0 {
                var iov = [
                    iovec(iov_base: UnsafeMutableRawPointer(mutating: headerPtr), iov_len: headerData.count),
                    iovec(iov_base: UnsafeMutableRawPointer(mutating: payload), iov_len: payloadLength)
                ]
                let expected = headerData.count + payloadLength
                let written = Darwin.writev(socketFD, &iov, 2)
                if written != expected {
                    if errno != EAGAIN && errno != EWOULDBLOCK {
                        closeLocked()
                    }
                    return false
                }
                return true
            } else {
                let written = Darwin.send(socketFD, headerPtr, headerData.count, 0)
                if written != headerData.count {
                    closeLocked()
                    return false
                }
                return true
            }
        }
    }

    public func disconnect() {
        lock.lock()
        defer { lock.unlock() }
        closeLocked()
    }

    private func closeLocked() {
        if socketFD >= 0 {
            Darwin.close(socketFD)
            socketFD = -1
        }
    }
}
