import Darwin
import Foundation

/// CLI 与菜单栏共用状态目录锁；锁由内核管理，退出后自动释放。
public final class DeviceLease: Sendable {
    private let descriptor: Int32

    public init(stateDirectory: URL) throws {
        let path = stateDirectory.appending(path: "device.lock").path
        let file = open(path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard file >= 0 else { throw LaunchError.invalid("无法打开私有设备锁") }
        guard flock(file, LOCK_EX | LOCK_NB) == 0 else {
            close(file)
            throw LaunchError.invalid("此设备目录已有宿主运行，不能重复启动")
        }
        descriptor = file
    }

    deinit { close(descriptor) }
}
