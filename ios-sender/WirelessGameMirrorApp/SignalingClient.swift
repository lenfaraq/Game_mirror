import Foundation
import UIKit

public protocol SignalingClientDelegate: AnyObject {
    func signalingDidApproveSession(token: String, targetConfig: [String: Any])
    func signalingDidAwaitPCApproval(message: String)
    func signalingDidRejectSession(reason: String)
    func signalingDidDetectViewerJoined(viewerId: String, role: String)
    func signalingDidDetectViewerLeft(viewerId: String)
    func signalingDidReceiveAnswer(sdp: String, viewerId: String)
    func signalingDidReceiveIceCandidate(candidate: [String: Any], viewerId: String)
    func signalingDidReceiveEncoderControl(bitrateKbps: Int?, fps: Int?, resolution: String?, forceKeyframe: Bool)
}

/// WebSocket Signaling Client for iOS Sender.
/// Supports both QR Code Token Auto-Auth and mDNS Allow/Deny PC approval flow,
/// plus multi-viewer SDP Offer/Answer routing (Dashboard + OBS Browser Source).
public final class SignalingClient {
    public weak var delegate: SignalingClientDelegate?

    private var webSocketTask: URLSessionWebSocketTask?
    private let urlSession = URLSession(configuration: .default)
    private let deviceId: String
    private var isConnected = false

    public init(deviceId: String = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString) {
        self.deviceId = deviceId
    }

    public func connect(to receiver: DiscoveredPCReceiver, initialOrientation: WGMPOrientation = .landscape) {
        disconnect()
        guard let wsURL = receiver.wsURL else { return }

        let task = urlSession.webSocketTask(with: wsURL)
        self.webSocketTask = task
        self.isConnected = true
        task.resume()

        receiveNextMessage()

        let width = initialOrientation == .portrait ? 1080 : 1920
        let height = initialOrientation == .portrait ? 1920 : 1080

        var joinPayload: [String: Any] = [
            "type": "join-sender",
            "deviceId": deviceId,
            "deviceName": UIDevice.current.name,
            "platform": "ios",
            "authMethod": receiver.authMethod,
            "orientation": initialOrientation.stringValue,
            "width": width,
            "height": height
        ]

        if let token = receiver.sessionToken, !token.isEmpty {
            joinPayload["token"] = token
        }

        sendJSON(joinPayload)
    }

    public func disconnect() {
        isConnected = false
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
    }

    public func sendOffer(sdp: String, viewerId: String) {
        sendJSON([
            "type": "offer",
            "viewerId": viewerId,
            "sdp": sdp
        ])
    }

    public func sendIceCandidate(_ candidateDict: [String: Any], viewerId: String) {
        sendJSON([
            "type": "ice-candidate",
            "viewerId": viewerId,
            "candidate": candidateDict
        ])
    }

    public func sendOrientationChange(orientation: WGMPOrientation, width: UInt32, height: UInt32, rotationDegrees: UInt16) {
        sendJSON([
            "type": "orientation",
            "orientation": orientation.stringValue,
            "width": Int(width),
            "height": Int(height),
            "rotationDegrees": Int(rotationDegrees)
        ])
    }

    public func sendTelemetry(fps: Int, bitrateKbps: Int, batteryPct: Int, tempCelsius: Double, memoryMb: Double) {
        sendJSON([
            "type": "telemetry",
            "telemetry": [
                "fps": fps,
                "bitrateKbps": bitrateKbps,
                "batteryPct": batteryPct,
                "tempCelsius": tempCelsius,
                "memoryMb": memoryMb,
                "encoder": "VideoToolbox H.264 (Zero B-Frames)"
            ]
        ])
    }

    private func sendJSON(_ dict: [String: Any]) {
        guard isConnected,
              let task = webSocketTask,
              let data = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: data, encoding: .utf8) else {
            return
        }
        task.send(.string(text)) { _ in }
    }

    private func receiveNextMessage() {
        guard isConnected, let task = webSocketTask else { return }
        task.receive { [weak self] result in
            guard let self = self, self.isConnected else { return }
            switch result {
            case .success(let message):
                if case let .string(text) = message,
                   let data = text.data(using: .utf8),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    self.handleIncomingJSON(json)
                }
                self.receiveNextMessage()
            case .failure(let error):
                DispatchQueue.main.async {
                    self.delegate?.signalingDidRejectSession(reason: error.localizedDescription)
                }
            }
        }
    }

    private func handleIncomingJSON(_ json: [String: Any]) {
        guard let type = json["type"] as? String else { return }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            switch type {
            case "auth-result":
                let status = json["status"] as? String ?? ""
                if status == "approved" {
                    let token = json["sessionToken"] as? String ?? ""
                    let cfg = json["targetConfig"] as? [String: Any] ?? [:]
                    self.delegate?.signalingDidApproveSession(token: token, targetConfig: cfg)
                } else if status == "pending-approval" {
                    let msg = json["message"] as? String ?? "รอกด Allow บนหน้าจอ PC"
                    self.delegate?.signalingDidAwaitPCApproval(message: msg)
                } else {
                    let reason = (json["message"] as? String) ?? (json["reason"] as? String) ?? "การเชื่อมต่อถูกปฏิเสธ"
                    self.delegate?.signalingDidRejectSession(reason: reason)
                }

            case "viewer-joined":
                if let viewerId = json["viewerId"] as? String {
                    let role = json["role"] as? String ?? "viewer"
                    self.delegate?.signalingDidDetectViewerJoined(viewerId: viewerId, role: role)
                }

            case "viewer-left":
                if let viewerId = json["viewerId"] as? String {
                    self.delegate?.signalingDidDetectViewerLeft(viewerId: viewerId)
                }

            case "answer":
                if let sdp = json["sdp"] as? String {
                    let viewerId = json["viewerId"] as? String ?? "default"
                    self.delegate?.signalingDidReceiveAnswer(sdp: sdp, viewerId: viewerId)
                }

            case "ice-candidate":
                if let cand = json["candidate"] as? [String: Any] {
                    let viewerId = json["viewerId"] as? String ?? "default"
                    self.delegate?.signalingDidReceiveIceCandidate(candidate: cand, viewerId: viewerId)
                }

            case "control":
                let action = json["action"] as? String
                let cfg = (json["config"] as? [String: Any]) ?? json
                let bitrate = cfg["bitrateKbps"] as? Int
                let fps = cfg["fps"] as? Int
                let resolution = cfg["resolution"] as? String
                self.delegate?.signalingDidReceiveEncoderControl(
                    bitrateKbps: bitrate,
                    fps: fps,
                    resolution: resolution,
                    forceKeyframe: action == "request-keyframe"
                )

            case "session-ended", "session-replaced":
                let reason = (json["reason"] as? String) ?? (json["message"] as? String) ?? "เซสชันสิ้นสุด"
                self.delegate?.signalingDidRejectSession(reason: reason)

            default:
                break
            }
        }
    }
}
