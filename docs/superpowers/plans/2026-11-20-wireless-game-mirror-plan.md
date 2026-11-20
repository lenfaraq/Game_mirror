# แผนการพัฒนา (Implementation Plan): Wireless Game Mirror (iOS & Android to PC/OBS)

## 1. ภาพรวมและเป้าหมาย
พัฒนาระบบแชร์ภาพหน้าจอและเสียงเกมจากมือถือ (iOS และ Android) ขึ้นเครื่อง PC (Windows) แบบไร้สายความหน่วงต่ำ (40–80ms) ผ่านเครือข่าย LAN เดียวกัน โดยใช้สถาปัตยกรรม **Native Hardware Capture + WebRTC LAN Direct** ตามเอกสารออกแบบ `docs/superpowers/specs/2026-11-20-wireless-game-mirror-design.md`

### คุณสมบัติหลักตามข้อกำหนดของผู้ใช้
1. **เชื่อมต่อทีละเครื่อง (Single-Device Session)**: ล็อกเซสชันให้มีมือถือสตรีมได้ทีละ 1 เครื่อง ป้องกันสัญญาณชนกัน พร้อมปุ่มตัดการเชื่อมต่อหรือสลับเครื่องจากฝั่ง PC
2. **การค้นหาและยืนยันตัวตน (QR Code Auto-Auth & mDNS Allow/Deny)**:
   - สแกน QR Code บนหน้าจอ PC: ยืนยันตัวตนอัตโนมัติด้วย Session Token แบบใช้เฉพาะเซสชัน
   - ค้นหาอัตโนมัติผ่าน mDNS (`_gamestream._tcp.local`): แสดงหน้าต่าง **Allow / Deny** บน PC Dashboard เพื่ออนุมัติก่อนเริ่มสตรีม
3. **รองรับการหมุนจออัตโนมัติ (Dynamic Orientation)**: สลับแนวตั้ง (`1080x1920`) และแนวนอน (`1920x1080`) แบบเรียลไทม์ ปรับสัดส่วนบน OBS Browser Source พื้นหลังโปร่งใสอัตโนมัติโดยภาพไม่ค้าง
4. **iOS Split-Process ReplayKit (<50MB RAM) สำหรับ Free Apple ID**:
   - Broadcast Upload Extension (`RPBroadcastSampleHandler`) ใช้หน่วยความจำต่ำกว่า 30MB ส่งเฟรมภาพและเสียงผ่าน App Group Unix Domain Socket ไปยัง Main App
   - Main App รัน Background Audio Keep-Alive + `VideoToolbox` Hardware H.264 Encoder (Zero B-frames) + WebRTC Client
   - มีไฟล์โครงสร้าง XcodeGen (`project.yml`) และ GitHub Actions workflow สำหรับ build `.ipa` เพื่อ sideload ด้วย Free Apple ID (AltStore / Sideloadly)
5. **Android Foreground Capture Service + Audio Fallback**:
   - ใช้ `MediaProjection` + `AudioPlaybackCapture` (Android 10+) และ `MediaCodec` Hardware H.264 Low-Latency
   - หากเกมบล็อกการอัดเสียงภายใน (`allowAudioPlaybackCapture="false"`) ระบบจะสลับเป็นโหมดส่งเฉพาะภาพโดยอัตโนมัติพร้อมแจ้งเตือนทั้งบนมือถือและหน้าจอ PC Dashboard
6. **OBS Browser Source (`/obs`) & PC Dashboard (`/`)**:
   - รองรับ Multi-Viewer WebRTC Signaling ให้ทั้งหน้า PC Dashboard Preview และหน้า OBS Browser Source รับสตรีมพร้อมกันหรือรีเฟรชแยกกันได้โดยไม่หลุด
   - ปรับ Bitrate (4–15 Mbps), FPS (30/60), ความละเอียด (720p/1080p) และสั่ง Force Keyframe แบบเรียลไทม์ผ่าน WebRTC DataChannel และ WebSocket

---

## 2. โครงสร้างโปรเจกต์ (Repository Structure)

```text
Phone Projact/
├── docs/
│   └── superpowers/
│       ├── specs/
│       │   └── 2026-11-20-wireless-game-mirror-design.md
│       ├── plans/
│       │   └── 2026-11-20-wireless-game-mirror-plan.md
│       └── reviews/
│           └── 2026-11-20-wireless-game-mirror-review.md
├── pc-receiver/                     # Windows PC Receiver, Signaling Server, mDNS, OBS & Dashboard UI
│   ├── package.json
│   ├── src/
│   │   ├── server.js                # HTTP + WebSocket Signaling + Single-Device Session + Auth Manager
│   │   ├── mdnsService.js           # mDNS (_gamestream._tcp.local) Responder & Advertiser
│   │   ├── sessionManager.js        # Single-Device Lock, QR Token Auth, mDNS Allow/Deny Queue
│   │   └── qrGenerator.js           # Pure SVG QR Code / Connection Payload Generator
│   ├── public/
│   │   ├── index.html               # PC Control Dashboard UI (Preview, QR, Telemetry, Bitrate/FPS Controls, Allow/Deny Modal)
│   │   ├── dashboard.js             # Dashboard WebRTC Receiver, DataChannel Controller & Signaling Logic
│   │   ├── styles.css               # UI Styling สำหรับ Streamer Dashboard
│   │   ├── obs.html                 # OBS Browser Source Endpoint (พื้นหลังโปร่งใส + Dynamic Portrait/Landscape)
│   │   └── obs.js                   # OBS WebRTC Receiver + Dynamic Aspect-Ratio & Auto-Reconnect
│   └── test/
│       ├── server.test.js           # ชุดทดสอบ Automated Tests (Session, Auth, mDNS Allow/Deny, Signaling, Rotation, Controls)
│       └── mobile-Senders.test.js   # ชุดทดสอบตรวจสอบโครงสร้างโค้ด iOS/Android, IPC Protocol และ CI Workflow
├── ios-sender/                      # iOS Native App (Swift) - Split-Process Architecture
│   ├── project.yml                  # XcodeGen Configuration (Main App + BroadcastExtension, 2 App IDs สำหรับ Free Apple ID)
│   ├── Shared/
│   │   ├── AppGroupConfig.swift     # ค่าคงที่ App Group ID, Socket Path และคอนฟิกเริ่มต้น
│   │   └── FramePacketProtocol.swift# โปรโตคอล Binary Packet (WGMP) สำหรับส่ง Video/Audio/Orientation ผ่าน Unix Socket
│   ├── BroadcastExtension/
│   │   ├── Info.plist
│   │   ├── BroadcastExtension.entitlements
│   │   ├── SampleHandler.swift      # RPBroadcastSampleHandler (<50MB RAM, autoreleasepool, Zero-Queue Backpressure)
│   │   └── FrameSocketClient.swift  # POSIX Unix Domain Socket Client แบบ Non-Blocking
│   └── WirelessGameMirrorApp/
│       ├── Info.plist
│       ├── WirelessGameMirrorApp.entitlements
│       ├── WirelessGameMirrorApp.swift
│       ├── ContentView.swift        # SwiftUI หน้าจอหลัก, QR Scanner, รายชื่อ PC บน mDNS, RPSystemBroadcastPickerView
│       ├── BackgroundKeepAlive.swift# AVAudioSession Silent Audio Loop ป้องกัน iOS พักแอปหลักขณะเล่นเกม
│       ├── FrameSocketServer.swift  # Unix Domain Socket Server รับเฟรมจาก Extension
│       ├── HardwareH264Encoder.swift# VideoToolbox VTCompressionSession (Hardware H.264, Zero B-frames, Dynamic Bitrate/Rotation)
│       ├── DiscoveryManager.swift   # NWBrowser (_gamestream._tcp) & QR Payload Parser
│       ├── SignalingClient.swift    # WebSocket Signaling Client (QR Token & mDNS Allow/Deny)
│       └── WebRTCClient.swift       # WebRTC PeerConnection, Video/Audio Tracks & DataChannel Telemetry/Control
├── android-sender/                  # Android Native App (Kotlin)
│   ├── settings.gradle.kts
│   ├── build.gradle.kts
│   └── app/
│       ├── build.gradle.kts
│       └── src/main/
│           ├── AndroidManifest.xml
│           └── java/com/wirelessgamemirror/sender/
│               ├── MainActivity.kt          # UI หลัก, QR/mDNS Pairing, Permission Launcher, Telemetry & Audio Warning
│               ├── ScreenCaptureService.kt  # Foreground Service (MediaProjection + AudioPlaybackCapture + Fallback)
│               ├── HardwareH264Encoder.kt   # MediaCodec H.264 Low-Latency Hardware Encoder + Dynamic Rotation
│               ├── MdnsDiscoveryManager.kt  # NsdManager (_gamestream._tcp.) Discovery
│               ├── SignalingClient.kt       # WebSocket Signaling Client
│               └── WebRTCManager.kt         # WebRTC PeerConnection + DataChannel Telemetry & Bitrate/FPS Control
├── .github/
│   └── workflows/
│       └── ios-sideload-build.yml   # GitHub Actions macOS Workflow สำหรับสร้างไฟล์ .ipa ไปติดตั้งผ่าน AltStore/Sideloadly
└── README.md                        # คู่มือการติดตั้งและใช้งานฉบับสมบูรณ์ (ภาษาไทย)
```

---

## 3. ลำดับขั้นตอนการดำเนินงาน (Execution Steps)

### ขั้นตอนที่ 1: พัฒนา PC Receiver & Local Signaling Server (`pc-receiver/`)
1. สร้าง `sessionManager.js` จัดการ:
   - Session Token สำหรับ QR Code (สุ่มค่าใหม่ได้ และตรวจสอบสิทธิ์อัตโนมัติ)
   - คิวรออนุมัติ (Pending Approval Queue) สำหรับอุปกรณ์ที่เชื่อมต่อผ่าน mDNS โดยไม่มี token พร้อมส่งอีเวนต์แจ้ง PC Dashboard ให้กด **Allow** หรือ **Deny**
   - กฎ **Single-Device Session**: อนุญาตให้มี `activeSender` ได้เพียง 1 เครื่องในเวลาเดียวกัน หากมีเครื่องที่สองพยายามเชื่อมต่อ จะปฏิเสธพร้อมรหัส `SESSION_BUSY` (เว้นแต่ผู้ใช้สั่ง `forceReplace` หรือตัดการเชื่อมต่อเครื่องเดิมจาก Dashboard)
2. สร้าง `mdnsService.js` ประกาศบริการ `_gamestream._tcp.local` บนระบบเครือข่าย LAN ด้วย UDP multicast DNS พร้อม TXT records บอกชื่อเครื่องและพอร์ต
3. สร้าง `server.js` ให้บริการ:
   - HTTP Endpoints: `/` (Dashboard UI), `/obs` (OBS Browser Source), `/api/status`, `/api/pairing-info` (LAN IPs, Port, QR SVG, Token), `/api/session/approve`, `/api/session/deny`, `/api/session/disconnect`, `/api/session/rotate-token`
   - WebSocket Server (`/ws`): รองรับบทบาท `sender`, `dashboard`, และ `obs` พร้อมส่งต่อ SDP Offer/Answer, ICE Candidates, Orientation Events (`portrait` / `landscape`, `width`, `height`), Telemetry, Audio Status Warning และ Control Commands (`set-bitrate`, `set-fps`, `set-resolution`, `request-keyframe`)
4. สร้างหน้า UI ฝั่ง PC:
   - `public/index.html` & `public/dashboard.js`: แสดงภาพตัวอย่างสตรีมสด, QR Code สำหรับสแกนจับคู่, ป๊อปอัป **Allow / Deny** เมื่อมีมือถือขอเชื่อมต่อผ่าน mDNS, แผง Telemetry (FPS, Bitrate, Latency, Packet Loss, แบตเตอรี่, อุณหภูมิ, สถานะเสียงเกม) และแถบปรับ Bitrate / FPS / Resolution แบบเรียลไทม์
   - `public/obs.html` & `public/obs.js`: พื้นหลังโปร่งใส (`rgba(0,0,0,0)`), ปรับขนาดตามการหมุนจอแนวตั้ง (`1080x1920`) และแนวนอน (`1920x1080`) อัตโนมัติ, ส่งเสียงเข้า OBS Audio Mixer โดยตรง และเชื่อมต่อใหม่อัตโนมัติหากสัญญาณสะดุด

### ขั้นตอนที่ 2: พัฒนา iOS Sender (`ios-sender/` & `.github/workflows/`)
1. สร้างโปรโตคอล IPC (`Shared/FramePacketProtocol.swift` & `Shared/AppGroupConfig.swift`) กำหนดโครงสร้างแพ็กเก็ตไบนารี (`WGMP`) ที่ส่งผ่าน Unix Domain Socket ใน App Group
2. สร้าง Broadcast Upload Extension (`BroadcastExtension/SampleHandler.swift` & `FrameSocketClient.swift`):
   - ดึง `CVPixelBuffer` (NV12) และตัวอย่างเสียง `.audioApp` จาก `CMSampleBuffer` ภายใต้บล็อก `autoreleasepool`
   - ตรวจสอบการหมุนจอจากขนาดบัฟเฟอร์และ `RPVideoSampleOrientationKey`
   - ใช้ Non-blocking Unix Domain Socket หากบัฟเฟอร์เต็มให้ดรอปเฟรมทันทีโดยไม่สะสมในคิว เพื่อรักษาระดับการใช้ RAM ให้ต่ำกว่า 30MB (เพดาน iOS คือ 50MB)
3. สร้าง Main App (`WirelessGameMirrorApp/`):
   - `BackgroundKeepAlive.swift`: เล่นเสียงเงียบผ่าน `AVAudioSession` (`.playback`, `.mixWithOthers`) เพื่อคงสถานะการทำงานเบื้องหลังขณะเล่นเกม
   - `FrameSocketServer.swift`: รับเฟรมภาพและเสียงจาก Extension
   - `HardwareH264Encoder.swift`: เข้ารหัส H.264 ด้วย `VTCompressionSession` (`kVTCompressionPropertyKey_RealTime`, `AllowFrameReordering = false` เพื่อปิด B-frames) รองรับการเปลี่ยน Bitrate และการหมุนจอแบบไดนามิก
   - `WebRTCClient.swift`, `SignalingClient.swift`, `DiscoveryManager.swift`, `ContentView.swift`: ค้นหา PC ผ่าน mDNS หรือสแกน QR Code, ส่งสตรีม WebRTC และรับคำสั่งปรับ Bitrate/FPS จาก PC
4. สร้าง `project.yml` (XcodeGen) และ `.github/workflows/ios-sideload-build.yml` สำหรับคอมไพล์ `.ipa` บน GitHub Actions เพื่อนำไป sideload ด้วย Free Apple ID

### ขั้นตอนที่ 3: พัฒนา Android Sender (`android-sender/`)
1. สร้าง `ScreenCaptureService.kt` (Foreground Service):
   - จับภาพหน้าจอด้วย `MediaProjection` + `VirtualDisplay` และตรวจจับ `onConfigurationChanged` เพื่อปรับขนาด `VirtualDisplay` และตัวเข้ารหัสทันทีเมื่อผู้เล่นหมุนจอแนวตั้ง ↔ แนวนอน
   - จับเสียงเกมภายในด้วย `AudioPlaybackCaptureConfiguration` (Android 10+) พร้อมกลไกตรวจสอบกรณีเกมบล็อกเสียง (ทั้งจาก Exception และตัวตรวจจับสัญญาณเงียบผิดปกติ) เพื่อสลับเข้าโหมดภาพอย่างเดียวและส่งคำเตือน `audio-blocked` ไปยังหน้าจอ PC
2. สร้าง `HardwareH264Encoder.kt`: เข้ารหัสด้วย `MediaCodec` (`video/avc`) โหมดความหน่วงต่ำ (`KEY_LOW_LATENCY`, `KEY_MAX_B_FRAMES = 0`) และปรับ Bitrate แบบเรียลไทม์ด้วย `PARAMETER_KEY_VIDEO_BITRATE`
3. สร้าง `WebRTCManager.kt`, `SignalingClient.kt`, `MdnsDiscoveryManager.kt`, และ `MainActivity.kt`

### ขั้นตอนที่ 4: การทดสอบและเขียนเอกสารรีวิวภาษาไทย
1. เขียนและรันชุดทดสอบอัตโนมัติ (`pc-receiver/test/server.test.js` และ `pc-receiver/test/mobile-senders.test.js`) ครอบคลุมทุกกรณีใช้งานและ Edge Cases
2. สร้างเอกสารรีวิวและสรุปผลการตรวจสอบทั้งหมดเป็น **ภาษาไทย** ที่ `docs/superpowers/reviews/2026-11-20-wireless-game-mirror-review.md` และ `README.md` ตามกฎ `thai-review-documents.md`
