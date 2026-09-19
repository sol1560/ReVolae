package io.cuaremote.daemon

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.view.accessibility.AccessibilityNodeInfo
import io.cuaremote.protocol.Attachment
import io.cuaremote.protocol.ToolsCall
import io.cuaremote.protocol.ToolsResult
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import java.util.Base64
import java.util.UUID

class ToolExecutor(private val context: Context) {
    fun execute(call: ToolsCall): ToolsResult {
        val started = System.nanoTime()
        return try {
            val (output, attachments) = when (call.tool) {
                "android.screenshot" -> null to listOf(Attachment("image/jpeg", inline = Base64.getEncoder().encodeToString(CaptureService.instance?.jpeg(call.int("maxWidth")) ?: error("尚未授权录屏"))))
                "android.ui_tree" -> Json.encodeToString(service().tree(call.int("maxElements") ?: 500, call.int("maxDepth") ?: 30)) to emptyList()
                "android.tap", "android.long_press" -> {
                    val (x, y) = point(call); check(service().tap(x, y, if (call.tool.endsWith("long_press")) 650 else 60)) { "手势提交失败" }; "已提交手势" to emptyList()
                }
                "android.swipe" -> { check(service().swipe(call.needInt("fromX"), call.needInt("fromY"), call.needInt("toX"), call.needInt("toY"), (call.int("durationMs") ?: 350).toLong())) { "滑动提交失败" }; "已提交滑动" to emptyList() }
                "android.set_text" -> { check(service().setText(call.needInt("index"), call.args["text"]?.jsonPrimitive?.content ?: error("缺少 text"))) { "元素不可编辑或 index 已失效" }; "文字已输入" to emptyList() }
                "android.key" -> { key(call.args["key"]?.jsonPrimitive?.content ?: error("缺少 key")); "按键已发送" to emptyList() }
                "android.launch" -> { val pkg = call.args["packageName"]?.jsonPrimitive?.content ?: error("缺少 packageName"); val intent = context.packageManager.getLaunchIntentForPackage(pkg) ?: error("应用不可启动"); context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); "已启动 $pkg" to emptyList() }
                "android.apps" -> Json.encodeToString(context.packageManager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0).map { mapOf("packageName" to it.activityInfo.packageName, "label" to it.loadLabel(context.packageManager).toString()) }.distinctBy { it["packageName"] }) to emptyList()
                "android.notifications" -> Json.encodeToString(CuaNotificationListener.instance?.current() ?: error("未开启通知使用权")) to emptyList()
                else -> error("没有工具 ${call.tool}")
            }
            ToolsResult(id = UUID.randomUUID().toString(), callId = call.callId, ok = true, output = output, attachments = attachments, ms = elapsed(started))
        } catch (e: Exception) {
            ToolsResult(id = UUID.randomUUID().toString(), callId = call.callId, ok = false, error = e.message ?: e.javaClass.simpleName, ms = elapsed(started))
        }
    }
    private fun service() = CuaAccessibilityService.instance ?: error("无障碍服务未开启")
    private fun point(call: ToolsCall): Pair<Int, Int> = call.int("index")?.let { service().pointFor(it) ?: error("index 已失效") } ?: (call.needInt("x") to call.needInt("y"))
    private fun key(key: String) {
        val service = service()
        val global = when (key) { "back" -> AccessibilityService.GLOBAL_ACTION_BACK; "home" -> AccessibilityService.GLOBAL_ACTION_HOME; "recents" -> AccessibilityService.GLOBAL_ACTION_RECENTS; else -> null }
        if (global != null) { check(service.performGlobalAction(global)) { "系统按键失败" }; return }
        if (key == "enter") { check(service.rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id) == true) { "当前没有可提交的输入框" }; return }
        val audio = context.getSystemService(AudioManager::class.java); val direction = if (key == "volume_up") AudioManager.ADJUST_RAISE else if (key == "volume_down") AudioManager.ADJUST_LOWER else error("不支持按键 $key")
        audio.adjustSuggestedStreamVolume(direction, AudioManager.USE_DEFAULT_STREAM_TYPE, AudioManager.FLAG_SHOW_UI)
    }
    private fun ToolsCall.int(name: String) = args[name]?.jsonPrimitive?.int
    private fun ToolsCall.needInt(name: String) = int(name) ?: error("缺少 $name")
    private fun elapsed(started: Long) = (System.nanoTime() - started) / 1_000_000.0
}
