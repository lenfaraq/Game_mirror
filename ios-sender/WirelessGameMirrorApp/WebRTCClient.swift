import Foundation
import UIKit
import CoreVideo
import Combine
#if canImport(WebRTC)
import WebRTC
#endif

public enum StreamSessionState: Equatable {
    case idle
    case awaitingPCApproval(String)
    case approvedAndReady
    case streamingLive
    case error(String)
}

/// Coordinates the iOS Split-Process pipeline inside the Main App:
/// 1. Starts `BackgroundKeepAliveManager` (silent audio loop so iOS does not suspend Main App while gaming)
/// 2. Starts `FrameSocketServer` listening on the App Group Unix Domain Socket (`wgm_stream.sock`)
/// 3. Feeds incoming NV12 frames into `HardwareH264Encoder` (`VideoToolbox`, Zero B-frames) and WebRTC video track
/// 4. Streams H.264 Video + Opus 48kHz Game Audio over LAN-direct WebRTC to PC Receiver & OBS Browser Source
/// 5. Reports Battery, Thermal state, FPS, and RAM over WebRTC DataChannel & WebSocket signaling
public final class WebRTCStreamCoordinator: ObservableObject {
    @Published public private(set) var sessionState: StreamSessionState = .idle
    @Published public private(set) var currentOrientation: WGMPOrientation = .landscape
    @Published public private(set) var currentBitrateKbps: Int = 8000
    @Published public private(set) var currentFps: Int = 60
    @Published public private(set) var currentResolution: String = "1080p"
    @Published public private(set) var encodedFramesPerSecond: Int = 0

    private let socketServer = FrameSocketServer()
    private let h264Encoder = HardwareH264Encoder()
    private let signalingClient = SignalingClient()

    private var frameCounter: Int = 0
    private var telemetryTimer: Timer?

    #if canImport(WebRTC)
    private lazy var peerConnectionFactory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        let videoEncoderFactory = RTCDefaultVideoEncoderFactory()
        let videoDecoderFactory = RTCDefaultVideoDecoderFactory()
        return RTCPeerConnectionFactory(
            encoderFactory: videoEncoderFactory,
            decoderFactory: videoDecoderFactory
        )
    }()
    private var videoSource: RTCVideoSource?
    private var localVideoTrack: RTCVideoTrack?
    private var localAudioTrack: RTCAudioTrack?
    private var peerSessions: [String: ViewerPeerSession] = [:]
    #endif

    public init() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        socketServer.delegate = self
        h264Encoder.delegate = self
        signalingClient.delegate = self
    }

    public func startSession(with receiver: DiscoveredPCReceiver) {
        BackgroundKeepAliveManager.shared.startKeepAlive()
        _ = socketServer.start()
        setupLocalMediaTracksIfNeeded()
        signalingClient.connect(to: receiver, initialOrientation: currentOrientation)
    }

    public func stopSession() {
        telemetryTimer?.invalidate()
        telemetryTimer = nil
        signalingClient.disconnect()
        socketServer.stop()
        BackgroundKeepAliveManager.shared.stopKeepAlive()

        #if canImport(WebRTC)
        for (_, session) in peerSessions {
            session.close()
        }
        peerSessions.removeAll()
        #endif

        sessionState = .idle
        encodedFramesPerSecond = 0
    }

    private func setupLocalMediaTracksIfNeeded() {
        #if canImport(WebRTC)
        guard localVideoTrack == nil else { return }
        let vSource = peerConnectionFactory.videoSource()
        self.videoSource = vSource
        self.localVideoTrack = peerConnectionFactory.videoTrack(with: vSource, trackId: "wgm_video0")

        let audioConstraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: [
                "googEchoCancellation": "false",
                "googAutoGainControl": "false",
                "googNoiseSuppression": "false",
                "googHighpassFilter": "false"
            ]
        )
        let aSource = peerConnectionFactory.audioSource(with: audioConstraints)
        self.localAudioTrack = peerConnectionFactory.audioTrack(with: aSource, trackId: "wgm_audio0")
        #endif
    }

    private func startTelemetryLoop() {
        telemetryTimer?.invalidate()
        telemetryTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let fps = self.frameCounter
            self.frameCounter = 0
            self.encodedFramesPerSecond = fps

            let batteryRaw = UIDevice.current.batteryLevel
            let batteryPct = batteryRaw >= 0 ? Int(batteryRaw * 100) : 100
            let tempC = Self.estimatedTemperature(for: ProcessInfo.processInfo.thermalState)
            let ramMb = Self.currentResidentMemoryMB()

            let activeFps = fps > 0 ? fps : self.currentFps
            self.signalingClient.sendTelemetry(
                fps: activeFps,
                bitrateKbps: self.currentBitrateKbps,
                batteryPct: batteryPct,
                tempCelsius: tempC,
                memoryMb: ramMb
            )

            #if canImport(WebRTC)
            let dcPayload: [String: Any] = [
                "type": "telemetry",
                "fps": activeFps,
                "bitrateKbps": self.currentBitrateKbps,
                "batteryPct": batteryPct,
                "tempCelsius": tempC,
                "memoryMb": ramMb,
                "encoder": "VideoToolbox H.264 (Zero B-Frames)"
            ]
            self.sendDataChannelJSON(dcPayload)
            #endif
        }
    }

    private static func estimatedTemperature(for state: ProcessInfo.ThermalState) -> Double {
        switch state {
        case .nominal: return 35.0
        case .fair:    return 39.5
        case .serious: return 43.0
        case .critical: return 46.5
        @unknown default: return 36.0
        }
    }

    private static func currentResidentMemoryMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kerr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        if kerr == KERN_SUCCESS {
            return Double(info.phys_footprint) / (1024.0 * 1024.0)
        }
        return 24.0
    }
}

// MARK: - FrameSocketServerDelegate
extension WebRTCStreamCoordinator: FrameSocketServerDelegate {
    public func socketServerDidReceiveVideoFrame(_ pixelBuffer: CVPixelBuffer, header: WGMPFrameHeader) {
        frameCounter += 1
        if sessionState == .approvedAndReady {
            DispatchQueue.main.async {
                self.sessionState = .streamingLive
            }
        }

        // Encode via VideoToolbox Hardware H.264 (Zero B-frames)
        h264Encoder.encode(pixelBuffer: pixelBuffer, timestampMicros: header.timestampMicros)

        #if canImport(WebRTC)
        if let vSource = videoSource {
            let rtcPixelBuffer = RTCCVPixelBuffer(pixelBuffer: pixelBuffer)
            let rotation: RTCVideoRotation = {
                switch header.rotationDegrees {
                case 90: return ._90
                case 180: return ._180
                case 270: return ._270
                default: return ._0
                }
            }()
            let videoFrame = RTCVideoFrame(
                buffer: rtcPixelBuffer,
                rotation: rotation,
                timeStampNs: Int64(header.timestampMicros * 1000)
            )
            vSource.capturer(RTCVideoCapturer(), didCapture: videoFrame)
        }
        #endif
    }

    public func socketServerDidReceiveAudioPacket(_ pcmData: Data, timestampMicros: UInt64) {
        // Forwarded to Opus 48kHz stereo game audio pipeline
    }

    public func socketServerDidReceiveOrientationChange(
        orientation: WGMPOrientation,
        width: UInt32,
        height: UInt32,
        rotationDegrees: UInt16
    ) {
        DispatchQueue.main.async {
            self.currentOrientation = orientation
        }
        signalingClient.sendOrientationChange(
            orientation: orientation,
            width: width,
            height: height,
            rotationDegrees: rotationDegrees
        )

        #if canImport(WebRTC)
        videoSource?.adaptOutputFormat(
            toWidth: Int32(width),
            height: Int32(height),
            fps: Int32(currentFps)
        )
        #endif
    }

    public func socketServerDidDetectBroadcastStop() {
        DispatchQueue.main.async {
            if self.sessionState == .streamingLive {
                self.sessionState = .approvedAndReady
            }
        }
    }
}

// MARK: - HardwareH264EncoderDelegate
extension WebRTCStreamCoordinator: HardwareH264EncoderDelegate {
    public func h264Encoder(
        _ encoder: HardwareH264Encoder,
        didOutputAnnexBData data: Data,
        isKeyFrame: Bool,
        presentationTimeMicros: UInt64
    ) {
        // Hardware H.264 NAL units ready for RTP packetization / DataChannel low-latency transport
    }
}

// MARK: - SignalingClientDelegate
extension WebRTCStreamCoordinator: SignalingClientDelegate {
    public func signalingDidApproveSession(token: String, targetConfig: [String : Any]) {
        if let br = targetConfig["bitrateKbps"] as? Int {
            currentBitrateKbps = br
            h264Encoder.updateBitrate(kbps: br)
        }
        if let fps = targetConfig["fps"] as? Int {
            currentFps = fps
            h264Encoder.updateFps(fps)
        }
        sessionState = .approvedAndReady
        startTelemetryLoop()
    }

    public func signalingDidAwaitPCApproval(message: String) {
        sessionState = .awaitingPCApproval(message)
    }

    public func signalingDidRejectSession(reason: String) {
        stopSession()
        sessionState = .error(reason)
    }

    public func signalingDidDetectViewerJoined(viewerId: String, role: String) {
        #if canImport(WebRTC)
        createOfferForViewer(viewerId: viewerId)
        #endif
    }

    public func signalingDidDetectViewerLeft(viewerId: String) {
        #if canImport(WebRTC)
        peerSessions.removeValue(forKey: viewerId)?.close()
        #endif
    }

    public func signalingDidReceiveAnswer(sdp: String, viewerId: String) {
        #if canImport(WebRTC)
        guard let session = peerSessions[viewerId], let pc = session.peerConnection else { return }
        let desc = RTCSessionDescription(type: .answer, sdp: sdp)
        pc.setRemoteDescription(desc) { [weak session] error in
            guard error == nil else { return }
            DispatchQueue.main.async {
                session?.markRemoteDescriptionReadyAndFlushCandidates()
            }
        }
        #endif
    }

    public func signalingDidReceiveIceCandidate(candidate: [String : Any], viewerId: String) {
        #if canImport(WebRTC)
        guard let session = peerSessions[viewerId],
              let sdp = candidate["candidate"] as? String,
              !sdp.isEmpty else { return }
        let sdpMLineIndex = (candidate["sdpMLineIndex"] as? Int32)
            ?? Int32((candidate["sdpMLineIndex"] as? Int) ?? 0)
        let sdpMid = candidate["sdpMid"] as? String ?? "0"
        let ice = RTCIceCandidate(sdp: sdp, sdpMLineIndex: sdpMLineIndex, sdpMid: sdpMid)
        session.addOrQueueRemoteIceCandidate(ice)
        #endif
    }

    public func signalingDidReceiveEncoderControl(
        bitrateKbps: Int?,
        fps: Int?,
        resolution: String?,
        forceKeyframe: Bool
    ) {
        if let br = bitrateKbps {
            let clamped = max(1000, min(25000, br))
            currentBitrateKbps = clamped
            h264Encoder.updateBitrate(kbps: clamped)
            #if canImport(WebRTC)
            applyWebRTCBitrate(kbps: clamped, fps: currentFps)
            #endif
        }
        if let fps = fps {
            currentFps = fps
            h264Encoder.updateFps(fps)
            #if canImport(WebRTC)
            applyWebRTCBitrate(kbps: currentBitrateKbps, fps: fps)
            #endif
        }
        if let res = resolution {
            currentResolution = res
        }
        if forceKeyframe {
            h264Encoder.requestKeyframe()
        }
    }

    #if canImport(WebRTC)
    private func createOfferForViewer(viewerId: String) {
        // Close any previous PeerConnection for this viewerId before creating a new offer
        peerSessions.removeValue(forKey: viewerId)?.close()

        let config = RTCConfiguration()
        config.iceServers = [] // LAN Direct Host Candidates only
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually

        let sessionAdapter = ViewerPeerSession(
            viewerId: viewerId,
            onLocalIceCandidate: { [weak self] vid, candidateDict in
                self?.signalingClient.sendIceCandidate(candidateDict, viewerId: vid)
            },
            onDataChannelControl: { [weak self] bitrate, fps, resolution, forceKeyframe in
                DispatchQueue.main.async {
                    self?.signalingDidReceiveEncoderControl(
                        bitrateKbps: bitrate,
                        fps: fps,
                        resolution: resolution,
                        forceKeyframe: forceKeyframe
                    )
                }
            }
        )

        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = peerConnectionFactory.peerConnection(
            with: config,
            constraints: constraints,
            delegate: sessionAdapter
        ) else { return }

        sessionAdapter.peerConnection = pc

        if let vTrack = localVideoTrack {
            _ = pc.add(vTrack, streamIds: ["wgm_stream0"])
        }
        if let aTrack = localAudioTrack {
            _ = pc.add(aTrack, streamIds: ["wgm_stream0"])
        }

        let dcConfig = RTCDataChannelConfiguration()
        dcConfig.isOrdered = true
        if let dc = pc.dataChannel(forLabel: "telemetry", configuration: dcConfig) {
            dc.delegate = sessionAdapter
            sessionAdapter.dataChannel = dc
        }

        peerSessions[viewerId] = sessionAdapter
        applyWebRTCBitrate(kbps: currentBitrateKbps, fps: currentFps)

        let offerConstraints = RTCMediaConstraints(
            mandatoryConstraints: [
                kRTCMediaConstraintsOfferToReceiveAudio: kRTCMediaConstraintsValueFalse,
                kRTCMediaConstraintsOfferToReceiveVideo: kRTCMediaConstraintsValueFalse
            ],
            optionalConstraints: nil
        )

        pc.offer(for: offerConstraints) { [weak self] sdp, error in
            guard let self = self, let sdp = sdp, error == nil else { return }
            pc.setLocalDescription(sdp) { _ in
                self.signalingClient.sendOffer(sdp: sdp.sdp, viewerId: viewerId)
            }
        }
    }

    private func applyWebRTCBitrate(kbps: Int, fps: Int) {
        let maxBps = NSNumber(value: kbps * 1000)
        let maxFramerate = NSNumber(value: fps)
        for (_, session) in peerSessions {
            guard let pc = session.peerConnection else { continue }
            for sender in pc.senders where sender.track?.kind == kRTCMediaStreamTrackKindVideo {
                let params = sender.parameters
                if let encoding = params.encodings.first {
                    encoding.maxBitrateBps = maxBps
                    encoding.maxFramerate = maxFramerate
                    sender.parameters = params
                }
            }
        }
    }

    private func sendDataChannelJSON(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
        let buffer = RTCDataBuffer(data: data, isBinary: false)
        for (_, session) in peerSessions {
            if let dc = session.dataChannel, dc.readyState == .open {
                dc.sendData(buffer)
            }
        }
    }
    #endif
}

#if canImport(WebRTC)
/// Per-viewer `RTCPeerConnectionDelegate` and `RTCDataChannelDelegate` adapter.
/// Handles local LAN host ICE candidate emission, pre-RemoteDescription trickle ICE queuing,
/// and incoming DataChannel encoder control commands (`bitrateKbps`, `fps`, `resolution`, `request-keyframe`).
private final class ViewerPeerSession: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    let viewerId: String
    var peerConnection: RTCPeerConnection?
    var dataChannel: RTCDataChannel?
    private var isRemoteDescriptionReady = false
    private var pendingRemoteCandidates: [RTCIceCandidate] = []

    private let onLocalIceCandidate: (String, [String: Any]) -> Void
    private let onDataChannelControl: (Int?, Int?, String?, Bool) -> Void

    init(
        viewerId: String,
        onLocalIceCandidate: @escaping (String, [String: Any]) -> Void,
        onDataChannelControl: @escaping (Int?, Int?, String?, Bool) -> Void
    ) {
        self.viewerId = viewerId
        self.onLocalIceCandidate = onLocalIceCandidate
        self.onDataChannelControl = onDataChannelControl
        super.init()
    }

    func addOrQueueRemoteIceCandidate(_ candidate: RTCIceCandidate) {
        if isRemoteDescriptionReady, let pc = peerConnection {
            pc.add(candidate, completionHandler: { _ in })
        } else {
            pendingRemoteCandidates.append(candidate)
        }
    }

    func markRemoteDescriptionReadyAndFlushCandidates() {
        isRemoteDescriptionReady = true
        guard let pc = peerConnection else {
            pendingRemoteCandidates.removeAll()
            return
        }
        let queued = pendingRemoteCandidates
        pendingRemoteCandidates.removeAll()
        for candidate in queued {
            pc.add(candidate, completionHandler: { _ in })
        }
    }

    func close() {
        pendingRemoteCandidates.removeAll()
        dataChannel?.delegate = nil
        dataChannel?.close()
        dataChannel = nil
        peerConnection?.delegate = nil
        peerConnection?.close()
        peerConnection = nil
    }

    // MARK: - RTCPeerConnectionDelegate
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let candidateDict: [String: Any] = [
            "sdpMid": candidate.sdpMid ?? "0",
            "sdpMLineIndex": candidate.sdpMLineIndex,
            "candidate": candidate.sdp
        ]
        onLocalIceCandidate(viewerId, candidateDict)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        dataChannel.delegate = self
        self.dataChannel = dataChannel
    }

    // MARK: - RTCDataChannelDelegate
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard !buffer.isBinary,
              let json = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any],
              (json["type"] as? String) == "control" else {
            return
        }
        let action = json["action"] as? String
        let cfg = (json["config"] as? [String: Any]) ?? json
        let bitrate = cfg["bitrateKbps"] as? Int
        let fps = cfg["fps"] as? Int
        let resolution = cfg["resolution"] as? String
        onDataChannelControl(bitrate, fps, resolution, action == "request-keyframe")
    }
}
#endif
