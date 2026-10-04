const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2] || require('node:path').resolve(__dirname, '../chuanhuatong.js'), 'utf8');
const config = { adminId: '1', apiUrl: 'https://example.invalid/' };
let requests = [], mode = 'ok';
const context = vm.createContext({ Response, URL, console, setTimeout,
  fetch: async (url, options) => {
    const method = url.split('/').pop(), payload = JSON.parse(options.body);
    requests.push({ method, payload });
    const restricted = (mode === 'privacy' || mode === 'alwaysPrivacy') && /tg:\/\/user/.test(payload.rich_message?.html || payload.text || payload.caption || '');
    if (restricted || mode === 'alwaysPrivacy') return Response.json({ ok: false, error_code: 400, description: 'Bad Request: USER_PRIVACY_RESTRICTED' }, { status: 400 });
    if (mode === 'unrelated') return Response.json({ ok: false, error_code: 400, description: 'Bad Request: cannot parse entities' }, { status: 400 });
    return Response.json({ ok: true, result: method === 'getChat' ? { first_name: '无用户名😀', id: payload.chat_id } : { message_id: 99 } });
  } });
vm.runInContext(source.replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }').replace('export class BotCoordinator', 'class BotCoordinator').replace('export default {', 'const worker = {'), context);
function storage(count = 23, authorized = true) {
  const values = new Map();
  for (let i = 2; i < count + 2; i++) {
    values.set('recent_' + i, JSON.stringify({ id: String(i), firstName: '昵称😀' + i, username: '', updatedAt: Date.now() - i * 1000 }));
    if (authorized) values.set('auth_' + i, 'true');
  }
  return { values, get: async key => values.get(key) || null, put: async (key, value) => values.set(key, value), delete: async key => values.delete(key),
    list: async ({ prefix }) => ({ keys: [...values.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }) };
}
const buttons = result => Array.from(result.replyMarkup.inline_keyboard.flat());
const ids = result => buttons(result).filter(b => b.callback_data?.startsWith('focus:')).map(b => b.callback_data.slice(6));
const query = data => ({ id: 'query', from: { id: 1 }, data, message: { message_id: 8 } });
const latest = () => requests.findLast(r => r.method === 'editMessageText').payload;
let passed = 0;
async function test(name, run) { requests = []; mode = 'ok'; await run(); passed++; console.log('PASS ' + name); }
(async () => {
  for (const kind of ['recent', 'authed']) {
    const build = (kv, page) => kind === 'recent' ? context.buildRecentUsersText(kv, page) : context.buildAuthedUsersText(kv, '1', config, page);
    await test(kind + ' 23人分为10/10/3，无重复或遗漏，昵称可点击', async () => {
      const kv = storage(), collected = [];
      for (let page = 0; page < 3; page++) {
        const result = await build(kv, page), current = ids(result);
        assert.equal(current.length, page === 2 ? 3 : 10);
        assert.equal((result.text.match(/🆔 <code>/g) || []).length, current.length);
        for (const id of current) assert.ok(result.text.includes('href="tg://user?id=' + id + '"'));
        assert.ok(buttons(result).some(b => b.text === `${page + 1} / 3`));
        assert.equal(buttons(result).some(b => b.callback_data === `${kind}_page:${page - 1}`), page > 0);
        assert.equal(buttons(result).some(b => b.callback_data === `${kind}_page:${page + 1}`), page < 2);
        for (const b of buttons(result)) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
        collected.push(...current);
      }
      assert.deepEqual(collected, Array.from({ length: 23 }, (_, i) => String(i + 2)));
      assert.equal([...kv.values.keys()].filter(k=>k.startsWith('auth_')||k.startsWith('recent_')).length,46);
      assert.equal([...kv.values.keys()].filter(k=>k.startsWith('profile_')).length,kind==='authed'?23:0);
      for(let id=2;id<25;id++){assert.equal(kv.values.get('auth_'+id),'true');assert.equal(JSON.parse(kv.values.get('recent_'+id)).firstName,'昵称😀'+id);}
    });
    await test(kind + ' 单页、空列表、负数和过大页码正确处理', async () => {
      for (const page of [-1, 0, Infinity, 'bad', 999999]) {
        const result = await build(storage(10), page);
        assert.equal(ids(result).length, 10);
        assert.ok(buttons(result).some(b => b.text === '1 / 1'));
        assert.ok(!buttons(result).some(b => b.callback_data?.startsWith(kind + '_page:')));
      }
      assert.equal(ids(await build(storage(), 999999)).length, 3);
      const empty = await build(storage(0), 999999);
      assert.equal(ids(empty).length, 0);
      assert.equal(buttons(empty).at(-1).callback_data, 'menu_main');
    });
    await test(kind + ' 下一页回调编辑原消息，保留会话清除和返回菜单', async () => {
      await context.handleCallback(query(kind + '_page:1'), { BOT_KV: storage() }, config);
      const payload = latest();
      assert.equal(payload.message_id, 8);
      assert.equal(payload.parse_mode, 'HTML');
      assert.ok(!payload.reply_markup.inline_keyboard.flat().some(b=>b.copy_text));
      assert.ok(payload.text.includes("<code>"));
      assert.equal(payload.rich_message, undefined);
      assert.equal(requests[0].method, 'answerCallbackQuery');
      assert.ok(payload.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'focus:12'));
      assert.ok(!payload.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'focus:2'));
      for (const action of ['focus_clear', 'menu_main']) assert.ok(payload.reply_markup.inline_keyboard.flat().some(b => b.callback_data === action));
    });
  }
  await test('旧 recent_all 和原入口按钮兼容第一分页', async () => {
    for (const data of ['recent_all', 'recent', 'authed']) {
      requests = [];
      await context.handleCallback(query(data), { BOT_KV: storage() }, config);
      assert.equal(latest().reply_markup.inline_keyboard.flat().filter(b => b.callback_data?.startsWith('focus:')).length, 10);
      assert.ok(latest().reply_markup.inline_keyboard.flat().some(b => b.text === '1 / 3'));
    }
  });
  await test('未验证清理后末页回退，全部清理后显示空列表', async () => {
    const kv = storage(23, false);
    for (let i = 2; i < 14; i++) kv.values.set('auth_' + i, 'true');
    await context.handleCallback(query('recent_clear_unverified:2'), { BOT_KV: kv }, config);
    assert.ok(latest().reply_markup.inline_keyboard.flat().some(b => b.text === '2 / 2'));
    assert.equal(latest().reply_markup.inline_keyboard.flat().filter(b => b.callback_data?.startsWith('focus:')).length, 2);
    assert.match(requests[0].payload.text, /11/);
    requests = [];
    await context.handleCallback(query('recent_clear_unverified:2'), { BOT_KV: storage(23, false) }, config);
    assert.match((latest().rich_message?.html || latest().text), /还没有/);
  });
  await test('授权清理保留原页，末页删除后自动回退', async () => {
    const kv = storage(23);
    for (let i = 14; i < 25; i++) kv.values.delete('recent_' + i);
    const list = await context.buildAuthedUsersText(kv, '1', config, 2);
    assert.ok(buttons(list).some(b => b.callback_data === 'authed_clear_expired:2'));
    requests = [];
    await context.handleCallback(query('authed_clear_expired:2'), { BOT_KV: kv }, config);
    assert.ok(latest().reply_markup.inline_keyboard.flat().some(b => b.text === '2 / 2'));
    assert.match(requests[0].payload.text, /11/);
    requests = [];
    const unchanged = storage(23);
    await context.handleCallback(query('authed_clear_expired:1'), { BOT_KV: unchanged }, config);
    assert.ok(latest().reply_markup.inline_keyboard.flat().some(b => b.text === '2 / 3'));
  });
  await test('资料查询仅针对当前页的最多10人，无用户名资料仍生成昵称提及', async () => {
    const kv = storage(23);
    for (const key of [...kv.values.keys()]) if (key.startsWith('recent_')) kv.values.delete(key);
    const list = await context.buildAuthedUsersText(kv, '1', config, 1);
    assert.equal(requests.filter(r => r.method === 'getChat').length, 10);
    assert.equal(ids(list).length, 10);
    assert.match(list.text, /<a href="tg:\/\/user\?id=\d+">无用户名😀<\/a>/);
  });
  await test('页码按钮仅应答；非管理员翻页不读取数据', async () => {
    const blocked = { get() { throw new Error('unauthorized read'); }, list() { throw new Error('unauthorized read'); } };
    await context.handleCallback(query('list_page_info'), { BOT_KV: blocked }, config);
    await context.handleCallback({ ...query('recent_page:1'), from: { id: 99 } }, { BOT_KV: blocked }, config);
    assert.deepEqual(requests.map(r => r.method), ['answerCallbackQuery', 'answerCallbackQuery']);
  });
  await test('多余切换说明移除，当前联系人无用户名也可点击', async () => {
    const kv = storage();
    kv.values.set('active_admin_1', JSON.stringify({ userId: '2', name: 'Test Abc', updatedAt: Date.now() }));
    kv.values.set('cache_admin_name_1', '管理员');
    for (const text of [(await context.buildSwitchDialog(kv, '1')).text, await context.buildAdminMenuText({ BOT_KV: kv }, config)]) {
      assert.ok(text.includes('<a href="tg://user?id=2">Test Abc</a>'));
      assert.ok(!text.includes('点击菜单进入'));
      assert.ok(!text.includes('按最近沟通时间排序'));
    }
  });
  await test('昵称安全转义，优先公开用户名链接，不显示网址文字', async () => {
    const idLink = context.formatContactNameHtml('Test <Abc>&😀', '', '2');
    assert.equal(idLink, '<a href="tg://user?id=2">Test &lt;Abc&gt;&amp;😀</a>');
    assert.equal(context.formatContactNameHtml('Test Abc', 'test_abc', '2'), '<a href="https://t.me/test_abc">Test Abc</a>');
    assert.equal(context.formatContactNameHtml('测试', '', 'bad"id'), '测试');
  });
  for (const method of ['sendMessage', 'editMessageText', 'sendPhoto']) {
    await test(method + ' 正文昵称隐私拒绝时仅重试一次，保留公开链接及菜单', async () => {
      mode = 'privacy';
      const field = method === 'sendPhoto' ? 'caption' : 'text';
      const text = '<a href="tg://user?id=2">Test &amp; Abc</a> <a href="https://t.me/name">名字</a>';
      const payload = { chat_id: '1', [field]: text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '切换', callback_data: 'focus:2' }]] } };
      const result = await context.safeJson(await context.callApi(method, payload, config));
      assert.equal(result.ok, true);
      assert.equal(requests.length, 2);
      assert.equal(requests[1].payload[field], 'Test &amp; Abc <a href="https://t.me/name">名字</a>');
      assert.equal(requests[1].payload.reply_markup.inline_keyboard[0][0].callback_data, 'focus:2');
      assert.equal(payload[field], text);
    });
  }
  await test('没有键盘的昵称提及也可回退，其他错误不重试，无无限循环', async () => {
    const payload = { chat_id: '1', text: '<a href="tg://user?id=2">昵称</a>', parse_mode: 'HTML' };
    for (const failure of ['privacy', 'unrelated', 'alwaysPrivacy']) {
      requests = []; mode = failure;
      const result = await context.safeJson(await context.callApi('sendMessage', payload, config));
      assert.equal(requests.length, failure === 'unrelated' ? 1 : 2);
      assert.equal(result.ok, failure === 'privacy');
    }
  });
  console.log(`${passed} offline checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
