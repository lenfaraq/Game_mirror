import Foundation

/// Compact 32-byte binary frame header (`WGMP`) sent over the App Group Unix Domain Socket
/// from ReplayKit Broadcast Upload Extension (<50MB RAM) to Main App (`VideoToolbox` + WebRTC).
public enum WGMPPacketType: UInt8 {
    case videoNV12 = 0x01
    case audioPCM  = 0x02
    case orientationChange = 0x03
    case streamStopped = 0x04
}

public enum WGMPOrientation: UInt8 {
    case portrait  = 0x00 // 1080x1920 (9:16)
    case landscape = 0x01 // 1920x1080 (16:9)

    public var stringValue: String {
        switch self {
        case .portrait: return "portrait"
        case .landscape: return "landscape"
        }
    }
}

public struct WGMPFrameHeader {
    public static let magic: UInt32 = 0x57474D50 // "WGMP"
    public static let headerSize: Int = 32

    public let packetType: WGMPPacketType
    public let orientation: WGMPOrientation
    public let rotationDegrees: UInt16
    public let width: UInt32
    public let height: UInt32
    public let yPlaneBytes: UInt32
    public let uvPlaneBytes: UInt32
    public let timestampMicros: UInt64

    public var totalPayloadBytes: Int {
        Int(yPlaneBytes) + Int(uvPlaneBytes)
    }

    public init(
        packetType: WGMPPacketType,
        orientation: WGMPOrientation,
        rotationDegrees: UInt16 = 0,
        width: UInt32 = 0,
        height: UInt32 = 0,
        yPlaneBytes: UInt32 = 0,
        uvPlaneBytes: UInt32 = 0,
        timestampMicros: UInt64 = 0
    ) {
        self.packetType = packetType
        self.orientation = orientation
        self.rotationDegrees = rotationDegrees
        self.width = width
        self.height = height
        self.yPlaneBytes = yPlaneBytes
        self.uvPlaneBytes = uvPlaneBytes
        self.timestampMicros = timestampMicros
    }

    public func serialize() -> Data {
        var data = Data(capacity: Self.headerSize)
        var magicBE = Self.magic.bigEndian
        var typeRaw = packetType.rawValue
        var orientRaw = orientation.rawValue
        var rotBE = rotationDegrees.bigEndian
        var widthBE = width.bigEndian
        var heightBE = height.bigEndian
        var yBytesBE = yPlaneBytes.bigEndian
        var uvBytesBE = uvPlaneBytes.bigEndian
        var tsBE = timestampMicros.bigEndian

        withUnsafeBytes(of: &magicBE) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: &typeRaw) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: &orientRaw) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: &rotBE) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: &widthBE) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: &heightBE) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: &yBytesBE) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: &uvBytesBE) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: &tsBE) { data.append(contentsOf: $0) }

        return data
    }

    public static func deserialize(from data: Data) -> WGMPFrameHeader? {
        guard data.count >= headerSize else { return nil }
        return data.withUnsafeBytes { raw -> WGMPFrameHeader? in
            guard let base = raw.baseAddress else { return nil }
            let magic = base.load(fromByteOffset: 0, as: UInt32.self).bigEndian
            guard magic == Self.magic else { return nil }

            let typeByte = base.load(fromByteOffset: 4, as: UInt8.self)
            let orientByte = base.load(fromByteOffset: 5, as: UInt8.self)
            guard let packetType = WGMPPacketType(rawValue: typeByte),
                  let orientation = WGMPOrientation(rawValue: orientByte) else {
                return nil
            }

            let rotation = base.load(fromByteOffset: 6, as: UInt16.self).bigEndian
            let width = base.load(fromByteOffset: 8, as: UInt32.self).bigEndian
            let height = base.load(fromByteOffset: 12, as: UInt32.self).bigEndian
            let yBytes = base.load(fromByteOffset: 16, as: UInt32.self).bigEndian
            let uvBytes = base.load(fromByteOffset: 20, as: UInt32.self).bigEndian
            let ts = base.load(fromByteOffset: 24, as: UInt64.self).bigEndian

            return WGMPFrameHeader(
                packetType: packetType,
                orientation: orientation,
                rotationDegrees: rotation,
                width: width,
                height: height,
                yPlaneBytes: yBytes,
                uvPlaneBytes: uvBytes,
                timestampMicros: ts
            )
        }
    }
}
