import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NoyClient } from "../client.js";
import type { Config } from "../config.js";
import { clip, fmtTime, fmtUntil, json, run } from "../format.js";

export interface ToolContext {
  client: NoyClient;
  cfg: Config;
}

/** 所有「内容向」接口共用的分级开关 */
export const adultParam = z
  .boolean()
  .optional()
  .describe(
    "是否请求成人向内容（allow-adult 请求头）。不传则用环境变量 NOY_ALLOW_ADULT，默认 false。" +
      "注意 /api/home 的服务端默认值是 true（不带就是 R18），本项目会显式传 false。",
  );

export const pageParam = z.coerce.number().int().min(1).max(9999).optional().describe("页码，从 1 开始");

export function bookLine(book: Record<string, any>, index: number): string {
  const parts = [
    `${index}. 《${clip(String(book.Bookname ?? "?"), 40)}》 Bid ${book.Bid}`,
    book.Author ? clip(String(book.Author), 24) : null,
    typeof book.Views === "number" ? `${book.Views} 浏览` : null,
    typeof book.Favorites === "number" ? `${book.Favorites} 收藏` : null,
    book.Adult === 1 ? "R18" : book.Adult === 0 ? "全年龄" : null,
    book.Status === 1 ? "完结" : book.Status === 0 ? "连载" : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function postLine(post: Record<string, any>, index: number): string {
  const expired = typeof post.expired === "number" && post.expired * 1000 < Date.now();
  return [
    `${index}. #${post.id} 《${clip(String(post.title ?? ""), 40)}》`,
    `@${post.username}`,
    fmtTime(post.time),
    `赞 ${post.like} / 回复 ${post.reply}`,
    post.is_like ? "已赞" : null,
    (post.image?.length ?? 0) > 0 ? `${post.image.length} 图` : null,
    expired ? "⚠️ 已过 90 天展示期" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function commentLine(comment: Record<string, any>, index?: number): string {
  const head = [
    index !== undefined ? `${index}.` : "-",
    `rid ${comment.rid}`,
    `@${comment.username}`,
    comment.area ? `(${comment.area})` : null,
    fmtTime(comment.time),
    typeof comment.reply_num === "number" && comment.reply_num > 0 ? `楼中楼 ${comment.reply_num}` : null,
  ].filter(Boolean);
  const prefix = comment.reply_username ? `回复 @${comment.reply_username}：` : "";
  return `${head.join(" ")}\n   ${prefix}${clip(String(comment.content ?? ""), 400)}`;
}

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  const { client, cfg } = ctx;

  server.registerTool(
    "noy_whoami",
    {
      title: "我的账号资料",
      description:
        "读取当前 NOY_SESSION 的账号资料：昵称、UID、积分、注册时间、头像，以及全部徽章 + 佩戴中的徽章。" +
        "这也是最轻的会话探活方式（无副作用），怀疑 cookie 失效时先调它。",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const info = (await client.userinfo()).userinfo ?? {};
        const badgePayload = await client.badges();
        const all: Record<string, any>[] = badgePayload.data ?? [];
        const wearing = new Set<string>((badgePayload.show ?? []).map(String));
        // userinfo.Badge[].Id 恒为 0，真实 ID 只能用 Img 反查 /api/badge
        const idByImg = new Map(all.map((b) => [String(b.Img), b.Id]));

        const badges = (info.Badge ?? []).map((b: Record<string, any>) => {
          const id = idByImg.get(String(b.Img)) ?? null;
          return { id, name: b.Name, wearing: id !== null && wearing.has(String(id)) };
        });
        const worn = badges.filter((b: { wearing: boolean }) => b.wearing);

        const email = typeof info.Email === "string" ? info.Email : "";
        const masked = email.includes("@")
          ? `${email.slice(0, 1)}***@${email.split("@")[1]}`
          : email ? "***" : "—";

        return [
          `👤 ${info.Username}（UID ${info.Uid} / Uhash ${info.Uhash}）`,
          `积分 ${info.Integral} · 注册 ${fmtTime(info.Time)} · 评论数 ${info.CommentLen ?? 0}`,
          `邮箱 ${masked}`,
          `头像 ${client.bucketImageUrl(info.Avatar) ?? "—"}`,
          `徽章 ${badges.length} 枚，佩戴中 ${worn.length} 枚` +
            (worn.length ? `：${worn.map((b: Record<string, any>) => `${b.name}（#${b.id}）`).join("、")}` : ""),
          "",
          "全部徽章：",
          ...badges.map(
            (b: Record<string, any>) => `- #${b.id ?? "?"} ${b.name}${b.wearing ? " ✅佩戴中" : ""}`,
          ),
        ].join("\n");
      }),
  );

  server.registerTool(
    "noy_home_feed",
    {
      title: "首页榜单 / 番剧推荐",
      description:
        "读取首页聚合数据：公告、四个书籍榜单（日收藏 / 日阅读 / 推荐位 / 编辑推荐）和番剧推荐（stream）。" +
        "注意：allow-adult=false 与 true 是两套互斥内容池，标签也会变；stream 只有带 v=3 才返回，本项目已默认带上。",
      inputSchema: {
        shelf: z
          .enum(["all", "favDay", "readDay", "fs", "proportion", "stream"])
          .default("all")
          .describe("取哪个榜单；all = 全部（每榜按 limit 截断）"),
        adult: adultParam,
        limit: z.number().int().min(1).max(20).default(8).describe("每个榜单返回多少条"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ shelf, adult, limit }) =>
      run(async () => {
        const data = await client.home(adult);
        const level = (adult ?? cfg.defaultAdult) ? "R18（allow-adult: true）" : "全年龄（allow-adult: false）";
        const tags: string[] = data.tags ?? [];
        const lines: string[] = [
          `📚 首页 · ${level}`,
          `公告：${clip(String(data.bulletin?.text ?? "—"), 80)}`,
          `标签（${tags.length}）：${tags.slice(0, 20).join(" / ")}`,
        ];

        const shelves: [string, string][] = [
          ["favDay", "日收藏榜"],
          ["readDay", "日阅读榜"],
          ["fs", "推荐位"],
          ["proportion", "编辑推荐"],
          ["stream", "番剧推荐"],
        ];

        for (const [key, label] of shelves) {
          if (shelf !== "all" && shelf !== key) continue;
          const items: Record<string, any>[] = data[key] ?? [];
          lines.push("", `【${label}】${items.length} 条${items.length === 0 ? "（无数据）" : ""}`);
          if (key === "stream") {
            for (const [i, item] of items.slice(0, limit).entries()) {
              lines.push(
                `- 《${clip(String(item.name ?? "?"), 40)}》 sid ${item.sid} · ${item.count ?? "?"} 集 · ` +
                  `${item.views ?? 0} 浏览 · ${item.favorites ?? 0} 收藏 · 更新 ${fmtTime(item.up_time)}`,
              );
              if (i === limit - 1) break;
            }
          } else {
            for (const [i, book] of items.slice(0, limit).entries()) lines.push(bookLine(book, i + 1));
          }
        }

        lines.push(
          "",
          `Bid / sid 汇总（供后续引用）：${JSON.stringify({
            favDay: (data.favDay ?? []).slice(0, limit).map((b: any) => b.Bid),
            readDay: (data.readDay ?? []).slice(0, limit).map((b: any) => b.Bid),
            fs: (data.fs ?? []).slice(0, limit).map((b: any) => b.Bid),
            proportion: (data.proportion ?? []).slice(0, limit).map((b: any) => b.Bid),
            stream: (data.stream ?? []).slice(0, limit).map((s: any) => s.sid),
          })}`,
        );
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "noy_list_posts",
    {
      title: "社区帖子列表",
      description:
        "按最新或最热翻社区帖子列表（每页约 40 条）。第 1 页会多带一条置顶帖；`len` 是近似总数会浮动，判断是否到底请用 `over`。" +
        "列表里没有评论内容，要看评论用 noy_read_post。",
      inputSchema: {
        sort: z.enum(["new", "like"]).default("new").describe("new = 最新；like = 热门"),
        page: pageParam,
        limit: z.number().int().min(1).max(42).default(12).describe("返回多少条摘要"),
        adult: adultParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sort, page, limit, adult }) =>
      run(async () => {
        const data = await client.communityList({ page: page ?? 1, type: sort, adult });
        const posts: Record<string, any>[] = data.info ?? [];
        const lines = [
          `🗂 社区 · ${sort === "like" ? "热门" : "最新"} · 第 ${page ?? 1} 页 · 本页 ${posts.length} 条 · 总数约 ${data.len}`,
          data.top ? "（第 1 页含置顶帖，通常是发布时间很早的那条）" : "",
          "",
          ...posts.slice(0, limit).map(postLine),
        ].filter(Boolean);
        if (posts.length > limit) lines.push("", `…还有 ${posts.length - limit} 条未展示（调大 limit 或用 page 翻页）`);
        lines.push(
          "",
          `over=${data.over}${data.over ? "（已到最后一页）" : "（还有下一页）"}`,
          `帖子 ID：${posts.slice(0, limit).map((p) => p.id).join(", ")}`,
        );
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "noy_read_post",
    {
      title: "看帖子与评论",
      description:
        "读取一个帖子的完整内容（正文、图片、模糊标记、点赞/回复数）和第一页评论（含楼中楼预览）。" +
        "评论里 `reply_id=-1` 是顶层评论；要看完整楼中楼用 noy_read_comment_replies。" +
        "正文里的 `[noygirl:yeah]` 是表情包代码、`NID123` 是书籍引用，都是纯文本存储、前端渲染。",
      inputSchema: {
        post_id: z.coerce.number().int().positive().describe("帖子 ID（社区列表里的 id）"),
        comment_limit: z.number().int().min(0).max(60).default(15).describe("展示多少条评论（0 = 只看帖子）"),
        adult: adultParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ post_id, comment_limit, adult }) =>
      run(async () => {
        const payload = await client.postDetail(post_id, adult);
        const data = payload.data ?? {};
        const post = data.post ?? {};
        const comments: Record<string, any>[] = data.comments ?? [];
        const spoiler = String(post.spoiler ?? "");
        const lines = [
          `📄 #${post.id} 《${post.title}》`,
          `@${post.username}（UID ${post.uid}） · ${fmtTime(post.time)} · ${post.area ?? "?"} · ${post.platform ?? "?"}`,
          `赞 ${post.like} · 回复 ${post.reply} · 评论 ${data.comment_count ?? comments.length}（置顶 ${data.top_count ?? 0}）` +
            (post.is_like ? " · 我已赞" : ""),
          `图片 ${post.image?.length ?? 0} 张${spoiler ? `（${spoiler.split(",").length} 张被服务端标记为需模糊，作者无法控制）` : ""}` +
            (post.image?.length ? `\n${post.image.map((p: string) => client.bucketImageUrl(p) ?? p).join("\n")}` : ""),
          `有效期：${fmtUntil(post.expired)}${post.edit ? ` · 最后编辑 ${fmtTime(post.edit)}` : ""}`,
          "",
          "正文：",
          String(post.content ?? "").trim() || "（空）",
        ];

        if (comment_limit > 0 && comments.length > 0) {
          lines.push("", `评论（显示 ${Math.min(comment_limit, comments.length)}/${comments.length}）：`);
          for (const [i, comment] of comments.slice(0, comment_limit).entries()) {
            lines.push(commentLine(comment, i + 1));
            const replies: Record<string, any>[] = comment.replies ?? [];
            for (const reply of replies.slice(0, 3)) {
              lines.push(`     ↳ rid ${reply.rid} @${reply.username}：${clip(String(reply.content ?? ""), 160)}`);
            }
            if ((comment.reply_num ?? 0) > replies.length || comment.reply_more) {
              lines.push(`     ↳ …还有 ${Math.max(0, (comment.reply_num ?? 0) - replies.length)} 条（用 noy_read_comment_replies）`);
            }
          }
        } else if (comments.length === 0) {
          lines.push("", "（还没有评论）");
        }
        if (comments.length > comment_limit) {
          lines.push("", `（本页共 ${comments.length} 条评论，还有 ${comments.length - comment_limit} 条未展示：调大 comment_limit）`);
        }

        lines.push(
          "",
          `下一步：发评论用 noy_comment(post_id=${post.id}, text=…)；回复某条评论时带上 reply_to_rid=<rid>。`,
        );
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "noy_read_comment_replies",
    {
      title: "看楼中楼",
      description:
        "读取某条评论下的全部回复（楼中楼），按时间倒序。评论详情接口通常已内联前几条，这里用于「加载更多」。" +
        "root_id 是根评论的 rid，reply_id 指向被回复的那一条。",
      inputSchema: {
        post_id: z.coerce.number().int().positive(),
        rid: z.coerce.number().int().positive().describe("根评论的 rid"),
        page: pageParam,
        limit: z.number().int().min(1).max(80).default(20),
        adult: adultParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ post_id, rid, page, limit, adult }) =>
      run(async () => {
        const payload = await client.commentReplies(post_id, rid, page ?? 1, adult);
        const data = payload.data ?? {};
        const replies: Record<string, any>[] = data.replies ?? [];
        const lines = [
          `💬 #${post_id} 的评论 rid ${rid}：共 ${data.count ?? replies.length} 条回复 · 第 ${data.page ?? 1} 页 · over=${data.over}`,
          "",
          ...replies.slice(0, limit).map((reply, i) => commentLine(reply, i + 1)),
        ];
        if (replies.length > limit) lines.push(`…还有 ${replies.length - limit} 条未展示`);
        if (replies.length === 0) lines.push("（没有回复）");
        lines.push(
          "",
          "字段：`reply_id` = 被回复的那条评论的 rid；`root_id` = 根评论 rid（发楼中楼时把 reply_id 设为目标的 rid）。",
        );
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "noy_inbox",
    {
      title: "讯息（未读数 / 评论回覆 / 社區回覆 / 系統訊息）",
      description:
        "读取站内讯息。kind=count 只取未读计数（最省，适合轮询）；kind=comment 是「书籍评论的回覆」；" +
        "kind=community 是「我参与过的帖子下的回复流」——它不是严格的「别人回复我」，需要自己按 cid 过滤自己的帖子。" +
        "站内没有「标记已读」接口：打开消息页即自动已读。",
      inputSchema: {
        kind: z
          .enum(["count", "comment", "community", "system"])
          .default("count")
          .describe("count = 未读数；comment / community / system = 三类消息列表"),
        page: pageParam,
        limit: z.number().int().min(1).max(80).default(12),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ kind, page, limit }) =>
      run(async () => {
        if (kind === "count") {
          const count = (await client.msgCount()).count ?? {};
          return [
            `📬 未读：全部 ${count.all ?? 0}`,
            `- 評論回覆（书籍）${count.comment_reply ?? 0}`,
            `- 社區回覆（帖子）${count.community_reply ?? 0}`,
            `- 系統訊息 ${count.sys_msg ?? 0}`,
            "",
            "提示：站内没有 mark-as-read 接口，打开消息页即视为已读。",
          ].join("\n");
        }

        const type = kind === "comment" ? "reply" : kind === "community" ? "community_reply" : "sysmsg";
        const payload = await client.messages({ type, page: page ?? 1 });

        if (type === "reply") {
          const block = payload.reply ?? {};
          const books: Record<string, any> = block.book ?? {};
          const items: Record<string, any>[] = block.comment ?? [];
          const lines = [
            `📖 书籍评论的回覆：共 ${block.count ?? items.length} 条 · 本页 ${items.length} · 第 ${page ?? 1} 页`,
            "",
            ...items.slice(0, limit).map((item, i) => {
              const book = books[String(item.bid)];
              return [
                `${i + 1}. @${item.username}（${item.area ?? "?"}）${fmtTime(item.time)} · 《${clip(String(book?.Bookname ?? "已删除"), 30)}》bid ${item.bid}`,
                `   回复 @${item.reply ? `评论 ${item.reply}` : "?"}：${clip(String(item.reply_text ?? ""), 80) || "—"}`,
                `   ${clip(String(item.content ?? ""), 300)}`,
              ].join("\n");
            }),
          ];
          lines.push("", `cid（书籍评论 ID）：${items.slice(0, limit).map((i) => i.cid).join(", ")}`);
          return lines.join("\n");
        }

        if (type === "community_reply") {
          const block = payload.community_reply ?? {};
          const posts: Record<string, any> = block.community ?? {};
          const items: Record<string, any>[] = block.community_reply ?? [];
          const lines = [
            `💬 社區回覆：共 ${block.count ?? items.length} 条 · 本页 ${items.length} · 第 ${page ?? 1} 页`,
            "⚠️ 这是「我参与过的帖子的回复流」，不全是别人回复我；要判断谁回了我，按 cid 匹配自己的帖子。",
            "",
            ...items.slice(0, limit).map((item, i) => {
              const post = posts[String(item.cid)];
              const top = item.reply === -1;
              return [
                `${i + 1}. @${item.username}（${item.area ?? "?"}）${fmtTime(item.time)} · 《${clip(String(post?.title ?? "已删除"), 30)}》#${item.cid}`,
                top ? `   ${clip(String(item.content ?? ""), 300)}` : `   回复 ${item.reply}（${clip(String(item.reply_text ?? ""), 60) || "—"}）：${clip(String(item.content ?? ""), 300)}`,
              ].join("\n");
            }),
          ];
          return lines.join("\n");
        }

        const block = payload.sysmsg ?? {};
        const items: Record<string, any>[] = block.msg ?? [];
        return [
          `🔔 系統訊息：count ${block.count ?? 0} · len ${block.len ?? 0} · 本页 ${items.length} 条`,
          items.length === 0
            ? "（没有系统消息，这个账号一直是空数组，条目字段结构未知）"
            : json(items.slice(0, limit)),
        ].join("\n");
      }),
  );

  server.registerTool(
    "noy_signin_status",
    {
      title: "签到记录",
      description:
        "查今天是否已签到、连续天数、最近记录。每天 00:00（UTC+8）重置；今天没签时 `continuous` 返回 -1（不是 0）。" +
        "只读；要真的签到用 noy_checkin。",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const record = await client.signinRecord();
        const rows: Record<string, any>[] = record.data ?? [];
        const lines = [
          `📅 今天${record.today ? "已签到 ✅" : "还没签到 ❌"}`,
          `连续天数：${record.today ? record.continuous : "—（没签，接口返回 " + record.continuous + "）"}`,
          "",
          "最近记录：",
          ...rows.map((r, i) => `${i + 1}. ${String(r.time).slice(0, 10)} · 连续 ${r.continuous} 天 · 星期 ${r.weekday}`),
        ];
        if (!record.today) lines.push("", "→ 用 noy_checkin 可以立刻签到（写操作）。");
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "noy_list_badges",
    {
      title: "徽章列表",
      description:
        "列出账号可用的全部徽章和佩戴状态（真实徽章 ID 在这里，userinfo 里的 Id 恒为 0）。" +
        "要改佩戴状态用 noy_set_badge，不要直接调接口（它不校验 ID，会写脏值）。",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const payload = await client.badges();
        const all: Record<string, any>[] = payload.data ?? [];
        const wearing = new Set<string>((payload.show ?? []).map(String));
        const lines = [
          `🎖 徽章 ${all.length} 枚，佩戴中 ${wearing.size} 枚（顺序 = 佩戴顺序）`,
          "",
          ...all.map(
            (badge) =>
              `- #${badge.Id} ${badge.Name}${wearing.has(String(badge.Id)) ? " ✅" : ""}\n  ${clip(String(badge.Des ?? ""), 100)}`,
          ),
        ];
        if (wearing.size === 0) lines.push("", "（当前没有佩戴任何徽章）");
        return lines.join("\n");
      }),
  );
}
