import { NoyClient } from "./client.js";
import { loadConfig } from "./config.js";
import { NoyAuthError } from "./errors.js";
import { openLoginBrowser } from "./browser-login.js";
import { applyStoredSession, clearStoredSession, sessionFilePath, writeStoredSession } from "./session.js";

const USAGE = `noyacg-mcp —— noymanga.com 的 MCP server

用法：
  noyacg-mcp                 启动 stdio MCP server（给 Claude Desktop / Cursor 用）
  noyacg-mcp login           打开浏览器，登录后自动保存 Cookie
  noyacg-mcp status          检查当前会话是否有效
  noyacg-mcp logout          删除本地保存的会话
  noyacg-mcp logout --revoke 删除本地会话，并让服务端吊销这个 Cookie
  noyacg-mcp help            显示本帮助

login 选项：
  --timeout <秒>    等待登录的最长时间，默认 300
  --headless        无头模式（CI / 无桌面环境）
  --channel <名>    chrome / msedge / chromium，默认自动探测
  --base-url <url>  覆盖站点地址`;

function takeFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, value && !value.startsWith("--") ? 2 : 1);
  return value && !value.startsWith("--") ? value : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

export async function runCli(argv: string[]): Promise<number> {
  const [command = "help", ...rest] = argv;
  const args = [...rest];

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }

  const cfg = loadConfig();
  const timeout = Number(takeFlag(args, "--timeout") ?? 300);
  const headless = hasFlag(args, "--headless");
  const channel = takeFlag(args, "--channel") ?? cfg.browserChannel;
  const baseUrl = takeFlag(args, "--base-url");
  if (baseUrl) cfg.baseUrl = baseUrl.replace(/\/+$/, "");

  if (command === "login") {
    const handle = await openLoginBrowser({
      baseUrl: cfg.baseUrl,
      profileDir: cfg.browserProfile,
      headless: headless || cfg.browserHeadless,
      channel,
      onStatus: (message) => console.error(`· ${message}`),
    });

    console.error(
      `\n👉 请在弹出的窗口里登录 ${cfg.baseUrl}（已有登录态会自动识别）。\n` +
        `   最多等待 ${Number.isFinite(timeout) && timeout > 0 ? timeout : 300} 秒，登录成功后窗口会自动关闭。\n`,
    );

    try {
      const result = await handle.wait((Number.isFinite(timeout) && timeout > 0 ? timeout : 300) * 1000);
      const path = await writeStoredSession(
        {
          cookie: result.cookie,
          uid: result.uid,
          username: result.username,
          baseUrl: cfg.baseUrl,
          savedAt: new Date().toISOString(),
          source: `browser:${result.channel}`,
        },
        cfg,
      );

      console.log(
        result.reused
          ? `\n✅ 检测到已有登录态，直接复用：${result.username}（UID ${result.uid}）`
          : `\n✅ 登录成功：${result.username}（UID ${result.uid}）`,
      );
      console.log(`   会话文件：${path}（权限 0600）`);
      console.log(`\n接下来：MCP 客户端里不用再填 NOY_SESSION 了，直接重启客户端即可。`);
      if (process.env.NOY_SESSION) {
        console.log(`\n⚠️ 检测到环境变量 NOY_SESSION 已设置，它的优先级更高，会覆盖这个文件。`);
      }
      return 0;
    } catch (err) {
      console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
      console.error("   可以重新执行 `noyacg-mcp login`（已登录状态会被复用，通常几秒完成）。");
      return 1;
    } finally {
      await handle.close();
    }
  }

  if (command === "status") {
    const source = await applyStoredSession(cfg);
    if (!source) {
      console.log("❌ 未登录：既没有 NOY_SESSION 环境变量，也没有本地会话文件。");
      console.log(`   执行 \`noyacg-mcp login\` 打开浏览器登录（会保存到 ${sessionFilePath(cfg)}）。`);
      return 1;
    }

    const client = new NoyClient(cfg);
    try {
      const info = (await client.userinfo()).userinfo ?? {};
      console.log(`✅ 会话有效`);
      console.log(`   账号：${info.Username}（UID ${info.Uid}）· 积分 ${info.Integral}`);
      console.log(`   来源：${source === "env" ? "环境变量 NOY_SESSION" : `本地文件 ${sessionFilePath(cfg)}`}`);
      if (source === "file" && cfg.sessionMeta?.savedAt) {
        console.log(`   保存于：${cfg.sessionMeta.savedAt}`);
      }
      return 0;
    } catch (err) {
      const reason = err instanceof NoyAuthError ? "服务端判定 cookie 已失效" : String(err);
      console.log(`❌ 会话无效：${reason}`);
      console.log("   执行 `noyacg-mcp login` 重新登录即可。");
      return 1;
    }
  }

  if (command === "logout") {
    const source = await applyStoredSession(cfg);
    if (hasFlag(args, "--revoke") && cfg.session) {
      const client = new NoyClient(cfg);
      try {
        await client.post("/api/logout", {}, { retry: 0 });
        console.log("已通知服务端吊销当前 Cookie（其它设备上的这个会话也会失效）。");
      } catch (err) {
        console.error(`吊销失败（继续清理本地）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const removed = await clearStoredSession(cfg);
    console.log(removed ? `已删除本地会话：${sessionFilePath(cfg)}` : "本地没有会话文件（可能用的是环境变量）。");
    if (source === "env") console.log("注意：环境变量 NOY_SESSION 仍然存在，需要手动从配置里删掉。");
    return 0;
  }

  console.error(`未知命令：${command}\n`);
  console.log(USAGE);
  return 2;
}
