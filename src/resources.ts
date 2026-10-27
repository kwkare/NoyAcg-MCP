import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ALL_STICKERS, STICKER_GROUPS, stickerUrl } from "./stickers.js";
import type { ToolContext } from "./tools/read.js";

/**
 * MCP Resources：把「agent 经常要读、而且读一次就够」的数据暴露成资源，
 * 让宿主可以按需加载（或缓存），比每轮都调工具省 token。
 *
 * 全部是只读快照；写操作仍然只能走工具。
 */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  const { client, cfg } = ctx;

  const jsonBody = (uri: URL, value: unknown) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 1) }],
  });

  server.registerResource(
    "profile",
    "noy://profile",
    {
      title: "我的账号资料",
      description: "当前 NOY_SESSION 的昵称 / UID / 积分 / 徽章 / 佩戴状态（脱敏，不含邮箱明文）",
      mimeType: "application/json",
    },
    async (uri) => {
      const info = (await client.userinfo()).userinfo ?? {};
      const badges = await client.badges();
      const idByImg = new Map((badges.data ?? []).map((b: Record<string, any>) => [String(b.Img), b.Id]));
      return jsonBody(uri, {
        uid: info.Uid,
        username: info.Username,
        integral: info.Integral,
        registeredAt: info.Time,
        avatar: client.bucketImageUrl(info.Avatar),
        bg: client.bucketImageUrl(info.Bg),
        badges: (info.Badge ?? []).map((b: Record<string, any>) => ({
          id: idByImg.get(String(b.Img)) ?? null,
          name: b.Name,
          img: b.Img,
        })),
        wearing: badges.show ?? [],
      });
    },
  );

  server.registerResource(
    "home-feed",
    "noy://feed/home",
    {
      title: "首页榜单（全年龄）",
      description: "公告、四个书籍榜单、番剧推荐与标签；allow-adult=false",
      mimeType: "application/json",
    },
    async (uri) => jsonBody(uri, await client.home(false)),
  );

  server.registerResource(
    "home-feed-adult",
    "noy://feed/home/adult",
    {
      title: "首页榜单（R18）",
      description: "同上，但 allow-adult=true。与全年龄是**互斥**的两套内容池",
      mimeType: "application/json",
    },
    async (uri) => jsonBody(uri, await client.home(true)),
  );

  server.registerResource(
    "community-latest",
    "noy://community/latest",
    {
      title: "社区最新帖",
      description: "社区第一页（含置顶帖），字段与 noy_list_posts 相同",
      mimeType: "application/json",
    },
    async (uri) => jsonBody(uri, await client.communityList({ page: 1, type: "new" })),
  );

  server.registerResource(
    "inbox-unread",
    "noy://inbox/unread",
    {
      title: "未读计数",
      description: "讯息中心三个 tab 的未读数（轮询成本很低）",
      mimeType: "application/json",
    },
    async (uri) => jsonBody(uri, (await client.msgCount()).count ?? {}),
  );

  server.registerResource(
    "stickers",
    "noy://stickers",
    {
      title: "表情包代码表",
      description:
        "4 组 57 个表情包的代码与图片地址（前端硬编码，无 API）。正文里写 [组:代码] 即可渲染；" +
        "大小写错误会导致代码**静默消失**，务必用小写。",
      mimeType: "application/json",
    },
    async (uri) =>
      jsonBody(uri, {
        note: "代码必须与表里完全一致（小写）；写错会显示成文字，大小写错会静默消失。",
        count: ALL_STICKERS.length,
        groups: STICKER_GROUPS.map((group) => ({
          name: group.name,
          label: group.label,
          stickers: group.stickers.map((sticker) => ({
            code: sticker.code,
            url: stickerUrl(cfg.baseUrl, sticker.file),
          })),
        })),
      }),
  );
}
