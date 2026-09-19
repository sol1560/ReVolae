package io.cuaremote.daemon

import kotlin.test.*
import org.junit.Test

class ToolCatalogTest {
    @Test fun `tool names and levels match policy`() {
        assertEquals(mapOf(
            "android.screenshot" to 0, "android.ui_tree" to 0, "android.tap" to 1,
            "android.long_press" to 1, "android.swipe" to 1, "android.set_text" to 1,
            "android.key" to 1, "android.launch" to 1, "android.apps" to 0,
            "android.notifications" to 0,
        ), ToolCatalog.tools.associate { it.name to it.staticLevel })
    }
}
