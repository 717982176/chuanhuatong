import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Real workerd and SQLite Durable Object; all outgoing HTTP is intercepted.
const requests = [];
let messageId = 100;
const runtime = new Miniflare(convertV4MiniflareOptions({
  name: 'chuanhuatong-smoke',
  modules: true,
  scriptPath: fileURLToPath(new URL('../dist/chuanhuatong.js', import.meta.url)),
  compatibilityDate: '2026-10-04',
  kvNamespaces: ['BOT_KV'],
  durableObjects: { BOT_STATE: { className: 'BotCoordinator', useSQLite: true } },
  bindings: {
    BOT_TOKEN: 'TEST_ONLY', MY_ADMIN_ID: '1', WEBHOOK_SECRET: 'TEST_ONLY',
    TURNSTILE_SITE_KEY: 'TEST_ONLY', TURNSTILE_SECRET: 'TEST_ONLY',
  },
  outboundService: async request => {
    const url = new URL(request.url);
    const body = await request.json();
    requests.push({ method: url.pathname.split('/').at(-1), body });
    return Response.json({ ok: true, result: { message_id: ++messageId, first_name: 'Test Admin' } });
  },
}));
let count = 0;
async function test(name, run) { await run(); count++; console.log('PASS ' + name); }
try {
  await runtime.ready;
  await test('真实 Worker GET 入口和验证页面可用', async () => {
    const root = await runtime.dispatchFetch('https://worker.example/');
    assert.equal(root.status, 200);
    assert.equal(await root.text(), 'OK');
    const verify = await runtime.dispatchFetch('https://worker.example/verify');
    assert.equal(verify.status, 200);
    assert.match(verify.headers.get('content-type'), /html/);
    assert.match(await verify.text(), /turnstile/);
  });
  await test('Webhook 缺少或错误 Secret 在访问协调器前被拒绝', async () => {
    for (const headers of [{}, { 'X-Telegram-Bot-Api-Secret-Token': 'WRONG' }]) {
      const response = await runtime.dispatchFetch('https://worker.example/', { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, 403);
    }
    assert.equal(requests.length, 0);
  });
  await test('伪造 Mini App 签名在真实协调器内被拒绝', async () => {
    const response = await runtime.dispatchFetch('https://worker.example/verify-submit', {
      method: 'POST', body: new URLSearchParams({ 'cf-turnstile-response': 'TEST_ONLY', initData: 'user=%7B%22id%22%3A2%7D&hash=bad' }),
    });
    assert.equal(response.status, 403);
    assert.equal(requests.length, 0);
  });
  await test('管理员菜单在真实 SQLite 状态中完成，重复更新不会重发', async () => {
    const body = JSON.stringify({ update_id: 1001, message: { message_id: 1, from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '/admin' } });
    const init = { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'TEST_ONLY', 'Content-Type': 'application/json' }, body };
    const first = await runtime.dispatchFetch('https://worker.example/', init);
    assert.equal(first.status, 200);
    const menus = () => requests.filter(request => request.method === 'sendMessage' && request.body.reply_markup);
    assert.equal(menus().length, 1);
    const second = await runtime.dispatchFetch('https://worker.example/', init);
    assert.equal(second.status, 200);
    assert.equal(menus().length, 1);
  });
  console.log(`${count} workerd smoke cases passed (no live Telegram requests)`);
} finally {
  await runtime.dispose();
}
