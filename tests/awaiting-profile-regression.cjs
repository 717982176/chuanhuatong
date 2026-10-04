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
const pendingSearch=async t=>JSON.parse(await t.bot.store.get('admin_input_1'));
const native=(mid,extra={})=>update(2,mid,'原文',{forward_origin:channel,...extra});
const contactRows=payload=>payload.reply_markup?.inline_keyboard.flat().filter(b=>b.callback_data?.startsWith('nfocus:'))||[];
const cleared=id=>markupEdits().filter(r=>r.payload.message_id===id&&contactRows(r.payload).length===0);
const deleted=id=>deletes().filter(r=>r.payload.chat_id==='1'&&r.payload.message_id===id);
const day=86400000;
const pendingRecord=(id, entries, extra={})=>['inbox_'+id,JSON.stringify({pendingIds:entries.map(e=>e[0]),pendingAt:Object.fromEntries(entries),seenIds:entries.map(e=>e[0]),incomingAt:entries.at(-1)?.[1]||clock,...extra})];
const mainView=()=>requests.findLast(r=>r.method==='editMessageText')?.payload;
const buttons=()=>mainView()?.reply_markup.inline_keyboard.flat()||[];
const remaining=async(t,id)=>JSON.parse(await t.bot.store.get('inbox_'+id)).pendingIds;
const profiles=async(t,id)=>JSON.parse(await t.bot.store.get('profile_'+id));
const profileRecord=(id,name='Alice',username='elaine')=>['profile_'+id,JSON.stringify({id:String(id),firstName:name,username,savedAt:clock})];
const confirmClear=()=>buttons().find(b=>b.callback_data?.startsWith('awaiting_confirm:'))?.callback_data;
(async()=>{
  await test('搜索标题和强制回复说明不重复，仍有取消及回复输入框',async()=>{
    const t=instance();accurateApi();await t.bot.fetch(callback('contact_search'));
    const top=mainView(),prompt=requests.findLast(r=>r.method==='sendMessage'&&r.payload.reply_markup?.force_reply)?.payload;
    assert.equal(top.text,'🔎 搜索联系人');assert.equal(prompt.text,'🔎 输入昵称、用户名、备注或 ID');assert.notEqual(top.text,prompt.text);
    assert.ok(top.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='input_cancel'));assert.ok(await pendingSearch(t));await t.drain();
  });
  await test('默认关闭自动清理，待回复仍显示老消息，列表有清理和设置入口',async()=>{
    const t=instance(legacy([pendingRecord(2,[[1,clock-8*day]]),record(2)]));accurateApi();await t.bot.fetch(callback('awaiting'));
    assert.ok(mainView().text.includes('1 条待回复'));assert.ok(buttons().some(b=>b.callback_data==='awaiting_manage:0'));assert.ok(buttons().some(b=>b.text==='⏱️ 自动清理：关闭'));
    assert.ok(!buttons().some(b=>b.callback_data==='focus_clear'));await t.drain();
  });
  await test('单个清理只移出目标待回复，原聊天映射授权昵称备注及另一人保留',async()=>{
    const t=instance(legacy([pendingRecord(2,[[1,clock],[2,clock]]),pendingRecord(3,[[3,clock]]),...auth(2,3),record(2),['note_2',JSON.stringify({text:'备注'})],['msg_888','2']]));accurateApi();await t.bot.fetch(callback('awaiting_manage:0'));const clear=buttons().find(b=>b.callback_data?.startsWith('awaiting_clear:2:0:')).callback_data;requests=[];
    await t.bot.fetch(callback(clear));assert.deepEqual(await remaining(t,2),[]);assert.deepEqual(await remaining(t,3),[3]);assert.equal(await t.bot.store.get('auth_2'),'true');assert.ok(await t.bot.store.get('note_2'));assert.equal(await t.bot.store.get('msg_888'),'2');
    assert.equal(noAdminCopies().length,0);assert.equal(deletes().length,0);assert.equal(requests.filter(r=>r.method==='sendMessage').length,0);assert.equal(mainView().message_id,100);await t.drain();
  });
  await test('全部清理预览不改数据，确认后只清快照，期间的新消息保留',async()=>{
    const t=instance(legacy([pendingRecord(2,[[1,clock]]),pendingRecord(3,[[3,clock]])]));accurateApi();await t.bot.fetch(callback('awaiting_clear_all'));const confirm=confirmClear();assert.deepEqual(await remaining(t,2),[1]);
    await runtime.recordIncomingMessage('2',2,t.bot.store);await runtime.recordIncomingMessage('4',4,t.bot.store);
    await t.bot.fetch(callback(confirm));assert.deepEqual(await remaining(t,2),[2]);assert.deepEqual(await remaining(t,3),[]);assert.deepEqual(await remaining(t,4),[4]);assert.equal(mainView().message_id,100);
    await t.bot.fetch(callback(confirm));assert.deepEqual(await remaining(t,2),[2]);await t.drain();
  });
  await test('全部清理取消或五分钟过期后确认不会清除消息',async()=>{
    for(const cancel of [true,false]){const t=instance(legacy([pendingRecord(2,[[1,clock]])]));accurateApi();await t.bot.fetch(callback('awaiting_clear_all'));const confirm=confirmClear();if(cancel)await t.bot.fetch(callback('awaiting_manage:0'));else clock+=300001;await t.bot.fetch(callback(confirm));assert.deepEqual(await remaining(t,2),[1]);await t.drain();requests=[];}
  });
  await test('设置3/5/7天和关闭原位更新，重建后仍保留，非法值不写设置',async()=>{
    const t=instance();accurateApi();for(const value of [3,5,7,0]){await t.bot.fetch(callback('awaiting_set:'+value));assert.equal(await t.bot.store.get('settings_awaiting'),String(value));assert.ok(buttons().find(b=>b.callback_data==='awaiting_set:'+value).text.startsWith('✓ '));}
    await t.bot.fetch(callback('awaiting_set:4'));assert.equal(await t.bot.store.get('settings_awaiting'),'0');await t.bot.fetch(callback('awaiting_set:7'));
    const rebuilt=instance(t.kv,t.storage);await rebuilt.bot.fetch(callback('awaiting_settings'));assert.ok(mainView().text.includes('当前：7天'));await rebuilt.drain();await t.drain();
  });
  await test('逐条过期：同一人有旧和新消息，只清旧消息，不被新留言续期',async()=>{
    const t=instance(legacy([pendingRecord(2,[[1,clock-4*day],[2,clock-day]]),record(2)]));accurateApi();await t.bot.fetch(callback('awaiting_set:3'));assert.deepEqual(await remaining(t,2),[2]);await runtime.recordIncomingMessage('2',3,t.bot.store);assert.deepEqual(await remaining(t,2),[2,3]);await t.drain();
  });
  await test('3天精确边界、5天及7天阈值，未知时间旧记录保守保留',async()=>{
    for(const days of [3,5,7]){const t=instance(legacy([pendingRecord(2,[[1,clock-days*day],[2,clock-days*day+1]]),['inbox_3',JSON.stringify({pendingIds:[3],seenIds:[3]})]]));accurateApi();await t.bot.fetch(callback('awaiting_set:'+days));assert.deepEqual(await remaining(t,2),[2]);assert.deepEqual(await remaining(t,3),[3]);await t.drain();requests=[];}
  });
  await test('旧版记录无逐条时间按最后收到时间兼容，未过期的保留',async()=>{
    const t=instance(legacy([['inbox_2',JSON.stringify({pendingIds:[1,2],seenIds:[1,2],incomingAt:clock-4*day})],['inbox_3',JSON.stringify({pendingIds:[3],seenIds:[3],incomingAt:clock-day})]]));accurateApi();await t.bot.fetch(callback('awaiting_set:3'));assert.deepEqual(await remaining(t,2),[]);assert.deepEqual(await remaining(t,3),[3]);await t.drain();
  });
  await test('后台alarm自动清理，授权/会话/回复映射保留，无额外Telegram通知',async()=>{
    const t=instance(legacy([['settings_awaiting','3'],pendingRecord(2,[[1,clock-2*day]]),...auth(2),record(2),['msg_888','2']]));accurateApi();clock+=day;await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');await t.bot.alarm();
    assert.deepEqual(await remaining(t,2),[]);assert.equal(await t.bot.store.get('msg_888'),'2');assert.equal(await t.bot.store.get('auth_2'),'true');assert.equal((await runtime.getActiveAdminTarget(t.bot.store,'1')).userId,'2');assert.equal(requests.length,0);await t.drain();
  });
  await test('未等后台alarm时所有列表待回复徽标一致，过期不继续优先排序',async()=>{
    const t=instance(legacy([['settings_awaiting','3'],pendingRecord(2,[[1,clock-4*day]]),...auth(2),record(2)]));accurateApi();const statuses=await runtime.loadUserStatuses(t.bot.store,['2']);assert.equal(statuses.get('2').pendingCount,0);
    const authed=await runtime.buildAuthedUsersText(t.bot.store,'1',rCfg(t));assert.ok(!authed.text.includes('📬'));assert.equal((await runtime.awaitingContacts(t.bot.store,'1')).length,0);await t.drain();
  });
  await test('手动及自动清理后的历史编辑不复活待回复，真正新留言重新进入',async()=>{
    for(const manual of [true,false]){const t=instance(legacy([pendingRecord(2,[[1,clock-4*day]])]));accurateApi();if(manual){await t.bot.fetch(callback('awaiting_manage:0'));await t.bot.fetch(callback(buttons().find(b=>b.callback_data?.startsWith('awaiting_clear:2:0:')).callback_data));}else await t.bot.fetch(callback('awaiting_set:3'));await runtime.recordIncomingMessage('2',1,t.bot.store,true);assert.deepEqual(await remaining(t,2),[]);await runtime.recordIncomingMessage('2',2,t.bot.store);assert.deepEqual(await remaining(t,2),[2]);await t.drain();requests=[];}
  });
  await test('管理清理页超过十人有翻页，清空末页后自动回到有效页',async()=>{
    const entries=[];for(let id=2;id<13;id++)entries.push(pendingRecord(id,[[id,clock-id]]),record(id,'用户'+id));const t=instance(legacy(entries));accurateApi();await t.bot.fetch(callback('awaiting_manage:0'));assert.equal(buttons().filter(b=>b.callback_data?.startsWith('awaiting_clear:')).length,10);await t.bot.fetch(callback('awaiting_manage:1'));assert.equal(buttons().filter(b=>b.callback_data?.startsWith('awaiting_clear:')).length,1);await t.bot.fetch(callback(buttons().find(b=>b.callback_data?.startsWith('awaiting_clear:12:1:')).callback_data));assert.ok(buttons().some(b=>b.text==='1 / 1'));assert.equal(buttons().filter(b=>b.callback_data?.startsWith('awaiting_clear:')).length,10);await t.drain();
  });
  await test('访客伪造清理设置确认回调均不修改状态也不泄露列表',async()=>{
    const t=instance(legacy([pendingRecord(2,[[1,clock]])]));accurateApi();for(const data of ['awaiting_clear:2:0','awaiting_set:3','awaiting_clear_all','awaiting_manage:0','awaiting_confirm:0123456789abcdef'])await t.bot.fetch(callback(data,2));assert.deepEqual(await remaining(t,2),[1]);assert.equal(await t.bot.store.get('settings_awaiting'),null);assert.equal(requests.filter(r=>r.method==='editMessageText').length,0);await t.drain();
  });
  await test('持久昵称独立于过期最近记录，已授权列表与切换资料仍有昵称',async()=>{
    const t=instance(legacy([...auth(2),record(2,'Alice',{username:'elaine'})]));accurateApi();await t.bot.alarm();assert.equal((await profiles(t,2)).firstName,'Alice');await t.bot.store.delete('recent_2');requests=[];
    const list=await runtime.buildAuthedUsersText(t.bot.store,'1',rCfg(t));assert.ok(list.text.includes('Alice'));assert.ok(list.text.includes('t.me/elaine'));assert.ok(list.text.includes('30天内无消息'));assert.equal(requests.filter(r=>r.method==='getChat').length,0);assert.equal((await runtime.getRecentUserById(t.bot.store,'2')).updatedAt,0);await t.drain();
  });
  await test('访客新留言刷新持久昵称并支持清除旧username，重建保持最新身份',async()=>{
    const t=instance(legacy([...auth(2),profileRecord(2,'旧名','oldname')]));accurateApi();await t.bot.fetch(update(2,1,'你好',{from:{id:2,first_name:'新名'}}));assert.equal((await profiles(t,2)).firstName,'新名');assert.equal((await profiles(t,2)).username,'');await t.bot.store.delete('recent_2');const rebuilt=instance(t.kv,t.storage);assert.equal((await runtime.getRecentUserById(rebuilt.bot.store,'2')).firstName,'新名');await rebuilt.drain();await t.drain();
  });
  await test('getChat回补成功缓存昵称，后续查询失败仍有名字且不产生假活跃时间',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();const normal=apiHook;apiHook=async(m,p)=>m==='getChat'?Response.json({ok:true,result:{id:2,first_name:'补回名字',username:'realuser'}}):normal(m,p);
    const first=await runtime.buildAuthedUsersText(t.bot.store,'1',rCfg(t));assert.ok(first.text.includes('补回名字'));assert.equal(await t.bot.store.get('recent_2'),null);assert.ok(await profiles(t,2));requests=[];apiHook=async(m,p)=>m==='getChat'?Response.json({ok:false,description:'chat not found'}):normal(m,p);
    const again=await runtime.buildAuthedUsersText(t.bot.store,'1',rCfg(t));assert.ok(again.text.includes('补回名字'));assert.equal(requests.filter(r=>r.method==='getChat').length,0);await t.drain();
  });
  await test('已过期活跃记录有备注昵称时恢复显示，完全未知且查询失败仅用访客ID',async()=>{
    const t=instance(legacy([...auth(2,3),['note_2',JSON.stringify({text:'备注',firstName:'备注存的昵称',username:'knownuser'})]]));accurateApi();const normal=apiHook;apiHook=async(m,p)=>m==='getChat'?Response.json({ok:false,description:'chat not found'}):normal(m,p);
    const view=await runtime.buildAuthedUsersText(t.bot.store,'1',rCfg(t));assert.ok(view.text.includes('备注存的昵称'));assert.ok(view.text.includes('访客3'));assert.ok(await profiles(t,2));assert.equal(await profiles(t,3),null);await t.drain();
  });
  await test('昵称持久资料可被昵称/用户名搜索，保存身份不把旧用户纳入30天最近访客',async()=>{
    const t=instance(legacy([...auth(2),profileRecord(2)]));accurateApi();const name=await runtime.buildContactSearch(t.bot.store,'1','Alice');assert.equal(name.entries.length,1);const user=await runtime.buildContactSearch(t.bot.store,'1','elaine');assert.equal(user.entries.length,1);const recent=await runtime.buildRecentUsersText(t.bot.store);assert.ok(!recent.text.includes('Alice'));await t.drain();
  });
  await test('备份包含昵称与清理设置，可恢复旧版备份；异常资料和设置拒绝',async()=>{
    const t=instance(legacy([...auth(2),profileRecord(2),['settings_awaiting','5']]));accurateApi();const saved=await t.bot.createBackup();assert.ok(saved.entries.some(e=>e.key==='profile_2'));assert.ok(saved.entries.some(e=>e.key==='settings_awaiting'));runtime.snapshotArg=saved;await vm.runInContext("validateBackup(snapshotArg,'1')",runtime);
    for(const entry of [{key:'settings_awaiting',value:'999',expiration:null,metadata:null},{key:'profile_2',value:JSON.stringify({id:'3',firstName:'错人',username:''}),expiration:null,metadata:null}]){const bad=await signBackup(t,[entry]);runtime.snapshotArg=bad;await assert.rejects(vm.runInContext("validateBackup(snapshotArg,'1')",runtime));}
    const old=await signBackup(t,[{key:'auth_2',value:'true',expiration:null,metadata:null}]);await t.bot.stageRestore(old,rCfg(t),100);await t.bot.restoreBackup(restoreNonce(t));assert.equal(await t.bot.store.get('profile_2'),null);assert.equal(await t.bot.store.get('settings_awaiting'),null);await t.drain();
  });
  console.log(passed+' awaiting/profile checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
