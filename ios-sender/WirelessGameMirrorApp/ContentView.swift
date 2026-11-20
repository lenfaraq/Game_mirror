import SwiftUI
import ReplayKit
import AVFoundation

/// Native iOS Camera QR Code Scanner (`AVCaptureMetadataOutput` `.qr`) for scanning PC Receiver pairing QR Codes.
struct QRCameraScannerRepresentable: UIViewControllerRepresentable {
    var onQRScanned: (String) -> Void

    func makeUIViewController(context: Context) -> QRCameraScannerViewController {
        let vc = QRCameraScannerViewController()
        vc.onQRScanned = onQRScanned
        return vc
    }

    func updateUIViewController(_ uiViewController: QRCameraScannerViewController, context: Context) {}
}

final class QRCameraScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onQRScanned: ((String) -> Void)?
    private let captureSession = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var hasReported = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard let videoDevice = AVCaptureDevice.default(for: .video),
              let videoInput = try? AVCaptureDeviceInput(device: videoDevice),
              captureSession.canAddInput(videoInput) else {
            return
        }
        captureSession.addInput(videoInput)

        let metadataOutput = AVCaptureMetadataOutput()
        guard captureSession.canAddOutput(metadataOutput) else { return }
        captureSession.addOutput(metadataOutput)
        metadataOutput.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
        if metadataOutput.availableMetadataObjectTypes.contains(.qr) {
            metadataOutput.metadataObjectTypes = [.qr]
        }

        let layer = AVCaptureVideoPreviewLayer(session: captureSession)
        layer.frame = view.layer.bounds
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        self.previewLayer = layer

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.captureSession.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.layer.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if captureSession.isRunning {
            captureSession.stopRunning()
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !hasReported,
              let readable = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              readable.type == .qr,
              let stringValue = readable.stringValue else {
            return
        }
        hasReported = true
        captureSession.stopRunning()
        onQRScanned?(stringValue)
    }
}

/// Wraps `RPSystemBroadcastPickerView` so the gamer can launch the ReplayKit Broadcast Upload Extension
/// (`com.wirelessgamemirror.app.BroadcastExtension`) directly from the SwiftUI interface.
struct BroadcastPickerRepresentable: UIViewRepresentable {
    let preferredExtensionBundleId: String

    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        picker.preferredExtension = preferredExtensionBundleId
        picker.showsMicrophoneButton = false
        return picker
    }

    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}

public struct ContentView: View {
    @Binding private var incomingDeepLink: String?
    @StateObject private var discovery = DiscoveryManager()
    @StateObject private var streamCoordinator = WebRTCStreamCoordinator()

    @State private var qrInputText: String = ""
    @State private var isShowingCameraScanner: Bool = false
    @State private var selectedReceiver: DiscoveredPCReceiver?

    public init(incomingDeepLink: Binding<String?> = .constant(nil)) {
        self._incomingDeepLink = incomingDeepLink
    }

    public var body: some View {
        NavigationView {
            List {
                Section(header: Text("1. เชื่อมต่อด้วย QR Code (Auto-Auth Session Token)")) {
                    Button {
                        isShowingCameraScanner = true
                    } label: {
                        HStack {
                            Image(systemName: "qrcode.viewfinder")
                            Text("สแกน QR Code จากหน้าจอ PC ด้วยกล้อง")
                                .bold()
                        }
                    }

                    HStack {
                        TextField("หรือวางลิงก์ gamemirror://connect?ip=...", text: $qrInputText)
                            .textInputAutocapitalization(.never)
                            .disableAutocorrection(true)

                        Button("เชื่อมต่อ") {
                            if let receiver = DiscoveryManager.parseQRCodePayload(qrInputText) {
                                selectedReceiver = receiver
                                streamCoordinator.startSession(with: receiver)
                            }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }

                Section(header: Text("2. เครื่อง PC ที่พบบน LAN ผ่าน mDNS (_gamestream._tcp)")) {
                    if discovery.discoveredReceivers.isEmpty {
                        HStack {
                            ProgressView()
                            Text("กำลังค้นหาเครื่อง PC Receiver ในวง Wi-Fi เดียวกัน...")
                                .font(.footnote)
                                .foregroundColor(.secondary)
                        }
                    } else {
                        ForEach(discovery.discoveredReceivers) { pc in
                            Button {
                                selectedReceiver = pc
                                streamCoordinator.startSession(with: pc)
                            } label: {
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(pc.name).font(.headline)
                                        Text("\(pc.host):\(pc.port) • ต้องกด Allow บนหน้าจอ PC")
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "tv.and.mediabox")
                                }
                            }
                        }
                    }
                }

                Section(header: Text("3. เริ่มแชร์หน้าจอเกม (ReplayKit Split-Process < 30MB RAM)")) {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("กดปุ่มด้านขวาเพื่อเริ่ม Broadcast")
                                .font(.subheadline)
                                .bold()
                            Text("รองรับการหมุนจอแนวตั้ง (1080x1920) ↔ แนวนอน (1920x1080) อัตโนมัติ")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                        BroadcastPickerRepresentable(
                            preferredExtensionBundleId: AppGroupConfig.broadcastExtensionBundleId
                        )
                        .frame(width: 56, height: 56)
                    }
                }

                Section(header: Text("สถานะสตรีม & Telemetry (VideoToolbox H.264)")) {
                    HStack {
                        Text("สถานะเซสชัน")
                        Spacer()
                        Text(statusDescription)
                            .foregroundColor(.accentColor)
                            .bold()
                    }
                    HStack {
                        Text("แนวหน้าจอ (Orientation)")
                        Spacer()
                        Text(streamCoordinator.currentOrientation.stringValue.uppercased())
                    }
                    HStack {
                        Text("เป้าหมาย Bitrate / FPS")
                        Spacer()
                        Text("\(streamCoordinator.currentBitrateKbps / 1000) Mbps @ \(streamCoordinator.currentFps) FPS")
                    }

                    if streamCoordinator.sessionState != .idle {
                        Button(role: .destructive) {
                            streamCoordinator.stopSession()
                        } label: {
                            Text("หยุดสตรีมและตัดการเชื่อมต่อ")
                        }
                    }
                }
            }
            .navigationTitle("Wireless Game Mirror")
            .sheet(isPresented: $isShowingCameraScanner) {
                QRCameraScannerRepresentable { scannedCode in
                    isShowingCameraScanner = false
                    qrInputText = scannedCode
                    if let receiver = DiscoveryManager.parseQRCodePayload(scannedCode) {
                        selectedReceiver = receiver
                        streamCoordinator.startSession(with: receiver)
                    }
                }
            }
            .onAppear {
                discovery.startBrowsing()
                handleDeepLinkIfNeeded(incomingDeepLink)
            }
            .onChange(of: incomingDeepLink) { newValue in
                handleDeepLinkIfNeeded(newValue)
            }
            .onDisappear {
                discovery.stopBrowsing()
            }
        }
    }

    private func handleDeepLinkIfNeeded(_ rawURL: String?) {
        guard let rawURL, !rawURL.isEmpty else { return }
        incomingDeepLink = nil
        isShowingCameraScanner = false
        qrInputText = rawURL
        if let receiver = DiscoveryManager.parseQRCodePayload(rawURL) {
            selectedReceiver = receiver
            streamCoordinator.startSession(with: receiver)
        }
    }

    private var statusDescription: String {
        switch streamCoordinator.sessionState {
        case .idle:
            return "ยังไม่ได้เชื่อมต่อ"
        case .awaitingPCApproval(let msg):
            return msg
        case .approvedAndReady:
            return "พร้อมสตรีม (กดปุ่ม Broadcast ด้านบน)"
        case .streamingLive:
            return "กำลังสตรีมสด (\(streamCoordinator.encodedFramesPerSecond) FPS)"
        case .error(let err):
            return "ข้อผิดพลาด: \(err)"
        }
    }
}
