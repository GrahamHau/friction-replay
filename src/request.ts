/** 请求失败的诊断字段：只记分类信息，不采集请求正文、查询参数和任意响应内容。 */
export type RequestFailureContext = {
  failureKind?: "http" | "network" | "timeout";
  method?: string;
  requestId?: string;
  errorName?: string;
  online?: boolean;
  elapsedMs?: number;
};

/** 错误原因脱敏：隐藏网址、Bearer、常见密钥字段与 JWT，压成一行并限长。 */
export function safeErrorReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, 2000)
    .replace(/https?:\/\/[^\s<>"']+/gi, "[url]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/((?:token|password|secret|authorization|cookie|api[_-]?key|密码|密钥)\s*[=:：]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[jwt]")
    .replace(/[\r\n\t]+/g, " ").trim().slice(0, 240) || undefined;
}

/** 把 fetch 抛出的异常归类为网络失败或超时；只保留浏览器通用提示，自定义异常可能夹带业务内容。 */
export function networkFailure(error: unknown, signal?: AbortSignal | null): RequestFailureContext & { reason: string } {
  const raw = error && typeof error === "object" ? error as { name?: unknown; message?: unknown } : {};
  const timeout = raw.name === "TimeoutError" || (signal?.reason as { name?: string } | undefined)?.name === "TimeoutError";
  const errorName = typeof raw.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(raw.name) ? raw.name : "UnknownError";
  const known = typeof raw.message === "string" && /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|The operation timed out\.?)$/.test(raw.message) ? raw.message : undefined;
  return { failureKind: timeout ? "timeout" : "network", errorName,
    reason: timeout ? "Request timed out without an HTTP response" : `No HTTP response; ${known ?? "browser gave no safe-to-record reason"}` };
}

/**
 * 只读失败响应里的 JSON 错误信封 `{ error: { code, message } }`；限长 8KB、限时 250ms，
 * 读的是 clone，不影响业务代码消费原响应。
 */
export async function responseFailure(response: Response): Promise<{ code?: string; reason?: string }> {
  if (!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get("content-type") ?? "")) return {};
  if (Number(response.headers.get("content-length")) > 8192) return {};
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return {};
    const read = async () => {
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const { done, value } = await reader!.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) return {};
        chunks.push(value);
      }
      const all = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
      const data = JSON.parse(new TextDecoder().decode(all)) as { error?: { code?: unknown; message?: unknown } };
      const code = typeof data?.error?.code === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(data.error.code) ? data.error.code : undefined;
      const reason = safeErrorReason(data.error?.message);
      return code ? { code, ...(reason ? { reason } : {}) } : {};
    };
    return await Promise.race([read(), new Promise<{}>(resolve => { timer = setTimeout(() => resolve({}), 250); })]);
  } catch { return {}; }
  finally { clearTimeout(timer); void reader?.cancel().catch(() => {}); }
}
