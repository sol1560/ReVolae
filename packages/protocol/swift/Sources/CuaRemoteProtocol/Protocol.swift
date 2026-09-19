// 由 packages/protocol/scripts/gen-swift.ts 生成，不要手改。MIT。
import Foundation

/// 任意 JSON 值
public enum JSONValue: Codable, Sendable, Equatable {
    case string(String), number(Double), bool(Bool), null
    case array([JSONValue]), object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "bad JSON value")
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

public let protocolVersion = 1

public enum AppInventoryPhase: String, Codable, Sendable, CaseIterable {
    case sdef = "sdef"
    case menu = "menu"
    case window = "window"
    case shortcuts = "shortcuts"
    case explore = "explore"
}

public enum InventoryItemSource: String, Codable, Sendable, CaseIterable {
    case sdef = "sdef"
    case menu = "menu"
    case window = "window"
    case shortcuts = "shortcuts"
    case explored = "explored"
}

public enum InventoryParamType: String, Codable, Sendable, CaseIterable {
    case text = "text"
    case number = "number"
    case bool = "bool"
    case choice = "choice"
    case date = "date"
    case file = "file"
    case unknown = "unknown"
}

public struct InventoryParam: Codable, Sendable {
    public var name: String
    public var `type`: InventoryParamType?
    public var required: Bool?
    public var choices: [String]?
    public var description: String?

    public init(name: String, `type`: InventoryParamType? = nil, required: Bool? = nil, choices: [String]? = nil, description: String? = nil) {
        self.name = name
        self.`type` = `type`
        self.required = required
        self.choices = choices
        self.description = description
    }

    enum CodingKeys: String, CodingKey {
        case name
        case `type`
        case required
        case choices
        case description
    }
}

public struct InventoryItem: Codable, Sendable {
    public var source: InventoryItemSource
    public var id: String
    public var name: String
    public var description: String?
    public var params: [InventoryParam]?
    public var meta: [String: JSONValue]?

    public init(source: InventoryItemSource, id: String, name: String, description: String? = nil, params: [InventoryParam]? = nil, meta: [String: JSONValue]? = nil) {
        self.source = source
        self.id = id
        self.name = name
        self.description = description
        self.params = params
        self.meta = meta
    }

    enum CodingKeys: String, CodingKey {
        case source
        case id
        case name
        case description
        case params
        case meta
    }
}

public struct AppInventory: Codable, Sendable {
    public var bundleId: String
    public var appName: String
    public var phase: AppInventoryPhase
    public var items: [InventoryItem]
    public var truncated: Bool?

    public init(bundleId: String, appName: String, phase: AppInventoryPhase, items: [InventoryItem], truncated: Bool? = nil) {
        self.bundleId = bundleId
        self.appName = appName
        self.phase = phase
        self.items = items
        self.truncated = truncated
    }

    enum CodingKeys: String, CodingKey {
        case bundleId
        case appName
        case phase
        case items
        case truncated
    }
}

public enum ApprovalSignatureAlg: String, Codable, Sendable, CaseIterable {
    case eS256 = "ES256"
    case ed25519 = "Ed25519"
}

public struct ApprovalSignature: Codable, Sendable {
    public var alg: ApprovalSignatureAlg
    public var keyId: String
    public var sig: String
    public var expiresAt: Int
    public var nonce: String

    public init(alg: ApprovalSignatureAlg, keyId: String, sig: String, expiresAt: Int, nonce: String) {
        self.alg = alg
        self.keyId = keyId
        self.sig = sig
        self.expiresAt = expiresAt
        self.nonce = nonce
    }

    enum CodingKeys: String, CodingKey {
        case alg
        case keyId
        case sig
        case expiresAt
        case nonce
    }
}

public enum BrainLocation: String, Codable, Sendable, CaseIterable {
    case local = "local"
    case cloud = "cloud"
    case lan = "lan"
}

public enum CardControl: String, Codable, Sendable, CaseIterable {
    case button = "button"
    case inputButton = "input_button"
    case list = "list"
    case toggle = "toggle"
    case picker = "picker"
    case form = "form"
}

public enum CardFieldKind: String, Codable, Sendable, CaseIterable {
    case text = "text"
    case number = "number"
    case bool = "bool"
    case choice = "choice"
    case date = "date"
}

public struct CardField: Codable, Sendable {
    public var key: String
    public var label: String
    public var kind: CardFieldKind
    public var choices: [String]?
    public var required: Bool?

    public init(key: String, label: String, kind: CardFieldKind, choices: [String]? = nil, required: Bool? = nil) {
        self.key = key
        self.label = label
        self.kind = kind
        self.choices = choices
        self.required = required
    }

    enum CodingKeys: String, CodingKey {
        case key
        case label
        case kind
        case choices
        case required
    }
}

public enum CardActionKind: String, Codable, Sendable, CaseIterable {
    case applescript = "applescript"
    case jxa = "jxa"
    case shortcut = "shortcut"
    case gui = "gui"
    case shell = "shell"
}

public struct CardAction: Codable, Sendable {
    public var kind: CardActionKind
    public var template: String

    public init(kind: CardActionKind, template: String) {
        self.kind = kind
        self.template = template
    }

    enum CodingKeys: String, CodingKey {
        case kind
        case template
    }
}

public enum Level: Int, Codable, Sendable, CaseIterable, Comparable {
    case l0 = 0
    case l1 = 1
    case l2 = 2
    public static func < (a: Level, b: Level) -> Bool { a.rawValue < b.rawValue }
}

public enum CapabilityCardSource: String, Codable, Sendable, CaseIterable {
    case sdef = "sdef"
    case menu = "menu"
    case window = "window"
    case shortcuts = "shortcuts"
    case explored = "explored"
    case adapter = "adapter"
}

public struct CapabilityCard: Codable, Sendable {
    public var id: String
    public var appBundleId: String
    public var appName: String
    public var name: String
    public var description: String
    public var control: CardControl
    public var fields: [CardField]?
    public var action: CardAction
    public var dataSource: CardAction?
    public var staticLevel: Level
    public var source: CapabilityCardSource
    public var hidden: Bool?

    public init(id: String, appBundleId: String, appName: String, name: String, description: String, control: CardControl, fields: [CardField]? = nil, action: CardAction, dataSource: CardAction? = nil, staticLevel: Level, source: CapabilityCardSource, hidden: Bool? = nil) {
        self.id = id
        self.appBundleId = appBundleId
        self.appName = appName
        self.name = name
        self.description = description
        self.control = control
        self.fields = fields
        self.action = action
        self.dataSource = dataSource
        self.staticLevel = staticLevel
        self.source = source
        self.hidden = hidden
    }

    enum CodingKeys: String, CodingKey {
        case id
        case appBundleId
        case appName
        case name
        case description
        case control
        case fields
        case action
        case dataSource
        case staticLevel
        case source
        case hidden
    }
}

public enum Channel: String, Codable, Sendable, CaseIterable {
    case shell = "shell"
    case applescript = "applescript"
    case jxa = "jxa"
    case shortcuts = "shortcuts"
    case fs = "fs"
    case gui = "gui"
    case app = "app"
    case ipad = "ipad"
    case android = "android"
    case terminal = "terminal"
}

public struct ConcreteAction: Codable, Sendable {
    public var channel: Channel
    public var summary: String
    public var detail: String
    public var targetApp: String?
    public var targetPath: String?

    public init(channel: Channel, summary: String, detail: String, targetApp: String? = nil, targetPath: String? = nil) {
        self.channel = channel
        self.summary = summary
        self.detail = detail
        self.targetApp = targetApp
        self.targetPath = targetPath
    }

    enum CodingKeys: String, CodingKey {
        case channel
        case summary
        case detail
        case targetApp
        case targetPath
    }
}

public struct Cost: Codable, Sendable {
    public var inputTokens: Int
    public var outputTokens: Int
    public var jevTokens: Int?
    public var usd: Double

    public init(inputTokens: Int, outputTokens: Int, jevTokens: Int? = nil, usd: Double) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.jevTokens = jevTokens
        self.usd = usd
    }

    enum CodingKeys: String, CodingKey {
        case inputTokens
        case outputTokens
        case jevTokens
        case usd
    }
}

public enum DevicePlatform: String, Codable, Sendable, CaseIterable {
    case macos = "macos"
    case ios = "ios"
    case ipados = "ipados"
    case android = "android"
    case cloud = "cloud"
}

public struct DeviceStats: Codable, Sendable {
    public var batteryPercent: Double?
    public var charging: Bool?
    public var network: String?
    public var runningApps: [String]
    public var cpuPercent: Double?
    public var memUsedMB: Double?
    public var uptimeSec: Double?

    public init(batteryPercent: Double? = nil, charging: Bool? = nil, network: String? = nil, runningApps: [String], cpuPercent: Double? = nil, memUsedMB: Double? = nil, uptimeSec: Double? = nil) {
        self.batteryPercent = batteryPercent
        self.charging = charging
        self.network = network
        self.runningApps = runningApps
        self.cpuPercent = cpuPercent
        self.memUsedMB = memUsedMB
        self.uptimeSec = uptimeSec
    }

    enum CodingKeys: String, CodingKey {
        case batteryPercent
        case charging
        case network
        case runningApps
        case cpuPercent
        case memUsedMB
        case uptimeSec
    }
}

public struct HistoryItem: Codable, Sendable {
    public var runId: String
    public var deviceId: String
    public var intent: String
    public var startedAt: Int
    public var finishedAt: Int?
    public var ok: Bool?
    public var summary: String?
    public var cost: Cost?
    public var stepCount: Int?

    public init(runId: String, deviceId: String, intent: String, startedAt: Int, finishedAt: Int? = nil, ok: Bool? = nil, summary: String? = nil, cost: Cost? = nil, stepCount: Int? = nil) {
        self.runId = runId
        self.deviceId = deviceId
        self.intent = intent
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.ok = ok
        self.summary = summary
        self.cost = cost
        self.stepCount = stepCount
    }

    enum CodingKeys: String, CodingKey {
        case runId
        case deviceId
        case intent
        case startedAt
        case finishedAt
        case ok
        case summary
        case cost
        case stepCount
    }
}

public enum ModelTier: String, Codable, Sendable, CaseIterable {
    case standard = "standard"
    case zdr = "zdr"
    case byok = "byok"
    case local = "local"
}

public struct ModelEntry: Codable, Sendable {
    public var id: String
    public var label: String
    public var provider: String
    public var tier: ModelTier
    public var zdr: Bool
    public var vision: Bool
    public var priceIn: Double
    public var priceOut: Double
    public var available: Bool
    public var unavailableReason: String?
    public var custom: Bool?

    public init(id: String, label: String, provider: String, tier: ModelTier, zdr: Bool, vision: Bool, priceIn: Double, priceOut: Double, available: Bool, unavailableReason: String? = nil, custom: Bool? = nil) {
        self.id = id
        self.label = label
        self.provider = provider
        self.tier = tier
        self.zdr = zdr
        self.vision = vision
        self.priceIn = priceIn
        self.priceOut = priceOut
        self.available = available
        self.unavailableReason = unavailableReason
        self.custom = custom
    }

    enum CodingKeys: String, CodingKey {
        case id
        case label
        case provider
        case tier
        case zdr
        case vision
        case priceIn
        case priceOut
        case available
        case unavailableReason
        case custom
    }
}

public enum PlanStepStatus: String, Codable, Sendable, CaseIterable {
    case pending = "pending"
    case running = "running"
    case awaitingApproval = "awaiting_approval"
    case done = "done"
    case failed = "failed"
    case skipped = "skipped"
    case cancelled = "cancelled"
}

public struct PlanStep: Codable, Sendable {
    public var id: String
    public var title: String
    public var channel: Channel?
    public var staticLevel: Level?
    public var status: PlanStepStatus

    public init(id: String, title: String, channel: Channel? = nil, staticLevel: Level? = nil, status: PlanStepStatus) {
        self.id = id
        self.title = title
        self.channel = channel
        self.staticLevel = staticLevel
        self.status = status
    }

    enum CodingKeys: String, CodingKey {
        case id
        case title
        case channel
        case staticLevel
        case status
    }
}

public enum PrecheckSource: String, Codable, Sendable, CaseIterable {
    case jev = "jev"
    case static = "static"
    case cache = "cache"
    case fallback = "fallback"
}

public enum PrivacyPreset: String, Codable, Sendable, CaseIterable {
    case allLocal = "all_local"
    case balanced = "balanced"
    case allCloud = "all_cloud"
}

public struct SyncSettings: Codable, Sendable {
    public var history: Bool
    public var screenshots: Bool
    public var logs: Bool
    public var shortcuts: Bool

    public init(history: Bool, screenshots: Bool, logs: Bool, shortcuts: Bool) {
        self.history = history
        self.screenshots = screenshots
        self.logs = logs
        self.shortcuts = shortcuts
    }

    enum CodingKeys: String, CodingKey {
        case history
        case screenshots
        case logs
        case shortcuts
    }
}

public enum PrivacySettingsAutonomy: String, Codable, Sendable, CaseIterable {
    case cautious = "cautious"
    case balanced = "balanced"
    case handsoff = "handsoff"
}

public struct PrivacySettings: Codable, Sendable {
    public var brainLocation: BrainLocation
    public var brainDeviceId: String?
    public var sync: SyncSettings
    public var modelTier: ModelTier
    public var localBrainModel: String?
    public var cloudModel: String?
    public var localGuiModel: String?
    public var jevEnabled: Bool
    public var autonomy: PrivacySettingsAutonomy

    public init(brainLocation: BrainLocation, brainDeviceId: String? = nil, sync: SyncSettings, modelTier: ModelTier, localBrainModel: String? = nil, cloudModel: String? = nil, localGuiModel: String? = nil, jevEnabled: Bool, autonomy: PrivacySettingsAutonomy) {
        self.brainLocation = brainLocation
        self.brainDeviceId = brainDeviceId
        self.sync = sync
        self.modelTier = modelTier
        self.localBrainModel = localBrainModel
        self.cloudModel = cloudModel
        self.localGuiModel = localGuiModel
        self.jevEnabled = jevEnabled
        self.autonomy = autonomy
    }

    enum CodingKeys: String, CodingKey {
        case brainLocation
        case brainDeviceId
        case sync
        case modelTier
        case localBrainModel
        case cloudModel
        case localGuiModel
        case jevEnabled
        case autonomy
    }
}

public enum PublicKeysSigAlg: String, Codable, Sendable, CaseIterable {
    case eS256 = "ES256"
    case ed25519 = "Ed25519"
}

public struct PublicKeys: Codable, Sendable {
    public var kem: String
    public var sig: String
    public var sigAlg: PublicKeysSigAlg

    public init(kem: String, sig: String, sigAlg: PublicKeysSigAlg) {
        self.kem = kem
        self.sig = sig
        self.sigAlg = sigAlg
    }

    enum CodingKeys: String, CodingKey {
        case kem
        case sig
        case sigAlg
    }
}

public struct Scope: Codable, Sendable {
    public var allowedDirs: [String]
    public var allowedApps: [String]
    public var deniedCommands: [String]

    public init(allowedDirs: [String], allowedApps: [String], deniedCommands: [String]) {
        self.allowedDirs = allowedDirs
        self.allowedApps = allowedApps
        self.deniedCommands = deniedCommands
    }

    enum CodingKeys: String, CodingKey {
        case allowedDirs
        case allowedApps
        case deniedCommands
    }
}

public enum ShortcutRunIn: String, Codable, Sendable, CaseIterable {
    case agent = "agent"
    case terminal = "terminal"
    case ssh = "ssh"
}

public struct Shortcut: Codable, Sendable {
    public var id: String
    public var name: String
    public var body: String
    public var runIn: ShortcutRunIn
    public var sshHostId: String?
    public var level: Level

    public init(id: String, name: String, body: String, runIn: ShortcutRunIn, sshHostId: String? = nil, level: Level) {
        self.id = id
        self.name = name
        self.body = body
        self.runIn = runIn
        self.sshHostId = sshHostId
        self.level = level
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case body
        case runIn
        case sshHostId
        case level
    }
}

public enum SyncKind: String, Codable, Sendable, CaseIterable {
    case history = "history"
    case shortcuts = "shortcuts"
    case logs = "logs"
    case screenshots = "screenshots"
}

public struct SyncBlob: Codable, Sendable {
    public var kind: SyncKind
    public var id: String
    public var deviceId: String
    public var ts: Int
    public var keyId: String
    public var alg: String
    public var nonce: String
    public var ct: String

    public init(kind: SyncKind, id: String, deviceId: String, ts: Int, keyId: String, alg: String, nonce: String, ct: String) {
        self.kind = kind
        self.id = id
        self.deviceId = deviceId
        self.ts = ts
        self.keyId = keyId
        self.alg = alg
        self.nonce = nonce
        self.ct = ct
    }

    enum CodingKeys: String, CodingKey {
        case kind
        case id
        case deviceId
        case ts
        case keyId
        case alg
        case nonce
        case ct
    }
}

public enum TerminalBlockState: String, Codable, Sendable, CaseIterable {
    case prompt = "prompt"
    case running = "running"
    case done = "done"
}

public struct TerminalBlock: Codable, Sendable {
    public var sessionId: String
    public var blockId: Int
    public var state: TerminalBlockState
    public var command: String?
    public var cwd: String?
    public var exitCode: Int?
    public var startedAt: Int
    public var finishedAt: Int?
    public var startOffset: Int
    public var outputOffset: Int?
    public var endOffset: Int?

    public init(sessionId: String, blockId: Int, state: TerminalBlockState, command: String? = nil, cwd: String? = nil, exitCode: Int? = nil, startedAt: Int, finishedAt: Int? = nil, startOffset: Int, outputOffset: Int? = nil, endOffset: Int? = nil) {
        self.sessionId = sessionId
        self.blockId = blockId
        self.state = state
        self.command = command
        self.cwd = cwd
        self.exitCode = exitCode
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.startOffset = startOffset
        self.outputOffset = outputOffset
        self.endOffset = endOffset
    }

    enum CodingKeys: String, CodingKey {
        case sessionId
        case blockId
        case state
        case command
        case cwd
        case exitCode
        case startedAt
        case finishedAt
        case startOffset
        case outputOffset
        case endOffset
    }
}

public enum ToolDescriptorCostClass: Int, Codable, Sendable, CaseIterable, Comparable {
    case l0 = 0
    case l1 = 1
    case l2 = 2
    public static func < (a: ToolDescriptorCostClass, b: ToolDescriptorCostClass) -> Bool { a.rawValue < b.rawValue }
}

public struct ToolDescriptor: Codable, Sendable {
    public var name: String
    public var description: String
    public var channel: Channel
    public var staticLevel: Level
    public var costClass: ToolDescriptorCostClass
    public var dataLeavesDevice: Bool
    public var inputSchema: [String: JSONValue]

    public init(name: String, description: String, channel: Channel, staticLevel: Level, costClass: ToolDescriptorCostClass, dataLeavesDevice: Bool, inputSchema: [String: JSONValue]) {
        self.name = name
        self.description = description
        self.channel = channel
        self.staticLevel = staticLevel
        self.costClass = costClass
        self.dataLeavesDevice = dataLeavesDevice
        self.inputSchema = inputSchema
    }

    enum CodingKeys: String, CodingKey {
        case name
        case description
        case channel
        case staticLevel
        case costClass
        case dataLeavesDevice
        case inputSchema
    }
}

public enum Verdict: String, Codable, Sendable, CaseIterable {
    case allow = "allow"
    case confirm = "confirm"
    case deny = "deny"
}

public struct PairOffer: Codable, Sendable {
    public var hubURL: String
    public var deviceId: String
    public var name: String
    public var pubKeys: PublicKeys
    public var secret: String
    public var expiresAt: Int

    public init(hubURL: String, deviceId: String, name: String, pubKeys: PublicKeys, secret: String, expiresAt: Int) {
        self.hubURL = hubURL
        self.deviceId = deviceId
        self.name = name
        self.pubKeys = pubKeys
        self.secret = secret
        self.expiresAt = expiresAt
    }

    enum CodingKeys: String, CodingKey {
        case hubURL
        case deviceId
        case name
        case pubKeys
        case secret
        case expiresAt
    }
}

public enum IntentSubmitMode: String, Codable, Sendable, CaseIterable {
    case agent = "agent"
    case terminal = "terminal"
}

public struct IntentSubmit: Codable, Sendable {
    public static let messageType = "intent.submit"
    public var v: Int = 1
    public var id: String
    public var type: String = "intent.submit"
    public var text: String
    public var deviceId: String
    public var mode: IntentSubmitMode
    public var provider: String?
    public var terminalSessionId: String?

    public init(id: String, text: String, deviceId: String, mode: IntentSubmitMode, provider: String? = nil, terminalSessionId: String? = nil) {
        self.id = id
        self.text = text
        self.deviceId = deviceId
        self.mode = mode
        self.provider = provider
        self.terminalSessionId = terminalSessionId
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case text
        case deviceId
        case mode
        case provider
        case terminalSessionId
    }
}

public struct RunCancel: Codable, Sendable {
    public static let messageType = "run.cancel"
    public var v: Int = 1
    public var id: String
    public var type: String = "run.cancel"
    public var runId: String

    public init(id: String, runId: String) {
        self.id = id
        self.runId = runId
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case runId
    }
}

public enum ApprovalDecisionRemember: String, Codable, Sendable, CaseIterable {
    case once = "once"
    case always = "always"
}

public struct ApprovalDecision: Codable, Sendable {
    public static let messageType = "approval.decision"
    public var v: Int = 1
    public var id: String
    public var type: String = "approval.decision"
    public var runId: String
    public var stepId: String
    public var allow: Bool
    public var remember: ApprovalDecisionRemember?
    public var signature: ApprovalSignature?

    public init(id: String, runId: String, stepId: String, allow: Bool, remember: ApprovalDecisionRemember? = nil, signature: ApprovalSignature? = nil) {
        self.id = id
        self.runId = runId
        self.stepId = stepId
        self.allow = allow
        self.remember = remember
        self.signature = signature
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case runId
        case stepId
        case allow
        case remember
        case signature
    }
}

public struct TerminalOpen: Codable, Sendable {
    public static let messageType = "terminal.open"
    public var v: Int = 1
    public var id: String
    public var type: String = "terminal.open"
    public var sessionId: String
    public var cols: Int
    public var rows: Int
    public var cwd: String?
    public var signature: ApprovalSignature?

    public init(id: String, sessionId: String, cols: Int, rows: Int, cwd: String? = nil, signature: ApprovalSignature? = nil) {
        self.id = id
        self.sessionId = sessionId
        self.cols = cols
        self.rows = rows
        self.cwd = cwd
        self.signature = signature
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case sessionId
        case cols
        case rows
        case cwd
        case signature
    }
}

public struct TerminalResize: Codable, Sendable {
    public static let messageType = "terminal.resize"
    public var v: Int = 1
    public var id: String
    public var type: String = "terminal.resize"
    public var sessionId: String
    public var cols: Int
    public var rows: Int

    public init(id: String, sessionId: String, cols: Int, rows: Int) {
        self.id = id
        self.sessionId = sessionId
        self.cols = cols
        self.rows = rows
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case sessionId
        case cols
        case rows
    }
}

public struct TerminalClose: Codable, Sendable {
    public static let messageType = "terminal.close"
    public var v: Int = 1
    public var id: String
    public var type: String = "terminal.close"
    public var sessionId: String

    public init(id: String, sessionId: String) {
        self.id = id
        self.sessionId = sessionId
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case sessionId
    }
}

public struct TerminalAck: Codable, Sendable {
    public static let messageType = "terminal.ack"
    public var v: Int = 1
    public var id: String
    public var type: String = "terminal.ack"
    public var sessionId: String
    public var bytes: Int

    public init(id: String, sessionId: String, bytes: Int) {
        self.id = id
        self.sessionId = sessionId
        self.bytes = bytes
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case sessionId
        case bytes
    }
}

public enum MediaSubscribeCodec: String, Codable, Sendable, CaseIterable {
    case jpeg = "jpeg"
    case h264 = "h264"
}

public struct MediaSubscribe: Codable, Sendable {
    public static let messageType = "media.subscribe"
    public var v: Int = 1
    public var id: String
    public var type: String = "media.subscribe"
    public var fps: Double
    public var maxWidth: Int
    public var codec: MediaSubscribeCodec?

    public init(id: String, fps: Double, maxWidth: Int, codec: MediaSubscribeCodec? = nil) {
        self.id = id
        self.fps = fps
        self.maxWidth = maxWidth
        self.codec = codec
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case fps
        case maxWidth
        case codec
    }
}

public struct MediaUnsubscribe: Codable, Sendable {
    public static let messageType = "media.unsubscribe"
    public var v: Int = 1
    public var id: String
    public var type: String = "media.unsubscribe"

    public init(id: String) {
        self.id = id
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
    }
}

public struct StatsGet: Codable, Sendable {
    public static let messageType = "stats.get"
    public var v: Int = 1
    public var id: String
    public var type: String = "stats.get"

    public init(id: String) {
        self.id = id
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
    }
}

public struct ShortcutRun: Codable, Sendable {
    public static let messageType = "shortcut.run"
    public var v: Int = 1
    public var id: String
    public var type: String = "shortcut.run"
    public var shortcutId: String
    public var params: [String: String]?

    public init(id: String, shortcutId: String, params: [String: String]? = nil) {
        self.id = id
        self.shortcutId = shortcutId
        self.params = params
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case shortcutId
        case params
    }
}

public struct HistoryList: Codable, Sendable {
    public static let messageType = "history.list"
    public var v: Int = 1
    public var id: String
    public var type: String = "history.list"
    public var cursor: String?
    public var limit: Int?

    public init(id: String, cursor: String? = nil, limit: Int? = nil) {
        self.id = id
        self.cursor = cursor
        self.limit = limit
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case cursor
        case limit
    }
}

public struct PrivacySet: Codable, Sendable {
    public static let messageType = "privacy.set"
    public var v: Int = 1
    public var id: String
    public var type: String = "privacy.set"
    public var settings: PrivacySettings

    public init(id: String, settings: PrivacySettings) {
        self.id = id
        self.settings = settings
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case settings
    }
}

public struct PrivacyGet: Codable, Sendable {
    public static let messageType = "privacy.get"
    public var v: Int = 1
    public var id: String
    public var type: String = "privacy.get"

    public init(id: String) {
        self.id = id
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
    }
}

public struct ScopeSet: Codable, Sendable {
    public static let messageType = "scope.set"
    public var v: Int = 1
    public var id: String
    public var type: String = "scope.set"
    public var scope: Scope

    public init(id: String, scope: Scope) {
        self.id = id
        self.scope = scope
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case scope
    }
}

public struct AppLearnStart: Codable, Sendable {
    public static let messageType = "app.learn.start"
    public var v: Int = 1
    public var id: String
    public var type: String = "app.learn.start"
    public var bundleId: String
    public var explore: Bool?
    public var deviceId: String?

    public init(id: String, bundleId: String, explore: Bool? = nil, deviceId: String? = nil) {
        self.id = id
        self.bundleId = bundleId
        self.explore = explore
        self.deviceId = deviceId
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case bundleId
        case explore
        case deviceId
    }
}

public struct AppLearnStop: Codable, Sendable {
    public static let messageType = "app.learn.stop"
    public var v: Int = 1
    public var id: String
    public var type: String = "app.learn.stop"
    public var bundleId: String

    public init(id: String, bundleId: String) {
        self.id = id
        self.bundleId = bundleId
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case bundleId
    }
}

public struct AppCardRun: Codable, Sendable {
    public static let messageType = "app.card.run"
    public var v: Int = 1
    public var id: String
    public var type: String = "app.card.run"
    public var cardId: String
    public var params: [String: String]?
    public var deviceId: String?

    public init(id: String, cardId: String, params: [String: String]? = nil, deviceId: String? = nil) {
        self.id = id
        self.cardId = cardId
        self.params = params
        self.deviceId = deviceId
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case cardId
        case params
        case deviceId
    }
}

public struct AppCardsGet: Codable, Sendable {
    public static let messageType = "app.cards.get"
    public var v: Int = 1
    public var id: String
    public var type: String = "app.cards.get"
    public var bundleId: String?

    public init(id: String, bundleId: String? = nil) {
        self.id = id
        self.bundleId = bundleId
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case bundleId
    }
}

public struct CapabilitiesGet: Codable, Sendable {
    public static let messageType = "capabilities.get"
    public var v: Int = 1
    public var id: String
    public var type: String = "capabilities.get"

    public init(id: String) {
        self.id = id
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
    }
}

public struct ModelsList: Codable, Sendable {
    public static let messageType = "models.list"
    public var v: Int = 1
    public var id: String
    public var type: String = "models.list"

    public init(id: String) {
        self.id = id
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
    }
}

public struct SyncKey: Codable, Sendable {
    public static let messageType = "sync.key"
    public var v: Int = 1
    public var id: String
    public var type: String = "sync.key"
    public var keyId: String
    public var key: String

    public init(id: String, keyId: String, key: String) {
        self.id = id
        self.keyId = keyId
        self.key = key
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case keyId
        case key
    }
}

public struct RunCreated: Codable, Sendable {
    public static let messageType = "run.created"
    public var v: Int = 1
    public var id: String
    public var type: String = "run.created"
    public var runId: String
    public var deviceId: String
    public var intent: String
    public var provider: String
    public var plan: [PlanStep]

    public init(id: String, runId: String, deviceId: String, intent: String, provider: String, plan: [PlanStep]) {
        self.id = id
        self.runId = runId
        self.deviceId = deviceId
        self.intent = intent
        self.provider = provider
        self.plan = plan
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case runId
        case deviceId
        case intent
        case provider
        case plan
    }
}

public struct PlanUpdated: Codable, Sendable {
    public static let messageType = "plan.updated"
    public var v: Int = 1
    public var id: String
    public var type: String = "plan.updated"
    public var runId: String
    public var plan: [PlanStep]

    public init(id: String, runId: String, plan: [PlanStep]) {
        self.id = id
        self.runId = runId
        self.plan = plan
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case runId
        case plan
    }
}

public struct StepStarted: Codable, Sendable {
    public static let messageType = "step.started"
    public var v: Int = 1
    public var id: String
    public var type: String = "step.started"
    public var runId: String
    public var stepId: String
    public var title: String
    public var channel: Channel?

    public init(id: String, runId: String, stepId: String, title: String, channel: Channel? = nil) {
        self.id = id
        self.runId = runId
        self.stepId = stepId
        self.title = title
        self.channel = channel
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case runId
        case stepId
        case title
        case channel
    }
}

public struct StepPrecheck: Codable, Sendable {
    public static let messageType = "step.precheck"
    public var v: Int = 1
    public var id: String
    public var type: String = "step.precheck"
    public var runId: String
    public var stepId: String
    public var staticLevel: Level
    public var level: Level
    public var intentMatch: Bool?
    public var risk: Double?
    public var confidence: Double?
    public var jevMs: Double?
    public var verdict: Verdict
    public var source: PrecheckSource

    public init(id: String, runId: String, stepId: String, staticLevel: Level, level: Level, intentMatch: Bool? = nil, risk: Double? = nil, confidence: Double? = nil, jevMs: Double? = nil, verdict: Verdict, source: PrecheckSource) {
        self.id = id
        self.runId = runId
        self.stepId = stepId
        self.staticLevel = staticLevel
        self.level = level
        self.intentMatch = intentMatch
        self.risk = risk
        self.confidence = confidence
        self.jevMs = jevMs
        self.verdict = verdict
        self.source = source
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case runId
        case stepId
        case staticLevel
        case level
        case intentMatch
        case risk
        case confidence
        case jevMs
        case verdict
        case source
    }
}

public struct StepApprovalRequired: Codable, Sendable {
    public static let messageType = "step.approval_required"
    public var v: Int = 1
    public var id: String
    public var type: String = "step.approval_required"
    public var runId: String
    public var stepId: String
    public var level: Level
    public var action: ConcreteAction
    public var reason: String
    public var expiresAt: Int
    public var challenge: String

    public init(id: String, runId: String, stepId: String, level: Level, action: ConcreteAction, reason: String, expiresAt: Int, challenge: String) {
        self.id = id
        self.runId = runId
        self.stepId = stepId
        self.level = level
        self.action = action
        self.reason = reason
        self.expiresAt = expiresAt
        self.challenge = challenge
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case runId
        case stepId
        case level
        case action
        case reason
        case expiresAt
        case challenge
    }
}

public struct StepFinished: Codable, Sendable {
    public static let messageType = "step.finished"
    public var v: Int = 1
    public var id: String
    public var type: String = "step.finished"
    public var runId: String
    public var stepId: String
    public var ok: Bool
    public var ms: Double
    public var channel: Channel?
    public var cost: Cost?
    public var dataLeftDevice: Bool
    public var output: String?
    public var error: String?

    public init(id: String, runId: String, stepId: String, ok: Bool, ms: Double, channel: Channel? = nil, cost: Cost? = nil, dataLeftDevice: Bool, output: String? = nil, error: String? = nil) {
        self.id = id
        self.runId = runId
        self.stepId = stepId
        self.ok = ok
        self.ms = ms
        self.channel = channel
        self.cost = cost
        self.dataLeftDevice = dataLeftDevice
        self.output = output
        self.error = error
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case runId
        case stepId
        case ok
        case ms
        case channel
        case cost
        case dataLeftDevice
        case output
        case error
    }
}

public struct RunFinished: Codable, Sendable {
    public static let messageType = "run.finished"
    public var v: Int = 1
    public var id: String
    public var type: String = "run.finished"
    public var runId: String
    public var ok: Bool
    public var summary: String
    public var cost: Cost
    public var stepCount: Int
    public var cancelled: Bool?

    public init(id: String, runId: String, ok: Bool, summary: String, cost: Cost, stepCount: Int, cancelled: Bool? = nil) {
        self.id = id
        self.runId = runId
        self.ok = ok
        self.summary = summary
        self.cost = cost
        self.stepCount = stepCount
        self.cancelled = cancelled
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case runId
        case ok
        case summary
        case cost
        case stepCount
        case cancelled
    }
}

public struct TerminalSuggestion: Codable, Sendable {
    public static let messageType = "terminal.suggestion"
    public var v: Int = 1
    public var id: String
    public var type: String = "terminal.suggestion"
    public var runId: String
    public var sessionId: String?
    public var command: String
    public var explanation: String
    public var level: Level

    public init(id: String, runId: String, sessionId: String? = nil, command: String, explanation: String, level: Level) {
        self.id = id
        self.runId = runId
        self.sessionId = sessionId
        self.command = command
        self.explanation = explanation
        self.level = level
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case runId
        case sessionId
        case command
        case explanation
        case level
    }
}

public struct TerminalOpened: Codable, Sendable {
    public static let messageType = "terminal.opened"
    public var v: Int = 1
    public var id: String
    public var type: String = "terminal.opened"
    public var sessionId: String
    public var pid: Int?

    public init(id: String, sessionId: String, pid: Int? = nil) {
        self.id = id
        self.sessionId = sessionId
        self.pid = pid
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case sessionId
        case pid
    }
}

public struct TerminalExit: Codable, Sendable {
    public static let messageType = "terminal.exit"
    public var v: Int = 1
    public var id: String
    public var type: String = "terminal.exit"
    public var sessionId: String
    public var code: Int?

    public init(id: String, sessionId: String, code: Int? = nil) {
        self.id = id
        self.sessionId = sessionId
        self.code = code
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case sessionId
        case code
    }
}

public struct TerminalBlockMsg: Codable, Sendable {
    public static let messageType = "terminal.block"
    public var v: Int = 1
    public var id: String
    public var type: String = "terminal.block"
    public var block: TerminalBlock

    public init(id: String, block: TerminalBlock) {
        self.id = id
        self.block = block
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case block
    }
}

public enum MediaInfoCodec: String, Codable, Sendable, CaseIterable {
    case jpeg = "jpeg"
    case h264 = "h264"
}

public struct MediaInfo: Codable, Sendable {
    public static let messageType = "media.info"
    public var v: Int = 1
    public var id: String
    public var type: String = "media.info"
    public var width: Int
    public var height: Int
    public var codec: MediaInfoCodec
    public var fps: Double

    public init(id: String, width: Int, height: Int, codec: MediaInfoCodec, fps: Double) {
        self.id = id
        self.width = width
        self.height = height
        self.codec = codec
        self.fps = fps
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case width
        case height
        case codec
        case fps
    }
}

public struct Stats: Codable, Sendable {
    public static let messageType = "stats"
    public var v: Int = 1
    public var id: String
    public var type: String = "stats"
    public var deviceId: String
    public var stats: DeviceStats

    public init(id: String, deviceId: String, stats: DeviceStats) {
        self.id = id
        self.deviceId = deviceId
        self.stats = stats
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case deviceId
        case stats
    }
}

public struct Capabilities: Codable, Sendable {
    public static let messageType = "capabilities"
    public var v: Int = 1
    public var id: String
    public var type: String = "capabilities"
    public var deviceId: String
    public var platform: DevicePlatform
    public var name: String
    public var tools: [ToolDescriptor]
    public var scope: Scope
    public var brainAvailable: Bool
    public var brainUnavailableReason: String?
    public var daemonVersion: String

    public init(id: String, deviceId: String, platform: DevicePlatform, name: String, tools: [ToolDescriptor], scope: Scope, brainAvailable: Bool, brainUnavailableReason: String? = nil, daemonVersion: String) {
        self.id = id
        self.deviceId = deviceId
        self.platform = platform
        self.name = name
        self.tools = tools
        self.scope = scope
        self.brainAvailable = brainAvailable
        self.brainUnavailableReason = brainUnavailableReason
        self.daemonVersion = daemonVersion
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case deviceId
        case platform
        case name
        case tools
        case scope
        case brainAvailable
        case brainUnavailableReason
        case daemonVersion
    }
}

public struct PrivacyStateDataFlowItem: Codable, Sendable {
    public var data: String
    public var destination: String
    public var reason: String

    public init(data: String, destination: String, reason: String) {
        self.data = data
        self.destination = destination
        self.reason = reason
    }

    enum CodingKeys: String, CodingKey {
        case data
        case destination
        case reason
    }
}

public struct PrivacyState: Codable, Sendable {
    public static let messageType = "privacy.state"
    public var v: Int = 1
    public var id: String
    public var type: String = "privacy.state"
    public var deviceId: String
    public var settings: PrivacySettings
    public var dataFlow: [PrivacyStateDataFlowItem]

    public init(id: String, deviceId: String, settings: PrivacySettings, dataFlow: [PrivacyStateDataFlowItem]) {
        self.id = id
        self.deviceId = deviceId
        self.settings = settings
        self.dataFlow = dataFlow
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case deviceId
        case settings
        case dataFlow
    }
}

public struct HistoryPage: Codable, Sendable {
    public static let messageType = "history.page"
    public var v: Int = 1
    public var id: String
    public var type: String = "history.page"
    public var items: [HistoryItem]
    public var nextCursor: String?

    public init(id: String, items: [HistoryItem], nextCursor: String? = nil) {
        self.id = id
        self.items = items
        self.nextCursor = nextCursor
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case items
        case nextCursor
    }
}

public enum AppLearnProgressPhase: String, Codable, Sendable, CaseIterable {
    case sdef = "sdef"
    case menu = "menu"
    case window = "window"
    case shortcuts = "shortcuts"
    case explore = "explore"
    case summarize = "summarize"
    case done = "done"
    case failed = "failed"
}

public struct AppLearnProgress: Codable, Sendable {
    public static let messageType = "app.learn.progress"
    public var v: Int = 1
    public var id: String
    public var type: String = "app.learn.progress"
    public var bundleId: String
    public var phase: AppLearnProgressPhase
    public var found: Int
    public var message: String?

    public init(id: String, bundleId: String, phase: AppLearnProgressPhase, found: Int, message: String? = nil) {
        self.id = id
        self.bundleId = bundleId
        self.phase = phase
        self.found = found
        self.message = message
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case bundleId
        case phase
        case found
        case message
    }
}

public struct AppCards: Codable, Sendable {
    public static let messageType = "app.cards"
    public var v: Int = 1
    public var id: String
    public var type: String = "app.cards"
    public var cards: [CapabilityCard]

    public init(id: String, cards: [CapabilityCard]) {
        self.id = id
        self.cards = cards
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case cards
    }
}

public struct ModelsCatalog: Codable, Sendable {
    public static let messageType = "models.catalog"
    public var v: Int = 1
    public var id: String
    public var type: String = "models.catalog"
    public var models: [ModelEntry]
    public var defaultModel: String
    public var brainLocation: BrainLocation

    public init(id: String, models: [ModelEntry], defaultModel: String, brainLocation: BrainLocation) {
        self.id = id
        self.models = models
        self.defaultModel = defaultModel
        self.brainLocation = brainLocation
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case models
        case defaultModel
        case brainLocation
    }
}

public struct ShortcutsList: Codable, Sendable {
    public static let messageType = "shortcuts.list"
    public var v: Int = 1
    public var id: String
    public var type: String = "shortcuts.list"
    public var shortcuts: [Shortcut]

    public init(id: String, shortcuts: [Shortcut]) {
        self.id = id
        self.shortcuts = shortcuts
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case shortcuts
    }
}

public struct ErrorMsg: Codable, Sendable {
    public static let messageType = "error"
    public var v: Int = 1
    public var id: String
    public var type: String = "error"
    public var code: String
    public var message: String
    public var ref: String?

    public init(id: String, code: String, message: String, ref: String? = nil) {
        self.id = id
        self.code = code
        self.message = message
        self.ref = ref
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case code
        case message
        case ref
    }
}

public struct Ack: Codable, Sendable {
    public static let messageType = "ack"
    public var v: Int = 1
    public var id: String
    public var type: String = "ack"
    public var ref: String

    public init(id: String, ref: String) {
        self.id = id
        self.ref = ref
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case ref
    }
}

public enum HelloRole: String, Codable, Sendable, CaseIterable {
    case device = "device"
    case phone = "phone"
    case brain = "brain"
}

public struct Hello: Codable, Sendable {
    public static let messageType = "hello"
    public var v: Int = 1
    public var id: String
    public var type: String = "hello"
    public var role: HelloRole
    public var deviceId: String
    public var platform: DevicePlatform
    public var name: String
    public var pubKeys: PublicKeys
    public var protocolVersion: Int
    public var token: String?

    public init(id: String, role: HelloRole, deviceId: String, platform: DevicePlatform, name: String, pubKeys: PublicKeys, protocolVersion: Int, token: String? = nil) {
        self.id = id
        self.role = role
        self.deviceId = deviceId
        self.platform = platform
        self.name = name
        self.pubKeys = pubKeys
        self.protocolVersion = protocolVersion
        self.token = token
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case role
        case deviceId
        case platform
        case name
        case pubKeys
        case protocolVersion
        case token
    }
}

public struct AuthChallenge: Codable, Sendable {
    public static let messageType = "auth.challenge"
    public var v: Int = 1
    public var id: String
    public var type: String = "auth.challenge"
    public var nonce: String

    public init(id: String, nonce: String) {
        self.id = id
        self.nonce = nonce
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case nonce
    }
}

public struct AuthResponse: Codable, Sendable {
    public static let messageType = "auth.response"
    public var v: Int = 1
    public var id: String
    public var type: String = "auth.response"
    public var nonce: String
    public var signature: String

    public init(id: String, nonce: String, signature: String) {
        self.id = id
        self.nonce = nonce
        self.signature = signature
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case nonce
        case signature
    }
}

public struct AuthOk: Codable, Sendable {
    public static let messageType = "auth.ok"
    public var v: Int = 1
    public var id: String
    public var type: String = "auth.ok"
    public var sessionToken: String
    public var expiresAt: Int

    public init(id: String, sessionToken: String, expiresAt: Int) {
        self.id = id
        self.sessionToken = sessionToken
        self.expiresAt = expiresAt
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case sessionToken
        case expiresAt
    }
}

public struct Presence: Codable, Sendable {
    public static let messageType = "presence"
    public var v: Int = 1
    public var id: String
    public var type: String = "presence"
    public var deviceId: String
    public var online: Bool
    public var lastSeen: Int

    public init(id: String, deviceId: String, online: Bool, lastSeen: Int) {
        self.id = id
        self.deviceId = deviceId
        self.online = online
        self.lastSeen = lastSeen
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case deviceId
        case online
        case lastSeen
    }
}

public struct PeerKeys: Codable, Sendable {
    public static let messageType = "peer.keys"
    public var v: Int = 1
    public var id: String
    public var type: String = "peer.keys"
    public var deviceId: String
    public var pubKeys: PublicKeys

    public init(id: String, deviceId: String, pubKeys: PublicKeys) {
        self.id = id
        self.deviceId = deviceId
        self.pubKeys = pubKeys
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case deviceId
        case pubKeys
    }
}

public enum PushRegisterPlatform: String, Codable, Sendable, CaseIterable {
    case apns = "apns"
    case fcm = "fcm"
}

public struct PushRegister: Codable, Sendable {
    public static let messageType = "push.register"
    public var v: Int = 1
    public var id: String
    public var type: String = "push.register"
    public var platform: PushRegisterPlatform
    public var token: String
    public var pushKem: String

    public init(id: String, platform: PushRegisterPlatform, token: String, pushKem: String) {
        self.id = id
        self.platform = platform
        self.token = token
        self.pushKem = pushKem
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case platform
        case token
        case pushKem
    }
}

public struct PushSend: Codable, Sendable {
    public static let messageType = "push.send"
    public var v: Int = 1
    public var id: String
    public var type: String = "push.send"
    public var to: String
    public var sealed: String
    public var category: String

    public init(id: String, to: String, sealed: String, category: String) {
        self.id = id
        self.to = to
        self.sealed = sealed
        self.category = category
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case to
        case sealed
        case category
    }
}

public struct UsageReport: Codable, Sendable {
    public static let messageType = "usage.report"
    public var v: Int = 1
    public var id: String
    public var type: String = "usage.report"
    public var runId: String
    public var cost: Cost
    public var steps: Int
    public var jevCalls: Int

    public init(id: String, runId: String, cost: Cost, steps: Int, jevCalls: Int) {
        self.id = id
        self.runId = runId
        self.cost = cost
        self.steps = steps
        self.jevCalls = jevCalls
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case runId
        case cost
        case steps
        case jevCalls
    }
}

public struct PairRequest: Codable, Sendable {
    public static let messageType = "pair.request"
    public var v: Int = 1
    public var id: String
    public var type: String = "pair.request"
    public var deviceId: String
    public var phoneId: String
    public var phoneName: String
    public var phonePubKeys: PublicKeys
    public var hmac: String

    public init(id: String, deviceId: String, phoneId: String, phoneName: String, phonePubKeys: PublicKeys, hmac: String) {
        self.id = id
        self.deviceId = deviceId
        self.phoneId = phoneId
        self.phoneName = phoneName
        self.phonePubKeys = phonePubKeys
        self.hmac = hmac
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case deviceId
        case phoneId
        case phoneName
        case phonePubKeys
        case hmac
    }
}

public struct PairConfirm: Codable, Sendable {
    public static let messageType = "pair.confirm"
    public var v: Int = 1
    public var id: String
    public var type: String = "pair.confirm"
    public var deviceId: String
    public var phoneId: String
    public var accept: Bool

    public init(id: String, deviceId: String, phoneId: String, accept: Bool) {
        self.id = id
        self.deviceId = deviceId
        self.phoneId = phoneId
        self.accept = accept
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case deviceId
        case phoneId
        case accept
    }
}

public struct PairResult: Codable, Sendable {
    public static let messageType = "pair.result"
    public var v: Int = 1
    public var id: String
    public var type: String = "pair.result"
    public var deviceId: String
    public var phoneId: String
    public var ok: Bool
    public var reason: String?

    public init(id: String, deviceId: String, phoneId: String, ok: Bool, reason: String? = nil) {
        self.id = id
        self.deviceId = deviceId
        self.phoneId = phoneId
        self.ok = ok
        self.reason = reason
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case deviceId
        case phoneId
        case ok
        case reason
    }
}

public struct PairCodeClaim: Codable, Sendable {
    public static let messageType = "pair.code.claim"
    public var v: Int = 1
    public var id: String
    public var type: String = "pair.code.claim"
    public var code: String
    public var phoneId: String
    public var phonePubKeys: PublicKeys

    public init(id: String, code: String, phoneId: String, phonePubKeys: PublicKeys) {
        self.id = id
        self.code = code
        self.phoneId = phoneId
        self.phonePubKeys = phonePubKeys
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case code
        case phoneId
        case phonePubKeys
    }
}

public struct PairOfferMsg: Codable, Sendable {
    public static let messageType = "pair.offer"
    public var v: Int = 1
    public var id: String
    public var type: String = "pair.offer"
    public var hubURL: String
    public var deviceId: String
    public var name: String
    public var pubKeys: PublicKeys
    public var secret: String
    public var expiresAt: Int

    public init(id: String, hubURL: String, deviceId: String, name: String, pubKeys: PublicKeys, secret: String, expiresAt: Int) {
        self.id = id
        self.hubURL = hubURL
        self.deviceId = deviceId
        self.name = name
        self.pubKeys = pubKeys
        self.secret = secret
        self.expiresAt = expiresAt
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case hubURL
        case deviceId
        case name
        case pubKeys
        case secret
        case expiresAt
    }
}

public struct SyncPut: Codable, Sendable {
    public static let messageType = "sync.put"
    public var v: Int = 1
    public var id: String
    public var type: String = "sync.put"
    public var items: [SyncBlob]

    public init(id: String, items: [SyncBlob]) {
        self.id = id
        self.items = items
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case items
    }
}

public struct SyncPull: Codable, Sendable {
    public static let messageType = "sync.pull"
    public var v: Int = 1
    public var id: String
    public var type: String = "sync.pull"
    public var kind: SyncKind
    public var cursor: String?
    public var limit: Int?

    public init(id: String, kind: SyncKind, cursor: String? = nil, limit: Int? = nil) {
        self.id = id
        self.kind = kind
        self.cursor = cursor
        self.limit = limit
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case kind
        case cursor
        case limit
    }
}

public struct SyncPage: Codable, Sendable {
    public static let messageType = "sync.page"
    public var v: Int = 1
    public var id: String
    public var type: String = "sync.page"
    public var kind: SyncKind
    public var items: [SyncBlob]
    public var cursor: String?
    public var more: Bool

    public init(id: String, kind: SyncKind, items: [SyncBlob], cursor: String? = nil, more: Bool) {
        self.id = id
        self.kind = kind
        self.items = items
        self.cursor = cursor
        self.more = more
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case kind
        case items
        case cursor
        case more
    }
}

public struct SyncDelete: Codable, Sendable {
    public static let messageType = "sync.delete"
    public var v: Int = 1
    public var id: String
    public var type: String = "sync.delete"
    public var kind: SyncKind
    public var ids: [String]?

    public init(id: String, kind: SyncKind, ids: [String]? = nil) {
        self.id = id
        self.kind = kind
        self.ids = ids
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case kind
        case ids
    }
}

public struct ToolsList: Codable, Sendable {
    public static let messageType = "tools.list"
    public var v: Int = 1
    public var id: String
    public var type: String = "tools.list"

    public init(id: String) {
        self.id = id
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
    }
}

public struct ToolsListResult: Codable, Sendable {
    public static let messageType = "tools.list.result"
    public var v: Int = 1
    public var id: String
    public var type: String = "tools.list.result"
    public var tools: [ToolDescriptor]
    public var scope: Scope

    public init(id: String, tools: [ToolDescriptor], scope: Scope) {
        self.id = id
        self.tools = tools
        self.scope = scope
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case tools
        case scope
    }
}

public struct ToolsCall: Codable, Sendable {
    public static let messageType = "tools.call"
    public var v: Int = 1
    public var id: String
    public var type: String = "tools.call"
    public var callId: String
    public var tool: String
    public var args: [String: JSONValue]
    public var timeoutMs: Int?

    public init(id: String, callId: String, tool: String, args: [String: JSONValue], timeoutMs: Int? = nil) {
        self.id = id
        self.callId = callId
        self.tool = tool
        self.args = args
        self.timeoutMs = timeoutMs
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case callId
        case tool
        case args
        case timeoutMs
    }
}

public enum ToolsResultAttachmentsItemKind: String, Codable, Sendable, CaseIterable {
    case imagejpeg = "image/jpeg"
    case imagepng = "image/png"
    case textplain = "text/plain"
}

public struct ToolsResultAttachmentsItem: Codable, Sendable {
    public var kind: ToolsResultAttachmentsItemKind
    public var streamId: Int?
    public var inline: String?

    public init(kind: ToolsResultAttachmentsItemKind, streamId: Int? = nil, inline: String? = nil) {
        self.kind = kind
        self.streamId = streamId
        self.inline = inline
    }

    enum CodingKeys: String, CodingKey {
        case kind
        case streamId
        case inline
    }
}

public struct ToolsResult: Codable, Sendable {
    public static let messageType = "tools.result"
    public var v: Int = 1
    public var id: String
    public var type: String = "tools.result"
    public var callId: String
    public var ok: Bool
    public var output: String?
    public var attachments: [ToolsResultAttachmentsItem]?
    public var error: String?
    public var ms: Double

    public init(id: String, callId: String, ok: Bool, output: String? = nil, attachments: [ToolsResultAttachmentsItem]? = nil, error: String? = nil, ms: Double) {
        self.id = id
        self.callId = callId
        self.ok = ok
        self.output = output
        self.attachments = attachments
        self.error = error
        self.ms = ms
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case callId
        case ok
        case output
        case attachments
        case error
        case ms
    }
}

public struct EventEmit: Codable, Sendable {
    public static let messageType = "event.emit"
    public var v: Int = 1
    public var id: String
    public var type: String = "event.emit"
    public var event: [String: JSONValue]

    public init(id: String, event: [String: JSONValue]) {
        self.id = id
        self.event = event
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case event
    }
}

public struct ApprovalRequest: Codable, Sendable {
    public static let messageType = "approval.request"
    public var v: Int = 1
    public var id: String
    public var type: String = "approval.request"
    public var runId: String
    public var stepId: String
    public var level: Level
    public var action: ConcreteAction
    public var reason: String
    public var challenge: String
    public var expiresAt: Int

    public init(id: String, runId: String, stepId: String, level: Level, action: ConcreteAction, reason: String, challenge: String, expiresAt: Int) {
        self.id = id
        self.runId = runId
        self.stepId = stepId
        self.level = level
        self.action = action
        self.reason = reason
        self.challenge = challenge
        self.expiresAt = expiresAt
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case runId
        case stepId
        case level
        case action
        case reason
        case challenge
        case expiresAt
    }
}

public enum ApprovalResponseRemember: String, Codable, Sendable, CaseIterable {
    case once = "once"
    case always = "always"
}

public struct ApprovalResponse: Codable, Sendable {
    public static let messageType = "approval.response"
    public var v: Int = 1
    public var id: String
    public var type: String = "approval.response"
    public var runId: String
    public var stepId: String
    public var allow: Bool
    public var remember: ApprovalResponseRemember?
    public var signature: ApprovalSignature?

    public init(id: String, runId: String, stepId: String, allow: Bool, remember: ApprovalResponseRemember? = nil, signature: ApprovalSignature? = nil) {
        self.id = id
        self.runId = runId
        self.stepId = stepId
        self.allow = allow
        self.remember = remember
        self.signature = signature
    }

    enum CodingKeys: String, CodingKey {
        case v
        case id
        case `type`
        case runId
        case stepId
        case allow
        case remember
        case signature
    }
}

/// 所有控制消息的类型安全包装；按 `type` 字段解码。
public enum AnyMessage: Codable, Sendable {
    case intentSubmit(IntentSubmit)
    case runCancel(RunCancel)
    case approvalDecision(ApprovalDecision)
    case terminalOpen(TerminalOpen)
    case terminalResize(TerminalResize)
    case terminalClose(TerminalClose)
    case terminalAck(TerminalAck)
    case mediaSubscribe(MediaSubscribe)
    case mediaUnsubscribe(MediaUnsubscribe)
    case statsGet(StatsGet)
    case shortcutRun(ShortcutRun)
    case historyList(HistoryList)
    case privacySet(PrivacySet)
    case privacyGet(PrivacyGet)
    case scopeSet(ScopeSet)
    case appLearnStart(AppLearnStart)
    case appLearnStop(AppLearnStop)
    case appCardRun(AppCardRun)
    case appCardsGet(AppCardsGet)
    case capabilitiesGet(CapabilitiesGet)
    case modelsList(ModelsList)
    case syncKey(SyncKey)
    case runCreated(RunCreated)
    case planUpdated(PlanUpdated)
    case stepStarted(StepStarted)
    case stepPrecheck(StepPrecheck)
    case stepApprovalRequired(StepApprovalRequired)
    case stepFinished(StepFinished)
    case runFinished(RunFinished)
    case terminalSuggestion(TerminalSuggestion)
    case terminalOpened(TerminalOpened)
    case terminalExit(TerminalExit)
    case terminalBlockMsg(TerminalBlockMsg)
    case mediaInfo(MediaInfo)
    case stats(Stats)
    case capabilities(Capabilities)
    case privacyState(PrivacyState)
    case historyPage(HistoryPage)
    case appLearnProgress(AppLearnProgress)
    case appCards(AppCards)
    case modelsCatalog(ModelsCatalog)
    case shortcutsList(ShortcutsList)
    case errorMsg(ErrorMsg)
    case ack(Ack)
    case hello(Hello)
    case authChallenge(AuthChallenge)
    case authResponse(AuthResponse)
    case authOk(AuthOk)
    case presence(Presence)
    case peerKeys(PeerKeys)
    case pushRegister(PushRegister)
    case pushSend(PushSend)
    case usageReport(UsageReport)
    case pairRequest(PairRequest)
    case pairConfirm(PairConfirm)
    case pairResult(PairResult)
    case pairCodeClaim(PairCodeClaim)
    case pairOfferMsg(PairOfferMsg)
    case syncPut(SyncPut)
    case syncPull(SyncPull)
    case syncPage(SyncPage)
    case syncDelete(SyncDelete)
    case toolsList(ToolsList)
    case toolsListResult(ToolsListResult)
    case toolsCall(ToolsCall)
    case toolsResult(ToolsResult)
    case eventEmit(EventEmit)
    case approvalRequest(ApprovalRequest)
    case approvalResponse(ApprovalResponse)

    private struct Peek: Decodable { let type: String }

    public var typeName: String {
        switch self {
        case .intentSubmit: return "intent.submit"
        case .runCancel: return "run.cancel"
        case .approvalDecision: return "approval.decision"
        case .terminalOpen: return "terminal.open"
        case .terminalResize: return "terminal.resize"
        case .terminalClose: return "terminal.close"
        case .terminalAck: return "terminal.ack"
        case .mediaSubscribe: return "media.subscribe"
        case .mediaUnsubscribe: return "media.unsubscribe"
        case .statsGet: return "stats.get"
        case .shortcutRun: return "shortcut.run"
        case .historyList: return "history.list"
        case .privacySet: return "privacy.set"
        case .privacyGet: return "privacy.get"
        case .scopeSet: return "scope.set"
        case .appLearnStart: return "app.learn.start"
        case .appLearnStop: return "app.learn.stop"
        case .appCardRun: return "app.card.run"
        case .appCardsGet: return "app.cards.get"
        case .capabilitiesGet: return "capabilities.get"
        case .modelsList: return "models.list"
        case .syncKey: return "sync.key"
        case .runCreated: return "run.created"
        case .planUpdated: return "plan.updated"
        case .stepStarted: return "step.started"
        case .stepPrecheck: return "step.precheck"
        case .stepApprovalRequired: return "step.approval_required"
        case .stepFinished: return "step.finished"
        case .runFinished: return "run.finished"
        case .terminalSuggestion: return "terminal.suggestion"
        case .terminalOpened: return "terminal.opened"
        case .terminalExit: return "terminal.exit"
        case .terminalBlockMsg: return "terminal.block"
        case .mediaInfo: return "media.info"
        case .stats: return "stats"
        case .capabilities: return "capabilities"
        case .privacyState: return "privacy.state"
        case .historyPage: return "history.page"
        case .appLearnProgress: return "app.learn.progress"
        case .appCards: return "app.cards"
        case .modelsCatalog: return "models.catalog"
        case .shortcutsList: return "shortcuts.list"
        case .errorMsg: return "error"
        case .ack: return "ack"
        case .hello: return "hello"
        case .authChallenge: return "auth.challenge"
        case .authResponse: return "auth.response"
        case .authOk: return "auth.ok"
        case .presence: return "presence"
        case .peerKeys: return "peer.keys"
        case .pushRegister: return "push.register"
        case .pushSend: return "push.send"
        case .usageReport: return "usage.report"
        case .pairRequest: return "pair.request"
        case .pairConfirm: return "pair.confirm"
        case .pairResult: return "pair.result"
        case .pairCodeClaim: return "pair.code.claim"
        case .pairOfferMsg: return "pair.offer"
        case .syncPut: return "sync.put"
        case .syncPull: return "sync.pull"
        case .syncPage: return "sync.page"
        case .syncDelete: return "sync.delete"
        case .toolsList: return "tools.list"
        case .toolsListResult: return "tools.list.result"
        case .toolsCall: return "tools.call"
        case .toolsResult: return "tools.result"
        case .eventEmit: return "event.emit"
        case .approvalRequest: return "approval.request"
        case .approvalResponse: return "approval.response"
        }
    }

    public init(from decoder: Decoder) throws {
        let t = try Peek(from: decoder).type
        let c = try decoder.singleValueContainer()
        switch t {
        case "intent.submit": self = .intentSubmit(try c.decode(IntentSubmit.self))
        case "run.cancel": self = .runCancel(try c.decode(RunCancel.self))
        case "approval.decision": self = .approvalDecision(try c.decode(ApprovalDecision.self))
        case "terminal.open": self = .terminalOpen(try c.decode(TerminalOpen.self))
        case "terminal.resize": self = .terminalResize(try c.decode(TerminalResize.self))
        case "terminal.close": self = .terminalClose(try c.decode(TerminalClose.self))
        case "terminal.ack": self = .terminalAck(try c.decode(TerminalAck.self))
        case "media.subscribe": self = .mediaSubscribe(try c.decode(MediaSubscribe.self))
        case "media.unsubscribe": self = .mediaUnsubscribe(try c.decode(MediaUnsubscribe.self))
        case "stats.get": self = .statsGet(try c.decode(StatsGet.self))
        case "shortcut.run": self = .shortcutRun(try c.decode(ShortcutRun.self))
        case "history.list": self = .historyList(try c.decode(HistoryList.self))
        case "privacy.set": self = .privacySet(try c.decode(PrivacySet.self))
        case "privacy.get": self = .privacyGet(try c.decode(PrivacyGet.self))
        case "scope.set": self = .scopeSet(try c.decode(ScopeSet.self))
        case "app.learn.start": self = .appLearnStart(try c.decode(AppLearnStart.self))
        case "app.learn.stop": self = .appLearnStop(try c.decode(AppLearnStop.self))
        case "app.card.run": self = .appCardRun(try c.decode(AppCardRun.self))
        case "app.cards.get": self = .appCardsGet(try c.decode(AppCardsGet.self))
        case "capabilities.get": self = .capabilitiesGet(try c.decode(CapabilitiesGet.self))
        case "models.list": self = .modelsList(try c.decode(ModelsList.self))
        case "sync.key": self = .syncKey(try c.decode(SyncKey.self))
        case "run.created": self = .runCreated(try c.decode(RunCreated.self))
        case "plan.updated": self = .planUpdated(try c.decode(PlanUpdated.self))
        case "step.started": self = .stepStarted(try c.decode(StepStarted.self))
        case "step.precheck": self = .stepPrecheck(try c.decode(StepPrecheck.self))
        case "step.approval_required": self = .stepApprovalRequired(try c.decode(StepApprovalRequired.self))
        case "step.finished": self = .stepFinished(try c.decode(StepFinished.self))
        case "run.finished": self = .runFinished(try c.decode(RunFinished.self))
        case "terminal.suggestion": self = .terminalSuggestion(try c.decode(TerminalSuggestion.self))
        case "terminal.opened": self = .terminalOpened(try c.decode(TerminalOpened.self))
        case "terminal.exit": self = .terminalExit(try c.decode(TerminalExit.self))
        case "terminal.block": self = .terminalBlockMsg(try c.decode(TerminalBlockMsg.self))
        case "media.info": self = .mediaInfo(try c.decode(MediaInfo.self))
        case "stats": self = .stats(try c.decode(Stats.self))
        case "capabilities": self = .capabilities(try c.decode(Capabilities.self))
        case "privacy.state": self = .privacyState(try c.decode(PrivacyState.self))
        case "history.page": self = .historyPage(try c.decode(HistoryPage.self))
        case "app.learn.progress": self = .appLearnProgress(try c.decode(AppLearnProgress.self))
        case "app.cards": self = .appCards(try c.decode(AppCards.self))
        case "models.catalog": self = .modelsCatalog(try c.decode(ModelsCatalog.self))
        case "shortcuts.list": self = .shortcutsList(try c.decode(ShortcutsList.self))
        case "error": self = .errorMsg(try c.decode(ErrorMsg.self))
        case "ack": self = .ack(try c.decode(Ack.self))
        case "hello": self = .hello(try c.decode(Hello.self))
        case "auth.challenge": self = .authChallenge(try c.decode(AuthChallenge.self))
        case "auth.response": self = .authResponse(try c.decode(AuthResponse.self))
        case "auth.ok": self = .authOk(try c.decode(AuthOk.self))
        case "presence": self = .presence(try c.decode(Presence.self))
        case "peer.keys": self = .peerKeys(try c.decode(PeerKeys.self))
        case "push.register": self = .pushRegister(try c.decode(PushRegister.self))
        case "push.send": self = .pushSend(try c.decode(PushSend.self))
        case "usage.report": self = .usageReport(try c.decode(UsageReport.self))
        case "pair.request": self = .pairRequest(try c.decode(PairRequest.self))
        case "pair.confirm": self = .pairConfirm(try c.decode(PairConfirm.self))
        case "pair.result": self = .pairResult(try c.decode(PairResult.self))
        case "pair.code.claim": self = .pairCodeClaim(try c.decode(PairCodeClaim.self))
        case "pair.offer": self = .pairOfferMsg(try c.decode(PairOfferMsg.self))
        case "sync.put": self = .syncPut(try c.decode(SyncPut.self))
        case "sync.pull": self = .syncPull(try c.decode(SyncPull.self))
        case "sync.page": self = .syncPage(try c.decode(SyncPage.self))
        case "sync.delete": self = .syncDelete(try c.decode(SyncDelete.self))
        case "tools.list": self = .toolsList(try c.decode(ToolsList.self))
        case "tools.list.result": self = .toolsListResult(try c.decode(ToolsListResult.self))
        case "tools.call": self = .toolsCall(try c.decode(ToolsCall.self))
        case "tools.result": self = .toolsResult(try c.decode(ToolsResult.self))
        case "event.emit": self = .eventEmit(try c.decode(EventEmit.self))
        case "approval.request": self = .approvalRequest(try c.decode(ApprovalRequest.self))
        case "approval.response": self = .approvalResponse(try c.decode(ApprovalResponse.self))
        default:
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "unknown message type \(t)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .intentSubmit(let v): try c.encode(v)
        case .runCancel(let v): try c.encode(v)
        case .approvalDecision(let v): try c.encode(v)
        case .terminalOpen(let v): try c.encode(v)
        case .terminalResize(let v): try c.encode(v)
        case .terminalClose(let v): try c.encode(v)
        case .terminalAck(let v): try c.encode(v)
        case .mediaSubscribe(let v): try c.encode(v)
        case .mediaUnsubscribe(let v): try c.encode(v)
        case .statsGet(let v): try c.encode(v)
        case .shortcutRun(let v): try c.encode(v)
        case .historyList(let v): try c.encode(v)
        case .privacySet(let v): try c.encode(v)
        case .privacyGet(let v): try c.encode(v)
        case .scopeSet(let v): try c.encode(v)
        case .appLearnStart(let v): try c.encode(v)
        case .appLearnStop(let v): try c.encode(v)
        case .appCardRun(let v): try c.encode(v)
        case .appCardsGet(let v): try c.encode(v)
        case .capabilitiesGet(let v): try c.encode(v)
        case .modelsList(let v): try c.encode(v)
        case .syncKey(let v): try c.encode(v)
        case .runCreated(let v): try c.encode(v)
        case .planUpdated(let v): try c.encode(v)
        case .stepStarted(let v): try c.encode(v)
        case .stepPrecheck(let v): try c.encode(v)
        case .stepApprovalRequired(let v): try c.encode(v)
        case .stepFinished(let v): try c.encode(v)
        case .runFinished(let v): try c.encode(v)
        case .terminalSuggestion(let v): try c.encode(v)
        case .terminalOpened(let v): try c.encode(v)
        case .terminalExit(let v): try c.encode(v)
        case .terminalBlockMsg(let v): try c.encode(v)
        case .mediaInfo(let v): try c.encode(v)
        case .stats(let v): try c.encode(v)
        case .capabilities(let v): try c.encode(v)
        case .privacyState(let v): try c.encode(v)
        case .historyPage(let v): try c.encode(v)
        case .appLearnProgress(let v): try c.encode(v)
        case .appCards(let v): try c.encode(v)
        case .modelsCatalog(let v): try c.encode(v)
        case .shortcutsList(let v): try c.encode(v)
        case .errorMsg(let v): try c.encode(v)
        case .ack(let v): try c.encode(v)
        case .hello(let v): try c.encode(v)
        case .authChallenge(let v): try c.encode(v)
        case .authResponse(let v): try c.encode(v)
        case .authOk(let v): try c.encode(v)
        case .presence(let v): try c.encode(v)
        case .peerKeys(let v): try c.encode(v)
        case .pushRegister(let v): try c.encode(v)
        case .pushSend(let v): try c.encode(v)
        case .usageReport(let v): try c.encode(v)
        case .pairRequest(let v): try c.encode(v)
        case .pairConfirm(let v): try c.encode(v)
        case .pairResult(let v): try c.encode(v)
        case .pairCodeClaim(let v): try c.encode(v)
        case .pairOfferMsg(let v): try c.encode(v)
        case .syncPut(let v): try c.encode(v)
        case .syncPull(let v): try c.encode(v)
        case .syncPage(let v): try c.encode(v)
        case .syncDelete(let v): try c.encode(v)
        case .toolsList(let v): try c.encode(v)
        case .toolsListResult(let v): try c.encode(v)
        case .toolsCall(let v): try c.encode(v)
        case .toolsResult(let v): try c.encode(v)
        case .eventEmit(let v): try c.encode(v)
        case .approvalRequest(let v): try c.encode(v)
        case .approvalResponse(let v): try c.encode(v)
        }
    }
}
