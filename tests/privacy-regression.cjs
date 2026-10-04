const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[2] || require('node:path').resolve(__dirname, '../chuanhuatong.js'), 'utf8');
const config = { adminId: '1', apiUrl: 'https://example.invalid/bot/'};
let calls = [], responseMode = 'normal';
const context = vm.createContext({
  Response, URL, console, setTimeout,
  fetch: async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({method: url.split('/').pop(), payload});
    if (responseMode === 'network') throw new Error('network failure');
    const privateButton = payload.reply_markup?.inline_keyboard?.flat().some(b => /^tg:\/\/user\?/i.test(b.url || ''));
    let body = {ok: true, result: {message_id: 99}};
    if (responseMode === 'unrelated') body = {ok:false, error_code:400, description:'Bad Request: BUTTON_DATA_INVALID'};
    else if (responseMode === 'rate') body = {ok:false, error_code:429, description:'Too Many Requests'};
    else if (privateButton || responseMode === 'alwaysPrivacy') body = {ok:false, error_code:400, description:'Bad Request: BUTTON_USER_PRIVACY_RESTRICTED'};
    return Response.json(body, {status: body.ok ? 200 : body.error_code});
  }
});
vm.runInContext(source.replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }').replace('export class BotCoordinator', 'class BotCoordinator').replace('export default {', 'const worker = {'), context);
function kv(username = '') {
  const values = new Map([
    ['auth_2', 'true'],
    ['cache_admin_name_1', '管理员'],
    ['active_admin_1', JSON.stringify({userId:'2', name:'访客',updatedAt:Date.now()})],
    ['recent_2', JSON.stringify({id:'2', firstName:'访客', username, updatedAt:Date.now()})]
  ]);
  return {values, get:async key => values.get(key) || null,
    put:async (key, value) => values.set(key, value), delete:async key => values.delete(key),
    list:async ({prefix}) => ({keys:[...values.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})), list_complete:true})};
}
function reset(mode = 'normal') { calls = []; responseMode = mode; }
let passed = 0;
async function test(name, run) { reset(); await run(); passed++; console.log('PASS ' + name); }
const privateMarkup = {inline_keyboard:[
  [{text:'私人主页', url:'tg://user?id=2'}, {text:'切换',callback_data:'nfocus:2'}],
  [{text:'公开主页',url:'https://t.me/example_user'}],
  [{text:'网页验证',web_app:{url:'https://example.invalid/verify'}}],
  [{text:'另一私人主页',url:'tg://user?id=3'}]
]};
(async () => {
  await test('管理员 /admin：无用户名联系人仍可加载控制台，保留当前会话', async () => {
    const storage = kv();
    await context.handleAdminMessage({from:{id:1}}, '/admin', {BOT_KV:storage}, config);
    assert.equal(calls.length, 1);
    const p = calls[0].payload;
    assert.match(p.text, /管理员控制台/);
    assert.match(p.text, /<code>2<\/code>/);
    const callbacks = p.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
    for (const action of ['status', 'authed', 'blacklist', 'recent', 'switch_menu', 'clear', 'contact_search', 'contact_note', 'session_settings', 'diagnostics']) assert.ok(callbacks.includes(action));
    assert.ok(p.reply_markup.inline_keyboard.flat().every(b => !/^tg:\/\/user\?/.test(b.url || '')));
    assert.ok(storage.values.has('active_admin_1'));
  });
  await test('控制台使用公开用户名主页链接', async () => {
    assert.equal((await context.sendAdminMenu('1', {BOT_KV:kv('example_user')}, config)).ok, true);
    assert.equal(calls[0].payload.reply_markup.inline_keyboard.at(-1)[0].url,'https://t.me/example_user');
  });
  await test('编辑现有控制台仍成功', async () => {
    assert.equal((await context.renderAdminMenu('1', {BOT_KV:kv()}, config, 7)).ok, true);
    assert.equal(calls[0].method,'editMessageText');
    assert.equal(calls[0].payload.message_id,7);
  });
  await test('验证成功通知无用户名时仍发送，建立回复映射', async () => {
    const storage = kv();
    await context.completeUserVerification('3',{first_name:'新访客'}, {BOT_KV:storage}, config);
    const notice = calls.find(c=>c.payload.text?.includes('新访客接入'));
    assert.equal(notice.payload.reply_markup.inline_keyboard[0].length,1);
    assert.equal(notice.payload.reply_markup.inline_keyboard[0][0].callback_data,'nfocus:3');
    assert.equal(storage.values.get('msg_99'),'3');
    assert.equal(storage.values.get('auth_3'),'true');
  });
  await test('验证成功通知使用公开主页', async () => {
    await context.completeUserVerification('3',{first_name:'新访客', username:'example_user'}, {BOT_KV:kv()}, config);
    assert.equal(calls.find(c=>c.payload.text?.includes('新访客接入')).payload.reply_markup.inline_keyboard[0][1].url,'https://t.me/example_user');
  });
  await test('切换对话的正文昵称使用 ID 提及，按钮保留切换动作', async () => {
    const dialog = await context.buildSwitchDialog(kv(), '1');
    assert.ok(dialog.text.includes('<a href="tg://user?id=2">访客</a>'));
    assert.match(dialog.text, /<code>2<\/code>/);
    assert.ok(dialog.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='focus:2'));
  });
  for (const method of ['sendMessage', 'editMessageText']) {
    await test(method + ' 隐私拒绝后重试一次，保留回调/公开主页/验证按钮', async () => {
      const result = await context.safeJson(await context.callApi(method, {chat_id:'1',text:'menu',reply_markup:privateMarkup},config));
      assert.equal(result.ok,true);
      assert.equal(calls.length,2);
      const buttons = calls[1].payload.reply_markup.inline_keyboard.flat();
      assert.equal(buttons.length,3);
      assert.equal(buttons[0].callback_data,'nfocus:2');
      assert.equal(buttons[1].url,'https://t.me/example_user');
      assert.ok(buttons[2].web_app);
      assert.equal(privateMarkup.inline_keyboard.length,4);
    });
  }
  for (const mode of ['unrelated','rate','alwaysPrivacy']) {
    await test(mode + ' 不进行多余重试', async () => {
      responseMode = mode;
      const result = await context.safeJson(await context.callApi('sendMessage',{chat_id:'1',text:'menu',reply_markup:privateMarkup},config));
      assert.equal(result.ok,false);
      assert.equal(calls.length, mode === 'alwaysPrivacy' ? 2 : 1);
    });
  }
  await test('网络异常不重发消息', async () => {
    responseMode = 'network';
    await assert.rejects(context.callApi('sendMessage',{reply_markup:privateMarkup},config), /network failure/);
    assert.equal(calls.length,1);
  });
  await test('不包含受限按钮时保留原错误响应', async () => {
    responseMode = 'alwaysPrivacy';
    const result = await context.safeJson(await context.callApi('sendMessage',{reply_markup:{inline_keyboard:[[{text:'按钮',callback_data:'status'}]]}},config));
    assert.equal(result.error_code,400);
    assert.equal(calls.length,1);
  });
  console.log(`${passed} offline regression checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
