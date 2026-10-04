const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const source=fs.readFileSync(require('node:path').resolve(__dirname, '../chuanhuatong.js'),'utf8');
let clock=Date.now(),requests=[],mode='ok',release=null;
class Clock extends Date { static now(){return clock;} }
let apiHook=null,downloadBody='{}';
const runtime=vm.createContext({URL,URLSearchParams,Response,Request,TextEncoder,TextDecoder,Blob,FormData,AbortSignal,Date:Clock,crypto:crypto.webcrypto,AbortController,clearTimeout,
  setTimeout:(fn,ms)=>ms===500?(fn(),0):setTimeout(fn,ms),console:{warn(){},error(){},log(){}},
  fetch:async(url,options)=>{
    if(url.includes('/file/bot'))return new Response(downloadBody);
    const method=url.split('/').pop();
    if(method==='siteverify')return Response.json({success:mode!=='challengeFail'});
    let payload;if(options.body instanceof FormData){payload=Object.fromEntries(options.body);payload.documentText=await payload.document.text();}else payload=JSON.parse(options.body);requests.push({method,payload});
    if(apiHook){const result=await apiHook(method,payload);if(result)return result;}
    if(mode==='holdWelcome'&&(method==='sendPhoto'||payload.text?.includes('验证成功')))await new Promise(resolve=>{release=resolve;});
    if(mode==='welcomeFail'&&payload.chat_id==='2'&&payload.text?.includes('验证成功'))throw Error('welcome unavailable');
    if(mode==='networkFail'&&method==='copyMessage')throw Error('temporary network failure');
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
async function test(name,fn){clock=Date.now();requests=[];mode='ok';release=null;apiHook=null;await fn();passed++;console.log('PASS '+name);}

function update(user,mid,text='',extra={}) {
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
const editNotices=()=>requests.filter(r=>['editMessageText','editMessageCaption'].includes(r.method));
const quickPayload=()=>requests.findLast(r=>r.payload.text?.includes('⚡ 快捷回复'));
const restoreNonce=t=>[...t.storage.data.keys()].filter(k=>k.startsWith('r:')).at(-1).slice(2);
async function signBackup(t,entries){const base=await t.bot.createBackup();runtime.entriesArg=entries;return {...base,entries,checksum:await vm.runInContext('entriesChecksum(entriesArg)',runtime)};}
const errorText=()=>requests.filter(r=>['sendMessage','editMessageText'].includes(r.method)).at(-1)?.payload.text;
(async()=>{
  await test('老访客再次留言重新待回复；每次成功管理员回复清除',async()=>{
    const t=instance(legacy([['auth_2','true'],['replied_2','true']]));
    await t.bot.fetch(update(2,1,'新的问题'));assert.equal((await inbox(t,2)).pendingIds.length,1);
    await t.bot.fetch(update(1,2,'/send 2 收到'));assert.equal((await inbox(t,2)).pendingIds.length,0);
    clock+=4000;await t.bot.fetch(update(2,3,'还有一个问题'));assert.equal((await inbox(t,2)).pendingIds.length,1);await t.drain();
  });
  await test('去重和切换会话不清待回复；成功副本发送才清除',async()=>{
    const t=instance(legacy([['auth_2','true']]));await t.bot.fetch(update(2,1,'a'));await t.bot.fetch(update(2,1,'a'));
    assert.equal((await inbox(t,2)).pendingIds.length,1);await t.bot.fetch(callback('focus:2'));assert.equal((await inbox(t,2)).pendingIds.length,1);
    await t.bot.fetch(update(1,2,'答复'));assert.equal((await inbox(t,2)).pendingIds.length,0);await t.drain();
  });
  await test('发送失败保持待回复；手动 /done 不发送任何内容',async()=>{
    const t=instance(legacy([['auth_2','true']]));await t.bot.fetch(update(2,1,'a'));await t.drain();
    apiHook=async(method,payload)=>method==='sendMessage'&&payload.chat_id==='2'?Response.json({ok:false,error_code:403,description:'blocked'}):null;
    await t.bot.fetch(update(1,2,'/send 2 answer'));assert.equal((await inbox(t,2)).pendingIds.length,1);
    const count=noAdminCopies().length;await t.bot.fetch(update(1,3,'/done 2'));assert.equal((await inbox(t,2)).pendingIds.length,0);assert.equal(noAdminCopies().length,count);
  });
  await test('失败转发不加入待回复；封禁隐藏并清除待回复',async()=>{
    const t=instance(legacy([['auth_2','true']]));apiHook=async method=>method==='copyMessage'?Response.json({ok:false,error_code:400,description:'cannot forward'}):null;
    await t.bot.fetch(update(2,1,'a'));assert.equal(await t.bot.store.get('inbox_2'),null);apiHook=null;clock+=4000;
    await t.bot.fetch(update(2,2,'b'));await t.bot.fetch(update(1,3,'拉黑 2'));assert.equal(await t.bot.store.get('inbox_2'),null);await t.drain();
  });
  await test('待回复 23 人分页 10/10/3，按新消息时间排序且无用户名昵称可点',async()=>{
    const t=instance();for(let i=2;i<25;i++){await t.bot.store.put('inbox_'+i,JSON.stringify({pendingIds:[i],seenIds:[i],incomingAt:clock-i}));await t.bot.store.put('recent_'+i,JSON.stringify({id:String(i),firstName:'联系人'+i,updatedAt:clock-i}));}
    const collected=[];for(let page=0;page<3;page++){const view=await runtime.buildAwaitingList(t.bot.store,'1',page);const focus=view.replyMarkup.inline_keyboard.flat().filter(b=>b.callback_data?.startsWith('focus:'));assert.equal(focus.length,page===2?3:10);collected.push(...focus.map(b=>b.callback_data));assert.match(view.text,/tg:\/\/user\?id=/);}
    assert.equal(new Set(collected).size,23);assert.equal(collected[0],'focus:2');
    await t.bot.fetch(callback('awaiting_page:2'));assert.ok(requests.some(r=>r.method==='editMessageText'&&(r.payload.rich_message?.html || r.payload.text || '').includes('待回复')));
  });
  await test('最近/已授权列表标识当前待回复，而非历史从未回复',async()=>{
    const t=instance(legacy([['auth_2','true'],['auth_3','true'],['replied_2','true'],['recent_2',JSON.stringify({id:'2',firstName:'老访客',updatedAt:clock-1000})],['recent_3',JSON.stringify({id:'3',firstName:'已处理',updatedAt:clock})]]));
    await runtime.recordIncomingMessage('2',55,t.bot.store);
    for(const view of [await runtime.buildRecentUsersText(t.bot.store),await runtime.buildAuthedUsersText(t.bot.store,'1',rCfg(t))]){assert.ok(view.text.indexOf('老访客')<view.text.indexOf('已处理'));assert.equal((view.text.match(/📬 /g)||[]).length,1);}
  });
  await test('成功相册计入待回复，检查点重复恢复不重复计数',async()=>{
    const t=instance(legacy([['auth_2','true']]));batchResponses();await t.bot.fetch(album(2,'pending',1));await t.bot.fetch(album(2,'pending',2));await mature(t);
    assert.equal((await inbox(t,2)).pendingIds.length,2);const key='a:2:pending',job=await t.storage.get(key);job.state='sent';await t.storage.put(key,job);await t.bot.alarm();assert.equal((await inbox(t,2)).pendingIds.length,2);await t.drain();
  });
  await test('普通访客修改原副本，原回复映射不变，历史待回复重新打开',async()=>{
    const t=instance(legacy([['auth_2','true']]));await t.bot.fetch(update(2,1,'原文'));await t.bot.fetch(update(1,2,'/send 2 收到'));clock+=4000;
    await t.bot.fetch(edited(2,1,'修订 <b>😀'));await t.drain();assert.equal(editNotices().length,1);assert.match(editNotices()[0].payload.text,/<b>😀/);assert.equal(editNotices()[0].payload.chat_id,'1');assert.equal(editNotices()[0].payload.message_id,99);assert.equal(await t.bot.store.get('msg_99'),'2');assert.equal((await inbox(t,2)).pendingIds.length,1);
  });
  await test('管理员修改始终发送原联系人，切换会话后也不误发',async()=>{
    const t=instance(legacy([['auth_2','true'],['auth_3','true']]));await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');await t.bot.fetch(update(1,1,'原回复'));await runtime.setActiveAdminTarget(t.bot.store,'1','3','李');await t.bot.fetch(edited(1,1,'改后的回复'));await t.drain();assert.equal(editNotices()[0].payload.chat_id,'2');
  });
  await test('/send 修改原目标文字会同步；修改目标 ID 不重新执行推送',async()=>{
    const t=instance();await t.bot.fetch(update(1,1,'/send 2 原文'));await t.bot.fetch(edited(1,1,'/send 2 修订'));await t.bot.fetch(edited(1,1,'/send 3 错目标'));assert.equal(editNotices().length,1);assert.equal(editNotices()[0].payload.chat_id,'2');await t.drain();
  });
  await test('编辑重复、非正文变化、旧时间、未知旧消息均不补发',async()=>{
    const t=instance(legacy([['auth_2','true']]));await t.bot.fetch(update(2,1,'原文'));const date=Math.floor(clock/1000);
    await t.bot.fetch(edited(2,1,'原文',date));await t.bot.fetch(edited(2,1,'新版',date));await t.bot.fetch(edited(2,1,'新版',date));await t.bot.fetch(edited(2,1,'旧版',date-1));await t.bot.fetch(edited(2,9,'无映射',date));assert.equal(editNotices().length,1);await t.drain();
  });
  await test('撤销/封禁访客编辑被忽略，管理员管理指令编辑不会执行',async()=>{
    const t=instance(legacy([['auth_2','true']]));await t.bot.fetch(update(2,1,'原文'));await t.bot.store.delete('auth_2');await t.bot.fetch(edited(2,1,'改文'));await t.bot.fetch(edited(1,10,'拉黑 3'));assert.equal(editNotices().length,0);assert.equal(await t.bot.store.get('lock_3'),null);await t.drain();
  });
  await test('相册已送达说明编辑按成员正确关联原消息',async()=>{
    const t=instance(legacy([['auth_2','true']]));batchResponses();await t.bot.fetch(album(2,'caption',1));await t.bot.fetch(update(2,2,'',{media_group_id:'caption',caption:'原说明'}));await mature(t);
    await t.bot.fetch(edited(2,2,undefined,Math.floor(clock/1000),{media_group_id:'caption',caption:'改说明'}));assert.equal(editNotices()[0].payload.message_id,901);await t.drain();
  });
  await test('收集中相册修改只更新基线，部分送达不建立猜测映射',async()=>{
    const t=instance(legacy([['auth_2','true']]));batchResponses();await t.bot.fetch(update(2,1,'',{media_group_id:'queued',caption:'原文'}));await t.bot.fetch(edited(2,1,undefined,Math.floor(clock/1000),{media_group_id:'queued',caption:'修订'}));assert.equal(editNotices().length,0);await mature(t);await t.bot.fetch(edited(2,1,undefined,Math.floor(clock/1000),{media_group_id:'queued',caption:'修订'}));assert.equal(editNotices().length,0);
    clock+=4000;apiHook=async method=>method==='copyMessages'?Response.json({ok:true,result:[{message_id:901}]}):null;await t.bot.fetch(album(2,'partial',3));await t.bot.fetch(album(2,'partial',4));await mature(t);assert.equal(await t.bot.store.get('origin_2_3'),null);assert.equal(await t.bot.store.get('origin_2_4'),null);assert.equal((await inbox(t,2)).pendingIds.length,2);await t.drain();
  });
  await test('快捷回复固定原联系人、按钮重复点击不重复发送并清待回复',async()=>{
    const t=instance(legacy([['auth_2','true'],['auth_3','true']]));await runtime.recordIncomingMessage('2',1,t.bot.store);await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');await t.bot.fetch(callback('quick_replies'));
    const payload=quickPayload();assert.match(payload.payload.text,/2/);const data=payload.payload.reply_markup.inline_keyboard[0][0].callback_data;await runtime.setActiveAdminTarget(t.bot.store,'1','3','李');await t.bot.fetch(callback(data));await t.bot.fetch(callback(data));
    const sent=requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id==='2');assert.equal(sent.length,1);assert.equal((await inbox(t,2)).pendingIds.length,0);await t.drain();
  });
  await test('/quick 回复映射优先；无效回复映射不能退回当前联系人',async()=>{
    const t=instance(legacy([['msg_100','3']]));await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');await t.bot.fetch(update(1,1,'/quick 1',{reply_to_message:{message_id:100}}));assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id==='3').length,1);await t.bot.fetch(update(1,2,'/quick 1',{reply_to_message:{message_id:404}}));assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id==='2').length,0);await t.drain();
  });
  await test('模板新增/删除编号稳定；管理输入与 /cancel 不发给访客',async()=>{
    const t=instance();await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');await t.bot.fetch(update(1,1,'/quick add 测试 | <新回复>😀'));await t.bot.fetch(update(1,2,'/quick del 2'));await t.bot.fetch(update(1,3,'/quick add 第二条 | 后续'));
    const bank=JSON.parse(await t.bot.store.get('quick_admin_1'));assert.equal(bank.items.at(-1).id,'5');assert.ok(bank.items.some(i=>i.id==='3'));await t.bot.fetch(callback('quick_add'));await t.bot.fetch(update(1,4,'第三条 | 内容',{reply_to_message:{message_id:99}}));assert.equal(JSON.parse(await t.bot.store.get('quick_admin_1')).items.at(-1).id,'6');await t.bot.fetch(callback('quick_add'));await t.bot.fetch(update(1,5,'/cancel',{reply_to_message:{message_id:99}}));assert.equal(await t.bot.store.get('admin_input_1'),null);assert.equal(noAdminCopies().length,0);assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id==='2').length,0);
  });
  await test('模板上限10条与 Unicode 字数；失败快捷回复保留待回复',async()=>{
    const t=instance();await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');for(let i=0;i<7;i++)await t.bot.fetch(update(1,i+1,'/quick add '+i+' | 内容'));await t.bot.fetch(update(1,9,'/quick add 超额 | 内容'));assert.equal(JSON.parse(await t.bot.store.get('quick_admin_1')).items.length,10);
    await t.bot.fetch(update(1,10,'/quick add '+'😀'.repeat(21)+' | 内容'));assert.equal(JSON.parse(await t.bot.store.get('quick_admin_1')).items.length,10);await runtime.recordIncomingMessage('2',5,t.bot.store);
    apiHook=async(method,payload)=>method==='sendMessage'&&payload.chat_id==='2'?Response.json({ok:false,error_code:403,description:'blocked'}):null;await t.bot.fetch(update(1,11,'/quick 1'));assert.equal((await inbox(t,2)).pendingIds.length,1);
  });
  await test('过期快捷菜单不能发送；访客不能操作模板/离开/备份',async()=>{
    const t=instance();await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');await t.bot.fetch(callback('quick_replies'));const data=quickPayload().payload.reply_markup.inline_keyboard[0][0].callback_data;clock+=601000;await t.bot.fetch(callback(data));assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id==='2').length,0);
    for(const data of ['quick_add','away_on','backup_new','awaiting'])await t.bot.fetch(callback(data,2));assert.equal(await t.bot.store.get('away_admin_1'),null);assert.equal([...t.storage.data.keys()].filter(k=>k.startsWith('b:')).length,0);
  });
  await test('离开模式默认关闭，开启后每位访客24小时最多一次，自动回复不清待回复',async()=>{
    const t=instance(legacy([['auth_2','true'],['auth_3','true']]));await t.bot.fetch(update(2,1,'a'));await t.drain();assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id!=='1'&&r.payload.text?.includes('暂时不在')).length,0);
    await t.bot.fetch(update(1,2,'/away on'));clock+=4000;await t.bot.fetch(update(2,3,'b'));await t.bot.fetch(update(2,4,'c'));await t.bot.fetch(update(3,5,'d'));await t.drain();assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id!=='1'&&r.payload.text?.includes('暂时不在')).length,2);assert.equal((await inbox(t,2)).pendingIds.length,3);
    clock+=86401000;await t.bot.fetch(update(2,6,'e'));await t.drain();assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id!=='1'&&r.payload.text?.includes('暂时不在')).length,3);
  });
  await test('离开提示修改/关闭输入不转发；发送失败允许下次提示',async()=>{
    const t=instance(legacy([['auth_2','true']]));await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');await t.bot.fetch(update(1,1,'/away text 我在外面😀'));await t.bot.fetch(callback('away_text'));await t.bot.fetch(update(1,2,'稍后回',{reply_to_message:{message_id:99}}));assert.equal(JSON.parse(await t.bot.store.get('away_admin_1')).text,'稍后回');assert.equal(noAdminCopies().length,0);
    await t.bot.fetch(callback('away_on'));apiHook=async(method,payload)=>method==='sendMessage'&&payload.chat_id==='2'&&payload.text==='稍后回'?Response.json({ok:false,error_code:403,description:'blocked'}):null;await t.bot.fetch(update(2,3,'a'));await t.drain();assert.equal(await t.bot.store.get('away_notice_2'),null);
    apiHook=null;clock+=4000;await t.bot.fetch(update(2,4,'b'));await t.drain();assert.ok(await t.bot.store.get('away_notice_2'));await t.bot.fetch(callback('away_off'));clock+=86401000;await t.bot.fetch(update(2,5,'c'));await t.drain();assert.equal(requests.filter(r=>r.payload.text==='稍后回'&&r.payload.chat_id==='2').length,2);
  });
  await test('离开相册只发一次提示；未授权消息不触发离开回复',async()=>{
    const t=instance(legacy([['auth_2','true']]));await t.bot.fetch(update(1,1,'/away on'));batchResponses();await t.bot.fetch(album(2,'away',2));await t.bot.fetch(album(2,'away',3));await mature(t);assert.equal(requests.filter(r=>r.payload.chat_id==='2'&&r.payload.text?.includes('暂时不在')).length,1);await t.bot.fetch(update(3,4,'未授权'));await t.drain();assert.equal(requests.filter(r=>r.payload.chat_id==='3'&&r.payload.text?.includes('暂时不在')).length,0);
  });
  await test('独立快照涵盖必要数据与过期时间，排除凭据/会话/原始消息映射',async()=>{
    const t=instance(legacy([['auth_2','true'],['lock_3',String(clock+300000)],['note_2',JSON.stringify({text:'朋友'})],['settings_admin_1',JSON.stringify({idleMinutes:15})],['BOT_TOKEN','SECRET_VALUE'],['msg_100','2'],['inbox_2','{}'],['away_notice_2',String(clock)],['active_admin_1','{}']]));
    const expiration=Math.floor(clock/1000)+300;await t.bot.store.put('replied_2','true',{expiration});const snapshot=await t.bot.createBackup();assert.ok(snapshot.entries.some(e=>e.key==='replied_2'&&e.expiration===expiration));assert.ok(snapshot.entries.some(e=>e.key==='note_2'));assert.ok(!JSON.stringify(snapshot).includes('SECRET_VALUE'));assert.ok(snapshot.entries.every(e=>runtime.isBackupKey(e.key,'1')));
    await t.bot.store.delete('note_2');const saved=[...t.storage.data.values()].find(e=>e?.snapshot);assert.ok(saved.snapshot.entries.some(e=>e.key==='note_2'));
  });
  await test('快照保留最近10份；协调器重建仍能读取独立备份',async()=>{
    const t=instance(legacy([['auth_2','true']]));for(let i=0;i<12;i++){clock+=1;await t.bot.createBackup();}assert.equal([...t.storage.data.keys()].filter(k=>k.startsWith('b:')).length,10);const restart=instance(t.kv,t.storage);await restart.bot.showBackups(rCfg(restart));assert.match(errorText(),/10\/10/);assert.equal(requests.at(-1).payload.reply_markup.inline_keyboard.filter(row=>row[0].callback_data?.startsWith('backup_get:')).length,10);
  });
  await test('/backup 上传 JSON 文档仅管理员可见；后台下载失败仍保留快照',async()=>{
    const t=instance(legacy([['auth_2','true']]));await t.bot.fetch(update(1,1,'/backup'));const uploaded=requests.find(r=>r.method==='sendDocument');assert.equal(uploaded.payload.chat_id,'1');const snapshot=JSON.parse(uploaded.payload.documentText);assert.equal(snapshot.format,'chuanhuatong-backup');assert.ok(uploaded.payload.document.name.startsWith('chuanhuatong-backup-'));
    apiHook=async method=>method==='sendDocument'?Response.json({ok:false,error_code:400,description:'cannot upload'}):null;await t.bot.fetch(update(1,2,'/backup'));assert.equal([...t.storage.data.keys()].filter(k=>k.startsWith('b:')).length,2);assert.match(errorText(),/备份已保存/);
  });
  await test('备份预览不改变数据；取消和未确认导入不恢复',async()=>{
    const t=instance(legacy([['auth_2','true']]));const snapshot=await t.bot.createBackup();await t.bot.store.delete('auth_2');await t.bot.stageRestore(snapshot,rCfg(t));const nonce=restoreNonce(t);assert.equal(await t.bot.store.get('auth_2'),null);await t.bot.fetch(callback('restore_cancel:'+nonce));assert.equal(await t.storage.get('r:'+nonce),undefined);assert.equal(await t.bot.store.get('auth_2'),null);
  });
  await test('确认恢复完整替换白名单数据、保留秘密和消息映射并清当前会话',async()=>{
    const t=instance(legacy([['auth_2','true'],['note_2',JSON.stringify({text:'旧备注'})],['msg_100','2'],['BOT_TOKEN','SECRET_VALUE']]));await t.bot.store.put('quick_admin_1',JSON.stringify({nextId:2,items:[{id:'1',title:'恢复模板',text:'恢复内容'}]}));const snapshot=await t.bot.createBackup();
    await t.bot.store.delete('auth_2');await t.bot.store.put('auth_3','true');await t.bot.store.put('note_2',JSON.stringify({text:'新备注'}));await runtime.setActiveAdminTarget(t.bot.store,'1','3','李');await t.bot.stageRestore(snapshot,rCfg(t));const nonce=restoreNonce(t);await t.bot.fetch(callback('restore_confirm:'+nonce));
    assert.equal(await t.bot.store.get('auth_2'),'true');assert.equal(await t.bot.store.get('auth_3'),null);assert.equal(JSON.parse(await t.bot.store.get('note_2')).text,'旧备注');assert.equal(await t.bot.store.get('active_admin_1'),null);assert.equal(await t.bot.store.get('msg_100'),'2');assert.equal(await t.bot.store.get('BOT_TOKEN'),'SECRET_VALUE');assert.equal(JSON.parse(await t.bot.store.get('quick_admin_1')).items[0].title,'恢复模板');assert.equal([...t.storage.data.keys()].filter(k=>k.startsWith('b:')).length,2);
  });
  await test('恢复保留绝对到期时间，过期封禁/回复记录跳过，不延长期限',async()=>{
    const t=instance();const expiry=Math.floor(clock/1000)+100;await t.bot.store.put('replied_2','true',{expiration:expiry});await t.bot.store.put('lock_3',String(clock+50000),{expiration:Math.floor(clock/1000)+50});const snapshot=await t.bot.createBackup();clock+=60000;await t.bot.stageRestore(snapshot,rCfg(t));const result=await t.bot.restoreBackup(restoreNonce(t));assert.equal(result.expired,1);assert.equal(await t.bot.store.get('lock_3'),null);assert.equal((await t.storage.get('v:replied_2')).expiration,expiry);
  });
  await test('恢复确认单次有效，超时确认失效，前置自动备份能找回替换前状态',async()=>{
    const t=instance(legacy([['auth_2','true']]));const snapshot=await t.bot.createBackup();await t.bot.store.put('auth_3','true');await t.bot.stageRestore(snapshot,rCfg(t));const nonce=restoreNonce(t);await t.bot.restoreBackup(nonce);await assert.rejects(t.bot.restoreBackup(nonce),/已使用/);
    const before=[...t.storage.data.values()].find(e=>e?.reason==='before_restore');assert.ok(before.snapshot.entries.some(e=>e.key==='auth_3'));await t.bot.stageRestore(snapshot,rCfg(t));const expired=restoreNonce(t);clock+=600001;await assert.rejects(t.bot.restoreBackup(expired),/过期/);await t.bot.alarm();assert.equal(await t.storage.get('r:'+expired),undefined);
  });
  await test('恢复事务失败保持原数据和确认记录，能再次确认',async()=>{
    const t=instance(legacy([['auth_2','true']]));const snapshot=await t.bot.createBackup();await t.bot.store.put('auth_3','true');await t.bot.stageRestore(snapshot,rCfg(t));const nonce=restoreNonce(t);
    const original=t.bot.createBackup.bind(t.bot);t.bot.createBackup=async(reason)=>{const result=await original(reason);t.storage.failNextTransactionPut=true;return result;};await assert.rejects(t.bot.restoreBackup(nonce),/transaction failed/);assert.equal(await t.bot.store.get('auth_3'),'true');assert.ok(await t.storage.get('r:'+nonce));t.bot.createBackup=original;await t.bot.restoreBackup(nonce);assert.equal(await t.bot.store.get('auth_3'),null);
  });
  await test('校验错误、跨管理员、未知密钥、重复键、坏模板均拒绝恢复',async()=>{
    const t=instance(legacy([['auth_2','true']])),snapshot=await t.bot.createBackup();await assert.rejects(runtime.validateBackup({...snapshot,checksum:'wrong'},'1'),/校验失败/);await assert.rejects(runtime.validateBackup({...snapshot,adminId:'2'},'1'),/管理员/);
    for(const entries of [[{key:'BOT_TOKEN',value:'bad',expiration:null,metadata:null}], [snapshot.entries[0],snapshot.entries[0]], [{key:'quick_admin_1',value:JSON.stringify({nextId:1,items:[{id:'1',title:'x',text:'y'}]}),expiration:null,metadata:null}]]){const bad=await signBackup(t,entries);await assert.rejects(runtime.validateBackup(bad,'1'));}assert.equal(await t.bot.store.get('auth_2'),'true');
  });
  await test('超大/非UTF8/未知路径的导入文件拒绝，且不转发给当前联系人',async()=>{
    const t=instance();await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');await t.bot.fetch(update(1,1,'/restore'));await t.bot.fetch(update(1,2,'',{document:{file_id:'bad',file_name:'data.json',file_size:1048577}}));assert.equal(noAdminCopies().length,0);assert.match(errorText(),/1 MiB/);
    apiHook=async method=>method==='getFile'?Response.json({ok:true,result:{file_path:'../unsafe.json',file_size:5}}):null;await t.bot.fetch(update(1,3,'',{document:{file_id:'bad',file_name:'chuanhuatong-backup-x.json',file_size:5}}));assert.match(errorText(),/无法获取/);assert.equal(noAdminCopies().length,0);
    apiHook=async method=>method==='getFile'?Response.json({ok:true,result:{file_path:'documents/file.json',file_size:2}}):null;downloadBody=new Uint8Array([0xff,0xff]);await t.bot.fetch(update(1,4,'',{document:{file_id:'bad',file_name:'chuanhuatong-backup-x.json',file_size:2}}));assert.match(errorText(),/UTF/);assert.equal(noAdminCopies().length,0);
  });
  await test('JSON 文件导入先预览，普通附件仍正常发送；恢复旧快捷菜单失效',async()=>{
    const t=instance(legacy([['auth_2','true']]));const snapshot=await t.bot.createBackup();downloadBody=JSON.stringify(snapshot);apiHook=async method=>method==='getFile'?Response.json({ok:true,result:{file_path:'documents/file.json',file_size:downloadBody.length}}):null;await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');await t.bot.fetch(callback('quick_replies'));const quick=quickPayload().payload.reply_markup.inline_keyboard[0][0].callback_data;
    await t.bot.store.delete('auth_2');await t.bot.fetch(update(1,1,'',{document:{file_id:'json',file_name:'chuanhuatong-backup-test.json',file_size:downloadBody.length}}));assert.equal(await t.bot.store.get('auth_2'),null);assert.match(errorText(),/恢复预览/);assert.equal(noAdminCopies().length,0);await t.bot.fetch(callback('restore_confirm:'+restoreNonce(t)));assert.equal(await t.bot.store.get('auth_2'),'true');await t.bot.fetch(callback(quick));assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id==='2').length,0);
    await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');await t.bot.fetch(update(1,2,'',{document:{file_id:'normal',file_name:'normal.json',file_size:3}}));assert.equal(noAdminCopies().length,1);await t.drain();
  });
  await test('旧备份毫秒到期在验签后规范化，已过期记录不会恢复',async()=>{
    const t=instance(),expiry=clock+300000;
    const snapshot=await signBackup(t,[{key:'replied_2',value:'true',expiration:expiry,metadata:{updatedAt:clock}},{key:'replied_3',value:'true',expiration:clock-1000,metadata:null}]);
    await assert.rejects(runtime.validateBackup({...snapshot,entries:snapshot.entries.map(e=>({...e,expiration:Math.floor(e.expiration/1000)}))},'1'),/校验失败/);
    await t.bot.stageRestore(snapshot,rCfg(t));const result=await t.bot.restoreBackup(restoreNonce(t));
    assert.equal(result.restored,1);assert.equal(result.expired,1);assert.equal(await t.bot.store.get('replied_3'),null);
    assert.equal((await t.storage.get('v:replied_2')).expiration,Math.floor(expiry/1000));
    assert.equal((await t.storage.get('v:replied_2')).metadata.updatedAt,clock);
  });
  await test('镜像重试延迟参与alarm调度，但新任务仍能及时唤醒',async()=>{
    const t=instance();await t.bot.store.put('auth_2','true');t.kv.failWrites=true;
    for(let i=0;i<3;i++){await t.bot.store.flushMirrors();const job=await t.storage.get('o:auth_2');await t.bot.rescheduleAlarm();assert.equal(t.storage.alarm,job.mirrorRetryAt);clock=job.mirrorRetryAt;}
    await t.bot.store.put('auth_3','true');await t.bot.rescheduleAlarm();assert.equal(t.storage.alarm,clock+2000);
  });
  console.log(passed+' advanced checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
