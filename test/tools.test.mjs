import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startMockSite } from "./mock-site.mjs";

/** 起一个 stdio MCP server，指向假站点 */
async function startServer(env) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NOY_SESSION: "test-session", ...env },
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
  const request = (method, params) => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`超时：${method}`)), 15_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}：${JSON.stringify(message.error)}`));
        else resolve(message.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);

  const call = async (name, args = {}) => {
    const result = await request("tools/call", { name, arguments: args });
    return { text: result.content?.[0]?.text ?? "", isError: Boolean(result.isError) };
  };

  return {
    call,
    stderr: () => stderr,
    close: () => {
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

describe("tools 集成（假站点）", () => {
  let site;
  let server;
  const workDir = join(tmpdir(), `noyacg-mcp-test-${process.pid}`);
  const imagePath = join(workDir, "pic.png");
  const auditPath = join(workDir, "audit.jsonl");

  before(async () => {
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex")).catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(workDir, { recursive: true });
      await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
    });
    site = await startMockSite();
    server = await startServer({
      NOY_BASE_URL: site.base,
      NOY_BUCKET_URL: site.base,
      NOY_AUDIT_LOG: auditPath,
      NOY_SESSION_FILE: join(workDir, "session.json"),
      NOY_TIMEOUT_MS: "5000",
    });
  });

  after(async () => {
    server.close();
    site.server.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it("noy_whoami：用 Img 反查真实徽章 ID，并标出佩戴状态", async () => {
    const { text, isError } = await server.call("noy_whoami");
    assert.equal(isError, false, text);
    assert.match(text, /tester/);
    assert.match(text, /佩戴中 2 枚/);
    assert.match(text, /諾莉亞的凝視（#8）/);
    assert.match(text, /t\*\*\*@example\.com/, "邮箱要打码");
  });

  it("noy_home_feed：默认 all，包含榜单与番剧", async () => {
    const { text, isError } = await server.call("noy_home_feed", { limit: 2 });
    assert.equal(isError, false, text);
    assert.match(text, /日收藏榜/);
    assert.match(text, /番剧推荐/);
    assert.match(text, /學生會也有洞/);
    assert.match(text, /全年龄/);
  });

  it("noy_list_posts：输出帖子摘要与 over", async () => {
    const { text } = await server.call("noy_list_posts", { limit: 5 });
    assert.match(text, /#78930/);
    assert.match(text, /《图》/);
    assert.match(text, /over=true/);
  });

  it("noy_read_post：正文 + 评论 + 楼中楼入口提示", async () => {
    const { text } = await server.call("noy_read_post", { post_id: 78930 });
    assert.match(text, /\[noygirl:yeah\]/);
    assert.match(text, /rid 460550/);
    assert.match(text, /noy_comment/);
  });

  it("noy_read_post：comment_limit=0 时只看帖子，不误报「没有评论」", async () => {
    const { text } = await server.call("noy_read_post", { post_id: 78930, comment_limit: 0 });
    assert.doesNotMatch(text, /（还没有评论）/);
    assert.match(text, /已按参数跳过/);
  });

  it("noy_comment：发顶层评论并回读 rid", async () => {
    const { text, isError } = await server.call("noy_comment", { post_id: 78930, text: "测试评论 [noygirl:yeah]" });
    assert.equal(isError, false, text);
    assert.match(text, /新评论 rid \d+/);
    const created = site.state.comments.find((c) => c.content === "测试评论 [noygirl:yeah]");
    assert.ok(created, "假站点应收到评论");
    assert.equal(created.reply_id, -1);
  });

  it("noy_comment：带 reply_to_rid 变成楼中楼", async () => {
    const { text, isError } = await server.call("noy_comment", { post_id: 78930, text: "楼中楼", reply_to_rid: 460550 });
    assert.equal(isError, false, text);
    const created = site.state.comments.find((c) => c.content === "楼中楼");
    assert.equal(created.reply_id, 460550);
    assert.equal(created.root_id, 460550);
  });

  it("noy_like_post：幂等（已赞时不再调用），可取消", async () => {
    const first = await server.call("noy_like_post", { post_id: 78930, action: "like" });
    assert.match(first.text, /已点赞/);
    assert.match(first.text, /点赞数：0 → 1/);

    const second = await server.call("noy_like_post", { post_id: 78930, action: "like" });
    assert.match(second.text, /已经是「已赞」状态/);

    const third = await server.call("noy_like_post", { post_id: 78930, action: "unlike" });
    assert.match(third.text, /已取消点赞/);
    assert.equal(site.state.posts.find((p) => p.id === 78930).like, 1 - 1);
  });

  it("noy_checkin：首次签到 +1 积分，第二次不重复调用", async () => {
    const first = await server.call("noy_checkin");
    assert.equal(first.isError, false, first.text);
    assert.match(first.text, /签到成功/);
    assert.match(first.text, /积分：100 → 101（\+1）/);

    const second = await server.call("noy_checkin");
    assert.match(second.text, /今天已经签过/);
    assert.equal(site.state.integral, 101);
  });

  it("noy_set_badge：拒绝不存在的 ID，合法 ID 幂等切换", async () => {
    const bad = await server.call("noy_set_badge", { badge_id: 114514, wear: true });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /不存在/);

    const wear = await server.call("noy_set_badge", { badge_id: 12, wear: true });
    assert.match(wear.text, /已佩戴/);
    assert.ok(site.state.show.includes("12"));

    const again = await server.call("noy_set_badge", { badge_id: 12, wear: true });
    assert.match(again.text, /已经佩戴中/);

    const unwear = await server.call("noy_set_badge", { badge_id: 12, wear: false });
    assert.match(unwear.text, /已取消/);
    assert.ok(!site.state.show.includes("12"));
  });

  it("noy_upload_images：上传本地文件并返回 image 引用", async () => {
    const { text, isError } = await server.call("noy_upload_images", { paths: [imagePath] });
    assert.equal(isError, false, text);
    assert.match(text, /image\/12345-deadbeef\.webp/);
  });

  it("noy_create_post：自动上传图片、发现新帖 ID、提示大小写错误", async () => {
    const { text, isError } = await server.call("noy_create_post", {
      title: "集成测试帖",
      content: "正文 [NoyGirl:Yeah]",
      images: [imagePath],
    });
    assert.equal(isError, false, text);
    assert.match(text, /发帖成功/);
    assert.match(text, /帖子 ID：\d+/);
    assert.match(text, /大小写错误/);

    const created = site.state.posts.find((p) => p.title === "集成测试帖");
    assert.deepEqual(created.image, ["image/12345-deadbeef.webp"]);
  });

  it("noy_edit_post：只改正文时沿用原标题", async () => {
    const { text, isError } = await server.call("noy_edit_post", { post_id: 78930, content: "改过的正文" });
    assert.equal(isError, false, text);
    assert.match(text, /正文：已更新/);
    assert.match(text, /最后编辑时间/);
    const post = site.state.posts.find((p) => p.id === 78930);
    assert.equal(post.title, "图");
    assert.equal(post.content, "改过的正文");
  });

  it("noy_inbox：未读数与社區回覆", async () => {
    const count = await server.call("noy_inbox", { kind: "count" });
    assert.match(count.text, /全部 1/);
    const community = await server.call("noy_inbox", { kind: "community", limit: 3 });
    assert.match(community.text, /@other/);
    assert.match(community.text, /《图》/);
    assert.match(community.text, /不全是别人回复我/);
  });

  it("noy_logout(revoke=true)：吊销服务端会话并清空当前登录态", async () => {
    const out = await server.call("noy_logout", { revoke: true });
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /已登出，并已吊销服务端会话/);
    assert.ok(
      site.state.calls.some((c) => c.path === "/api/logout"),
      "应该真的调用了 /api/logout",
    );

    const after = await server.call("noy_whoami");
    assert.equal(after.isError, true, "登出后读接口应该要求重新登录");
    assert.match(after.text, /需要登录/);
  });

  it("写操作落审计日志（不含会话 cookie）", async () => {
    const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.length >= 4, "发帖/评论/签到/徽章都应记录");
    assert.ok(lines.some((line) => line.tool === "noy_create_post"));
    assert.ok(lines.every((line) => line.ts));
    assert.ok(!JSON.stringify(lines).includes("test-session"), "审计日志不能包含 cookie");
  });
});
