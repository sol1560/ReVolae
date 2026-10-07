import CuaRemoteProtocol
import SwiftUI
import XCTest
@testable import CuaRemote

@MainActor
final class StatusColorTests: XCTestCase {
    func testRealStatesAndRiskNeverTurnCancellationOrFailureGreen() {
        XCTAssertEqual(RunStatus.succeeded.tone, .success)
        XCTAssertEqual(RunStatus.failed.tone, .danger)
        XCTAssertEqual(RunStatus.denied.tone, .danger)
        XCTAssertEqual(RunStatus.cancelled.tone, .neutral)
        XCTAssertEqual(PlanStepStatus.awaitingApproval.tone, .warning)
        XCTAssertEqual(PlanStepStatus.running.tone, .neutral)
        XCTAssertEqual(PlanStepStatus.pending.tone, .neutral)
        XCTAssertEqual(PlanStepStatus.cancelled.tone, .neutral)
        XCTAssertEqual(Level.l0.tone, .neutral)
        XCTAssertEqual(Level.l1.tone, .warning)
        XCTAssertEqual(Level.l2.tone, .danger)
        var result = RunFinished(id: "color", runId: "isolated", ok: true, status: .denied,
            summary: "成功不是依据", cost: Cost(inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0), stepCount: 0)
        XCTAssertEqual(result.resultTone, .danger, "明确状态优先于旧ok字段")
        result.status = nil; result.cancelled = true
        XCTAssertEqual(result.resultTone, .neutral)
        var item = HistoryItem(runId: "old", deviceId: "isolated", intent: "只测试展示", startedAt: 0, ok: true)
        XCTAssertEqual(item.resultTone, .warning, "未结束历史不能由ok推断为成功")
        XCTAssertEqual(item.resultIcon, "clock")
        item.finishedAt = 1
        XCTAssertEqual(item.resultTone, .success)
        XCTAssertEqual(item.resultIcon, "checkmark.circle")
        item.ok = false
        XCTAssertEqual(item.resultTone, .danger)
        XCTAssertEqual(item.resultIcon, "xmark.circle")
    }

    func testReferenceColorsAndReadableLightDarkBadges() {
        let expected: [(StatusTone, UInt32)] = [(.success, 0x077A42), (.warning, 0x8A5200), (.danger, 0xC0392B), (.info, 0x1768CF)]
        for (tone, hex) in expected {
            let rgb = components(tone.foreground, style: .light)
            XCTAssertEqual(rgb[0], Double((hex >> 16) & 255) / 255, accuracy: 0.005)
            XCTAssertEqual(rgb[1], Double((hex >> 8) & 255) / 255, accuracy: 0.005)
            XCTAssertEqual(rgb[2], Double(hex & 255) / 255, accuracy: 0.005)
        }
        for style in [UIUserInterfaceStyle.light, .dark] {
            for tone in StatusTone.allCases {
                let fg = luminance(components(tone.foreground, style: style))
                let bg = luminance(components(tone.background, style: style))
                XCTAssertGreaterThanOrEqual((max(fg, bg) + 0.05) / (min(fg, bg) + 0.05), 4.5, "徽章小字必须可读：\(style) \(tone)")
            }
        }
    }

    private func components(_ color: Color, style: UIUserInterfaceStyle) -> [Double] {
        let value = UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        XCTAssertTrue(value.getRed(&r, green: &g, blue: &b, alpha: &a))
        return [Double(r), Double(g), Double(b)]
    }
    private func luminance(_ rgb: [Double]) -> Double {
        let linear = rgb.map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
    }
}
