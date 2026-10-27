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
      "修复步骤：",
      "1. 浏览器打开 https://noymanga.com 并登录；",
      "2. DevTools → Application → Cookies → `NOY_SESSION`，复制整段值；",
      "3. 更新 MCP 配置里的环境变量 `NOY_SESSION`，重启 MCP 客户端。",
      "",
      "注意：调用 `/api/logout`（或站点内退出登录）会立刻吊销旧 cookie，之后必须重新复制。",
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
