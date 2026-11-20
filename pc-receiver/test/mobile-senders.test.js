const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

describe('4. iOS Sender (Split-Process ReplayKit < 50MB RAM + VideoToolbox + Free Apple ID Workflow) Verification', () => {
  test('verifies iOS Split-Process App Group config and 35MB memory safety guard (<50MB iOS limit)', () => {
    const appGroupFile = fs.readFileSync(
      path.join(repoRoot, 'ios-sender', 'Shared', 'AppGroupConfig.swift'),
      'utf8'
    );
    assert.ok(appGroupFile.includes('group.com.wirelessgamemirror.shared'));
    assert.ok(appGroupFile.includes('maxExtensionMemoryBytes: UInt64 = 35 * 1024 * 1024'));
    assert.ok(appGroupFile.includes('_gamestream._tcp'));

    const packetProto = fs.readFileSync(
      path.join(repoRoot, 'ios-sender', 'Shared', 'FramePacketProtocol.swift'),
      'utf8'
    );
    assert.ok(packetProto.includes('0x57474D50')); // "WGMP" magic
    assert.ok(packetProto.includes('case videoNV12 = 0x01'));
    assert.ok(packetProto.includes('case audioPCM  = 0x02'));
    assert.ok(packetProto.includes('case orientationChange = 0x03'));
  });

  test('verifies Broadcast Upload Extension uses autoreleasepool, TASK_VM_INFO memory check, and non-blocking Unix socket', () => {
    const sampleHandler = fs.readFileSync(
      path.join(repoRoot, 'ios-sender', 'BroadcastExtension', 'SampleHandler.swift'),
      'utf8'
    );
    assert.ok(sampleHandler.includes('RPBroadcastSampleHandler'));
    assert.ok(sampleHandler.includes('autoreleasepool'));
    assert.ok(sampleHandler.includes('TASK_VM_INFO'));
    assert.ok(sampleHandler.includes('phys_footprint < AppGroupConfig.maxExtensionMemoryBytes'));
    assert.ok(sampleHandler.includes('RPVideoSampleOrientationKey'));

    const socketClient = fs.readFileSync(
      path.join(repoRoot, 'ios-sender', 'BroadcastExtension', 'FrameSocketClient.swift'),
      'utf8'
    );
    assert.ok(socketClient.includes('AF_UNIX'));
    assert.ok(socketClient.includes('O_NONBLOCK'));
    assert.ok(socketClient.includes('Darwin.writev'));
  });

  test('verifies Main App uses VideoToolbox Hardware H.264 (Zero B-frames) and Background Audio Keep-Alive', () => {
    const encoder = fs.readFileSync(
      path.join(repoRoot, 'ios-sender', 'WirelessGameMirrorApp', 'HardwareH264Encoder.swift'),
      'utf8'
    );
    assert.ok(encoder.includes('VTCompressionSessionCreate'));
    assert.ok(encoder.includes('kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue'));
    assert.ok(encoder.includes('kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse'));
    assert.ok(encoder.includes('kVTCompressionPropertyKey_AverageBitRate'));
    assert.ok(encoder.includes('kVTEncodeFrameOptionKey_ForceKeyFrame'));

    const keepAlive = fs.readFileSync(
      path.join(repoRoot, 'ios-sender', 'WirelessGameMirrorApp', 'BackgroundKeepAlive.swift'),
      'utf8'
    );
    assert.ok(keepAlive.includes('AVAudioSession'));
    assert.ok(keepAlive.includes('.mixWithOthers'));

    const webrtcClient = fs.readFileSync(
      path.join(repoRoot, 'ios-sender', 'WirelessGameMirrorApp', 'WebRTCClient.swift'),
      'utf8'
    );
    assert.ok(webrtcClient.includes('RTCPeerConnectionDelegate'));
    assert.ok(webrtcClient.includes('RTCDataChannelDelegate'));
    assert.ok(webrtcClient.includes('didGenerate candidate: RTCIceCandidate'));
    assert.ok(webrtcClient.includes('markRemoteDescriptionReadyAndFlushCandidates'));
    assert.ok(webrtcClient.includes('signalingDidDetectViewerLeft'));

    const socketServer = fs.readFileSync(
      path.join(repoRoot, 'ios-sender', 'WirelessGameMirrorApp', 'FrameSocketServer.swift'),
      'utf8'
    );
    assert.ok(socketServer.includes('readPlane('));
    assert.ok(socketServer.includes('CVPixelBufferGetBytesPerRowOfPlane'));
  });

  test('verifies XcodeGen project.yml (2 App IDs for Free Apple ID limit) and GitHub Actions macOS Sideload workflow', () => {
    const projectYml = fs.readFileSync(path.join(repoRoot, 'ios-sender', 'project.yml'), 'utf8');
    assert.ok(projectYml.includes('WirelessGameMirrorApp:'));
    assert.ok(projectYml.includes('BroadcastExtension:'));
    assert.ok(projectYml.includes('com.wirelessgamemirror.app'));
    assert.ok(projectYml.includes('com.wirelessgamemirror.app.BroadcastExtension'));

    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'ios-sideload-build.yml'),
      'utf8'
    );
    assert.ok(workflow.includes('macos-latest'));
    assert.ok(workflow.includes('xcodegen generate'));
    assert.ok(workflow.includes('WirelessGameMirror-Sideload.ipa'));
  });
});

describe('5. Android Sender (Foreground Service + MediaProjection + AudioPlaybackCapture Fallback + MediaCodec Low-Latency) Verification', () => {
  test('verifies AndroidManifest permissions and mediaProjection Foreground Service declaration', () => {
    const manifest = fs.readFileSync(
      path.join(repoRoot, 'android-sender', 'app', 'src', 'main', 'AndroidManifest.xml'),
      'utf8'
    );
    assert.ok(manifest.includes('android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION'));
    assert.ok(manifest.includes('android.permission.RECORD_AUDIO'));
    assert.ok(manifest.includes('android:foregroundServiceType="mediaProjection"'));
    assert.ok(manifest.includes('android:scheme="gamemirror"'));
  });

  test('verifies ScreenCaptureService implements AudioPlaybackCapture with Video-Only Fallback & Dynamic Orientation', () => {
    const service = fs.readFileSync(
      path.join(
        repoRoot,
        'android-sender',
        'app',
        'src',
        'main',
        'java',
        'com',
        'wirelessgamemirror',
        'sender',
        'ScreenCaptureService.kt'
      ),
      'utf8'
    );
    assert.ok(service.includes('AudioPlaybackCaptureConfiguration.Builder'));
    assert.ok(service.includes('AudioAttributes.USAGE_GAME'));
    assert.ok(service.includes('notifyAudioCaptureBlocked'));
    assert.ok(service.includes('onConfigurationChanged'));
    assert.ok(service.includes('sendOrientationChange'));
    assert.ok(service.includes('mediaProjection = projection'));
    assert.ok(service.includes('onViewerLeft'));

    const webrtcMgr = fs.readFileSync(
      path.join(
        repoRoot,
        'android-sender',
        'app',
        'src',
        'main',
        'java',
        'com',
        'wirelessgamemirror',
        'sender',
        'WebRTCManager.kt'
      ),
      'utf8'
    );
    // Ensure single MediaProjection instance is shared (no duplicate ScreenCapturerAndroid getMediaProjection call)
    assert.equal(webrtcMgr.includes('ScreenCapturerAndroid'), false);
    assert.ok(webrtcMgr.includes('mediaProjection.createVirtualDisplay'));
    assert.ok(webrtcMgr.includes('pendingIceCandidates'));
    assert.ok(webrtcMgr.includes('handleViewerLeft'));
  });

  test('verifies Android HardwareH264Encoder uses MediaCodec Low-Latency & Zero B-Frames', () => {
    const encoder = fs.readFileSync(
      path.join(
        repoRoot,
        'android-sender',
        'app',
        'src',
        'main',
        'java',
        'com',
        'wirelessgamemirror',
        'sender',
        'HardwareH264Encoder.kt'
      ),
      'utf8'
    );
    assert.ok(encoder.includes('MediaFormat.MIMETYPE_VIDEO_AVC'));
    assert.ok(encoder.includes('MediaFormat.KEY_MAX_B_FRAMES, 0'));
    assert.ok(encoder.includes('MediaFormat.KEY_LOW_LATENCY, 1'));
    assert.ok(encoder.includes('MediaCodec.PARAMETER_KEY_VIDEO_BITRATE'));
    assert.ok(encoder.includes('MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME'));
  });
});

describe('6. Global Thai Review Documents Rule Verification', () => {
  test('verifies C:\\Users\\tfkr7\\.gemini\\config\\rules\\thai-review-documents.md is created and accurate', () => {
    const rulePath = 'C:\\Users\\tfkr7\\.gemini\\config\\rules\\thai-review-documents.md';
    assert.ok(fs.existsSync(rulePath));
    const content = fs.readFileSync(rulePath, 'utf8');
    assert.ok(content.includes('# Thai Review & Design Documents Rule'));
    assert.ok(content.includes('Always write review documents, design specs, audit summaries, and proposal artifacts in **Thai**'));
  });
});
