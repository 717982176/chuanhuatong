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
const quickRecords=()=>requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id==='1'&&/快捷回复(?:已发送|未送达|发送结果待确认)/.test(r.payload.text||''));
async function prepareQuick(t){await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');await t.bot.fetch(callback('quick_replies'));const menu=quickPayload().payload;const stored=JSON.parse(await t.bot.store.get('admin_quick_'+menu.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1]));return {data:menu.reply_markup.inline_keyboard[0][0].callback_data,id:stored.menuId};}
function relayUnique(){const original=apiHook;apiHook=async(method,payload)=>{
  if(method==='copyMessage')return Response.json({ok:true,result:{message_id:++messageCounter}});
  if(method==='copyMessages')return Response.json({ok:true,result:payload.message_ids.map(()=>({message_id:++messageCounter}))});
  if(['sendMessage','sendPhoto'].includes(method))return Response.json({ok:true,result:{message_id:++messageCounter}});
  if(['editMessageText','editMessageCaption'].includes(method))return Response.json({ok:true,result:{message_id:payload.message_id}});return original?original(method,payload):null;
};}
const origin=async(t,user,mid)=>JSON.parse(await t.bot.store.get(`origin_${user}_${mid}`));
const updates=()=>requests.filter(r=>['editMessageText','editMessageCaption'].includes(r.method));
const lastUpdate=()=>updates().at(-1).payload;
const body=r=>r.text??r.caption;
const pendingEdits=t=>[...t.storage.data.entries()].filter(([k])=>k.startsWith('e:'));
const warningMessages=()=>requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id==='1'&&/[⚠️❌]/u.test(r.payload.text||''));
async function readyVisitor(){const t=instance(legacy([['auth_2','true']]));relayUnique();await t.bot.fetch(update(2,1,'原文'));await t.drain();requests=[];return t;}
async function retry(t,seconds=3){clock+=seconds*1000;await t.bot.alarm();await t.drain();}
function failOnce429(){const original=apiHook;let attempts=0;apiHook=async(method,payload)=>{if(['editMessageText','editMessageCaption'].includes(method)&&attempts++===0)return Response.json({ok:false,error_code:429,description:'Too many requests',parameters:{retry_after:2}});return original(method,payload);};}
(async()=>{
  await test('访客文字复制为可编辑副本，保留联系人标识，修改不新增消息或换ID',async()=>{
    const t=instance(legacy([['auth_2','true']]));relayUnique();await t.bot.fetch(update(2,1,'原文'));const original=await origin(t,2,1),copied=requests.find(r=>r.method==='copyMessage');assert.equal(original.transport,'copy');assert.equal(copied.payload.reply_markup.inline_keyboard[0][0].callback_data,'nfocus:2');assert.match(copied.payload.reply_markup.inline_keyboard[0][0].text,/张三/);await t.drain();requests=[];await t.bot.fetch(edited(2,1,'新版'));assert.equal(updates().length,1);assert.equal(lastUpdate().message_id,original.relayedId);assert.equal(lastUpdate().text,'新版');assert.equal(requests.filter(r=>r.method==='sendMessage').length,0);assert.equal(await t.bot.store.get('msg_'+original.relayedId),'2');assert.equal((await origin(t,2,1)).relayedId,original.relayedId);await t.drain();
  });
  await test('管理员修改回复仅更新原联系人副本，切换会话后不误改新联系人',async()=>{
    const t=instance();relayUnique();await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');await t.bot.fetch(update(1,1,'原回复'));const original=await origin(t,1,1);await runtime.setActiveAdminTarget(t.bot.store,'1','3','李');await t.drain();requests=[];await t.bot.fetch(edited(1,1,'修订'));assert.equal(lastUpdate().chat_id,'2');assert.equal(lastUpdate().message_id,original.relayedId);assert.equal(requests.filter(r=>r.method==='sendMessage').length,0);assert.equal((await runtime.getActiveAdminTarget(t.bot.store,'1')).userId,'3');await t.drain();
  });
  await test('/send 修改正文去掉指令前缀、校正UTF16实体偏移；目标ID改动被忽略',async()=>{
    const t=instance();relayUnique();await t.bot.fetch(update(1,1,'/send 2 原文'));await t.drain();requests=[];await t.bot.fetch(edited(1,1,'/send 2 😀粗体',Math.floor(clock/1000),{entities:[{type:'bold',offset:10,length:2}]}));assert.equal(lastUpdate().text,'😀粗体');assert.deepEqual(lastUpdate().entities[0],{type:'bold',offset:2,length:2});await t.bot.fetch(edited(1,1,'/send 3 新对象'));assert.equal(updates().length,1);await t.drain();
  });
  await test('照片说明直接编辑原caption，保留实体、图片位置与联系人按钮',async()=>{
    const t=instance(legacy([['auth_2','true']]));relayUnique();await t.bot.fetch(update(2,1,undefined,{photo:[{file_id:'TEST'}],caption:'原说明',show_caption_above_media:true}));const original=await origin(t,2,1);await t.drain();requests=[];await t.bot.fetch(edited(2,1,undefined,Math.floor(clock/1000),{photo:[{file_id:'TEST'}],caption:'新版',caption_entities:[{type:'bold',offset:0,length:2}]}));assert.equal(updates()[0].method,'editMessageCaption');assert.equal(lastUpdate().message_id,original.relayedId);assert.equal(lastUpdate().caption,'新版');assert.equal(lastUpdate().show_caption_above_media,true);assert.equal(lastUpdate().caption_entities[0].type,'bold');assert.equal(lastUpdate().reply_markup.inline_keyboard[0][0].callback_data,'nfocus:2');assert.equal(requests.filter(r=>r.method==='sendMessage').length,0);await t.drain();
  });
  await test('删除媒体说明仍更新原caption；不残留旧正文',async()=>{
    const t=instance(legacy([['auth_2','true']]));relayUnique();await t.bot.fetch(update(2,1,undefined,{document:{file_id:'TEST'},caption:'原说明'}));await t.drain();requests=[];await t.bot.fetch(edited(2,1,undefined,Math.floor(clock/1000),{document:{file_id:'TEST'}}));assert.equal(lastUpdate().caption,'');assert.deepEqual(lastUpdate().caption_entities,[]);await t.drain();
  });
  await test('原格式、链接和emoji偏移保留，不添加正文尾注且无HTML解析',async()=>{
    const t=await readyVisitor();const text='😀粗体 <b>网址';await t.bot.fetch(edited(2,1,text,Math.floor(clock/1000),{entities:[{type:'bold',offset:2,length:2},{type:'text_link',offset:8,length:2,url:'https://example.com'}]}));assert.equal(lastUpdate().parse_mode,undefined);assert.equal(lastUpdate().text,text+'');assert.deepEqual(lastUpdate().entities,[{type:'bold',offset:2,length:2},{type:'text_link',offset:8,length:2,url:'https://example.com'}]);await t.bot.fetch(edited(2,1,'下一版',Math.floor(clock/1000)+1));assert.equal(lastUpdate().text,'下一版');assert.equal((lastUpdate().text.match(/edited/g)||[]).length,0);await t.drain();
  });
  await test('重复更新、旧版本和未知映射不编辑，也不产生额外通知',async()=>{
    const t=await readyVisitor(),date=Math.floor(clock/1000);await t.bot.fetch(edited(2,1,'新版',date));await t.bot.fetch(edited(2,1,'新版',date));await t.bot.fetch(edited(2,1,'旧版',date-1));await t.bot.fetch(edited(2,99,'未知',date));assert.equal(updates().length,1);assert.equal(requests.filter(r=>r.method==='sendMessage').length,0);await t.drain();
  });
  await test('仅修改粗体等实体时也更新原副本，其他属性变化仍忽略',async()=>{
    const t=await readyVisitor();await t.bot.fetch(edited(2,1,'原文',Math.floor(clock/1000),{entities:[{type:'bold',offset:0,length:2}]}));assert.equal(updates().length,1);await t.bot.fetch(edited(2,1,'原文',Math.floor(clock/1000),{entities:[{type:'bold',offset:0,length:2}],is_topic_message:true}));assert.equal(updates().length,1);await t.drain();
  });
  await test('快速连续五次编辑不会被本地3条限流丢弃，最终保留最新版',async()=>{
    const t=await readyVisitor();for(let i=0;i<5;i++)await t.bot.fetch(edited(2,1,'版本'+i,Math.floor(clock/1000)+i));assert.equal(updates().length,5);assert.equal(lastUpdate().text,'版本4');assert.equal(new Set(updates().map(r=>r.payload.message_id)).size,1);await t.drain();
  });
  await test('Telegram429后合并等待期间新编辑，按retry_after仅补改最新版',async()=>{
    const t=await readyVisitor();failOnce429();const date=Math.floor(clock/1000);await t.bot.fetch(edited(2,1,'B',date));assert.equal(pendingEdits(t).length,1);await t.bot.fetch(edited(2,1,'C',date+1));await t.bot.fetch(edited(2,1,'D',date+2));assert.equal(updates().length,1);assert.equal(pendingEdits(t)[0][1].message.text,'D');await retry(t);assert.equal(updates().length,2);assert.equal(lastUpdate().text,'D');assert.equal(pendingEdits(t).length,0);assert.equal(requests.filter(r=>r.method==='sendMessage').length,0);
  });
  await test('等待重试时用户改回原文，取消较旧队列并阻止旧更新覆盖',async()=>{
    const t=await readyVisitor();failOnce429();const date=Math.floor(clock/1000);await t.bot.fetch(edited(2,1,'B',date));await t.bot.fetch(edited(2,1,'原文',date+1));assert.equal(pendingEdits(t).length,0);await runtime.handleEditedMessage({message_id:1,chat:{id:2,type:'private'},text:'B',edit_date:date},sequence-10,rEnv(t),rCfg(t));await retry(t);assert.equal(updates().length,1);assert.equal((await origin(t,2,1)).editDate,date+1);
  });
  await test('过期旧版本或重复Webhook不会清掉较新的重试队列',async()=>{
    const t=await readyVisitor();failOnce429();const date=Math.floor(clock/1000);await t.bot.fetch(edited(2,1,'B',date));await t.bot.fetch(edited(2,1,'原文',date-1));assert.equal(pendingEdits(t).length,1);await retry(t);assert.equal(lastUpdate().text,'B');
  });
  await test('编辑队列和原消息ID在协调器重建后仍能恢复',async()=>{
    const t=await readyVisitor();failOnce429();await t.bot.fetch(edited(2,1,'重建后新版'));const id=(await origin(t,2,1)).relayedId;const restarted=instance(t.kv,t.storage);await retry(restarted);assert.equal(lastUpdate().message_id,id);assert.equal(lastUpdate().text,'重建后新版');assert.equal(pendingEdits(restarted).length,0);
  });
  await test('编辑网络结果不确定安全重试同ID，不新发副本',async()=>{
    const t=await readyVisitor(),orig=apiHook;let failed=false;apiHook=async(method,payload)=>{if(method==='editMessageText'&&!failed){failed=true;throw Error('network interrupted');}return orig(method,payload);};await t.bot.fetch(edited(2,1,'新版'));assert.equal(pendingEdits(t).length,1);await retry(t);assert.equal(updates().length,2);assert.equal(new Set(updates().map(r=>r.payload.message_id)).size,1);assert.equal(requests.filter(r=>r.method==='sendMessage').length,0);
  });
  await test('编辑网络重试耗尽会结束队列并提示未确认，不伪称成功',async()=>{
    const t=await readyVisitor(),orig=apiHook;apiHook=async(method,payload)=>{if(method==='editMessageText')throw Error('offline');return orig(method,payload);};await t.bot.fetch(edited(2,1,'新版'));for(let i=0;i<3;i++)await retry(t);assert.equal(updates().length,4);assert.equal(pendingEdits(t).length,0);assert.equal(warningMessages().length,1);assert.match(warningMessages()[0].payload.text,/未确认/);
  });
  await test('等待编辑期间撤销授权或封禁会停止重试',async()=>{
    const t=await readyVisitor();failOnce429();await t.bot.fetch(edited(2,1,'新版'));await t.bot.store.delete('auth_2');await retry(t);assert.equal(updates().length,1);assert.equal(pendingEdits(t).length,0);
  });
  await test('已回复访客的新编辑重新计入待回复，但不重复增加条数',async()=>{
    const t=await readyVisitor();await runtime.clearAwaitingReply('2',t.bot.store);await t.bot.fetch(edited(2,1,'新版'));assert.equal((await inbox(t,2)).pendingIds.length,1);await t.bot.fetch(edited(2,1,'下一版'));assert.equal((await inbox(t,2)).pendingIds.length,1);await t.drain();
  });
  await test('相册采用可编辑复制且只在首张附联系人标识，编辑第二张保留同组位置',async()=>{
    const t=instance(legacy([['auth_2','true']]));relayUnique();await t.bot.fetch(album(2,'album_edit',1));await t.bot.fetch(update(2,2,undefined,{media_group_id:'album_edit',photo:[{file_id:'TEST'}],caption:'原文'}));await mature(t);assert.equal(requests.filter(r=>r.method==='copyMessages').length,1);const id=(await origin(t,2,2)).relayedId;const identity=requests.filter(r=>r.method==='editMessageReplyMarkup');assert.equal(identity.length,1);assert.equal(identity[0].payload.message_id,(await origin(t,2,1)).relayedId);requests=[];await t.bot.fetch(edited(2,2,undefined,Math.floor(clock/1000),{media_group_id:'album_edit',caption:'修订'}));assert.equal(updates()[0].method,'editMessageCaption');assert.equal(lastUpdate().message_id,id);assert.equal(lastUpdate().caption,'修订');assert.equal(requests.filter(r=>r.method==='sendMessage').length,0);await t.drain();
  });
  await test('旧副本明确无法编辑时只创建一条修订副本，后续编辑复用这条消息',async()=>{
    const t=await readyVisitor(),orig=apiHook,old=(await origin(t,2,1)).relayedId;apiHook=async(method,payload)=>method==='editMessageText'&&payload.message_id===old?Response.json({ok:false,error_code:400,description:"Bad Request: message can't be edited"}):orig(method,payload);await t.bot.fetch(edited(2,1,'修订1'));const correction=(await origin(t,2,1)).correctionId;assert.ok(correction);assert.equal(requests.filter(r=>r.method==='sendMessage').length,1);assert.equal(await t.bot.store.get('msg_'+correction),'2');await t.bot.fetch(edited(2,1,'修订2',Math.floor(clock/1000)+1));await t.bot.fetch(edited(2,1,'修订2',Math.floor(clock/1000)+1));assert.equal(requests.filter(r=>r.method==='sendMessage').length,1);assert.equal(lastUpdate().message_id,correction);assert.equal(lastUpdate().text,'修订2');await t.drain();
  });
  await test('旧媒体caption无法编辑时修订副本是文字，后续也用文字原位修改',async()=>{
    const t=instance(legacy([['auth_2','true']]));relayUnique();await t.bot.fetch(update(2,1,undefined,{photo:[{file_id:'TEST'}],caption:'原文'}));await t.drain();requests=[];const orig=apiHook;apiHook=async(method,payload)=>method==='editMessageCaption'?Response.json({ok:false,error_code:400,description:'message to edit not found'}):orig(method,payload);await t.bot.fetch(edited(2,1,undefined,Math.floor(clock/1000),{caption:'修订1'}));const correction=(await origin(t,2,1)).correctionId;await t.bot.fetch(edited(2,1,undefined,Math.floor(clock/1000)+1,{caption:'修订2'}));assert.equal(updates().at(-1).method,'editMessageText');assert.equal(lastUpdate().message_id,correction);assert.equal(lastUpdate().text,'修订2');assert.equal(requests.filter(r=>r.method==='sendMessage').length,1);await t.drain();
  });
  await test('修订副本也被删除后不继续创建第三条消息',async()=>{
    const t=await readyVisitor(),orig=apiHook;apiHook=async(method,payload)=>method==='editMessageText'?Response.json({ok:false,error_code:400,description:'message to edit not found'}):orig(method,payload);await t.bot.fetch(edited(2,1,'修订1'));await t.bot.fetch(edited(2,1,'修订2',Math.floor(clock/1000)+1));assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.text==='修订1').length,1);assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.text==='修订2').length,0);assert.equal(warningMessages().length,1);await t.drain();
  });
  await test('创建修订副本网络结果未知会留检查点，重复更新不重复创建',async()=>{
    const t=await readyVisitor(),orig=apiHook;apiHook=async(method,payload)=>{if(method==='editMessageText')return Response.json({ok:false,error_code:400,description:'message to edit not found'});if(method==='sendMessage'&&payload.text==='修订')throw Error('unknown network outcome');return orig(method,payload);};await t.bot.fetch(edited(2,1,'修订'));await t.bot.fetch(edited(2,1,'修订'));assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.text==='修订').length,1);assert.ok((await origin(t,2,1)).correctionUncertain);assert.equal(pendingEdits(t).length,0);await t.drain();
  });
  await test('文本4096字和caption1024字完整保留，不添加尾注或截掉原文',async()=>{
    const t=await readyVisitor();await t.bot.fetch(edited(2,1,'字'.repeat(4096)));assert.equal(lastUpdate().text,'字'.repeat(4096));const media=instance(legacy([['auth_2','true']]));relayUnique();await media.bot.fetch(update(2,1,undefined,{photo:[{file_id:'TEST'}],caption:'原'}));await media.drain();requests=[];await media.bot.fetch(edited(2,1,undefined,Math.floor(clock/1000),{caption:'字'.repeat(1024)}));assert.equal(lastUpdate().caption,'字'.repeat(1024));await t.drain();await media.drain();
  });
  await test('实体隐私拒绝时只移除受限提及，保留正文格式、公开链接和原文',async()=>{
    const t=await readyVisitor(),orig=apiHook;apiHook=async(method,payload)=>method==='editMessageText'&&payload.entities?.some(e=>e.type==='text_mention')?Response.json({ok:false,error_code:400,description:'USER_PRIVACY_RESTRICTED'}):orig(method,payload);await t.bot.fetch(edited(2,1,'甲乙丙丁',Math.floor(clock/1000),{entities:[{type:'text_mention',offset:0,length:1,user:{id:4,first_name:'甲'}},{type:'bold',offset:1,length:1},{type:'text_link',offset:2,length:1,url:'https://example.com'}]}));assert.equal(updates().length,2);assert.ok(lastUpdate().entities.every(e=>e.type!=='text_mention'));assert.ok(lastUpdate().entities.some(e=>e.type==='bold'));assert.ok(lastUpdate().entities.some(e=>e.url==='https://example.com'));assert.equal(lastUpdate().entities.at(-1).type,'text_link');assert.equal(warningMessages().length,0);await t.drain();
  });
  await test('接口未修改被视为幂等成功，不新增副本；普通解析错误不会转为修订新消息',async()=>{
    const t=await readyVisitor(),orig=apiHook;apiHook=async(method,payload)=>method==='editMessageText'?Response.json({ok:false,error_code:400,description:'message is not modified'}):orig(method,payload);await t.bot.fetch(edited(2,1,'修订'));assert.equal(requests.filter(r=>r.method==='sendMessage').length,0);assert.equal((await origin(t,2,1)).editDate,Math.floor(clock/1000));apiHook=async(method,payload)=>method==='editMessageText'?Response.json({ok:false,error_code:400,description:'cannot parse entities'}):orig(method,payload);await t.bot.fetch(edited(2,1,'新修订',Math.floor(clock/1000)+1));assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.text==='新修订').length,0);assert.equal(warningMessages().length,1);await t.drain();
  });
  await test('网络错误发生在服务端已修改之后，用户改回原文仍实际同步确认',async()=>{
    const t=await readyVisitor(),orig=apiHook;let serverText='原文',failed=false;apiHook=async(method,payload)=>{if(method==='editMessageText'){serverText=payload.text;if(!failed){failed=true;throw Error('response lost after server changed');}}return orig(method,payload);};const date=Math.floor(clock/1000);await t.bot.fetch(edited(2,1,'B',date));assert.equal(serverText,'B');await t.bot.fetch(edited(2,1,'原文',date+1));assert.equal(pendingEdits(t).length,1);await retry(t);assert.equal(serverText,'原文');assert.equal(pendingEdits(t).length,0);assert.equal(requests.filter(r=>r.method==='sendMessage').length,0);
  });
  await test('媒体说明限流后合并空caption更新，重试保留原图位置并清除旧说明',async()=>{
    const t=instance(legacy([['auth_2','true']]));relayUnique();await t.bot.fetch(update(2,1,undefined,{photo:[{file_id:'TEST'}],caption:'原文',show_caption_above_media:true}));await t.drain();requests=[];failOnce429();const date=Math.floor(clock/1000);await t.bot.fetch(edited(2,1,undefined,date,{caption:'新文',caption_entities:[{type:'bold',offset:0,length:2}]}));await t.bot.fetch(edited(2,1,undefined,date+1,{photo:[{file_id:'TEST'}]}));await retry(t);assert.equal(lastUpdate().caption,'');assert.equal(lastUpdate().show_caption_above_media,true);assert.equal(lastUpdate().caption_entities.length,0);assert.equal(pendingEdits(t).length,0);
  });
  console.log(passed+' edit sync checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
