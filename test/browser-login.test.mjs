import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openLoginBrowser } from "../dist/browser-login.js";

const VALID_COOKIE = "s".repeat(120);

/**
 * 假登录站点：
 * - /user        未登录时的登录页（可配置成「自动登录」或「永不登录」）
 * - /fake-login  登录动作，种 NOY_SESSION
 * - /api/v3/userinfo  校验 cookie
 */
async function startMockLoginSite({ autoLogin, persistentCookie = true }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://mock");

    if (url.pathname === "/fake-login") {
      // persistentCookie=false 时模拟真实站点：下发 session cookie（无 Max-Age）
      const cookie = persistentCookie
        ? `NOY_SESSION=${VALID_COOKIE}; Path=/; Max-Age=2592000`
        : `NOY_SESSION=${VALID_COOKIE}; Path=/`;
      res.writeHead(200, { "set-cookie": cookie, "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (url.pathname === "/api/v3/userinfo") {
      const cookie = req.headers.cookie ?? "";
      const ok = cookie.includes(`NOY_SESSION=${VALID_COOKIE}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          ok
            ? { status: "ok", userinfo: { Uid: 38354, Username: "测试用户", Integral: 100 } }
            : { status: "login" },
        ),
      );
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    const script = autoLogin
      ? `<script>setTimeout(async () => {
           await fetch('/fake-login', { credentials: 'include' });
           document.getElementById('s').textContent = '已登录';
         }, 400);</script>`
      : "";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>登录</title>
      <input type="text" placeholder="用户名"><input type="password" placeholder="密码">
      <p id="s">等待登录…</p>${script}`);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

describe("浏览器登录（headless Chrome）", () => {
  let dir;
  let autoSite;
  let stuckSite;
  let available = true;
  let skipReason = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "noyacg-browser-"));
    autoSite = await startMockLoginSite({ autoLogin: true });
    stuckSite = await startMockLoginSite({ autoLogin: false });

    // 探一下本机有没有能用的浏览器；没有就让整组测试 skip（CI 上可能没有）
    const probe = await openLoginBrowser({
      baseUrl: stuckSite.base,
      profileDir: join(dir, "probe"),
      headless: true,
      pollMs: 200,
    }).catch((err) => {
      available = false;
      skipReason = err instanceof Error ? err.message.split("\n")[0] : String(err);
      return null;
    });
    if (probe) await probe.close();
  });

  after(async () => {
    autoSite?.server.close();
    stuckSite?.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("登录后自动读到 NOY_SESSION，并校验出账号", async (t) => {
    if (!available) return t.skip(`本机没有可用浏览器：${skipReason}`);
    const handle = await openLoginBrowser({
      baseUrl: autoSite.base,
      profileDir: join(dir, "auto"),
      headless: true,
      pollMs: 200,
    });
    try {
      const result = await handle.wait(20_000);
      assert.equal(result.cookie, VALID_COOKIE);
      assert.equal(result.uid, 38354);
      assert.equal(result.username, "测试用户");
    } finally {
      await handle.close();
    }
  });

  it("没人登录时超时报错，且不关窗口（可以再等）", async (t) => {
    if (!available) return t.skip(`本机没有可用浏览器：${skipReason}`);
    const handle = await openLoginBrowser({
      baseUrl: stuckSite.base,
      profileDir: join(dir, "stuck"),
      headless: true,
      pollMs: 200,
    });
    try {
      await assert.rejects(() => handle.wait(1200), /等待登录超时/);
      assert.equal(handle.closed, false, "超时不应该关闭浏览器");
    } finally {
      await handle.close();
    }
    assert.equal(handle.closed, true);
  });

  it("登录下发的是 session cookie 时，也要落成持久 cookie（否则重开就丢）", async (t) => {
    if (!available) return t.skip(`本机没有可用浏览器：${skipReason}`);
    const site = await startMockLoginSite({ autoLogin: true, persistentCookie: false });
    const profile = join(dir, "session-cookie");
    try {
      const first = await openLoginBrowser({ baseUrl: site.base, profileDir: profile, headless: true, pollMs: 200 });
      try {
        const result = await first.wait(20_000);
        assert.equal(result.cookie, VALID_COOKIE);
      } finally {
        await first.close();
      }

      // 重新打开：如果不补 expires，这里会因为 session cookie 被清掉而超时
      const second = await openLoginBrowser({ baseUrl: site.base, profileDir: profile, headless: true, pollMs: 200 });
      try {
        const again = await second.wait(3_000);
        assert.equal(again.cookie, VALID_COOKIE, "cookie 应该已经持久化");
      } finally {
        await second.close();
      }
    } finally {
      site.server.close();
    }
  });

  it("profile 已登录时直接复用，不弹窗", async (t) => {
    if (!available) return t.skip(`本机没有可用浏览器：${skipReason}`);
    // 复用第一个用例留下的 profile（里面已经有 NOY_SESSION）
    const started = Date.now();
    let handle;
    try {
      handle = await openLoginBrowser({
        baseUrl: autoSite.base,
        profileDir: join(dir, "auto"),
        headless: false, // 关键：有头模式下也应该是「探测到已登录 → 不弹窗」
        pollMs: 200,
      });
    } catch (err) {
      return t.skip(`无图形环境，跳过有头复用测试：${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
    try {
      assert.equal(handle.reused, true, "应该标记为复用");
      const result = await handle.wait(1000);
      assert.equal(result.reused, true);
      assert.equal(result.username, "测试用户");
      assert.ok(Date.now() - started < 30_000);
    } finally {
      await handle.close();
    }
  });

  it("MCP 工具 noy_browser_login 能完成整条链路", async (t) => {
    if (!available) return t.skip(`本机没有可用浏览器：${skipReason}`);
    const sessionFile = join(dir, "mcp-session.json");
    const child = spawn(process.execPath, ["dist/index.js"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NOY_SESSION: "",
        NOY_BASE_URL: autoSite.base,
        NOY_BUCKET_URL: autoSite.base,
        NOY_SESSION_FILE: sessionFile,
        NOY_BROWSER_PROFILE: join(dir, "mcp-profile"),
        NOY_BROWSER_HEADLESS: "true",
        NOY_AUDIT_LOG: join(dir, "audit.jsonl"),
      },
    });

    let buffer = "";
    const pending = new Map();
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
        const timer = setTimeout(() => reject(new Error(`超时：${method}`)), 40_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          if (message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    };

    try {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);

      const result = await request("tools/call", {
        name: "noy_browser_login",
        arguments: { action: "wait", timeout_seconds: 30, headless: true },
      });
      const text = result.content[0].text;
      assert.equal(Boolean(result.isError), false, text);
      assert.match(text, /登录成功/);
      assert.match(text, /38354/);

      const saved = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(sessionFile, "utf8")));
      assert.equal(saved.cookie, VALID_COOKIE);
      assert.equal(saved.username, "测试用户");
    } finally {
      child.stdin.end();
      child.kill("SIGTERM");
    }
  });
});
