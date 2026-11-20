import Foundation
import Network
import Combine

public struct DiscoveredPCReceiver: Identifiable, Hashable {
    public let id: String
    public let name: String
    public let host: String
    public let port: Int
    public let sessionToken: String?
    public let authMethod: String // "qr-token" or "mdns-prompt"

    public var wsURL: URL? {
        var components = URLComponents()
        components.scheme = "ws"
        components.host = host
        components.port = port
        components.path = "/ws"
        if let token = sessionToken, !token.isEmpty {
            components.queryItems = [URLQueryItem(name: "token", value: token)]
        }
        return components.url
    }
}

/// Discovers PC Receivers on the local LAN via mDNS (`_gamestream._tcp.local`)
/// and parses QR Code pairing URIs (`gamemirror://connect?ip=...&port=...&token=...`).
public final class DiscoveryManager: ObservableObject {
    @Published public private(set) var discoveredReceivers: [DiscoveredPCReceiver] = []
    @Published public private(set) var isBrowsing: Bool = false

    private var browser: NWBrowser?
    private let browserQueue = DispatchQueue(label: "com.wirelessgamemirror.mdns.browser")

    public init() {}

    public func startBrowsing() {
        stopBrowsing()

        let params = NWParameters.tcp
        params.includePeerToPeer = true
        let descriptor = NWBrowser.Descriptor.bonjour(
            type: AppGroupConfig.mDNSServiceType,
            domain: AppGroupConfig.mDNSDomain
        )

        let nwBrowser = NWBrowser(for: descriptor, using: params)
        nwBrowser.stateUpdateHandler = { [weak self] state in
            DispatchQueue.main.async {
                switch state {
                case .ready:
                    self?.isBrowsing = true
                case .failed, .cancelled:
                    self?.isBrowsing = false
                default:
                    break
                }
            }
        }

        nwBrowser.browseResultsChangedHandler = { [weak self] results, _ in
            self?.resolveBrowseResults(results)
        }

        nwBrowser.start(queue: browserQueue)
        self.browser = nwBrowser
    }

    public func stopBrowsing() {
        browser?.cancel()
        browser = nil
        DispatchQueue.main.async {
            self.isBrowsing = false
        }
    }

    /// Parses a QR Code URI (`gamemirror://connect?ip=192.168.1.10&port=8080&token=...&name=PC`)
    /// or direct `ws://` URL into a `DiscoveredPCReceiver` with auto-auth token.
    public static func parseQRCodePayload(_ rawString: String) -> DiscoveredPCReceiver? {
        let trimmed = rawString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed) else { return nil }

        let queryMap = Dictionary(
            uniqueKeysWithValues: (components.queryItems ?? []).compactMap { item -> (String, String)? in
                guard let val = item.value else { return nil }
                return (item.name.lowercased(), val)
            }
        )

        if components.scheme?.lowercased() == "gamemirror" {
            guard let ip = queryMap["ip"], !ip.isEmpty else { return nil }
            let port = Int(queryMap["port"] ?? "8080") ?? 8080
            let token = queryMap["token"]
            let name = queryMap["name"] ?? "PC Receiver (\(ip))"

            return DiscoveredPCReceiver(
                id: "\(ip):\(port)",
                name: name,
                host: ip,
                port: port,
                sessionToken: token,
                authMethod: (token != nil && !token!.isEmpty) ? "qr-token" : "mdns-prompt"
            )
        }

        if let host = components.host, !host.isEmpty {
            let ip = queryMap["ip"] ?? host
            let port = Int(queryMap["port"] ?? "") ?? components.port ?? 8080
            let token = queryMap["token"]
            let name = queryMap["name"] ?? "PC Receiver (\(ip))"
            return DiscoveredPCReceiver(
                id: "\(ip):\(port)",
                name: name,
                host: ip,
                port: port,
                sessionToken: token,
                authMethod: (token != nil && !token!.isEmpty) ? "qr-token" : "mdns-prompt"
            )
        }

        return nil
    }

    private func resolveBrowseResults(_ results: Set<NWBrowser.Result>) {
        for result in results {
            guard case let .service(name, type, domain, _) = result.endpoint else { continue }
            let connection = NWConnection(to: result.endpoint, using: .tcp)
            connection.stateUpdateHandler = { [weak self] state in
                if case .ready = state,
                   let innerEndpoint = connection.currentPath?.remoteEndpoint,
                   case let .hostPort(host, port) = innerEndpoint {
                    let hostStr = Self.cleanHostString("\(host)")
                    let receiver = DiscoveredPCReceiver(
                        id: "\(name).\(type).\(domain)",
                        name: name,
                        host: hostStr,
                        port: Int(port.rawValue),
                        sessionToken: nil, // mDNS requires PC Allow/Deny prompt on first connect
                        authMethod: "mdns-prompt"
                    )
                    DispatchQueue.main.async {
                        guard let self = self else { return }
                        if !self.discoveredReceivers.contains(where: { $0.id == receiver.id }) {
                            self.discoveredReceivers.append(receiver)
                        }
                    }
                    connection.cancel()
                }
            }
            connection.start(queue: browserQueue)
        }
    }

    private static func cleanHostString(_ raw: String) -> String {
        if let percentIdx = raw.firstIndex(of: "%") {
            return String(raw[..<percentIdx])
        }
        return raw
    }
}
