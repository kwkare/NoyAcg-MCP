import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  /** 站点根地址，默认 https://noymanga.com（可用 NOY_BASE_URL 指向测试环境） */
  baseUrl: string;
  /** 图床根地址，只用于上传和拼图片 URL */
  bucketUrl: string;
  /** NOY_SESSION 的值（已去掉 `NOY_SESSION=` 前缀），没配时为 null */
  session: string | null;
  /** 请求头 allow-adult 的默认值，工具参数可覆盖 */
  defaultAdult: boolean;
  /** 普通请求超时 */
  timeoutMs: number;
  /** 上传超时（图床会转码，给宽一点） */
  uploadTimeoutMs: number;
  /** 单张图片大小上限 */
  maxUploadBytes: number;
  /** 写操作审计日志路径；null = 不落盘 */
  auditLog: string | null;
  /** 只注册只读工具 */
  readonly: boolean;
  /** 是否允许暴露账号密码登录工具（默认关闭） */
  allowPasswordLogin: boolean;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off", ""].includes(v)) return false;
  return fallback;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** `NOY_SESSION` 允许直接粘贴 `NOY_SESSION=xxx` 整段，这里统一去掉前缀 */
export function normalizeSession(raw: string | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith("NOY_SESSION=")) value = value.slice("NOY_SESSION=".length);
  value = value.replace(/^["']|["']$/g, "").trim();
  return value.length > 0 ? value : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const defaultAudit = join(homedir(), ".noyacg-mcp", "audit.jsonl");
  const auditSetting = env.NOY_AUDIT_LOG;
  const auditLog =
    auditSetting === undefined
      ? defaultAudit
      : auditSetting.trim() === "" || auditSetting.trim().toLowerCase() === "off"
        ? null
        : auditSetting.trim();

  return {
    baseUrl: stripSlash(env.NOY_BASE_URL?.trim() || "https://noymanga.com"),
    bucketUrl: stripSlash(env.NOY_BUCKET_URL?.trim() || "https://bucket.noymanga.com"),
    session: normalizeSession(env.NOY_SESSION),
    defaultAdult: bool(env.NOY_ALLOW_ADULT, false),
    timeoutMs: num(env.NOY_TIMEOUT_MS, 30_000),
    uploadTimeoutMs: num(env.NOY_UPLOAD_TIMEOUT_MS, 120_000),
    maxUploadBytes: num(env.NOY_MAX_UPLOAD_MB, 20) * 1024 * 1024,
    auditLog,
    readonly: bool(env.NOY_READONLY, false),
    allowPasswordLogin: bool(env.NOY_ALLOW_PASSWORD_LOGIN, false),
  };
}
