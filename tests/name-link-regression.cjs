const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.argv[2] || require('node:path').resolve(__dirname, '../chuanhuatong.js'),'utf8');
const fancy='𝖳𝖾𝗌𝗍 𝖠𝖻𝖼',config={adminId:'1',apiUrl:'https://example.invalid/'};
const requests=[];
const context=vm.createContext({URL,Response,console,setTimeout,
  fetch:async(url,options)=>{
    requests.push({method:url.split('/').pop(),payload:JSON.parse(options.body)});
    return Response.json({ok:true,result:{message_id:99,first_name:fancy,username:'test_abc'}});
  }});
vm.runInContext(source.replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }').replace('export class BotCoordinator', 'class BotCoordinator').replace('export default {','const worker = {'),context);
function kv(username='test_abc',count=1) {
  const values=new Map([['cache_admin_name_1','管理员'],['active_admin_1',JSON.stringify({userId:'2',name:fancy,updatedAt:Date.now()})]]);
  for(let n=2;n<count+2;n++) {
    values.set('recent_'+n,JSON.stringify({id:String(n),firstName:fancy,username,updatedAt:Date.now()-n}));
    values.set('auth_'+n,'true');
  }
  return {put:async(key,value)=>values.set(key,value),get:async key=>values.get(key)||null,list:async({prefix})=>({keys:[...values.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true})};
}
let passed=0;
async function test(name,run){requests.length=0;await run();passed++;console.log('PASS '+name);}
(async()=>{
  await test('昵称仍显示原文字，链接只存在于 href 中，特殊字符正确转义',async()=>{
    const html=context.formatContactNameHtml(fancy,'test_abc');
    assert.equal(html,'<a href="https://t.me/test_abc">'+fancy+'</a>');
    assert.equal(html.replace(/<[^>]*>/g,''),fancy);
    assert.equal(context.formatContactNameHtml('<x>&😀','test_abc'),'<a href="https://t.me/test_abc">&lt;x&gt;&amp;😀</a>');
    for(const username of ['',null,'bad/name','bad"name']) {
      assert.equal(context.formatContactNameHtml(fancy,username),fancy);
    }
  });
  await test('主控制台和切换菜单的当前联系人昵称可点击',async()=>{
    const storage=kv(),expected='<a href="https://t.me/test_abc">'+fancy+'</a>';
    assert.ok((await context.buildAdminMenuText({BOT_KV:storage},config)).includes(expected));
    assert.ok((await context.buildSwitchDialog(storage,'1')).text.includes(expected));
  });
  await test('已授权、最近访客、访客通知昵称均为主页链接；切换按钮保留原动作',async()=>{
    const storage=kv();
    const recent=await context.buildRecentUsersText(storage),authed=await context.buildAuthedUsersText(storage,'1',config);
    for(const list of [recent,authed]) {
      assert.ok(list.text.includes('<a href="https://t.me/test_abc">'));
      assert.ok(list.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='focus:2'&&!b.url));
    }
    assert.ok(context.buildVisitorNoticeHtml('2',fancy,'test_abc').includes('<a href="https://t.me/test_abc">'+fancy+'</a>'));
    assert.equal(context.buildNoticeButtons('2',fancy,'test_abc')[0][0].callback_data,'nfocus:2');
  });
  await test('无公开用户名时通过正文昵称 ID 提及打开主页，按钮仍用于切换',async()=>{
    const html=await context.buildAdminMenuText({BOT_KV:kv('')},config);
    assert.ok(html.includes(fancy));
    assert.ok(html.includes('<a href="tg://user?id=2">'+fancy+'</a>'));
    assert.ok(!context.buildNoticeButtons('2',fancy,'').flat().some(b=>b.url));
  });
  await test('长列表截断仍有成对 HTML 标签，禁用网址预览避免显示网址卡片',async()=>{
    const list=await context.buildRecentUsersText(kv('a'.repeat(64),60),0);
    await context.editHtmlMessage('1',7,list.text,config,{reply_markup:list.replyMarkup});
    const payload=requests.at(-1).payload;
    assert.ok(payload.text.length<=4000);
    assert.ok(payload.text.isWellFormed());
    for(const tag of ['a','code']) assert.equal((payload.text.match(new RegExp('<'+tag+'(?:>| )','g'))||[]).length,(payload.text.match(new RegExp('</'+tag+'>','g'))||[]).length);
    assert.equal(payload.link_preview_options.is_disabled,true);
  });
  console.log(`${passed} offline checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1});
