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
    put:async(key,value,options={})=>{operations.push({op:'put',key});if(kv.failWrites)throw Error('KV unavailable');if(writes.has(key)&&clock-writes.get(key)<1000)throw Error('same key write limit');writes.set(key,clock);data.set(key,value);metadata[key]={expiration:options.expiration ?? (options.expirationTtl ? Math.floor(clock/1000)+options.expirationTtl : undefined),metadata:options.metadata};},
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
(async()=>{
  await test('管理员三次 /start 仅保留最新欢迎图，兼容 Bot 名称及 payload',async()=>{
    const t=instance();t.bindings.WELCOME_IMAGE=t.bot.env.WELCOME_IMAGE='https://example.invalid/welcome.png';uniqueMessages();
    for(const [index,command]of ['/start','/start@MochiBot','/start deep-link'].entries())await t.bot.fetch(update(1,index+1,command));await t.drain();
    assert.equal(photos().length,3);assert.equal(deletions().length,2);assert.equal((await ui(t,'start',1)).messageId,messageCounter);assert.ok(deletions().every(r=>r.payload.message_id!==messageCounter&&r.payload.chat_id==='1'));
  });
  await test('已授权访客连续 /start 欢迎图或纯文字均替换旧消息',async()=>{
    for(const image of ['', 'https://example.invalid/welcome.png']){
      requests=[];const t=instance(legacy([['auth_2','true']]));t.bindings.WELCOME_IMAGE=t.bot.env.WELCOME_IMAGE=image;uniqueMessages();
      await t.bot.fetch(update(2,1,'/start'));const first=(await ui(t,'start',2)).messageId;await t.bot.fetch(update(2,2,'/start'));await t.drain();
      assert.equal(deletions().length,1);assert.equal(deletions()[0].payload.message_id,first);assert.notEqual((await ui(t,'start',2)).messageId,first);assert.equal(noAdminCopies().length,0);
    }
  });
  await test('未授权访客先清旧验证链接再发新入口，沿用旧版本 verify_msg',async()=>{
    const t=instance(legacy([['verify_msg_2','50']]));uniqueMessages();await t.bot.fetch(update(2,1,'/start'));await t.drain();const first=(await ui(t,'start',2)).messageId;
    assert.equal(deletions()[0].payload.message_id,50);assert.ok(requests.findIndex(r=>r.method==='sendMessage'&&r.payload.reply_markup?.inline_keyboard[0][0].web_app)>requests.findIndex(r=>r.method==='deleteMessage'));
    await t.bot.fetch(update(2,2,'/start'));await t.drain();assert.equal(await t.bot.store.get('verify_msg_2'),String((await ui(t,'start',2)).messageId));assert.equal(deletions().at(-1).payload.message_id,first);
  });
  await test('新提示失败不伪造记录；新欢迎图失败可回退文字',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(update(2,1,'/start'));const previous=(await ui(t,'start',2)).messageId;await t.drain();
    apiHook=async method=>method==='sendMessage'?Response.json({ok:false,error_code:400,description:'cannot send'}):null;await t.bot.fetch(update(2,2,'/start'));await t.drain();assert.equal(await ui(t,'start',2),null);assert.equal(await t.bot.store.get('verify_msg_2'),null);assert.equal(deletions().length,1);
    await t.bot.store.put('auth_2','true');t.bindings.WELCOME_IMAGE=t.bot.env.WELCOME_IMAGE='https://example.invalid/welcome.png';apiHook=async method=>method==='sendPhoto'?Response.json({ok:false,error_code:400,description:'bad photo'}):method==='sendMessage'?Response.json({ok:true,result:{message_id:5000}}):null;
    await t.bot.fetch(update(2,3,'/start'));await t.drain();assert.equal((await ui(t,'start',2)).messageId,5000);assert.equal(deletions().at(-1).payload.message_id,previous);
  });
  await test('管理员 /admin、/help、指令共同保留一个最新控制台；欢迎图独立',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(update(1,1,'/start'));const welcome=(await ui(t,'start',1)).messageId;
    for(const [index,command]of ['/admin','/help@MochiBot','指令'].entries())await t.bot.fetch(update(1,index+2,command));await t.drain();assert.equal(deletions().length,2);assert.ok(deletions().every(r=>r.payload.message_id!==welcome));assert.equal((await ui(t,'menu',1)).messageId,messageCounter);
  });
  await test('新控制台失败不保存无效ID，普通对话和访客通知仍保留',async()=>{
    const t=instance(legacy([['auth_2','true']]));uniqueMessages();await t.bot.fetch(update(1,1,'/admin'));const current=(await ui(t,'menu',1)).messageId;
    apiHook=async(method,payload)=>method==='sendMessage'&&payload.text.includes('管理员控制台')?Response.json({ok:false,error_code:400,description:'cannot send'}):null;
    await t.bot.fetch(update(1,2,'/admin'));await t.bot.fetch(update(2,3,'普通留言'));await t.drain();assert.equal(await ui(t,'menu',1),null);assert.equal(deletions().filter(r=>r.payload.message_id===current).length,1);assert.equal(noAdminCopies().length,1);
  });
  await test('菜单返回只编辑现有消息；失效列表另发后新 /admin 会清掉替代列表',async()=>{
    const t=instance(legacy([['auth_2','true'],['recent_2',JSON.stringify({id:'2',firstName:'张',updatedAt:clock})]]));uniqueMessages();await t.bot.fetch(update(1,1,'/admin'));const current=(await ui(t,'menu',1)).messageId;
    const query={id:'cb',from:{id:1},data:'menu_main',message:{message_id:current}};await runtime.handleCallback(query,rEnv(t),rCfg(t));await t.drain();assert.equal((await ui(t,'menu',1)).messageId,current);assert.equal(deletions().length,0);
    apiHook=async(method,payload)=>method==='editMessageText'?Response.json({ok:false,error_code:400,description:'Bad Request: message to edit not found'}):method==='sendMessage'?Response.json({ok:true,result:{message_id:++messageCounter}}):null;
    query.data='recent';await runtime.handleCallback(query,rEnv(t),rCfg(t));const replacement=(await ui(t,'menu',1)).messageId;assert.notEqual(replacement,current);
    await t.bot.fetch(update(1,2,'/admin'));await t.drain();assert.ok(deletions().some(r=>r.payload.message_id===replacement));assert.ok(!deletions().some(r=>r.payload.message_id===(t.storage.data.get('v:ui_menu_1')&&JSON.parse(t.storage.data.get('v:ui_menu_1').value).messageId)));
  });
  await test('验证成功欢迎提示替换验证链接，后续 /start 不再次累积欢迎图',async()=>{
    const t=instance();t.bindings.WELCOME_IMAGE=t.bot.env.WELCOME_IMAGE='https://example.invalid/welcome.png';uniqueMessages();await t.bot.fetch(update(2,1,'/start'));const prompt=(await ui(t,'start',2)).messageId;await grant(t);await t.drain();const welcome=(await ui(t,'start',2)).messageId;
    assert.notEqual(welcome,prompt);assert.equal(await t.bot.store.get('verify_msg_2'),null);assert.ok(deletions().some(r=>r.payload.message_id===prompt));await t.bot.fetch(update(2,2,'/start'));await t.drain();assert.ok(deletions().some(r=>r.payload.message_id===welcome));
  });
  await test('欢迎提示失败不影响实时授权；撤销后再次 /start 能替换欢迎图',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(update(2,1,'/start'));const prompt=(await ui(t,'start',2)).messageId;
    apiHook=async(method,payload)=>method==='sendMessage'&&payload.chat_id==='2'&&payload.text.includes('验证成功')?Response.json({ok:false,error_code:400,description:'cannot send welcome'}):null;await grant(t);await t.drain();assert.equal(await t.bot.store.get('auth_2'),'true');assert.equal(await ui(t,'start',2),null);assert.ok(deletions().some(r=>r.payload.message_id===prompt));
    uniqueMessages();await t.bot.fetch(update(2,2,'/start'));const welcome=(await ui(t,'start',2)).messageId;await t.bot.store.delete('auth_2');await t.bot.fetch(update(2,3,'/start'));await t.drain();assert.ok(deletions().some(r=>r.payload.message_id===welcome));assert.equal(await t.bot.store.get('verify_msg_2'),String((await ui(t,'start',2)).messageId));
  });
  await test('等待旧欢迎图删除完成后发新图；明确删除失败仍继续转发',async()=>{
    const t=instance(legacy([['auth_2','true']]));uniqueMessages();await t.bot.fetch(update(2,1,'/start'));const first=(await ui(t,'start',2)).messageId;const original=apiHook;let resolveDelete;
    apiHook=async(method,payload)=>{if(method==='deleteMessage'&&payload.message_id===first){await new Promise(resolve=>{resolveDelete=resolve;});return Response.json({ok:false,error_code:400,description:'message cannot be deleted'});}return original(method,payload);};
    const sending=t.bot.fetch(update(2,2,'/start'));while(!resolveDelete)await new Promise(resolve=>setTimeout(resolve,1));assert.equal((await ui(t,'start',2)).messageId,first);resolveDelete();assert.equal((await within(sending)).status,200);assert.equal((await within(t.bot.fetch(update(2,3,'真实留言')))).status,200);assert.equal(noAdminCopies().length,1);assert.notEqual((await ui(t,'start',2)).messageId,first);await t.drain();
  });
  await test('后台欢迎通知与 /start 同时发送按顺序替换，最后只保留新的消息',async()=>{
    const t=instance();await t.bot.store.put('auth_2','true');uniqueMessages();const original=apiHook;let releaseWelcome;
    apiHook=async(method,payload)=>{if(method==='sendMessage'&&payload.text==='迟到的欢迎'){await new Promise(resolve=>{releaseWelcome=resolve;});}return original(method,payload);};
    const first=runtime.sendLatestStart('2',()=>runtime.sendMessage('2','迟到的欢迎',rEnv(t),rCfg(t)),rEnv(t),rCfg(t));
    while(!releaseWelcome)await new Promise(resolve=>setTimeout(resolve,1));const second=t.bot.fetch(update(2,1,'/start'));releaseWelcome();await first;await second;await t.drain();
    assert.equal(deletions().length,1);assert.equal((await ui(t,'start',2)).messageId,messageCounter);assert.ok(!deletions().some(r=>r.payload.message_id===messageCounter));assert.equal(t.bot.uiQueues.size,0);
  });
  await test('不同访客隔离，协调器重建后仍记得上一条欢迎提示',async()=>{
    const t=instance(legacy([['auth_2','true'],['auth_3','true']]));uniqueMessages();await t.bot.fetch(update(2,1,'/start'));const two=(await ui(t,'start',2)).messageId;await t.bot.fetch(update(3,2,'/start'));const three=(await ui(t,'start',3)).messageId;
    const restart=instance(t.kv,t.storage);await restart.bot.fetch(update(2,3,'/start'));await restart.drain();assert.ok(deletions().some(r=>r.payload.message_id===two&&r.payload.chat_id==='2'));assert.ok(!deletions().some(r=>r.payload.message_id===three));assert.equal((await ui(restart,'start',3)).messageId,three);
  });
  await test('访客 /admin 与 /help 说明也替换旧说明，管理权限与验证按钮保留',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(update(2,1,'/start'));const prompt=(await ui(t,'start',2)).messageId;await t.bot.fetch(update(2,2,'/admin'));const help=(await ui(t,'help',2)).messageId;await t.bot.fetch(update(2,3,'/help'));await t.drain();assert.ok(deletions().some(r=>r.payload.message_id===help));assert.ok(!deletions().some(r=>r.payload.message_id===prompt));assert.equal(await t.bot.store.get('ui_menu_2'),null);
  });
  await test('管理员交替 /start、/admin、/help、指令只保留最新的一条用户指令',async()=>{
    const t=instance();uniqueMessages();for(const [i,text]of ['/start','/admin','/help@MochiBot','指令'].entries())await t.bot.fetch(update(1,i+1,text));await t.drain();
    assert.deepEqual(commandDeletes().map(r=>r.payload.message_id),[1,2,3]);assert.equal((await ui(t,'command',1)).messageId,4);assert.ok(!commandDeletes().some(r=>r.payload.message_id===4));
  });
  await test('访客与管理员指令互不影响；协调器重建后仍清理上次用户指令',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(update(1,1,'/admin'));await t.bot.fetch(update(2,2,'/start'));const restarted=instance(t.kv,t.storage);
    await restarted.bot.fetch(update(2,3,'/admin'));await restarted.bot.fetch(update(1,4,'/start'));await restarted.drain();assert.ok(commandDeletes().some(r=>r.payload.chat_id==='2'&&r.payload.message_id===2));assert.ok(commandDeletes().some(r=>r.payload.chat_id==='1'&&r.payload.message_id===1));assert.equal((await ui(restarted,'command',2)).messageId,3);assert.equal((await ui(restarted,'command',1)).messageId,4);
  });
  await test('普通消息、/send 内容和访客的普通“指令”不进入自动删除记录',async()=>{
    const t=instance(legacy([['auth_2','true']]));uniqueMessages();await t.bot.fetch(update(1,1,'/admin'));await t.bot.fetch(update(1,2,'/send 2 保留内容'));await t.bot.fetch(update(2,3,'指令'));await t.bot.fetch(update(2,4,'普通消息'));await t.bot.fetch(update(1,5,'/start'));await t.drain();
    const ids=requests.filter(r=>r.method==='deleteMessage').map(r=>r.payload.message_id);assert.ok(ids.includes(1));assert.ok(!ids.includes(2)&&!ids.includes(3)&&!ids.includes(4));assert.equal((await ui(t,'command',1)).messageId,5);assert.equal(await t.bot.store.get('ui_command_2'),null);
  });
  await test('Webhook重复投递不删除最新指令；发送异常仍保留当前用户指令',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(update(1,1,'/start'));await t.bot.fetch(update(1,1,'/start'));await t.drain();assert.equal(commandDeletes().length,0);
    apiHook=async method=>{if(method==='sendMessage')throw Error('network failure');return null;};assert.equal((await t.bot.fetch(update(1,2,'/start'))).status,503);await t.drain();assert.equal((await ui(t,'command',1)).messageId,2);assert.equal(commandDeletes().length,1);
  });
  await test('旧用户指令删除请求先完成再发新菜单；受限时当前指令仍保留',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(update(1,1,'/admin'));const original=apiHook;let finish;
    apiHook=async(method,payload)=>{if(method==='deleteMessage'&&payload.message_id===1){await new Promise(resolve=>{finish=resolve;});return Response.json({ok:false,error_code:400,description:'message cannot be deleted'});}return original(method,payload);};const next=t.bot.fetch(update(1,2,'/admin'));while(!finish)await new Promise(resolve=>setTimeout(resolve,1));assert.equal((await ui(t,'command',1)).messageId,1);finish();assert.equal((await within(next)).status,200);assert.equal((await ui(t,'command',1)).messageId,2);await t.drain();assert.ok(!commandDeletes().some(r=>r.payload.message_id===2));
  });
  await test('删除接口无响应时约1.5秒停止等待，继续发新提示',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(update(1,1,'/admin'));const original=apiHook;let aborted=false;
    apiHook=async(method,payload,options)=>{if(method==='deleteMessage'&&payload.message_id===1)return new Promise((_,reject)=>{options.signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));},{once:true});});return original(method,payload);};
    const began=performance.now();assert.equal((await t.bot.fetch(update(1,2,'/admin'))).status,200);const elapsed=performance.now()-began;assert.ok(aborted);assert.ok(elapsed>=1400&&elapsed<2500);assert.equal((await ui(t,'command',1)).messageId,2);assert.ok(await ui(t,'menu',1));await t.drain();
  });
  console.log(passed+' UI cleanup checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
