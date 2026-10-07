import SwiftUI
import CuaRemoteProtocol

enum Design {
    static let background = adaptive(0xF2F3F5, 0x151719)
    static let card = adaptive(0xFFFFFF, 0x222629)
    static let well = adaptive(0xF4F5F7, 0x2B3035)
    static let line = adaptive(0xE7E9EC, 0x3A4148)
    static let text = adaptive(0x0E1114, 0xF3F4F5)
    static let secondary = adaptive(0x5C6670, 0xA8B1BB)
    static let ink = adaptive(0x16191D, 0xF2F3F5)
    static let inkText = adaptive(0xFFFFFF, 0x16191D)
    static let blue = adaptive(0x1A6DD8, 0x8BBAFF)
    // 浅蓝徽章上的小字略加深；导航和链接仍使用原稿蓝色。
    static let blueText = adaptive(0x1768CF, 0x8BBAFF)
    static let blueWash = adaptive(0xE9F0FD, 0x1C304A)
    static let green = adaptive(0x077A42, 0x71D6A0)
    static let greenWash = adaptive(0xE8F7EF, 0x173B2B)
    static let greenFill = adaptive(0x0FA35C, 0x43C884)
    static let warning = adaptive(0x8A5200, 0xF1C278)
    static let warningWash = adaptive(0xFBF0DC, 0x42331D)
    static let warningFill = adaptive(0xC77A00, 0xE7AE51)
    static let danger = adaptive(0xC0392B, 0xFFAAA0)
    static let dangerWash = adaptive(0xFCECEA, 0x482825)

    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 255) / 255,
                           green: CGFloat((hex >> 8) & 255) / 255,
                           blue: CGFloat(hex & 255) / 255, alpha: 1)
        })
    }
}

enum StatusTone: CaseIterable {
    case neutral, success, warning, danger, info
    var foreground: Color {
        switch self {
        case .neutral: Design.secondary
        case .success: Design.green
        case .warning: Design.warning
        case .danger: Design.danger
        case .info: Design.blueText
        }
    }
    var background: Color {
        switch self {
        case .neutral: Design.well
        case .success: Design.greenWash
        case .warning: Design.warningWash
        case .danger: Design.dangerWash
        case .info: Design.blueWash
        }
    }
}

extension Level {
    var tone: StatusTone { self == .l0 ? .neutral : self == .l1 ? .warning : .danger }
}

struct StatusBadge: View {
    let text: String
    let tone: StatusTone
    var body: some View {
        Text(text).font(.caption.weight(.semibold)).padding(.horizontal, 9).padding(.vertical, 4)
            .foregroundStyle(tone.foreground).background(tone.background, in: Capsule())
    }
}

struct ProductCard<Content: View>: View {
    var tone: StatusTone? = nil
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 14) { content }
            .frame(maxWidth: .infinity, alignment: .leading).padding(18)
            .background(tone?.background ?? Design.card, in: RoundedRectangle(cornerRadius: 22))
            .shadow(color: .black.opacity(0.04), radius: 1, y: 1)
            .shadow(color: .black.opacity(0.06), radius: 12, y: 4)
    }
}

struct ProductCode: View {
    let text: String
    var body: some View {
        Text(text).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading).padding(13)
            .foregroundStyle(Color(red: 201 / 255, green: 231 / 255, blue: 214 / 255))
            .background(Color(red: 20 / 255, green: 24 / 255, blue: 28 / 255), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct ProductPage<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Design.background).foregroundStyle(Design.text)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 52).padding(.horizontal, 20)
            .foregroundStyle(Design.inkText)
            .background(Design.ink, in: Capsule())
            .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.42)
    }
}

private struct ProductNavigation: ViewModifier {
    let title: String
    var back = true
    var close = false
    var actionIcon: String?
    var actionLabel = ""
    var actionID = ""
    var actionDisabled = false
    var action: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    func body(content: Content) -> some View {
        content.navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            .toolbar {
                if close {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("关闭", systemImage: "xmark") { dismiss() }
                            .accessibilityIdentifier("navigateBack")
                    }
                }
                if let action, let actionIcon {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(actionLabel, systemImage: actionIcon, action: action)
                            .accessibilityIdentifier(actionID).disabled(actionDisabled)
                    }
                }
            }
    }
}

extension View {
    func productNavigation(_ title: String, back: Bool = true, close: Bool = false,
                           actionIcon: String? = nil, actionLabel: String = "", actionID: String = "", actionDisabled: Bool = false, action: (() -> Void)? = nil) -> some View {
        modifier(ProductNavigation(title: title, back: back, close: close, actionIcon: actionIcon,
            actionLabel: actionLabel, actionID: actionID, actionDisabled: actionDisabled, action: action))
    }

    func productField() -> some View {
        padding(.horizontal, 15).padding(.vertical, 13)
            .background(Design.card, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Design.line, lineWidth: 1.5))
            .foregroundStyle(Design.text)
    }
}

struct ProductSearch: View {
    @Binding var text: String
    let prompt: String
    let identifier: String
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").font(.subheadline).foregroundStyle(Design.secondary)
            TextField(prompt, text: $text).font(.body).autocorrectionDisabled()
                .submitLabel(.search).onSubmit { hideKeyboard() }
                .accessibilityIdentifier(identifier)
            if !text.isEmpty { Button { text = "" } label: { Image(systemName: "xmark.circle.fill") }
                .accessibilityLabel("清空搜索").foregroundStyle(Design.secondary) }
        }.productField()
    }
}

struct ProductList<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(spacing: 0) { content }.background(Design.card)
            .clipShape(RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(Design.line.opacity(0.4), lineWidth: 0.5))
    }
}

struct ProductRow: View {
    let title: String
    var subtitle: String?
    var icon: String?
    var trailing: String?
    var chevron = true
    var tone: StatusTone? = nil
    var body: some View {
        HStack(spacing: 12) {
            if let icon {
                Image(systemName: icon).font(.title3).frame(width: 46, height: 46)
                    .foregroundStyle(tone?.foreground ?? Design.text)
                    .background(tone?.background ?? Design.well, in: RoundedRectangle(cornerRadius: 13))
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.semibold))
                if let subtitle { Text(subtitle).font(.caption).foregroundStyle(Design.secondary).fixedSize(horizontal: false, vertical: true) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if let trailing { Text(trailing).font(.caption2).foregroundStyle(Design.secondary) }
            if chevron { Image(systemName: "chevron.right").font(.caption).foregroundStyle(Design.secondary.opacity(0.6)) }
        }.padding(.horizontal, 16).padding(.vertical, 13).frame(minHeight: 60)
            .foregroundStyle(Design.text).contentShape(Rectangle())
    }
}

struct ProductSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.subheadline.bold()).accessibilityAddTraits(.isHeader)
            content
        }
    }
}

struct ProductEmpty: View {
    let icon: String
    let title: String
    let detail: String
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: icon).font(.title2).frame(width: 60, height: 60)
                .background(Design.card, in: RoundedRectangle(cornerRadius: 18))
            Text(title).font(.body.weight(.semibold))
            Text(detail).font(.subheadline).foregroundStyle(Design.secondary).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity).padding(.vertical, 36)
    }
}

struct DeviceSelector: View {
    @Bindable var model: PhoneModel
    var body: some View {
        if model.devices.isEmpty {
            Text("先连接并配对一台 Mac").foregroundStyle(Design.secondary)
        } else {
            Menu {
                ForEach(model.devices, id: \.deviceId) { device in
                    Button(device.name + (device.online ? "" : " · 离线")) { model.selectedDevice = device.deviceId }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "desktopcomputer")
                    Text(model.devices.first(where: { $0.deviceId == model.selectedDevice })?.name ?? "选择设备")
                    Image(systemName: "chevron.down").font(.caption)
                }.font(.subheadline.weight(.medium)).padding(.horizontal, 13).frame(minHeight: 44)
                    .background(Design.card, in: Capsule()).foregroundStyle(Design.text)
            }.disabled(model.busy).accessibilityIdentifier("devicePicker")
        }
    }
}

struct ResourceStatus: View {
    @Bindable var state: DeviceData
    let resource: DeviceData.Resource
    var body: some View {
        if state.pending[resource] != nil { ProgressView("等待设备回复…").font(.footnote) }
        if let error = state.errors[resource] { Text(error).font(.footnote).foregroundStyle(Design.danger)
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(Design.dangerWash, in: RoundedRectangle(cornerRadius: 14)) }
    }
}

@MainActor
func hideKeyboard() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}
