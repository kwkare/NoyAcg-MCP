import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openLoginBrowser, type LoginHandle } from "../browser-login.js";
import { NoyError } from "../errors.js";
import { audit } from "../log.js";
import { run } from "../format.js";
import { clearStoredSession, writeStoredSession } from "../session.js";
import type { ToolContext } from "./read.js";

/** 同一个进程里只保留一个登录窗口，避免 agent 连点几次开出一堆 Chrome */
let active: { handle: LoginHandle; startedAt: number } | null = null;

export function registerAuthTools(server: McpServer, ctx: ToolContext): void {
  const { cfg, client } = ctx;

  server.registerTool(
    "noy_logout",
    {
      title: "登出（清除登录态）",
      description:
        "清除本地保存的登录态（`~/.noyacg-mcp/session.json`）并让当前进程立即失效，之后所有工具会要求重新登录。\n" +
        "默认**只清本地**：服务端的会话仍然有效（其它设备不受影响，同一个 cookie 复制走还能用）。\n" +
        "revoke=true 会额外调用 `/api/logout` **吊销服务端会话**——这是不可逆的，之后必须重新登录。\n" +
        "注意：如果登录态来自环境变量 `NOY_SESSION`，本工具清不掉它，需要用户自己改 MCP 配置。",
      inputSchema: {
        revoke: z.boolean().default(false).describe("是否同时吊销服务端会话（不可逆，会影响其它设备上的同一 cookie）"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ revoke }) =>
      run(async () => {
        const hadSession = Boolean(cfg.session);
        const fromEnv = cfg.sessionSource === "env";
        let revoked = false;
        let revokeError: string | null = null;

        if (revoke && cfg.session) {
          try {
            await client.post("/api/logout", {}, { retry: 0 });
            revoked = true;
          } catch (err) {
            revokeError = err instanceof Error ? err.message : String(err);
          }
        }

        const removed = await clearStoredSession(cfg);

        cfg.session = null;
        cfg.sessionSource = null;
        cfg.sessionMeta = undefined;

        await audit(cfg, {
          tool: "noy_logout",
          args: { revoke },
          ok: true,
          result: { revoked, removed, fromEnv },
        });

        const lines: string[] = [];
        if (!hadSession && !removed) {
          lines.push("ℹ️ 当前本来就没有登录态，无需登出。");
        } else if (revoked) {
          lines.push("✅ 已登出，并已吊销服务端会话。");
          lines.push("   这个 cookie 现在彻底失效了（其它设备上用同一 cookie 的会话也会掉线）。");
        } else {
          lines.push("✅ 已清除本地登录态（服务端会话仍然有效）。");
          lines.push("   想连服务端一起吊销：noy_logout(revoke=true)，或用命令行 `noyacg-mcp logout --revoke`。");
        }

        if (removed) lines.push(`   已删除本地会话文件。`);
        if (fromEnv) {
          lines.push("⚠️ 这次的登录态来自环境变量 NOY_SESSION，本地文件清掉了但它还在；请让用户修改 MCP 配置后重启客户端。");
        }
        if (revokeError) lines.push(`⚠️ 吊销请求失败：${revokeError}（本地已清除）`);
        lines.push("", "重新登录：noy_browser_login(action=\"wait\")，或命令行 `noyacg-mcp login`。");
        return lines.join("\n");
      }),
  );

  if (!cfg.browserLoginEnabled) return;

  server.registerTool(
    "noy_browser_login",
    {
      title: "浏览器登录（自动抓 Cookie）",
      description:
        "打开一个独立的 Chrome 窗口让用户**自己输入账号密码**，登录成功后自动读取 NOY_SESSION 并保存到本地，" +
        "之后所有工具立刻可用（不用重启、不用手动复制 cookie）。\n" +
        "如果这个 profile 之前登录过，会**直接复用、不弹窗**（约 1 秒完成）——所以可以先无脑调一次 wait 试试。\n" +
        "用法：action=open 只开窗口（马上返回）；action=wait 打开并在 timeout_seconds 内等待保存；" +
        "action=cancel 关掉窗口。等待超时**不会关窗口**，用户登完再调一次 wait 即可。\n" +
        "⚠️ 窗口是本项目专用的独立 profile（~/.noyacg-mcp/browser），不会动用户日常浏览器的登录态。\n" +
        "⚠️ 只在用户明确要求「帮我登录」时调用，不要自作主张弹窗。",
      inputSchema: {
        action: z
          .enum(["open", "wait", "cancel"])
          .default("wait")
          .describe("open = 只打开窗口；wait = 打开并等待登录后保存；cancel = 关掉窗口"),
        timeout_seconds: z
          .number()
          .int()
          .min(5)
          .max(300)
          .default(120)
          .describe("wait 的最长等待时间（秒）；超时不会关窗口，可再次调用"),
        headless: z.boolean().default(false).describe("无头模式（一般只有 CI / 服务器场景需要）"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ action, timeout_seconds, headless }) =>
      run(async () => {
        if (action === "cancel") {
          if (!active) return "当前没有打开的登录窗口。";
          await active.handle.close();
          active = null;
          return "已关闭登录窗口。";
        }

        if (!active || active.handle.closed) {
          active = {
            handle: await openLoginBrowser({
              baseUrl: cfg.baseUrl,
              profileDir: cfg.browserProfile,
              headless: headless || cfg.browserHeadless,
              channel: cfg.browserChannel,
              onStatus: (message) => console.error(`[noyacg-mcp] ${message}`),
            }),
            startedAt: Date.now(),
          };
        }

        if (action === "open" && !active.handle.reused) {
          return [
            `🪟 已打开 ${active.handle.channel} 窗口，并跳到登录页。`,
            "请让用户在窗口里输入用户名 / 密码完成登录（窗口是本项目专用 profile，不影响日常浏览器）。",
            "登录完成后调用 noy_browser_login(action=\"wait\") 保存会话；已登录的 profile 下次会直接复用。",
          ].join("\n");
        }

        const result = await active.handle.wait(timeout_seconds * 1000).catch(async (err) => {
          const message = err instanceof Error ? err.message : String(err);
          // 句柄已经死了（窗口被关、浏览器崩了）：丢掉它，下次调用重新开一个
          if (active?.handle.closed) {
            await active.handle.close().catch(() => undefined);
            active = null;
          }
          if (message.includes("等待登录超时")) {
            throw new NoyError(
              `${message} 浏览器窗口仍开着，用户在窗口里完成登录后，再调一次 noy_browser_login(action="wait") 即可。`,
            );
          }
          if (message.includes("已经关闭")) {
            throw new NoyError(`${message} 已丢弃失效的窗口，重新调用 noy_browser_login 即可。`);
          }
          throw err;
        });

        const savedAt = new Date().toISOString();
        const path = await writeStoredSession(
          {
            cookie: result.cookie,
            uid: result.uid,
            username: result.username,
            baseUrl: cfg.baseUrl,
            savedAt,
            source: `browser:${result.channel}${result.reused ? ":reused" : ""}`,
          },
          cfg,
        );

        await active.handle.close();
        active = null;

        // 立即生效：不必重启 MCP
        cfg.session = result.cookie;
        cfg.sessionSource = "file";
        cfg.sessionMeta = { uid: result.uid, username: result.username, savedAt };

        await audit(cfg, {
          tool: "noy_browser_login",
          args: { action, channel: result.channel, reused: result.reused },
          ok: true,
          result: { uid: result.uid, username: result.username },
        });

        return [
          result.reused
            ? `✅ 检测到已有登录态，直接复用：${result.username}（UID ${result.uid}）`
            : `✅ 登录成功：${result.username}（UID ${result.uid}）`,
          `会话已保存到 ${path}（权限 0600），**当前进程已生效**，不需要重启。`,
          "",
          "提示：环境变量 NOY_SESSION 的优先级高于这个文件；以后想换账号，先 noy_logout 再重新登录即可。",
        ].join("\n");
      }),
  );
}
