import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openLoginBrowser, type LoginHandle } from "../browser-login.js";
import { NoyError } from "../errors.js";
import { audit } from "../log.js";
import { run } from "../format.js";
import { writeStoredSession } from "../session.js";
import type { ToolContext } from "./read.js";

/** 同一个进程里只保留一个登录窗口，避免 agent 连点几次开出一堆 Chrome */
let active: { handle: LoginHandle; startedAt: number } | null = null;

export function registerAuthTools(server: McpServer, ctx: ToolContext): void {
  const { cfg } = ctx;
  if (!cfg.browserLoginEnabled) return;

  server.registerTool(
    "noy_browser_login",
    {
      title: "浏览器登录（自动抓 Cookie）",
      description:
        "打开一个独立的 Chrome 窗口让用户**自己输入账号密码**，登录成功后自动读取 NOY_SESSION 并保存到本地，" +
        "之后所有工具立刻可用（不用重启、不用手动复制 cookie）。\n" +
        "用法：先 action=open（马上返回，窗口留着让用户操作），跟用户说「请在弹出的窗口里登录」；" +
        "用户说好了之后调 action=wait 等待并保存（最多等 timeout_seconds，超时窗口不会关，可以再调一次）。\n" +
        "⚠️ 窗口是本项目专用的独立 profile（~/.noyacg-mcp/browser），不会动用户日常浏览器的登录态；" +
        "登录过一次之后再打开通常已是登录状态，秒完成。\n" +
        "⚠️ 只在用户明确要求「帮我登录」时调用，不要自作主张弹窗。",
      inputSchema: {
        action: z
          .enum(["open", "wait", "cancel"])
          .default("wait")
          .describe("open = 只打开窗口；wait = 等待登录并保存；cancel = 关掉窗口"),
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

        if (action === "open") {
          return [
            `🪟 已打开 ${active.handle.channel} 窗口，并跳到登录页。`,
            "请让用户在窗口里输入用户名 / 密码完成登录（窗口是本项目专用 profile，不影响日常浏览器）。",
            `登录完成后调用 noy_browser_login(action="wait") 保存会话。`,
          ].join("\n");
        }

        const result = await active.handle
          .wait(timeout_seconds * 1000)
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("等待登录超时")) {
              throw new NoyError(
                `${message} 浏览器窗口仍开着，用户在窗口里完成登录后，再调一次 noy_browser_login(action="wait") 即可。`,
              );
            }
            throw err;
          });

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

        await active.handle.close();
        active = null;

        // 立即生效：不必重启 MCP
        cfg.session = result.cookie;
        cfg.sessionSource = "file";
        cfg.sessionMeta = { uid: result.uid, username: result.username, savedAt: new Date().toISOString() };

        await audit(cfg, {
          tool: "noy_browser_login",
          args: { action, channel: result.channel },
          ok: true,
          result: { uid: result.uid, username: result.username },
        });

        return [
          `✅ 登录成功：${result.username}（UID ${result.uid}）`,
          `会话已保存到 ${path}（权限 0600），**当前进程已生效**，不需要重启。`,
          "",
          "提示：环境变量 NOY_SESSION 的优先级高于这个文件；以后想换账号，重新调一次本工具即可。",
        ].join("\n");
      }),
  );
}
