import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NoyError } from "../errors.js";
import { audit } from "../log.js";
import { clip, fmtTime, json, run } from "../format.js";
import { analyzeStickers } from "../stickers.js";
import { adultParam, pageParam, type ToolContext } from "./read.js";

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const MAX_IMAGES = 9;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

interface Uploaded {
  source: string;
  file: string;
  imageRef: string;
  bytes: number;
}

async function uploadLocalFiles(ctx: ToolContext, paths: string[]): Promise<Uploaded[]> {
  const uploaded: Uploaded[] = [];
  for (const raw of paths) {
    const path = resolve(raw);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new NoyError(`找不到文件：${path}`);
    if (info.size > ctx.cfg.maxUploadBytes) {
      throw new NoyError(
        `图片太大：${path}（${(info.size / 1024 / 1024).toFixed(1)} MB，上限 ${(ctx.cfg.maxUploadBytes / 1024 / 1024).toFixed(0)} MB）`,
      );
    }
    const mime = MIME_BY_EXT[extname(path).toLowerCase()];
    if (!mime) throw new NoyError(`不支持的格式：${path}（支持 jpg / jpeg / png / webp / gif）`);

    const data = await readFile(path);
    const result = await ctx.client.uploadImage({ data, fileName: basename(path), mime });
    uploaded.push({ source: path, file: result.file, imageRef: result.imageRef, bytes: data.byteLength });
  }
  return uploaded;
}

function stickerWarnings(text: string): string[] {
  const { unknown, wrongCase } = analyzeStickers(text);
  const warnings: string[] = [];
  if (wrongCase.length) {
    warnings.push(
      `⚠️ 大小写错误的表情包代码：${wrongCase.join(" ")} —— 前端正则带 i 会匹配到，但查表区分大小写，` +
        "结果是**整段代码静默消失**（不是显示成文字）。请改成小写。",
    );
  }
  if (unknown.length) {
    warnings.push(`⚠️ 未收录的表情包代码：${unknown.join(" ")} —— 会原样显示成文字，不会渲染。`);
  }
  return warnings;
}

/** 发帖 / 评论后，列表有一定延迟；轮询几次尽量拿到新 ID */
async function findNewPostId(ctx: ToolContext, uid: number, title: string, sinceSec: number): Promise<number | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const list = await ctx.client.communityList({ page: 1, type: "new" });
    const posts: Record<string, any>[] = list.info ?? [];
    const hit = posts.find((p) => p.uid === uid && p.title === title && Number(p.time) >= sinceSec - 5);
    if (hit) return Number(hit.id);
    await sleep(700);
  }
  return null;
}

function collectRids(comments: Record<string, any>[]): Set<number> {
  const rids = new Set<number>();
  for (const comment of comments) {
    rids.add(Number(comment.rid));
    for (const reply of comment.replies ?? []) rids.add(Number(reply.rid));
  }
  return rids;
}

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  const { client, cfg } = ctx;

  server.registerTool(
    "noy_upload_images",
    {
      title: "上传图片到图床",
      description:
        "把本地图片传到 noymanga 的图床，返回发帖可用的 `image/<file>` 引用。图片一律被服务端转成 webp。" +
        "这一步本身是写操作（占用图床空间），但不会在社区产生内容。发帖时再引用返回的 file 即可，无需重复上传。",
      inputSchema: {
        paths: z.array(z.string().min(1)).min(1).max(MAX_IMAGES).describe("本地图片绝对路径或相对当前工作目录的路径"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ paths }) =>
      run(async () => {
        const uploaded = await uploadLocalFiles(ctx, paths);
        await audit(cfg, { tool: "noy_upload_images", args: { count: paths.length }, ok: true, result: uploaded.map((u) => u.file) });
        return [
          `✅ 上传完成 ${uploaded.length} 张`,
          "",
          ...uploaded.map((u) => `- ${basename(u.source)}（${(u.bytes / 1024).toFixed(0)} KB）→ ${u.imageRef}`),
          "",
          "发帖时把上面的 imageRef 传给 noy_create_post 的 images 参数。",
          `imageRefs：${json(uploaded.map((u) => u.imageRef))}`,
        ].join("\n");
      }),
  );

  server.registerTool(
    "noy_create_post",
    {
      title: "发帖（社区）",
      description:
        "在社区发一条帖子，可选带图。⚠️ 不可撤销：站点没有删帖接口，帖子 90 天后自动过期，但期间无法删除；" +
        "⚠️ 图片是否打码由服务端判定（spoiler），客户端无法指定；发帖不返回帖子 ID，本工具会去列表里回查。" +
        "正文支持表情包代码（如 `[noygirl:yeah]`）与 `NID<书籍ID>` 引用。",
      inputSchema: {
        title: z.string().min(1).max(120).describe("标题"),
        content: z.string().min(1).max(5000).describe("正文，纯文本 + 表情包代码"),
        images: z
          .array(z.string().min(1))
          .max(MAX_IMAGES)
          .optional()
          .describe("图片：本地路径（会先自动上传）或已上传的文件名 / `image/<file>` 引用"),
        platform: z.enum(["web", "android"]).default("web").describe("客户端标识"),
        adult: adultParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ title, content, images, platform, adult }) =>
      run(async () => {
        const images_ = images ?? [];
        const imageRefs: string[] = [];
        const uploaded: Uploaded[] = [];

        for (const item of images_) {
          // 依次判断：本地文件 → 已是发帖引用 → 已上传的文件名
          const exists = await stat(resolve(item)).then((info) => info.isFile()).catch(() => false);
          if (exists) {
            const [result] = await uploadLocalFiles(ctx, [item]);
            if (result) {
              uploaded.push(result);
              imageRefs.push(result.imageRef);
            }
            continue;
          }
          if (item.startsWith("image/")) {
            imageRefs.push(item);
            continue;
          }
          if (/\.webp$/i.test(item) && !item.includes("/")) {
            imageRefs.push(`image/${item}`);
            continue;
          }
          throw new NoyError(
            `图片既不是本地文件，也不是发帖引用：${item}。` +
              "请传绝对路径，或用 noy_upload_images 先上传拿到 `image/<file>`。",
          );
        }

        const warnings = stickerWarnings(content);
        const me = (await client.userinfo(adult)).userinfo ?? {};
        const startedAt = Math.floor(Date.now() / 1000);

        const payload = await client.createPost({ title, content, imageRefs, platform });

        const postId = await findNewPostId(ctx, Number(me.Uid), title, startedAt);
        await audit(cfg, {
          tool: "noy_create_post",
          args: { title, content, images: imageRefs, platform },
          ok: true,
          result: { status: payload.status, postId },
        });

        const lines = [
          `✅ 发帖成功（status=${String(payload.status)}）`,
          `标题：《${title}》 · 图片 ${imageRefs.length} 张${uploaded.length ? `（新上传 ${uploaded.length} 张）` : ""}`,
        ];
        if (postId) lines.push(`帖子 ID：${postId} → ${cfg.baseUrl}/community/${postId}`);
        else lines.push("⚠️ 列表还没刷新出来，帖子 ID 未知；稍后可用 noy_list_posts 按标题查找。");
        if (warnings.length) lines.push("", ...warnings);
        lines.push(
          "",
          "注：服务端可能把图片标记为「需模糊」（spoiler），这由服务端判定，无法手动设置。",
        );
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "noy_comment",
    {
      title: "发评论 / 回复评论",
      description:
        "在帖子下发评论。不带 reply_to_rid 是顶层评论（reply_id=-1）；带 reply_to_rid 是楼中楼回复。" +
        "正文支持表情包代码。⚠️ 评论没有删除接口，发了就一直在；接口不返回评论 ID，本工具会回读列表找出新 rid。",
      inputSchema: {
        post_id: z.coerce.number().int().positive().describe("帖子 ID"),
        text: z.string().min(1).max(2000).describe("评论正文"),
        reply_to_rid: z.coerce
          .number()
          .int()
          .positive()
          .optional()
          .describe("要回复的评论 rid（楼中楼）；不传 = 发顶层评论"),
        platform: z.enum(["web", "android"]).default("web"),
        adult: adultParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ post_id, text, reply_to_rid, platform, adult }) =>
      run(async () => {
        const before = await client.postDetail(post_id, adult);
        const existing = collectRids(before.data?.comments ?? []);
        const me = (await client.userinfo(adult)).userinfo ?? {};

        const payload = await client.reply({ postId: post_id, text, replyToRid: reply_to_rid, platform });

        // 回读找新 rid（接口不返回）
        let found: Record<string, any> | null = null;
        for (let attempt = 0; attempt < 4 && !found; attempt += 1) {
          await sleep(attempt === 0 ? 300 : 700);
          const after = await client.postDetail(post_id, adult);
          const pool: Record<string, any>[] = [];
          for (const comment of after.data?.comments ?? []) {
            pool.push(comment, ...(comment.replies ?? []));
          }
          found =
            pool.find(
              (c) => !existing.has(Number(c.rid)) && Number(c.uid) === Number(me.Uid) && String(c.content) === text,
            ) ?? null;
        }

        await audit(cfg, {
          tool: "noy_comment",
          args: { post_id, text, reply_to_rid },
          ok: true,
          result: { status: payload.status, rid: found?.rid ?? null },
        });

        const warnings = stickerWarnings(text);
        const lines = [
          `✅ 已发布（status=${String(payload.status)}）· 帖子 #${post_id} · ${reply_to_rid ? `回复 rid ${reply_to_rid}` : "顶层评论"}`,
        ];
        if (found) {
          lines.push(`新评论 rid ${found.rid}${found.root_id ? ` · root_id ${found.root_id}` : ""}`);
        } else {
          lines.push("⚠️ 回读没找到新评论（可能列表延迟），稍后再用 noy_read_post 确认。");
        }
        if (warnings.length) lines.push("", ...warnings);
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "noy_edit_post",
    {
      title: "编辑帖子",
      description:
        "修改自己帖子的标题和/或正文（只传要改的字段，未传的沿用当前值）。只能改文字，**改不了图片和 spoiler**；" +
        "编辑不会把帖子顶到前面。⚠️ 会覆盖原内容，请先 noy_read_post 确认。",
      inputSchema: {
        post_id: z.coerce.number().int().positive(),
        title: z.string().min(1).max(120).optional(),
        content: z.string().min(1).max(5000).optional(),
        adult: adultParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ post_id, title, content, adult }) =>
      run(async () => {
        if (title === undefined && content === undefined) {
          throw new NoyError("至少提供 title 或 content 之一");
        }
        const before = (await client.postDetail(post_id, adult)).data?.post ?? {};
        const nextTitle = title ?? String(before.title ?? "");
        const nextContent = content ?? String(before.content ?? "");
        const warnings = content ? stickerWarnings(content) : [];

        const payload = await client.editPost({ postId: post_id, title: nextTitle, content: nextContent });
        const after = (await client.postDetail(post_id, adult)).data?.post ?? {};
        await audit(cfg, {
          tool: "noy_edit_post",
          args: { post_id, title: nextTitle, content: nextContent },
          ok: true,
          result: { status: payload.status, edit: after.edit },
        });

        const changed = (a: unknown, b: unknown) => (String(a) === String(b) ? "未变" : "已更新");
        return [
          `✅ 已提交（status=${String(payload.status)}）`,
          `标题：${changed(before.title, after.title)}`,
          `正文：${changed(before.content, after.content)}`,
          `封面图 / 图片：${(after.image ?? []).length} 张（不可修改）`,
          `最后编辑时间：${fmtTime(after.edit)}`,
          "",
          "当前正文：",
          String(after.content ?? ""),
          ...(warnings.length ? ["", ...warnings] : []),
        ].join("\n");
      }),
  );

  server.registerTool(
    "noy_like_post",
    {
      title: "点赞 / 取消点赞",
      description:
        "给帖子点赞或取消点赞。接口是**开关式**（调一次翻转一次），所以本工具会先读当前状态再决定要不要调，" +
        "并在调用后回读确认。可以指定 action=like / unlike 表达明确意图，避免重复调用把自己又取消掉。",
      inputSchema: {
        post_id: z.coerce.number().int().positive(),
        action: z.enum(["like", "unlike", "toggle"]).default("like").describe("like = 点赞；unlike = 取消；toggle = 翻转"),
        adult: adultParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ post_id, action, adult }) =>
      run(async () => {
        const before = (await client.postDetail(post_id, adult)).data?.post ?? {};
        const wasLiked = Boolean(before.is_like);
        const wantLiked = action === "toggle" ? !wasLiked : action === "like";

        if (wasLiked === wantLiked) {
          return `ℹ️ 已经是「${wantLiked ? "已赞" : "未赞"}」状态，没有调用接口（点赞数 ${before.like}）。`;
        }

        const payload = await client.like(post_id);
        const after = (await client.postDetail(post_id, adult)).data?.post ?? {};
        await audit(cfg, {
          tool: "noy_like_post",
          args: { post_id, action },
          ok: true,
          result: { status: payload.status, like: after.like, is_like: after.is_like },
        });

        if (Boolean(after.is_like) === wasLiked) {
          throw new NoyError(
            `点赞没有生效：接口返回 status=${String(payload.status)} 但帖子状态没变。` +
              "常见原因是 post_id 不存在（该接口不校验 cid），请先 noy_read_post 确认 ID。",
          );
        }
        return [
          `✅ ${wantLiked ? "已点赞" : "已取消点赞"} #${post_id}`,
          `点赞数：${before.like} → ${after.like} · is_like：${wasLiked} → ${after.is_like}`,
        ].join("\n");
      }),
  );

  server.registerTool(
    "noy_checkin",
    {
      title: "每日签到",
      description:
        "执行每日签到（+1 积分，连续天数 +1）。会先查记录：今天已签则直接返回、不重复调用。" +
        "站点按 UTC+8 的 00:00 重置；签到时间不记录具体时刻，统一写当天 0 点。",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const before = await client.signinRecord();
        if (before.today) {
          return `ℹ️ 今天已经签过了（连续 ${before.continuous} 天），没有调用签到接口。`;
        }
        const integralBefore = Number((await client.userinfo()).userinfo?.Integral ?? 0);
        const payload = await client.signinSign();

        const after = await client.signinRecord();
        const integralAfter = Number((await client.userinfo()).userinfo?.Integral ?? 0);
        await audit(cfg, {
          tool: "noy_checkin",
          args: {},
          ok: payload.status === 200,
          result: { status: payload.status, msg: payload.msg, continuous: payload.continuous },
        });

        if (payload.status !== 200) {
          throw new NoyError(
            `签到失败：status=${String(payload.status)} / msg=${String(payload.msg ?? "?")}。` +
              "注意这个接口的 status 是**数字**（200/500），500 通常是「今天已经签过」。",
          );
        }
        const delta = integralAfter - integralBefore;
        return [
          "✅ 签到成功",
          `连续天数：${payload.continuous ?? after.continuous} 天`,
          `积分：${integralBefore} → ${integralAfter}（${delta >= 0 ? "+" : ""}${delta}）`,
          `今天状态：today=${after.today}`,
        ].join("\n");
      }),
  );

  server.registerTool(
    "noy_set_badge",
    {
      title: "佩戴 / 取消佩戴徽章",
      description:
        "设置徽章佩戴状态。接口本身是**开关式**且**不校验 ID**（传垃圾值会写进 show 数组），" +
        "所以本工具会先校验 ID 是否在徽章表里，再按当前状态决定是否需要切换，保证幂等。",
      inputSchema: {
        badge_id: z.coerce.number().int().describe("徽章 ID，来自 noy_list_badges"),
        wear: z.boolean().default(true).describe("true = 佩戴，false = 取消佩戴"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ badge_id, wear }) =>
      run(async () => {
        const payload = await client.badges();
        const all: Record<string, any>[] = payload.data ?? [];
        const badge = all.find((b) => Number(b.Id) === badge_id);
        if (!badge) {
          throw new NoyError(
            `徽章 ${badge_id} 不存在。可用 ID：${all.map((b) => b.Id).join(", ")}（见 noy_list_badges）`,
          );
        }
        const wearing = new Set<string>((payload.show ?? []).map(String));
        const isWearing = wearing.has(String(badge_id));

        if (isWearing === wear) {
          return `ℹ️ 「${badge.Name}」已经${wear ? "佩戴中" : "未佩戴"}，没有调用接口。`;
        }

        const result = await client.setBadgeShow(badge_id);
        const after = await client.badges();
        const nowWearing = new Set<string>((after.show ?? []).map(String));
        await audit(cfg, {
          tool: "noy_set_badge",
          args: { badge_id, wear },
          ok: true,
          result: { status: result.status, show: after.show },
        });

        return [
          `✅ ${wear ? "已佩戴" : "已取消"}「${badge.Name}」（#${badge_id}）`,
          `佩戴列表：${(after.show ?? []).join(", ") || "（空）"}`,
          `校验：${nowWearing.has(String(badge_id)) === wear ? "状态已生效" : "⚠️ 状态与预期不符，请回读 noy_list_badges"}`,
          "",
          "提示：`show` 的顺序就是佩戴顺序；脏值（不存在的 ID）会一直留在里面，只能再切一次清掉。",
        ].join("\n");
      }),
  );

  // 账号密码登录默认关闭：密码会进入对话记录 / 宿主日志，风险比复制 cookie 高
  if (cfg.allowPasswordLogin) {
    server.registerTool(
      "noy_login",
      {
        title: "账号密码登录（可选，默认关闭）",
        description:
          "用邮箱 + 密码换一个新的 NOY_SESSION，并在**当前进程内**生效（重启 MCP 后失效）。" +
          "⚠️ 密码会出现在对话记录和宿主日志里，除非你明确需要，否则更推荐直接把 cookie 配到环境变量 NOY_SESSION。" +
          "⚠️ 这不会吊销其它会话，但会导致本进程使用新 cookie。需要 NOY_ALLOW_PASSWORD_LOGIN=true 才会注册本工具。",
        inputSchema: {
          email: z.string().email(),
          password: z.string().min(1),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ email, password }) =>
        run(async () => {
          const cookie = await client.login(email, password);
          client.cfg.session = cookie;
          const info = (await client.userinfo()).userinfo ?? {};
          await audit(cfg, { tool: "noy_login", args: { email }, ok: true, result: { uid: info.Uid } });
          return [
            `✅ 已登录：${info.Username}（UID ${info.Uid}）`,
            `cookie 已在当前进程内生效（${cookie.slice(0, 8)}…，共 ${cookie.length} 字符）`,
            "",
            "要长期生效：把这段 cookie 写进 MCP 配置的 NOY_SESSION 并重启客户端（值可用浏览器 DevTools 复制）。",
          ].join("\n");
        }),
    );
  }
}

/** 仅供测试：暴露给单测复用的纯函数 */
export { stickerWarnings, uploadLocalFiles, collectRids, MAX_IMAGES, pageParam as _pageParam };
