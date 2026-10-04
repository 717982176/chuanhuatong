# 1.0.1 升级步骤

本次修复 KV 镜像到期参数越界，并增加持续失败的逐步延迟重试。无需更换 KV、Durable Object、Bot Token 或 Webhook。

## 更新现有 Worker

1. 管理员先发送 `/backup` 保存备份。
2. 解压升级包，将包内 `chuanhuatong` 文件夹中的项目文件覆盖到原项目目录。包内没有个人 `wrangler.jsonc`，请保留原文件；不要用 `wrangler.example.jsonc` 覆盖它。
3. 在包含实际 `wrangler.jsonc` 的目录打开 PowerShell，执行：

```powershell
Test-Path .\wrangler.jsonc
npx.cmd wrangler@4.147.0 deploy --config wrangler.jsonc
```

`Test-Path` 必须返回 `True`；否则先回到原来的部署目录，不能凭模板部署新的空数据库。Worker 名称、KV ID、Durable Object 绑定与已有 migrations 都保持原配置。

如果只更新线上运行代码，也可以只覆盖该部署目录的 `chuanhuatong.js` 后执行上述部署命令；要更新 GitHub 项目则应覆盖升级包中的全部项目文件。

## 验收

部署成功后发送 `/diagnose`，等待后台同步后再次查看：重点核对待同步数量是否减少以及是否出现新的失败时间。旧的失败记录会保留，不能只看历史列表判断修复失败。

此版本在测试中自动修复历史毫秒到期字段，同时兼容 2038 年后的合法秒时间戳。生产中 4 条任务的真实内容尚未读取；如果继续失败，保留新的错误提示供定位，不清空 KV 或 Durable Object。

若错误变成额度耗尽，查看 Cloudflare 账号的各类 KV 用量。额度每天 UTC 00:00、北京时间 08:00 重置。升级套餐不能修复参数越界，50% 邮件也不表示已耗尽。

## 本地检查与提交 GitHub

在已覆盖全部项目文件的 Git 仓库中执行：

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run smoke
git status --short
git add chuanhuatong.js package.json package-lock.json CHANGELOG.md docs scripts tests
git diff --cached --stat
git commit -m "fix: normalize KV expiration and back off failed mirrors"
git push origin main
```

检查暂存摘要后再提交。实际配置、Secrets、备份和日志不应出现在暂存区。项目自带 `.gitignore` 排除这些文件。

本版验证：410 个离线回归、7 个真实 workerd / SQLite / KV 用例通过，构建通过；没有连接生产 Telegram 或部署生产 Worker。
