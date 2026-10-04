const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const after = fs.readFileSync(process.argv[2] || require('node:path').resolve(__dirname, '../chuanhuatong.js'), 'utf8');
const config = {adminId:'1',apiUrl:'https://example.invalid/'};
let requests=[];
function allTextValid(value) {
  if (typeof value==='string') return value.isWellFormed();
  if (value && typeof value==='object') return Object.values(value).every(allTextValid);
  return true;
}
function runtime(source) {
  const context = vm.createContext({Response,URL,console,setTimeout,
    fetch:async(url,options)=>{
      const payload=JSON.parse(options.body);
      requests.push({method:url.split('/').pop(),payload,headers:options.headers});
      return allTextValid(payload)
        ? Response.json({ok:true,result:{message_id:99}})
        : Response.json({ok:false,error_code:400,description:'Bad Request: text must be encoded in UTF-8'},{status:400});
    }});
  vm.runInContext(source.replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }').replace('export class BotCoordinator', 'class BotCoordinator').replace('export default {','const worker = {'),context);
  return context;
}
const current=runtime(after);
function kv(entries) {
  const values=new Map(entries);
  return {values,get:async key=>values.get(key)||null,
    list:async({prefix})=>({keys:[...values.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true}),
    put:async(key,value)=>values.set(key,value),delete:async key=>values.delete(key)};
}
const profile=(id,name,time)=>['recent_'+id,JSON.stringify({id,firstName:name,updatedAt:time})];
let passed=0;
async function test(name,run) {requests=[];await run();passed++;console.log('PASS '+name);}
(async()=>{
  await test('含 emoji 的昵称截断和访客菜单保持有效 Unicode',async()=>{
    const storage=kv([profile('2','abcde😀昵称',Date.now())]);
    const query={id:'q',from:{id:1},data:'recent',message:{message_id:7}};
    requests=[];
    await current.handleCallback(query,{BOT_KV:storage},config);
    const request=requests.find(r=>r.method==='editMessageText');
    assert.ok(allTextValid(request.payload));
    assert.match(request.payload.reply_markup.inline_keyboard.flat().map(b=>b.text).join('|'),/abcde😀昵称/);
    assert.ok(request.payload.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='focus:2'));
  });
  await test('中英文、emoji、旗帜、变体和组合字符在各截断位置均可编码',async()=>{
    const samples=['abcde😀昵称','abcdefg🦊用户','中文𠮷测试😀','👩🏽‍💻abc🧑‍🚀','🇨🇳🇯🇵🇬🇧abc','e\u0301中文','\uD800x\uDC00'];
    for(const value of samples) for(let n=0;n<14;n++) assert.ok(current.truncateText(value,n).isWellFormed());
    assert.equal(current.truncateText('😀',1),'😀');
    assert.equal(current.truncateText('abcdef',3),'abc…');
  });
  await test('长消息在 surrogate 边界截断仍保持有效字符且不超限',async()=>{
    for(const n of [3977,3978,3979,3980,3998,3999,4000]) {
      const value='a'.repeat(n)+'😀'+'b'.repeat(100);
      const result=current.clampText(value);
      assert.ok(result.isWellFormed());
      assert.ok(result.length<=4000);
    }
  });
  await test('Telegram 请求入口处理文字、标题和嵌套按钮，保持原参数不变',async()=>{
    const payload={chat_id:1,text:'a\uD800',caption:'b\uDC00',disable_notification:true,
      reply_markup:{inline_keyboard:[[{text:'c\uDFFF',callback_data:'focus:2'}]]}};
    const result=await current.safeJson(await current.callApi('sendMessage',payload,config));
    assert.equal(result.ok,true);
    assert.ok(allTextValid(requests[0].payload));
    assert.equal(requests[0].payload.disable_notification,true);
    assert.equal(requests[0].payload.chat_id,1);
    assert.equal(requests[0].payload.reply_markup.inline_keyboard[0][0].callback_data,'focus:2');
    assert.equal(payload.text.isWellFormed(),false);
    assert.match(requests[0].headers['Content-Type'],/charset=utf-8/);
  });
  await test('HTML/Markdown 转义保留合法 emoji 并处理坏字符',async()=>{
    assert.equal(current.escapeHtml('<😀>'),'&lt;😀&gt;');
    assert.ok(current.escapeHtml('\uD800').isWellFormed());
    assert.ok(current.escapeMarkdownV2('😀_\uD800').isWellFormed());
  });
  await test('不支持 toWellFormed 的运行时也能安全替换坏字符',async()=>{
    const fallback=runtime(after);
    vm.runInContext('String.prototype.toWellFormed = undefined;',fallback);
    for(const value of ['abc','😀','a\uD800b','\uDC00a','\uD800\uD800\uDC00']) {
      assert.equal(fallback.toSafeUnicode(value),value.toWellFormed());
    }
  });
  await test('切换会话仅显示已授权且未被封禁的访客',async()=>{
    const storage=kv([
      profile('2','待验证',Date.now()), profile('3','已通过',Date.now()-2000),profile('4','已封禁',Date.now()-1000),
      ['auth_3','true'],['auth_4','true'],['lock_4',String(Date.now()+60000)],['recent_5','null']
    ]);
    const menu=await current.buildSwitchDialog(storage,'1');
    const targets=menu.replyMarkup.inline_keyboard.flat().filter(b=>b.callback_data.startsWith('focus:')).map(b=>b.callback_data);
    assert.deepEqual(Array.from(targets),['focus:3']);
    assert.equal(storage.values.size,7);
  });
  await test('先筛选授权再取数量上限，待验证访客不会挤掉已通过访客',async()=>{
    const storage=kv([profile('2','待验证A',Date.now()),profile('3','待验证B',Date.now()-1000),profile('4','已通过',Date.now()-2000),['auth_4','true']]);
    const users=await current.getRecentFocusUsers(storage,1);
    assert.equal(users.length,1);
    assert.equal(users[0].id,'4');
  });
  await test('已通过访客按最近互动排序，已过期封禁不再排除',async()=>{
    const storage=kv([profile('2','旧访客',Date.now()-2000),profile('3','新访客',Date.now()-1000),['auth_2','true'],['auth_3','true'],['lock_3',String(Date.now()-60000)]]);
    const users=await current.getRecentFocusUsers(storage);
    assert.deepEqual(Array.from(users,u=>u.id),['3','2']);
  });
  await test('无已通过访客时提示空列表并保留返回菜单',async()=>{
    const menu=await current.buildSwitchDialog(kv([profile('2','待验证',100)]),'1');
    assert.match(menu.text,/暂无可切换/);
    assert.ok(menu.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='menu_main'));
    assert.ok(!menu.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data.startsWith('focus:')));
  });
  console.log(`${passed} offline checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1});
