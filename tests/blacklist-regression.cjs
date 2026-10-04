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
const locked=(id,until=clock+86400000)=>['lock_'+id,String(until)];
const rowIds=view=>[...view.text.matchAll(/<code>(\d+)<\/code>/g)].map(m=>m[1]);
const blacklist=async(t,page=0)=>runtime.buildBlacklistText(t.bot.store,rCfg(t),page);
(async()=>{
  await test('黑名单优先昵称；无用户名昵称也可点击，缺昵称才显示用户名',async()=>{
    const t=instance(legacy([locked(2),locked(3)],{'lock_2':{metadata:{firstName:'张三',username:'TestAbc'}},'lock_3':{metadata:{firstName:'小猫咪',username:''}}}));const view=await blacklist(t);assert.match(view.text,/<code>2<\/code> \| <a href="https:\/\/t.me\/TestAbc">张三<\/a>/);assert.match(view.text,/<code>3<\/code> \| <a href="tg:\/\/user\?id=3">小猫咪<\/a>/);assert.equal(view.text.split('\n').filter(l=>l.startsWith('•')).length,2);assert.equal(requests.filter(r=>r.method==='getChat').length,0);await t.bot.store.put('lock_4',String(clock+86400000),{metadata:{username:'nickname_missing'}});assert.match((await blacklist(t)).text,/>@nickname_missi…<\/a>/);
  });
  await test('过长中文、用户名和表情按显示宽度截断并加省略号；完整跳转目标保留',async()=>{
    const username='abcdefghijklmnopqrstuvwxyz123456';const t=instance(legacy([locked(2),locked(3)],{'lock_2':{metadata:{firstName:'汉'.repeat(40)}},'lock_3':{metadata:{username}}}));const view=await blacklist(t);assert.match(view.text,/汉{7}…/);assert.match(view.text,/@abcdefghijklmn…/);assert.ok(view.text.includes('https://t.me/'+username));assert.equal(runtime.shortBlacklistName('👨‍👩‍👧‍👦'.repeat(20)), '👨‍👩‍👧‍👦'.repeat(7)+'…');assert.equal(runtime.shortBlacklistName('😀'.repeat(20)),'😀'.repeat(7)+'…');assert.equal(runtime.shortBlacklistName('1234567890123456'),'1234567890123456');
  });
  await test('昵称换行、分隔符、双向控制字符被规范化，HTML安全转义',async()=>{
    const t=instance(legacy([locked(2)],{'lock_2':{metadata:{firstName:'张\n<猫>&|\u202e咪'}}}));const view=await blacklist(t);assert.equal(view.text.split('\n').filter(l=>l.startsWith('•')).length,1);assert.match(view.text,/张 &lt;猫&gt;&amp; 咪/);assert.ok(!view.text.includes('\u202e'));assert.equal((view.text.split('\n').at(-1).match(/ \| /g)||[]).length,1);
  });
  await test('拉黑前保存姓名资料，清除recent后仍可显示，封禁值格式兼容旧逻辑',async()=>{
    const t=instance(legacy([['recent_2',JSON.stringify({id:'2',firstName:'张三',username:'wj',updatedAt:clock})],['auth_2','true']]));await runtime.banUser('2',rEnv(t),rCfg(t));assert.equal(await t.bot.store.get('recent_2'),null);assert.equal(await t.bot.store.get('auth_2'),null);assert.equal(Number(await t.bot.store.get('lock_2')),clock+30*86400000);const view=await blacklist(t);assert.match(view.text,/张三/);assert.equal(requests.filter(r=>r.method==='getChat').length,0);await runtime.banUser('2',rEnv(t),rCfg(t));assert.match((await blacklist(t)).text,/张三/);await t.drain();
  });
  await test('仅有备注的姓名仍可保留，昵称不会变成备注正文',async()=>{
    const t=instance(legacy([['note_2',JSON.stringify({text:'内部备注',firstName:'猫咪',username:''})]]));await runtime.banUser('2',rEnv(t),rCfg(t));const view=await blacklist(t);assert.match(view.text,/猫咪/);assert.ok(!view.text.includes('内部备注'));await t.drain();
  });
  await test('旧版黑名单补查后缓存资料且不延长30天封禁，到期时间精确保留',async()=>{
    const until=clock+86400000,expiry=Math.ceil(until/1000);const t=instance(legacy([locked(2,until)],{'lock_2':{expiration:expiry}}));apiHook=async(method,payload)=>method==='getChat'?Response.json({ok:true,result:{first_name:'旧访客',username:'old_user'}}):null;assert.match((await blacklist(t)).text,/旧访客/);assert.equal(Number(await t.bot.store.get('lock_2')),until);const key=(await t.bot.store.list({prefix:'lock_'})).keys[0];assert.equal(key.expiration,expiry);assert.equal(key.metadata.firstName,'旧访客');await blacklist(t);assert.equal(requests.filter(r=>r.method==='getChat').length,1);
  });
  await test('旧资料查询失败显示未知访客，网络错误不阻止整页显示',async()=>{
    const t=instance(legacy([locked(2),locked(3)]));apiHook=async(method,payload)=>{if(method==='getChat'&&payload.chat_id==='2')return Response.json({ok:false,error_code:400,description:'chat not found'});if(method==='getChat')throw Error('network failed');return null;};const view=await blacklist(t);assert.equal((view.text.match(/未知访客/g)||[]).length,2);assert.deepEqual(rowIds(view).sort(),['2','3']);assert.equal(Number(await t.bot.store.get('lock_2')),clock+86400000);
  });
  await test('23名黑名单按10/10/3分页，越界回退；只查询当前页资料',async()=>{
    const t=instance(legacy(Array.from({length:23},(_,i)=>locked(i+2,clock+86400000+i))));const collected=[];for(let page=0;page<3;page++){requests=[];const view=await blacklist(t,page);assert.equal(rowIds(view).length,[10,10,3][page]);assert.equal(requests.filter(r=>r.method==='getChat').length,[10,10,3][page]);collected.push(...rowIds(view));}assert.equal(new Set(collected).size,23);assert.equal(rowIds(await blacklist(t,9999)).length,3);assert.equal(rowIds(await blacklist(t,-1)).length,10);
  });
  await test('翻页更新原消息而非新增，非管理员不能获取黑名单',async()=>{
    const t=instance(legacy(Array.from({length:23},(_,i)=>locked(i+2))));uniqueMessages();await t.bot.fetch(callback('blacklist_page:1'));assert.equal(requests.filter(r=>r.method==='sendMessage').length,0);const edit=requests.findLast(r=>r.method==='editMessageText');assert.equal(edit.payload.message_id,100);assert.equal(rowIds({text:edit.payload.text}).length,10);assert.ok(edit.payload.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='blacklist_page:2'));requests=[];await t.bot.fetch(callback('blacklist_page:1',2));assert.equal(requests.filter(r=>r.method==='getChat').length,0);assert.equal(requests.filter(r=>r.method==='editMessageText').length,0);await t.drain();
  });
  await test('到期/坏键/坏时间不展示，空名单保留返回菜单按钮',async()=>{
    const t=instance(legacy([locked(2,clock-1),['lock_bad','9999999999999'],['lock_3','oops']]));const view=await blacklist(t);assert.match(view.text,/暂无封禁用户/);assert.equal(rowIds(view).length,0);assert.equal(view.replyMarkup.inline_keyboard[0][0].callback_data,'menu_main');assert.equal(requests.filter(r=>r.method==='getChat').length,0);
  });
  await test('封禁姓名随备份导出/恢复保留，解封同时移除封禁姓名',async()=>{
    const t=instance(legacy([['recent_2',JSON.stringify({id:'2',firstName:'张三',username:'wj',updatedAt:clock})]]));await runtime.banUser('2',rEnv(t),rCfg(t));const snapshot=await t.bot.createBackup();assert.equal(snapshot.entries.find(x=>x.key==='lock_2').metadata.username,'wj');await t.bot.store.delete('lock_2');await t.bot.stageRestore(snapshot,rCfg(t));await t.bot.restoreBackup(restoreNonce(t));assert.match((await blacklist(t)).text,/张三/);await runtime.unbanUser('2',rEnv(t),rCfg(t));assert.match((await blacklist(t)).text,/暂无/);assert.equal(await t.bot.store.get('lock_2'),null);await t.drain();
  });
  console.log(passed+' blacklist checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
