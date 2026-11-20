# Design: Wireless Game Mirror (iOS & Android to PC)

## 1. Intent & Why
สตรีมเมอร์เกมมือถือต้องการนำภาพหน้าจอและเสียงเกมจากมือถือ (iOS และ Android) ขึ้น PC แบบไร้สายด้วยความหน่วงต่ำใกล้เคียงเรียลไทม์ เพื่อส่งเข้า OBS สำหรับไลฟ์สตรีมหรือบันทึกวิดีโอ โดยไม่ต้องต่อสาย HDMI/Capture Card

## 2. Goals, Non-Goals, Anti-Goals
### Goals
- ส่งภาพหน้าจอมือถือ (สูงสุด 1080p 60fps) และเสียงภายในเกมขึ้น PC แบบไร้สายผ่านวง LAN เดียวกัน
- Latency เป้าหมาย 40–80ms บน Wi-Fi 5GHz/6GHz (และรองรับการใช้งานผ่าน USB Tethering โดยอัตโนมัติในฐานะ network interface เดียวกัน)
- นำเข้า OBS ได้ทันทีผ่าน OBS Browser Source (ภาพ+เสียงพร้อมใช้งาน)
- เชื่อมต่อสะดวกผ่าน QR Code หรือ mDNS discovery บน LAN ไม่ต้องตั้งค่า IP เองทุกครั้ง
- รองรับทั้ง iOS และ Android ด้วยโปรโตคอลรับส่งเดียวกันฝั่ง PC

### Non-Goals (MVP)
- ไม่รองรับการสตรีมข้ามอินเทอร์เน็ต (Remote WAN / Relay Server) ในเวอร์ชันแรก
- ไม่รองรับการควบคุมมือถือจาก PC (Touch injection / Mouse-to-Touch)
- ไม่ทำระบบบัญชีผู้ใช้หรือ Cloud Backend

### Anti-Goals
- **ไม่กิน RAM เกิน 50MB ใน iOS Broadcast Extension** (เพราะ iOS จะ kill extension ทันทีขณะเล่นเกม)
- **ไม่ทำให้เฟรมเรตเกมบนมือถือตก** จากการใช้ software encoding (ต้องใช้ hardware encoder เสมอ)
- **ไม่เกิด A/V drift** (ภาพและเสียงต้องซิงค์กันตลอดการสตรีมยาวหลายชั่วโมง)

## 3. Constraints
- **iOS `ReplayKit` & Free Apple ID**: Broadcast Upload Extension มีเพดาน RAM 50MB และใช้ Free Apple ID สำหรับ sideload (ต้อง re-sign ทุก 7 วัน, จำกัด 3 App IDs ซึ่ง Main App + Extension ใช้พอดี 2 IDs) จึงใช้ Background Audio/VoIP keep-alive ได้โดยไม่ติดข้อจำกัด App Store Review แต่ต้อง build ผ่าน macOS/Xcode หรือเครื่องมือ sideload
- **Android**: ต้องใช้ `MediaProjection` + `AudioPlaybackCapture` (รองรับ Android 10 ขึ้นไป สำหรับแอปเกมที่อนุญาตให้จับเสียงภายใน หากเกมบล็อกเสียง ให้ส่งเฉพาะภาพพร้อมแจ้งเตือนบนหน้าจอ)
- **Network**: ทำงานใน Local LAN (Wi-Fi 5GHz/6GHz แนะนำ) โดยไม่ต้องพึ่งอินเทอร์เน็ต (ใช้ Host ICE candidates บน LAN ตรง)

## 4. Approaches Considered
1. **Native Capture + WebRTC LAN Direct (Chosen)**
   - iOS/Android จับภาพ+เสียงด้วย Native API และส่งผ่าน WebRTC เข้า PC Receiver
   - *ข้อดี*: Latency ต่ำ (40–80ms), A/V sync ในตัว, ทน packet loss บน Wi-Fi ได้ดี, ส่งเข้า OBS Browser Source ได้โดยตรง
   - *ข้อแลกเปลี่ยน*: ต้องพัฒนา Native Sender แยก 2 แพลตฟอร์ม และต้องแยก process บน iOS เพื่อเลี่ยงเพดาน RAM 50MB
2. **Native Capture + SRT Low-Latency Stream**
   - ส่ง H.264 + Opus ผ่าน SRT เข้า PC/OBS
   - *ข้อดี*: ฝั่ง iOS เบากว่า WebRTC เล็กน้อย ไม่ต้องมี signaling
   - *ข้อแลกเปลี่ยน*: ต้องจูน jitter buffer และจัดการ A/V sync เองเมื่อ Wi-Fi แกว่ง
3. **PC-Only Multi-Protocol Receiver (AirPlay + ADB)**
   - PC จำลองตัวรับ AirPlay (iOS) และ ADB Wireless (Android)
   - *ข้อดี*: ไม่ต้องสร้างแอปมือถือ
   - *ข้อแลกเปลี่ยน*: Latency ฝั่ง AirPlay สูงกว่า (~100–150ms) และคุม bitrate/FPS หรือ audio routing ได้จำกัด

## 5. Architecture & Core Design
ระบบแบ่งเป็น 3 ส่วนหลัก:

### 5.1 PC Receiver & Local Signaling Server (Windows)
- **Single-Device Session**: รองรับการเชื่อมต่อมือถือ **ทีละ 1 เครื่อง** (เครื่องใหม่ต่อเข้ามาจะแทนที่ session เดิมหรือแจ้งเตือนให้ตัดการเชื่อมต่อก่อน)
- **Local Signaling + Discovery & Auth**:
  - เปิด WebSocket server บน LAN สำหรับแลกเปลี่ยน WebRTC SDP / ICE candidates
  - ประกาศบริการผ่าน mDNS (`_gamestream._tcp.local`) และสร้าง QR Code บนหน้าจอ PC (บรรจุ LAN IP + Port + Session Token)
  - การเชื่อมต่อผ่าน QR Code อนุมัติอัตโนมัติด้วย Session Token; การเชื่อมต่อผ่าน mDNS จะขึ้น popup **Allow / Deny** บน PC เพื่อยืนยันสิทธิ์ครั้งแรก
- **WebRTC Receiver & OBS Output**:
  - เปิด local HTTP endpoint (`http://127.0.0.1:<port>/obs`) สำหรับเพิ่มเป็น **OBS Browser Source** (แสดงภาพเต็มเฟรมพื้นหลังโปร่งใส + ส่งเสียงเข้า OBS Audio Mixer ตรง)
  - หน้าจอควบคุมบน PC แสดง Preview, สถานะ FPS / Bitrate / Latency / Packet Loss และปุ่มปรับ Bitrate หรือ FPS แบบเรียลไทม์ผ่าน WebRTC DataChannel

### 5.2 iOS Sender (Swift)
- **Split-Process Architecture (เลี่ยงเพดาน RAM 50MB)**:
  - **Broadcast Upload Extension (`RPBroadcastSampleHandler`)**: รับ `CMSampleBuffer` (Video + App Audio) จากเกม แล้วส่งต่อแบบ zero-copy / lightweight frame buffer ผ่าน local Unix Domain Socket / App Group ไปยัง Main App
  - **Main App (Background Audio/VoIP keep-alive + WebRTC)**: รับเฟรมจาก Extension, ใช้ `VideoToolbox` encode H.264 hardware และส่งออกผ่าน WebRTC Client พร้อมส่ง Telemetry (แบต/อุณหภูมิ/FPS) ผ่าน DataChannel
- **QR / mDNS Client**: สแกน QR Code หรือเลือกเครื่อง PC ที่พบบน LAN แล้วกด Start Broadcast

### 5.3 Android Sender (Kotlin)
- **Capture Service (Foreground Service)**:
  - ใช้ `MediaProjection` จับภาพหน้าจอ + `AudioPlaybackCapture` จับเสียงเกมภายใน
  - Encode ภาพด้วย `MediaCodec` (Hardware H.264, Low-Latency profile / Zero B-frames)
- **WebRTC Client**: ส่ง Video + Game Audio Track และรับคำสั่งปรับ Bitrate/FPS ผ่าน DataChannel
- **QR / mDNS Client**: สแกน QR Code หรือเลือกเครื่อง PC ที่พบบน LAN

### 5.4 Media & Transport Spec (MVP)
- **Video**: H.264 (Baseline/Main profile, Zero B-frames เพื่อลด latency), Target 1080p60 (ปรับลดเป็น 720p60 หรือ 4–15 Mbps ได้จาก PC)
- **Dynamic Orientation**: รองรับการหมุนจอ **แนวตั้ง ↔ แนวนอน** แบบไดนามิก (`1080x1920` ↔ `1920x1080`) โดยปรับขนาด frame/WebRTC track อัตโนมัติบน OBS Browser Source พื้นหลังโปร่งใสโดยไม่ทำให้ภาพค้าง
- **Audio**: Opus 48kHz Stereo (Game Audio track เป็นค่าเริ่มต้น; ช่องแยก Mic เป็นส่วนเสริมหลัง MVP)
- **Signaling**: WebSocket over LAN (JSON SDP offer/answer + ICE candidates, ไม่ใช้ STUN/TURN ภายนอกเมื่ออยู่ใน LAN)

## 6. Left to the Builder
- การเลือก Tech Stack ฝั่ง PC Receiver (เช่น Tauri/Electron + WebView2 หรือ Go/Rust backend + Web UI)
- การเลือก WebRTC library binding ฝั่ง iOS/Android (เช่น `WebRTC-SDK` / `libwebrtc`) และรายละเอียด IPC ระหว่าง iOS ReplayKit Extension กับ Main App
- รูปแบบ UI และ CI workflow สำหรับ build `.ipa` (หากยังไม่มีเครื่อง Mac ในการพัฒนา)
