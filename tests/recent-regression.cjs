const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const after = fs.readFileSync(process.argv[2] || require('node:path').resolve(__dirname, '../chuanhuatong.js'), 'utf8');
const config = {adminId:'1', apiUrl:'https://example.invalid/', botToken:'TEST_SECRET_TOKEN'};
let requests = [], mode = 'ok';
function makeContext(source) {
  const context = vm.createContext({URL, Response, console:{log(){},warn(){},error(){}}, setTimeout,
    fetch:async (url, options) => {
      const method = url.split('/').pop(), payload = JSON.parse(options.body);
      requests.push({method,payload});
      if (mode === 'network' && method === 'editMessageText') throw new Error('network failure');
      let result = {ok:true,result:{message_id:99}};
      if (method === 'editMessageText' || mode === 'bothFail') {
        if (mode === 'notEditable' || mode === 'bothFail') result = {ok:false,error_code:400,description:"Bad Request: message can't be edited"};
        if (mode === 'notFound') result = {ok:false,error_code:400,description:'Bad Request: message to edit not found'};
        if (mode === 'unchanged') result = {ok:false,error_code:400,description:'Bad Request: message is not modified'};
        if (mode === 'invalid') result = {ok:false,error_code:400,description:'Bad Request: BUTTON_DATA_INVALID TEST_SECRET_TOKEN'};
        if (mode === 'rate') result = {ok:false,error_code:429,description:'Too Many Requests'};
      }
      return Response.json(result,{status:result.ok?200:result.error_code});
    }});
  vm.runInContext(source.replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }').replace('export class BotCoordinator', 'class BotCoordinator').replace('export default {','const worker = {'),context);
  return context;
}
const current = makeContext(after);
function storage(records) {
  const data = new Map(records.map(([id, raw])=>['recent_'+id,raw]));
  data.set('ui_list_style_1','plain');
  return {data, get:async key=>data.get(key)||null,
    list:async ({prefix})=>({keys:[...data.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true}),
    put:async (key,value)=>data.set(key,value), delete:async key=>data.delete(key)};
}
const query = {id:'q',from:{id:1},data:'recent',message:{message_id:4}};
let count=0;
async function test(name,run) { mode='ok'; requests=[]; await run(); count++; console.log('PASS '+name); }
(async()=>{
  await test('非法时间记录不影响最近访客加载',async()=>{
    const kv = storage([['2',JSON.stringify({id:'2',firstName:'访客',updatedAt:'bad date'})]]);
    await current.handleCallback(query,{BOT_KV:kv},config);
    assert.match(requests.find(r=>r.method==='editMessageText').payload.text,/还没有近 30 天/);assert.ok(kv.data.has('recent_2'));
  });
  await test('忽略 null 和损坏的历史记录并保留原数据',async()=>{
    const kv=storage([['2','null'],['3','[1,2]'],['4','{broken'],['5',JSON.stringify({id:5,firstName:'正常访客',updatedAt:Date.now()})]]);
    const result=await current.buildRecentUsersText(kv);
    assert.match(result.text,/正常访客/);
    assert.equal(kv.data.size,5);
  });
  await test('字符串毫秒和 ISO 日期仍能显示时间',async()=>{
    const result=await current.buildRecentUsersText(storage([
      ['2',JSON.stringify({id:'2',updatedAt:String(Date.now())})],
      ['3',JSON.stringify({id:'3',updatedAt:new Date().toISOString()})]
    ]));
    assert.ok(!result.text.includes('未知时间'));
  });
  await test('空访客列表正常显示并保留返回菜单',async()=>{
    await current.handleCallback(query,{BOT_KV:storage([])},config);
    const p=requests.find(r=>r.method==='editMessageText').payload;
    assert.match(p.text,/还没有/);
    assert.equal(p.reply_markup.inline_keyboard.at(-1)[0].callback_data,'menu_main');
  });
  for(const reason of ['notEditable','notFound']) {
    await test(reason+'：旧菜单不能编辑时新发访客列表',async()=>{
      mode=reason;
      await current.handleCallback(query,{BOT_KV:storage([['2',JSON.stringify({id:'2',firstName:'访客',updatedAt:Date.now()})]])},config);
      assert.deepEqual(requests.map(r=>r.method),['answerCallbackQuery','editMessageText','sendMessage']);
      assert.match(requests[2].payload.text,/最近访客/);
      assert.ok(requests[2].payload.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='focus:2'));
    });
  }
  await test('同一列表重复点击不产生报错或重复消息',async()=>{
    mode='unchanged';
    const result=await current.editHtmlMessage('1',4,'menu',config);
    assert.equal(result.ok,true);
    assert.equal(requests.length,1);
  });
  await test('Telegram 失败报告真实错误并隐藏密钥',async()=>{
    mode='invalid';
    await assert.rejects(current.editHtmlMessage('1',4,'menu',config),error=>error.message.includes('BUTTON_DATA_INVALID')&&!error.message.includes(config.botToken));
  });
  await test('429 不重复发送',async()=>{
    mode='rate';
    await assert.rejects(current.editHtmlMessage('1',4,'menu',config),/Telegram 429/);
    assert.equal(requests.length,1);
  });
  await test('网络异常不重复发送',async()=>{
    mode='network';
    await assert.rejects(current.editHtmlMessage('1',4,'menu',config),/network failure/);
    assert.equal(requests.length,1);
  });
  await test('编辑和新发均失败会报告错误，最多两次',async()=>{
    mode='bothFail';
    await assert.rejects(current.editHtmlMessage('1',4,'menu',config),/Telegram 400/);
    assert.equal(requests.length,2);
  });
  await test('授权检查保留：非管理员点击不读取访客列表',async()=>{
    await current.handleCallback({...query,from:{id:2}},{BOT_KV:{list:async()=>{throw new Error('must not read')}}},config);
    assert.deepEqual(requests.map(r=>r.method),['answerCallbackQuery']);
  });
  console.log(`${count} offline checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1});
