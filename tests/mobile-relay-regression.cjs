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
(async()=>{
  await test('恢复文字列表：昵称主页、状态时间与真实ID，原昵称切换按钮且无复制/样式按钮',async()=>{
    clock=new Date('2026-10-04T06:33:00Z').getTime();const t=instance(legacy([record('2','Alice'),...auth('2')]));accurateApi();await t.bot.fetch(callback('recent'));const data=nativeEdit(),buttons=data.reply_markup.inline_keyboard.flat();assert.equal(data.parse_mode,'HTML');assert.equal(data.rich_message,undefined);assert.ok(data.text.includes('Alice'));assert.ok(data.text.includes('tg://user?id=2'));assert.ok(data.text.includes('10/04 14:33'));assert.ok(data.text.includes('<code>2</code>'));assert.ok(buttons.some(b=>b.callback_data==='focus:2'));assert.ok(!buttons.some(b=>b.copy_text||b.callback_data?.startsWith('list_style:')||b.callback_data?.startsWith('contact_detail:')));assert.equal(requests.filter(r=>r.method==='sendRichMessage').length,0);await t.drain();
  });
  await test('最近访客23人文字分页10/10/3，真实ID与昵称切换对应，黑名单不生成切换按钮',async()=>{
    const t=instance(legacy(Array.from({length:23},(_,i)=>record(i+2,'联系人'+i,{updatedAt:clock-i}))));accurateApi();const ids=[];for(let page=0;page<3;page++){await t.bot.fetch(callback('recent_page:'+page));const data=nativeEdit(),codes=[...data.text.matchAll(/<code>([0-9]+)<\/code>/g)].map(m=>m[1]),buttons=data.reply_markup.inline_keyboard.flat();assert.equal(codes.length,[10,10,3][page]);assert.equal(data.message_id,100);ids.push(...codes);assert.equal(buttons.filter(b=>b.callback_data?.startsWith('focus:')).length,codes.length);assert.ok(!buttons.some(b=>b.copy_text));}assert.equal(new Set(ids).size,23);await t.drain();const blocked=instance(legacy([record(2),['lock_2',String(clock+86400000)]]));await blocked.bot.fetch(callback('blacklist'));assert.ok(nativeEdit().text.includes('<code>2</code>'));assert.ok(!nativeEdit().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='focus:2'||b.copy_text));await blocked.drain();
  });
  await test('授权、待回复和搜索也保留文字资料与昵称切换，不附加复制按钮',async()=>{
    const t=instance(legacy([record(2,'Alice',{username:'profile_example'}),...auth(2),['inbox_2',JSON.stringify({pendingIds:[1],seenIds:[1],incomingAt:clock})],['admin_search_1','Alice'],['note_2',JSON.stringify({text:'<b>私有备注</b>'})]]));accurateApi();for(const entry of ['authed','awaiting','search_page:0']){await t.bot.fetch(callback(entry));const data=nativeEdit();assert.equal(data.message_id,100);assert.ok(data.text.includes('<code>2</code>'));assert.ok(data.text.includes('href="https://t.me/profile_example"'));assert.ok(data.text.includes('&lt;b&gt;私有备注&lt;/b&gt;'));assert.ok(!data.reply_markup.inline_keyboard.flat().some(b=>b.copy_text));}await t.drain();
  });
  await test('旧详情按钮兼容显示当前页数字ID；返回恢复文字列表',async()=>{
    const t=instance(legacy(Array.from({length:12},(_,i)=>record(i+2,'昵称'+i,{updatedAt:clock-i}))));accurateApi();await t.bot.fetch(callback('list_details:recent:1'));assert.equal((nativeEdit().text.match(/<code>/g)||[]).length,2);assert.equal(nativeEdit().message_id,100);await t.bot.fetch(callback('contact_detail:12:recent:1'));assert.ok(nativeEdit().text.includes('<code>12</code>'));assert.ok(!nativeEdit().reply_markup.inline_keyboard.flat().some(b=>b.copy_text));await t.bot.fetch(callback('list_style:compact:recent:1'));assert.equal((nativeEdit().text.match(/<code>/g)||[]).length,2);assert.equal(requests.filter(r=>r.method==='sendMessage').length,0);await t.drain();
  });
  await test('旧rich/compact偏好和旧样式按钮自动回到文字列表，兼容旧指令且不误发访客',async()=>{
    for(const pref of ['rich','compact','plain']){const t=instance(legacy([record(2),['ui_list_style_1',pref]]));accurateApi();await t.bot.fetch(callback('recent'));assert.ok(nativeEdit().text.includes('Alice'));assert.equal(nativeEdit().rich_message,undefined);await t.bot.fetch(callback('list_style:rich:recent:0'));assert.equal(await t.bot.store.get('ui_list_style_1'),'plain');assert.ok(nativeEdit().text.includes('<code>2</code>'));await t.bot.fetch(update(1,99,'/list compact'));assert.equal(await t.bot.store.get('ui_list_style_1'),'plain');assert.equal(noAdminCopies().length,0);await t.drain();requests=[];}
  });
  await test('原菜单删除后仅回退一个新文字菜单，保存真实ID以供后续清理',async()=>{
    const t=instance(legacy([record(2)]));accurateApi();const normal=apiHook;apiHook=async(method,payload)=>method==='editMessageText'&&payload.message_id===100?Response.json({ok:false,error_code:400,description:'message to edit not found'}):normal(method,payload);await t.bot.fetch(callback('recent'));const last=requests.findLast(r=>r.method==='sendMessage');assert.ok(last.payload.text.includes('<code>2</code>'));assert.ok(!last.payload.reply_markup.inline_keyboard.flat().some(b=>b.copy_text));const id=(await ui(t,'menu',1)).messageId;await t.bot.fetch(update(1,99,'/admin'));assert.ok(deletes().some(r=>r.payload.message_id===id));await t.drain();
  });
  await test('文字昵称隐私回退保留数字ID、状态与原有切换按钮',async()=>{
    const t=instance(legacy([record(2)]));accurateApi();const normal=apiHook;apiHook=async(method,payload)=>payload.text?.includes('tg://user')?Response.json({ok:false,error_code:400,description:'USER_PRIVACY_RESTRICTED'}):normal(method,payload);await t.bot.fetch(callback('recent'));assert.ok(nativeEdit().text.includes('<code>2</code>'));assert.ok(!nativeEdit().text.includes('tg://user'));assert.ok(nativeEdit().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='focus:2'));await t.drain();
  });
  await test('非管理员或非法详情回调不泄露信息，搜索过期保留原位提示',async()=>{
    const t=instance(legacy([record(2)]));accurateApi();await t.bot.fetch(callback('contact_detail:2:recent:0',3));assert.equal(requests.filter(r=>r.method==='editMessageText').length,0);await t.bot.fetch(callback('contact_detail:99:recent:0'));assert.match(nativeEdit().text,/记录已更新/);await t.bot.fetch(callback('list_style:rich:search:0'));assert.match(nativeEdit().text,/搜索已过期/);await t.drain();
  });
  await test('文字列表网络异常与429不重发，原位结果未修改按成功处理',async()=>{
    for(const failure of ['network','rate','unchanged']){const t=instance(legacy([record(2)]));accurateApi();apiHook=async(method,payload)=>{if(method==='editMessageText'){if(failure==='network')throw Error('response lost');return Response.json({ok:false,error_code:failure==='rate'?429:400,description:failure==='rate'?'Too Many Requests':'message is not modified'});}return null;};const task=runtime.renderContactList(await makeView(t),rEnv(t),rCfg(t),100);if(failure==='unchanged')assert.equal((await task).ok,true);else await assert.rejects(task);assert.equal(requests.filter(r=>r.method==='sendMessage').length,0);requests=[];await t.drain();}
  });
  await test('带外部回调的真实转发使用引用备用，原作者资源按钮不被改写',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(forwarded(1));const origin=await orig(t,2,1),card=cards()[0];assert.equal(requests.filter(r=>r.method==='forwardMessage').length,1);assert.equal(requests.filter(r=>r.method==='copyMessage').length,0);assert.equal(card.payload.text,'⁣');assert.ok(!card.payload.text.includes('转发人'));assert.equal(card.payload.reply_parameters.message_id,origin.relayedId);assert.equal(card.payload.reply_markup.inline_keyboard[0][0].text,'💬 张三😀');assert.equal(markupEdits().length,0);const pointer=JSON.parse(await t.bot.store.get('ui_relay_group_1'));assert.equal(pointer.kind,'quote');assert.equal(await t.bot.store.get('msg_'+pointer.messageId),'2');assert.equal(origin.replyMarkup,null);await t.drain();
  });
  await test('同一访客连续转发只留最新引用卡片，删除卡片而非正文/资源按钮',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(forwarded(1));const first=(await orig(t,2,1)).relayedId,cardId=JSON.parse(await t.bot.store.get('ui_relay_group_1')).messageId;clock+=1100;await t.bot.fetch(forwarded(2));assert.ok(deletes().some(r=>r.payload.message_id===cardId));assert.ok(!deletes().some(r=>r.payload.message_id===first));assert.equal(await t.bot.store.get('msg_'+cardId),null);assert.equal(await t.bot.store.get('msg_'+first),'2');const second=JSON.parse(await t.bot.store.get('ui_relay_group_1'));assert.equal(second.replyToId,(await orig(t,2,2)).relayedId);await t.drain();
  });
  await test('A转发 A转发 B转发 A转发保留三个组身份，聊天双方不混淆',async()=>{
    const t=instance(legacy(auth(2,3)));accurateApi();const ids=[];for(const [user,mid]of [[2,1],[2,2],[3,3],[2,4]]){clock+=1100;await t.bot.fetch(forwarded(mid,user));ids.push(JSON.parse(await t.bot.store.get('ui_relay_group_1')).messageId);}assert.ok(deletes().some(r=>r.payload.message_id===ids[0]));assert.ok(!deletes().some(r=>ids.slice(1).includes(r.payload.message_id)));assert.equal(cards().length,4);await t.drain();
  });
  await test('普通消息和引用卡片在同组切换时清理旧UI，保留所有源内容',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,'自发原文'));const first=(await orig(t,2,1)).relayedId;clock+=1100;await t.bot.fetch(forwarded(2));assert.ok(markupEdits().some(r=>r.payload.message_id===first));const quoted=JSON.parse(await t.bot.store.get('ui_relay_group_1')).messageId;clock+=1100;await t.bot.fetch(update(2,3,'自发第三条'));assert.ok(deletes().some(r=>r.payload.message_id===quoted));assert.ok(!deletes().some(r=>r.payload.message_id===first));assert.equal(await t.bot.store.get('msg_'+first),'2');await t.drain();
  });
  await test('升级前未标记类型的转发人卡片按已存映射清理，不误删原消息',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.store.put('origin_2_1',JSON.stringify({relayedId:500,kind:'visitor'}));await t.bot.store.put('ui_relay_group_1',JSON.stringify({userId:'2',sourceId:1,messageId:501,baseMarkup:{inline_keyboard:[]}}));await t.bot.store.put('msg_500','2');await t.bot.store.put('msg_501','2');await t.bot.fetch(forwarded(2));assert.ok(deletes().some(r=>r.payload.message_id===501));assert.ok(!deletes().some(r=>r.payload.message_id===500));assert.equal(await t.bot.store.get('msg_500'),'2');await t.drain();
  });
  await test('引用卡片占位明确被拒绝才退回气泡，网络未知不自动重发卡片',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();const normal=apiHook;apiHook=async(method,payload)=>method==='sendMessage'&&payload.text==='⁣'?Response.json({ok:false,error_code:400,description:'message text is empty'}):normal(method,payload);await t.bot.fetch(forwarded(1));assert.equal(cards().length,2);assert.equal(cards()[1].payload.text,'💬');await t.drain();const t2=instance(legacy(auth(2)));accurateApi();const normal2=apiHook;apiHook=async(method,payload)=>{if(method==='sendMessage'&&payload.text==='⁣')throw Error('unknown outcome');return normal2(method,payload);};requests=[];await t2.bot.fetch(forwarded(2));assert.equal(cards().length,1);assert.equal(requests.filter(r=>r.method==='forwardMessage').length,1);await t2.drain();
  });
  await test('引用分组指针重建后继续清旧卡片，重复Webhook不重复转发或引用',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(forwarded(1));await t.bot.fetch(forwarded(1));assert.equal(cards().length,1);const old=JSON.parse(await t.bot.store.get('ui_relay_group_1')).messageId;await t.drain();clock+=1100;const restart=instance(t.kv,t.storage);await restart.bot.fetch(forwarded(2));assert.ok(deletes().some(r=>r.payload.message_id===old));await restart.drain();
  });
  await test('转发相册保留原生作者和原按钮，只加一张实际访客引用',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,undefined,{...photo('one'),media_group_id:'forward_album',forward_origin:channel,reply_markup:resources}));await t.bot.fetch(update(2,2,undefined,{...photo('two'),media_group_id:'forward_album',forward_origin:channel}));await mature(t);assert.equal(requests.filter(r=>r.method==='forwardMessages').length,1);assert.equal(cards().length,1);assert.equal(markupEdits().length,0);assert.equal(cards()[0].payload.reply_parameters.message_id,(await orig(t,2,1)).relayedId);
  });
  await test('管理员转发不重建其他机器人按钮，也不另发身份提示',async()=>{
    const t=instance();accurateApi();await runtime.setActiveAdminTarget(t.bot.store,'1','2','访客');await t.bot.fetch(update(1,1,'来源',{forward_origin:channel,reply_markup:resources}));assert.equal(requests.find(r=>r.method==='forwardMessage').payload.chat_id,'2');assert.equal(markupEdits().length,0);assert.equal(cards().length,0);await t.drain();
  });
  await test('自发贴纸/语音/骰子复制发送，不出现虚假的转发来源或额外引用',async()=>{
    for(const extra of [{sticker:{file_id:'STICKER'}},{voice:{file_id:'VOICE'}},{dice:{emoji:'🎲',value:2}}]){const t=instance(legacy(auth(2)));accurateApi();requests=[];await t.bot.fetch(update(2,1,undefined,{...extra,text:undefined}));assert.equal(requests.filter(r=>r.method==='copyMessage').length,1);assert.equal(requests.filter(r=>r.method==='forwardMessage').length,0);assert.equal(cards().length,0);assert.equal(requests.find(r=>r.method==='copyMessage').payload.reply_markup.inline_keyboard[0][0].text,'💬 张三😀');await t.drain();}
  });
  await test('真正转发的贴纸仍保留真实作者，已知不可复制内容不误走copy',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,undefined,{text:undefined,sticker:{file_id:'S'},forward_origin:channel}));assert.equal(requests.filter(r=>r.method==='forwardMessage').length,1);assert.equal(cards().length,0);assert.equal(markupEdits().length,1);assert.equal(runtime.canCopyRelayMessage({paid_media:{}}),false);assert.equal(runtime.canCopyRelayMessage({invoice:{}}),false);assert.equal(runtime.canCopyRelayMessage({poll:{type:'quiz'}}),false);await t.drain();
  });
  await test('访客A、管理员普通消息、访客A开启两组；新组连续发送只清理新组旧按钮',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,'第一组'));const first=(await orig(t,2,1)).relayedId;await t.bot.fetch(update(1,99,'管理员插入'));clock+=1100;await t.bot.fetch(update(2,2,'第二组'));const second=(await orig(t,2,2)).relayedId;clock+=1100;await t.bot.fetch(update(2,3,'第二组第二条'));assert.ok(!markupEdits().some(r=>r.payload.message_id===first));assert.ok(markupEdits().some(r=>r.payload.message_id===second));assert.equal(await t.bot.store.get('msg_'+first),'2');assert.equal((await orig(t,2,1)).relayContact,true);await t.drain();
  });
  await test('管理员实际回复后，同一访客继续留言不会移除回复前的昵称气泡',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,'原留言'));const first=(await orig(t,2,1)).relayedId;await t.bot.fetch(update(1,99,'回复',{reply_to_message:{message_id:first}}));assert.ok(noAdminCopies().some(r=>r.payload.chat_id==='2'));clock+=1100;await t.bot.fetch(update(2,2,'追问'));assert.ok(!markupEdits().some(r=>r.payload.message_id===first));assert.equal(await t.bot.store.get('msg_'+first),'2');await t.drain();
  });
  await test('管理员指令、定向推送、备注、照片与贴纸均形成身份分组边界',async()=>{
    for(const [text,extra]of [['/admin',{}],['/start',{}],['/send 2 hi',{}],['/note 2 备注',{}],['/unknown',{}],['',{photo:[{file_id:'admin_photo'}]}],['',{sticker:{file_id:'admin_sticker'}}]]){const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,'前文'));const first=(await orig(t,2,1)).relayedId;await t.bot.fetch(update(1,99,text,extra));clock+=1100;await t.bot.fetch(update(2,2,'后文'));assert.ok(!markupEdits().some(r=>r.payload.message_id===first),text);assert.equal((await orig(t,2,1)).relayContact,true);await t.drain();requests=[];}
  });
  await test('真实转发、管理员菜单、真实转发保留两张引用；随后仅清理新组的旧引用',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(forwarded(1));const firstCard=JSON.parse(await t.bot.store.get('ui_relay_group_1')).messageId;await t.bot.fetch(update(1,99,'/admin'));clock+=1100;await t.bot.fetch(forwarded(2));const secondCard=JSON.parse(await t.bot.store.get('ui_relay_group_1')).messageId;clock+=1100;await t.bot.fetch(forwarded(3));assert.ok(!deletes().some(r=>r.payload.message_id===firstCard));assert.ok(deletes().some(r=>r.payload.message_id===secondCard));assert.equal(await t.bot.store.get('msg_'+firstCard),'2');await t.drain();
  });
  await test('引用与普通留言在管理员插入后不跨组删除身份，原转发按钮不改写',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(forwarded(1));const firstCard=JSON.parse(await t.bot.store.get('ui_relay_group_1')).messageId;await t.bot.fetch(update(1,99,'插入'));clock+=1100;await t.bot.fetch(update(2,2,'自发内容'));assert.ok(!deletes().some(r=>r.payload.message_id===firstCard));assert.equal(markupEdits().length,0);await t.drain();
  });
  await test('管理员插入后编辑旧组原文仍保留旧昵称气泡，不改变新组归属',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,'1'));const first=(await orig(t,2,1)).relayedId;await t.bot.fetch(update(1,99,'插入'));clock+=1100;await t.bot.fetch(update(2,2,'新组'));const second=JSON.parse(await t.bot.store.get('ui_relay_group_1')).messageId;await t.bot.fetch(edited(2,1,'2'));assert.equal(nativeEdit().message_id,first);assert.equal(nativeEdit().text,'2');assert.ok(nativeEdit().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='nfocus:2'));assert.equal(JSON.parse(await t.bot.store.get('ui_relay_group_1')).messageId,second);await t.drain();
  });
  await test('协调器重建后仍保留管理员造成的分组中断与旧回复映射',async()=>{
    let t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,'前文'));const first=(await orig(t,2,1)).relayedId;await t.bot.fetch(update(1,99,'插入'));await t.drain();t=instance(t.kv,t.storage);clock+=1100;await t.bot.fetch(update(2,2,'后文'));assert.ok(!markupEdits().some(r=>r.payload.message_id===first));assert.equal(await t.bot.store.get('msg_'+first),'2');await t.drain();
  });
  await test('已处理的管理员消息重投不再次截断最新访客组',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,'前文'));const first=(await orig(t,2,1)).relayedId;await t.bot.fetch(update(1,99,'插入'));clock+=1100;await t.bot.fetch(update(2,2,'后文'));const second=(await orig(t,2,2)).relayedId;await t.bot.fetch(update(1,99,'插入'));clock+=1100;await t.bot.fetch(update(2,3,'后文第二条'));assert.ok(!markupEdits().some(r=>r.payload.message_id===first));assert.ok(markupEdits().some(r=>r.payload.message_id===second));await t.drain();
  });
  await test('菜单原位开关没有新增消息，不截断访客连续消息组',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,'前文'));const first=(await orig(t,2,1)).relayedId;await t.bot.fetch(callback('away_settings'));clock+=1100;await t.bot.fetch(update(2,2,'后文'));assert.ok(markupEdits().some(r=>r.payload.message_id===first));await t.drain();
  });
  await test('快捷按钮产生常驻回复记录后开启新组，保留回复前的访客气泡',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,'前文'));const first=(await orig(t,2,1)).relayedId;await runtime.showQuickReplies('2',rEnv(t),rCfg(t),100);const payload=quickPayload().payload;const send=payload.reply_markup.inline_keyboard[0][0].callback_data;await t.bot.fetch(callback(send));assert.ok(requests.some(r=>r.payload.text?.includes('快捷回复已发送')));clock+=1100;await t.bot.fetch(update(2,2,'后文'));assert.ok(!markupEdits().some(r=>r.payload.message_id===first));await t.drain();
  });
  await test('管理员常驻提示和新控制台均截断分组，临时回执不截断',async()=>{
    for(const kind of ['persistent','new_menu','temporary']){const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,'前文'));const first=(await orig(t,2,1)).relayedId;if(kind==='persistent')await runtime.sendMessage('1','系统提示',rEnv(t),rCfg(t));if(kind==='new_menu')await runtime.renderAdminView('新控制台',runtime.getBackToMenuButtons(),rEnv(t),rCfg(t));if(kind==='temporary')await runtime.sendAutoDeleteHtmlMessage('1','临时回执',rEnv(t),rCfg(t));await t.drain();clock+=1100;await t.bot.fetch(update(2,2,'后文'));assert.equal(markupEdits().some(r=>r.payload.message_id===first),kind==='temporary');await t.drain();requests=[];}
  });
  await test('文字1改2只更新原消息为2，实体格式保留且不注入edited',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,'1'));const old=await orig(t,2,1);await t.drain();requests=[];await t.bot.fetch(edited(2,1,'2',Math.floor(clock/1000),{entities:[{type:'bold',offset:0,length:1}]}));assert.equal(nativeEdit().message_id,old.relayedId);assert.equal(nativeEdit().text,'2');assert.deepEqual(nativeEdit().entities,[{type:'bold',offset:0,length:1}]);assert.equal(requests.filter(r=>r.method==='sendMessage').length,0);await t.drain();
  });
  await test('图片替换调用原生编辑同一张，说明实体和联系人按钮保留',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,undefined,{...photo('old'),caption:'原图',show_caption_above_media:true}));const old=await orig(t,2,1);await t.drain();requests=[];await t.bot.fetch(edited(2,1,undefined,Math.floor(clock/1000),{...photo('new'),caption:'😀新图',caption_entities:[{type:'bold',offset:2,length:2}]}));const edit=medias()[0].payload;assert.equal(edit.message_id,old.relayedId);assert.equal(edit.media.media,'file_new');assert.equal(edit.media.show_caption_above_media,true);assert.equal(edit.media.caption,'😀新图');assert.deepEqual(edit.media.caption_entities,[{type:'bold',offset:2,length:2}]);assert.equal(edit.reply_markup.inline_keyboard[0][0].callback_data,'nfocus:2');assert.equal(requests.filter(r=>['sendPhoto','copyMessage'].includes(r.method)).length,0);assert.equal(await t.bot.store.get('msg_'+old.relayedId),'2');await t.drain();
  });
  await test('无说明图片替换后保持空说明；重复与旧版本不再编辑',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,undefined,photo('old')));await t.drain();requests=[];const date=Math.floor(clock/1000);await t.bot.fetch(edited(2,1,undefined,date,photo('new')));assert.equal(medias()[0].payload.media.caption,'');assert.deepEqual(medias()[0].payload.media.caption_entities,[]);await t.bot.fetch(edited(2,1,undefined,date,photo('new')));await t.bot.fetch(edited(2,1,undefined,date-1,photo('old')));assert.equal(medias().length,1);await t.drain();
  });
  await test('仅改图片说明用editCaption，稳定unique_id的另一file_id不当成换图',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,undefined,{...photo('old'),caption:'原文'}));await t.drain();requests=[];await t.bot.fetch(edited(2,1,undefined,Math.floor(clock/1000),{...photo('old'),caption:'新文'}));assert.equal(medias().length,0);assert.equal(requests.filter(r=>r.method==='editMessageCaption').length,1);await t.bot.fetch(edited(2,1,undefined,Math.floor(clock/1000)+1,{photo:[{file_id:'alias',file_unique_id:'unique_old'}],caption:'新文'}));assert.equal(requests.filter(r=>r.method==='editMessageCaption').length,1);await t.drain();
  });
  await test('管理员换图固定原收件人，切换会话不改另一人',async()=>{
    const t=instance();accurateApi();await runtime.setActiveAdminTarget(t.bot.store,'1','2','原对象');await t.bot.fetch(update(1,1,undefined,{...photo('old'),caption:'说明'}));await t.drain();await runtime.setActiveAdminTarget(t.bot.store,'1','3','新对象');requests=[];await t.bot.fetch(edited(1,1,undefined,Math.floor(clock/1000),{...photo('new'),caption:'新说明'}));assert.equal(medias()[0].payload.chat_id,'2');assert.equal(requests.filter(r=>r.method==='copyMessage').length,0);await t.drain();
  });
  await test('换图429合并最新文件并重建恢复，同一消息ID更新',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,undefined,photo('old')));const old=await orig(t,2,1);await t.drain();requests=[];const normal=apiHook;let failed=false;apiHook=async(method,payload)=>{if(method==='editMessageMedia'&&!failed){failed=true;return Response.json({ok:false,error_code:429,description:'Too Many Requests',parameters:{retry_after:2}});}return normal(method,payload);};const date=Math.floor(clock/1000);await t.bot.fetch(edited(2,1,undefined,date,photo('B')));await t.bot.fetch(edited(2,1,undefined,date+1,photo('C')));assert.equal(medias().length,1);const restart=instance(t.kv,t.storage);clock+=4000;await restart.bot.alarm();assert.equal(medias().length,2);assert.equal(medias()[1].payload.media.media,'file_C');assert.equal(medias()[1].payload.message_id,old.relayedId);await restart.drain();
  });
  await test('相册换第二张定位正确成员，不拆分相册或另发图',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,undefined,{...photo('one'),media_group_id:'album'}));await t.bot.fetch(update(2,2,undefined,{...photo('two'),media_group_id:'album',caption:'原文'}));await mature(t);const second=await orig(t,2,2);requests=[];await t.bot.fetch(edited(2,2,undefined,Math.floor(clock/1000),{...photo('replacement'),media_group_id:'album',caption:'新版'}));assert.equal(medias()[0].payload.message_id,second.relayedId);assert.equal(medias()[0].payload.media.caption,'新版');assert.equal(requests.filter(r=>r.method==='sendPhoto').length,0);await t.drain();
  });
  await test('嵌套媒体caption的隐私提及拒绝回退，保留粗体和原文',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,undefined,photo('old')));await t.drain();requests=[];const normal=apiHook;apiHook=async(method,payload)=>method==='editMessageMedia'&&payload.media.caption_entities.some(e=>e.type==='text_mention')?Response.json({ok:false,error_code:400,description:'USER_PRIVACY_RESTRICTED'}):normal(method,payload);await t.bot.fetch(edited(2,1,undefined,Math.floor(clock/1000),{...photo('new'),caption:'甲乙',caption_entities:[{type:'text_mention',offset:0,length:1,user:{id:5,first_name:'甲'}},{type:'bold',offset:1,length:1}]}));assert.equal(medias().length,2);assert.ok(!medias()[1].payload.media.caption_entities.some(e=>e.type==='text_mention'));assert.equal(medias()[1].payload.media.caption_entities.at(-1).type,'bold');await t.drain();
  });
  await test('图片同步网络响应未知只重试同ID，不新增照片',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,undefined,photo('old')));const old=await orig(t,2,1);await t.drain();requests=[];const normal=apiHook;let failed=false;apiHook=async(method,payload)=>{if(method==='editMessageMedia'&&!failed){failed=true;throw Error('response lost');}return normal(method,payload);};await t.bot.fetch(edited(2,1,undefined,Math.floor(clock/1000),photo('new')));clock+=4000;await t.bot.alarm();assert.equal(medias().length,2);assert.ok(medias().every(r=>r.payload.message_id===old.relayedId));assert.equal(requests.filter(r=>r.method==='sendPhoto').length,0);await t.drain();
  });
  await test('限流换图后改回已送达原图取消旧队列，不最终替换成过时文件',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,undefined,photo('old')));await t.drain();requests=[];const normal=apiHook;apiHook=async(method,payload)=>method==='editMessageMedia'?Response.json({ok:false,error_code:429,description:'rate',parameters:{retry_after:2}}):normal(method,payload);const date=Math.floor(clock/1000);await t.bot.fetch(edited(2,1,undefined,date,photo('new')));await t.bot.fetch(edited(2,1,undefined,date+1,photo('old')));assert.equal([...t.storage.data.keys()].filter(k=>k.startsWith('e:')).length,0);clock+=4000;await t.bot.alarm();assert.equal(medias().length,1);await t.drain();
  });
  await test('相册收集中换图保留最新文件基线，送达后再次换图仍定位成员',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,undefined,{...photo('old'),media_group_id:'collect_edit'}));await t.bot.fetch(edited(2,1,undefined,Math.floor(clock/1000),{...photo('B'),media_group_id:'collect_edit'}));await mature(t);assert.equal((await orig(t,2,1)).mediaKey,'photo:unique_B');requests=[];await t.bot.fetch(edited(2,1,undefined,Math.floor(clock/1000)+1,{...photo('C'),media_group_id:'collect_edit'}));assert.equal(medias()[0].payload.media.media,'file_C');await t.drain();
  });
  await test('仅切换图片剧透标志也编辑原媒体，重新关闭时清除剧透',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,undefined,photo('old')));await t.drain();requests=[];const date=Math.floor(clock/1000);await t.bot.fetch(edited(2,1,undefined,date,{...photo('old'),has_media_spoiler:true}));assert.equal(medias()[0].payload.media.has_spoiler,true);await t.bot.fetch(edited(2,1,undefined,date+1,photo('old')));assert.equal(medias()[1].payload.media.has_spoiler,false);await t.drain();
  });
  await test('不可编辑转发图换图只创建一次可回复修订图，以后继续编辑修订图',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,undefined,{...photo('old'),forward_origin:channel}));const old=await orig(t,2,1);await t.drain();requests=[];const normal=apiHook;apiHook=async(method,payload)=>method==='editMessageMedia'&&payload.message_id===old.relayedId?Response.json({ok:false,error_code:400,description:"message can't be edited"}):normal(method,payload);const date=Math.floor(clock/1000);await t.bot.fetch(edited(2,1,undefined,date,photo('B')));const correction=(await orig(t,2,1)).correctionId;assert.ok(correction);assert.equal(requests.filter(r=>r.method==='sendPhoto').length,1);await t.bot.fetch(edited(2,1,undefined,date+1,photo('C')));assert.equal(medias().at(-1).payload.message_id,correction);assert.equal(requests.filter(r=>r.method==='sendPhoto').length,1);assert.equal(await t.bot.store.get('msg_'+correction),'2');await t.drain();
  });
  await test('老版forward字段也走真正转发；Webhook重复投递不重复加按钮',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();const message=()=>update(2,1,'来源',{forward_date:1,forward_from_chat:{id:-100123456,username:'example_channel'},forward_from_message_id:10});await t.bot.fetch(message());await t.bot.fetch(message());assert.equal(requests.filter(r=>r.method==='forwardMessage').length,1);assert.equal(markupEdits().length,1);assert.equal(cards().length,0);await t.drain();
  });
  await test('联系人分组指针重建后继续清理同组上一条，旧回复映射保留',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,'第一条'));const old=await orig(t,2,1);await t.drain();clock+=1100;const restart=instance(t.kv,t.storage);requests=[];await restart.bot.fetch(update(2,2,'第二条'));assert.ok(markupEdits().some(r=>r.payload.message_id===old.relayedId));assert.equal(await restart.bot.store.get('msg_'+old.relayedId),'2');await restart.drain();
  });
  await test('图片说明满1024字保留全文，不能为添加尾注截断',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,1,undefined,photo('old')));await t.drain();requests=[];const text='字'.repeat(1024);await t.bot.fetch(edited(2,1,undefined,Math.floor(clock/1000),{...photo('new'),caption:text}));assert.equal(medias()[0].payload.media.caption,text);await t.drain();
  });
  console.log(passed+' mobile/relay/native-edit checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
