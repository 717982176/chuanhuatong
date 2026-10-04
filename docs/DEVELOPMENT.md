# 开发说明

## 本地检查

本项目以 Node.js 24 验证，运行时代码无 npm 生产依赖；Wrangler 为固定版本的开发依赖。

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run smoke
```

`check` 检查 JavaScript 语法、文档本地链接及常见凭据特征。实际本地配置和备份目录被忽略；这不是能识别任何形式秘密的通用安全扫描器，提交前还应人工查看 Git 差异。

`test` 自动运行 `tests/` 中的 CJS 套件，每个套件在独立进程内执行，最多并行 4 个进程。Telegram API、时钟、KV 与 Durable Object 使用模拟，覆盖故障重试和实例重建，不依赖旧版本文件，也不访问真实 Bot。

`build` 使用 `wrangler.example.jsonc` 做部署 dry-run，检查 Worker 打包和 SQLite Durable Object 声明，不读取生产凭据，也不发布到 Cloudflare。

`smoke` 需要先构建，使用固定版本 Miniflare 启动真实本地 workerd 和 SQLite，拦截外部 HTTP。检查基本路由、拒绝错误 Webhook Secret、拒绝伪造签名、菜单发送和重复更新去重。CI 运行以上四个步骤。

单独运行某个套件：

```powershell
node tests/relay-merge-regression.cjs
```

## 目录

| 路径 | 用途 |
| --- | --- |
| `chuanhuatong.js` | Worker 入口、机器人逻辑、协调器与存储实现 |
| `wrangler.example.jsonc` | 无账号资源信息的部署模板 |
| `.dev.vars.example` | 空白本地变量模板 |
| `scripts/` | 项目检查、测试执行、Webhook 管理 |
| `tests/` | 离线回归测试 |
| `docs/` | 部署、维护、架构、开发和审计文档 |
| `.github/` | CI、依赖更新、问题和 PR 模板 |

为保持直接上传和覆盖部署方便，运行时代码仍为单文件；新增功能应先维护清楚职责和数据边界，再决定是否拆分模块，避免仅以行数衡量质量。

## 修改约定

- 保留 `export default` 和 `export class BotCoordinator extends DurableObject`，不能去掉生产导出。
- 所有业务状态通过协调存储访问；需要事务的原生状态在协调器中处理。
- Telegram 外发是有副作用的操作。区分明确失败、确认成功和网络结果不明，不使用笼统的自动重发。
- 管理回复必须优先使用明确回复对象；无映射时不要回退到其他当前联系人。
- 身份气泡修改与管理消息删除必须更新分组历史，不能删除原转发键盘或回复映射。
- 访客昵称等外部文本经过 Unicode 与 HTML 处理，不能把未转义值直接插入 HTML。
- 交互尽量更新原菜单，输入上下文和一次性按钮必须有失效规则。
- 修改持久化字段时兼容既有记录，补充损坏记录、实例重建及重试场景；同步更新相应文档。

本地真实联调使用独立测试 Bot 和独立存储，不改变生产 Webhook。复制 `.dev.vars.example` 和 `wrangler.example.jsonc` 完成本地配置，再运行 `npm.cmd run dev`。普通本地地址不能直接作为 Telegram Webhook 的 HTTPS 地址，需要自行安排测试域名或受控入口。

## 发布流程

1. 确认变更与测试、文档一致，更新 `CHANGELOG.md` 和版本号。
2. 执行 `npm ci`、`npm run check`、`npm test`、`npm run build`、`npm run smoke`；需要时评估 `npm audit` 的依赖报告。
3. 检查 Git 暂存区，不包含实际配置、Token、日志、用户资料或备份。
4. 提交到 GitHub，检查 CI；使用独立 Bot 完成部署验收。
5. 需要生产升级时先备份，再使用原配置部署。GitHub CI 只检查代码，不自动部署生产。

许可证为 GPL-3.0-only，提交的代码应具备相容授权，保留必要来源说明。
