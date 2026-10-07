import AppKit
import ScreenCaptureKit

public struct CapturedImage: Encodable, Sendable {
    public let width: Int
    public let height: Int
    public let jpeg: String
}

@MainActor
public enum ScreenCapture {
    public static func image(maxWidth: Int, bundleID: String? = nil) async throws -> CapturedImage {
        guard (1...4096).contains(maxWidth) else { throw NativeFailure.unavailable("画面宽度必须在 1 到 4096 之间") }
        guard CGPreflightScreenCaptureAccess() else {
            throw NativeFailure.unavailable("Mac 尚未授予屏幕录制权限；没有采集画面")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let filter: SCContentFilter
        let size: CGSize
        if let bundleID {
            guard let window = content.windows.first(where: {
                $0.owningApplication?.bundleIdentifier == bundleID && $0.frame.width > 1 && $0.frame.height > 1
            }) else { throw NativeFailure.unavailable("指定应用没有可采集的屏幕窗口") }
            filter = SCContentFilter(desktopIndependentWindow: window)
            size = window.frame.size
        } else {
            guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
                throw NativeFailure.unavailable("没有可采集的主显示器")
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
            size = CGSize(width: display.width, height: display.height)
        }
        let config = SCStreamConfiguration()
        config.width = min(maxWidth, Int(size.width))
        config.height = max(1, Int(Double(config.width) * size.height / size.width))
        config.showsCursor = false; config.capturesAudio = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else {
            throw NativeFailure.unavailable("无法编码真实画面")
        }
        return CapturedImage(width: image.width, height: image.height, jpeg: jpeg.base64EncodedString())
    }
}
