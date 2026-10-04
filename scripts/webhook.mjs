import { pathToFileURL } from 'node:url';

export function webhookRequest(action, workerUrl, env) {
  if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(env.BOT_TOKEN || '')) throw new Error('请在本地 .dev.vars 或环境变量中填写 BOT_TOKEN。');
  if (!['set', 'info'].includes(action)) throw new Error('支持 set 或 info。');
  if (action === 'info') return { method: 'getWebhookInfo', payload: {} };
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(env.WEBHOOK_SECRET || '')) throw new Error('WEBHOOK_SECRET 必须是 1–256 位字母、数字、下划线或短横线。');
  let url;
  try { url = new URL(workerUrl); } catch { throw new Error('请传入 Worker 的完整 HTTPS 地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Worker 地址必须使用 HTTPS，且不能包含账号、查询参数或片段。');
  }
  return {
    method: 'setWebhook',
    payload: {
      url: url.href,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      drop_pending_updates: false,
    },
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, transport = fetch) {
  const [action, workerUrl, ...extra] = argv;
  if (extra.length) throw new Error('用法：npm run set-webhook -- https://你的Worker地址 或 npm run webhook-info');
  const { method, payload } = webhookRequest(action, workerUrl, env);
  let response;
  try {
    response = await transport(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new Error('Telegram 请求未能确认，请检查网络后用 webhook-info 核实；凭据不会输出。'); }
  let body;
  try { body = await response.json(); } catch { throw new Error('Telegram 返回了无效响应。'); }
  if (!response.ok || body?.ok !== true) {
    // Do not print remote descriptions: they may echo credentials or full request URLs.
    throw new Error(`Telegram 操作失败（HTTP ${response.status}）。请检查 Bot Token、Webhook 密钥和 HTTPS 地址。`);
  }
  if (action === 'set') return { ok: true, message: 'Webhook 已设置，保留待投递消息，并启用消息编辑更新。' };
  const result = body.result || {};
  return {
    configured: Boolean(result.url),
    pending_update_count: Number(result.pending_update_count) || 0,
    allowed_updates: Array.isArray(result.allowed_updates) ? result.allowed_updates : [],
    last_error_date: Number(result.last_error_date) || null,
    has_error: Boolean(result.last_error_message),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
