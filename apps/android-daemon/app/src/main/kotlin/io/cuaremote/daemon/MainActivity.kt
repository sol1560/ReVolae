package io.cuaremote.daemon

import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.provider.Settings
import android.widget.*
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    private lateinit var status: TextView
    private var connection: HubConnection? = null
    private val capture = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK && result.data != null) CaptureService.start(this, result.resultCode, result.data!!)
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("config", MODE_PRIVATE)
        val hub = EditText(this).apply { hint = "wss://hub.example/ws"; setText(prefs.getString("hub", "")) }
        val device = EditText(this).apply { hint = "设备 ID"; setText(prefs.getString("device", Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID))) }
        status = TextView(this).apply { text = "未连接" }
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(40, 64, 40, 40)
            addView(TextView(this@MainActivity).apply { text = "CuaRemote 被控端"; textSize = 26f }); addView(status); addView(hub); addView(device)
            addView(Button(this@MainActivity).apply { text = "打开无障碍设置"; setOnClickListener { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) } })
            addView(Button(this@MainActivity).apply { text = "打开通知使用权"; setOnClickListener { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) } })
            addView(Button(this@MainActivity).apply { text = "授权录屏"; setOnClickListener { capture.launch(getSystemService(MediaProjectionManager::class.java).createScreenCaptureIntent()) } })
            addView(Button(this@MainActivity).apply { text = "连接"; setOnClickListener {
                prefs.edit().putString("hub", hub.text.toString()).putString("device", device.text.toString()).apply()
                connection?.close(); connection = HubConnection(hub.text.toString(), device.text.toString(), android.os.Build.MODEL, AndroidIdentity(this@MainActivity), ToolExecutor(this@MainActivity)::execute, onState = { runOnUiThread { status.text = it } }).also { it.connect() }
            } })
        }
        setContentView(layout)
    }
    override fun onDestroy() { connection?.close(); super.onDestroy() }
}
