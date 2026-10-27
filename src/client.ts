import { NoyApiError, NoyAuthError, NoyError } from "./errors.js";
import type { Config } from "./config.js";
import { VERSION } from "./version.js";

export type FormValue = string | number | boolean | null | undefined;
export type FormBody = Record<string, FormValue>;
export type Json = Record<string, any>;

export interface RequestOptions {
  /** allow-adult 请求头；不传则用配置里的默认值 */
  adult?: boolean;
  timeoutMs?: number;
  /** 只对只读请求开启重试 */
  retry?: number;
}

export interface UploadInput {
  data: Uint8Array;
  fileName: string;
  mime: string;
  /** 图床路径，默认发帖用的 /api/upload_image */
  path?: string;
}

export type ProfileImageKind = "avatar" | "bg";

export interface UploadResult {
  file: string;
  /** 发帖时用的引用：`image/<file>` */
  imageRef: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause ? `${err.message}（${String(cause)}）` : err.message;
  }
  return String(err);
}

/**
 * 站点 HTTP 客户端。
 *
 * 设计要点：
 * - 业务状态藏在响应体的 `status` 里，HTTP 码几乎恒为 200，所以 `status === 'login'` 才抛鉴权错误；
 * - 签到接口的 `status` 是**数字**（200/500），不能按字符串判断；
 * - 写操作不重试（发帖 / 点赞 / 徽章开关都不幂等）；
 * - 上传走独立域名，**不带 Cookie**，只带一次性 token。
 */
export class NoyClient {
  constructor(readonly cfg: Config) {}

  get authenticated(): boolean {
    return this.cfg.session !== null;
  }

  private adult(adult?: boolean): boolean {
    return adult ?? this.cfg.defaultAdult;
  }

  private headers(adult: boolean, withCookie: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "allow-adult": adult ? "true" : "false",
      origin: this.cfg.baseUrl,
      referer: `${this.cfg.baseUrl}/`,
      "user-agent": `noyacg-mcp/${VERSION}`,
    };
    if (withCookie && this.cfg.session) headers.cookie = `NOY_SESSION=${this.cfg.session}`;
    return headers;
  }

  private async request(url: string, init: RequestInit, opts: RequestOptions): Promise<Response> {
    const retries = opts.retry ?? 0;
    const timeout = opts.timeoutMs ?? this.cfg.timeoutMs;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
        if (res.status >= 500 && attempt < retries) {
          lastError = new NoyError(`HTTP ${res.status}`);
          await sleep(500 * (attempt + 1));
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
      }
    }
    throw new NoyError(`请求失败：${url} —— ${describe(lastError)}`);
  }

  private async parse<T>(res: Response, path: string): Promise<T> {
    const raw = await res.text();
    if (!raw.trim()) throw new NoyError(`空响应：${path}（HTTP ${res.status}）`);
    try {
      return JSON.parse(raw) as T;
    } catch {
      const snippet = raw.slice(0, 200).replace(/\s+/g, " ");
      throw new NoyError(`非 JSON 响应：${path}（HTTP ${res.status}）：${snippet}`);
    }
  }

  /**
   * 统一的状态检查。
   * `login` 一定是鉴权问题；`error` 是内容被拒 / 参数不对；其它未知字符串原样报错。
   * 数字状态（签到 200/500）不在这里判断，交给调用方。
   */
  private raiseForStatus(payload: unknown, path: string): void {
    const status = (payload as Json | undefined)?.status;
    if (status === "login") throw new NoyAuthError();
    if (typeof status !== "string") return;
    if (["ok", "success", "logout"].includes(status)) return;
    if (status === "error") {
      throw new NoyApiError(
        `接口返回 status=error：${path}。常见原因：内容被拒（长度 / 敏感词）、频率限制、必填参数缺失`,
        status,
        payload,
      );
    }
    throw new NoyApiError(`接口返回 status=${status}：${path}`, status, payload);
  }

  /** 发一个表单请求并校验业务状态 */
  async post<T = Json>(path: string, form: FormBody = {}, opts: RequestOptions = {}): Promise<T> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (value !== undefined && value !== null) body.set(key, String(value));
    }
    const url = path.startsWith("http") ? path : `${this.cfg.baseUrl}${path}`;
    const res = await this.request(
      url,
      { method: "POST", headers: this.headers(this.adult(opts.adult), true), body: body.toString() },
      opts,
    );
    const payload = await this.parse<T>(res, path);
    this.raiseForStatus(payload, path);
    return payload;
  }

  /** 用一个已吊销风险的 cookie 换新 cookie；仅在 NOY_ALLOW_PASSWORD_LOGIN=true 时由工具调用 */
  async login(email: string, password: string): Promise<string> {
    const body = new URLSearchParams({ user: email, pass: password });
    const headers = this.headers(this.adult(), false);
    delete headers.cookie;
    const res = await this.request(
      `${this.cfg.baseUrl}/api/login`,
      { method: "POST", headers, body: body.toString() },
      { timeoutMs: this.cfg.timeoutMs },
    );
    const payload = await this.parse<Json>(res, "/api/login");
    this.raiseForStatus(payload, "/api/login");

    const raw = typeof (res.headers as any).getSetCookie === "function"
      ? ((res.headers as any).getSetCookie() as string[]).join("\n")
      : (res.headers.get("set-cookie") ?? "");
    const match = raw.match(/NOY_SESSION=([^;]+)/);
    if (!match?.[1]) throw new NoyError("登录返回 ok，但没有下发 NOY_SESSION");
    return match[1];
  }

  // ------------------------------------------------------------------ 首页 / 用户

  /** 首页聚合。v=3 才会返回 stream（番剧推荐），不带则这个 key 直接不存在 */
  home(adult?: boolean, includeStream = true): Promise<Json> {
    const form: FormBody = includeStream ? { v: 3, stream_all: 1 } : {};
    return this.post("/api/home", form, { adult, retry: 1 });
  }

  ads(adult?: boolean): Promise<Json> {
    return this.post("/api/v3/ads", {}, { adult, retry: 1 });
  }

  /** 最轻的会话探活：无副作用、返回小 */
  userinfo(adult?: boolean): Promise<Json> {
    return this.post("/api/v3/userinfo", {}, { adult, retry: 1 });
  }

  /** 徽章全集 + 佩戴中的 ID 列表（`show`，字符串数组） */
  badges(): Promise<Json> {
    return this.post("/api/badge", {}, { retry: 1 });
  }

  setBadgeShow(badgeId: number | string): Promise<Json> {
    return this.post("/api/v3/set_badge_show", { id: badgeId });
  }

  // ------------------------------------------------------------------ 签到

  signinRecord(): Promise<Json> {
    return this.post("/api/v4/signin/record", {}, { retry: 1 });
  }

  /** 重复签到会返回数字 status=500，不算异常，由调用方判断 */
  signinSign(): Promise<Json> {
    return this.post("/api/v4/signin/sign", {});
  }

  // ------------------------------------------------------------------ 社区

  communityList(input: { page?: number; type?: string; adult?: boolean } = {}): Promise<Json> {
    return this.post(
      "/api/v3/community_list",
      { page: input.page ?? 1, type: input.type ?? "new", filter: "" },
      { adult: input.adult, retry: 1 },
    );
  }

  postDetail(postId: number | string, adult?: boolean): Promise<Json> {
    return this.post(`/api/v4/community/post/${postId}`, {}, { adult, retry: 1 });
  }

  postComments(postId: number | string, page = 1, adult?: boolean): Promise<Json> {
    return this.post(`/api/v4/community/post/${postId}/comments`, { page }, { adult, retry: 1 });
  }

  commentReplies(postId: number | string, rid: number | string, page = 1, adult?: boolean): Promise<Json> {
    return this.post(
      `/api/v4/community/post/${postId}/comment/${rid}/replies`,
      { page },
      { adult, retry: 1 },
    );
  }

  /** replyToRid = -1 发顶层评论；填评论 rid = 楼中楼回复 */
  reply(input: { postId: number | string; text: string; replyToRid?: number; platform?: string }): Promise<Json> {
    return this.post(`/api/v4/community/post/${input.postId}/reply`, {
      reply_id: input.replyToRid ?? -1,
      text: input.text,
      platform: input.platform ?? "web",
      hide_ip: "false",
    });
  }

  editPost(input: { postId: number | string; title: string; content: string; platform?: string }): Promise<Json> {
    return this.post("/api/v3/edit_community_post", {
      id: input.postId,
      title: input.title,
      content: input.content,
      platform: input.platform ?? "web",
    });
  }

  /** 开关式：调一次切换一次 */
  like(cid: number | string): Promise<Json> {
    return this.post("/api/v3/community_like", { cid });
  }

  createPost(input: { title: string; content: string; imageRefs?: string[]; platform?: string }): Promise<Json> {
    const form: FormBody = {
      title: input.title,
      content: input.content,
      platform: input.platform ?? "web",
    };
    if (input.imageRefs?.length) form.image = JSON.stringify(input.imageRefs);
    return this.post("/api/v3/send_community", form);
  }

  // ------------------------------------------------------------------ 讯息

  messages(input: { type: "reply" | "community_reply" | "sysmsg"; page?: number }): Promise<Json> {
    return this.post("/api/v3/get_msg", { page: input.page ?? 1, type: input.type, v: 3 }, { retry: 1 });
  }

  msgCount(): Promise<Json> {
    return this.post("/api/v4/msg/count", {}, { retry: 1 });
  }

  // ------------------------------------------------------------------ 图床

  imageToken(): Promise<Json> {
    return this.post("/api/get_image_bucket_token", {});
  }

  /**
   * 上传一张图，返回文件名与发帖用的引用。
   * token 是一次性的，每张图重新换；请求**不带 Cookie**。
   */
  async uploadImage(input: UploadInput): Promise<UploadResult> {
    const tokenPayload = await this.imageToken();
    const token = tokenPayload.token;
    if (typeof token !== "string" || !token) throw new NoyError("换图床 token 失败：响应里没有 token");

    const form = new FormData();
    form.set("token", token);
    form.set("file", new Blob([input.data], { type: input.mime }), input.fileName);

    const res = await this.request(
      `${this.cfg.bucketUrl}${input.path ?? "/api/upload_image"}`,
      {
        method: "POST",
        body: form,
        headers: {
          // 注意：不设 content-type，让 fetch 自己生成 boundary；也不要带 Cookie
          origin: this.cfg.baseUrl,
          referer: `${this.cfg.baseUrl}/`,
          "allow-adult": this.adult() ? "true" : "false",
          "user-agent": `noyacg-mcp/${VERSION}`,
        },
      },
      { timeoutMs: this.cfg.uploadTimeoutMs },
    );

    const payload = await this.parse<Json>(res, `bucket${input.path ?? "/api/upload_image"}`);
    if (payload.status !== "ok") {
      throw new NoyApiError(
        `图床上传失败：status=${String(payload.status)}。token 过期/无效时重新换 token；HTTP ${res.status}`,
        payload.status,
        payload,
      );
    }
    const file = payload.file;
    if (typeof file !== "string" || !file) throw new NoyError("图床返回 ok，但没有 file 字段");
    return { file, imageRef: `image/${file}` };
  }

  /**
   * 上传头像 / 背景图。
   * 走 `/bucket/api/upload_avatar`、`/bucket/api/upload_bg`（与 upload_image 同一套 token + multipart），
   * 服务端会直接把新文件写进 `userinfo.Avatar` / `userinfo.Bg`，没有额外的保存接口。
   */
  async uploadProfileImage(kind: ProfileImageKind, input: Omit<UploadInput, "path">): Promise<UploadResult> {
    return this.uploadImage({ ...input, path: `/api/upload_${kind}` });
  }

  /** 相对路径（如 `avatar/x.webp`）→ 绝对 URL */
  bucketImageUrl(relative: string | undefined | null): string | null {
    if (!relative) return null;
    if (/^https?:\/\//i.test(relative)) return relative;
    // 接口给的都是「相对图床根目录」的路径，原样拼接即可：
    //   image/xxx.webp  → https://bucket.noymanga.com/image/xxx.webp
    //   avatar/xxx.webp → https://bucket.noymanga.com/avatar/xxx.webp
    //   bg/xxx.webp     → https://bucket.noymanga.com/bg/xxx.webp
    // 注意不要统一加 /image/ 前缀，那样 avatar/bg 会返回 JSON 而不是图片。
    return `${this.cfg.bucketUrl}/${relative.replace(/^\/+/, "")}`;
  }
}
