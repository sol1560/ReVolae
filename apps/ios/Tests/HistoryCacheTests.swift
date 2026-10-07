import CuaRemoteProtocol
import SwiftUI
import Vision
import XCTest
@testable import CuaRemote

@MainActor
final class HistoryCacheTests: XCTestCase {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("history-test-" + UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func device(_ id: String) -> DevicesPageDevicesItem {
        DevicesPageDevicesItem(deviceId: id, role: .device, platform: .macos, name: "测试 Mac " + id,
            online: true, lastSeen: 1, paired: true)
    }
    private func item(_ id: String, device: String = "mac-a", time: Int = 1) -> HistoryItem {
        HistoryItem(runId: id, deviceId: device, intent: "隔离测试记录 · " + id, startedAt: time)
    }
    private func fixture(_ root: URL) throws -> PhoneModel {
        let store = try HistoryStore(directory: root), model = PhoneModel(historyStore: store)
        let phone = try XCTUnwrap(model.connection).identity.id
        model.historyScope = try HistoryStore.Scope(url: XCTUnwrap(URL(string: "wss://history.example.test/ws")), phoneID: phone)
        try store.remember(XCTUnwrap(model.historyScope))
        model.receive(.authOk(AuthOk(id: "fixture-auth", sessionToken: "not-a-real-token", expiresAt: 1)), peer: nil)
        model.receive(.devicesPage(DevicesPage(id: "fixture-devices", devices: [device("mac-a"), device("mac-b")])), peer: nil)
        return model
    }
    private func page(_ model: PhoneModel, device: String = "mac-a", items: [HistoryItem], cursor: String? = nil) {
        let ref = UUID().uuidString
        model.data(for: device).pending[.history] = ref
        model.receive(.historyPage(HistoryPage(id: UUID().uuidString, ref: ref, items: items, nextCursor: cursor)), peer: device)
    }
    private func detail(_ model: PhoneModel, item: HistoryItem) throws {
        let ref = UUID().uuidString, state = model.data(for: item.deviceId)
        state.pending[.detail] = ref; state.requestedRunID = item.runId
        let approval = StepApprovalRequired(id: "old-approval", runId: item.runId, stepId: "step", level: .l2,
            action: ConcreteAction(channel: .shell, summary: "旧操作", detail: "printf '历史操作，仅供查看'"),
            reason: "历史测试数据", expiresAt: 1, challenge: "old-expired-challenge")
        let raw = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(approval))
        model.receive(.historyDetail(HistoryDetail(id: "detail", ref: ref, item: item, events: [raw])), peer: item.deviceId)
    }

    func testFreshStoreAndModelMergeUpdatedRunAndEarlierPagesWithoutRestoringExecution() async throws {
        let root = try directory(), model = try fixture(root)
        var recent = item("recent", time: 300)
        recent.summary = "旧的未完成摘要"
        let older = item("older", time: 10)
        page(model, items: [recent], cursor: "before-300")
        page(model, items: [older, older], cursor: nil)
        var finished = recent; finished.status = .succeeded; finished.ok = true
        finished.finishedAt = 400; finished.summary = "新的成功摘要"
        page(model, items: [finished], cursor: "before-300")
        let pageSnapshot = try XCTUnwrap(HistoryStore(directory: root).load(scope: XCTUnwrap(model.historyScope), deviceID: "mac-a"))
        XCTAssertEqual(pageSnapshot.items.map(\.runId), ["recent", "older"])
        XCTAssertEqual(pageSnapshot.items.first?.status, .succeeded)
        XCTAssertEqual(pageSnapshot.items.first?.summary, "新的成功摘要", "必须在详情回读前证明第一页已替换旧状态")
        try detail(model, item: finished)
        page(model, device: "mac-b", items: [item("other-device", device: "mac-b", time: 999)])
        XCTAssertNil(model.data(for: "mac-a").historyStorageError)

        let freshStore = try HistoryStore(directory: root), fresh = PhoneModel(historyStore: freshStore)
        let state = fresh.data(for: "mac-a")
        XCTAssertEqual(state.history?.map(\.runId), ["recent", "older"])
        XCTAssertEqual(state.history?.first?.summary, "新的成功摘要")
        XCTAssertEqual(state.history?.first?.status, .succeeded)
        XCTAssertEqual(fresh.data(for: "mac-b").history?.map(\.runId), ["other-device"])
        XCTAssertNotNil(state.historyDetails["recent"])
        XCTAssertNil(state.historyDetails["older"], "没下载的详情不能凭摘要补造")
        XCTAssertNotNil(state.historyCachedAt); XCTAssertNotNil(state.historyDetailCachedAt["recent"])
        XCTAssertFalse(fresh.connected); XCTAssertTrue(fresh.devices.allSatisfy { !$0.online })
        XCTAssertNil(fresh.runID); XCTAssertNil(fresh.approval); XCTAssertFalse(fresh.busy)
        XCTAssertNil(fresh.completion); XCTAssertTrue(fresh.events.isEmpty); XCTAssertEqual(fresh.token, "")
        await fresh.refreshHistory("mac-a"); await fresh.loadHistory(older, device: "mac-a")
        XCTAssertTrue(state.pending.isEmpty); XCTAssertTrue(state.errors.isEmpty)
        let file = freshStore.fileURL(scope: try XCTUnwrap(fresh.historyScope), deviceID: "mac-a")
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertEqual(try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        print("HISTORY_FRESH_MODEL_MERGE_PERMISSIONS_AND_BACKUP_PASS")
    }

    func testCompleteFileProtectionOnPhysicalDevice() throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("模拟器未提供文件保护属性；不能据此验收真机锁屏加密，必须在真机复跑")
        #else
        let root = try directory(), model = try fixture(root)
        page(model, items: [item("protected")])
        let file = try XCTUnwrap(model.historyStore).fileURL(scope: XCTUnwrap(model.historyScope), deviceID: "mac-a")
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        XCTAssertEqual(attributes[.protectionKey] as? String, FileProtectionType.complete.rawValue)
        #endif
    }

    func testSourcePhoneDeviceIsolationAndNoCredentialBytes() throws {
        let root = try directory(), store = try HistoryStore(directory: root)
        let secret = "cache-password-ONLY-TEST", query = "cache-token-ONLY-TEST"
        let raw = "wss://cache-user:\(secret)@Example.test:443/a?token=\(query)"
        let first = try HistoryStore.Scope(url: XCTUnwrap(URL(string: raw)), phoneID: "phone-one")
        let otherSecret = try HistoryStore.Scope(url: XCTUnwrap(URL(string: raw + "-different")), phoneID: "phone-one")
        let otherPort = try HistoryStore.Scope(url: XCTUnwrap(URL(string: raw.replacingOccurrences(of: ":443/", with: ":444/"))), phoneID: "phone-one")
        let otherPath = try HistoryStore.Scope(url: XCTUnwrap(URL(string: raw.replacingOccurrences(of: "/a?", with: "/b?"))), phoneID: "phone-one")
        let otherPhone = try HistoryStore.Scope(url: XCTUnwrap(URL(string: raw)), phoneID: "phone-two")
        for (index, scope) in [first, otherSecret, otherPort, otherPath, otherPhone].enumerated() {
            try store.save(.init(scope: scope, device: device("mac-a"), items: [item("source-\(index)")],
                listReceivedAt: Date(), nextCursor: nil, details: [:], detailReceivedAt: [:]))
        }
        try store.remember(first)
        XCTAssertEqual(first.relay, "wss://example.test/a")
        XCTAssertNotEqual(first.sourceID, otherSecret.sourceID)
        let fresh = try HistoryStore(directory: root)
        for (index, scope) in [first, otherSecret, otherPort, otherPath, otherPhone].enumerated() {
            XCTAssertEqual(try fresh.restore(scope).first?.items.map(\.runId), ["source-\(index)"])
        }
        let files = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        for case let url as URL in files {
            for forbidden in [secret, query, "cache-user"] { XCTAssertFalse(url.path.contains(forbidden)) }
            if url.pathExtension == "json" {
                let text = try String(contentsOf: url, encoding: .utf8)
                for forbidden in [secret, query, "cache-user", "sessionToken", "not-a-real-token"] { XCTAssertFalse(text.contains(forbidden)) }
            }
        }
        print("HISTORY_SOURCE_ISOLATION_AND_CREDENTIAL_SCAN_PASS")
    }

    func testVerifiedReplyOnlyAndPersistentRemovalRejectsLateResponse() throws {
        let root = try directory(), model = try fixture(root), scope = try XCTUnwrap(model.historyScope)
        let state = model.data(for: "mac-a"), incoming = item("new")
        state.pending[.history] = "current"
        model.receive(.historyPage(HistoryPage(id: "wrong-peer", ref: "current", items: [incoming])), peer: "mac-b")
        model.receive(.historyPage(HistoryPage(id: "wrong-ref", ref: "old", items: [incoming])), peer: "mac-a")
        model.receive(.historyPage(HistoryPage(id: "wrong-device", ref: "current", items: [item("bad", device: "mac-b")])), peer: "mac-a")
        XCTAssertNil(try model.historyStore?.load(scope: scope, deviceID: "mac-a"))
        page(model, items: [incoming]); page(model, device: "mac-b", items: [item("keep", device: "mac-b")])
        state.pending[.detail] = "detail-current"; state.requestedRunID = incoming.runId
        model.receive(.historyDetail(HistoryDetail(id: "wrong-run", ref: "detail-current", item: item("other-run"), events: [])), peer: "mac-a")
        XCTAssertTrue(try XCTUnwrap(model.historyStore?.load(scope: scope, deviceID: "mac-a")).details.isEmpty)
        state.pending[.history] = "late"
        model.receive(.pairRemoved(PairRemoved(id: "removed", deviceId: "mac-a", phoneId: scope.phoneID, by: "phone")), peer: nil)
        model.receive(.historyPage(HistoryPage(id: "late-page", ref: "late", items: [incoming])), peer: "mac-a")
        let freshStore = try HistoryStore(directory: root), fresh = PhoneModel(historyStore: freshStore)
        XCTAssertNil(try freshStore.load(scope: scope, deviceID: "mac-a"))
        XCTAssertEqual(fresh.devices.map(\.deviceId), ["mac-b"])
        model.receive(.devicesPage(DevicesPage(id: "removed-from-server", devices: [])), peer: nil)
        XCTAssertTrue(try HistoryStore(directory: root).restore(scope).isEmpty)
        XCTAssertTrue(PhoneModel(historyStore: try HistoryStore(directory: root)).devices.isEmpty)
        print("HISTORY_VALIDATED_REPLIES_AND_PERSISTENT_REMOVAL_PASS")
    }

    func testCorruptionIsVisibleAndCannotBeOverwrittenAsEmpty() throws {
        let root = try directory(), model = try fixture(root)
        page(model, items: [item("saved")])
        let scope = try XCTUnwrap(model.historyScope), file = try XCTUnwrap(model.historyStore).fileURL(scope: scope, deviceID: "mac-a")
        let damaged = Data("{broken-history".utf8)
        try damaged.write(to: file)
        let freshStore = try HistoryStore(directory: root)
        XCTAssertThrowsError(try freshStore.restore(scope))
        let fresh = PhoneModel(historyStore: freshStore)
        XCTAssertTrue(fresh.historyCacheError?.contains("损坏") == true)
        XCTAssertNil(fresh.data(for: "mac-a").history)
        page(model, items: [])
        XCTAssertNotNil(model.data(for: "mac-a").historyStorageError)
        XCTAssertEqual(try Data(contentsOf: file), damaged)
        try freshStore.remove(scope: scope, deviceID: "mac-a")
        XCTAssertTrue(try freshStore.restore(scope).isEmpty)
        print("HISTORY_CORRUPTION_EXPLICIT_FAILURE_PASS")
    }

    func testHistoryEventsCannotPersistAuthenticationOrForeignRun() throws {
        let root = try directory(), model = try fixture(root), row = item("own-run")
        page(model, items: [row])
        let state = model.data(for: "mac-a"), secret = "fixture-credential-must-not-persist"
        let auth = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(AuthOk(id: "bad", sessionToken: secret, expiresAt: 1)))
        state.pending[.detail] = "auth-ref"; state.requestedRunID = row.runId
        model.receive(.historyDetail(HistoryDetail(id: "bad-detail", ref: "auth-ref", item: row, events: [auth])), peer: "mac-a")
        XCTAssertNil(state.historyDetails[row.runId]); XCTAssertNotNil(state.errors[.detail])
        let foreign = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(StepStarted(id: "step", runId: "other-run", stepId: "s", title: "foreign")))
        state.pending[.detail] = "foreign-ref"
        model.receive(.historyDetail(HistoryDetail(id: "foreign-detail", ref: "foreign-ref", item: row, events: [foreign])), peer: "mac-a")
        XCTAssertNil(state.historyDetails[row.runId])
        var known = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(StepStarted(id: "step", runId: row.runId, stepId: "s", title: "known"))) as? [String: Any])
        known["unexpectedCredential"] = secret
        let raw = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: known))
        state.pending[.detail] = "valid-ref"
        model.receive(.historyDetail(HistoryDetail(id: "valid", ref: "valid-ref", item: row, events: [raw])), peer: "mac-a")
        XCTAssertNotNil(state.historyDetails[row.runId]); XCTAssertNil(state.errors[.detail])
        let file = try XCTUnwrap(model.historyStore).fileURL(scope: XCTUnwrap(model.historyScope), deviceID: "mac-a")
        let text = try String(contentsOf: file, encoding: .utf8)
        XCTAssertFalse(text.contains(secret)); XCTAssertFalse(text.contains("unexpectedCredential"))
        print("HISTORY_EVENT_WHITELIST_AND_CREDENTIAL_REJECTION_PASS")
    }

    func testTerminalSuggestionResponsePersistsAndRestoresWithoutExecution() throws {
        let root = try directory(), model = try fixture(root), row = item("suggested-run")
        page(model, items: [row])
        let suggestion = TerminalSuggestion(id: "suggestion", runId: row.runId, sessionId: "old-session",
            command: "find ./Reports -name '*.csv' -print", explanation: "只列出文件，尚未执行", level: .l2)
        var fields = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(suggestion)) as? [String: Any])
        fields["unexpectedCredential"] = "suggestion-secret-must-not-persist"
        let raw = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: fields))
        let state = model.data(for: "mac-a")
        state.pending[.detail] = "suggestion-ref"; state.requestedRunID = row.runId
        model.receive(.historyDetail(HistoryDetail(id: "suggestion-detail", ref: "suggestion-ref", item: row, events: [raw])), peer: "mac-a")
        XCTAssertNil(state.errors[.detail], "合法建议命令不能导致整份历史被拒")
        let freshStore = try HistoryStore(directory: root), fresh = PhoneModel(historyStore: freshStore)
        let restored = try XCTUnwrap(fresh.data(for: "mac-a").historyDetails[row.runId])
        let event = try JSONDecoder().decode(AnyMessage.self, from: JSONEncoder().encode(XCTUnwrap(restored.events.first)))
        guard case .terminalSuggestion(let saved) = event else { return XCTFail("建议命令未读回") }
        XCTAssertEqual(saved.command, suggestion.command); XCTAssertEqual(saved.explanation, suggestion.explanation)
        XCTAssertEqual(saved.level, .l2); XCTAssertEqual(saved.sessionId, "old-session")
        XCTAssertNil(fresh.approval); XCTAssertNil(fresh.runID); XCTAssertFalse(fresh.busy)
        let file = freshStore.fileURL(scope: try XCTUnwrap(fresh.historyScope), deviceID: "mac-a")
        let bytes = try Data(contentsOf: file)
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("suggestion-secret"))
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("unexpectedCredential"))
        fields["runId"] = "foreign-run"
        let foreign = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: fields))
        state.pending[.detail] = "foreign-suggestion-ref"
        model.receive(.historyDetail(HistoryDetail(id: "foreign-suggestion", ref: "foreign-suggestion-ref", item: row, events: [foreign])), peer: "mac-a")
        XCTAssertNotNil(state.errors[.detail]); XCTAssertEqual(try Data(contentsOf: file), bytes)
    }

    /// 用实际截图文字及按钮样式探针检查正式组件，不复制产品展示逻辑。
    func testHistoryEventPresentationIsReadOnlyAndOptionalDataIsNotInvented() async throws {
        let root = try directory(), model = try fixture(root), row = item("presentation-run")
        let plan = PlanUpdated(id: "plan", runId: row.runId, plan: [
            PlanStep(id: "one", title: "读取所选报告目录中的文件名，保留原始顺序，不修改或上传任何文件", status: .done),
            PlanStep(id: "two", title: "比较两份月度报告的列名与日期格式，并列出需要人工核对的不一致项目", status: .running),
            PlanStep(id: "three", title: "展示拟保存的差异摘要与完整目标路径，等待用户确认后才允许写入", status: .awaitingApproval),
            PlanStep(id: "four", title: "取消未获批准的归档步骤，保留源文件与已经读取的原始输出", status: .cancelled)
        ])
        let full = StepPrecheck(id: "check", runId: row.runId, stepId: "three", staticLevel: .l1, level: .l2,
            intentMatch: false, risk: 0.73, confidence: 0.91, jevMs: 38.5, verdict: .confirm, source: .cache)
        let missing = StepPrecheck(id: "minimal", runId: row.runId, stepId: "four", staticLevel: .l2, level: .l2,
            verdict: .deny, source: .fallback)
        let suggestion = TerminalSuggestion(id: "suggestion", runId: row.runId,
            command: "find './Reports/Monthly review' -type f -name '*.csv' -print\n# 只建议列出名称，不代表这条命令已执行",
            explanation: "这条命令会读取所选目录中的文件名。请先检查路径和访问范围；历史页面不会打开终端、填入或执行这条建议。", level: .l2)
        let approval = StepApprovalRequired(id: "approval", runId: row.runId, stepId: "three", level: .l2,
            action: ConcreteAction(channel: .shell, summary: "旧操作", detail: "printf 'ARCHIVED-ONLY'"),
            reason: "隔离历史数据", expiresAt: 1, challenge: "expired")
        let cases: [(String, AnyMessage, [String], [String])] = [
            ("long-plan", .planUpdated(plan), ["计划更新"] + plan.plan.map(\.title) + ["完成", "执行中", "等你确认", "已取消"], []),
            ("precheck-full", .stepPrecheck(full), ["检查结果：需要确认", "检查来源：cache", "静态风险等级：1 · 最终风险等级：2", "符合任务意图：否", "风险值：0.73", "置信度：0.91", "Jev 检查耗时：38.5 毫秒"], []),
            ("precheck-missing", .stepPrecheck(missing), ["检查结果：禁止", "检查来源：fallback", "静态风险等级：2 · 最终风险等级：2"], ["符合任务意图", "风险值", "置信度", "检查耗时"]),
            ("suggestion", .terminalSuggestion(suggestion), [suggestion.command, suggestion.explanation, "风险等级：2", "只是建议，未因此执行"], []),
            ("finished-local", .stepFinished(StepFinished(id: "local", runId: row.runId, stepId: "one", ok: true, ms: 1234.5, dataLeftDevice: false, output: "报告目录：3 个 CSV 文件")), ["步骤完成", "报告目录：3 个 CSV 文件", "实际耗时：1,234.5 毫秒", "数据离机：否（设备报告）"], []),
            ("finished-egress", .stepFinished(StepFinished(id: "remote", runId: row.runId, stepId: "two", ok: false, ms: 17.25, dataLeftDevice: true, error: "远端返回错误")), ["步骤未完成", "远端返回错误", "实际耗时：17.25 毫秒", "数据离机：是（设备报告）"], []),
            ("old-approval", .stepApprovalRequired(approval), ["当时需要确认的操作", approval.action.detail, "旧请求已不可在此确认"], [])
        ]
        for (name, event, expected, absent) in cases {
          for foreign in [false, true] {
            let page = HistoryDetailView(model: model, deviceID: "mac-a", item: foreign ? item("other-run") : row)
            let measurements = HistoryEventMeasurements()
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let window = UIWindow(windowScene: scene)
            window.rootViewController = UIHostingController(rootView: NavigationStack {
                ProductPage {
                    page.historicalEvent(event)
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { measurements.frame = $0 }
                        .buttonStyle(HistoryButtonProbe(measurements: measurements))
                }
                    .navigationTitle("历史事件补测").navigationBarTitleDisplayMode(.inline)
                    .safeAreaInset(edge: .top) { Text("隔离数据 · " + name + (foreign ? " · foreign" : "")).font(.caption).padding(8) }
            }.environment(\.locale, Locale(identifier: "zh_CN")).preferredColorScheme(.light))
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(400)); window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                XCTAssertTrue(window.drawHierarchy(in: window.bounds, afterScreenUpdates: true))
            }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate; request.recognitionLanguages = ["zh-Hans", "en-US"]
            request.usesLanguageCorrection = false
            try VNImageRequestHandler(cgImage: XCTUnwrap(image.cgImage)).perform([request])
            let text = request.results?.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n") ?? ""
            let compact = { (value: String) in value.filter { !$0.isWhitespace && !$0.isPunctuation } }
            // OCR 按横行读取时会把右栏状态插入换行标题；标题检查移除这四个状态词，状态仍单独检查。
            let planTitles = ["完成", "执行中", "等你确认", "已取消"].reduce(text) { $0.replacingOccurrences(of: $1, with: "") }
            XCTAssertTrue(compact(text).contains("隔离数据"), "确认文字检查确实读到了本轮页面")
            for label in foreign ? [] : expected {
                XCTAssertTrue(compact(text).contains(compact(label)) || (name == "long-plan" && compact(planTitles).contains(compact(label))),
                    "\(name) 缺少实际文字：\(label)，读到：\(text)")
            }
            for label in foreign ? expected : absent {
                XCTAssertFalse(compact(text).contains(compact(label)), "\(name) 不得串入其他任务或补造可选数据：\(label)")
            }
            XCTAssertEqual(measurements.buttons, 0, "历史事件没有执行或批准按钮")
            if foreign {
                XCTAssertTrue(measurements.frame.isNull || measurements.frame.height < 1)
            } else {
                XCTAssertGreaterThan(measurements.frame.minY, window.safeAreaInsets.top)
                XCTAssertLessThan(measurements.frame.maxY, window.bounds.maxY - window.safeAreaInsets.bottom, "整张事件卡必须完整可见")
                let attachment = XCTAttachment(image: image)
                attachment.name = "history-events-" + name; attachment.lifetime = .keepAlways; add(attachment)
            }
            XCTAssertNil(model.approval); XCTAssertNil(model.runID); XCTAssertFalse(model.busy)
            print("HISTORY_EVENT_RENDER \(name) foreign=\(foreign) buttons=\(measurements.buttons) frame=\(measurements.frame)")
          }
        }
    }

    func testReadOnlyButtonProbeDetectsAnActualButton() async throws {
        let measurements = HistoryEventMeasurements()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: ProductPage {
            Button("只验证测试探针，不执行任务") {}.buttonStyle(HistoryButtonProbe(measurements: measurements))
        })
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(measurements.buttons, 1, "必须证明按钮探针能检出按钮，零按钮断言才有效")
    }

    func testRenderOnlineOfflineMissingDetailAndOldApprovalReadOnly() async throws {
        let root = try directory(), initial = try fixture(root)
        let saved = item("已保存详情", time: 1_790_000_000_000), missing = item("尚未下载详情", time: 1_789_999_990_000)
        page(initial, items: [saved, missing]); try detail(initial, item: saved)
        for mode in ["online", "offline", "missing-detail", "old-approval"] {
            let model = PhoneModel(historyStore: try HistoryStore(directory: root))
            model.selectedDevice = "mac-a"
            if mode == "online" {
                model.connected = true; model.devices[0].online = true
                model.data(for: "mac-a").pending[.history] = "fixture-no-network"
            }
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let window = UIWindow(windowScene: scene)
            window.rootViewController = UIHostingController(rootView: NavigationStack {
                Group {
                    if mode == "missing-detail" { HistoryDetailView(model: model, deviceID: "mac-a", item: missing) }
                    else if mode == "old-approval" { HistoryDetailView(model: model, deviceID: "mac-a", item: saved) }
                    else { HistoryView(model: model) }
                }.safeAreaInset(edge: .top) {
                    Text("历史补测 · 隔离数据 · \(mode)").font(.caption).padding(8)
                }
            }.environment(\.locale, Locale(identifier: "zh_CN")).preferredColorScheme(.light))
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(400))
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                XCTAssertTrue(window.drawHierarchy(in: window.bounds, afterScreenUpdates: true))
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "history-fixture-" + mode; attachment.lifetime = .keepAlways; add(attachment)
            XCTAssertNil(model.approval); XCTAssertNil(model.runID); XCTAssertFalse(model.busy)
            if mode != "online" { XCTAssertTrue(model.data(for: "mac-a").pending.isEmpty) }
        }
    }
}

@MainActor
private final class HistoryEventMeasurements {
    var frame = CGRect.null
    var buttons = 0
}

private struct HistoryButtonProbe: ButtonStyle {
    let measurements: HistoryEventMeasurements
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.onAppear { measurements.buttons += 1 }
    }
}
