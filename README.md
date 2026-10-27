# noyacg-mcp

[NoyAcg / noymanga.com](https://noymanga.com) 的 **MCP server** —— 让 AI agent 直接看社区、读帖子、查榜单、发帖评论、签到、管徽章。

基于仓库 [NoyAcg-API-Collect](https://github.com/kwkare/NoyAcg-API-Collect) 里逐条实测过的接口契约实现，**TypeScript + stdio**，接 Claude Desktop / Cursor / 任何支持 MCP 的宿主。

最省事的用法：**配好路径 → 让 agent 弹个浏览器窗口 → 你自己登录 → 完事**。不用翻 DevTools 复制 cookie。

```text
你：看看社区今天有什么热闹，挑两条有意思的说给我听
agent → noy_list_posts(sort=like) → noy_read_post(78912) → noy_inbox(kind=count)
agent：今天热帖是……（附带评论里在吵什么）
```

## 特性

- **浏览器登录**：`noy_browser_login` 打开独立 Chrome 窗口，用户自己登录，自动抓 `NOY_SESSION` 并保存，**当前进程立刻生效**
- **17 个任务级工具**：不是一个端点一个工具，而是「看帖」「发评论」「签到」这种完成一件事的工具
- **6 个资源**（`noy://`）：主页资料、首页榜单、最新帖、未读数、表情包代码表，可按需加载 / 缓存
- **2 个提示词模板**：社区速览、评论起草
- **写操作直接执行 + 审计日志**：每次发帖 / 评论 / 点赞 / 签到 / 徽章变更都追加一行 JSONL
- **把踩过的坑写进工具里**：`allow-adult` 默认 false、点赞幂等、徽章 ID 校验、签到先查再签、表情包大小写检查……

## 安装

```bash
git clone https://github.com/kwkare/NoyAcg-MCP.git
cd NoyAcg-MCP
npm ci
npm run build

# 登录（会弹出 Chrome，登录一次即可）
node dist/index.js login
node dist/index.js status     # 确认会话有效
```

要求 Node.js ≥ 18.17，以及 Chrome（或 Edge / `npx playwright install chromium`）。

## 配置

登录态有三种给法，**优先级：环境变量 > 本地会话文件**。

| 方式 | 怎么做 | 适合 |
| --- | --- | --- |
| **A. 浏览器登录**（推荐） | `node dist/index.js login`，或让 agent 调 `noy_browser_login` | 所有人，尤其是懒得碰 DevTools 的 |
| B. 环境变量 | MCP 配置里写 `NOY_SESSION` | 多账号切换 / 容器 / 服务器 |
| C. 会话文件 | 直接写 `~/.noyacg-mcp/session.json` | 脚本化部署 |

### A. 浏览器登录（推荐）

```bash
node dist/index.js login          # 打开 Chrome，登录后自动保存并关闭
node dist/index.js login --timeout 120
```

- 用的是**独立 profile**（`~/.noyacg-mcp/browser`），不会动你日常浏览器的登录态；
- 登录过一次之后再打开：先 headless 探测（约 2 秒），命中就**直接复用、不弹窗**，并保存会话；
- 想换账号：`noy_logout` 再 `login`；想彻底作废这个 cookie：`noyacg-mcp logout --revoke`；
- Cookie 存到 `~/.noyacg-mcp/session.json`，权限 `0600`；
- 也可以在对话里让 agent 调 `noy_browser_login`：先 `action=open` 弹窗，登录好后 `action=wait` 保存，**不用重启 MCP**。

> 会话文件里是明文 Cookie，等同账号凭证。别提交到 git、别随手发给别人。

### B. Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`（macOS）或 `%APPDATA%\Claude\claude_desktop_config.json`（Windows）：

```json
{
  "mcpServers": {
    "noyacg": {
      "command": "node",
      "args": ["/absolute/path/to/NoyAcg-MCP/dist/index.js"]
    }
  }
}
```

不需要 `env`：登录态从 `~/.noyacg-mcp/session.json` 读。想用环境变量覆盖，就再加 `"env": { "NOY_SESSION": "..." }`（见 `examples/claude_desktop_config.cookie.json`）。

### Cursor / 其它

`.cursor/mcp.json`（项目级）或 `~/.cursor/mcp.json`（全局），结构同上。VS Code、Cline、Continue 等只要是 stdio MCP 客户端都一样。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NOY_SESSION` | — | 站点 Cookie 的值（也可以粘贴整段 `NOY_SESSION=xxx`）；**优先级最高** |
| `NOY_SESSION_FILE` | `~/.noyacg-mcp/session.json` | 本地会话文件路径 |
| `NOY_BROWSER` | 自动探测 | 指定浏览器通道：`chrome` / `msedge` / `chromium` |
| `NOY_BROWSER_PROFILE` | `~/.noyacg-mcp/browser` | 浏览器登录用的独立 profile 目录 |
| `NOY_BROWSER_HEADLESS` | `false` | 无头模式（服务器 / CI） |
| `NOY_DISABLE_BROWSER_LOGIN` | `false` | `true` 时不注册 `noy_browser_login`（无桌面环境） |
| `NOY_ALLOW_ADULT` | `false` | 内容分级默认值；工具参数 `adult` 可逐次覆盖 |
| `NOY_READONLY` | `false` | `true` 时**只注册只读工具**，写操作从工具列表里消失 |
| `NOY_AUDIT_LOG` | `~/.noyacg-mcp/audit.jsonl` | 写操作审计日志；设成 `off` 关闭 |
| `NOY_TIMEOUT_MS` | `30000` | 普通请求超时 |
| `NOY_UPLOAD_TIMEOUT_MS` | `120000` | 图床上传超时（服务端会转码，比较慢） |
| `NOY_MAX_UPLOAD_MB` | `20` | 单张图片大小上限 |
| `NOY_ALLOW_PASSWORD_LOGIN` | `false` | `true` 才注册 `noy_login`（见下方安全说明） |
| `NOY_BASE_URL` / `NOY_BUCKET_URL` | 官方域名 | 指向自建 / 测试环境时用 |

## 工具

### 只读

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `noy_whoami` | 资料、积分、徽章、佩戴状态；也是会话探活 | — |
| `noy_home_feed` | 首页榜单 + 番剧推荐 + 标签 | `shelf`、`adult`、`limit` |
| `noy_list_posts` | 社区列表（最新 / 热门） | `sort`、`page`、`limit` |
| `noy_read_post` | 帖子正文 + 图片 + 评论 + 楼中楼预览 | `post_id`、`comment_limit` |
| `noy_read_comment_replies` | 楼中楼完整列表 | `post_id`、`rid`、`page` |
| `noy_inbox` | 未读数 / 书籍评论回覆 / 社區回覆 / 系統訊息 | `kind`、`page`、`limit` |
| `noy_signin_status` | 今天签没签、连续天数 | — |
| `noy_list_badges` | 徽章全集 + 佩戴状态（真实 ID 在这里） | — |

### 登录

| 工具 | 作用 | 说明 |
| --- | --- | --- |
| `noy_browser_login` | 打开浏览器让用户登录，自动抓 Cookie 并保存 | `action=open\|wait\|cancel`；独立 profile；**登录过就直接复用、不弹窗**；保存后立即生效 |
| `noy_logout` | 清除本地登录态 | 默认只清本地；`revoke=true` 会调 `/api/logout` **吊销服务端会话**（不可逆） |

### 写操作（**直接生效，无二次确认**）

| 工具 | 作用 | 备注 |
| --- | --- | --- |
| `noy_upload_images` | 本地图片 → 图床，返回 `image/<file>` | 服务端统一转 webp |
| `noy_create_post` | 发帖（可带图） | **无法删除**，90 天后自动过期 |
| `noy_comment` | 顶层评论 / 楼中楼回复 | **无法删除**，会回读出新 rid |
| `noy_edit_post` | 改标题 / 正文 | 改不了图片，且会覆盖原文 |
| `noy_like_post` | 点赞 / 取消 | 先读后写，`action=like\|unlike\|toggle` |
| `noy_checkin` | 每日签到 | 已签则跳过，返回积分变化 |
| `noy_set_badge` | 佩戴 / 取消佩戴 | 先校验 ID（接口本身不校验） |

## 资源

| URI | 内容 |
| --- | --- |
| `noy://profile` | 当前账号资料（邮箱已省略） |
| `noy://feed/home` | 首页榜单（全年龄） |
| `noy://feed/home/adult` | 首页榜单（R18） |
| `noy://community/latest` | 社区第一页（含置顶帖） |
| `noy://inbox/unread` | 三个 tab 的未读数 |
| `noy://stickers` | 4 组 57 个表情包代码 + 图片地址 |

## 提示词

- `noy_digest`：翻社区、挑帖子、读评论，输出速览（可指定关注主题）
- `noy_reply_draft`：读帖后按指定语气起草评论（默认只起草、不发送）

## 安全与边界

**这个 MCP 会真的操作你的账号。** 设计上的护栏：

- **Cookie 只存在本地**：`~/.noyacg-mcp/session.json`（0600）与独立浏览器 profile；登录过程不经过第三方，密码直接输在 noymanga 的页面上
- **写操作直接执行**（按需求如此），但每次都会写审计日志：`ts / tool / args / ok / result`，Cookie 与 token 自动打码
- `NOY_READONLY=true` 可以一键把写工具从工具列表里摘掉，只留只读
- `noy_like_post` / `noy_set_badge` 都是「先读当前状态 → 需要才调」，避免重复调用把自己翻转回去
- `noy_set_badge` 会先校验 ID：官方接口**不校验**，传垃圾值会永久写进 `show` 数组
- `noy_create_post` 会检查正文里的表情包代码：大小写写错会被前端**静默吞掉**（不是显示成文字），工具会直接警告
- 账号密码登录默认**不注册**（密码会进对话记录与宿主日志），要开得显式设 `NOY_ALLOW_PASSWORD_LOGIN=true`

其它事实（都会影响 agent 的判断）：

- 帖子 / 评论 **没有删除接口**，只能等 90 天过期；过期后从列表消失但链接仍可访问
- 点赞、徽章佩戴都是**开关式**，重试一次 = 翻转回去
- 签到按 **UTC+8 00:00** 重置，每次 +1 积分；重复签到返回**数字** `status=500`
- 内容分「全年龄 / R18」两套**互斥**内容池，`allow-adult` 不同则榜单、标签全变
- 站内没有「标记已读」接口：打开消息页即已读

## 开发

```bash
npm run build      # tsc
npm test           # 38 个用例：单元 + 集成（内置假站点 + headless Chrome，不碰真实站点）
npm run smoke      # 真正拉起 stdio server 走一遍 JSON-RPC
node dist/index.js status   # 检查真实登录态
```

测试分四层（36 个用例）：

1. `test/client.test.mjs`：HTTP 客户端（编码、Cookie、分级头、错误映射、multipart、图片 URL 拼接）
2. `test/tools.test.mjs` + `test/mock-site.mjs`：**完整 MCP 协议**跑全部工具，含发帖 / 评论 / 点赞 / 签到 / 徽章等写流程（对假站点，不会产生真实内容）
3. `test/session.test.mjs` + `test/browser-login.test.mjs`：会话文件读写与权限、headless Chrome 上的真实登录流程（抓 cookie → 校验 → 落盘）、MCP 工具端到端；本机没有浏览器时自动 skip
4. `scripts/smoke.mjs`：未登录状态下的工具清单、资源、提示词、错误提示

接口契约以 [NoyAcg-API-Collect](https://github.com/kwkare/NoyAcg-API-Collect) 的 `docs/` 为准；那边是人工实测记录，这边是它的可执行封装。

## 许可证

MIT。非官方项目，与 NoyAcg 官方无关；请遵守站点规则，不要用它刷帖 / 刷积分。
