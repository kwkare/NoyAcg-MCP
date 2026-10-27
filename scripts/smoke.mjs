#!/usr/bin/env node
/**
 * 端到端冒烟测试：真正把 dist/index.js 当 stdio MCP server 拉起来，
 * 走一遍 initialize → tools/list → resources/list → prompts/list → tools/call。
 *
 * 不需要 NOY_SESSION：故意不配 cookie，验证「未登录」时的报错是可操作的提示。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const child = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  // 指向一个不存在的会话文件：保证「未登录」状态，不受本机真实登录态影响
  env: {
    ...process.env,
    NOY_SESSION: "",
    NOY_SESSION_FILE: join(tmpdir(), "noyacg-mcp-smoke-no-session.json"),
    NOY_AUDIT_LOG: "",
    NOY_ALLOW_ADULT: "",
  },
});

let buffer = "";
let stderr = "";
const pending = new Map();

child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

let seq = 0;
function request(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时：${method}`)), 15_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method} 失败：${JSON.stringify(message.error)}`));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

const EXPECTED_TOOLS = [
  "noy_whoami",
  "noy_home_feed",
  "noy_list_posts",
  "noy_read_post",
  "noy_read_comment_replies",
  "noy_inbox",
  "noy_signin_status",
  "noy_list_badges",
  "noy_upload_images",
  "noy_create_post",
  "noy_comment",
  "noy_edit_post",
  "noy_like_post",
  "noy_checkin",
  "noy_set_badge",
  "noy_browser_login",
  "noy_logout",
];

try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  assert.equal(init.serverInfo.name, "noyacg-mcp");
  assert.ok(init.instructions.includes("NOY_SESSION"), "initialize 应该带使用说明");
  notify("notifications/initialized", {});

  const tools = await request("tools/list", {});
  const names = tools.tools.map((tool) => tool.name);
  for (const expected of EXPECTED_TOOLS) assert.ok(names.includes(expected), `缺少工具 ${expected}`);
  assert.equal(new Set(names).size, names.length, "工具名不能重复");
  for (const tool of tools.tools) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} 缺少描述`);
  }

  const resources = await request("resources/list", {});
  const uris = resources.resources.map((item) => item.uri);
  for (const uri of ["noy://profile", "noy://feed/home", "noy://community/latest", "noy://stickers"]) {
    assert.ok(uris.includes(uri), `缺少资源 ${uri}`);
  }

  const stickerDoc = await request("resources/read", { uri: "noy://stickers" });
  const stickers = JSON.parse(stickerDoc.contents[0].text);
  assert.equal(stickers.count, 57, "表情包应为 4 组 57 个");

  const prompts = await request("prompts/list", {});
  assert.deepEqual(
    prompts.prompts.map((prompt) => prompt.name).sort(),
    ["noy_digest", "noy_reply_draft"],
  );

  // 没配 cookie：应该返回 isError + 可操作的登录提示，而不是崩溃
  const whoami = await request("tools/call", { name: "noy_whoami", arguments: {} });
  assert.equal(whoami.isError, true);
  assert.match(whoami.content[0].text, /需要登录/);
  assert.match(whoami.content[0].text, /NOY_SESSION/);

  const list = await request("tools/call", { name: "noy_list_posts", arguments: { sort: "new" } });
  assert.equal(list.isError, true);

  assert.match(stderr, /ready/, "stderr 应有启动日志");
  console.log(`✅ smoke 通过：${names.length} 个工具 / ${uris.length} 个资源 / ${prompts.prompts.length} 个提示词`);
} catch (err) {
  console.error("❌ smoke 失败：", err);
  console.error(stderr);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
}
