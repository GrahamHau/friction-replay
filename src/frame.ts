import {
  DEFAULT_LIMITS, FRAME_MESSAGE, INTERACTIVE, NO_DEAD_CHECK, RECORD_OPTIONS, RageDetector, TEXT_MAX,
  clip, controlName, controlRole, defaultLoadRecorder, type RecordFn,
} from "./shared.ts";

/**
 * 内嵌页一侧的桥：跨源 / 沙箱 iframe 里，外层的录制器既录不到画面、也收不到点击。
 * 在内嵌页里调用 startFrameBridge()，它只做三件事，全部经 postMessage 交给外层的 createReplayRecorder：
 *   - 有操作就报一声 activity（每秒最多一次），外层据此保持录制；
 *   - 连续狂点、点了没反应、脚本异常照外层同样的口径判好再报，外层按卡点抓回放；
 *   - 外层在录时才让它开录（rrweb 跨源 iframe 模式，画面经外层并进同一份回放），外层暂停它就停。
 *
 * 没人碰过的内嵌页不加载录制器；页面就是顶层窗口时什么也不做。同源 iframe 外层本来录得到画面，这里只转卡点。
 */
export type FrameBridgeOptions = {
  /** 换掉录制器的加载方式（沙箱页面里通常改成加载一份本地静态脚本）。 */
  loadRecorder?: () => Promise<RecordFn>;
  deadClickMs?: number;
};

export function startFrameBridge(options: FrameBridgeOptions = {}): () => void {
  if (typeof window === "undefined" || window.parent === window) return () => {};
  const parent = window.parent;
  let sameOrigin = false;
  try { sameOrigin = Boolean(parent.document); } catch { sameOrigin = false; }
  const deadClickMs = options.deadClickMs ?? DEFAULT_LIMITS.deadClickMs;
  const cleanups: Array<() => void> = [];
  let stopped = false;
  const post = (kind: string, fields: Record<string, unknown> = {}) => {
    if (stopped) return;
    try { parent.postMessage({ type: FRAME_MESSAGE, kind, ...fields }, "*"); } catch { /* 外层已卸载 */ }
  };

  // ---- 操作 ----
  let lastActivity = 0;
  const onActivity = () => {
    const now = Date.now();
    if (now - lastActivity < 1000) return;
    lastActivity = now;
    post("activity");
  };
  const activityEvents = ["pointerdown", "pointermove", "keydown", "input", "scroll"] as const;
  activityEvents.forEach(type => document.addEventListener(type, onActivity, { capture: true, passive: true }));
  cleanups.push(() => activityEvents.forEach(type => document.removeEventListener(type, onActivity, true)));

  // ---- 页面变化与请求：判「点了没反应」 ----
  let lastMutationAt = 0, lastNetworkAt = 0;
  let pressed: Element | null = null;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && pressed && (record.target === pressed || (record.target as Element).contains?.(pressed))) continue;
      lastMutationAt = Date.now();
      break;
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  cleanups.push(() => observer.disconnect());
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function frameFetch(this: unknown, ...args: Parameters<typeof fetch>) {
      try { return await originalFetch.apply(this, args); } finally { lastNetworkAt = Date.now(); }
    } as typeof fetch;
    cleanups.push(() => { window.fetch = originalFetch; });
  }

  // ---- 点击 ----
  const rage = new RageDetector();
  const clickTimers = new Set<number>();
  cleanups.push(() => { clickTimers.forEach(id => window.clearTimeout(id)); clickTimers.clear(); });
  const onClick = (event: MouseEvent) => {
    const origin = event.target instanceof Element ? event.target : null;
    if (!origin || origin.closest("[data-replay-ignore]")) return;
    const control = origin.closest(INTERACTIVE);
    const now = Date.now();
    if (control) {
      const target = controlName(control);
      const role = controlRole(control);
      if (rage.hit(control, now)) post("friction", { friction: "rage_click", target, role });
      if (!control.matches(NO_DEAD_CHECK)) {
        pressed = control;
        const clickTimer = window.setTimeout(() => {
          clickTimers.delete(clickTimer);
          if (pressed === control) pressed = null;
          const reacted = lastMutationAt >= now || lastNetworkAt >= now || !control.isConnected;
          if (!reacted) post("friction", { friction: "dead_click", target, role });
        }, deadClickMs);
        clickTimers.add(clickTimer);
      }
    } else if (rage.hit(origin, now)) {
      post("friction", { friction: "rage_click", target: clip((origin as HTMLElement).innerText?.split("\n")[0], TEXT_MAX.target) ?? origin.tagName.toLowerCase(), role: "other" });
    }
  };
  document.addEventListener("click", onClick, true);
  cleanups.push(() => document.removeEventListener("click", onClick, true));

  // ---- 脚本异常 ----
  const onError = (event: ErrorEvent) => { if (event.message) post("friction", { friction: "error", detail: clip(event.message, TEXT_MAX.detail) }); };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason as { message?: string; name?: string } | undefined;
    if (reason?.name === "AbortError") return;
    post("friction", { friction: "error", detail: clip(reason?.message ?? String(event.reason ?? "Unhandled rejection"), TEXT_MAX.detail) });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  cleanups.push(() => { window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onRejection); });

  // ---- 录制：外层说录才录 ----
  let stopRecorder: (() => void) | undefined;
  let recorder: RecordFn | undefined;
  let loading = false;
  const loadRecorder = options.loadRecorder ?? defaultLoadRecorder;
  const pause = () => { stopRecorder?.(); stopRecorder = undefined; };
  cleanups.push(pause);
  const record = (fresh: boolean) => {
    if (sameOrigin || stopped) return;
    if (stopRecorder) {
      if (fresh) { try { recorder?.takeFullSnapshot?.(); } catch { /* 录制器已停 */ } }
      return;
    }
    if (loading) return;
    loading = true;
    void loadRecorder().then((load) => {
      if (stopped || stopRecorder) return;
      recorder = load;
      // 跨源模式：事件不在这里落地，rrweb 自己发给外层，外层换好编号并进同一份回放。
      stopRecorder = load({ ...RECORD_OPTIONS }) ?? undefined;
    }).catch(() => { /* 录制器加载失败：只是没有画面，不影响页面 */ }).finally(() => { loading = false; });
  };
  const onMessage = (event: MessageEvent) => {
    if (event.source !== parent) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object" || data["type"] !== FRAME_MESSAGE) return;
    if (data["kind"] === "record") record(data["fresh"] === true);
    else if (data["kind"] === "pause") pause();
  };
  window.addEventListener("message", onMessage);
  cleanups.push(() => window.removeEventListener("message", onMessage));

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cleanups.splice(0).reverse().forEach(cleanup => { try { cleanup(); } catch { /* 卸载不影响页面 */ } });
  };
  window.addEventListener("pagehide", stop, { once: true });
  return stop;
}
