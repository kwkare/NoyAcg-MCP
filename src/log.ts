import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./config.js";

/**
 * 写操作审计日志。
 *
 * 这个 MCP 的写操作是「直接执行」的（发帖 / 评论 / 点赞 / 签到 / 徽章 / 上传），
 * 没有二次确认环节，所以每次写操作都落一行 JSONL，方便事后追查
 * 「谁在什么时候发了什么」。读操作不记录，避免噪声。
 */
export interface AuditRecord {
  tool: string;
  args?: unknown;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const SECRET_KEY = /^(session|cookie|password|pass|token|authorization)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "***" : redact(item, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) {
    return `${value.slice(0, 500)}…（共 ${value.length} 字符）`;
  }
  return value;
}

export async function audit(cfg: Config, record: AuditRecord): Promise<void> {
  if (!cfg.auditLog) return;
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    ...record,
    args: redact(record.args),
    result: redact(record.result),
  })}\n`;
  try {
    await mkdir(dirname(cfg.auditLog), { recursive: true });
    await appendFile(cfg.auditLog, line, "utf8");
  } catch (err) {
    // 审计失败不能影响工具本身，但要在 stderr 留痕（stdout 是协议通道）
    console.error(`[noyacg-mcp] 审计日志写入失败：${String(err)}`);
  }
}
