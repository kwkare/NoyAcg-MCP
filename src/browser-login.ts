import { NoyError } from "./errors.js";

/**
 * 浏览器登录：打开一个真实的 Chrome 窗口，让用户自己输入账号密码，
 * 登录成功后从浏览器上下文里读 `NOY_SESSION` Cookie。
 *
 * 设计取舍：
 * - 用 `launchPersistentContext` + 独立 profile：登录态会留在
 *   `~/.noyacg-mcp/browser`，下次打开直接是已登录状态，秒取 cookie；
 * - 不去读系统 Chrome 的 Cookies 数据库（要解 keychain，跨平台且脆弱）；
 * - 不碰用户日常浏览器 profile，避免「打开一次就把你正在浏览的窗口接管了」。
 */

export interface BrowserLoginOptions {
  baseUrl: string;
  profileDir: string;
  headless?: boolean;
  /** 指定浏览器通道：chrome / msedge / chromium；不指定则自动尝试 */
  channel?: string;
  pollMs?: number;
  onStatus?: (message: string) => void;
}

export interface BrowserLoginResult {
  cookie: string;
  uid?: number;
  username?: string;
  channel: string;
}

export interface LoginHandle {
  /** 让宿主/测试能拿到页面对象，便于截图或调试 */
  readonly page: any;
  readonly channel: string;
  readonly closed: boolean;
  /** 可以重复调用：超时不会关浏览器，可以再等一次 */
  wait(timeoutMs: number): Promise<BrowserLoginResult>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadPlaywright(): Promise<any> {
  try {
    return await import("playwright-core");
  } catch {
    throw new NoyError(
      "浏览器登录需要 playwright-core。请在项目目录执行 `npm install playwright-core` 后重试。",
    );
  }
}

async function verifyCookie(baseUrl: string, cookie: string): Promise<{ uid?: number; username?: string } | null> {
  try {
    const res = await fetch(`${baseUrl}/api/v3/userinfo`, {
      method: "POST",
      headers: {
        cookie: `NOY_SESSION=${cookie}`,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "allow-adult": "false",
        origin: baseUrl,
        referer: `${baseUrl}/`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await res.json()) as Record<string, any>;
    if (payload.status !== "ok") return null;
    return { uid: payload.userinfo?.Uid, username: payload.userinfo?.Username };
  } catch {
    return null;
  }
}

export async function openLoginBrowser(options: BrowserLoginOptions): Promise<LoginHandle> {
  const { chromium } = await loadPlaywright();
  const candidates = options.channel ? [options.channel] : ["chrome", "msedge", ""];
  const failures: string[] = [];
  let context: any = null;
  let usedChannel = "";

  for (const channel of candidates) {
    try {
      context = await chromium.launchPersistentContext(options.profileDir, {
        headless: options.headless ?? false,
        channel: channel || undefined,
        viewport: null,
        locale: "zh-CN",
        args: ["--start-maximized", "--no-first-run", "--no-default-browser-check"],
      });
      usedChannel = channel || "bundled-chromium";
      break;
    } catch (err) {
      failures.push(`${channel || "bundled-chromium"}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }

  if (!context) {
    throw new NoyError(
      [
        "没能启动浏览器（Chrome / Edge 都没找到）。",
        "解决办法（任选其一）：",
        "1. 安装 Google Chrome 后重试；",
        "2. 在本项目里执行 `npx playwright install chromium` 下载内置浏览器；",
        "3. 用 `NOY_BROWSER=msedge` 指定 Edge。",
        "",
        "启动失败详情：",
        ...failures.map((line) => `- ${line}`),
      ].join("\n"),
    );
  }

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${options.baseUrl}/user`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await page.bringToFront().catch(() => undefined);
  options.onStatus?.(`已打开 ${usedChannel}，请在窗口里登录 noymanga.com`);

  let closed = false;
  const handle: LoginHandle = {
    page,
    channel: usedChannel,
    get closed() {
      return closed;
    },
    async wait(timeoutMs: number): Promise<BrowserLoginResult> {
      if (closed) throw new NoyError("浏览器窗口已经关了，请重新打开登录");
      const deadline = Date.now() + timeoutMs;
      let invalidSeen = false;

      while (Date.now() < deadline) {
        const cookies: { name: string; value: string }[] = await context.cookies(options.baseUrl);
        const session = cookies
          .filter((c) => c.name === "NOY_SESSION" && c.value.length >= 40)
          .sort((a, b) => b.value.length - a.value.length)[0];

        if (session) {
          const account = await verifyCookie(options.baseUrl, session.value);
          if (account) {
            return { cookie: session.value, uid: account.uid, username: account.username, channel: usedChannel };
          }
          // 有可能是上一任账号留下的失效 cookie：清掉，继续等用户登录
          if (!invalidSeen) {
            invalidSeen = true;
            options.onStatus?.("检测到无效的旧 cookie，已清除，继续等待登录");
            await context.clearCookies({ domain: new URL(options.baseUrl).hostname }).catch(() => undefined);
          }
        }
        await sleep(options.pollMs ?? 1000);
      }

      throw new NoyError(`等待登录超时（${Math.round(timeoutMs / 1000)} 秒）：还没检测到有效的 NOY_SESSION。`);
    },
    async close() {
      if (closed) return;
      closed = true;
      await context.close().catch(() => undefined);
    },
  };

  return handle;
}
