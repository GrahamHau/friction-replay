/**
 * 参考服务端：收回放分段、按编号取回拼好的整段。只依赖 node:http / node:zlib / node:fs，
 * 可直接挂在 http.createServer，也可以在 Express / Fastify 里把 req、res 交给它。
 *
 *   POST <prefix>/replays        收一段（before / after），按 (replayId, part) 幂等
 *   GET  <prefix>/replays/<id>   取回整段：两段按时间拼好，附卡点时刻 markerAt
 *
 * 回放里是用户的真实页面画面：读取必须经 authorizeRead 放行；写入建议用 identify 绑定身份，
 * 同一编号已被别人写过时拒收，防止伪造他人的回放。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

export type ReplayPartMeta = {
  replayId: string;
  part: "before" | "after";
  app: string;
  sessionId: string | null;
  trigger: string;
  path: string;
  startedAt: string;
  endedAt: string;
  friction: { type: string; at: string; target?: string; detail?: string } | null;
  owner: string | null;
  eventCount: number;
  receivedAt: string;
};

export type StoredPart = ReplayPartMeta & { eventsJson: string };

export interface ReplayStore {
  /** 已有同编号同分段：同一身份返回 "exists"，别人写的返回 "taken"。 */
  put(part: StoredPart): Promise<"inserted" | "exists" | "taken">;
  /** 取某编号的全部分段，不存在返回 null。 */
  get(replayId: string): Promise<StoredPart[] | null>;
  /** 删除收到时间早于 before 的分段，返回删除数。 */
  prune?(before: Date): Promise<number>;
}

export type ReplayData = {
  replayId: string;
  app: string;
  sessionId: string | null;
  trigger: string;
  path: string;
  friction: ReplayPartMeta["friction"];
  /** 卡点时刻：优先取卡点本身的时间，没有（手动抓取）就取 before 段结束时刻。 */
  markerAt: string | null;
  parts: Array<Pick<ReplayPartMeta, "part" | "startedAt" | "endedAt" | "eventCount">>;
  events: unknown[];
};

export type ReplayHandlerOptions = {
  store: ReplayStore;
  /** 挂载前缀，与采集端 endpoint 一致，如 "/api/replay"。 */
  prefix?: string;
  /** 读取授权：返回 false 一律 403。回放含真实页面画面，没有默认放行。 */
  authorizeRead: (req: IncomingMessage, replay: Omit<ReplayData, "events">) => boolean | Promise<boolean>;
  /** 写入身份：返回 null 视为未登录（401）。不提供则不校验身份。 */
  identify?: (req: IncomingMessage) => string | null | Promise<string | null>;
  /** 允许跨站页面写入（默认只收同源页面，防伪造）。 */
  allowCrossSite?: boolean;
  /** 传输体积上限（压缩后），默认 6MB；解压后上限默认 48MB，防 gzip 炸弹。 */
  maxBodyBytes?: number;
  maxInflatedBytes?: number;
  /** 保留天数，默认 30；写入时顺带清理，最多每小时一次。 */
  retentionDays?: number;
  now?: () => Date;
};

const TRIGGERS = new Set(["rage_click", "dead_click", "error", "form_abandon", "manual"]);
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const clip = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
};
const isoOf = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
const fail = (res: ServerResponse, status: number, code: string, message: string) => { writeJson(res, status, { error: { code, message } }); return true; };

async function readBody(req: IncomingMessage, limit: number, inflatedLimit: number): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; status: number; code: string; message: string }> {
  const chunks: Buffer[] = [];
  let size = 0, tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) { tooLarge = true; continue; } // 读完再拒，避免客户端写端报错
    chunks.push(buffer);
  }
  if (tooLarge) return { ok: false, status: 413, code: "too_large", message: `Body exceeds ${limit} bytes.` };
  let raw = Buffer.concat(chunks);
  if (String(req.headers["content-encoding"] ?? "").toLowerCase() === "gzip") {
    try { raw = await gunzipAsync(raw, { maxOutputLength: inflatedLimit }); }
    catch { return { ok: false, status: 413, code: "bad_gzip", message: "Gzip body is invalid or inflates beyond the limit." }; }
  }
  try {
    const parsed = JSON.parse(raw.toString("utf8") || "null") as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return { ok: true, value: parsed as Record<string, unknown> };
  } catch { /* 落到下面 */ }
  return { ok: false, status: 400, code: "invalid_request", message: "Body must be a JSON object." };
}

/** 只收本站页面发来的请求（含 sendBeacon）：浏览器带的 Origin / Sec-Fetch-Site 不对就拒。 */
function sameSite(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin") return false;
  const origin = req.headers["origin"];
  if (typeof origin !== "string" || origin === "null" && site === "same-origin") return true;
  try { return new URL(origin).host === req.headers["host"]; } catch { return false; }
}

/**
 * before 段在卡点时刻截止、after 段从卡点时刻开始，按段顺序拼接即为时间顺序，直接拼 JSON 原文（单段可达十几 MB，
 * 免得解析再序列化）；段时间重叠或内容不是数组时才解析排序。
 */
export function mergeReplayParts(parts: Array<Pick<StoredPart, "startedAt" | "endedAt" | "eventsJson">>): string {
  const texts = parts.map(p => p.eventsJson.trim());
  const ordered = texts.every(t => t.startsWith("[") && t.endsWith("]")) && parts.every((part, i) =>
    i === 0 || Date.parse(parts[i - 1]!.endedAt) <= Date.parse(part.startedAt));
  if (ordered) return `[${texts.map(t => t.slice(1, -1).trim()).filter(Boolean).join(",")}]`;
  let events: unknown[] = [];
  for (const text of texts) {
    try { const decoded = JSON.parse(text) as unknown; if (Array.isArray(decoded)) events = events.concat(decoded); } catch { /* 坏段跳过 */ }
  }
  const ts = (e: unknown) => Number((e as { timestamp?: unknown })?.timestamp) || 0;
  events.sort((a, b) => ts(a) - ts(b));
  return JSON.stringify(events);
}

const partOrder = (p: { part: string }) => (p.part === "before" ? 0 : 1);

/** 返回 true 表示请求已处理；false 表示路径不归它管，交给后续路由。 */
export function createReplayHandler(options: ReplayHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const prefix = `${(options.prefix ?? "").replace(/\/+$/, "")}/replays`;
  const maxBody = options.maxBodyBytes ?? 6 * 1024 * 1024;
  const maxInflated = options.maxInflatedBytes ?? 48 * 1024 * 1024;
  const retentionMs = (options.retentionDays ?? 30) * 86_400_000;
  const now = options.now ?? (() => new Date());
  let lastPrune = 0;
  const maybePrune = () => {
    const t = now().getTime();
    if (!options.store.prune || t - lastPrune < 3_600_000) return;
    lastPrune = t;
    void options.store.prune(new Date(t - retentionMs)).catch(() => {});
  };

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "");
    if (path !== prefix && !path.startsWith(`${prefix}/`)) return false;
    const rest = path.slice(prefix.length + 1);

    if (path === prefix) {
      if (req.method !== "POST") { res.setHeader("allow", "POST"); return fail(res, 405, "method_not_allowed", "Use POST."); }
      if (!options.allowCrossSite && !sameSite(req)) return fail(res, 403, "cross_site", "Only same-origin pages may upload replays.");
      const owner = options.identify ? await options.identify(req) : null;
      if (options.identify && owner === null) return fail(res, 401, "unauthenticated", "Sign in required.");
      const body = await readBody(req, maxBody, maxInflated);
      if (!body.ok) return fail(res, body.status, body.code, body.message);
      const v = body.value;
      const replayId = typeof v["replayId"] === "string" && ID.test(v["replayId"]) ? v["replayId"] : null;
      const part = v["part"] === "before" || v["part"] === "after" ? v["part"] : null;
      const trigger = typeof v["trigger"] === "string" && TRIGGERS.has(v["trigger"]) ? v["trigger"] : null;
      const startedAt = isoOf(v["startedAt"]), endedAt = isoOf(v["endedAt"]);
      if (replayId === null) return fail(res, 400, "invalid_request", "replayId must match [A-Za-z0-9_-]{1,64}.");
      if (part === null) return fail(res, 400, "invalid_request", "part must be before or after.");
      if (trigger === null) return fail(res, 400, "invalid_request", "Unknown trigger.");
      if (startedAt === null || endedAt === null) return fail(res, 400, "invalid_request", "startedAt / endedAt must be ISO timestamps.");
      if (!Array.isArray(v["events"])) return fail(res, 400, "invalid_request", "events must be an rrweb event array.");
      const rawFriction = v["friction"] as Record<string, unknown> | undefined;
      const frictionType = rawFriction && typeof rawFriction === "object" ? clip(rawFriction["type"], 32) : null;
      const frictionAt = rawFriction && typeof rawFriction === "object" ? isoOf(rawFriction["at"]) : null;
      const friction = frictionType && TRIGGERS.has(frictionType) && frictionAt ? {
        type: frictionType, at: frictionAt,
        ...(clip(rawFriction!["target"], 80) ? { target: clip(rawFriction!["target"], 80)! } : {}),
        ...(clip(rawFriction!["detail"], 300) ? { detail: clip(rawFriction!["detail"], 300)! } : {}),
      } : null;
      const outcome = await options.store.put({
        replayId, part, trigger, startedAt, endedAt, friction, owner,
        app: clip(v["app"], 64) ?? "web", sessionId: clip(v["sessionId"], 64), path: clip(v["path"], 500) ?? "/",
        eventCount: v["events"].length, receivedAt: now().toISOString(), eventsJson: JSON.stringify(v["events"]),
      });
      if (outcome === "taken") return fail(res, 409, "replay_taken", "This replayId belongs to someone else.");
      maybePrune();
      writeJson(res, 200, { replayId, stored: outcome === "inserted" });
      return true;
    }

    if (req.method !== "GET" || !ID.test(rest)) {
      if (req.method !== "GET") { res.setHeader("allow", "GET"); return fail(res, 405, "method_not_allowed", "Use GET."); }
      return fail(res, 404, "not_found", "Replay not found.");
    }
    const parts = (await options.store.get(rest))?.sort((a, b) => partOrder(a) - partOrder(b));
    if (!parts || parts.length === 0) return fail(res, 404, "not_found", "Replay not found or expired.");
    const first = parts[0]!;
    const before = parts.find(p => p.part === "before");
    const friction = parts.find(p => p.friction)?.friction ?? null;
    const meta: Omit<ReplayData, "events"> = {
      replayId: rest, app: first.app, sessionId: first.sessionId, trigger: first.trigger, path: first.path, friction,
      markerAt: friction?.at ?? before?.endedAt ?? null,
      parts: parts.map(p => ({ part: p.part, startedAt: p.startedAt, endedAt: p.endedAt, eventCount: p.eventCount })),
    };
    if (!(await options.authorizeRead(req, meta))) return fail(res, 403, "forbidden", "Not allowed to view this replay.");
    // 事件已是 JSON 原文，直接拼进响应；客户端接受 gzip 就压缩（回放 JSON 压缩率通常 5 倍以上）。
    const text = `${JSON.stringify(meta).slice(0, -1)},"events":${mergeReplayParts(parts)}}`;
    const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", vary: "accept-encoding" };
    if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
      res.writeHead(200, { ...headers, "content-encoding": "gzip" });
      res.end(await gzipAsync(text));
    } else {
      res.writeHead(200, headers);
      res.end(text);
    }
    return true;
  };
}

/** 内存存储：测试与演示用，进程退出即丢。 */
export function createMemoryStore(): ReplayStore {
  const rows = new Map<string, StoredPart>();
  return {
    async put(part) {
      const key = `${part.replayId}:${part.part}`;
      const existing = [...rows.values()].find(r => r.replayId === part.replayId);
      if (existing && existing.owner !== part.owner) return "taken";
      if (rows.has(key)) return "exists";
      rows.set(key, part);
      return "inserted";
    },
    async get(replayId) {
      const parts = [...rows.values()].filter(r => r.replayId === replayId);
      return parts.length ? parts : null;
    },
    async prune(before) {
      let n = 0;
      for (const [key, row] of rows) if (Date.parse(row.receivedAt) < before.getTime()) { rows.delete(key); n++; }
      return n;
    },
  };
}

/** 文件存储：<dir>/<replayId>/<part>.json 存元数据、<part>.events.gz 存压缩事件。单机够用；多实例请换成数据库实现。 */
export function createFileStore(dir: string): ReplayStore {
  const folder = (replayId: string) => join(dir, replayId);
  const readMeta = async (replayId: string, part: string): Promise<ReplayPartMeta | null> => {
    try { return JSON.parse(await readFile(join(folder(replayId), `${part}.json`), "utf8")) as ReplayPartMeta; } catch { return null; }
  };
  return {
    async put(part) {
      if (!ID.test(part.replayId)) return "taken";
      const metas = (await Promise.all(["before", "after"].map(p => readMeta(part.replayId, p)))).filter(Boolean) as ReplayPartMeta[];
      if (metas.some(m => m.owner !== part.owner)) return "taken";
      if (metas.some(m => m.part === part.part)) return "exists";
      await mkdir(folder(part.replayId), { recursive: true });
      const { eventsJson, ...meta } = part;
      await writeFile(join(folder(part.replayId), `${part.part}.events.gz`), await gzipAsync(eventsJson));
      // 元数据最后写、且独占创建：并发重复上传只有一个成功。
      try { await writeFile(join(folder(part.replayId), `${part.part}.json`), JSON.stringify(meta), { flag: "wx" }); }
      catch { return "exists"; }
      return "inserted";
    },
    async get(replayId) {
      if (!ID.test(replayId)) return null;
      const parts: StoredPart[] = [];
      for (const p of ["before", "after"]) {
        const meta = await readMeta(replayId, p);
        if (!meta) continue;
        try {
          const eventsJson = (await gunzipAsync(await readFile(join(folder(replayId), `${p}.events.gz`)))).toString("utf8");
          parts.push({ ...meta, eventsJson });
        } catch { /* 事件文件缺失：跳过这段 */ }
      }
      return parts.length ? parts : null;
    },
    async prune(before) {
      let n = 0;
      let names: string[] = [];
      try { names = await readdir(dir); } catch { return 0; }
      for (const name of names) {
        if (!ID.test(name)) continue;
        try {
          if ((await stat(folder(name))).mtimeMs < before.getTime()) { await rm(folder(name), { recursive: true, force: true }); n++; }
        } catch { /* 并发删除 */ }
      }
      return n;
    },
  };
}
