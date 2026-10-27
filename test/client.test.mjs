import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { NoyClient } from "../dist/client.js";
import { loadConfig } from "../dist/config.js";
import { NoyApiError, NoyAuthError } from "../dist/errors.js";

/** 一个只记录请求、按路由返回固定响应的假站点 */
function startFakeSite(route) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const record = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(record);
      const payload = route(record);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, requests, base: `http://127.0.0.1:${port}` });
    });
  });
}

function makeClient(base, overrides = {}) {
  const cfg = loadConfig({
    NOY_SESSION: "test-cookie",
    NOY_BASE_URL: base,
    NOY_BUCKET_URL: base,
    NOY_AUDIT_LOG: "",
    ...overrides,
  });
  return new NoyClient(cfg);
}

describe("NoyClient.post", () => {
  let site;
  let client;

  before(async () => {
    site = await startFakeSite(({ url }) => {
      if (url.includes("login")) return { status: "login" };
      if (url.includes("error")) return { status: "error" };
      if (url.includes("community_list")) return { status: "ok", info: [], len: 0, over: true };
      if (url.includes("signin/sign")) return { status: 500, msg: "Please do not sign in too frequently" };
      return { status: "ok" };
    });
    client = makeClient(site.base);
  });

  after(() => site.server.close());

  it("带上 cookie、allow-adult 和表单编码", async () => {
    await client.communityList({ page: 2, type: "like", adult: false });
    const req = site.requests.at(-1);
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/v3/community_list");
    assert.equal(req.headers.cookie, "NOY_SESSION=test-cookie");
    assert.equal(req.headers["allow-adult"], "false");
    assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
    assert.match(String(req.body), /page=2/);
    assert.match(String(req.body), /type=like/);
    assert.match(String(req.body), /filter=/);
  });

  it("adult 参数覆盖默认值", async () => {
    await client.communityList({ adult: true });
    assert.equal(site.requests.at(-1).headers["allow-adult"], "true");
  });

  it("status=login 抛 NoyAuthError", async () => {
    await assert.rejects(() => client.post("/api/login"), (err) => err instanceof NoyAuthError);
  });

  it("status=error 抛 NoyApiError 并带上响应体", async () => {
    await assert.rejects(
      () => client.post("/api/error"),
      (err) => err instanceof NoyApiError && err.status === "error",
    );
  });

  it("home 默认带 v=3 与 stream_all", async () => {
    await client.home(false);
    const body = String(site.requests.at(-1).body);
    assert.match(body, /v=3/);
    assert.match(body, /stream_all=1/);
    assert.equal(site.requests.at(-1).headers["allow-adult"], "false");
  });

  it("home(false) 不带 stream 参数时可以关掉", async () => {
    await client.home(false, false);
    assert.doesNotMatch(String(site.requests.at(-1).body), /stream_all/);
  });

  it("签到接口的数字 status=500 不当作异常，交给调用方判断", async () => {
    const payload = await client.signinSign();
    assert.equal(payload.status, 500);
    assert.match(String(payload.msg), /too frequently/);
  });
});

describe("NoyClient.uploadImage", () => {
  let site;
  let client;

  before(async () => {
    site = await startFakeSite(({ url }) => {
      if (url.includes("get_image_bucket_token")) return { status: "ok", token: "tok-123" };
      return { status: "ok", file: "91266-abc.webp" };
    });
    client = makeClient(site.base);
  });

  after(() => site.server.close());

  it("两步走：先换 token，再 multipart 上传（不带 cookie）", async () => {
    const result = await client.uploadImage({
      data: Buffer.from("hello"),
      fileName: "pic.jpg",
      mime: "image/jpeg",
    });

    assert.equal(result.file, "91266-abc.webp");
    assert.equal(result.imageRef, "image/91266-abc.webp");

    const tokenReq = site.requests[0];
    assert.equal(tokenReq.url, "/api/get_image_bucket_token");
    assert.equal(tokenReq.headers.cookie, "NOY_SESSION=test-cookie");

    const uploadReq = site.requests[1];
    assert.equal(uploadReq.url, "/api/upload_image");
    assert.equal(uploadReq.headers.cookie, undefined, "上传不应该带站点 Cookie");
    assert.equal(uploadReq.headers.origin, site.base);
    assert.match(String(uploadReq.headers["content-type"]), /multipart\/form-data; boundary=/);
    const body = String(uploadReq.body);
    assert.match(body, /name="token"/);
    assert.match(body, /tok-123/);
    assert.match(body, /name="file"; filename="pic.jpg"/);
  });

  it("token 失效时给出可操作错误", async () => {
    site.server.close();
    const bad = await startFakeSite(({ url }) =>
      url.includes("get_image_bucket_token") ? { status: "ok", token: "tok" } : { status: "token_format_error" },
    );
    const badClient = makeClient(bad.base);
    await assert.rejects(
      () => badClient.uploadImage({ data: Buffer.from("x"), fileName: "a.webp", mime: "image/webp" }),
      /图床上传失败.*token_format_error/s,
    );
    bad.server.close();
  });
});

describe("其他行为", () => {
  it("bucketImageUrl 补全相对路径，绝对地址原样返回", () => {
    const client = new NoyClient(loadConfig({ NOY_SESSION: "x" }));
    assert.equal(client.bucketImageUrl("avatar/x.webp"), "https://bucket.noymanga.com/avatar/x.webp");
    assert.equal(client.bucketImageUrl("bg/x.webp"), "https://bucket.noymanga.com/bg/x.webp");
    assert.equal(client.bucketImageUrl("image/x.webp"), "https://bucket.noymanga.com/image/x.webp");
    assert.equal(client.bucketImageUrl("https://cdn/x.webp"), "https://cdn/x.webp");
    assert.equal(client.bucketImageUrl(""), null);
  });

  it("NOY_SESSION 允许粘贴整段 `NOY_SESSION=xxx`", () => {
    const cfg = loadConfig({ NOY_SESSION: "NOY_SESSION=abc==; other=1" });
    assert.equal(cfg.session, "abc==; other=1");
  });

  it("默认 allow-adult = false", () => {
    assert.equal(loadConfig({}).defaultAdult, false);
    assert.equal(loadConfig({ NOY_ALLOW_ADULT: "true" }).defaultAdult, true);
  });
});
