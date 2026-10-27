# examples

| 文件 | 宿主 |
| --- | --- |
| `claude_desktop_config.json` | Claude Desktop（推荐：不需要 env，登录态走本地会话文件） |
| `claude_desktop_config.cookie.json` | Claude Desktop（传统写法：cookie 放环境变量） |
| `cursor-mcp.json` | Cursor（放到 `.cursor/mcp.json` 或 `~/.cursor/mcp.json`） |

## 怎么登录

配好配置后，两种方式都行：

1. **命令行**（推荐先做一次）：`node dist/index.js login` —— 弹出 Chrome，登录完自动保存并关闭；
2. **对话里**：直接说「帮我登录 noymanga」，agent 会调 `noy_browser_login` 弹窗，你登好后会保存到
   `~/.noyacg-mcp/session.json`，当前进程立即生效，不用重启客户端。

想先试水的话，把 `NOY_READONLY` 设成 `"true"`：只暴露读工具，agent 无法发帖 / 评论 / 点赞。
