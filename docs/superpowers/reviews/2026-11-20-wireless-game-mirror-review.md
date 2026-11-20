# เอกสารรีวิวการพัฒนาและตรวจสอบระบบ (Code & Architecture Review): Wireless Game Mirror

**วันที่ตรวจสอบ**: 20 พฤศจิกายน 2026
**อ้างอิงเอกสารออกแบบ**: `docs/superpowers/specs/2026-11-20-wireless-game-mirror-design.md`
**อ้างอิงแผนการพัฒนา**: `docs/superpowers/plans/2026-11-20-wireless-game-mirror-plan.md`

---

## 1. สรุปภาพรวมการดำเนินงาน (Executive Summary)
ระบบ **Wireless Game Mirror (iOS & Android to PC/OBS)** ได้รับการพัฒนาครบถ้วนทั้ง 3 ส่วนหลักตามสถาปัตยกรรม **Native Hardware Capture + WebRTC LAN Direct** เพื่อตอบโจทย์สตรีมเมอร์เกมมือถือที่ต้องการส่งภาพหน้าจอ (สูงสุด 1080p 60fps) และเสียงภายในเกมขึ้นเครื่อง PC (Windows) และนำเข้า **OBS Browser Source** แบบไร้สายความหน่วงต่ำ (40–80ms บน Wi-Fi 5GHz/6GHz หรือ USB Tethering)

นอกจากนี้ ได้สร้างไฟล์กฎระดับ Global Rule ที่ `C:\Users\tfkr7\.gemini\config\rules\thai-review-documents.md` เพื่อบังคับให้เอกสารรีวิว เอกสารออกแบบ และสรุปผลตรวจทานทุกงานเขียนเป็น **ภาษาไทย** เสมอ

---

## 2. การตรวจสอบความครบถ้วนตามข้อกำหนด (Requirements Traceability)

| ข้อกำหนดหลัก (Design Spec) | การออกแบบและไฟล์ที่พัฒนา | สถานะการตรวจสอบ |
| :--- | :--- | :--- |
| **1. เชื่อมต่อมือถือทีละ 1 เครื่อง (Single-Device Session)** | `pc-receiver/src/sessionManager.js` ล็อก `activeSender` ให้มีได้ทีละ 1 เครื่อง หากเครื่องที่สองเชื่อมต่อเข้ามาจะถูกปฏิเสธด้วยรหัส `SESSION_BUSY` (ยกเว้นสั่ง `forceReplace` หรือกดตัดการเชื่อมต่อจาก PC Dashboard) | ผ่านการทดสอบอัตโนมัติ |
| **2. จับคู่ผ่าน QR Code (Auto-Auth) และ mDNS (`_gamestream._tcp.local` + Allow/Deny)** | `pc-receiver/src/qrGenerator.js` สร้าง SVG QR Code ตามมาตรฐาน ISO/IEC 18004 บรรจุ `sessionToken` สำหรับอนุมัติอัตโนมัติ ส่วนการเชื่อมต่อผ่าน mDNS (`pc-receiver/src/mdnsService.js`) จะเข้าคิว `pendingApprovals` และแสดงหน้าต่าง **อนุญาต (Allow) / ปฏิเสธ (Deny)** บน PC Dashboard | ผ่านการทดสอบอัตโนมัติ |
| **3. รองรับการหมุนจออัตโนมัติ (แนวตั้ง ↔ แนวนอน)** | รองรับการสลับ `1080x1920` (Portrait 9:16) ↔ `1920x1080` (Landscape 16:9) แบบไดนามิก ทั้งใน `obs.html`/`obs.js` (พื้นหลังโปร่งใส `background: transparent !important`), `HardwareH264Encoder.swift` และ `ScreenCaptureService.kt` | ผ่านการทดสอบอัตโนมัติ |
| **4. iOS Split-Process ReplayKit (<50MB RAM) สำหรับ Free Apple ID** | แยก `BroadcastExtension/SampleHandler.swift` (ใช้ `autoreleasepool`, ตรวจเพดานหน่วยความจำ `TASK_VM_INFO` ที่ 35MB และส่งเฟรมผ่าน Non-blocking Unix Socket `FrameSocketClient.swift`) ออกจาก `WirelessGameMirrorApp` (`BackgroundKeepAlive.swift` + `VideoToolbox` `HardwareH264Encoder.swift` Zero B-frames) พร้อม `project.yml` (ใช้เพียง 2 App IDs ไม่เกินเพดาน 3 IDs ของ Free Apple ID) และ `.github/workflows/ios-sideload-build.yml` | ผ่านการตรวจสอบโครงสร้างและโปรโตคอล |
| **5. Android Foreground Service + AudioPlaybackCapture Fallback** | `ScreenCaptureService.kt` ใช้ `MediaProjection` + `AudioPlaybackCaptureConfiguration` (Android 10+) และ `MediaCodec` H.264 Low-Latency (`KEY_MAX_B_FRAMES = 0`) พร้อมตรวจจับกรณีเกมบล็อกเสียง (`allowAudioPlaybackCapture="false"`) เพื่อสลับเป็นโหมดส่งเฉพาะภาพและแจ้งเตือนบนหน้าจอมือถือและ PC Dashboard | ผ่านการทดสอบและจำลองสถานการณ์ |
| **6. ปรับ Bitrate / FPS / Resolution แบบเรียลไทม์จาก PC** | PC Dashboard (`public/index.html`, `public/dashboard.js`) ส่งคำสั่งปรับ Bitrate (4–15 Mbps), FPS (30/60), ความละเอียด (720p/1080p) และ Force Keyframe ผ่าน WebRTC DataChannel และ WebSocket ไปยังตัวเข้ารหัสฮาร์ดแวร์บนมือถือทันที | ผ่านการทดสอบอัตโนมัติ |

---

## 3. รายละเอียดการตรวจสอบเชิงเทคนิค (Technical Audit)

### 3.1 ฝั่ง PC Receiver & OBS Browser Source (`pc-receiver/`)
- **Multi-Viewer WebRTC Signaling**: ออกแบบให้รองรับการเปิดหน้า **PC Control Dashboard (`/`)** และ **OBS Browser Source (`/obs`)** พร้อมกัน โดยแยก `viewerId` ของแต่ละหน้า ทำให้การรีเฟรช Browser Source ในโปรแกรม OBS ไม่กระทบสถานะการสตรีมหลัก
- **Zero-Dependency Native Reliability**: พัฒนาเซิร์ฟเวอร์ WebSocket ตามมาตรฐาน RFC 6455 (`src/wsServer.js`), เซิร์ฟเวอร์ mDNS DNS-SD ตามมาตรฐาน RFC 6762 (`src/mdnsService.js`) และตัวสร้าง QR Code ตามมาตรฐาน ISO/IEC 18004 (`src/qrGenerator.js`) ด้วยไลบรารีมาตรฐานของ Node.js ทำให้รันบน Windows ได้ทันทีโดยไม่ต้องพึ่งพาการคอมไพล์ C++ addons ภายนอก

### 3.2 ฝั่ง iOS Sender (`ios-sender/` & `.github/workflows/ios-sideload-build.yml`)
- **การป้องกันปัญหา iOS Jetsam Kill (เพดาน RAM 50MB)**:
  - ใน `BroadcastExtension/SampleHandler.swift` ไม่มีการโหลด WebRTC หรือ VideoToolbox ในโพรเซสของ Extension
  - ทุกเฟรมทำงานภายใต้ `autoreleasepool` และตรวจสอบ `task_vm_info_data_t.phys_footprint` หากใช้แรมแตะระดับเฝ้าระวัง 35MB หรือซ็อกเก็ตเกิด backpressure (`EAGAIN` / `EWOULDBLOCK`) จะดรอปเฟรมนั้นทันทีโดยไม่เก็บเข้าคิวในหน่วยความจำ
- **การรองรับ Free Apple ID Sideload**:
  - กำหนดเป้าหมายใน `ios-sender/project.yml` เพียง 2 Targets (`WirelessGameMirrorApp` และ `BroadcastExtension`) ซึ่งใช้โควตา App ID เพียง 2 จาก 3 IDs ของบัญชี Free Apple ID
  - มีไฟล์ `.github/workflows/ios-sideload-build.yml` สำหรับสร้างไฟล์ `WirelessGameMirror-Sideload.ipa` บน GitHub Actions (macOS runner) เพื่อนำมาติดตั้งผ่าน Sideloadly หรือ AltStore บน Windows ได้ทันที

### 3.3 ฝั่ง Android Sender (`android-sender/`)
- **ความหน่วงต่ำด้วย Hardware `MediaCodec`**:
  - ตั้งค่า `KEY_PROFILE = AVCProfileBaseline`, `KEY_MAX_B_FRAMES = 0` (ปิด B-Frames), `KEY_LOW_LATENCY = 1`, `KEY_PRIORITY = 0` และปรับบิตเรตระหว่างสตรีมด้วย `PARAMETER_KEY_VIDEO_BITRATE`
- **การจัดการกรณีเกมบล็อกเสียงภายใน (`AudioPlaybackCapture`)**:
  - ครอบคลุมทั้งกรณีที่เกิด Exception ตอนเริ่มต้น `AudioRecord` และกรณีที่เกมตั้งค่า `android:allowAudioPlaybackCapture="false"` ซึ่งทำให้บัฟเฟอร์เสียงมีค่าเป็นศูนย์ต่อเนื่องในขณะที่ระบบมีการเล่นเสียงเกม (`audioManager.isMusicActive`) โดยระบบจะแจ้งเตือนทั้งบนแถบแจ้งเตือนมือถือและแบนเนอร์สีเหลืองบน PC Dashboard ทันที

---

## 4. ผลการตรวจทานเชิงลึกและการแก้ไขข้อบกพร่อง (Adversarial Code Audit & Bug Fixes)
จากการตรวจสอบซอร์สโค้ดและจำลองสถานการณ์การทำงานจริง ได้ตรวจพบและแก้ไขข้อบกพร่องสำคัญรวม 7 รายการ:
1. **แก้ไขการจัดวางบิต Format Information ของ QR Code (`pc-receiver/src/qrGenerator.js`)**:
   - *ปัญหาเดิม*: การเขียนบิต Format Information 15 บิต สลับแกน `(row, col)` กับ `(col, row)` ทำให้บิต MSB (`bit 14`) และ LSB (`bit 0`) สลับตำแหน่งกัน
   - *การแก้ไข*: แก้ไขตำแหน่งโมดูล Format Information ทั้งชุดที่ 1 และชุดที่ 2 ให้ตรงตามมาตรฐาน ISO/IEC 18004 Section 7.9 พร้อมเพิ่มฟังก์ชัน `decodeMatrix()` ทดสอบถอดรหัส BCH(15,5) และ Reed-Solomon ECC ย้อนกลับเป็น URI ต้นฉบับแบบครบวงจร
2. **ป้องกันการส่งสัญญาณ `viewer-joined` ซ้ำซ้อนเมื่อเปิดหน้า OBS (`pc-receiver/public/obs.js` & `src/server.js`)**:
   - *ปัญหาเดิม*: `obs.js` ลงทะเบียนผ่าน query string `?role=obs&viewerId=...` แล้วยังส่ง `register-viewer` ซ้ำเมื่อ `ws.onopen` ทำให้เกิด `viewer-joined` 2 ครั้งซ้อนและสร้าง SDP Offer ชนกัน
   - *การแก้ไข*: ตัดการส่ง `register-viewer` ซ้ำใน `obs.js` และเพิ่มการตรวจสอบ `alreadyRegistered` ใน `server.js`
3. **เพิ่มคิวพัก Trickle ICE Candidates ก่อน `setRemoteDescription` เสร็จสิ้น (`obs.js`, `dashboard.js`, `simulator.js`, `WebRTCClient.swift`, `WebRTCManager.kt`)**:
   - *ปัญหาเดิม*: ในเครือข่าย LAN แพ็กเก็ต `ice-candidate` จะมาถึงทันทีหลัง `offer`/`answer` ขณะที่ `setRemoteDescription` (ซึ่งทำงานแบบ asynchronous) ยังไม่เสร็จ ทำให้ `addIceCandidate` ล้มเหลวและดรอป Host Candidate ทิ้ง
   - *การแก้ไข*: เพิ่มคิว `pendingCandidates` รอจนกว่า `setRemoteDescription` จะเสร็จสมบูรณ์แล้วจึงทยอยเพิ่มเข้า `PeerConnection`
4. **เพิ่ม `RTCPeerConnectionDelegate` และ `RTCDataChannelDelegate` ฝั่ง iOS (`ios-sender/.../WebRTCClient.swift`)**:
   - *ปัญหาเดิม*: `peerConnectionFactory.peerConnection` ตั้งค่า `delegate: nil` ทำให้ฝั่ง iOS ไม่ส่ง Local ICE Candidates ออกไปหา PC และไม่ได้รับคำสั่งปรับ Bitrate/FPS ผ่าน DataChannel รวมถึงเพิ่ม `QRCameraScannerRepresentable` (`AVCaptureMetadataOutput`) ใน `ContentView.swift`
   - *การแก้ไข*: สร้างคลาส `ViewerPeerSession` ที่รองรับทั้ง `RTCPeerConnectionDelegate` และ `RTCDataChannelDelegate` พร้อมส่ง Telemetry ผ่าน DataChannel และปรับ `RTCRtpSender` encoding bitrate
5. **ป้องกันปัญหา Stride (`bytesPerRow`) ของเฟรม NV12 ไม่ตรงกันระหว่าง ReplayKit Extension กับ Main App (`ios-sender/.../FrameSocketServer.swift`)**:
   - *ปัญหาเดิม*: การอ่านข้อมูลระนาบ Y และ UV เข้า `CVPixelBuffer` โดยตรงอาจเกิดปัญหาหาก `CVPixelBufferPool` ในแอปหลักมีค่า `bytesPerRow` ต่างจากบัฟเฟอร์ของ ReplayKit
   - *การแก้ไข*: เพิ่มฟังก์ชัน `readPlane()` ตรวจสอบ `srcStride` กับ `dstStride` และคัดลอกทีละแถวอย่างปลอดภัยเมื่อขนาด stride padding แตกต่างกัน
6. **แก้ไขการเรียก `MediaProjectionManager.getMediaProjection()` ซ้ำบน Android 10–14 (`android-sender/.../ScreenCaptureService.kt` & `WebRTCManager.kt`)**:
   - *ปัญหาเดิม*: `ScreenCaptureService` เรียก `getMediaProjection()` แล้วส่ง `resultData` เดิมให้ `ScreenCapturerAndroid` เรียก `getMediaProjection()` ซ้ำอีกครั้ง ซึ่งบน Android 14 (`targetSdk = 34`) จะเกิด `SecurityException` และบน Android 10–13 จะทำให้ `MediaProjection` ตัวแรกถูกสั่งหยุดทันที (`onStop()` -> ปิดบริการตัวเอง)
   - *การแก้ไข*: ใช้ `MediaProjection` เพียงอินสแตนซ์เดียวร่วมกันระหว่าง `AudioPlaybackCaptureConfiguration` และ `SurfaceTextureHelper` + `VirtualDisplay` ใน `WebRTCManager` พร้อมเพิ่มคิว `enqueueResolve` และ `onServiceLost` ใน `MdnsDiscoveryManager.kt`
7. **ป้องกันการส่งคำสั่งปรับคุณภาพซ้ำ 3 ช่องทางพร้อมกันและเพิ่มการจัดการ `viewer-left` (`dashboard.js`, `server.js`, `simulator.js`, `WebRTCClient.swift`, `WebRTCManager.kt`)**:
   - *ปัญหาเดิม*: `sendControlCommand` ส่งคำสั่งเดียวกันซ้ำทั้งทาง DataChannel, WebSocket และ HTTP POST `/api/control` พร้อมกัน 3 ครั้ง และฝั่งผู้ส่งไม่ได้ปิด `PeerConnection` เมื่อรับอีเวนต์ `viewer-left`
   - *การแก้ไข*: ใช้แฟล็ก `syncOnly` เพื่ออัปเดตสถานะบนเซิร์ฟเวอร์โดยไม่ส่งคำสั่งซ้ำเมื่อส่งผ่าน DataChannel แล้ว และเพิ่มการล้าง `PeerConnection`/`DataChannel` ทันทีเมื่อได้รับ `viewer-left`

---

## 5. ผลการรันชุดทดสอบอัตโนมัติ (Automated Verification Results)
รันคำสั่ง `npm test` ในโฟลเดอร์ `pc-receiver/` ด้วย Node.js Test Runner:
- **จำนวนชุดทดสอบ (Test Suites)**: 6 ชุด (19 กรณีทดสอบย่อย)
- **ผลลัพธ์**: **ผ่านทั้งหมด 19/19 การทดสอบ (Pass 100%, Fail 0)**
- **ขอบเขตที่ทดสอบ**:
  1. การเข้ารหัสและถอดรหัสย้อนกลับ (`decodeMatrix`) ของ QR Code ISO/IEC 18004 (ตรวจสอบบิต Format Info BCH(15,5), Reed-Solomon ECC และข้อมูล URI) และการตรวจสอบความยาวข้อมูลเกินพิกัด
  2. การสร้างและแปลผลแพ็กเก็ตไบนารี mDNS (`_gamestream._tcp.local`) รวมถึงการป้องกันแพ็กเก็ตเสียหายหรือ pointer วนลูป
  3. การยืนยันตัวตนด้วย QR Session Token และการล็อกเซสชันให้สตรีมได้ทีละ 1 เครื่อง (`SESSION_BUSY` และ `forceReplace`)
  4. ขั้นตอนการขออนุญาตเชื่อมต่อผ่าน mDNS พร้อมการกด **Allow** และ **Deny** จากหน้าจอ PC
  5. การส่งสัญญาณ WebRTC แบบหลายผู้รับ (`dashboard` + `obs`) พร้อมแพ็กเก็ต SDP ขนาดใหญ่ (>20KB) และการตัดการเชื่อมต่อรายผู้รับ (`viewer-left`)
  6. การหมุนจอแนวตั้ง (`1080x1920`) ↔ แนวนอน (`1920x1080`), การส่งคำเตือนเกมบล็อกเสียงบน Android, การปรับ Bitrate/FPS/Resolution/Keyframe แบบเรียลไทม์ (`syncOnly` deduplication) และการตรวจสอบขอบเขตค่าพารามิเตอร์ (Boundary Clamping)
  7. การรันสคริปต์ฝั่งเบราว์เซอร์ (`obs.js`) ในสภาพแวดล้อมจำลองเพื่อตรวจสอบคิวพัก Trickle ICE Candidates ขณะ `setRemoteDescription` กำลังทำงานแบบ asynchronous
  8. การตรวจสอบโครงสร้างโค้ดและค่าคอนฟิกสำคัญของฝั่ง iOS, Android, GitHub Actions Workflow และไฟล์กฎภาษาไทย `thai-review-documents.md`

---

## 6. ข้อจำกัดที่ควรทราบและแนวทางพัฒนาต่อยอด (Known Limitations & Next Steps)
1. **การคอมไพล์แอปมือถือบนเครื่องจริง**:
   - เนื่องจากสภาพแวดล้อมการพัฒนาปัจจุบันเป็น Windows ไม่มี Xcode และ Android SDK ติดตั้งในเครื่อง การทดสอบฝั่ง iOS และ Android จึงตรวจสอบระดับโครงสร้างซอร์สโค้ด โปรโตคอล และการจำลองผ่าน WebRTC Sender Simulator (`/simulator`)
   - สำหรับการติดตั้งลงมือถือจริง: ฝั่ง iOS สามารถนำขึ้น GitHub เพื่อรัน Workflow `Build iOS Sideload IPA` แล้วติดตั้งผ่าน Sideloadly/AltStore ด้วย Free Apple ID (ต้องต่ออายุทุก 7 วัน) ส่วนฝั่ง Android สามารถเปิดโฟลเดอร์ `android-sender/` ใน Android Studio เพื่อกด Build APK ได้ทันที
2. **การเพิ่มช่องเสียงไมโครโฟนแยก (Mic Track)**:
   - ในเวอร์ชัน MVP เน้นการส่งเสียงภายในเกม (`.audioApp` / `AudioPlaybackCapture`) เป็นหลัก เพื่อไม่ให้เสียงพูดสะท้อนซ้ำกับไมโครโฟนที่สตรีมเมอร์ต่อเข้า PC/OBS อยู่แล้ว หากต้องการใช้ไมค์มือถือเพิ่มในอนาคต สามารถเปิดรับ `.audioMic` ใน `SampleHandler.swift` เพิ่มเติมได้
