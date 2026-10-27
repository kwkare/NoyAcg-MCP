import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * MCP Prompts：给宿主一个「开箱即用的任务模板」。
 * 这里只写提示词，不直接调接口——真正的数据由模型在对话里用工具取。
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "noy_digest",
    {
      title: "社区速览",
      description: "翻一遍社区最新 / 热门帖，挑几条值得看的读正文和评论，输出一份摘要",
      argsSchema: {
        focus: z.string().optional().describe("关注的主题，例如「插画」「求推荐」「表情包」"),
        count: z.string().optional().describe("看几条帖子，默认 5"),
      },
    },
    ({ focus, count }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `帮我做一份 NoyAcg 社区速览${focus ? `，重点关注「${focus}」` : ""}，看 ${count ?? "5"} 条左右。`,
              "",
              "步骤建议：",
              "1. 用 noy_list_posts(sort=new) 拿最新帖，必要时再用 sort=like 看热门；",
              "2. 挑出标题看起来相关的帖子，用 noy_read_post 读正文和评论；",
              "3. 顺手用 noy_inbox(kind=count) 看一下有没有未读；",
              "4. 输出：每条一句话讲清楚「谁发了什么 / 讨论点在哪」，并给出帖子链接（https://noymanga.com/community/<id>）。",
              "",
              "注意：正文里的 [noygirl:yeah] 这类是表情包代码，不要照抄进摘要；帖子 90 天后会从列表消失。",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "noy_reply_draft",
    {
      title: "起草一条评论",
      description: "读某个帖子（和已有评论），按指定语气起草一条得体的回复，可选带表情包代码",
      argsSchema: {
        post_id: z.string().describe("帖子 ID"),
        tone: z.string().optional().describe("语气，例如「轻松」「认真讨论」「玩梗」"),
        with_sticker: z.string().optional().describe("是否加表情包代码（true / false）"),
      },
    },
    ({ post_id, tone, with_sticker }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `请先读帖子 #${post_id} 的正文和评论（noy_read_post），再帮我起草一条评论。`,
              `语气：${tone ?? "轻松自然"}；${with_sticker === "true" ? "可以加 1 个表情包代码。" : "先不加表情包。"}`,
              "",
              "要求：",
              "- 回复要接得上上下文，不要复读别人的评论；",
              "- 如果楼里已经有人说过同样的观点，换成别的角度或者直接回复那条评论（用 reply_to_rid）；",
              "- 需要表情包代码时先读 noy://stickers，只用表里存在的小写代码；",
              "- 起草完先给我看，不要直接发（noy_comment 一旦发出无法删除）。",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
