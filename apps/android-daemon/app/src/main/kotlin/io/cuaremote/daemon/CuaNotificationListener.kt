package io.cuaremote.daemon

import android.service.notification.NotificationListenerService
import kotlinx.serialization.Serializable

@Serializable data class VisibleNotification(val packageName: String, val title: String?, val text: String?)
class CuaNotificationListener : NotificationListenerService() {
    override fun onListenerConnected() { instance = this }
    override fun onListenerDisconnected() { if (instance === this) instance = null }
    fun current() = activeNotifications.map { n -> VisibleNotification(n.packageName, n.notification.extras.getCharSequence("android.title")?.toString(), n.notification.extras.getCharSequence("android.text")?.toString()) }
    companion object { @Volatile var instance: CuaNotificationListener? = null; private set }
}
