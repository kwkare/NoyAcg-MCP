#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { NoyClient } from "./client.js";
import { registerReadTools, type ToolContext } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { VERSION } from "./version.js";

const INSTRUCTIONS = [
  "NoyAcg（noymanga.com）漫画社区 MCP。",
  "",
  "鉴权：所有工具依赖环境变量 NOY_SESSION（站点 Cookie）。返回「需要登录」时，请让用户重新从浏览器复制 cookie 再重启客户端；",
  "  /api/logout 会立即吊销旧 cookie，退出登录后必须重新复制。",
  "",
  "分级：内容分「全年龄」与「R18」两套互斥内容池，工具参数 adult 默认 false。注意 /api/home 服务端默认是 R18，本服务会显式传 false。",
  "",
  "写操作（直接生效，无二次确认）：noy_create_post / noy_comment / noy_edit_post / noy_like_post / noy_checkin / noy_set_badge / noy_upload_images。",
  "  帖子和评论都**没有删除接口**，发出去只能等 90 天自动过期；点赞与徽章是开关式，重复调用会翻转。",
  "  每次写操作都会追加一行审计日志（默认 ~/.noyacg-mcp/audit.jsonl）。",
  "",
  "数据习惯：正文里的 [noygirl:yeah] 是表情包代码（见 noy://stickers），NID123 是书籍引用；",
  "  列表分页用 `over` 判断是否到底，不要用 `len`（近似总数且会浮动）；置顶帖只出现在第 1 页。",
].join("\n");

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = new NoyClient(cfg);
  const ctx: ToolContext = { client, cfg };

  const server = new McpServer(
    { name: "noyacg-mcp", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerReadTools(server, ctx);
  if (!cfg.readonly) registerWriteTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);

  await server.connect(new StdioServerTransport());

  // stdout 是 JSON-RPC 通道，日志一律走 stderr
  console.error(
    `[noyacg-mcp ${VERSION}] ready · session=${cfg.session ? "yes" : "no"} · adult=${cfg.defaultAdult} · ` +
      `readonly=${cfg.readonly} · audit=${cfg.auditLog ?? "off"} · base=${cfg.baseUrl}`,
  );
  if (!cfg.session) {
    console.error("[noyacg-mcp] 没有配置 NOY_SESSION：读接口会返回「需要登录」，请先按 README 复制 cookie。");
  }
}

main().catch((err) => {
  console.error(`[noyacg-mcp] 启动失败：${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
