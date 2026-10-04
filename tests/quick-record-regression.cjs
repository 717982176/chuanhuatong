const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const source=fs.readFileSync(require('node:path').resolve(__dirname, '../chuanhuatong.js'),'utf8');
let clock=Date.now(),requests=[],mode='ok',release=null;
class Clock extends Date { static now(){return clock;} }
let apiHook=null,downloadBody='{}',messageCounter=1000;
const issuedCommandIds=new Set();
const runtime=vm.createContext({URL,URLSearchParams,Response,Request,TextEncoder,TextDecoder,Blob,FormData,AbortSignal,Date:Clock,crypto:crypto.webcrypto,AbortController,clearTimeout,
  setTimeout:(fn,ms)=>ms===500?(fn(),0):setTimeout(fn,ms),console:{warn(){},error(){},log(){}},
  fetch:async(url,options)=>{
    if(url.includes('/file/bot'))return new Response(downloadBody);
    const method=url.split('/').pop();
    if(method==='siteverify')return Response.json({success:mode!=='challengeFail'});
    let payload;if(options.body instanceof FormData){payload=Object.fromEntries(options.body);payload.documentText=await payload.document.text();}else payload=JSON.parse(options.body);requests.push({method,payload});
    if(apiHook){const result=await apiHook(method,payload,options);if(result)return result;}
    if(mode==='holdWelcome'&&(method==='sendPhoto'||payload.text?.includes('验证成功')))await new Promise(resolve=>{release=resolve;});
    if(mode==='welcomeFail'&&payload.chat_id==='2'&&payload.text?.includes('验证成功'))throw Error('welcome unavailable');
    if(mode==='networkFail'&&method==='forwardMessage')throw Error('temporary network failure');
    return Response.json({ok:true,result:{message_id:99,first_name:'访客😀'}});
  }});
vm.runInContext(source.replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }').replace('export class BotCoordinator','class BotCoordinator').replace('export default {','const worker = {'),runtime);
const clone=v=>v===undefined?undefined:structuredClone(v);
class Storage {
  constructor(){this.data=new Map();this.tail=Promise.resolve();this.alarm=null;}
  rawGet(k){if(Array.isArray(k))return new Map(k.filter(x=>this.data.has(x)).map(x=>[x,clone(this.data.get(x))]));return clone(this.data.get(k));}
  rawPut(k,v){if(typeof k==='string')this.data.set(k,clone(v));else for(const [name,value]of Object.entries(k))this.data.set(name,clone(value));}
  rawDelete(k){if(Array.isArray(k)){let n=0;for(const x of k)n+=this.data.delete(x);return n;}return this.data.delete(k);}
  enqueue(fn){const p=this.tail.then(fn);this.tail=p.then(()=>{},()=>{});return p;}
  get(k){return this.enqueue(()=>this.rawGet(k));}
  put(k,v){return this.enqueue(()=>this.rawPut(k,v));}
  delete(k){return this.enqueue(()=>this.rawDelete(k));}
  list({prefix='',startAfter,limit=1000}={}){return this.enqueue(()=>new Map([...this.data.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).filter(([k])=>k.startsWith(prefix)&&(!startAfter||k>startAfter)).slice(0,limit).map(([k,v])=>[k,clone(v)])));}
  transaction(fn){return this.enqueue(async()=>{const before=clone(this.data);try{return await fn({get:async k=>this.rawGet(k),put:async(k,v)=>{if(this.failNextTransactionPut){this.failNextTransactionPut=false;throw Error('transaction failed');}this.rawPut(k,v);},delete:async k=>this.rawDelete(k)});}catch(error){this.data=before;throw error;}});}
  getAlarm(){return this.enqueue(()=>this.alarm);}
  setAlarm(time){return this.enqueue(()=>{this.alarm=time;});}
}
function legacy(entries=[],metadata={}){
  const data=new Map(entries),writes=new Map(),operations=[];
  const kv={data,metadata,operations,failWrites:false,
    get:async key=>{operations.push({op:'get',key});if(Array.isArray(key))return new Map(key.map(k=>[k,data.get(k)??null]));return data.get(key)??null;},
    list:async({prefix='',cursor,limit=1000})=>{operations.push({op:'list',prefix});const names=[...data.keys()].sort().filter(k=>k.startsWith(prefix)&&(!cursor||k>cursor));const selected=names.slice(0,limit);return {keys:selected.map(name=>({name,...metadata[name]})),list_complete:names.length<=limit,cursor:names.length>limit?selected.at(-1):''};},
    put:async(key,value,options={})=>{operations.push({op:'put',key});if(kv.failWrites)throw Error('KV unavailable');if(writes.has(key)&&clock-writes.get(key)<1000)throw Error('same key write limit');writes.set(key,clock);data.set(key,value);metadata[key]={expiration:options.expiration,metadata:options.metadata};},
    delete:async key=>{operations.push({op:'delete',key});if(kv.failWrites)throw Error('KV unavailable');data.delete(key);delete metadata[key];}};
  return kv;
}
function env(kv){return {BOT_KV:kv,BOT_TOKEN:'TEST_TOKEN_PLACEHOLDER',MY_ADMIN_ID:'1',WEBHOOK_SECRET:'TEST_WEBHOOK_SECRET',TURNSTILE_SITE_KEY:'TEST_SITE_KEY',TURNSTILE_SECRET:'TEST_TURNSTILE_SECRET'};}
function instance(kv=legacy(),storage=new Storage()){
  const pending=[],bindings=env(kv),ctx={storage,waitUntil:p=>pending.push(p)};
  runtime.ctxArg=ctx;runtime.envArg=bindings;
  const bot=vm.runInContext('new BotCoordinator(ctxArg,envArg)',runtime);
  bindings.BOT_STATE={idFromName:name=>name,get:()=>bot};
  return {bot,kv,storage,pending,bindings,drain:async()=>{while(pending.length)await Promise.allSettled(pending.splice(0));}};
}
const cfg={adminId:'1',apiUrl:'https://example.invalid/'};
const webhook=(id=101,text='你好',user=2)=>new Request('https://bot.example/',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'TEST_WEBHOOK_SECRET'},body:JSON.stringify({update_id:id,message:{message_id:id,chat:{id:user,type:'private'},from:{id:user,first_name:'访客😀'},text}})});
function initData(user=2,time=clock/1000){
  const p=new URLSearchParams({auth_date:String(Math.floor(time)),user:JSON.stringify({id:user,first_name:'访客😀'})});
  const key=crypto.createHmac('sha256','WebAppData').update('TEST_TOKEN_PLACEHOLDER').digest();
  const signature=crypto.createHmac('sha256',key).update([...p].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex');
  p.set('hash',signature);return p.toString();
}
function verification(init=initData()) {return new Request('https://bot.example/verify-submit',{method:'POST',headers:{Accept:'application/json'},body:new URLSearchParams({initData:init,'cf-turnstile-response':'TEST_CHALLENGE_TOKEN'})});}
async function grant(test){return test.bot.fetch(verification());}
async function within(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('blocked by notification')),1000);})]);}finally{clearTimeout(timer);}}
let passed=0;
async function test(name,fn){clock=Date.now();requests=[];mode='ok';release=null;apiHook=null;issuedCommandIds.clear();await fn();passed++;console.log('PASS '+name);}

function update(user,mid,text='',extra={}) {
  if (/^\/(start|admin|help)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text)||(user===1&&text==='指令'))issuedCommandIds.add(`${user}:${mid}`);
  return new Request('https://bot.example/',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'TEST_WEBHOOK_SECRET'},body:JSON.stringify({update_id:10000+mid,message:{message_id:mid,chat:{id:user,type:'private'},from:{id:user,first_name:user===1?'管理员':'张三😀'},text,...extra}})});
}
const album=(user,group,mid,reply)=>update(user,mid,'',{media_group_id:group,photo:[{file_id:'TEST_PHOTO'}],...(reply?{reply_to_message:{message_id:reply}}:{})});
const rEnv=t=>({...t.bindings,BOT_KV:t.bot.store,__botRuntime:t.bot});
const rCfg=t=>{const c=runtime.getConfig(rEnv(t));c.waitUntil=p=>t.pending.push(p);return c;};
const batchCalls=()=>requests.filter(r=>['forwardMessages','copyMessages'].includes(r.method));
function batchResponses(){apiHook=async(method,payload)=>['forwardMessages','copyMessages'].includes(method)?Response.json({ok:true,result:payload.message_ids.map((_,i)=>({message_id:900+i}))}):null;}
async function mature(t){clock+=4000;await t.bot.alarm();await t.drain();}

let sequence=80000;
const callback=(data,user=1)=>new Request('https://bot.example/',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'TEST_WEBHOOK_SECRET'},body:JSON.stringify({update_id:sequence++,callback_query:{id:String(sequence),from:{id:user},data,message:{message_id:100,chat:{id:user,type:'private'}}}})});
const edited=(user,mid,text,editDate=Math.floor(clock/1000),extra={})=>new Request('https://bot.example/',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'TEST_WEBHOOK_SECRET'},body:JSON.stringify({update_id:sequence++,edited_message:{message_id:mid,chat:{id:user,type:'private'},from:{id:user,first_name:'张三'},text,edit_date:editDate,...extra}})});
const inbox=async(t,id)=>JSON.parse(await t.bot.store.get('inbox_'+id));
const noAdminCopies=()=>requests.filter(r=>['copyMessage','copyMessages','forwardMessage','forwardMessages'].includes(r.method));
const editNotices=()=>requests.filter(r=>r.method==='sendMessage'&&r.payload.text?.includes('修改了消息'));
const quickPayload=()=>requests.findLast(r=>r.payload.text?.includes('⚡ 快捷回复'));
const restoreNonce=t=>[...t.storage.data.keys()].filter(k=>k.startsWith('r:')).at(-1).slice(2);
async function signBackup(t,entries){const base=await t.bot.createBackup();runtime.entriesArg=entries;return {...base,entries,checksum:await vm.runInContext('entriesChecksum(entriesArg)',runtime)};}
const errorText=()=>requests.filter(r=>r.method==='sendMessage').at(-1)?.payload.text;
function uniqueMessages(){apiHook=async(method,payload)=>{
  if(['sendMessage','sendPhoto'].includes(method))return Response.json({ok:true,result:{message_id:++messageCounter}});
  if(method==='editMessageText')return Response.json({ok:true,result:{message_id:payload.message_id}});
  return null;
};}
const ui=async(t,kind,id)=>JSON.parse(await t.bot.store.get(`ui_${kind}_${id}`));
// 原13项只统计机器人界面删除，用户指令删除单独检验。
const deletions=()=>requests.filter(r=>r.method==='deleteMessage'&&!issuedCommandIds.has(`${r.payload.chat_id}:${r.payload.message_id}`));
const commandDeletes=()=>requests.filter(r=>r.method==='deleteMessage'&&issuedCommandIds.has(`${r.payload.chat_id}:${r.payload.message_id}`));
const photos=()=>requests.filter(r=>r.method==='sendPhoto');
const quickRecords=()=>requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id==='1'&&/快捷回复(?:已发送|未送达|发送结果待确认)/.test(r.payload.text||''));
async function prepareQuick(t){await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');await t.bot.fetch(callback('quick_replies'));const menu=quickPayload().payload;const stored=JSON.parse(await t.bot.store.get('admin_quick_'+menu.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1]));return {data:menu.reply_markup.inline_keyboard[0][0].callback_data,id:stored.menuId};}
(async()=>{
  await test('点模板后先收按钮，发送成功删除菜单并永久保留联系人/模板/正文记录',async()=>{
    const t=instance(legacy([['recent_2',JSON.stringify({id:'2',firstName:'张三',updatedAt:clock})]]));uniqueMessages();const {data,id}=await prepareQuick(t);await t.bot.fetch(callback(data));const recordId=messageCounter;await t.drain();
    const collapse=requests.findIndex(r=>r.method==='editMessageReplyMarkup'&&r.payload.message_id===id);const delivery=requests.findIndex(r=>r.method==='sendMessage'&&r.payload.chat_id==='2');assert.ok(collapse>=0&&collapse<delivery);assert.deepEqual(requests[collapse].payload.reply_markup.inline_keyboard,[]);
    assert.equal(quickRecords().length,1);assert.match(quickRecords()[0].payload.text,/张三/);assert.match(quickRecords()[0].payload.text,/模板：收到/);assert.match(quickRecords()[0].payload.text,/收到，我看一下。/);assert.match(quickRecords()[0].payload.text,/tg:\/\/user\?id=2/);
    assert.ok(requests.some(r=>r.method==='deleteMessage'&&r.payload.message_id===id));assert.ok(!requests.some(r=>r.method==='deleteMessage'&&r.payload.message_id===recordId));
  });
  await test('重复点击不重复发送/记录，菜单清理用真实保存ID而非任意回调ID',async()=>{
    const t=instance();uniqueMessages();const {data,id}=await prepareQuick(t);const clicked=await callback(data).json();clicked.callback_query.message.message_id=444;const forged=new Request('https://bot.example/',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'TEST_WEBHOOK_SECRET'},body:JSON.stringify(clicked)});await t.bot.fetch(forged);await t.bot.fetch(callback(data));await t.drain();assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id==='2').length,1);assert.equal(quickRecords().length,1);assert.ok(requests.some(r=>r.method==='deleteMessage'&&r.payload.message_id===id));assert.ok(!requests.some(r=>r.method==='deleteMessage'&&r.payload.message_id===444));
  });
  await test('切换会话后旧菜单仍给原联系人，常驻记录也显示原联系人',async()=>{
    const t=instance(legacy([['recent_2',JSON.stringify({id:'2',firstName:'原对象',updatedAt:clock})],['recent_3',JSON.stringify({id:'3',firstName:'新对象',updatedAt:clock})]]));uniqueMessages();const {data}=await prepareQuick(t);await runtime.setActiveAdminTarget(t.bot.store,'1','3','新对象');await t.bot.fetch(callback(data));await t.drain();assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id==='3').length,0);assert.match(quickRecords()[0].payload.text,/原对象/);assert.ok(!quickRecords()[0].payload.text.includes('新对象'));
  });
  await test('明确发送失败保留待回复，收起菜单并常驻失败记录，不伪称成功',async()=>{
    const t=instance();uniqueMessages();await runtime.recordIncomingMessage('2',10,t.bot.store);const {data,id}=await prepareQuick(t),original=apiHook;apiHook=async(method,payload)=>method==='sendMessage'&&payload.chat_id==='2'?Response.json({ok:false,error_code:403,description:'bot was blocked by the user'}):original(method,payload);
    await t.bot.fetch(callback(data));await t.drain();assert.equal((await inbox(t,2)).pendingIds.length,1);assert.equal(quickRecords().length,1);assert.match(quickRecords()[0].payload.text,/未送达/);assert.ok(!quickRecords()[0].payload.text.includes('已发送'));assert.ok(requests.some(r=>r.method==='deleteMessage'&&r.payload.message_id===id));
  });
  await test('接口网络结果不确定会留下待确认记录，重复Webhook不会重发模板',async()=>{
    const t=instance();uniqueMessages();await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');const original=apiHook;apiHook=async(method,payload)=>{if(method==='sendMessage'&&payload.chat_id==='2')throw Error('network interrupted');return original(method,payload);};assert.equal((await t.bot.fetch(update(1,1,'/quick 1'))).status,200);await t.bot.fetch(update(1,1,'/quick 1'));await t.drain();assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id==='2').length,1);assert.equal(quickRecords().length,1);assert.match(quickRecords()[0].payload.text,/结果待确认/);
  });
  await test('常驻记录消息发送失败时原菜单变成记录且不留下按钮',async()=>{
    const t=instance();uniqueMessages();const {data,id}=await prepareQuick(t),original=apiHook;apiHook=async(method,payload)=>method==='sendMessage'&&payload.chat_id==='1'&&payload.text.includes('快捷回复已发送')?Response.json({ok:false,error_code:400,description:'cannot send receipt'}):original(method,payload);
    await t.bot.fetch(callback(data));await t.drain();const fallback=requests.findLast(r=>r.method==='editMessageText'&&r.payload.message_id===id);assert.ok(fallback);assert.match(fallback.payload.text,/收到，我看一下。/);assert.deepEqual(fallback.payload.reply_markup.inline_keyboard,[]);assert.ok(!requests.some(r=>r.method==='deleteMessage'&&r.payload.message_id===id));
  });
  await test('1000字含HTML符号的模板完整记录；再开控制台不会删除这条历史记录',async()=>{
    const t=instance();uniqueMessages();await t.bot.store.put('quick_admin_1',JSON.stringify({nextId:2,items:[{id:'1',title:'特殊字符',text:'<'.repeat(1000)}]}));const {data}=await prepareQuick(t);await t.bot.fetch(callback(data));const recordId=messageCounter;assert.equal((quickRecords()[0].payload.text.match(/&lt;/g)||[]).length,1000);assert.ok(quickRecords()[0].payload.text.length>4000);assert.ok(!quickRecords()[0].payload.text.includes('截断'));await t.bot.fetch(update(1,1,'/admin'));await t.drain();assert.ok(!requests.some(r=>r.method==='deleteMessage'&&r.payload.message_id===recordId));
  });
  console.log(passed+' quick record checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
