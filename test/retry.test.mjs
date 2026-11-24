import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { NoyClient } from "../dist/client.js";
import { loadConfig } from "../dist/config.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const client = () => new NoyClient(loadConfig({ NOY_BASE_URL: "http://example.test", NOY_SESSION: "test" }));
const ok = () => new Response(JSON.stringify({ status: "ok", today: true }), { status: 200 });
const networkError = (code) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

it("签到状态遇到 DNS 错误和服务器错误后自动恢复", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw networkError("ENOTFOUND");
    if (calls === 2) return new Response("unavailable", { status: 503 });
    return ok();
  };
  assert.equal((await client().signinRecord()).today, true);
  assert.equal(calls, 3);
});

it("读取响应体超时也会重试", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: true, status: 200, arrayBuffer: async () => { throw new Error("timeout"); } };
    return ok();
  };
  await client().signinRecord();
  assert.equal(calls, 2);
});

it("重试耗尽后返回次数和原因", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw networkError("ENOTFOUND"); };
  await assert.rejects(() => client().signinRecord(), /尝试 3 次.*ENOTFOUND/);
  assert.equal(calls, 3);
});

it("写操作只对确定未建立连接的错误重试", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; if (calls === 1) throw networkError("ECONNREFUSED"); return ok(); };
  await client().like(123);
  assert.equal(calls, 2);
  calls = 0;
  globalThis.fetch = async () => { calls++; throw networkError("ECONNRESET"); };
  await assert.rejects(() => client().like(123), /写操作结果不确定/);
  assert.equal(calls, 1);
});
