import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { NoyApiError, NoyAuthError, NoyError } from "./errors.js";

const TIME_FORMAT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** unix 秒 → `2026-10-27 04:07`（站点按 UTC+8 运营） */
export function fmtTime(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  return TIME_FORMAT.format(new Date(seconds * 1000));
}

/** 距离过期还有多久，用于提醒帖子 90 天有效 */
export function fmtUntil(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const days = Math.floor((seconds * 1000 - Date.now()) / 86_400_000);
  if (days < 0) return `已过期 ${-days} 天`;
  return `${days} 天后过期`;
}

export function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function json(value: unknown, maxChars = 6000): string {
  const text = JSON.stringify(value, null, 1);
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截断）` : text;
}

export function okText(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function failText(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** 把异常翻译成 agent 能照着做的提示 */
export function describeError(err: unknown): string {
  if (err instanceof NoyAuthError) {
    return [
      "🔒 需要登录：NOY_SESSION 缺失或已失效。",
      "",
      "最快的修复方式（让用户在浏览器里点几下，自动保存，无需重启）：",
      '  · 调 `noy_browser_login({ action: "wait", timeout_seconds: 120 })`，然后把弹出的窗口交给用户登录；',
      "  · 已登录过的 profile 会 2 秒内直接复用，不弹窗。",
      "",
      "命令行方式（本机跑）：",
      "  · `noyacg-mcp login` —— 同样会打开窗口并保存到 ~/.noyacg-mcp/session.json。",
      "",
      "不想用浏览器自动化时（手动复制）：",
      "  1. 浏览器打开 https://noymanga.com 登录；",
      "  2. DevTools → Application → Cookies → 复制 `NOY_SESSION` 的值；",
      "  3. 写进 MCP 配置的 `NOY_SESSION` 环境变量后重启客户端。",
      "",
      "注意：`/api/logout`（或站点里退出登录）会立刻吊销旧 cookie，之后必须重新登录；",
      "本工具默认只清本地，`noy_logout(revoke=true)` 才会吊销服务端会话。",
    ].join("\n");
  }
  if (err instanceof NoyApiError) {
    const detail = err.payload ? `\n响应：${clip(JSON.stringify(err.payload), 400)}` : "";
    return `⚠️ 接口拒绝：${err.message}${detail}`;
  }
  if (err instanceof NoyError) return `⚠️ ${err.message}`;
  if (err instanceof Error) return `⚠️ ${err.message}`;
  return `⚠️ ${String(err)}`;
}

/** 统一 try/catch：成功返回文本，失败返回 isError 文本（不抛给宿主） */
export async function run(fn: () => Promise<string>): Promise<CallToolResult> {
  try {
    return okText(await fn());
  } catch (err) {
    return failText(describeError(err));
  }
}
