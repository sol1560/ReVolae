package io.cuaremote.controller

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import io.cuaremote.protocol.PairOffer
import io.cuaremote.protocol.ProtocolJson

data class Device(val id: String, val name: String, val platform: String, val online: Boolean)
data class TimelineStep(val title: String, val detail: String, val state: String)

class MainActivity : FragmentActivity() {
    private val devices = mutableStateListOf(Device("mac-studio", "工作室 Mac", "macOS", true), Device("ipad-home", "客厅 iPad", "iPadOS", false), Device("android-pixel", "Pixel 9", "Android", true))
    private val scan = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let { raw -> runCatching { ProtocolJson.value.decodeFromString(PairOffer.serializer(), raw) }.onSuccess { offer -> devices.removeAll { it.id == offer.deviceId }; devices += Device(offer.deviceId, offer.name, "已配对设备", true) } }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { CuaTheme { CuaRemoteApp(devices, onScan = { scan.launch(ScanOptions().setPrompt("扫描设备上的配对二维码").setBeepEnabled(false).setOrientationLocked(false)) }, signer = remember { ApprovalSigner(this) }) } }
    }
}

@Composable private fun CuaTheme(content: @Composable () -> Unit) {
    val colors = lightColorScheme(primary = Color(0xFF315C49), secondary = Color(0xFF52665A), background = Color(0xFFF7F8F5), surface = Color(0xFFFFFFFF), error = Color(0xFFBA1A1A))
    MaterialTheme(colorScheme = colors, typography = Typography(), content = content)
}

@Composable private fun CuaRemoteApp(devices: List<Device>, onScan: () -> Unit, signer: ApprovalSigner) {
    var tab by remember { mutableIntStateOf(0) }
    Scaffold(bottomBar = { NavigationBar { listOf("设备" to Icons.Outlined.Devices, "执行" to Icons.Outlined.AutoAwesome, "历史" to Icons.Outlined.History, "设置" to Icons.Outlined.Settings).forEachIndexed { index, item -> NavigationBarItem(selected = tab == index, onClick = { tab = index }, icon = { Icon(item.second, null) }, label = { Text(item.first) }) } } }) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) { when (tab) { 0 -> DevicesScreen(devices, onScan); 1 -> IntentScreen(devices.filter { it.online }); 2 -> HistoryScreen(); else -> SettingsScreen() } }
    }
}

@Composable private fun Page(title: String, content: @Composable ColumnScope.() -> Unit) = Column(Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) { Text(title, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold); content() }

@Composable private fun DevicesScreen(devices: List<Device>, onScan: () -> Unit) = Page("设备") {
    Text("选择一台设备，或扫码添加新设备。", color = MaterialTheme.colorScheme.onSurfaceVariant)
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.weight(1f)) { items(devices) { d ->
        ElevatedCard(Modifier.fillMaxWidth()) { Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) { Icon(if (d.platform.contains("Android")) Icons.Outlined.PhoneAndroid else Icons.Outlined.Computer, null); Spacer(Modifier.width(14.dp)); Column(Modifier.weight(1f)) { Text(d.name, fontWeight = FontWeight.Medium); Text(d.platform, style = MaterialTheme.typography.bodySmall) }; Text(if (d.online) "在线" else "离线", color = if (d.online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline) } }
    } }
    Button(onScan, Modifier.fillMaxWidth()) { Icon(Icons.Outlined.QrCodeScanner, null); Spacer(Modifier.width(8.dp)); Text("扫码配对") }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun IntentScreen(devices: List<Device>) = Page("执行任务") {
    var selected by remember { mutableStateOf(devices.firstOrNull()) }; var text by remember { mutableStateOf("") }; var running by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded, { expanded = !expanded }) { OutlinedTextField(selected?.name ?: "没有在线设备", {}, readOnly = true, label = { Text("目标设备") }, trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) }, modifier = Modifier.menuAnchor().fillMaxWidth()); ExposedDropdownMenu(expanded, { expanded = false }) { devices.forEach { DropdownMenuItem({ Text("${it.name} · ${it.platform}") }, { selected = it; expanded = false }) } } }
    OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth(), label = { Text("告诉设备要做什么") }, placeholder = { Text("例如：打开日历，看看明天下午有没有空") }, minLines = 3)
    Button({ if (text.isNotBlank() && selected != null) running = true }, Modifier.fillMaxWidth(), enabled = text.isNotBlank() && selected != null) { Text("开始执行") }
    if (running) {
        Text("步骤", style = MaterialTheme.typography.titleMedium)
        listOf(TimelineStep("理解任务", "已生成执行计划", "完成"), TimelineStep("读取当前界面", "android.ui_tree · L0", "完成"), TimelineStep("打开目标应用", "等待云端大脑下一步", "进行中")).forEach { step -> Row(verticalAlignment = Alignment.Top) { Icon(if (step.state == "完成") Icons.Outlined.CheckCircle else Icons.Outlined.Pending, null, tint = MaterialTheme.colorScheme.primary); Spacer(Modifier.width(12.dp)); Column { Text(step.title, fontWeight = FontWeight.Medium); Text("${step.detail} · ${step.state}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
    }
}

@Composable fun ApprovalCard(action: String, detail: String, challenge: String, signer: ApprovalSigner, onDecision: (Boolean, Boolean, String) -> Unit) {
    var signing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    ElevatedCard(colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("需要确认", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text(action)
            Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surface) { Text(detail, Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall) }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(Triple("仅这次", true, false), Triple("以后自动", true, true), Triple("拒绝", false, false)).forEach { choice ->
                    Button(onClick = { signing = true; signer.sign(challenge, choice.second) { result -> signing = false; result.onSuccess { onDecision(choice.second, choice.third, it) }.onFailure { error = it.message } } }, enabled = !signing) { Text(choice.first) }
                }
            }
        }
    }
}

@Composable private fun HistoryScreen() = Page("操作历史") { LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) { items(listOf("整理下载目录" to "工作室 Mac · 已完成", "读取未接来电" to "Pixel 9 · 已完成", "发送付款" to "Pixel 9 · 已拒绝")) { item -> OutlinedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp)) { Text(item.first, fontWeight = FontWeight.Medium); Text(item.second, color = MaterialTheme.colorScheme.onSurfaceVariant) } } } } }

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun SettingsScreen() = Page("设置") {
    var preset by remember { mutableStateOf("平衡") }; var history by remember { mutableStateOf(true) }; var shots by remember { mutableStateOf(false) }; var logs by remember { mutableStateOf(false) }; var shortcuts by remember { mutableStateOf(true) }; var jev by remember { mutableStateOf(true) }
    Text("隐私预设", style = MaterialTheme.typography.titleMedium); SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) { listOf("全本地", "平衡", "全云端").forEachIndexed { i, name -> SegmentedButton(preset == name, { preset = name }, SegmentedButtonDefaults.itemShape(i, 3)) { Text(name) } } }
    Text("逐项控制", style = MaterialTheme.typography.titleMedium)
    listOf("同步操作历史" to (history to { v: Boolean -> history = v }), "同步截图" to (shots to { v: Boolean -> shots = v }), "同步日志" to (logs to { v: Boolean -> logs = v }), "同步快捷指令" to (shortcuts to { v: Boolean -> shortcuts = v }), "启用 Jev 预检" to (jev to { v: Boolean -> jev = v })).forEach { row -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { Text(row.first, Modifier.weight(1f)); Switch(row.second.first, row.second.second) } }
    HorizontalDivider(); Text("L2 系统级操作始终要求手机确认，任何预设都不能关闭。", color = MaterialTheme.colorScheme.onSurfaceVariant)
}
