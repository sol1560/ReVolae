package io.cuaremote.daemon

import android.app.*
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.IBinder
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import java.io.ByteArrayOutputStream

class CaptureService : Service() {
    private var projection: MediaProjection? = null
    private var reader: ImageReader? = null
    private var display: VirtualDisplay? = null
    private val imageThread = HandlerThread("cuaremote-capture").apply { start() }
    @Volatile private var latest: Bitmap? = null
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() { super.onCreate(); instance = this; createChannel(); startForeground(31, Notification.Builder(this, CHANNEL).setContentTitle("CuaRemote 截屏已授权").setSmallIcon(android.R.drawable.ic_menu_camera).build()) }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int { intent?.getParcelableExtra<Intent>(EXTRA_DATA)?.let { authorize(intent.getIntExtra(EXTRA_CODE, Activity.RESULT_CANCELED), it) }; return START_NOT_STICKY }
    override fun onDestroy() { display?.release(); reader?.close(); latest?.recycle(); projection?.stop(); imageThread.quitSafely(); if (instance === this) instance = null; super.onDestroy() }
    fun authorize(resultCode: Int, data: Intent) {
        display?.release(); reader?.close(); latest?.recycle(); projection?.stop()
        val activeProjection = requireNotNull(getSystemService(MediaProjectionManager::class.java).getMediaProjection(resultCode, data)) { "录屏授权无效" }
        activeProjection.registerCallback(object : MediaProjection.Callback() { override fun onStop() { projection = null } }, Handler(Looper.getMainLooper()))
        projection = activeProjection
        val metrics = resources.displayMetrics
        reader = ImageReader.newInstance(metrics.widthPixels, metrics.heightPixels, PixelFormat.RGBA_8888, 2).also { imageReader ->
            imageReader.setOnImageAvailableListener({ source -> source.acquireLatestImage()?.use { image ->
                val plane = image.planes[0]; val padded = Bitmap.createBitmap(plane.rowStride / plane.pixelStride, image.height, Bitmap.Config.ARGB_8888); padded.copyPixelsFromBuffer(plane.buffer)
                val cropped = Bitmap.createBitmap(padded, 0, 0, image.width, image.height); padded.recycle(); latest?.recycle(); latest = cropped
            } }, Handler(imageThread.looper))
        }
        display = projection!!.createVirtualDisplay("cuaremote-shot", metrics.widthPixels, metrics.heightPixels, metrics.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader!!.surface, null, null)
    }
    fun jpeg(maxWidth: Int?): ByteArray {
        val source = latest ?: error("尚未授权录屏或屏幕帧尚未就绪")
        val output = if (maxWidth != null && source.width > maxWidth) Bitmap.createScaledBitmap(source, maxWidth, source.height * maxWidth / source.width, true) else source
        return ByteArrayOutputStream().use { out -> output.compress(Bitmap.CompressFormat.JPEG, 82, out); if (output !== source) output.recycle(); out.toByteArray() }
    }
    private fun createChannel() { getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "截屏", NotificationManager.IMPORTANCE_LOW)) }
    companion object { private const val CHANNEL = "capture"; private const val EXTRA_CODE = "resultCode"; private const val EXTRA_DATA = "resultData"; @Volatile var instance: CaptureService? = null; private set
        fun start(context: Context, resultCode: Int, data: Intent) { context.startForegroundService(Intent(context, CaptureService::class.java).putExtra(EXTRA_CODE, resultCode).putExtra(EXTRA_DATA, data)) }
    }
}
