import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createReplayRecorder, type FrictionEvent, type ReplayPartPayload } from "../src/recorder.ts";
import type { RecordFn } from "../src/shared.ts";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 在 jsdom 里跑采集端；录制器换成假的：开录先发 Meta + FullSnapshot，之后由测试手动发增量。 */
async function page(run: (h: { win: JSDOM["window"]; uploads: ReplayPartPayload[]; frictions: FrictionEvent[]; emit: (data: Record<string, unknown>) => void; started: () => boolean }) => Promise<void>, fetchStatus = 200) {
  const dom = new JSDOM('<!doctype html><body><form aria-label="Order"><input name="qty"><button type="button" id="dead">Load more</button></form><button id="live">Open</button></body>', { url: "http://localhost/orders", pretendToBeVisual: true });
  const win = dom.window;
  win.fetch = (async () => new Response(JSON.stringify({ error: { code: "DB_DOWN", message: "db down password=x" } }), { status: fetchStatus, headers: { "content-type": "application/json" } })) as typeof fetch;
  const globals: Record<string, unknown> = { window: win, document: win.document, location: win.location, history: win.history, sessionStorage: win.sessionStorage,
    navigator: win.navigator, MutationObserver: win.MutationObserver, Element: win.Element, HTMLElement: win.HTMLElement };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let emitFn: ((event: unknown, isCheckout?: boolean) => void) | undefined;
  const record = ((options: Record<string, unknown>) => {
    emitFn = options["emit"] as typeof emitFn;
    const now = Date.now();
    emitFn!({ type: 4, timestamp: now, data: {} }, true);
    emitFn!({ type: 2, timestamp: now, data: { node: {} } }, true);
    return () => { emitFn = undefined; };
  }) as RecordFn;
  const uploads: ReplayPartPayload[] = [];
  const frictions: FrictionEvent[] = [];
  const recorder = createReplayRecorder({
    endpoint: "/api/replay", app: "demo", loadRecorder: async () => record,
    upload: payload => uploads.push(payload), onFriction: event => frictions.push(event),
    limits: { deadClickMs: 40, replayAfterMs: 80 },
  });
  try {
    await wait(40);
    await run({ win, uploads, frictions, started: () => emitFn !== undefined,
      emit: data => emitFn?.({ type: 3, timestamp: Date.now(), data }, false) });
  } finally {
    recorder.stop();
    win.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

test("点了没反应：判出卡点，上传事发前（全量快照开头）与事发后两段，编号一致", () => page(async h => {
  assert.equal(h.started(), true, "录制器已启动");
  h.emit({ source: 2, type: 1 });
  h.win.document.getElementById("dead")!.dispatchEvent(new h.win.MouseEvent("click", { bubbles: true }));
  await wait(60);
  assert.equal(h.frictions.length, 1);
  const friction = h.frictions[0]!;
  assert.equal(friction.type, "dead_click");
  assert.equal(friction.target, "Load more");
  assert.ok(friction.replayId);
  assert.equal(h.uploads.length, 1);
  const before = h.uploads[0]!;
  assert.equal(before.part, "before");
  assert.equal(before.replayId, friction.replayId);
  assert.deepEqual(before.events.slice(0, 2).map(e => e.type), [4, 2]);
  assert.equal(before.friction?.type, "dead_click");
  h.emit({ source: 0, texts: [{ id: 1, value: "x" }] });
  await wait(120);
  assert.equal(h.uploads.length, 2);
  assert.equal(h.uploads[1]!.part, "after");
  assert.equal(h.uploads[1]!.replayId, friction.replayId);
}));

test("页面有反应的点击不算卡点；冷却期内同类卡点复用同一段回放", () => page(async h => {
  const live = h.win.document.getElementById("live")!;
  live.addEventListener("click", () => { live.textContent = "Opened"; });
  live.dispatchEvent(new h.win.MouseEvent("click", { bubbles: true }));
  await wait(60);
  assert.equal(h.frictions.length, 0);
  h.emit({ source: 2, type: 1 });
  const dead = h.win.document.getElementById("dead")!;
  dead.dispatchEvent(new h.win.MouseEvent("click", { bubbles: true }));
  await wait(60);
  dead.dispatchEvent(new h.win.MouseEvent("click", { bubbles: true }));
  await wait(60);
  assert.equal(h.frictions.length, 2);
  assert.equal(h.frictions[0]!.replayId, h.frictions[1]!.replayId);
  assert.equal(h.uploads.filter(u => u.part === "before").length, 1);
}));

test("接口 500：按报错卡点处理，只带脱敏后的错误码与原因", () => page(async h => {
  h.emit({ source: 2, type: 1 });
  await h.win.fetch("/api/orders?secret=1");
  await wait(20);
  const error = h.frictions.find(f => f.type === "error");
  assert.ok(error, "记到报错");
  assert.equal(error.context?.status, 500);
  assert.equal(error.context?.code, "DB_DOWN");
  assert.equal(error.context?.requestPath, "/api/orders");
  assert.equal(JSON.stringify(error).includes("secret=1"), false);
  assert.equal(JSON.stringify(error).includes("password=x"), false);
  assert.ok(error.replayId);
}, 500));

test("表单填到一半整块移除：判放弃；输入值不进卡点", () => page(async h => {
  const input = h.win.document.querySelector("input")!;
  input.value = "secret value";
  input.dispatchEvent(new h.win.Event("input", { bubbles: true }));
  h.win.document.querySelector("form")!.remove();
  await wait(10);
  const abandon = h.frictions.find(f => f.type === "form_abandon");
  assert.equal(abandon?.detail, "Order");
  assert.equal(JSON.stringify(h.frictions).includes("secret value"), false);
}));
