# 贡献说明

提交问题前，请阅读[使用与维护](docs/OPERATIONS.md)和[平台边界](docs/ARCHITECTURE.md)，确认使用的是当前版本。提供复现步骤、预期与实际结果、客户端和版本信息，以及经过脱敏的诊断内容。

不要在 Issue、截图、日志或 PR 中公开 Bot Token、Webhook / Turnstile 私钥、真实用户消息和备份。安全问题按照 [SECURITY.md](SECURITY.md) 私下报告。

代码贡献请围绕一个明确行为修改，加入能验证该行为及相关失败情形的回归测试，更新文档，并运行：

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run smoke
```

提交前查看差异，确保 `wrangler.jsonc`、`.dev.vars`、备份和生成目录未进入暂存区。PR 说明应写清触发条件、变化后的行为和实际验证结果，区分离线模拟与真实联调。

本项目采用 GPL-3.0-only；贡献者需有权以相容许可证提交相关代码，不引入授权不明的素材或代码。
