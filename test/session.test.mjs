import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../dist/config.js";
import { applyStoredSession, clearStoredSession, readStoredSession, writeStoredSession } from "../dist/session.js";

describe("本地会话文件", () => {
  let dir;
  let file;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "noyacg-session-"));
    file = join(dir, "session.json");
  });

  after(() => rm(dir, { recursive: true, force: true }));

  it("写入后能读回，且权限是 0600", async () => {
    const cfg = loadConfig({ NOY_SESSION_FILE: file });
    const path = await writeStoredSession(
      { cookie: "abc".repeat(40), uid: 12345, username: "tester", savedAt: new Date().toISOString(), source: "browser:chrome" },
      cfg,
    );
    assert.equal(path, file);

    const stored = await readStoredSession(cfg);
    assert.equal(stored.uid, 12345);
    assert.equal(stored.username, "tester");
    assert.equal(stored.cookie.length, 120);

    if (process.platform !== "win32") {
      const mode = (await stat(file)).mode & 0o777;
      assert.equal(mode, 0o600, "会话文件必须是 0600");
    }

    const raw = await readFile(file, "utf8");
    assert.match(raw, /"username": "tester"/);
  });

  it("会话文件损坏时当作未登录，而不是崩溃", async () => {
    const cfg = loadConfig({ NOY_SESSION_FILE: join(dir, "broken.json") });
    await writeFileSafe(cfg.sessionFile, "{ not json");
    assert.equal(await readStoredSession(cfg), null);
  });

  it("applyStoredSession：环境变量优先于文件", async () => {
    const cfg = loadConfig({ NOY_SESSION: "from-env", NOY_SESSION_FILE: file, NOY_AUDIT_LOG: "" });
    const source = await applyStoredSession(cfg);
    assert.equal(source, "env");
    assert.equal(cfg.session, "from-env");
    assert.equal(cfg.sessionSource, "env");
  });

  it("applyStoredSession：没有环境变量时读文件", async () => {
    const cfg = loadConfig({ NOY_SESSION_FILE: file, NOY_AUDIT_LOG: "" });
    const source = await applyStoredSession(cfg);
    assert.equal(source, "file");
    assert.equal(cfg.session, "abc".repeat(40));
    assert.equal(cfg.sessionMeta?.username, "tester");
  });

  it("applyStoredSession：都没有则返回 null", async () => {
    const cfg = loadConfig({ NOY_SESSION_FILE: join(dir, "missing.json"), NOY_AUDIT_LOG: "" });
    assert.equal(await applyStoredSession(cfg), null);
    assert.equal(cfg.session, null);
  });

  it("clearStoredSession 删除文件后可重复调用", async () => {
    const cfg = loadConfig({ NOY_SESSION_FILE: file });
    assert.equal(await clearStoredSession(cfg), true);
    assert.equal(await clearStoredSession(cfg), false);
    assert.equal(await readStoredSession(cfg), null);
  });
});

async function writeFileSafe(path, content) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, content, "utf8");
}
