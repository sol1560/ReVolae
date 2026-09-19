package io.cuaremote.daemon

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.serialization.Serializable

@Serializable
data class UiElement(val index: Int, val className: String?, val text: String?, val contentDescription: String?, val bounds: String, val clickable: Boolean, val editable: Boolean)

class CuaAccessibilityService : AccessibilityService() {
    private val indexed = mutableMapOf<Int, AccessibilityNodeInfo>()

    override fun onServiceConnected() { instance = this }
    override fun onDestroy() { if (instance === this) instance = null; clearIndex(); super.onDestroy() }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit

    fun tree(maxElements: Int, maxDepth: Int): List<UiElement> {
        clearIndex()
        val result = mutableListOf<UiElement>()
        fun visit(node: AccessibilityNodeInfo, depth: Int) {
            if (depth > maxDepth || result.size >= maxElements) return
            val index = result.size
            indexed[index] = AccessibilityNodeInfo.obtain(node)
            val r = Rect(); node.getBoundsInScreen(r)
            result += UiElement(index, node.className?.toString(), node.text?.toString(), node.contentDescription?.toString(), "${r.left},${r.top},${r.right},${r.bottom}", node.isClickable, node.isEditable)
            for (i in 0 until node.childCount) node.getChild(i)?.let { child -> visit(child, depth + 1); child.recycle() }
        }
        rootInActiveWindow?.let { visit(it, 0) }
        return result
    }

    fun pointFor(index: Int): Pair<Int, Int>? = indexed[index]?.let { val r = Rect(); it.getBoundsInScreen(r); r.centerX() to r.centerY() }
    fun setText(index: Int, text: String): Boolean = indexed[index]?.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }) == true
    fun tap(x: Int, y: Int, duration: Long = 60): Boolean = gesture(x, y, x, y, duration)
    fun swipe(fromX: Int, fromY: Int, toX: Int, toY: Int, duration: Long): Boolean = gesture(fromX, fromY, toX, toY, duration)
    private fun gesture(x1: Int, y1: Int, x2: Int, y2: Int, duration: Long): Boolean {
        val path = Path().apply { moveTo(x1.toFloat(), y1.toFloat()); if (x1 != x2 || y1 != y2) lineTo(x2.toFloat(), y2.toFloat()) }
        return dispatchGesture(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, duration)).build(), null, null)
    }
    private fun clearIndex() { indexed.values.forEach(AccessibilityNodeInfo::recycle); indexed.clear() }

    companion object { @Volatile var instance: CuaAccessibilityService? = null; private set }
}
