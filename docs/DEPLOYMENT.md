# 部署说明

以下 Windows 步骤在 PowerShell 中执行。macOS / Linux 使用相同的 Wrangler 参数，将 `npm.cmd` 改为 `npm`，`Copy-Item` 改为 `cp`。示例中的“你的地址”和 KV ID 必须替换。

## 1. 准备项目

安装 Node.js 24 或更高版本和 Git；下载 ZIP 的用户解压后直接进入项目目录即可。

```powershell
git clone https://github.com/717982176/chuanhuatong.git
Set-Location chuanhuatong
node -v
npm.cmd -v
npm.cmd ci
Copy-Item wrangler.example.jsonc wrangler.jsonc
Copy-Item .dev.vars.example .dev.vars
npx.cmd wrangler login
```

项目固定 Wrangler 4.147.0，避免 `@latest` 在不同时间产生配置差异。安装后使用本项目的 `npx.cmd wrangler`。

## 2. 配置 Worker 和存储

打开 `wrangler.jsonc`，修改 `name` 为自己的 Worker 名称。名称使用小写字母、数字和短横线。升级已有 Worker 必须使用原名称。

首次部署可创建 KV；已有部署使用原命名空间：

```powershell
npx.cmd wrangler kv namespace list
# 仅第一次部署、没有可用命名空间时执行：
npx.cmd wrangler kv namespace create BOT_KV
```

把返回的命名空间 ID 填入 `kv_namespaces[0].id`，替换示例中的 32 个零。保留绑定名称 `BOT_KV`、`BOT_STATE` 与类名 `BotCoordinator`。

示例使用 SQLite Durable Object 的声明式 `exports` 配置，适用于本项目的独立部署。若已有项目使用 `migrations`，不要将两种声明混用或删除历史迁移；在原有迁移列表追加新的 `tag` 和 `new_sqlite_classes: ["BotCoordinator"]`，保留原绑定与路由。参阅 [Cloudflare 配置文档](https://developers.cloudflare.com/workers/wrangler/configuration/)。

## 3. 准备 Telegram 与 Turnstile

1. 在 Telegram 的 `@BotFather` 创建机器人，获取 Bot Token。
2. 确认管理员的 Telegram **数字用户 ID**，不是手机号或用户名。
3. 在 Cloudflare 控制台创建 Turnstile 站点。允许域名填写实际 Worker 域名，例如 `你的Worker.你的子域.workers.dev`，使用自定义域名时也加入该域名。
4. 生成独立的 Webhook 密钥，例如以下命令生成 32 字节随机十六进制字符串：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

在本地 `.dev.vars` 中填入以下值，保持原来的引号和每行一个变量的形式：

| 名称 | 必填 | 用途 |
| --- | --- | --- |
| `BOT_TOKEN` | 是 | Telegram Bot Token |
| `MY_ADMIN_ID` | 是 | 管理员数字 ID |
| `WEBHOOK_SECRET` | 是 | Telegram Webhook 请求校验密钥 |
| `TURNSTILE_SITE_KEY` | 是 | Turnstile 站点公钥 |
| `TURNSTILE_SECRET` | 是 | Turnstile 私钥 |
| `WELCOME_IMAGE` | 否 | 可公开访问的欢迎图片 URL，留空发送文字 |

`.dev.vars` 是本地文件，不会自动作为生产配置上传。生产值需要单独上传到 Cloudflare。为简化操作，下列六项均可使用 Secrets 保存；公钥和管理员 ID 不要求加密，但这样不会进入公开配置。

## 4. 检查并上传

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
# 使用真实配置进行部署预检查；全零示例 ID 不能用于正式部署。
npx.cmd wrangler deploy --dry-run --config wrangler.jsonc
npm.cmd run deploy
```

首次部署尚未填写生产 Secrets 时，访问地址返回 `Config error` 属于配置未完成。部署得到 Worker 地址后依次设置 Secrets，命令会要求输入值，避免把值写在命令参数中：

```powershell
npx.cmd wrangler secret put BOT_TOKEN
npx.cmd wrangler secret put MY_ADMIN_ID
npx.cmd wrangler secret put WEBHOOK_SECRET
npx.cmd wrangler secret put TURNSTILE_SITE_KEY
npx.cmd wrangler secret put TURNSTILE_SECRET
# 仅需要欢迎图片时执行：
npx.cmd wrangler secret put WELCOME_IMAGE
```

也可以在 Cloudflare 控制台设置，名称必须完全一致。实际配置保留 `keep_vars: true`，升级时保留后台变量。`preview_urls: false` 关闭每版本预览地址，稳定的 `workers.dev` 地址仍然可用。

## 5. 设置 Webhook

确认 `.dev.vars` 中的 Bot Token 和 Webhook 密钥与生产一致，将下面的地址替换为部署输出的 HTTPS 地址：

```powershell
npm.cmd run set-webhook -- https://你的Worker.你的子域.workers.dev
npm.cmd run webhook-info
```

辅助脚本从本地环境读取凭据，通过 POST 设置 `secret_token`，订阅 `message`、`edited_message`、`callback_query`，并保留待投递消息。不会把真实 Token 放进命令参数，也不会输出完整 API 地址、Webhook 地址或远端错误正文。

生产 Webhook 只接受匹配 `X-Telegram-Bot-Api-Secret-Token` 的请求。每个 Bot 同时只有一个 Webhook；本地测试请使用单独测试 Bot，避免覆盖生产入口。相关接口见 [Telegram Bot API](https://core.telegram.org/bots/api#setwebhook)。

## 6. 上线验收

- 管理员发送 `/start`、`/admin`，确认菜单可用；重复发送后旧指令与旧欢迎 / 控制台消息会被清理。
- 未授权测试访客发送 `/start`，从 Telegram 内点击验证入口。通过后立即发送消息，管理员应收到消息。
- 双向测试文本、照片和相册；修改刚才发送的文本或图片，确认对方收到的副本内容更新。
- 两位访客交替留言并穿插管理员消息，检查气泡身份；删除重复管理指令后，相邻同一访客的分组应自动合并。
- 检查最近访客、已授权、待回复的翻页、备注、搜索、快捷回复记录和离开模式。
- 打开 `/diagnose`，确认绑定、Webhook 编辑订阅及待投递状况；创建一次 `/backup`，私下保留备份。

更多异常处理见[使用与维护](OPERATIONS.md)。Telegram 右下角原生“已编辑”的显示由平台与客户端决定，内容同步成功不以该标记出现为条件。

## 升级现有 Worker

1. 先用 `/backup` 保存数据，并私下备份实际 `wrangler.jsonc`。
2. 更新源码和仓库文件，执行 `npm.cmd ci`、检查、测试与构建。
3. 保留原 Worker 名称、KV 命名空间、Durable Object 绑定、类名、管理员 ID 和路由。**不要用示例配置覆盖已完成配置的 `wrangler.jsonc`。**
4. 用原配置执行 `npm.cmd run deploy`。地址和密钥没变时无需重设 Webhook；只有缺少 `edited_message` 订阅或主动更换配置时才重新设置。
5. 按上线验收重点复查新增功能，确认诊断中 KV 镜像没有持续积压。

Git 忽略实际 `wrangler.jsonc` 和 `.dev.vars`。首次从旧目录搬到新目录时，手动复制原配置；`git pull` 不会为你创建配置或迁移数据。

## 回退

回退前先创建备份并检查待同步镜像。使用 Cloudflare 已保存版本或历史 Git 提交回退代码，继续保留 `BOT_STATE` 和 `BOT_KV`。回退代码不会自动回退数据；不要删除 Durable Object 命名空间，不要未经核对回退到仅依赖 KV 的旧实现。
