# 🎮 Wireless Game Mirror (iOS & Android ➔ PC / OBS)

ระบบแชร์ภาพหน้าจอและเสียงภายในเกมจากมือถือ (**iOS** และ **Android**) ขึ้นเครื่องคอมพิวเตอร์ (**Windows PC**) แบบไร้สายความหน่วงต่ำใกล้เคียงเรียลไทม์ (**40–80ms**) ผ่านเครือข่าย Wi-Fi 5GHz/6GHz หรือ USB Tethering เดียวกัน เพื่อนำเข้าโปรแกรม **OBS Studio** สำหรับไลฟ์สตรีมหรือบันทึกวิดีโอโดยไม่ต้องใช้การ์ดแคปเจอร์

---

## ✨ คุณสมบัติเด่น (Key Features)

1. **ความหน่วงต่ำระดับสตรีมเกม (40–80ms)**:
   - ใช้ฮาร์ดแวร์เอ็นโค้ดเดอร์ (`VideoToolbox` บน iOS และ `MediaCodec` บน Android) เข้ารหัส H.264 โหมด **Zero B-Frames** ส่งตรงผ่าน **WebRTC LAN Direct** (Host ICE Candidates ในวง LAN ไม่ต้องผ่านอินเทอร์เน็ตภายนอก)
2. **นำเข้า OBS ได้ทันทีพร้อมพื้นหลังโปร่งใส (`/obs`)**:
   - เพิ่มเป็น **OBS Browser Source** ที่ `http://127.0.0.1:8080/obs` ได้ทั้งภาพคมชัดสูงสุด 1080p 60fps และเสียงเกม Opus 48kHz Stereo เข้า OBS Audio Mixer โดยตรง
3. **หมุนจอแนวตั้ง ↔ แนวนอน อัตโนมัติ (Dynamic Orientation)**:
   - สลับระหว่างเกมแนวตั้ง (`1080x1920`) และเกมแนวนอน (`1920x1080`) ได้ทันทีระหว่างสตรีม โดยหน้าต่าง OBS Browser Source จะปรับสัดส่วนให้อัตโนมัติบนพื้นหลังโปร่งใสโดยภาพไม่ค้าง
4. **รองรับการเชื่อมต่อทีละ 1 เครื่อง (Single-Device Session)**:
   - ล็อกเซสชันให้มีมือถือสตรีมได้ทีละเครื่อง ป้องกันสัญญาณชนกันระหว่างไลฟ์
5. **จับคู่สะดวกทั้ง QR Code (Auto-Auth) และ mDNS (`_gamestream._tcp.local`)**:
   - สแกน QR Code บนหน้าจอ PC เพื่อเชื่อมต่อและยืนยันสิทธิ์อัตโนมัติด้วย Session Token
   - หรือเลือกชื่อเครื่อง PC ที่ตรวจพบบน LAN ผ่าน mDNS แล้วกดปุ่ม **อนุญาต (Allow) / ปฏิเสธ (Deny)** บนหน้าจอ PC Dashboard
6. **สถาปัตยกรรม iOS Split-Process (<35MB RAM) รองรับ Free Apple ID**:
   - แยกการทำงานระหว่าง `BroadcastExtension` (จับภาพด้วย `ReplayKit` แล้วส่งผ่าน App Group Unix Domain Socket โดยกินแรมไม่เกิน 35MB ต่ำกว่าเพดาน 50MB ของ iOS) กับแอปหลัก `WirelessGameMirrorApp` (รัน Background Audio Keep-Alive + `VideoToolbox` + WebRTC)
   - ใช้โควตาเพียง **2 App IDs** จึงสามารถติดตั้งแบบ Sideload ด้วย **Free Apple ID** ผ่าน AltStore หรือ Sideloadly ได้ทันที
7. **Android 10+ Internal Game Audio พร้อมระบบแจ้งเตือนเมื่อเกมบล็อกเสียง**:
   - จับภาพด้วย `MediaProjection` และจับเสียงเกมภายในด้วย `AudioPlaybackCapture` หากเกมใดบล็อกการอัดเสียงภายใน (`allowAudioPlaybackCapture="false"`) ระบบจะสลับเป็นโหมดส่งเฉพาะภาพอัตโนมัติพร้อมแสดงแบนเนอร์แจ้งเตือนทั้งบนมือถือและหน้าจอ PC

---

## 📂 โครงสร้างโปรเจกต์

- [`pc-receiver/`](file:///c:/Users/tfkr7/Documents/pragam/Phone%20Projact/pc-receiver) — เซิร์ฟเวอร์รับสัญญาณบน Windows PC, WebSocket Signaling, mDNS Advertiser, หน้าควบคุม Dashboard (`/`) และหน้า OBS Browser Source (`/obs`)
- [`ios-sender/`](file:///c:/Users/tfkr7/Documents/pragam/Phone%20Projact/ios-sender) — แอปส่งสัญญาณฝั่ง iOS (Swift) แบบ Split-Process (`BroadcastExtension` + `WirelessGameMirrorApp`) พร้อมไฟล์ `project.yml` สำหรับ XcodeGen
- [`android-sender/`](file:///c:/Users/tfkr7/Documents/pragam/Phone%20Projact/android-sender) — แอปส่งสัญญาณฝั่ง Android (Kotlin) ใช้ Foreground Service (`MediaProjection` + `AudioPlaybackCapture` + `MediaCodec`)
- [`.github/workflows/ios-sideload-build.yml`](file:///c:/Users/tfkr7/Documents/pragam/Phone%20Projact/.github/workflows/ios-sideload-build.yml) — GitHub Actions Workflow สำหรับคอมไพล์ไฟล์ `.ipa` บน macOS runner เพื่อนำมา Sideload ด้วย Free Apple ID
- [`docs/superpowers/`](file:///c:/Users/tfkr7/Documents/pragam/Phone%20Projact/docs/superpowers) — เอกสารออกแบบ (`specs/`), แผนการพัฒนา (`plans/`) และเอกสารรีวิวระบบ (`reviews/`) ฉบับภาษาไทย

---

## 🚀 วิธีเริ่มต้นใช้งาน

### 1. รันโปรแกรมฝั่ง PC Receiver (Windows)
```powershell
cd pc-receiver
npm start
```
เมื่อรันแล้วสามารถเปิดใช้งานผ่านลิงก์ต่อไปนี้:
- **หน้าจอควบคุมหลัก (PC Control Dashboard)**: `http://127.0.0.1:8080/`
- **ลิงก์สำหรับใส่ใน OBS Browser Source**: `http://127.0.0.1:8080/obs`
- **ตัวจำลองมือถือสำหรับทดสอบสตรีมทันที (Simulator)**: `http://127.0.0.1:8080/simulator`

### 2. การตั้งค่าในโปรแกรม OBS Studio
1. ในช่อง **Sources** กดปุ่ม `+` เลือก **Browser**
2. ตั้งค่าดังนี้:
   - **URL**: `http://127.0.0.1:8080/obs`
   - **Width**: `1920`
   - **Height**: `1080`
   - ติ๊กถูกที่ ✅ **Control audio via OBS** (เพื่อให้เสียงเกมแยกออกมาอยู่ใน OBS Audio Mixer)
   - ติ๊กถูกที่ ✅ **Refresh browser when scene becomes active** (ตัวเลือกเสริม)

### 3. การติดตั้งแอปบน iOS ด้วย Free Apple ID (AltStore / Sideloadly)
1. นำโค้ดขึ้น GitHub Repository แล้วสั่งรัน Action **Build iOS Sideload IPA** (หรือใช้เครื่อง Mac รัน `xcodegen generate` ในโฟลเดอร์ `ios-sender/`)
2. ดาวน์โหลดไฟล์ `WirelessGameMirror-Sideload.ipa` จาก Artifacts
3. เปิดโปรแกรม **Sideloadly** หรือ **AltStore** บน Windows ต่อสาย iPhone/iPad เข้าคอมพิวเตอร์แล้วลากไฟล์ `.ipa` ลงไปพร้อมกรอก **Free Apple ID** (ระบบใช้เพียง 2 App IDs คือตัวแอปหลักและ Broadcast Extension; ต้องกด Refresh/Re-sign ทุก 7 วันตามข้อกำหนดของบัญชีฟรี)

### 4. การติดตั้งแอปบน Android
1. เปิดโฟลเดอร์ `android-sender/` ด้วยโปรแกรม **Android Studio**
2. เสียบสายมือถือ Android (เปิด USB Debugging) หรือสร้างไฟล์ APK ด้วยเมนู **Build > Build Bundle(s) / APK(s) > Build APK(s)**

---

## 🧪 การรันชุดทดสอบอัตโนมัติ (Automated Tests)
```powershell
cd pc-receiver
npm test
```
