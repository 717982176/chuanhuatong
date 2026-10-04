# 传话筒 · chuanhuatong

运行在 Cloudflare Workers 上的 Telegram 私聊传话筒。访客通过验证后向机器人留言，管理员可以直接回复、切换联系人，或使用 `/send` 定向发送。

[![CI](https://github.com/717982176/chuanhuatong/actions/workflows/ci.yml/badge.svg)](https://github.com/717982176/chuanhuatong/actions/workflows/ci.yml)

## 功能

- Telegram Mini App 身份签名与 Cloudflare Turnstile 验证，授权确认后立即生效。
- 文本、图片及相册双向传递；同步后续文字和媒体修改；真实转发尽量保留原作者与原有按钮。
- 昵称可点击进入主页，连续访客消息只保留一个联系人气泡；删除指令分隔后自动合并相邻同一访客的分组。
- 已授权、最近访客、黑名单、联系人搜索与备注，每页最多 10 人；最近联系人保留 30 天。
- 会话闲置退出、快捷回复、离开模式、待回复管理，以及 3 / 5 / 7 天自动清理选项。
- 欢迎消息和控制台复用或清理旧消息；交互优先在原菜单上更新。
- Durable Object 实时状态、KV 后台镜像、更新去重、发送检查点、运行诊断和备份恢复。

## 快速开始

需要 Node.js 24 或更高版本、Cloudflare 账号、Telegram Bot，以及 Cloudflare Turnstile 站点。

```powershell
git clone https://github.com/717982176/chuanhuatong.git
Set-Location chuanhuatong
npm.cmd ci
Copy-Item wrangler.example.jsonc wrangler.jsonc
Copy-Item .dev.vars.example .dev.vars
```

接着按[部署说明](docs/DEPLOYMENT.md)配置自己的 Worker 名称、KV 绑定和 Secrets，再部署并设置 Webhook。已有部署请先阅读文档中的“升级现有 Worker”，继续使用原有资源。

仓库中的配置只有示例值，不包含 Bot Token、Turnstile 私钥、管理员 ID 或实际 KV 命名空间 ID。真实凭据填写在本地 `.dev.vars` 和 Cloudflare Secrets 中。

## 常用操作

| 身份 | 操作 | 用途 |
| --- | --- | --- |
| 访客 | `/start` | 获取验证入口或欢迎消息 |
| 访客 | `/status`、`/help` | 查看状态和使用说明 |
| 管理员 | `/admin` | 打开控制台 |
| 管理员 | 回复访客副本 | 回复对应访客 |
| 管理员 | `/send ID 内容` | 向指定访客发送文字 |
| 管理员 | `/search 关键词`、`/inbox` | 搜索联系人、查看待回复 |
| 管理员 | `/quick`、`/away on` | 快捷回复、离开模式 |
| 管理员 | `/diagnose`、`/backup` | 运行诊断、创建备份 |

完整指令和操作规则见[使用与维护](docs/OPERATIONS.md)。

## 文档与验证

| 文档 | 内容 |
| --- | --- |
| [部署说明](docs/DEPLOYMENT.md) | Windows 步骤、环境变量、Webhook、升级和上线检查 |
| [使用与维护](docs/OPERATIONS.md) | 管理指令、数据维护、备份、异常处理 |
| [架构与边界](docs/ARCHITECTURE.md) | 状态协调、消息映射、数据期限、平台限制 |
| [开发说明](docs/DEVELOPMENT.md) | 安装、检查、回归测试和修改规范 |
| [审计报告](docs/AUDIT.md) | 发布前检查范围、结果和未覆盖项 |
| [更新记录](CHANGELOG.md) | 版本与变更 |
| [贡献说明](CONTRIBUTING.md) | 提交问题和代码变更 |
| [安全说明](SECURITY.md) | 凭据管理及漏洞报告 |

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run smoke
```

回归测试使用离线 Telegram 与存储模拟，不需要真实 Token。`build` 使用示例配置进行 Wrangler 构建检查，不发布 Worker；`smoke` 在真实本地 workerd 引擎与 SQLite 中验证基础入口，拦截所有外部请求。真实 Telegram 客户端和生产网络表现仍需部署后验收。

## 许可证

Copyright © 2026 [717982176](https://github.com/717982176)。本项目采用 **GPL-3.0-only**，完整条款见 [LICENSE](LICENSE)。分发项目或其修改版本时，请遵守许可证中关于源代码、版权声明和同许可证分发的要求。
