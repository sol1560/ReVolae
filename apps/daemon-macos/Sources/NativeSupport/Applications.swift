import AppKit
import ApplicationServices
import CuaRemoteProtocol

@MainActor
public enum Applications {
    public static func list() -> [InstalledApp] {
        let running = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
        var apps: [String: InstalledApp] = [:]
        let roots = ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"]
        func include(_ url: URL) {
            guard let bundle = Bundle(url: url), let id = bundle.bundleIdentifier else { return }
            let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
                ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? url.deletingPathExtension().lastPathComponent
            apps[id] = InstalledApp(bundleId: id, name: name, running: running.contains(id), learned: false)
        }
        for root in roots {
            guard let files = FileManager.default.enumerator(at: URL(fileURLWithPath: root),
                includingPropertiesForKeys: nil, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
            for case let url as URL in files where url.pathExtension == "app" {
                include(url)
            }
        }
        // Finder 等系统应用位于 CoreServices，不在通常的安装目录里。
        for app in NSWorkspace.shared.runningApplications {
            if let url = app.bundleURL { include(url) }
        }
        return apps.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    public static func inventory(bundleID: String, phase: AppInventoryPhase) throws -> AppInventory {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID),
              let bundle = Bundle(url: url) else { throw NativeFailure.unavailable("找不到该应用") }
        let name = bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? url.deletingPathExtension().lastPathComponent
        if phase == .sdef {
            let process = Process(), output = Pipe()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/sdef")
            process.arguments = [url.path]
            process.standardOutput = output; process.standardError = FileHandle.standardError
            try process.run()
            let xml = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw NativeFailure.unavailable("应用未提供可读的脚本字典") }
            return try SdefInventory.parse(xml, bundleID: bundleID, appName: name)
        }
        guard phase == .menu || phase == .window else {
            throw NativeFailure.unavailable("此只读采集入口不执行界面探索；系统未提供按应用查询个人快捷指令的接口")
        }
        guard AXIsProcessTrusted() else { throw NativeFailure.unavailable("需要在 Mac 系统设置中允许辅助功能；未读取界面") }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else {
            throw NativeFailure.unavailable("应用没有运行。采集不会自行打开应用")
        }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        var value: CFTypeRef?
        let attribute = phase == .menu ? kAXMenuBarAttribute : kAXWindowsAttribute
        let status = AXUIElementCopyAttributeValue(root, attribute as CFString, &value)
        guard status == .success, let value else { throw NativeFailure.unavailable("应用未提供可读的菜单或窗口") }
        let elements: [AXUIElement]
        if CFGetTypeID(value) == AXUIElementGetTypeID() { elements = [unsafeDowncast(value, to: AXUIElement.self)] }
        else { elements = value as? [AXUIElement] ?? [] }
        var items: [InventoryItem] = [], truncated = false
        var visited: Set<CFHashCode> = []
        func text(_ element: AXUIElement, _ attribute: String) -> String? {
            var output: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, attribute as CFString, &output) == .success else { return nil }
            return output as? String
        }
        func walk(_ element: AXUIElement, path: [String], depth: Int) {
            guard items.count < 300, depth < 12 else { truncated = true; return }
            guard visited.insert(CFHash(element)).inserted else { return }
            let role = text(element, kAXRoleAttribute) ?? "AXUnknown"
            let title = text(element, kAXTitleAttribute) ?? text(element, kAXDescriptionAttribute) ?? role
            let currentPath = path + [title]
            var actions: CFArray?
            AXUIElementCopyActionNames(element, &actions)
            let actionNames = actions as? [String] ?? []
            items.append(InventoryItem(source: phase == .menu ? .menu : .window,
                id: currentPath.joined(separator: " > "), name: title, params: [],
                meta: ["role": .string(role), "actions": .array(actionNames.map(JSONValue.string))]))
            var children: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success,
               let children = children as? [AXUIElement] {
                for child in children { walk(child, path: currentPath, depth: depth + 1) }
            }
        }
        for element in elements { walk(element, path: [], depth: 0) }
        return AppInventory(bundleId: bundleID, appName: name, phase: phase, items: items, truncated: truncated)
    }
}

public enum SdefInventory {
    public static func parse(_ xml: Data, bundleID: String, appName: String) throws -> AppInventory {
        let document = try XMLDocument(data: xml, options: [.nodeLoadExternalEntitiesNever])
        let commands = try document.nodes(forXPath: "//suite/command")
        let items = commands.prefix(300).compactMap { node -> InventoryItem? in
            guard let command = node as? XMLElement, let name = command.attribute(forName: "name")?.stringValue else { return nil }
            let suite = (command.parent as? XMLElement)?.attribute(forName: "name")?.stringValue ?? ""
            let params = (command.children ?? []).compactMap { child -> InventoryParam? in
                guard let element = child as? XMLElement, ["parameter", "direct-parameter"].contains(element.name) else { return nil }
                let name = element.attribute(forName: "name")?.stringValue ?? "directParameter"
                let rawType = element.attribute(forName: "type")?.stringValue ?? "unknown"
                let type: InventoryParamType
                switch rawType {
                case "text", "string": type = .text
                case "integer", "real", "number": type = .number
                case "boolean": type = .bool
                case "file", "alias": type = .file
                case "date": type = .date
                default: type = .unknown
                }
                return InventoryParam(name: name, type: type,
                    required: element.attribute(forName: "optional")?.stringValue != "yes",
                    description: element.attribute(forName: "description")?.stringValue)
            }
            return InventoryItem(source: .sdef, id: suite + "/" + name, name: name,
                description: command.attribute(forName: "description")?.stringValue, params: params,
                meta: ["suite": .string(suite)])
        }
        return AppInventory(bundleId: bundleID, appName: appName, phase: .sdef, items: items, truncated: commands.count > 300)
    }
}
