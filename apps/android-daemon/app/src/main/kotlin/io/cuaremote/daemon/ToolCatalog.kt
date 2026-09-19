package io.cuaremote.daemon

import io.cuaremote.protocol.ToolDescriptor
import kotlinx.serialization.json.*

object ToolCatalog {
    private fun schema(required: List<String> = emptyList(), vararg properties: Pair<String, JsonObject>) = buildJsonObject {
        put("type", "object"); putJsonObject("properties") { properties.forEach { put(it.first, it.second) } }; if (required.isNotEmpty()) putJsonArray("required") { required.forEach(::add) }
    }
    private fun type(name: String) = buildJsonObject { put("type", name) }
    val tools = listOf(
        ToolDescriptor("android.screenshot", "截取当前屏幕，返回 JPEG", staticLevel = 0, costClass = 2, inputSchema = schema(properties = arrayOf("maxWidth" to type("integer")))),
        ToolDescriptor("android.ui_tree", "读取当前无障碍元素树", staticLevel = 0, inputSchema = schema(properties = arrayOf("maxElements" to type("integer"), "maxDepth" to type("integer")))),
        ToolDescriptor("android.tap", "点击元素或坐标", staticLevel = 1, inputSchema = schema(properties = arrayOf("index" to type("integer"), "x" to type("integer"), "y" to type("integer")))),
        ToolDescriptor("android.long_press", "长按元素或坐标", staticLevel = 1, inputSchema = schema(properties = arrayOf("index" to type("integer"), "x" to type("integer"), "y" to type("integer")))),
        ToolDescriptor("android.swipe", "从一个坐标滑到另一个坐标", staticLevel = 1, inputSchema = schema(listOf("fromX", "fromY", "toX", "toY"), "fromX" to type("integer"), "fromY" to type("integer"), "toX" to type("integer"), "toY" to type("integer"), "durationMs" to type("integer"))),
        ToolDescriptor("android.set_text", "向可编辑元素输入文字", staticLevel = 1, inputSchema = schema(listOf("index", "text"), "index" to type("integer"), "text" to type("string"))),
        ToolDescriptor("android.key", "发送系统按键", staticLevel = 1, inputSchema = schema(listOf("key"), "key" to buildJsonObject { put("type", "string"); putJsonArray("enum") { listOf("back", "home", "recents", "enter", "volume_up", "volume_down").forEach(::add) } })),
        ToolDescriptor("android.launch", "启动指定包名的应用", staticLevel = 1, inputSchema = schema(listOf("packageName"), "packageName" to type("string"))),
        ToolDescriptor("android.apps", "列出已安装且可启动的应用", staticLevel = 0, inputSchema = schema()),
        ToolDescriptor("android.notifications", "读取当前通知", staticLevel = 0, inputSchema = schema()),
    )
}
