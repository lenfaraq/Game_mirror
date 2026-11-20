package com.wirelessgamemirror.sender

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * Main Activity for Wireless Game Mirror Android Sender:
 * - Connects via QR Code URI (`gamemirror://connect?ip=...&port=...&token=...`) with auto-auth
 * - Discovers PC Receivers automatically via mDNS (`_gamestream._tcp.`) with PC Allow/Deny prompt
 * - Requests `RECORD_AUDIO` + `MediaProjection` permissions and launches `ScreenCaptureService`
 * - Displays an on-screen warning banner if a game blocks `AudioPlaybackCapture`
 */
class MainActivity : AppCompatActivity() {

    private lateinit var mdnsDiscoveryManager: MdnsDiscoveryManager
    private var discoveredList: List<DiscoveredPCReceiver> = emptyList()
    private var pendingReceiver: DiscoveredPCReceiver? = null

    private lateinit var statusTextView: TextView
    private lateinit var audioWarningBanner: TextView
    private lateinit var qrInputEditText: EditText
    private lateinit var receiversListView: ListView
    private lateinit var receiversAdapter: ArrayAdapter<String>

    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                ScreenCaptureService.ACTION_STATE_UPDATE -> {
                    val status = intent.getStringExtra(ScreenCaptureService.EXTRA_STATUS_TEXT) ?: return
                    statusTextView.text = "สถานะ: $status"
                }
                ScreenCaptureService.ACTION_AUDIO_CAPTURE_BLOCKED -> {
                    val warning = intent.getStringExtra(ScreenCaptureService.EXTRA_WARNING_TEXT)
                        ?: "เกมนี้บล็อกการอัดเสียงภายใน (AudioPlaybackCapture) ระบบกำลังส่งเฉพาะภาพ"
                    audioWarningBanner.text = "⚠️ $warning"
                    audioWarningBanner.visibility = View.VISIBLE
                }
            }
        }
    }

    private val audioPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ ->
        requestMediaProjectionPermission()
    }

    private val mediaProjectionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val receiver = pendingReceiver ?: return@registerForActivityResult
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            audioWarningBanner.visibility = View.GONE
            val serviceIntent = Intent(this, ScreenCaptureService::class.java).apply {
                action = ScreenCaptureService.ACTION_START_CAPTURE
                putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.resultCode)
                putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, result.data)
                putExtra(ScreenCaptureService.EXTRA_PC_HOST, receiver.host)
                putExtra(ScreenCaptureService.EXTRA_PC_PORT, receiver.port)
                putExtra(ScreenCaptureService.EXTRA_PC_NAME, receiver.name)
                putExtra(ScreenCaptureService.EXTRA_SESSION_TOKEN, receiver.sessionToken)
            }
            ContextCompat.startForegroundService(this, serviceIntent)
        } else {
            Toast.makeText(this, "ยกเลิกการอนุญาตแชร์หน้าจอ", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setupProgrammaticLayout()

        mdnsDiscoveryManager = MdnsDiscoveryManager(this) { receivers ->
            discoveredList = receivers
            val labels = receivers.map { "${it.name} (${it.host}:${it.port}) • กดเพื่อขออนุญาต Allow บน PC" }
            receiversAdapter.clear()
            receiversAdapter.addAll(labels)
            receiversAdapter.notifyDataSetChanged()
        }

        // Handle Deep Link from external QR scanner (`gamemirror://connect?ip=...`)
        intent?.dataString?.let { deepLink ->
            MdnsDiscoveryManager.parseQrCodePayload(deepLink)?.let { receiver ->
                qrInputEditText.setText(deepLink)
                beginConnectionFlow(receiver)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter().apply {
            addAction(ScreenCaptureService.ACTION_STATE_UPDATE)
            addAction(ScreenCaptureService.ACTION_AUDIO_CAPTURE_BLOCKED)
        }
        ContextCompat.registerReceiver(
            this,
            stateReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        mdnsDiscoveryManager.startDiscovery()
    }

    override fun onStop() {
        mdnsDiscoveryManager.stopDiscovery()
        try {
            unregisterReceiver(stateReceiver)
        } catch (_: Exception) {
        }
        super.onStop()
    }

    private fun beginConnectionFlow(receiver: DiscoveredPCReceiver) {
        pendingReceiver = receiver
        val hasAudioPerm = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasAudioPerm) {
            audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        } else {
            requestMediaProjectionPermission()
        }
    }

    private fun requestMediaProjectionPermission() {
        val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        mediaProjectionLauncher.launch(projectionManager.createScreenCaptureIntent())
    }

    private fun setupProgrammaticLayout() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 40, 40, 40)
            setBackgroundColor(Color.parseColor("#0B0F19"))
        }

        val title = TextView(this).apply {
            text = "🎮 Wireless Game Mirror (Android 10+)"
            textSize = 20f
            setTextColor(Color.parseColor("#38BDF8"))
        }
        root.addView(title)

        statusTextView = TextView(this).apply {
            text = "สถานะ: พร้อมเชื่อมต่อ (รองรับหมุนจอแนวตั้ง ↔ แนวนอน อัตโนมัติ)"
            textSize = 14f
            setTextColor(Color.parseColor("#E2E8F0"))
            setPadding(0, 12, 0, 16)
        }
        root.addView(statusTextView)

        audioWarningBanner = TextView(this).apply {
            text = "⚠️ เกมนี้บล็อกการอัดเสียงภายใน (AudioPlaybackCapture) ระบบกำลังส่งเฉพาะภาพ"
            textSize = 13f
            setTextColor(Color.parseColor("#FDE68A"))
            setBackgroundColor(Color.parseColor("#78350F"))
            setPadding(24, 20, 24, 20)
            visibility = View.GONE
        }
        root.addView(audioWarningBanner)

        qrInputEditText = EditText(this).apply {
            hint = "วางลิงก์ QR (gamemirror://connect?ip=...&port=8080&token=...)"
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#64748B"))
        }
        root.addView(qrInputEditText)

        val btnConnectQr = Button(this).apply {
            text = "🔗 เชื่อมต่อด้วย QR Code / ลิงก์จับคู่ (Auto-Auth)"
            setOnClickListener {
                val parsed = MdnsDiscoveryManager.parseQrCodePayload(qrInputEditText.text.toString())
                if (parsed != null) {
                    beginConnectionFlow(parsed)
                } else {
                    Toast.makeText(this@MainActivity, "รูปแบบลิงก์ QR ไม่ถูกต้อง", Toast.LENGTH_SHORT).show()
                }
            }
        }
        root.addView(btnConnectQr)

        val mdnsHeader = TextView(this).apply {
            text = "📡 เครื่อง PC ที่พบบนเครือข่าย LAN (mDNS _gamestream._tcp):"
            textSize = 14f
            setTextColor(Color.parseColor("#94A3B8"))
            setPadding(0, 28, 0, 8)
        }
        root.addView(mdnsHeader)

        receiversAdapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, mutableListOf())
        receiversListView = ListView(this).apply {
            adapter = receiversAdapter
            setOnItemClickListener { _, _, position, _ ->
                discoveredList.getOrNull(position)?.let { receiver ->
                    beginConnectionFlow(receiver)
                }
            }
        }
        root.addView(
            receiversListView,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )

        val btnStop = Button(this).apply {
            text = "✖ หยุดสตรีมและตัดการเชื่อมต่อ"
            gravity = Gravity.CENTER
            setOnClickListener {
                val stopIntent = Intent(this@MainActivity, ScreenCaptureService::class.java).apply {
                    action = ScreenCaptureService.ACTION_STOP_CAPTURE
                }
                startService(stopIntent)
                statusTextView.text = "สถานะ: หยุดสตรีมแล้ว"
                audioWarningBanner.visibility = View.GONE
            }
        }
        root.addView(btnStop)

        setContentView(root)
    }
}
