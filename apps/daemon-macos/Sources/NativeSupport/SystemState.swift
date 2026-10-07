import AppKit
import Darwin
import IOKit.ps
import CuaRemoteProtocol

public enum NativeFailure: LocalizedError {
    case unavailable(String)
    public var errorDescription: String? { switch self { case .unavailable(let message): message } }
}

@MainActor
public enum SystemState {
    public static func stats() throws -> DeviceStats {
        let before = try cpuTicks()
        Thread.sleep(forTimeInterval: 0.2)
        let after = try cpuTicks()
        let delta = zip(after, before).map { Double($0 &- $1) }
        let total = delta.reduce(0, +)
        var memory = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
        let memoryResult = withUnsafeMutablePointer(to: &memory) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
            }
        }
        guard memoryResult == KERN_SUCCESS else { throw NativeFailure.unavailable("无法读取系统内存状态") }
        let pageSize = Double(getpagesize())
        let used = Double(memory.active_count + memory.wire_count + memory.compressor_page_count) * pageSize / 1_048_576
        let disk = try FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory())
        let running = NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier).sorted()
        var result = DeviceStats(runningApps: running,
            cpuPercent: total > 0 ? 100 * (1 - delta[Int(CPU_STATE_IDLE)] / total) : nil,
            memUsedMB: used, memTotalMB: Double(ProcessInfo.processInfo.physicalMemory) / 1_048_576,
            diskFreeGB: (disk[.systemFreeSize] as? NSNumber).map { $0.doubleValue / 1_000_000_000 },
            uptimeSec: ProcessInfo.processInfo.systemUptime)
        if let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
           let sources = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] {
            for source in sources {
                guard let data = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any],
                      data[kIOPSTypeKey] as? String == kIOPSInternalBatteryType,
                      let current = data[kIOPSCurrentCapacityKey] as? Double,
                      let maximum = data[kIOPSMaxCapacityKey] as? Double, maximum > 0 else { continue }
                result.batteryPercent = current / maximum * 100
                result.charging = data[kIOPSIsChargingKey] as? Bool
            }
        }
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        if getifaddrs(&interfaces) == 0 {
            defer { freeifaddrs(interfaces) }
            var current = interfaces
            while let item = current {
                defer { current = item.pointee.ifa_next }
                guard let address = item.pointee.ifa_addr,
                      address.pointee.sa_family == UInt8(AF_INET),
                      item.pointee.ifa_flags & UInt32(IFF_UP) != 0,
                      item.pointee.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
                result.network = String(cString: item.pointee.ifa_name)
                break
            }
        }
        return result
    }

    private static func cpuTicks() throws -> [UInt32] {
        var ticks = host_cpu_load_info()
        var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info>.size / MemoryLayout<integer_t>.size)
        let status = withUnsafeMutablePointer(to: &ticks) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &count)
            }
        }
        guard status == KERN_SUCCESS else { throw NativeFailure.unavailable("无法读取 CPU 状态") }
        return [ticks.cpu_ticks.0, ticks.cpu_ticks.1, ticks.cpu_ticks.2, ticks.cpu_ticks.3]
    }
}
