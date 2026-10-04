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
const edits=()=>requests.filter(r=>r.method==='editMessageText');
const adminSends=()=>requests.filter(r=>['sendMessage','sendPhoto'].includes(r.method)&&r.payload.chat_id==='1');
const lastEdit=()=>{const payload=edits().at(-1).payload;return {...payload,text:payload.rich_message?.html || payload.text};};
const pendingInput=async t=>JSON.parse(await t.bot.store.get('admin_input_1'));
const reply=(mid,text,prompt)=>update(1,mid,text,{reply_to_message:{message_id:prompt}});
const resetRequests=()=>{requests=[];};
(async()=>{
  await test('离开模式开关反复操作只编辑同一消息，按钮状态同步',async()=>{
    const t=instance();uniqueMessages();for(const data of ['away_settings','away_on','away_off'])await t.bot.fetch(callback(data));await t.drain();assert.equal(adminSends().length,0);assert.deepEqual(edits().map(r=>r.payload.message_id),[100,100,100]);assert.match(edits()[1].payload.text,/已开启/);assert.equal(edits()[1].payload.reply_markup.inline_keyboard[0][0].callback_data,'away_off');assert.match(lastEdit().text,/已关闭/);
  });
  await test('模板管理和返回不新增消息；旧快捷按钮不能发消息或清掉新页面按钮',async()=>{
    const t=instance();uniqueMessages();const {data}=await prepareQuick(t);await t.bot.fetch(callback('quick_manage'));const count=requests.length;await t.bot.fetch(callback(data));assert.equal(requests.slice(count).filter(r=>r.method==='editMessageReplyMarkup').length,0);assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id==='2').length,0);await t.bot.fetch(callback('menu_main'));assert.equal(adminSends().length,0);assert.ok(edits().every(r=>r.payload.message_id===100));await t.drain();
  });
  await test('修改离开提示完成后删除输入提示、更新原页面，不新增保存通知',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(callback('away_text'));const pending=await pendingInput(t);resetRequests();await t.bot.fetch(reply(1,'稍后回复你',pending.messageId));await t.drain();assert.equal(adminSends().length,0);assert.equal(lastEdit().message_id,100);assert.match(lastEdit().text,/稍后回复你/);assert.equal(await pendingInput(t),null);assert.ok(requests.some(r=>r.method==='deleteMessage'&&r.payload.message_id===pending.messageId));assert.equal(noAdminCopies().length,0);
  });
  await test('模板输入无效在原页提示且保留输入，纠正后原页展示新模板',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(callback('quick_add'));const pending=await pendingInput(t);resetRequests();await t.bot.fetch(reply(1,'错误格式',pending.messageId));assert.equal((await pendingInput(t)).messageId,pending.messageId);assert.equal(adminSends().length,0);assert.match(lastEdit().text,/标题/);await t.bot.fetch(reply(2,'测试 | 内容',pending.messageId));await t.drain();assert.equal(await pendingInput(t),null);assert.match(lastEdit().text,/测试/);assert.equal(lastEdit().message_id,100);assert.equal(noAdminCopies().length,0);
  });
  await test('取消按钮清理临时提示并返回原离开页面，取消后迟到回复不发给访客',async()=>{
    const t=instance();uniqueMessages();await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');await t.bot.fetch(callback('away_text'));const pending=await pendingInput(t);resetRequests();await t.bot.fetch(callback('input_cancel'));assert.equal(adminSends().length,0);assert.match(lastEdit().text,/离开模式/);assert.ok(requests.some(r=>r.method==='deleteMessage'&&r.payload.message_id===pending.messageId));await t.bot.fetch(reply(1,'旧输入',pending.messageId));assert.equal(noAdminCopies().length,0);await t.drain();
  });
  await test('输入期间返回主菜单清理提示，搜索新页面复用原消息',async()=>{
    const t=instance(legacy([['recent_2',JSON.stringify({id:'2',firstName:'张三',updatedAt:clock})]]));uniqueMessages();await t.bot.fetch(callback('contact_search'));const first=await pendingInput(t);await t.bot.fetch(callback('menu_main'));assert.equal(await pendingInput(t),null);assert.ok(requests.some(r=>r.method==='deleteMessage'&&r.payload.message_id===first.messageId));await t.bot.fetch(callback('contact_search'));const next=await pendingInput(t);resetRequests();await t.bot.fetch(reply(1,'张',next.messageId));assert.equal(adminSends().length,0);assert.match(lastEdit().reply_markup.inline_keyboard.flat().map(b=>b.text).join('|'),/张三/);assert.equal(lastEdit().message_id,100);await t.drain();
  });
  await test('备注完成保留固定目标并更新原页；管理文字不转发',async()=>{
    const t=instance();uniqueMessages();await runtime.setActiveAdminTarget(t.bot.store,'1','2','张');await t.bot.fetch(callback('contact_note'));const pending=await pendingInput(t);await runtime.setActiveAdminTarget(t.bot.store,'1','3','李');resetRequests();await t.bot.fetch(reply(1,'备注内容',pending.messageId));assert.equal(JSON.parse(await t.bot.store.get('note_2')).text,'备注内容');assert.equal(await t.bot.store.get('note_3'),null);assert.equal(adminSends().length,0);assert.match(lastEdit().text,/备注已保存/);assert.equal(noAdminCopies().length,0);await t.drain();
  });
  await test('新输入替换旧输入时清理旧提示；重新输入admin退出输入模式',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(update(1,1,'/search'));const first=await pendingInput(t);await t.bot.fetch(update(1,2,'/search'));assert.ok(requests.some(r=>r.method==='deleteMessage'&&r.payload.message_id===first.messageId));const second=await pendingInput(t);await t.bot.fetch(update(1,3,'/admin'));assert.equal(await pendingInput(t),null);assert.ok(requests.some(r=>r.method==='deleteMessage'&&r.payload.message_id===second.messageId));await t.drain();
  });
  await test('备份创建、预览、取消在原消息更新，只新增实际JSON文件',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(callback('backups'));await t.bot.fetch(callback('backup_new'));const nonce=[...t.storage.data.keys()].find(k=>k.startsWith('b:')).slice(2);await t.bot.fetch(callback('backup_preview:'+nonce));const restore=restoreNonce(t);await t.bot.fetch(callback('restore_cancel:'+restore));assert.equal(adminSends().length,0);assert.equal(requests.filter(r=>r.method==='sendDocument').length,1);assert.ok(edits().every(r=>r.payload.message_id===100));assert.equal(await t.storage.get('r:'+restore),undefined);await t.drain();
  });
  await test('恢复成功更新原页，重复确认不覆盖结果或再次恢复',async()=>{
    const t=instance(legacy([['auth_2','true']]));uniqueMessages();await t.bot.fetch(callback('backup_new'));const nonce=[...t.storage.data.keys()].find(k=>k.startsWith('b:')).slice(2);await t.bot.store.delete('auth_2');await t.bot.fetch(callback('backup_preview:'+nonce));const restore=restoreNonce(t);await t.bot.fetch(callback('restore_confirm:'+restore));assert.equal(await t.bot.store.get('auth_2'),'true');assert.match(lastEdit().text,/恢复完成/);const editCount=edits().length,backupCount=[...t.storage.data.keys()].filter(k=>k.startsWith('b:')).length;await t.bot.fetch(callback('restore_confirm:'+restore));assert.equal(edits().length,editCount);assert.equal([...t.storage.data.keys()].filter(k=>k.startsWith('b:')).length,backupCount);assert.equal(adminSends().length,0);await t.drain();
  });
  await test('无效导入在原页面显示错误且保留上传状态，cancel回原备份页',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(callback('backup_import'));resetRequests();await t.bot.fetch(update(1,1,'',{document:{file_id:'TEST',file_name:'wrong.txt',file_size:20}}));assert.match(lastEdit().text,/未导入/);assert.equal(lastEdit().message_id,100);assert.equal(adminSends().length,0);assert.ok(await t.bot.store.get('admin_restore_input_1'));await t.bot.fetch(update(1,2,'/cancel'));assert.equal(await t.bot.store.get('admin_restore_input_1'),null);assert.match(lastEdit().text,/已取消备份导入/);assert.equal(adminSends().length,0);await t.drain();
  });
  await test('过期备份与恢复确认错误均显示在原页面',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(callback('backup_preview:aaaaaaaaaaaaaaaa'));assert.match(lastEdit().text,/过期/);await t.bot.fetch(callback('restore_confirm:bbbbbbbbbbbbbbbb'));assert.match(lastEdit().text,/未恢复/);assert.equal(adminSends().length,0);assert.ok(edits().every(r=>r.payload.message_id===100));await t.drain();
  });
  await test('通知切换更新现有控制台，访客通知不被改写、不再单独发切换消息',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(update(1,1,'/admin'));const menu=(await ui(t,'menu',1)).messageId;resetRequests();await t.bot.fetch(callback('nfocus:2'));assert.equal(adminSends().length,0);assert.equal(lastEdit().message_id,menu);assert.match(lastEdit().text,/tg:\/\/user\?id=2/);await t.drain();
  });
  await test('当前页面被外部删除时仅创建一个替代页面，后续开关使用新ID',async()=>{
    const t=instance();uniqueMessages();await t.bot.fetch(callback('away_settings'));const orig=apiHook;apiHook=async(method,payload)=>method==='editMessageText'&&payload.message_id===100?Response.json({ok:false,error_code:400,description:'Bad Request: message to edit not found'}):orig(method,payload);resetRequests();await t.bot.fetch(callback('away_on'));assert.equal(adminSends().length,1);const replacement=(await ui(t,'menu',1)).messageId;assert.notEqual(replacement,100);await runtime.handleCallback({id:'x',from:{id:1},data:'away_off',message:{message_id:replacement,chat:{id:1,type:'private'}}},rEnv(t),rCfg(t));assert.equal(adminSends().length,1);assert.equal(lastEdit().message_id,replacement);await t.drain();
  });
  await test('记录发送失败改写原快捷菜单后，后续admin及旧快捷点击不删除或改写永久记录',async()=>{
    const t=instance();uniqueMessages();const {data,id}=await prepareQuick(t),orig=apiHook;apiHook=async(method,payload)=>method==='sendMessage'&&payload.chat_id==='1'&&payload.text.includes('快捷回复已发送')?Response.json({ok:false,error_code:400,description:'cannot send receipt'}):orig(method,payload);await t.bot.fetch(callback(data));assert.match(lastEdit().text,/快捷回复已发送/);resetRequests();await t.bot.fetch(update(1,1,'/admin'));await t.bot.fetch(callback(data));assert.ok(!requests.some(r=>['deleteMessage','editMessageText','editMessageReplyMarkup'].includes(r.method)&&r.payload.message_id===id));await t.drain();
  });
  console.log(passed+' interaction checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
