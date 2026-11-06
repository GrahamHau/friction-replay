import { DEFAULT_LIMITS, type RrwebEvent } from "./shared.ts";

/**
 * 回放环形缓冲：每次 rrweb 全量快照（checkout）开一段，只留覆盖最近 beforeMs 所需的段。
 * 新段从全量快照开头：rrweb 定时快照先发 Meta（4）再发 FullSnapshot（2），两条都带 isCheckout，只在 Meta 处开段；
 * 内嵌页的快照到外层已变成增量（3），即使带 isCheckout 也不开段。
 */
export class ReplayBuffer {
  private segments: RrwebEvent[][] = [];
  private sizes: number[] = [];
  private bytes = 0;
  private listeners = new Set<(event: RrwebEvent) => void>();
  private beforeMs: number;
  private maxBytes: number;
  constructor(beforeMs: number = DEFAULT_LIMITS.replayBeforeMs, maxBytes: number = DEFAULT_LIMITS.replayMaxBytes) {
    this.beforeMs = beforeMs;
    this.maxBytes = maxBytes;
  }
  push(event: RrwebEvent, isCheckout: boolean, now = Date.now()) {
    const last = this.segments[this.segments.length - 1];
    const startsSnapshot = event.type === 4 || (event.type === 2 && last?.[last.length - 1]?.type !== 4);
    if (this.segments.length === 0 || (isCheckout && startsSnapshot)) { this.segments.push([]); this.sizes.push(0); }
    const size = new TextEncoder().encode(JSON.stringify(event)).byteLength + 1;
    this.segments[this.segments.length - 1]!.push(event);
    this.sizes[this.sizes.length - 1]! += size;
    this.bytes += size;
    // 第二段起点已在窗口之外，说明最老那段整段都用不上了，丢掉。
    while (this.segments.length > 1 && ((this.segments[1]![0]?.timestamp ?? now) <= now - this.beforeMs || this.bytes > this.maxBytes * 2)) {
      this.segments.shift(); this.bytes -= this.sizes.shift()!;
    }
    // 单个快照就已超限：清空，等下一次全量快照再恢复，不保留无上界的 DOM。
    if (this.bytes > this.maxBytes * 2) { this.segments = []; this.sizes = []; this.bytes = 0; }
    this.listeners.forEach((listener) => listener(event));
  }
  /** 事发前：从仍覆盖窗口的最早一段开头取起，保证以全量快照开头、能独立播放；超限从老段丢。 */
  snapshot(maxBytes: number = this.maxBytes): RrwebEvent[] {
    let start = 0, bytes = this.bytes + 2;
    while (start < this.segments.length - 1 && bytes > maxBytes) bytes -= this.sizes[start++]!;
    // 开头不含全量快照的段放不出来，跳过。
    while (start < this.segments.length - 1 && !this.segments[start]!.some(event => event.type === 2)) bytes -= this.sizes[start++]!;
    const events = this.segments.slice(start).flat();
    return bytes <= maxBytes && events.some(event => event.type === 2) ? events : [];
  }
  /** 订阅之后进来的事件（用于收「事发后」片段），返回退订函数。 */
  follow(listener: (event: RrwebEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
