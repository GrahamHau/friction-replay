/**
 * 演示：npm run demo 后打开 http://localhost:5173
 * 在演示页制造卡点（狂点、点了没反应、接口报错），右侧列表会出现回放，点开即播放。
 * 回放存在 ./.replays；这里读取不设权限，正式使用必须在 authorizeRead 里校验身份。
 */
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileStore, createReplayHandler } from "../dist/server.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataDir = join(root, ".replays");
const handle = createReplayHandler({ store: createFileStore(dataDir), prefix: "/api/replay", authorizeRead: () => true });
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
const statics: Array<[string, string]> = [
  ["/dist/", join(root, "dist")],
  ["/vendor/record/", join(root, "node_modules/@rrweb/record/dist")],
  ["/vendor/replay/", join(root, "node_modules/@rrweb/replay/dist")],
];

createServer(async (req, res) => {
  try {
    if (await handle(req, res)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/replay/list") {
      // 演示用：列出已收到的回放，最新在前。
      let names: string[] = [];
      try { names = await readdir(dataDir); } catch { /* 还没有 */ }
      const rows = await Promise.all(names.map(async name => {
        const meta = JSON.parse(await readFile(join(dataDir, name, "before.json"), "utf8").catch(() => readFile(join(dataDir, name, "after.json"), "utf8")));
        return { replayId: name, trigger: meta.trigger, friction: meta.friction, path: meta.path, at: (await stat(join(dataDir, name))).mtimeMs };
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rows.sort((a, b) => b.at - a.at)));
      return;
    }
    if (url.pathname === "/api/orders") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "ORDERS_UNAVAILABLE", message: "Order service is down" } }));
      return;
    }
    let file = url.pathname === "/" ? join(root, "examples/index.html") : url.pathname === "/viewer" ? join(root, "examples/viewer.html") : null;
    for (const [prefix, dir] of statics) if (!file && url.pathname.startsWith(prefix)) {
      const target = normalize(join(dir, url.pathname.slice(prefix.length)));
      if (target.startsWith(dir)) file = target;
    }
    if (!file) { res.writeHead(404); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
}).listen(Number(process.env.PORT ?? 5173), () => console.log(`friction-replay demo: http://localhost:${process.env.PORT ?? 5173}`));
