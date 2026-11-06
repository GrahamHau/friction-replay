import { hasReplayActivity } from "./shared.ts";

/**
 * 播放端：不依赖任何框架。@rrweb/replay 的 Replayer 只负责画面，进度 / 倍速 / 定位卡点由这里包一层，
 * 业务自己画控件，调 controller 的方法即可（examples/viewer.html 是一个最小示例）。
 */

export type ReplayDataLike = {
  parts: Array<{ part: string; startedAt?: string | null; endedAt?: string | null }>;
  markerAt: string | null;
  events: unknown[];
};

type SerializedNode = { tagName?: string; attributes?: Record<string, unknown>; childNodes?: SerializedNode[] };

function strip(node: SerializedNode | undefined) {
  if (!node || typeof node !== "object") return;
  if (node.tagName === "iframe" && node.attributes) delete node.attributes["sandbox"];
  node.childNodes?.forEach(strip);
}

/**
 * 录下的沙箱 iframe 带着 sandbox 属性，播放器还原后它成了跨源框，内嵌页画面写不进去，只剩空框。
 * 播放前去掉 iframe 的 sandbox：播放器外层沙箱本就不许脚本运行，去掉不会让回放里的页面脚本跑起来。
 * 就地修改，重复调用无副作用。
 */
export function unsandboxFrames<T>(events: T[]): T[] {
  for (const raw of events) {
    const event = raw as { type?: number; data?: Record<string, unknown> };
    if (event?.type === 2) strip(event.data?.["node"] as SerializedNode);
    if (event?.type === 3 && event.data?.["source"] === 0) {
      (event.data["adds"] as Array<{ node?: SerializedNode }> | undefined)?.forEach(add => strip(add.node));
      (event.data["attributes"] as Array<{ attributes?: Record<string, unknown> }> | undefined)?.forEach(change => { if (change.attributes) delete change.attributes["sandbox"]; });
    }
  }
  return events;
}

export type CoverageWarning = "missing_before" | "missing_after" | "marker_out_of_range" | "snapshot_only" | "short_clip";

/** 只判断收到的现场能不能放、缺什么；缺段原因不能从存储结果推断，交给界面如实提示。 */
export function replayCoverage(replay: ReplayDataLike): { playable: boolean; hasSnapshot: boolean; hasActivity: boolean; durationMs: number; warnings: CoverageWarning[] } {
  const warnings: CoverageWarning[] = [];
  if (!replay.parts.some(p => p.part === "before")) warnings.push("missing_before");
  if (!replay.parts.some(p => p.part === "after")) warnings.push("missing_after");
  const events = replay.events.filter((e): e is { type: number; timestamp: number } =>
    typeof e === "object" && e !== null && typeof (e as { type?: unknown }).type === "number" && Number.isFinite((e as { timestamp?: unknown }).timestamp));
  const full = events.findIndex(e => e.type === 2);
  const first = events[0]?.timestamp;
  const last = events.at(-1)?.timestamp;
  const marker = replay.markerAt === null ? NaN : Date.parse(replay.markerAt);
  if (first !== undefined && last !== undefined && Number.isFinite(marker) && (marker < first || marker > last)) warnings.push("marker_out_of_range");
  const durationMs = first === undefined || last === undefined ? 0 : Math.max(0, last - first);
  const hasActivity = hasReplayActivity(events.slice(Math.max(0, full)));
  if (full >= 0 && !hasActivity) warnings.push("snapshot_only");
  else if (full >= 0 && durationMs < 2000) warnings.push("short_clip");
  return { playable: full >= 0 && hasActivity && events.length >= 2, hasSnapshot: full >= 0, hasActivity, durationMs, warnings };
}

type ReplayerLike = {
  play(offset?: number): void;
  pause(offset?: number): void;
  getCurrentTime(): number;
  getMetaData(): { startTime: number; endTime: number; totalTime: number };
  setConfig(config: { speed?: number }): void;
  on(event: string, handler: (payload: unknown) => void): unknown;
  destroy(): void;
  wrapper: HTMLDivElement;
};

export type ReplayPlayer = {
  /** 总时长（毫秒）。 */
  readonly totalMs: number;
  /** 卡点在时间轴上的位置（毫秒），不在范围内为 null。 */
  readonly markerMs: number | null;
  play(fromMs?: number): void;
  pause(): void;
  seek(ms: number): void;
  /** 跳到卡点前 leadMs（默认 3 秒）。 */
  seekToMarker(leadMs?: number): void;
  setSpeed(speed: number): void;
  readonly playing: boolean;
  currentMs(): number;
  destroy(): void;
};

export type ReplayPlayerOptions = {
  /** 默认 import("@rrweb/replay")；别忘了引入 @rrweb/replay/dist/style.css。 */
  loadReplayer?: () => Promise<new (events: unknown[], config: Record<string, unknown>) => unknown>;
  autoplay?: boolean;
  /** 跳过无操作的静止区间，默认 true。 */
  skipInactive?: boolean;
  onTick?: (currentMs: number) => void;
  onFinish?: () => void;
};

/** 把回放画到 root 里，并按 root 尺寸等比缩放居中。 */
export async function createReplayPlayer(root: HTMLElement, replay: ReplayDataLike, options: ReplayPlayerOptions = {}): Promise<ReplayPlayer> {
  const Replayer = options.loadReplayer
    ? await options.loadReplayer()
    : (await import("@rrweb/replay")).Replayer as unknown as new (events: unknown[], config: Record<string, unknown>) => unknown;
  if (getComputedStyle(root).position === "static") root.style.position = "relative";
  root.style.overflow = "hidden";
  const replayer = new Replayer(unsandboxFrames(replay.events), { root, showWarning: false, mouseTail: false, skipInactive: options.skipInactive ?? true }) as ReplayerLike;
  let size = { width: 1280, height: 720 };
  const fit = () => {
    if (root.clientWidth === 0 || root.clientHeight === 0) return;
    const scale = Math.min(1, root.clientWidth / size.width, root.clientHeight / size.height);
    const style = replayer.wrapper.style;
    style.transform = `scale(${scale})`;
    style.transformOrigin = "top left";
    style.position = "absolute";
    style.left = `${Math.max(0, (root.clientWidth - size.width * scale) / 2)}px`;
    style.top = `${Math.max(0, (root.clientHeight - size.height * scale) / 2)}px`;
  };
  replayer.on("resize", (payload) => {
    const next = payload as { width?: number; height?: number };
    if (next.width && next.height && Number.isFinite(next.width) && Number.isFinite(next.height) && next.width > 0 && next.height > 0) { size = { width: next.width, height: next.height }; fit(); }
  });
  const observer = new ResizeObserver(fit);
  observer.observe(root);

  const meta = replayer.getMetaData();
  const offset = replay.markerAt === null ? NaN : Date.parse(replay.markerAt) - meta.startTime;
  const markerMs = Number.isFinite(offset) && offset >= 0 && offset <= meta.totalTime ? offset : null;
  let playing = false;
  let position = 0;
  let ticker: number | undefined;
  const tick = () => { position = replayer.getCurrentTime(); options.onTick?.(position); };
  const startTicker = () => { window.clearInterval(ticker); ticker = window.setInterval(tick, 200); };
  replayer.on("finish", () => { playing = false; window.clearInterval(ticker); position = meta.totalTime; options.onTick?.(position); options.onFinish?.(); });

  const player: ReplayPlayer = {
    totalMs: meta.totalTime,
    markerMs,
    get playing() { return playing; },
    play(fromMs) {
      const from = fromMs ?? (position >= meta.totalTime ? 0 : position);
      replayer.play(from); position = from; playing = true; startTicker();
    },
    pause() { replayer.pause(); playing = false; window.clearInterval(ticker); tick(); },
    seek(ms) {
      position = Math.min(Math.max(0, ms), meta.totalTime);
      if (playing) replayer.play(position); else replayer.pause(position);
      options.onTick?.(position);
    },
    seekToMarker(leadMs = 3000) { if (markerMs !== null) player.seek(markerMs - leadMs); },
    setSpeed(speed) { replayer.setConfig({ speed }); },
    currentMs: () => (playing ? replayer.getCurrentTime() : position),
    destroy() { window.clearInterval(ticker); observer.disconnect(); replayer.destroy(); },
  };
  fit();
  if (options.autoplay !== false) player.play(0);
  else replayer.pause(0);
  return player;
}
