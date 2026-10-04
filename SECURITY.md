# 安全说明

## 配置和资料

Bot Token、Turnstile 私钥和 Webhook Secret 使用 Cloudflare Secrets。实际 `wrangler.jsonc` 与本地 `.dev.vars` 被 Git 忽略，公开示例只保留占位或空值。

备份包含访客资料，日志也可能包含业务信息；不要公开上传。项目会脱敏已知配置密钥，但部署者分享日志前仍应自行检查。使用独立测试 Bot，避免测试脚本覆盖生产 Webhook。

Webhook 使用 Telegram Secret Header 校验；网页验证校验 Telegram Mini App HMAC、有效时间及 Turnstile。管理操作仅允许配置的管理员私聊执行。修改相关逻辑时必须保留对应回归测试。

## 泄露处理

发现 Bot Token 泄露后，在 `@BotFather` 撤销并重新生成，更新生产和本地配置，再设置 Webhook。Webhook Secret 或 Turnstile 私钥泄露时也需要更换；从当前文件删除秘密不会自动清除 Git 历史或第三方副本。

## 报告漏洞

不要通过公开 Issue 发布可利用的漏洞细节或任何凭据。如果仓库开启了 GitHub 私密漏洞报告，可在 Security 页面使用该入口；否则先在公开 Issue 中仅请求私下联系，不附复现载荷、用户资料或秘密。

请提供受影响的版本、必要复现步骤和影响范围，使用合成测试数据。项目未承诺固定响应时限。持续维护的主分支优先接收安全修复，旧发布版本请更新后重新检查。
