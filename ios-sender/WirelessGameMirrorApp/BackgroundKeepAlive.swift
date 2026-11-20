import Foundation
import AVFoundation

/// Keeps the Main App (`WirelessGameMirrorApp`) active in the background while the user
/// plays a full-screen mobile game and the ReplayKit Extension streams frames over the App Group socket.
/// Designed for Free Apple ID sideloaded builds (`UIBackgroundModes: audio` with `.mixWithOthers`).
public final class BackgroundKeepAliveManager {
    public static let shared = BackgroundKeepAliveManager()

    private var audioPlayer: AVAudioPlayer?
    public private(set) var isRunning: Bool = false

    private init() {}

    public func startKeepAlive() {
        guard !isRunning else { return }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)

            let silentWavData = Self.makeSilentWavData(sampleRate: 8000, durationSeconds: 2)
            let player = try AVAudioPlayer(data: silentWavData, fileTypeHint: AVFileType.wav.rawValue)
            player.numberOfLoops = -1
            player.volume = 0.0
            player.prepareToPlay()
            player.play()

            self.audioPlayer = player
            self.isRunning = true
        } catch {
            print("[BackgroundKeepAlive] Failed to activate background audio keep-alive: \(error)")
        }
    }

    public func stopKeepAlive() {
        audioPlayer?.stop()
        audioPlayer = nil
        isRunning = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Generates a valid 16-bit mono PCM WAV buffer filled with zeros (silence).
    private static func makeSilentWavData(sampleRate: UInt32, durationSeconds: UInt32) -> Data {
        let numSamples = sampleRate * durationSeconds
        let dataBytes = numSamples * 2
        let totalFileBytes = 36 + dataBytes

        var header = Data(capacity: 44 + Int(dataBytes))
        header.append("RIFF".data(using: .ascii)!)
        var chunkSize = totalFileBytes.littleEndian
        withUnsafeBytes(of: &chunkSize) { header.append(contentsOf: $0) }
        header.append("WAVE".data(using: .ascii)!)
        header.append("fmt ".data(using: .ascii)!)

        var subchunk1Size: UInt32 = UInt32(16).littleEndian
        var audioFormat: UInt16 = UInt16(1).littleEndian // PCM
        var numChannels: UInt16 = UInt16(1).littleEndian
        var srLE = sampleRate.littleEndian
        var byteRate = (sampleRate * 2).littleEndian
        var blockAlign: UInt16 = UInt16(2).littleEndian
        var bitsPerSample: UInt16 = UInt16(16).littleEndian

        withUnsafeBytes(of: &subchunk1Size) { header.append(contentsOf: $0) }
        withUnsafeBytes(of: &audioFormat) { header.append(contentsOf: $0) }
        withUnsafeBytes(of: &numChannels) { header.append(contentsOf: $0) }
        withUnsafeBytes(of: &srLE) { header.append(contentsOf: $0) }
        withUnsafeBytes(of: &byteRate) { header.append(contentsOf: $0) }
        withUnsafeBytes(of: &blockAlign) { header.append(contentsOf: $0) }
        withUnsafeBytes(of: &bitsPerSample) { header.append(contentsOf: $0) }

        header.append("data".data(using: .ascii)!)
        var dataSizeLE = dataBytes.littleEndian
        withUnsafeBytes(of: &dataSizeLE) { header.append(contentsOf: $0) }
        header.append(Data(count: Int(dataBytes)))

        return header
    }
}
