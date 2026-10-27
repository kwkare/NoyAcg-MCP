import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";

/**
 * 本地会话文件。
 *
 * 目的是「配一次就不用再碰 cookie」：浏览器登录 → 抓 cookie → 存到
 * `~/.noyacg-mcp/session.json`（0600），MCP server 启动时自动读取。
 * 环境变量 NOY_SESSION 仍然优先级最高，方便临时切换账号。
 */
export interface StoredSession {
  cookie: string;
  uid?: number;
  username?: string;
  baseUrl?: string;
  savedAt: string;
  source?: string;
}

export function sessionFilePath(cfg?: Config): string {
  return cfg?.sessionFile ?? process.env.NOY_SESSION_FILE ?? join(homedir(), ".noyacg-mcp", "session.json");
}

export async function readStoredSession(cfg?: Config): Promise<StoredSession | null> {
  try {
    const raw = await readFile(sessionFilePath(cfg), "utf8");
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.cookie || typeof parsed.cookie !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeStoredSession(session: StoredSession, cfg?: Config): Promise<string> {
  const path = sessionFilePath(cfg);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // Windows 上 chmod 基本无意义，忽略失败
  await chmod(path, 0o600).catch(() => undefined);
  return path;
}

export async function clearStoredSession(cfg?: Config): Promise<boolean> {
  const path = sessionFilePath(cfg);
  try {
    await rm(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把本地会话灌进配置：环境变量优先，其次 session 文件。
 * 返回最终来源，方便启动日志与 `status` 子命令展示。
 */
export async function applyStoredSession(cfg: Config): Promise<"env" | "file" | null> {
  if (cfg.session) {
    cfg.sessionSource = "env";
    return "env";
  }
  const stored = await readStoredSession(cfg);
  if (!stored) return null;
  cfg.session = stored.cookie;
  cfg.sessionSource = "file";
  cfg.sessionMeta = stored;
  return "file";
}
