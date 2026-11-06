import assert from "node:assert/strict";
import test from "node:test";
import { ReplayBuffer } from "../src/buffer.ts";
import { RageDetector, hasReplayActivity } from "../src/shared.ts";
import { networkFailure, responseFailure, safeErrorReason } from "../src/request.ts";
import { replayCoverage, unsandboxFrames } from "../src/player.ts";
import { mergeReplayParts } from "../src/server.ts";

const ev = (timestamp: number, type = 3, data: Record<string, unknown> = { source: 2 }) => ({ type, timestamp, data });

test("狂点：1 秒内同一目标第 3 下判一次，这一串不重复判；换目标重新计", () => {
  const rage = new RageDetector();
  const a = {}, b = {};
  assert.deepEqual([0, 200, 400, 600].map(t => rage.hit(a, t)), [false, false, true, false]);
  assert.equal(rage.hit(a, 3000), false, "隔太久重新计数");
  assert.deepEqual([3100, 3200].map(t => rage.hit(a, t)), [false, true]);
  assert.deepEqual([0, 100, 200].map(t => rage.hit(b, 5000 + t)), [false, false, true]);
});

test("环形缓冲：只留覆盖最近 5 分钟的段，事发前从全量快照开头", () => {
  const buffer = new ReplayBuffer();
  buffer.push(ev(0, 2), true, 0);
  buffer.push(ev(30_000), false, 30_000);
  buffer.push(ev(60_000, 2), true, 60_000);
  buffer.push(ev(120_000, 2), true, 120_000);
  buffer.push(ev(150_000), false, 150_000);
  // 365 秒时窗口起点为 65 秒：第一段整段在窗口外被丢，60 秒那段仍覆盖起点。
  buffer.push(ev(365_000), false, 365_000);
  const snap = buffer.snapshot();
  assert.equal(snap[0]!.type, 2);
  assert.equal(snap[0]!.timestamp, 60_000);
  const seen: number[] = [];
  const stop = buffer.follow(event => seen.push(event.timestamp));
  buffer.push(ev(366_000), false, 366_000);
  stop();
  buffer.push(ev(367_000), false, 367_000);
  assert.deepEqual(seen, [366_000]);
});

test("环形缓冲：Meta 与 FullSnapshot 只开一段；没有全量快照时取不出", () => {
  const buffer = new ReplayBuffer();
  buffer.push(ev(0), false, 0);
  assert.deepEqual(buffer.snapshot(), [], "无全量快照不能独立播放");
  buffer.push(ev(10, 4), true, 10);
  buffer.push(ev(11, 2), true, 11);
  buffer.push(ev(12), false, 12);
  assert.deepEqual(buffer.snapshot().map(e => e.timestamp), [10, 11, 12]);
});

test("画面活动：空 mutation、纯快照不算，操作和 DOM 增量算", () => {
  assert.equal(hasReplayActivity([ev(0, 2), ev(1, 4)]), false);
  assert.equal(hasReplayActivity([ev(0, 3, { source: 0, adds: [], removes: [], texts: [], attributes: [] })]), false);
  assert.equal(hasReplayActivity([ev(0, 3, { source: 0, texts: [{ id: 1 }] })]), true);
  assert.equal(hasReplayActivity([ev(0, 3, { source: 1, positions: [] })]), false);
  assert.equal(hasReplayActivity([ev(0, 3, { source: 2 })]), true);
});

test("错误原因脱敏：网址、令牌、密码、JWT 都不外泄", async () => {
  const reason = safeErrorReason('failed token=abc password="p w" https://x.example/?k=1 Bearer zzz eyJa.eyJb.sig');
  for (const secret of ["abc", "p w", "x.example", "zzz", "eyJa"]) assert.equal(reason!.includes(secret), false, secret);
  const response = new Response(JSON.stringify({ error: { code: "UNAVAILABLE", message: "down token=abc", details: { sql: "private" } } }), { status: 503, headers: { "content-type": "application/json" } });
  const result = await responseFailure(response);
  assert.equal(result.code, "UNAVAILABLE");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.ok((await response.json()).error.details.sql, "原响应不被消费");
  assert.deepEqual(await responseFailure(new Response("<html>x</html>", { status: 502 })), {});
  assert.equal(networkFailure(Object.assign(new Error("boom secret"), { name: "TypeError" })).reason.includes("secret"), false);
  assert.equal(networkFailure(new DOMException("t", "TimeoutError")).failureKind, "timeout");
});

test("播放前去掉内嵌页 sandbox，快照与增量里的都去", () => {
  const events = unsandboxFrames([
    { type: 2, data: { node: { tagName: "html", childNodes: [{ tagName: "iframe", attributes: { sandbox: "allow-scripts", src: "x" } }] } } },
    { type: 3, data: { source: 0, adds: [{ node: { tagName: "iframe", attributes: { sandbox: "" } } }], attributes: [{ attributes: { sandbox: "" } }] } },
  ]);
  assert.equal(JSON.stringify(events).includes("sandbox"), false);
  assert.equal(JSON.stringify(events).includes('"src":"x"'), true);
});

test("覆盖判断：缺快照不能放、只有快照不能放、卡点超出范围要提示", () => {
  const t = Date.parse("2026-01-01T00:00:00Z");
  const base = { parts: [{ part: "before" }, { part: "after" }], markerAt: new Date(t + 1000).toISOString() };
  assert.equal(replayCoverage({ ...base, events: [ev(t), ev(t + 5000)] }).playable, false);
  const snapOnly = replayCoverage({ ...base, events: [ev(t, 4), ev(t + 1, 2)] });
  assert.equal(snapOnly.playable, false);
  assert.ok(snapOnly.warnings.includes("snapshot_only"));
  const ok = replayCoverage({ ...base, events: [ev(t, 4), ev(t + 1, 2), ev(t + 5000)] });
  assert.equal(ok.playable, true);
  assert.deepEqual(ok.warnings, []);
  const late = replayCoverage({ parts: [{ part: "before" }], markerAt: new Date(t + 60_000).toISOString(), events: [ev(t, 2), ev(t + 5000)] });
  assert.deepEqual(late.warnings, ["missing_after", "marker_out_of_range"]);
});

test("拼段：时间不重叠直接拼原文，重叠则解析后按时间排序", () => {
  const a = { startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:00Z", eventsJson: '[{"timestamp":1},{"timestamp":2}]' };
  const b = { startedAt: "2026-01-01T00:01:00Z", endedAt: "2026-01-01T00:02:00Z", eventsJson: '[{"timestamp":3}]' };
  assert.equal(mergeReplayParts([a, b]), '[{"timestamp":1},{"timestamp":2},{"timestamp":3}]');
  assert.equal(mergeReplayParts([a, { ...b, eventsJson: "[]" }]), '[{"timestamp":1},{"timestamp":2}]');
  const overlap = { ...b, startedAt: "2026-01-01T00:00:30Z", eventsJson: '[{"timestamp":0}]' };
  assert.deepEqual(JSON.parse(mergeReplayParts([a, overlap])).map((e: { timestamp: number }) => e.timestamp), [0, 1, 2]);
});
