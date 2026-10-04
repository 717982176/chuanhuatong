const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

(async () => {
  const { webhookRequest, main } = await import(pathToFileURL(resolve(__dirname, '../scripts/webhook.mjs')));
  const env = { BOT_TOKEN: '123456:TEST_ONLY', WEBHOOK_SECRET: 'TEST_ONLY_SECRET' };
  let count = 0;
  async function test(name, run) { await run(); count++; console.log('PASS ' + name); }
  await test('set 保留待投递消息并订阅编辑更新', () => {
    const result = webhookRequest('set', 'https://worker.example/', env);
    assert.equal(result.method, 'setWebhook');
    assert.equal(result.payload.secret_token, env.WEBHOOK_SECRET);
    assert.equal(result.payload.drop_pending_updates, false);
    assert.deepEqual(result.payload.allowed_updates, ['message', 'edited_message', 'callback_query']);
  });
  await test('info 不发送 Webhook 密钥', () => {
    assert.deepEqual(webhookRequest('info', undefined, env), { method: 'getWebhookInfo', payload: {} });
  });
  await test('拒绝缺失凭据和不符合 Telegram 格式的 Webhook 密钥', () => {
    assert.throws(() => webhookRequest('set', 'https://worker.example', {}), /BOT_TOKEN/);
    for (const value of ['', 'a b', 'a'.repeat(257)]) {
      assert.throws(() => webhookRequest('set', 'https://worker.example', { ...env, WEBHOOK_SECRET: value }), /WEBHOOK_SECRET/);
    }
  });
  await test('拒绝非 HTTPS、地址凭据和查询秘密', () => {
    for (const value of ['bad', 'http://worker.example', 'https://user:pass@worker.example', 'https://worker.example/?secret=x', 'https://worker.example/#x']) {
      assert.throws(() => webhookRequest('set', value, env));
    }
  });
  await test('请求使用 POST JSON 且不在返回记录中包含秘密', async () => {
    const result = await main(['set', 'https://worker.example'], env, async (url, options) => {
      assert.equal(url, `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`);
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).secret_token, env.WEBHOOK_SECRET);
      return Response.json({ ok: true, result: true });
    });
    assert.equal(result.ok, true);
    assert.ok(!JSON.stringify(result).includes(env.BOT_TOKEN));
    assert.ok(!JSON.stringify(result).includes(env.WEBHOOK_SECRET));
  });
  await test('HTTP 错误不输出远端秘密正文', async () => {
    await assert.rejects(main(['info'], env, async () => Response.json({ ok: false, description: env.BOT_TOKEN + env.WEBHOOK_SECRET }, { status: 400 })), error => {
      assert.ok(!error.message.includes(env.BOT_TOKEN));
      assert.ok(!error.message.includes(env.WEBHOOK_SECRET));
      return /HTTP 400/.test(error.message);
    });
  });
  await test('网络异常不输出可能包含 Token 的原异常', async () => {
    await assert.rejects(main(['info'], env, async () => { throw new Error(env.BOT_TOKEN); }), error => !error.message.includes(env.BOT_TOKEN));
  });
  await test('诊断输出去除 Webhook 地址和错误正文，拒绝无效 JSON', async () => {
    const result = await main(['info'], env, async () => Response.json({ ok: true, result: {
      url: 'https://worker.example/?secret=TEST_ONLY', last_error_message: env.BOT_TOKEN, pending_update_count: 7, allowed_updates: ['edited_message'],
    } }));
    assert.equal(result.configured, true);
    assert.equal(result.pending_update_count, 7);
    assert.equal(result.has_error, true);
    assert.ok(!JSON.stringify(result).includes('TEST_ONLY'));
    await assert.rejects(main(['info'], env, async () => new Response('broken')), /无效响应/);
  });
  console.log(`${count} offline checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
