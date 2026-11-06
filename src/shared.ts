/** 采集端（外层页面）与内嵌页桥共用的类型、常量和判定。 */

export type FrictionType = "rage_click" | "dead_click" | "error" | "form_abandon";
export type ReplayTrigger = FrictionType | "manual";

/** rrweb 的 record：调用开始录制、返回停止函数；另带手动全量快照与自定义事件。 */
export type RecordFn = ((options: Record<string, unknown>) => (() => void) | undefined) & {
  takeFullSnapshot?: (isCheckout?: boolean) => void;
  addCustomEvent?: (tag: string, payload: unknown) => void;
};

export type RrwebEvent = { type: number; timestamp: number; [key: string]: unknown };

/** 外层与内嵌页之间 postMessage 的类型标识。 */
export const FRAME_MESSAGE = "friction-replay-frame";

export const DEFAULT_LIMITS = {
  /** 连续狂点：时间窗内同一控件点到第 N 下判一次。 */
  rageWindowMs: 1_000,
  rageClicks: 3,
  /** 点击后这么久页面没变化、没有请求结束，判「点了没反应」。 */
  deadClickMs: 1_500,
  /** 事发前保留多久、事发后继续收多久。 */
  replayBeforeMs: 300_000,
  replayAfterMs: 120_000,
  /** 定时全量快照间隔：环形缓冲按快照分段丢弃。 */
  checkoutEveryMs: 60_000,
  /** 同一页面同一类卡点在冷却期内复用上一段回放。 */
  replayCooldownMs: 60_000,
  /** 这么久没有操作就暂停录制，有操作再恢复（恢复时重拍全量快照）。 */
  replayIdleMs: 30_000,
  /** 单段回放原始 JSON 上限（压缩前）。 */
  replayMaxBytes: 16_000_000,
  /** 单次同步录制工作超过此时长，本页停止录制，避免拖慢交互。 */
  workBudgetMs: 250,
} as const;
export type ReplayLimits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };

/** 外层与内嵌页一致的 rrweb 录制参数：输入一律打码，标了 data-replay-block 的区域整块不录。 */
export const RECORD_OPTIONS = {
  maskAllInputs: true,
  blockSelector: "[data-replay-block]",
  recordCanvas: false,
  recordCrossOriginIframes: true,
  collectFonts: false,
  inlineImages: false,
  slimDOMOptions: "all",
  sampling: { mousemove: 100, scroll: 150, input: "last" },
} as const;

export const defaultLoadRecorder = (): Promise<RecordFn> =>
  import("@rrweb/record").then(module => module.record as unknown as RecordFn);

export const INTERACTIVE = "button, a[href], summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=checkbox], [role=switch], [role=radio], [role=row], [role=treeitem], input[type=checkbox], input[type=radio], input[type=submit], input[type=button], select";
/** 这些控件点了本来就不一定引起页面变化（勾选框自身状态由浏览器画），不判「点了没反应」。 */
export const NO_DEAD_CHECK = "input, select, label, [role=checkbox], [role=switch], [role=radio], [role=row], a[target=_blank], a[download]";

export const TEXT_MAX = { path: 500, target: 80, detail: 300 } as const;

export function clip(value: string | null | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function uid(): string {
  try { return crypto.randomUUID(); } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }
}

/** 控件角色，用于给卡点归类。 */
export function controlRole(element: Element): string {
  const role = element.getAttribute("role");
  if (role) return ["button", "link", "tab", "menuitem", "checkbox", "option", "row"].includes(role) ? role : role.startsWith("menuitem") ? "menuitem" : role === "switch" || role === "radio" ? "checkbox" : role === "treeitem" ? "option" : "other";
  const tag = element.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return "option";
  if (tag === "input") { const type = (element as HTMLInputElement).type; return type === "checkbox" || type === "radio" ? "checkbox" : "button"; }
  return "other";
}

/**
 * 控件名称：aria-label → aria-labelledby → 可见文字首行 → title。
 * 表格行只记 "table row"（行文字是业务数据不是控件名）；输入框只取它的标签，绝不取值。
 */
export function controlName(element: Element): string | undefined {
  if (element.getAttribute("role") === "row") return "table row";
  const aria = element.getAttribute("aria-label");
  if (aria) return clip(aria, TEXT_MAX.target);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "").join(" ");
    if (text.trim()) return clip(text, TEXT_MAX.target);
  }
  const view = element.ownerDocument.defaultView;
  if (view && (element instanceof view.HTMLInputElement || element instanceof view.HTMLSelectElement)) {
    const label = element.labels?.[0]?.textContent;
    return clip(label ?? element.getAttribute("name") ?? element.getAttribute("title"), TEXT_MAX.target);
  }
  const text = (element as HTMLElement).innerText ?? element.textContent ?? "";
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean);
  return clip(firstLine ?? element.getAttribute("title"), TEXT_MAX.target);
}

/** 连续狂点：同一目标在时间窗内点到第 N 下时判一次，之后这一串不再重复判。 */
export class RageDetector {
  private last: { target: unknown; times: number[]; fired: boolean } = { target: null, times: [], fired: false };
  private windowMs: number;
  private clicks: number;
  constructor(windowMs: number = DEFAULT_LIMITS.rageWindowMs, clicks: number = DEFAULT_LIMITS.rageClicks) {
    this.windowMs = windowMs;
    this.clicks = clicks;
  }
  hit(target: unknown, now: number): boolean {
    if (this.last.target !== target) this.last = { target, times: [], fired: false };
    this.last.times = [...this.last.times.filter((time) => now - time < this.windowMs), now];
    if (!this.last.fired && this.last.times.length >= this.clicks) { this.last.fired = true; return true; }
    if (this.last.times.length === 1) this.last.fired = false;
    return false;
  }
}

/** 只认操作与实际 DOM 增量；定时快照、字体、日志与空 mutation 不算画面活动。 */
export function hasReplayActivity(events: readonly unknown[]): boolean {
  return events.some(raw => {
    const event = raw as { type?: unknown; data?: unknown };
    if (event?.type !== 3 || !event.data || typeof event.data !== "object") return false;
    const data = event.data as Record<string, unknown>;
    if (data["source"] === 0) return ["adds", "removes", "texts", "attributes"].some(key => Array.isArray(data[key]) && (data[key] as unknown[]).length > 0);
    if (data["source"] === 1 || data["source"] === 6) return Array.isArray(data["positions"]) && (data["positions"] as unknown[]).length > 0;
    return [2, 3, 4, 5, 7].includes(data["source"] as number);
  });
}

/** 大页面快照不能抢在点击后的首帧之前执行；返回的取消函数连同已排队任务一起撤销。 */
export function afterPaint(run: () => void): () => void {
  let active = true;
  let frame: number | undefined;
  let timer: number | undefined;
  const enqueue = () => { timer = window.setTimeout(() => { if (active) run(); }, 0); };
  if (typeof window.requestAnimationFrame === "function") frame = window.requestAnimationFrame(enqueue);
  else enqueue();
  return () => {
    active = false;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}
