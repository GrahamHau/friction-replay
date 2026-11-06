import { ReplayBuffer } from "./buffer.ts";
import { networkFailure, responseFailure, safeErrorReason, type RequestFailureContext } from "./request.ts";
import {
  DEFAULT_LIMITS, FRAME_MESSAGE, INTERACTIVE, NO_DEAD_CHECK, RECORD_OPTIONS, RageDetector, TEXT_MAX,
  afterPaint, clip, controlName, controlRole, defaultLoadRecorder, hasReplayActivity, uid,
  type FrictionType, type RecordFn, type ReplayLimits, type ReplayTrigger, type RrwebEvent,
} from "./shared.ts";

/**
 * 卡点回放采集端（照 Sentry Replay 的「出错才上传」）。纯浏览器 TS、不依赖任何框架。
 *
 * 录制只在本机内存，环形缓冲保留最近约 5 分钟；出现卡点或手动 capture() 时上传
 * 「事发前（以全量快照开头）+ 事发后 2 分钟」两段，平时一字不传。
 *
 * 卡点：rage_click 连续狂点、dead_click 点了没反应、error 报错（脚本异常、接口 4xx/5xx/网络失败、
 * 页面上标了 data-replay-error 的错误提示）、form_abandon 表单填到一半离开。
 *
 * 隐私：输入框一律打码；标了 data-replay-block 的区域整块不录；data-replay-ignore 内的点击和输入不判卡点。
 * 性能：rrweb 按需 import()；无操作 30 秒暂停、页面隐藏暂停；单次录制工作超 250ms 本页停止录制。
 * 内嵌页：跨源 iframe 里挂 startFrameBridge()，画面并进同一份回放，点击与卡点转给外层。
 * 采集失败一律静默降级，绝不影响业务页面。
 */

/** 来源由业务入口明确提供；HTTP 失败本身不能证明是用户操作失败。 */
export type ErrorContext = RequestFailureContext & {
  source: "user_action" | "background" | "unknown";
  operation?: string; code?: string; requestPath?: string; status?: number; reason?: string;
};

export type FrictionEvent = {
  id: string;
  type: FrictionType;
  at: string;
  path: string;
  target?: string;
  role?: string;
  detail?: string;
  context?: ErrorContext;
  /** 本次卡点对应的回放编号；回放不可用（未在录、无全量快照）时缺省。 */
  replayId?: string;
};

/** 上传到 `<endpoint>/replays` 的一段回放。 */
export type ReplayPartPayload = {
  replayId: string;
  part: "before" | "after";
  app: string;
  sessionId: string;
  trigger: ReplayTrigger;
  path: string;
  startedAt: string;
  endedAt: string;
  /** 触发这段回放的卡点（手动 capture 没有）。 */
  friction?: Pick<FrictionEvent, "type" | "at" | "target" | "detail">;
  events: RrwebEvent[];
};

export type ReplayRecorderOptions = {
  /** 上传口，回放 POST 到 `<endpoint>/replays`。建议同源，便于带登录票据。 */
  endpoint: string;
  /** 来源应用名，原样写进回放。 */
  app?: string;
  /** 关掉某些卡点判定，默认全开。 */
  triggers?: Partial<Record<FrictionType, boolean>>;
  /** 每次判出卡点都回调（含冷却期内复用回放的那些），可接入自己的埋点。 */
  onFriction?: (event: FrictionEvent) => void;
  /** 按请求路径补充错误来源：只传静态操作名、错误码和安全原因，不得传请求参数、正文或凭据。 */
  requestContext?: (pathname: string) => ErrorContext | undefined;
  /** 点了这些字样的按钮，所在表单 / 弹窗不再算放弃。 */
  submitWords?: RegExp;
  /** 换掉录制器的加载方式（测试，或页面不能动态 import 时）；默认 import("@rrweb/record")。 */
  loadRecorder?: () => Promise<RecordFn>;
  /** 自定义上传；默认 fetch（大包 gzip、5xx/408/429 退避重试 3 次），页面关闭时用 sendBeacon。 */
  upload?: (payload: ReplayPartPayload, options: { beacon: boolean }) => void;
  limits?: Partial<ReplayLimits>;
};

export type ReplayRecorder = {
  readonly sessionId: string;
  /** 手动抓一段回放并上传（例如用户提交反馈时），返回回放编号；回放不可用时返回 null。 */
  capture(trigger?: ReplayTrigger): string | null;
  /** 外部报错入口（如业务自己弹出的错误提示），按 error 卡点处理。 */
  reportError(message: string, context?: ErrorContext): void;
  /** 在回放时间线上打一个标记，只进回放；没在录时什么也不做。 */
  mark(tag: string, payload?: Record<string, unknown>): void;
  stop(): void;
};

const DEFAULT_SUBMIT = /submit|save|confirm|create|send|publish|apply|upload|import|done|ok|提交|保存|确定|确认|创建|新建|发布|发送|完成|添加|更新|导入|上传|应用/i;

const activeRecorders = new WeakMap<Window, ReplayRecorder>();

function currentPath(): string {
  return clip(`${location.pathname}${location.search}`, TEXT_MAX.path) ?? "/";
}

function readSessionId(app: string, idleMs: number): string {
  const key = `friction-replay:session:${app}`;
  try {
    const raw = sessionStorage.getItem(key);
    const stored = raw ? JSON.parse(raw) as { id?: string; last?: number } : null;
    const id = stored?.id && typeof stored.last === "number" && Date.now() - stored.last < idleMs ? stored.id : uid();
    sessionStorage.setItem(key, JSON.stringify({ id, last: Date.now() }));
    return id;
  } catch { return uid(); }
}

/** 表单 / 弹窗的名称，用于「填到一半放弃」。 */
function containerName(container: Element): string | undefined {
  const dialog = container.closest("[role=dialog]");
  if (dialog && dialog !== container) return containerName(dialog);
  const aria = container.getAttribute("aria-label");
  if (aria) return clip(aria, TEXT_MAX.detail);
  const labelledBy = container.getAttribute("aria-labelledby");
  const labelled = labelledBy ? container.ownerDocument.getElementById(labelledBy)?.textContent : null;
  if (labelled) return clip(labelled, TEXT_MAX.detail);
  const heading = container.querySelector("h1, h2, h3, [data-dialog-title]");
  return clip(heading?.textContent ?? container.getAttribute("name") ?? (container.tagName === "FORM" ? "form" : "dialog"), TEXT_MAX.detail);
}

/** 默认上传：同源 fetch，≥60KB 用 gzip；5xx/408/429/网络失败按 1s/3s/10s 退避重试，重试复用同一编号与压缩结果。 */
export function createFetchUpload(endpoint: string): { upload: (payload: ReplayPartPayload, options: { beacon: boolean }) => void; dispose: () => void } {
  const base = endpoint.replace(/\/+$/, "");
  const url = `${base}/replays`;
  let pendingBytes = 0;
  let disposed = false;
  const timers = new Set<number>();
  const upload = (payload: ReplayPartPayload, { beacon }: { beacon: boolean }) => {
    const text = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(text).byteLength;
    if (beacon && typeof navigator.sendBeacon === "function" && bytes < 60_000) {
      try { if (navigator.sendBeacon(url, new Blob([text], { type: "application/json" }))) return; } catch { /* 退回 fetch */ }
    }
    // 同时在途的上传有总量上限，避免慢网下内存堆积。
    if (pendingBytes + bytes > 48_000_000) return;
    pendingBytes += bytes;
    let released = false;
    const release = () => { if (!released) { released = true; pendingBytes -= bytes; } };
    let encoded: Promise<{ body: BodyInit; gzip: boolean }> | undefined;
    const attempt = async (retry = 0): Promise<void> => {
      try {
        encoded ??= bytes >= 60_000 && typeof CompressionStream === "function"
          ? new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer()
            .then(body => ({ body, gzip: true })).catch(() => ({ body: text, gzip: false }))
          : Promise.resolve({ body: text, gzip: false });
        const encodedBody = await encoded;
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(encodedBody.gzip ? { "content-encoding": "gzip" } : {}) },
          body: encodedBody.body, credentials: "same-origin", keepalive: bytes < 60_000,
          signal: AbortSignal.timeout(20_000),
        });
        if (response.ok || (response.status < 500 && ![408, 429].includes(response.status))) { release(); return; }
      } catch { /* 网络失败，退避重试 */ }
      if (disposed || retry >= 3) { release(); return; }
      const timer = window.setTimeout(() => { timers.delete(timer); void attempt(retry + 1); }, [1000, 3000, 10_000][retry]);
      timers.add(timer);
    };
    void attempt();
  };
  return { upload, dispose: () => { disposed = true; timers.forEach(id => window.clearTimeout(id)); timers.clear(); } };
}

export function createReplayRecorder(options: ReplayRecorderOptions): ReplayRecorder {
  const noop: ReplayRecorder = { sessionId: "", capture: () => null, reportError: () => {}, mark: () => {}, stop: () => {} };
  if (typeof window === "undefined" || typeof document === "undefined") return noop;
  // 重复挂载先结束旧实例，避免叠加 History / fetch 包装和监听。
  activeRecorders.get(window)?.stop();

  const limits: ReplayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const app = options.app ?? "web";
  const enabled = (type: FrictionType) => options.triggers?.[type] !== false;
  const submitWords = options.submitWords ?? DEFAULT_SUBMIT;
  const sessionId = readSessionId(app, 30 * 60_000);
  const cleanups: Array<() => void> = [];
  let stopped = false;

  let upload = options.upload;
  if (!upload) {
    const fetchUpload = createFetchUpload(endpoint);
    upload = fetchUpload.upload;
    cleanups.push(fetchUpload.dispose);
  }
  const send = (payload: ReplayPartPayload, beacon: boolean) => { try { upload!(payload, { beacon }); } catch { /* 上传失败不影响页面 */ } };

  // ---- 录制 ----
  const buffer = new ReplayBuffer(limits.replayBeforeMs, limits.replayMaxBytes);
  let recording = false, loadingRecorder = false;
  let stopRecorder: (() => void) | undefined;
  let recorder: RecordFn | undefined;
  // 每次开录一个会话：rrweb 停止后不摘它为跨源 iframe 挂的 message 监听，旧会话的回调可能还会被叫到，按会话丢掉。
  let session: object | undefined;
  let idleTimer: number | undefined;
  let checkoutTimer: number | undefined;
  let cancelWork: (() => void) | undefined;
  let suspended = false;
  let generation = 0;
  const pauseRecorder = () => {
    generation++;
    cancelWork?.(); cancelWork = undefined;
    window.clearTimeout(checkoutTimer);
    loadingRecorder = false;
    const wasRecording = recording;
    stopRecorder?.(); stopRecorder = undefined; recording = false; session = undefined;
    window.clearTimeout(idleTimer);
    if (wasRecording) tellFrames("pause");
  };
  const keepActive = () => {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(pauseRecorder, limits.replayIdleMs);
  };
  cleanups.push(pauseRecorder);
  // 录制工作超预算：本页停止画面录制，卡点判定照常；不再触发抓取，免得采集自身再唤醒慢录制器。
  const withinBudget = (started: number) => {
    if (performance.now() - started <= limits.workBudgetMs) return true;
    suspended = true;
    pauseRecorder();
    return false;
  };
  const scheduleCheckout = () => {
    checkoutTimer = window.setTimeout(() => {
      cancelWork = afterPaint(() => {
        cancelWork = undefined;
        if (!recording || stopped || suspended || document.visibilityState === "hidden") return;
        const started = performance.now();
        try { recorder?.takeFullSnapshot?.(true); } catch { pauseRecorder(); return; }
        if (withinBudget(started)) scheduleCheckout();
      });
    }, limits.checkoutEveryMs);
  };
  const loadRecorder = options.loadRecorder ?? defaultLoadRecorder;
  const startRecording = () => {
    if (stopped || suspended || recording || loadingRecorder || document.visibilityState === "hidden") return;
    loadingRecorder = true;
    const started = generation;
    cancelWork = afterPaint(() => {
      cancelWork = undefined;
      void loadRecorder().then((record) => {
        if (stopped || started !== generation || document.visibilityState === "hidden") return;
        const t0 = performance.now();
        const current = {};
        session = current;
        // 记下 rrweb 这次挂在 window 上的 message 监听（跨源 iframe 用），暂停时一并摘掉，免得每次恢复录制叠一层。
        const messageListeners: EventListenerOrEventListenerObject[] = [];
        const addListener = window.addEventListener;
        window.addEventListener = function (this: Window, type: string, listener: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
          if (this === window && type === "message" && listener) messageListeners.push(listener);
          return addListener.call(this, type, listener as EventListenerOrEventListenerObject, opts);
        } as typeof window.addEventListener;
        let stop: (() => void) | undefined;
        try {
          stop = record({
            ...RECORD_OPTIONS,
            emit: (event: unknown, isCheckout?: boolean) => {
              if (session !== current) return;
              const row = event as RrwebEvent;
              buffer.push(row, Boolean(isCheckout));
              if (hasReplayActivity([row])) keepActive();
              // 外层出了全量快照（开录、恢复、定时快照），活跃的内嵌页也得重拍，否则新段里内嵌页是空框。
              if (row.type === 2) tellFrames("record", true);
            },
          });
        } finally { window.addEventListener = addListener; }
        recording = typeof stop === "function";
        recorder = record;
        const unhook = () => messageListeners.forEach(listener => window.removeEventListener("message", listener));
        stopRecorder = () => { stop?.(); unhook(); };
        if (recording) { if (withinBudget(t0)) { keepActive(); scheduleCheckout(); } }
        else { session = undefined; unhook(); }
      }).catch(() => { if (started === generation) recording = false; })
        .finally(() => { if (started === generation) loadingRecorder = false; });
    });
  };

  // ---- 内嵌页：frame bridge 转来的操作、点击与卡点 ----
  // 只认本页 iframe 发来的消息，每个框每秒最多 30 条；近 replayIdleMs 内有操作的框才让它录。
  const frames = new Map<Window, { lastActive: number; windowStart: number; count: number }>();
  const frameOf = (source: unknown) => {
    for (const frame of document.querySelectorAll("iframe")) if (frame.contentWindow === source) return frame;
    return null;
  };
  function tellFrames(kind: "record" | "pause", fresh = false) {
    const now = Date.now();
    for (const [win, state] of frames) {
      if (!frameOf(win)) { frames.delete(win); continue; }
      if (kind === "pause" || now - state.lastActive < limits.replayIdleMs) {
        try { win.postMessage({ type: FRAME_MESSAGE, kind, fresh }, "*"); } catch { /* 框已卸载 */ }
      }
    }
  }
  const text = (value: unknown, max: number) => (typeof value === "string" ? clip(value, max) : undefined);
  const ROLES = new Set(["button", "link", "tab", "menuitem", "checkbox", "option", "row", "other"]);
  const onFrameMessage = (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (stopped || !data || typeof data !== "object" || data["type"] !== FRAME_MESSAGE) return;
    const source = event.source as Window | null;
    if (!source || source === window || !frameOf(source)) return;
    const now = Date.now();
    let state = frames.get(source);
    if (!state) { state = { lastActive: 0, windowStart: now, count: 0 }; frames.set(source, state); }
    if (now - state.windowStart >= 1000) { state.windowStart = now; state.count = 0; }
    if (++state.count > 30) return;
    const target = text(data["target"], TEXT_MAX.target);
    const role = typeof data["role"] === "string" && ROLES.has(data["role"]) ? data["role"] : "other";
    if (data["kind"] === "activity") {
      state.lastActive = now;
      startRecording();
      if (recording) {
        keepActive();
        try { source.postMessage({ type: FRAME_MESSAGE, kind: "record", fresh: false }, "*"); } catch { /* 框已卸载 */ }
      }
    } else if (data["kind"] === "friction") {
      if (data["friction"] === "rage_click" || data["friction"] === "dead_click") friction(data["friction"], { target, role });
      else if (data["friction"] === "error") { const detail = text(data["detail"], TEXT_MAX.detail); if (detail) reportError(`[frame] ${detail}`); }
    }
  };
  window.addEventListener("message", onFrameMessage);
  cleanups.push(() => { window.removeEventListener("message", onFrameMessage); frames.clear(); });

  // 尽早异步加载，缩小首屏报错发生在录制器启动之前的空窗。
  startRecording();
  const wake = () => { startRecording(); if (recording) keepActive(); };
  const activityEvents = ["pointerdown", "pointermove", "keydown", "input", "scroll"] as const;
  activityEvents.forEach(type => document.addEventListener(type, wake, { capture: true, passive: true }));
  const onVisibility = () => { if (document.visibilityState === "hidden") pauseRecorder(); else wake(); };
  document.addEventListener("visibilitychange", onVisibility);
  cleanups.push(() => {
    activityEvents.forEach(type => document.removeEventListener(type, wake, true));
    document.removeEventListener("visibilitychange", onVisibility);
  });

  // ---- 抓取：事发前 + 事发后 ----
  const cooldown = new Map<string, { at: number; replayId: string }>();
  const capture = (trigger: ReplayTrigger, cause?: ReplayPartPayload["friction"]): string | null => {
    if (stopped) return null;
    if (!recording) { startRecording(); return null; }
    const path = currentPath();
    const key = `${trigger}:${path}`;
    const now = Date.now();
    const previous = cooldown.get(key);
    if (trigger !== "manual" && previous && now - previous.at < limits.replayCooldownMs) return previous.replayId;
    const replayId = uid();
    const before = buffer.snapshot();
    if (before.length === 0) return null;
    cooldown.set(key, { at: now, replayId });
    if (cooldown.size > 100) cooldown.delete(cooldown.keys().next().value!);
    const base = { replayId, app, sessionId, trigger, path, ...(cause ? { friction: cause } : {}) };
    // 事发前只有静态快照、没有任何操作或画面变化的，等事发后真有变化再一起发，避免上传无用的大快照。
    let beforeSent = false;
    const sendBefore = () => {
      if (beforeSent) return;
      beforeSent = true;
      send({ ...base, part: "before", startedAt: new Date(before[0]!.timestamp).toISOString(), endedAt: new Date(now).toISOString(), events: before }, false);
    };
    if (hasReplayActivity(before)) sendBefore();
    const after: RrwebEvent[] = [];
    let afterBytes = 0;
    let sent = false;
    const sendAfter = (beacon: boolean) => {
      if (sent) return;
      sent = true;
      unfollow();
      window.clearTimeout(afterTimer);
      window.removeEventListener("pagehide", onHide);
      if (!beforeSent && cooldown.get(key)?.replayId === replayId) cooldown.delete(key);
      if (hasReplayActivity(after)) send({ ...base, part: "after", startedAt: new Date(now).toISOString(), endedAt: new Date().toISOString(), events: after }, beacon);
    };
    const unfollow = buffer.follow((event) => {
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (afterBytes + bytes > limits.replayMaxBytes) { sendAfter(false); return; }
      afterBytes += bytes; after.push(event);
      if (hasReplayActivity([event])) sendBefore();
    });
    // 事发后继续收 replayAfterMs；页面先关掉就把已收的尽量发出去。
    const onHide = () => sendAfter(true);
    const afterTimer = window.setTimeout(() => sendAfter(false), limits.replayAfterMs);
    window.addEventListener("pagehide", onHide);
    cleanups.push(() => sendAfter(true));
    return replayId;
  };

  const friction = (type: FrictionType, fields: Pick<FrictionEvent, "target" | "role" | "detail" | "context"> & { path?: string; at?: string } = {}) => {
    if (stopped || !enabled(type)) return;
    const path = fields.path ?? currentPath();
    const at = fields.at ?? new Date().toISOString();
    const cause = { type, at, ...(fields.target ? { target: fields.target } : {}), ...(fields.detail ? { detail: fields.detail } : {}) };
    // 卡点发生的页面已经离开（例如接口失败回来时已切路由），这段画面对不上，不抓。
    const replayId = path === currentPath() ? capture(type, cause) : null;
    const event: FrictionEvent = { id: uid(), type, at, path, ...fields, ...(replayId ? { replayId } : {}) };
    try { options.onFriction?.(event); } catch { /* 回调出错不影响采集 */ }
  };

  // ---- 报错 ----
  let lastNetworkAt = 0;
  const errorSeen = new Map<string, number>();
  const reportError = (message: string, context?: ErrorContext, occurrence?: { path: string; at: string }) => {
    const detail = clip(message, TEXT_MAX.detail);
    if (!detail) return;
    if (context) {
      // 白名单重建，丢掉调用方误塞的任何其他字段。
      const raw = context;
      context = { source: raw.source === "user_action" || raw.source === "background" ? raw.source : "unknown" };
      for (const name of ["operation", "code", "reason"] as const) {
        if (typeof raw[name] === "string") {
          const value = name === "reason" ? safeErrorReason(raw[name]) : clip(raw[name], 100);
          if (value) context[name] = value;
        }
      }
      if (["http", "network", "timeout"].includes(raw.failureKind ?? "")) context.failureKind = raw.failureKind;
      if (typeof raw.method === "string" && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(raw.method)) context.method = raw.method;
      if (typeof raw.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(raw.requestId)) context.requestId = raw.requestId;
      if (typeof raw.errorName === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(raw.errorName)) context.errorName = raw.errorName;
      if (typeof raw.online === "boolean") context.online = raw.online;
      if (Number.isSafeInteger(raw.elapsedMs) && raw.elapsedMs! >= 0) context.elapsedMs = raw.elapsedMs;
      if (typeof raw.requestPath === "string" && raw.requestPath.startsWith("/") && !raw.requestPath.startsWith("//")) context.requestPath = raw.requestPath.split(/[?#]/)[0]!.slice(0, 300);
      if (Number.isInteger(raw.status) && raw.status! >= 400 && raw.status! <= 599) context.status = raw.status;
    }
    // 同一页面同一错误 10 秒内只算一次。
    const { elapsedMs: _elapsed, requestId: _requestId, ...signature } = context ?? {};
    const key = `${occurrence?.path ?? currentPath()}|${detail}|${JSON.stringify(signature)}`;
    if (Date.now() - (errorSeen.get(key) ?? 0) < 10_000) return;
    errorSeen.set(key, Date.now());
    if (errorSeen.size > 200) errorSeen.delete(errorSeen.keys().next().value!);
    friction("error", { detail, ...(context ? { context } : {}), ...occurrence });
  };

  // 接口：结束即算页面「有反应」；同源 4xx/5xx 与网络失败记为报错。导航取消可能抛 TypeError，等下一任务确认页面仍在再记。
  let pageInactive = false;
  const pendingFailures = new Set<number>();
  const observedRejections = new WeakSet<object>();
  const clearPendingFailures = () => { pendingFailures.forEach(timer => window.clearTimeout(timer)); pendingFailures.clear(); };
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function replayFetch(this: unknown, ...args: Parameters<typeof fetch>) {
      // 解析或分类失败不能改变原请求结果。
      const startedAt = Date.now();
      let signal: AbortSignal | null | undefined;
      let method = "GET";
      let url: URL | null = null;
      let context: ErrorContext = { source: "unknown" };
      try {
        const input = args[0];
        url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
        const request = typeof input === "object" && "method" in input ? input as Request : undefined;
        method = (args[1]?.method ?? request?.method ?? "GET").toUpperCase();
        signal = args[1]?.signal === undefined ? request?.signal : args[1].signal;
        context = options.requestContext?.(url.pathname) ?? context;
      } catch { /* 由原 fetch 处理无效输入 */ }
      const observe = url !== null && url.origin === location.origin && !url.pathname.startsWith(`${endpoint}/`);
      try {
        const response = await originalFetch.apply(this, args);
        lastNetworkAt = Date.now();
        if (observe && response.status >= 400 && response.status <= 599) {
          const status = response.status;
          const occurrence = { path: currentPath(), at: new Date().toISOString() };
          const failureContext: ErrorContext = { ...context, requestPath: url!.pathname, method, status,
            failureKind: "http", elapsedMs: Math.max(0, Date.now() - startedAt),
            requestId: response.headers.get("x-request-id") ?? undefined };
          const report = (extra: { code?: string; reason?: string }) => {
            if (!stopped) reportError(`HTTP ${status}: ${url!.pathname}`, { ...failureContext, reason: context.reason ?? `Server returned HTTP ${status}`, ...extra }, occurrence);
          };
          // JSON 错误信封与业务消费并行读取，不吞掉原响应。
          if (/json/i.test(response.headers.get("content-type") ?? "")) void responseFailure(response).then(report);
          else report({});
        }
        return response;
      } catch (error) {
        lastNetworkAt = Date.now();
        const failure = networkFailure(error, signal);
        const cancelled = failure.failureKind !== "timeout" && (signal?.aborted || (error && typeof error === "object" && "name" in error && error.name === "AbortError"));
        if (observe && error && typeof error === "object") observedRejections.add(error);
        if (observe && !cancelled && !stopped && !pageInactive) {
          const occurrence = { path: currentPath(), at: new Date().toISOString() };
          const failureContext: ErrorContext = { ...context, ...failure, method, online: navigator.onLine, elapsedMs: Math.max(0, Date.now() - startedAt) };
          const timer = window.setTimeout(() => {
            pendingFailures.delete(timer);
            if (!stopped && !pageInactive) reportError(`Request failed: ${url!.pathname}`, { ...failureContext, requestPath: url!.pathname, code: failure.failureKind === "timeout" ? "request_timeout" : "request_failed" }, occurrence);
          }, 0);
          pendingFailures.add(timer);
        }
        throw error;
      }
    } as typeof fetch;
    cleanups.push(() => { clearPendingFailures(); window.fetch = originalFetch; });
  }
  const onError = (event: ErrorEvent) => { if (event.message) reportError(event.message); };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason as { message?: string; name?: string } | undefined;
    if (reason?.name === "AbortError" || (reason && typeof reason === "object" && observedRejections.has(reason))) return;
    reportError(reason?.message ?? String(event.reason ?? "Unhandled rejection"));
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  cleanups.push(() => { window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onRejection); });

  // 业务自己处理掉的错误不会触发 window.error：页面在错误提示元素上标 data-replay-error="展示文案" 即可。
  const visibleErrors = new WeakMap<Element, string>();
  const observeError = (element: Element) => {
    if (element.closest("[data-replay-ignore], [data-replay-block]")) return;
    const message = element.getAttribute("data-replay-error");
    if (!message || visibleErrors.get(element) === message) return;
    visibleErrors.set(element, message);
    const source = element.getAttribute("data-replay-source");
    const operation = clip(element.getAttribute("data-replay-operation"), 100);
    const code = clip(element.getAttribute("data-replay-code"), 100);
    const reason = clip(element.getAttribute("data-replay-reason"), 240);
    reportError(`UI error: ${message}`, { source: source === "user_action" || source === "background" ? source : "unknown", ...(operation ? { operation } : {}), ...(code ? { code } : {}), ...(reason ? { reason } : {}) });
  };
  const scanErrors = (element: Element) => {
    if (element.matches("[data-replay-error]")) observeError(element);
    element.querySelectorAll("[data-replay-error]").forEach(observeError);
  };
  scanErrors(document.documentElement);

  // ---- 页面变化：判「点了没反应」与表单 / 弹窗消失 ----
  let lastMutationAt = 0;
  let pressed: Element | null = null;
  const dirty = new Set<Element>();
  const abandon = (container: Element) => { dirty.delete(container); friction("form_abandon", { detail: containerName(container) }); };
  const abandonDirty = () => { for (const container of [...dirty]) abandon(container); };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.attributeName === "data-replay-error" && record.target instanceof Element) observeError(record.target);
      for (const node of record.addedNodes) if (node instanceof Element) scanErrors(node);
    }
    for (const record of records) {
      // 按下时控件自己改属性（按下态、焦点态）不算反应。
      if (record.type === "attributes" && pressed && (record.target === pressed || (record.target as Element).contains?.(pressed))) continue;
      lastMutationAt = Date.now();
      break;
    }
    if (dirty.size > 0) for (const container of [...dirty]) if (!container.isConnected) abandon(container);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  cleanups.push(() => observer.disconnect());

  // ---- 路由：离开页面时，填了一半的表单算放弃 ----
  let page = currentPath();
  const onRoute = () => {
    if (stopped) return;
    const next = currentPath();
    if (next === page) return;
    abandonDirty();
    page = next;
  };
  const history = window.history;
  const originalPush = history.pushState, originalReplace = history.replaceState;
  history.pushState = function pushState(...args: Parameters<History["pushState"]>) { const result = originalPush.apply(this, args); queueMicrotask(onRoute); return result; };
  history.replaceState = function replaceState(...args: Parameters<History["replaceState"]>) { const result = originalReplace.apply(this, args); queueMicrotask(onRoute); return result; };
  window.addEventListener("popstate", onRoute);
  cleanups.push(() => { history.pushState = originalPush; history.replaceState = originalReplace; window.removeEventListener("popstate", onRoute); });

  // ---- 点击 ----
  const rage = new RageDetector(limits.rageWindowMs, limits.rageClicks);
  const clickTimers = new Set<number>();
  cleanups.push(() => { clickTimers.forEach(id => window.clearTimeout(id)); clickTimers.clear(); });
  // 点上传区会打开系统选文件窗口，页面本身不变：经隐藏 input[type=file] 代点的这次算有反应。
  let filePickerAt = 0;
  const onClick = (event: MouseEvent) => {
    const origin = event.target instanceof Element ? event.target : null;
    if (origin?.matches('input[type="file"]')) { filePickerAt = Date.now(); return; }
    if (!origin || origin.closest("[data-replay-ignore]")) return;
    const control = origin.closest(INTERACTIVE);
    const now = Date.now();
    if (control) {
      const target = controlName(control);
      const role = controlRole(control);
      if (rage.hit(control, now)) friction("rage_click", { target, role });
      // 悬停已展示的说明（tooltip）是已发生的反馈，点击后不要求再改 DOM。
      const described = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).some(id => {
        const tip = id ? document.getElementById(id) : null;
        return tip?.getAttribute("role") === "tooltip" && !tip.closest('[hidden], [aria-hidden="true"]')
          && window.getComputedStyle(tip).display !== "none" && window.getComputedStyle(tip).visibility !== "hidden";
      });
      if (!control.matches(NO_DEAD_CHECK) && !described) {
        pressed = control;
        const path = currentPath();
        const clickTimer = window.setTimeout(() => {
          clickTimers.delete(clickTimer);
          if (pressed === control) pressed = null;
          const reacted = lastMutationAt >= now || lastNetworkAt >= now || filePickerAt >= now || currentPath() !== path || !control.isConnected;
          if (!reacted && !stopped) friction("dead_click", { target, role });
        }, limits.deadClickMs);
        clickTimers.add(clickTimer);
      }
      // 点了提交类按钮：所在表单 / 弹窗不再算放弃。
      if (submitWords.test(target ?? "") || (control as HTMLButtonElement).type === "submit") {
        const container = control.closest("form, [role=dialog]");
        if (container) dirty.delete(container);
      }
    } else if (rage.hit(origin, now)) {
      // 对着不是控件的地方连点，多半以为它能点。
      friction("rage_click", { target: clip((origin as HTMLElement).innerText?.split("\n")[0], TEXT_MAX.target) ?? origin.tagName.toLowerCase(), role: "other" });
    }
  };
  document.addEventListener("click", onClick, true);
  cleanups.push(() => document.removeEventListener("click", onClick, true));

  // ---- 表单：有输入、没提交就离开 ----
  const onInput = (event: Event) => {
    const origin = event.target instanceof Element ? event.target : null;
    if (!origin || origin.closest("[data-replay-ignore]")) return;
    // 搜索框、筛选这类即时输入不算填表。
    if (origin.matches("[type=search], [role=searchbox], [role=combobox]")) return;
    const container = origin.closest("[role=dialog] form, [role=dialog], form");
    if (container) dirty.add(container);
  };
  const onSubmit = (event: Event) => {
    const form = event.target instanceof Element ? event.target : null;
    if (!form) return;
    dirty.delete(form);
    const dialog = form.closest("[role=dialog]");
    if (dialog) dirty.delete(dialog);
  };
  document.addEventListener("input", onInput, true);
  document.addEventListener("submit", onSubmit, true);
  cleanups.push(() => { document.removeEventListener("input", onInput, true); document.removeEventListener("submit", onSubmit, true); });

  // ---- 离开 ----
  const onPageHide = () => { pageInactive = true; clearPendingFailures(); abandonDirty(); };
  const onPageShow = () => { pageInactive = false; };
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  cleanups.push(() => { window.removeEventListener("pagehide", onPageHide); window.removeEventListener("pageshow", onPageShow); });

  const instance: ReplayRecorder = {
    sessionId,
    capture: (trigger = "manual") => capture(trigger),
    reportError: (message, context) => reportError(message, context),
    mark(tag, payload) {
      if (!recording || !recorder?.addCustomEvent) return;
      try { recorder.addCustomEvent(clip(tag, TEXT_MAX.target) ?? "mark", payload ?? {}); } catch { /* 录制器未就绪 */ }
    },
    stop() {
      if (stopped) return;
      // 先发出在收的事发后片段，再标记停止。
      cleanups.splice(0).reverse().forEach((cleanup) => { try { cleanup(); } catch { /* 卸载不影响页面 */ } });
      stopped = true;
      if (activeRecorders.get(window) === instance) activeRecorders.delete(window);
    },
  };
  activeRecorders.set(window, instance);
  return instance;
}
