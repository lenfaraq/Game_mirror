import Foundation

/// Shared configuration between the Main App (`WirelessGameMirrorApp`)
/// and the ReplayKit Broadcast Upload Extension (`BroadcastExtension`).
/// Uses 1 shared App Group container so total App IDs = 2 (within Free Apple ID 3-ID limit).
public enum AppGroupConfig {
    public static let appGroupIdentifier = "group.com.wirelessgamemirror.shared"
    public static let broadcastExtensionBundleId = "com.wirelessgamemirror.app.BroadcastExtension"
    public static let socketFileName = "wgm_stream.sock"

    /// Hard memory ceiling inside Broadcast Upload Extension (iOS kills at 50 MB).
    /// We enforce a 35 MB safety threshold to drop frames before iOS jetsam triggers.
    public static let maxExtensionMemoryBytes: UInt64 = 35 * 1024 * 1024

    public static let mDNSServiceType = "_gamestream._tcp"
    public static let mDNSDomain = "local."

    public static var sharedContainerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)
    }

    public static var unixSocketPath: String {
        if let containerURL = sharedContainerURL {
            return containerURL.appendingPathComponent(socketFileName).path
        }
        return NSTemporaryDirectory().appending(socketFileName)
    }
}
