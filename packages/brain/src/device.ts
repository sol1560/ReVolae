import { randomBytes, randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  AnyMessage, ApprovalVerifier, b64, controlFrame, decodeFrame,
  hubAuthPayload, mkMsg, pairHmac, pairHmacEquals,
  parseControl, signPayload, z, PhoneToDevice, DeviceStats, InstalledApp, PrivacySettings, PermissionsState,
  type Shortcut, type CapabilityCard,
  type MsgBody, type PairOffer,
} from "@cuaremote/protocol";
import { runIntent, type ApprovalRequest } from "./agent/loop.js";
import { PeerLinks } from "./cloud/peer-links.js";
import { loadDeviceIdentity } from "./device-identity.js";
import { DeviceStore } from "./device-store.js";
import { DeviceMedia } from "./device-media.js";
import { LocalBunHost } from "./host/local-bun-host.js";
import { nativeHelper } from "./host/native-helper.js";
import { PolicyEngine } from "./jev/policy.js";
import { createProvider } from "./llm/providers.js";
import { catalogMessage, probeLocal, resolveProvider } from "./llm/catalog.js";
import { TerminalManager } from "./terminal/manager.js";
import { spawnBunPty } from "./terminal/pty.js";
import { learnApp, runCard } from "./learn/learn.js";

export interface DeviceOptions {
  hubURL: string;
  stateDir: string;
  provider: string;
  allowedDirs: string[];
  name?: string;
  token?: string;
  log?: (event: Record<string, unknown>) => void;
  /** 由本机用户确认；隔离测试可注入回调，正式 CLI 默认使用原生确认窗口。 */
  confirmPair?: (phone: { id: string; name: string }, signal: AbortSignal) => Promise<boolean>;
}

/** 真实本地设备：hub 只转发密文，模型与工具调用均由本进程执行。 */
export async function startDevice(o: DeviceOptions) {
  if (o.provider === "mock" || o.provider.startsWith("mock:")) throw new Error("设备模式不允许使用 mock 模型");
  const initialProvider = createProvider(o.provider);
  if (!o.allowedDirs.length) throw new Error("必须指定至少一个允许访问的目录");
  const { identity, save: saveIdentity } = await loadDeviceIdentity(o.stateDir);
  const pubKeys = { kem: identity.kem.publicKey, sig: identity.sig.publicKey, sigAlg: "ES256" as const };
  const store = new DeviceStore(join(o.stateDir, "device.sqlite"));
  store.interruptUnfinished();
  let settings = PrivacySettings.parse(store.get("privacy") ?? {
    brainLocation: "local", modelTier: initialProvider.info.tier === "local" ? "local" : "standard",
    sync: { history: false, screenshots: false, logs: false, shortcuts: false },
    jevEnabled: false, autonomy: "cautious",
  });
  const ws = new WebSocket(o.hubURL);
  ws.binaryType = "arraybuffer";
  const send = (body: MsgBody) => ws.send(JSON.stringify(mkMsg(body)));
  const links = new PeerLinks(identity.deviceId, {
    publicKey: b64.from(identity.kem.publicKey), privateKey: b64.from(identity.kem.privateKey),
  }, (peer) => identity.peers[peer], (bytes) => {
    if (ws.readyState !== WebSocket.OPEN) throw new Error("连接已关闭，无法发送设备结果");
    ws.send(bytes);
  });
  const sendTo = async (peer: string, body: MsgBody) => {
    // 停止后的结果只留在历史中，不能重新建立链路等待对端握手。
    if (ws.readyState !== WebSocket.OPEN) throw new Error("连接已关闭，无法发送设备结果");
    await links.send(peer, controlFrame(mkMsg(body), 0));
  };
  const media = new DeviceMedia(sendTo, (phone, bytes) => links.send(phone, bytes));
  const terminals = new Map<string, TerminalManager>();
  const nonces = store.nonces();
  function terminal(phone: string) {
    let manager = terminals.get(phone);
    if (!manager) {
      manager = new TerminalManager({
        deviceId: identity.deviceId, phoneKeys: identity.peers[phone]!, spawn: spawnBunPty,
        nonces, consumeNonce: (nonce, expiresAt) => store.consumeNonce(nonce, expiresAt),
        defaultCwd: o.allowedDirs[0],
        sendFrame: (bytes) => { void links.send(phone, bytes).catch(() => dropPeer(phone)); },
        sendMsg: (body) => { void sendTo(phone, body).catch(() => dropPeer(phone)); },
      });
      terminals.set(phone, manager);
    }
    return manager;
  }
  const cards = () => store.get<CapabilityCard[]>("cards") ?? [];
  const hostFor = (phone: string) => new LocalBunHost({ scope: { allowedDirs: o.allowedDirs }, loginShell: false, terminals: terminal(phone), getCard: (id) => cards().find((c) => c.id === id) });
  const verifiers = new Map<string, ApprovalVerifier>();
  const pending = new Map<string, { phone: string; resolve: (allow: boolean) => void }>();
  let active: { phone: string; runId: string; ctrl: AbortController } | undefined;
  let learning: { phone: string; bundleId: string; ctrl: AbortController } | undefined;
  let authenticated = false;
  let closed = false;
  let reconnectable = false;
  let storeClosed = false;
  let offer: PairOffer | undefined;
  let sessionToken: string | undefined;
  let latestPairing: { offer: PairOffer; code: string } | undefined;
  let pairingRefresh: Promise<{ offer: PairOffer; code: string }> | undefined;
  let pairCandidate: string | undefined;
  let pairConfirmation: AbortController | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let inbound = Promise.resolve();
  let resolveReady!: (value: { offer: PairOffer; code: string }) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<{ offer: PairOffer; code: string }>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveClosed!: () => void;
  const finished = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const timer = setTimeout(() => { rejectReady(new Error("设备登录超时")); ws.close(); }, 20_000);

  async function refreshPairing() {
    if (closed || !authenticated || !sessionToken) throw new Error("设备尚未连接中继，无法生成配对码");
    if (pairCandidate) throw new Error("正在等待本机配对确认，请先处理当前请求");
    if (pairingRefresh) return pairingRefresh;
    pairingRefresh = (async () => {
      const next: PairOffer = { hubURL: o.hubURL, deviceId: identity.deviceId, name: o.name ?? hostname(), pubKeys,
        secret: randomBytes(16).toString("base64"), expiresAt: Math.floor(Date.now() / 1000) + 300 };
      const url = new URL("/api/pair/code", o.hubURL.replace(/^ws/, "http"));
      const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(next), signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!res.ok) throw new Error(`生成配对码失败：HTTP ${res.status}`);
      const result = z.object({ code: z.string().length(6), expiresAt: z.number().int() }).parse(await res.json());
      if (closed) throw new Error("连接已关闭，未保存新配对码");
      next.expiresAt = result.expiresAt;
      const path = join(o.stateDir, "pairing.json");
      writeFileSync(`${path}.tmp`, JSON.stringify({ ...next, code: result.code }), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      offer = next;
      latestPairing = { offer: next, code: result.code };
      return latestPairing;
    })();
    try { return await pairingRefresh; }
    finally { pairingRefresh = undefined; }
  }

  function cancelRun(phone?: string) {
    if (!phone || active?.phone === phone) active?.ctrl.abort();
    if (!phone || learning?.phone === phone) learning?.ctrl.abort();
    for (const wait of pending.values()) if (!phone || wait.phone === phone) wait.resolve(false);
  }

  function dropPeer(phone: string) {
    cancelRun(phone);
    media.stop(phone);
    terminals.get(phone)?.closeAll();
    terminals.delete(phone);
    links.drop(phone);
  }

  function writeStatus() {
    const path = join(o.stateDir, "status.json");
    writeFileSync(`${path}.tmp`, JSON.stringify({
      connection: closed ? "disconnected" : authenticated ? "authenticated" : "connecting",
      updatedAt: Date.now(), ...(active ? { activeRunId: active.runId } : {}),
      ...(closed ? { reconnectable } : {}),
    }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  function selectedProvider(requested?: string) {
    const p = resolveProvider({ settings, requested, defaultModel: o.provider });
    if (p.info.id === "mock" || p.info.id.startsWith("mock:")) throw new Error("设备模式不允许使用 mock 模型");
    return p;
  }

  async function waitApproval(phone: string, req: ApprovalRequest): Promise<{ allow: boolean; remember: "once"; failure?: string }> {
    const key = `${req.runId}/${req.stepId}`;
    const verifier = verifiers.get(phone)!;
    verifier.remember(req);
    // runIntent 在进入这里之前同步发出了事件；网络发送是异步的，此处先装好接收器。
    const allow = await new Promise<boolean | undefined>((resolve) => {
      const timeout = setTimeout(() => finish(undefined), Math.max(0, req.expiresAt * 1000 - Date.now()));
      function finish(value: boolean | undefined) {
        clearTimeout(timeout);
        pending.delete(key);
        verifier.forget(req.runId, req.stepId);
        resolve(value);
      }
      pending.set(key, { phone, resolve: finish });
      if (active?.ctrl.signal.aborted) finish(false);
    });
    return { allow: allow === true, remember: "once", ...(allow === undefined ? { failure: "确认请求已过期，未执行" } : {}) };
  }

  async function run(phone: string, m: Extract<AnyMessage, { type: "intent.submit" }>, cardRun?: { card: CapabilityCard; params: Record<string, string> }) {
    if (m.deviceId !== identity.deviceId) return sendTo(phone, { type: "error", code: "wrong_device", message: "目标设备不匹配", ref: m.id });
    const previous = store.request(phone, m.id);
    if (previous) return sendTo(phone, { ...store.detail(phone, previous)!, ref: m.id });
    if (active || learning) return sendTo(phone, { type: "error", code: "device_busy", message: "Mac 正在执行另一项请求", ref: m.id });
    let provider;
    try { provider = selectedProvider(m.provider); }
    catch (e) { return sendTo(phone, { type: "error", code: "provider", message: String(e), ref: m.id }); }
    const runId = randomUUID();
    const ctrl = new AbortController();
    store.begin(phone, m.id, { runId, deviceId: identity.deviceId, intent: m.text, startedAt: Date.now() });
    active = { phone, runId, ctrl };
    writeStatus();
    const verifier = new ApprovalVerifier({ phoneKeys: identity.peers[phone]! });
    verifiers.set(phone, verifier);
    let events = Promise.resolve();
    try {
      const deps = {
        host: hostFor(phone), provider,
        policy: new PolicyEngine({ autonomy: settings.autonomy, jevEnabled: false }),
        signal: ctrl.signal,
        approvals: { request: (req: ApprovalRequest) => waitApproval(phone, req) },
        emit: (event: MsgBody) => {
          if (event.type === "run.created" || event.type === "run.finished") event = { ...event, requestId: m.id };
          if (event.type === "error") event = { ...event, ref: m.id };
          store.append(event);
          if (event.type === "step.approval_required") o.log?.({ ...event, t: event.type });
          events = events.then(() => sendTo(phone, event)).catch((e) => {
            o.log?.({ type: "send_failed", message: String(e) });
            cancelRun(phone);
          });
        },
        log: o.log,
      };
      if (cardRun) await runCard({ ...deps, runId, deviceId: identity.deviceId }, cardRun.card, cardRun.params);
      else await runIntent(deps, { runId, deviceId: identity.deviceId, intent: m.text, mode: m.mode, terminalSessionId: m.terminalSessionId });
      await events;
    } catch (e) {
      const failure = { type: "run.finished" as const, runId, requestId: m.id, ok: false, status: ctrl.signal.aborted ? "cancelled" as const : "failed" as const, summary: String(e), stepCount: 0, cancelled: ctrl.signal.aborted, cost: { inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0 } };
      store.append(failure);
      await events;
      await sendTo(phone, failure).catch(() => {});
      await sendTo(phone, { type: "error", code: "run_failed", message: String(e), ref: m.id }).catch(() => {});
    } finally {
      cancelRun(phone);
      verifiers.delete(phone);
      active = undefined;
      writeStatus();
      finishClosed();
    }
  }

  function finishClosed() {
    if (closed && !active && !learning && !storeClosed) {
      storeClosed = true;
      store.close();
      resolveClosed();
    }
  }

  async function learn(phone: string, m: Extract<AnyMessage, { type: "app.learn.start" }>) {
    let events = Promise.resolve();
    const ctrl = new AbortController();
    const emit = (body: MsgBody) => {
      if (body.type === "app.learn.progress" || body.type === "app.cards") body = { ...body, ref: m.id };
      events = events.then(() => sendTo(phone, body)).catch(() => cancelRun(phone));
    };
    try {
      if (m.deviceId && m.deviceId !== identity.deviceId) throw new Error("目标设备不匹配");
      if (active || learning) throw new Error("Mac 正在执行另一项请求");
      if (m.explore) throw new Error("界面操作探索尚未接通，请使用只读学习");
      const provider = selectedProvider();
      learning = { phone, bundleId: m.bundleId, ctrl };
      await learnApp({ host: hostFor(phone), provider, signal: ctrl.signal, log: o.log, emit: (event) => {
        if (event.type === "app.cards") store.set("cards", [...cards().filter((c) => c.appBundleId !== m.bundleId), ...event.cards]);
        emit(event);
      } }, m);
    } catch (e) {
      emit({ type: "app.learn.progress", bundleId: m.bundleId, phase: "failed", found: 0, message: ctrl.signal.aborted ? "学习已停止" : String(e) });
    } finally {
      await events;
      if (learning?.ctrl === ctrl) learning = undefined;
      finishClosed();
    }
  }

  async function onFrame(bytes: Uint8Array) {
    const received = await links.receive(bytes);
    if (!received || closed) return;
    const frame = decodeFrame(received.frame);
    const phone = received.from;
    if (!identity.peers[phone]) throw new Error("未配对的发送者");
    if (frame.kind === 1) { terminal(phone).input(frame); return; }
    if (frame.kind !== 0) throw new Error("手机发送了不支持的数据帧");
    const m = PhoneToDevice.parse(parseControl(frame));
    try {
    if (terminal(phone).handle(m)) return;
    switch (m.type) {
      case "intent.submit":
        void run(phone, m).catch((e) => o.log?.({ type: "run_failed", message: String(e) }));
        break;
      case "approval.decision": {
        const wait = pending.get(`${m.runId}/${m.stepId}`);
        if (!wait || wait.phone !== phone) return sendTo(phone, { type: "error", code: "approval_unknown_step", message: "没有等待中的确认", ref: m.id });
        const result = verifiers.get(phone)!.verify(m);
        if (!result.ok) {
          await sendTo(phone, { type: "error", code: `approval_${result.reason}`, message: result.message, ref: m.id });
          return;
        }
        wait.resolve(m.allow);
        break;
      }
      case "run.cancel":
        if (active?.phone === phone && active.runId === m.runId) cancelRun(phone);
        await sendTo(phone, { type: "ack", ref: m.id });
        break;
      case "history.list":
        await sendTo(phone, { type: "history.page", ref: m.id, ...store.list(phone, m.limit, m.cursor) });
        break;
      case "history.get": {
        const detail = store.detail(phone, m.runId);
        if (!detail) throw new Error("找不到这条执行记录");
        await sendTo(phone, { ...detail, ref: m.id });
        break;
      }
      case "capabilities.get": {
        const { tools, scope } = await hostFor(phone).listTools();
        let reason: string | undefined;
        try { selectedProvider(); } catch (e) { reason = String(e); }
        await sendTo(phone, { type: "capabilities", ref: m.id, deviceId: identity.deviceId, platform: process.platform === "darwin" ? "macos" : "cloud", name: o.name ?? hostname(), tools, scope, brainAvailable: !reason, brainUnavailableReason: reason, daemonVersion: "0.1.0" });
        break;
      }
      case "stats.get":
        await sendTo(phone, { type: "stats", ref: m.id, deviceId: identity.deviceId, stats: await nativeHelper(["stats"], DeviceStats) });
        break;
      case "permissions.get":
        await sendTo(phone, { type: "permissions.state", ref: m.id, deviceId: identity.deviceId,
          permissions: await nativeHelper(["permissions"], PermissionsState.shape.permissions) });
        break;
      case "media.subscribe":
        media.subscribe(phone, m);
        break;
      case "media.unsubscribe":
        media.stop(phone);
        await sendTo(phone, { type: "ack", ref: m.id });
        break;
      case "apps.list":
        await sendTo(phone, { type: "apps.page", ref: m.id, apps: (await nativeHelper(["apps"], z.array(InstalledApp))).map((app) => ({ ...app, learned: cards().some((c) => c.appBundleId === app.bundleId) })) });
        break;
      case "app.cards.get":
        await sendTo(phone, { type: "app.cards", ref: m.id, cards: cards().filter((c) => !m.bundleId || c.appBundleId === m.bundleId) });
        break;
      case "app.card.update": {
        const saved = cards();
        const card = saved.find((c) => c.id === m.cardId);
        if (!card) throw new Error("找不到这张卡片");
        card.name = m.name;
        card.hidden = m.hidden;
        store.set("cards", saved);
        await sendTo(phone, { type: "app.cards", ref: m.id, cards: saved });
        break;
      }
      case "app.learn.start":
        void learn(phone, m);
        break;
      case "app.learn.stop":
        if (learning?.phone === phone && learning.bundleId === m.bundleId) learning.ctrl.abort();
        await sendTo(phone, { type: "ack", ref: m.id });
        break;
      case "app.card.run": {
        const card = cards().find((c) => c.id === m.cardId);
        if (!card || card.hidden) throw new Error("卡片不存在或已隐藏");
        void run(phone, { v: 1, id: m.id, type: "intent.submit", deviceId: m.deviceId ?? identity.deviceId, text: `卡片「${card.name}」（${card.appName}）`, mode: "agent" }, { card, params: m.params }).catch((e) => o.log?.({ type: "run_failed", message: String(e) }));
        break;
      }
      case "shortcuts.get":
        await sendTo(phone, { type: "shortcuts.list", ref: m.id, shortcuts: store.get<Shortcut[]>(`shortcuts:${phone}`) ?? [] });
        break;
      case "shortcuts.reorder": {
        const current = store.get<Shortcut[]>(`shortcuts:${phone}`) ?? [];
        const byId = new Map(current.map((shortcut) => [shortcut.id, shortcut]));
        if (m.shortcutIds.length !== current.length || new Set(m.shortcutIds).size !== current.length || m.shortcutIds.some((id) => !byId.has(id))) {
          throw new Error("快捷指令列表已变化，请刷新后重新排序");
        }
        const shortcuts = m.shortcutIds.map((id) => byId.get(id)!);
        store.set(`shortcuts:${phone}`, shortcuts);
        await sendTo(phone, { type: "shortcuts.list", ref: m.id, shortcuts });
        break;
      }
      case "shortcut.put":
      case "shortcut.delete": {
        const shortcuts = store.get<Shortcut[]>(`shortcuts:${phone}`) ?? [];
        const id = m.type === "shortcut.put" ? m.shortcut.id : m.shortcutId;
        const index = shortcuts.findIndex((s) => s.id === id);
        if (m.type === "shortcut.put") {
          if (index < 0) shortcuts.push(m.shortcut); else shortcuts[index] = m.shortcut;
        } else if (index >= 0) shortcuts.splice(index, 1);
        store.set(`shortcuts:${phone}`, shortcuts);
        await sendTo(phone, { type: "shortcuts.list", ref: m.id, shortcuts });
        break;
      }
      case "shortcut.run": {
        const shortcut = (store.get<Shortcut[]>(`shortcuts:${phone}`) ?? []).find((s) => s.id === m.shortcutId);
        if (!shortcut) throw new Error("找不到这条快捷指令");
        if (shortcut.runIn === "ssh") throw new Error("SSH 快捷指令需要从手机的 SSH 会话执行");
        if (Object.keys(m.params).length) throw new Error("这条快捷指令没有参数定义");
        void run(phone, { v: 1, id: m.id, type: "intent.submit", deviceId: identity.deviceId, text: shortcut.body, mode: shortcut.runIn }).catch((e) => o.log?.({ type: "run_failed", message: String(e) }));
        break;
      }
      case "models.list": {
        const defaultModel = (settings.modelTier === "local" ? settings.localBrainModel : settings.cloudModel) ?? o.provider;
        const custom = [...new Set([o.provider, settings.cloudModel, settings.localBrainModel].filter((id): id is string => Boolean(id)))].map((id) => ({ id }));
        await sendTo(phone, { ...catalogMessage({ defaultModel, brainLocation: "local", custom, localUp: await probeLocal() }), ref: m.id });
        break;
      }
      case "privacy.set":
        if (active || learning) throw new Error("请先停止正在运行的任务再修改设置");
        if (m.settings.brainLocation !== "local" || Object.values(m.settings.sync).some(Boolean) || m.settings.jevEnabled || m.settings.localGuiModel) throw new Error("此设备暂未接通远程执行、内容同步或专用评估模型；设置未保存");
        resolveProvider({ settings: m.settings, defaultModel: o.provider });
        if ([m.settings.cloudModel, m.settings.localBrainModel].some((id) => id === "mock" || id?.startsWith("mock:"))) throw new Error("设备模式不允许使用 mock 模型");
        store.set("privacy", m.settings);
        settings = m.settings;
        // 保存后回读完整状态，客户端不能只按本地开关显示成功。
      case "privacy.get": {
        const p = selectedProvider();
        await sendTo(phone, { type: "privacy.state", ref: m.id, deviceId: identity.deviceId, settings, dataFlow: [
          { data: "任务和工具结果", destination: p.info.tier === "local" ? "本机模型" : p.info.id, reason: "实际执行模型" },
          { data: "历史和快捷指令", destination: "此设备与发起手机", reason: "保存在设备本地，经加密连接返回；未开启云同步" },
        ] });
        break;
      }
      default:
        await sendTo(phone, { type: "error", code: "unsupported_message", message: `此设备入口不支持 ${m.type}`, ref: m.id });
    }
    } catch (e) {
      await sendTo(phone, { type: "error", code: "request_failed", message: e instanceof Error ? e.message : String(e), ref: m.id });
    }
  }

  async function onControl(m: AnyMessage) {
    switch (m.type) {
      case "auth.challenge":
        send({ type: "auth.response", nonce: m.nonce, signature: signPayload(new TextEncoder().encode(hubAuthPayload(identity.deviceId, m.nonce)), b64.from(identity.sig.privateKey), "ES256") });
        break;
      case "auth.ok": {
        authenticated = true;
        sessionToken = m.sessionToken;
        writeStatus();
        const pairing = await refreshPairing();
        clearTimeout(timer);
        heartbeat = setInterval(() => send({ type: "devices.list" }), 30_000);
        reconnectable = true;
        resolveReady(pairing);
        break;
      }
      case "pair.request": {
        const offered = offer;
        if (!offered || pairCandidate || pairingRefresh || m.deviceId !== identity.deviceId || offered.expiresAt <= Date.now() / 1000 || !pairHmacEquals(m.hmac, pairHmac(offered.secret, pubKeys.kem, m.phonePubKeys.kem))) {
          send({ type: "pair.confirm", deviceId: identity.deviceId, phoneId: m.phoneId, accept: false });
          break;
        }
        pairCandidate = m.phoneId;
        const ctrl = new AbortController();
        pairConfirmation = ctrl;
        // 等用户期间仍处理现有设备的确认、取消和离线消息；保存身份再回到接收队列。
        void Promise.resolve().then(async () => o.confirmPair
          ? o.confirmPair({ id: m.phoneId, name: m.phoneName }, ctrl.signal)
          : (await nativeHelper(["confirm-pair", m.phoneName, m.phoneId], z.object({ accept: z.boolean() }), 90_000, ctrl.signal)).accept
        ).catch((e) => { o.log?.({ type: "pair_confirmation_failed", message: String(e) }); return false; }).then((confirmed) => {
          inbound = inbound.then(async () => {
            const accept = confirmed && !ctrl.signal.aborted && offer === offered && offered.expiresAt > Date.now() / 1000;
            if (!closed) {
              if (accept) {
                identity.peers[m.phoneId] = m.phonePubKeys;
                await saveIdentity();
                offer = undefined;
                rmSync(join(o.stateDir, "pairing.json"), { force: true });
              }
              send({ type: "pair.confirm", deviceId: identity.deviceId, phoneId: m.phoneId, accept });
            }
            pairCandidate = undefined;
            pairConfirmation = undefined;
          }).catch((e) => { reconnectable = false; o.log?.({ type: "pair_confirmation_failed", message: String(e) }); ws.close(1011, "pairing failed"); });
        });
        break;
      }
      case "peer.keys": {
        const known = identity.peers[m.deviceId];
        if (known && (known.kem !== m.pubKeys.kem || known.sig !== m.pubKeys.sig || known.sigAlg !== m.pubKeys.sigAlg)) throw new Error("对端公钥变更，必须重新配对");
        break;
      }
      case "presence":
        if (!m.online) dropPeer(m.deviceId);
        break;
      case "pair.removed": {
        const peer = m.deviceId === identity.deviceId ? m.phoneId : m.deviceId;
        dropPeer(peer);
        delete identity.peers[peer];
        await saveIdentity();
        break;
      }
      case "error":
        o.log?.({ type: "hub_error", code: m.code, message: m.message });
        if (!authenticated) throw new Error(`${m.code}: ${m.message}`);
        break;
    }
  }

  writeStatus();
  ws.onopen = () => send({ type: "hello", role: "device", deviceId: identity.deviceId, platform: process.platform === "darwin" ? "macos" : "cloud", name: o.name ?? hostname(), pubKeys, protocolVersion: 1, ...(o.token ? { token: o.token } : {}) });
  ws.onmessage = (event) => {
    inbound = inbound.then(async () => {
      if (closed) return;
      if (typeof event.data === "string") await onControl(AnyMessage.parse(JSON.parse(event.data)));
      else await onFrame(new Uint8Array(event.data as ArrayBuffer));
    }).catch((e) => {
      reconnectable = false;
      o.log?.({ type: "connection_error", message: String(e) });
      rejectReady(e instanceof Error ? e : new Error(String(e)));
      ws.close(1011, "invalid session");
    });
  };
  ws.onerror = () => rejectReady(new Error("WebSocket 连接失败"));
  ws.onclose = (event) => {
    reconnectable = reconnectable && [1001, 1006, 1012, 1013].includes(event.code);
    o.log?.({ type: "connection_closed", code: event.code, reconnectable });
    closed = true;
    writeStatus();
    pairConfirmation?.abort();
    clearTimeout(timer);
    clearInterval(heartbeat);
    cancelRun();
    media.close();
    for (const phone of terminals.keys()) dropPeer(phone);
    links.close();
    rejectReady(new Error("连接已关闭"));
    finishClosed();
  };
  try {
    await ready;
    return { deviceId: identity.deviceId, get offer() { return latestPairing!.offer; }, get code() { return latestPairing!.code; },
      refreshPairing, finished, close: () => { if (!closed) { reconnectable = false; ws.close(); } } };
  } catch (e) {
    reconnectable = false;
    clearTimeout(timer);
    ws.close();
    throw e;
  }
}
