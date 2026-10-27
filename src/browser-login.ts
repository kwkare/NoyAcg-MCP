import { NoyError } from "./errors.js";

/**
 * 浏览器登录：打开一个真实的 Chrome 窗口，让用户自己输入账号密码，
 * 登录成功后从浏览器上下文里读 `NOY_SESSION` Cookie。
 *
 * 设计取舍：
 * - 用 `launchPersistentContext` + 独立 profile：登录态留在
 *   `~/.noyacg-mcp/browser`，第二次打开直接命中，**不再弹窗**；
 * - 先跑一次 headless 探测（约 1 秒）判断是否已登录，成功就直接复用；
 * - 不去读系统 Chrome 的 Cookies 数据库（要解 keychain，跨平台且脆弱）；
 * - 不碰用户日常浏览器 profile。
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
  /** true = 复用 profile 里已有的登录态，没有让用户重新登录 */
  reused: boolean;
}

export interface LoginHandle {
  /** 让宿主/测试能拿到页面对象，便于截图或调试 */
  readonly page: any;
  readonly channel: string;
  /** 是否直接复用了已有登录态（此时窗口可能根本没弹出来） */
  readonly reused: boolean;
  readonly closed: boolean;
  /** 可以重复调用：超时不会关浏览器，可以再等一次 */
  wait(timeoutMs: number): Promise<BrowserLoginResult>;
  close(): Promise<void>;
}

interface Launched {
  context: any;
  channel: string;
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

/** 读 profile 里的 NOY_SESSION 并校验，返回有效账号 */
async function readValidSession(
  context: any,
  baseUrl: string,
): Promise<{ cookie: string; uid?: number; username?: string } | null> {
  let cookies: { name: string; value: string }[];
  try {
    cookies = await context.cookies(baseUrl);
  } catch {
    // 浏览器刚崩溃 / 被外部关掉：当作没登录，走正常弹窗流程
    return null;
  }
  const session = cookies
    .filter((c) => c.name === "NOY_SESSION" && c.value.length >= 40)
    .sort((a, b) => b.value.length - a.value.length)[0];
  if (!session) return null;
  const account = await verifyCookie(baseUrl, session.value);
  if (!account) return null;
  return { cookie: session.value, ...account };
}

/**
 * 把会话 cookie 落成「持久 cookie」。
 * 站点登录下发的是 session cookie（关浏览器即失效），不补 expires 的话
 * profile 里留不住，下次复用探测必然失败。
 */
async function persistCookie(context: any, cookie: any): Promise<void> {
  const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 3600; // 与站点侧会话寿命一致：30 天
  const payload: Record<string, unknown> = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? "/",
    expires,
    httpOnly: cookie.httpOnly ?? false,
    secure: cookie.secure ?? true,
    sameSite: cookie.sameSite ?? "Lax",
  };
  await context.addCookies([payload]);
}

/** 在页面顶部浮一条提示，让用户知道「不用你了，已经登录好了」 */
async function showToast(page: any, text: string): Promise<void> {
  const script = `(() => {
    const el = document.createElement('div');
    el.textContent = ${JSON.stringify(text)};
    el.setAttribute('data-noyacg-mcp', 'toast');
    el.style.cssText = ${JSON.stringify(
      [
        "position:fixed",
        "z-index:2147483647",
        "top:18px",
        "left:50%",
        "transform:translateX(-50%)",
        "padding:12px 22px",
        "border-radius:999px",
        "background:#12b886",
        "color:#fff",
        "font:600 14px/1.4 system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif",
        "box-shadow:0 10px 30px rgba(0,0,0,.25)",
        "pointer-events:none",
      ].join(";"),
    )};
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  })()`;
  await page.evaluate(script).catch(() => undefined);
}

async function tryLaunch(
  chromium: any,
  options: BrowserLoginOptions,
  headless: boolean,
  channels: string[],
  failures: string[],
): Promise<Launched | null> {
  // Linux 上 Chrome 默认用 keyring 加密 cookie；headful 与 headless 拿到的密钥可能不同，
  // 会导致「登录时能读到、下次 headless 探测读不到」。固定成 basic 保证跨模式一致。
  // 这个 profile 只用来存一个站点的会话，而会话文件本身就是明文 cookie，风险没有变化。
  const args = ["--start-maximized", "--no-first-run", "--no-default-browser-check"];
  if (process.platform === "linux") args.push("--password-store=basic");

  for (const channel of channels) {
    try {
      const context = await chromium.launchPersistentContext(options.profileDir, {
        headless,
        channel: channel || undefined,
        viewport: null,
        locale: "zh-CN",
        // 兜底：任何情况下都不要卡住不动
        timeout: 30_000,
        args,
      });
      return { context, channel: channel || "bundled-chromium" };
    } catch (err) {
      failures.push(
        `${channel || "bundled-chromium"}${headless ? " (headless)" : ""}: ${
          err instanceof Error ? err.message.split("\n")[0] : String(err)
        }`,
      );
    }
  }
  return null;
}

function browserHelp(failures: string[]): NoyError {
  return new NoyError(
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

function makeHandle(
  context: any,
  channel: string,
  prefetched: { cookie: string; uid?: number; username?: string } | null,
  options: BrowserLoginOptions,
): LoginHandle {
  let closed = false;
  let consumed = prefetched === null;
  const page = context.pages()[0] ?? null;

  return {
    page,
    channel,
    reused: prefetched !== null,
    get closed() {
      return closed;
    },
    async wait(timeoutMs: number): Promise<BrowserLoginResult> {
      if (prefetched && !consumed) {
        consumed = true;
        return { ...prefetched, channel, reused: true };
      }
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
            // 站点的登录 cookie 是 session cookie（没有 Max-Age），浏览器一关就丢。
            // 这里补一个 30 天有效期写回 profile，否则「下次自动复用」永远不成立。
            await persistCookie(context, session).catch(() => undefined);
            return { cookie: session.value, ...account, channel, reused: false };
          }

          // 可能是上一任账号留下的失效 cookie：清掉再等用户登录
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
      // 浏览器偶发卡在关闭上：最多等 10 秒，不阻塞调用方
      await Promise.race([
        context.close().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    },
  };
}

export async function openLoginBrowser(options: BrowserLoginOptions): Promise<LoginHandle> {
  const { chromium } = await loadPlaywright();
  const headless = options.headless ?? false;
  const channels = options.channel ? [options.channel] : ["chrome", "msedge", ""];
  const failures: string[] = [];

  // 1) 已登录就直接复用：先用 headless 探一下 profile（用户看不到窗口）
  if (!headless) {
    const probe = await tryLaunch(chromium, options, true, channels, failures);
    if (probe) {
      const existing = await readValidSession(probe.context, options.baseUrl);
      if (existing) {
        await persistCookie(probe.context, { name: "NOY_SESSION", value: existing.cookie, domain: new URL(options.baseUrl).hostname, path: "/" }).catch(() => undefined);
        const page = probe.context.pages()[0] ?? (await probe.context.newPage());
        await page.goto(`${options.baseUrl}/user`, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
        await showToast(page, `✅ 已登录：${existing.username ?? "当前账号"}，正在保存会话…`);
        options.onStatus?.("检测到已登录，直接复用（不会弹窗）");
        return makeHandle(probe.context, probe.channel, existing, options);
      }
      await Promise.race([
        probe.context.close().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }
  }

  // 2) 没登录：正常打开（默认有头）窗口让用户操作
  const launched = await tryLaunch(chromium, options, headless, channels, failures);
  if (!launched) throw browserHelp(failures);

  const page = launched.context.pages()[0] ?? (await launched.context.newPage());
  await page.goto(`${options.baseUrl}/user`, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
  await page.bringToFront().catch(() => undefined);
  options.onStatus?.(`已打开 ${launched.channel}，请在窗口里登录 noymanga.com`);

  return makeHandle(launched.context, launched.channel, null, options);
}
