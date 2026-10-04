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
const record=(id,name='Alice',extra={})=>['recent_'+id,JSON.stringify({id:String(id),firstName:name,updatedAt:clock,username:'',...extra})];
const auth=(...ids)=>ids.map(id=>['auth_'+id,'true']);
const orig=async(t,u,m)=>JSON.parse(await t.bot.store.get(`origin_${u}_${m}`));
const richEdit=()=>requests.findLast(r=>r.method==='editMessageText'&&r.payload.rich_message)?.payload;
const markupEdits=()=>requests.filter(r=>r.method==='editMessageReplyMarkup');
const photo=(id)=>({text:undefined,photo:[{file_id:'file_'+id,file_unique_id:'unique_'+id}]});
const medias=()=>requests.filter(r=>r.method==='editMessageMedia');
function accurateApi(){apiHook=async(method,payload)=>{
  if(['copyMessage','forwardMessage','sendMessage','sendRichMessage','sendPhoto','sendVideo','sendDocument','sendAudio','sendAnimation'].includes(method))return Response.json({ok:true,result:{message_id:++messageCounter}});
  if(['copyMessages','forwardMessages'].includes(method))return Response.json({ok:true,result:payload.message_ids.map(()=>({message_id:++messageCounter}))});
  if(method.startsWith('editMessage'))return Response.json({ok:true,result:{message_id:payload.message_id}});return null;
};}
const channel={type:'channel',date:1,chat:{id:-100123456,username:'example_channel',title:'来源'},message_id:10};
const resources={inline_keyboard:[[{text:'查看资源',url:'https://example.com/resource'}],[{text:'原回调',callback_data:'away_on'}]]};
const makeView=async(t)=>runtime.buildRecentUsersText(t.bot.store);
const nativeEdit=()=>requests.findLast(r=>r.method==='editMessageText').payload;
const userRows=payload=>payload.reply_markup.inline_keyboard.filter(row=>row.length===3&&row[2].copy_text);
const cards=()=>requests.filter(r=>r.method==='sendMessage'&&r.payload.reply_parameters&&r.payload.reply_markup?.inline_keyboard.flat().some(b=>b.callback_data?.startsWith('nfocus:')));
const deletes=()=>requests.filter(r=>r.method==='deleteMessage');
const forwarded=(mid,from=2)=>update(from,mid,'资源内容',{forward_origin:channel,reply_markup:resources});
const native=(mid,extra={})=>update(2,mid,'原文',{forward_origin:channel,...extra});
const pause=()=>{clock+=1200;};
const contactRows=payload=>payload.reply_markup?.inline_keyboard.flat().filter(b=>b.callback_data?.startsWith('nfocus:'))||[];
const gone=id=>markupEdits().some(r=>r.payload.message_id===id&&!contactRows(r.payload).length);
const live=async(t,id)=>(await orig(t,2,id))?.relayContact;
const history=async t=>JSON.parse(await t.bot.store.get('ui_relay_history_1'));
async function visitor(t,mid,text='留言',from=2){pause();await t.bot.fetch(update(from,mid,text));await t.drain();return (await orig(t,from,mid)).relayedId;}
async function command(t,mid,text='/admin'){await t.bot.fetch(update(1,mid,text));await t.drain();return JSON.parse(await t.bot.store.get('ui_'+(text.startsWith('/start')?'start':'menu')+'_1')).messageId;}
async function split(t,cmd='/admin'){const first=await visitor(t,1);const menu=await command(t,100,cmd);const second=await visitor(t,2);assert.ok(!gone(first));return {first,menu,second};}
(async()=>{
 await test('重复/admin清掉旧指令和菜单后，立即合并前两组，保留最新昵称入口',async()=>{const t=instance(legacy(auth(2)));accurateApi();const {first,second}=await split(t);await command(t,101);assert.ok(gone(first));assert.ok(!gone(second));assert.equal(await live(t,1),false);assert.equal(await live(t,2),true);assert.equal(await t.bot.store.get('msg_'+first),'2');assert.equal(await t.bot.store.get('msg_'+second),'2');});
 await test('重复/start及/start@BotName欢迎替换后同样合并',async()=>{for(const text of ['/start','/start@MochiBot']){const t=instance(legacy(auth(2)));accurateApi();const {first,second}=await split(t,text);await command(t,101,text);assert.ok(gone(first));assert.ok(!gone(second));requests=[];}});
 await test('/admin仍在两组中间时，不提前合并；只删除指令还不够',async()=>{const t=instance(legacy(auth(2)));accurateApi();const {first}=await split(t);await runtime.deleteMessage('1',100,rCfg(t));assert.ok(!gone(first));assert.equal(await live(t,1),true);});
 await test('两个分隔消息都确认删除后即刻合并，不需要访客再发新留言',async()=>{const t=instance(legacy(auth(2)));accurateApi();const {first,second,menu}=await split(t);await runtime.deleteMessage('1',100,rCfg(t));await runtime.deleteMessage('1',menu,rCfg(t));assert.ok(gone(first));assert.ok(!gone(second));assert.equal(JSON.parse(await t.bot.store.get('ui_relay_group_1')).messageId,second);});
 await test('连续多次替换管理员菜单，每个已连起来的访客段只保留最后气泡',async()=>{const t=instance(legacy(auth(2)));accurateApi();const {first,second}=await split(t);await command(t,101);const third=await visitor(t,3);assert.ok(!gone(second));await command(t,102);assert.ok(gone(first));assert.ok(gone(second));assert.ok(!gone(third));assert.equal((await history(t)).filter(e=>!e.barrier).length,1);});
 await test('admin/start交替且旧欢迎仍在时，只合并真正已经相邻的段',async()=>{const t=instance(legacy(auth(2)));accurateApi();const first=await visitor(t,1);await command(t,100);const second=await visitor(t,2);await command(t,101,'/start');const third=await visitor(t,3);await command(t,102);assert.ok(gone(first));assert.ok(!gone(second));assert.ok(!gone(third));await command(t,103,'/start');assert.ok(gone(second));assert.ok(!gone(third));});
 await test('管理员555普通消息仍在时，旧菜单清除不跨真实消息合并',async()=>{const t=instance(legacy(auth(2)));accurateApi();const {first,second}=await split(t);await t.bot.fetch(update(1,99,'555'));await t.drain();const third=await visitor(t,3);await command(t,101);assert.ok(gone(first));assert.ok(!gone(second));assert.ok(!gone(third));assert.equal(await live(t,2),true);assert.equal(await live(t,3),true);});
 await test('管理员实际回复访客作为保留的分隔，重复指令不清前一组身份',async()=>{const t=instance(legacy(auth(2)));accurateApi();const first=await visitor(t,1);await t.bot.fetch(update(1,99,'真实回复',{reply_to_message:{message_id:first}}));await t.drain();await command(t,100);const second=await visitor(t,2);await command(t,101);assert.ok(!gone(first));assert.ok(!gone(second));});
 await test('不同访客A/B/A交替，清除旧指令不能合并跨访客的A',async()=>{const t=instance(legacy(auth(2,3)));accurateApi();const first=await visitor(t,1);await command(t,100);const middle=await visitor(t,11,'另一人',3);const last=await visitor(t,2);await command(t,101);assert.ok(!gone(first));assert.ok(!gone(middle));assert.ok(!gone(last));});
 await test('昵称相同但访客ID不同，仍保留各自身份和回复映射',async()=>{const t=instance(legacy(auth(2,3)));accurateApi();const first=await visitor(t,1);await command(t,100);const second=await visitor(t,11,'同名',3);await command(t,101);assert.ok(!gone(first));assert.ok(!gone(second));assert.equal(await t.bot.store.get('msg_'+first),'2');assert.equal(await t.bot.store.get('msg_'+second),'3');});
 await test('旧菜单删除明确失败或网络结果不明时，不把仍可能可见的分隔当作已移除',async()=>{for(const uncertain of [false,true]){const t=instance(legacy(auth(2)));accurateApi();const {first,menu}=await split(t);const normal=apiHook;apiHook=async(m,p)=>m==='deleteMessage'&&p.message_id===menu?(uncertain?(()=>{throw Error('unknown deletion');})():Response.json({ok:false,error_code:400,description:"message can't be deleted"})):normal(m,p);await command(t,101);assert.ok(!gone(first));assert.equal(await live(t,1),true);assert.ok((await history(t)).some(e=>e.barrier&&e.messageId===menu));requests=[];}});
 await test('旧菜单已不存在的明确结果可确认移除并合并',async()=>{const t=instance(legacy(auth(2)));accurateApi();const {first,menu}=await split(t);const normal=apiHook;apiHook=async(m,p)=>m==='deleteMessage'&&p.message_id===menu?Response.json({ok:false,error_code:400,description:'Bad Request: message to delete not found'}):normal(m,p);await command(t,101);assert.ok(gone(first));});
 await test('旧气泡清理失败时保留状态，后续操作能重试且不误删原消息',async()=>{const t=instance(legacy(auth(2)));accurateApi();const {first}=await split(t);const normal=apiHook;apiHook=async(m,p)=>m==='editMessageReplyMarkup'&&p.message_id===first?Response.json({ok:false,error_code:429,description:'slow down'}):normal(m,p);await command(t,101);assert.equal(await live(t,1),true);apiHook=normal;await command(t,102);assert.equal(await live(t,1),false);assert.ok(!deletes().some(r=>r.payload.message_id===first));});
 await test('重建协调器后，旧分隔删除仍能合并并保留源消息映射',async()=>{const t=instance(legacy(auth(2)));accurateApi();const {first,second}=await split(t);const rebuilt=instance(t.kv,t.storage);await command(rebuilt,101);assert.ok(gone(first));assert.ok(!gone(second));assert.equal(await rebuilt.bot.store.get('msg_'+first),'2');await rebuilt.drain();});
 await test('重复Webhook不追加历史分隔，不重复删气泡或重发控制台',async()=>{const t=instance(legacy(auth(2)));accurateApi();const {first}=await split(t);await command(t,101);const before=JSON.stringify(await history(t)),count=markupEdits().length;await t.bot.fetch(update(1,101,'/admin'));await t.drain();assert.equal(JSON.stringify(await history(t)),before);assert.equal(markupEdits().length,count);assert.ok(gone(first));});
 await test('原生转发的引用气泡合并只删除旧身份卡片，原作者原按钮和源内容保留',async()=>{const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(forwarded(1));await t.drain();const first=(await orig(t,2,1)).relayedId,oldCard=cards().at(-1).payload;const oldId=JSON.parse(await t.bot.store.get('ui_relay_contact_1_2')).messageId;await command(t,100);pause();await t.bot.fetch(forwarded(2));await t.drain();const second=(await orig(t,2,2)).relayedId,newId=JSON.parse(await t.bot.store.get('ui_relay_contact_1_2')).messageId;await command(t,101);assert.ok(deletes().some(r=>r.payload.message_id===oldId));assert.ok(!deletes().some(r=>[first,second,newId].includes(r.payload.message_id)));assert.equal(await t.bot.store.get('msg_'+first),'2');assert.equal(await t.bot.store.get('msg_'+oldId),null);assert.equal(await t.bot.store.get('msg_'+newId),'2');assert.ok(oldCard.reply_parameters);});
 await test('原生转发能挂昵称的情况，合并恢复原按钮，不改写转发来源',async()=>{const t=instance(legacy(auth(2)));accurateApi();const original={inline_keyboard:[[{text:'资源',url:'https://example.com'}]]};await t.bot.fetch(native(1,{reply_markup:original}));await t.drain();const first=(await orig(t,2,1)).relayedId;await command(t,100);pause();await t.bot.fetch(native(2,{reply_markup:original}));await t.drain();await command(t,101);const clean=markupEdits().findLast(r=>r.payload.message_id===first);assert.deepEqual(clean.payload.reply_markup,original);assert.ok(!deletes().some(r=>r.payload.message_id===first));});
 await test('引用气泡与普通内联气泡混合也合并，回复任意原消息仍映射正确',async()=>{for(const quoteFirst of [false,true]){const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(quoteFirst?forwarded(1):update(2,1,'普通'));await t.drain();const pointer=JSON.parse(await t.bot.store.get('ui_relay_contact_1_2')),first=(await orig(t,2,1)).relayedId;await command(t,100);pause();await t.bot.fetch(quoteFirst?update(2,2,'普通'):forwarded(2));await t.drain();await command(t,101);assert.equal(await live(t,1),false);assert.equal(await t.bot.store.get('msg_'+first),'2');if(quoteFirst)assert.ok(deletes().some(r=>r.payload.message_id===pointer.messageId));else assert.ok(gone(first));requests=[];}});
 await test('合并后编辑前文不重新长出旧气泡，当前组身份保持',async()=>{const t=instance(legacy(auth(2)));accurateApi();const {first,second}=await split(t);await command(t,101);requests=[];await t.bot.fetch(edited(2,1,'修订前文'));const payload=nativeEdit();assert.equal(payload.message_id,first);assert.equal(payload.text,'修订前文');assert.equal(contactRows(payload).length,0);assert.equal(await live(t,2),true);assert.ok(!gone(second));await t.drain();});
 await test('访客自身/start替换不移除管理员对话中的分隔和身份',async()=>{const t=instance(legacy(auth(2)));accurateApi();const {first}=await split(t);await t.bot.fetch(update(2,20,'/start'));await t.drain();await t.bot.fetch(update(2,21,'/start'));await t.drain();assert.ok(!gone(first));assert.equal(await live(t,1),true);});
 await test('原位按钮切换保持原来连续消息合并行为',async()=>{const t=instance(legacy(auth(2)));accurateApi();const first=await visitor(t,1);await t.bot.fetch(callback('away_settings'));const second=await visitor(t,2);assert.ok(gone(first));assert.ok(!gone(second));});
 await test('未记录具体ID的持久提示保守保留分隔，不能因无关删除误合并',async()=>{const t=instance(legacy(auth(2)));accurateApi();const first=await visitor(t,1);await runtime.interruptVisitorRelayGroup(rEnv(t),rCfg(t));const second=await visitor(t,2);await runtime.deleteMessage('1',99999,rCfg(t));assert.ok(!gone(first));assert.ok(!gone(second));});
 await test('旧版本仍有效的连续组可以安全接续，已丢失的旧分隔不猜测回溯',async()=>{const t=instance(legacy(auth(2)));accurateApi();const pointer={userId:'2',sourceId:10,messageId:555,kind:'inline',baseMarkup:{inline_keyboard:[]}};await t.bot.store.put('ui_relay_group_1',JSON.stringify(pointer));await t.bot.store.put('msg_555','2');await visitor(t,1);assert.ok(gone(555));assert.equal(await t.bot.store.get('msg_555'),'2');});
 await test('历史索引限制256个紧凑事件，保留实际消息分隔，不无界堆积大键盘',async()=>{const t=instance(legacy(auth(2)));accurateApi();const first=await visitor(t,1);for(let i=0;i<270;i++)await runtime.interruptVisitorRelayGroup(rEnv(t),rCfg(t),20000+i);await visitor(t,2);const entries=await history(t);assert.ok(entries.length<=256);assert.ok(!gone(first));assert.ok(entries.every(e=>!('baseMarkup' in e)));await t.drain();});

 await test('单条留言和随后相册之间的旧管理员界面清理后合并，仍只保留一个相册入口',async()=>{const t=instance(legacy(auth(2)));accurateApi();const first=await visitor(t,1);await command(t,100);pause();await t.bot.fetch(album(2,'after_command',2));await t.bot.fetch(album(2,'after_command',3));clock+=4000;await t.bot.alarm();await t.drain();const second=(await orig(t,2,2)).relayedId,third=(await orig(t,2,3)).relayedId;await command(t,101);assert.ok(gone(first));assert.ok(!gone(second));assert.equal(await live(t,2),true);assert.equal(await live(t,3),false);assert.equal(await t.bot.store.get('msg_'+third),'2');});
 await test('相册前一组和后来文字合并只收起旧相册入口，不删除任何成员',async()=>{const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(album(2,'before_command',1));await t.bot.fetch(album(2,'before_command',2));clock+=4000;await t.bot.alarm();await t.drain();const first=(await orig(t,2,1)).relayedId,second=(await orig(t,2,2)).relayedId;await command(t,100);const last=await visitor(t,3);await command(t,101);assert.ok(gone(first));assert.ok(!gone(last));assert.ok(!deletes().some(r=>[first,second].includes(r.payload.message_id)));assert.equal(await t.bot.store.get('msg_'+second),'2');});
 await test('并行分隔记录与并行删除不会覆盖历史，最后一个分隔删除后才合并',async()=>{const t=instance(legacy(auth(2)));accurateApi();const first=await visitor(t,1);await Promise.all([runtime.interruptVisitorRelayGroup(rEnv(t),rCfg(t),200),runtime.interruptVisitorRelayGroup(rEnv(t),rCfg(t),201)]);const last=await visitor(t,2);await Promise.all([runtime.removeVisitorRelaySeparators([200],rEnv(t),rCfg(t)),runtime.removeVisitorRelaySeparators([201],rEnv(t),rCfg(t))]);assert.ok(gone(first));assert.ok(!gone(last));assert.equal((await history(t)).filter(e=>!e.barrier).length,1);});
 console.log(passed+' relay separator merge checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
