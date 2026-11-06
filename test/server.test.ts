import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStore, createMemoryStore, createReplayHandler, type ReplayStore } from "../src/server.ts";

async function serve(store: ReplayStore, allowRead = true) {
  const handle = createReplayHandler({
    store, prefix: "/api/replay",
    identify: req => (req.headers["x-user"] as string | undefined) ?? null,
    authorizeRead: () => allowRead,
  });
  const server = createServer((req, res) => { void handle(req, res).then(done => { if (!done) { res.statusCode = 404; res.end(); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}/api/replay/replays`, close: () => new Promise(resolve => server.close(resolve)) };
}

const part = (p: "before" | "after", startedAt: string, endedAt: string, events: unknown[]) => ({
  replayId: "r1", part: p, app: "demo", sessionId: "s1", trigger: "dead_click", path: "/orders?id=1", startedAt, endedAt,
  friction: { type: "dead_click", at: "2026-01-01T00:01:00.000Z", target: "Save" }, events,
});

for (const [name, makeStore] of [["内存存储", async () => ({ store: createMemoryStore(), cleanup: async () => {} })],
  ["文件存储", async () => { const dir = await mkdtemp(join(tmpdir(), "friction-replay-")); return { store: createFileStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) }; }]] as const) {
  test(`${name}：收两段（含 gzip）、幂等、他人编号拒收、取回按时间拼好`, async () => {
    const { store, cleanup } = await makeStore();
    const { base, close } = await serve(store);
    try {
      const headers = { "content-type": "application/json", "x-user": "u1" };
      const before = part("before", "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z", [{ type: 4, timestamp: 1 }, { type: 2, timestamp: 2 }]);
      let res = await fetch(base, { method: "POST", headers: { ...headers, "content-encoding": "gzip" }, body: gzipSync(JSON.stringify(before)) });
      assert.deepEqual(await res.json(), { replayId: "r1", stored: true });
      res = await fetch(base, { method: "POST", headers, body: JSON.stringify(before) });
      assert.deepEqual(await res.json(), { replayId: "r1", stored: false }, "重复上传幂等");
      res = await fetch(base, { method: "POST", headers: { ...headers, "x-user": "u2" }, body: JSON.stringify(part("after", "2026-01-01T00:01:00Z", "2026-01-01T00:03:00Z", [])) });
      assert.equal(res.status, 409, "他人不能往别人的回放里追加");
      res = await fetch(base, { method: "POST", headers, body: JSON.stringify(part("after", "2026-01-01T00:01:00Z", "2026-01-01T00:03:00Z", [{ type: 3, timestamp: 3 }])) });
      assert.equal(res.status, 200);

      res = await fetch(`${base}/r1`);
      assert.equal(res.status, 200);
      const replay = await res.json() as { events: { timestamp: number }[]; markerAt: string; parts: unknown[]; friction: { target: string } };
      assert.deepEqual(replay.events.map(e => e.timestamp), [1, 2, 3]);
      assert.equal(replay.markerAt, "2026-01-01T00:01:00.000Z");
      assert.equal(replay.parts.length, 2);
      assert.equal(replay.friction.target, "Save");
      assert.equal((await fetch(`${base}/nope`)).status, 404);
    } finally { await close(); await cleanup(); }
  });
}

test("拒收：未登录、跨站、坏字段、gzip 炸弹；读取未授权 403", async () => {
  const { base, close } = await serve(createMemoryStore(), false);
  try {
    const good = part("before", "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z", [{ type: 2, timestamp: 1 }]);
    const post = (body: BodyInit, headers: Record<string, string> = {}) => fetch(base, { method: "POST", headers: { "content-type": "application/json", "x-user": "u1", ...headers }, body });
    assert.equal((await fetch(base, { method: "POST", body: JSON.stringify(good) })).status, 401);
    assert.equal((await post(JSON.stringify(good), { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await post(JSON.stringify(good), { origin: "https://evil.example" })).status, 403);
    assert.equal((await post(JSON.stringify({ ...good, replayId: "../x" }))).status, 400);
    assert.equal((await post(JSON.stringify({ ...good, trigger: "whatever" }))).status, 400);
    assert.equal((await post(gzipSync(Buffer.alloc(60 * 1024 * 1024)), { "content-encoding": "gzip" })).status, 413);
    assert.equal((await post(JSON.stringify(good))).status, 200);
    assert.equal((await fetch(`${base}/r1`)).status, 403);
  } finally { await close(); }
});
