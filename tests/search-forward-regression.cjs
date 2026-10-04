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
(async()=>{
  await test('按钮搜索完成后删关键词与提示，结果仍编辑原控制台且分页条件保留',async()=>{
    const t=instance(legacy([record(2,'张三')]));accurateApi();await t.bot.fetch(callback('contact_search'));const prompt=await pendingSearch(t);requests=[];assert.equal((await t.bot.fetch(update(1,99,'张',{reply_to_message:{message_id:prompt.messageId}}))).status,200);assert.equal(nativeEdit().message_id,100);assert.ok(nativeEdit().text.includes('张三'));assert.equal(deleted(99).length,1);assert.equal(deleted(prompt.messageId).length,1);assert.equal(await pendingSearch(t),null);assert.equal(await t.bot.store.get('admin_search_1'),'张');assert.ok(requests.findIndex(r=>r.method==='editMessageText')<requests.findIndex(r=>r.method==='deleteMessage'&&r.payload.message_id===99));assert.equal(noAdminCopies().length,0);await t.drain();
  });
  await test('直接/search关键词命令在结果发送后删整条输入，不删结果或无关消息',async()=>{
    const t=instance(legacy([record(2,'Alice')]));accurateApi();await t.bot.fetch(update(1,99,'/search Alice'));const result=requests.find(r=>r.method==='sendMessage'&&r.payload.text?.startsWith('🔎'));assert.ok(result);assert.equal(deleted(99).length,1);assert.equal(deletes().length,1);assert.equal(await t.bot.store.get('admin_search_1'),'Alice');assert.equal(noAdminCopies().length,0);await t.drain();
  });
  await test('无搜索结果也清理有效关键词，搜索23人分页保留条件且不反复删除输入',async()=>{
    for(const phrase of ['没找到','张']){const t=instance(legacy(Array.from({length:23},(_,i)=>record(i+2,'张'+i))));accurateApi();await t.bot.fetch(update(1,99,'/search '+phrase));assert.equal(deleted(99).length,1);if(phrase==='没找到')assert.ok(requests.find(r=>r.method==='sendMessage'&&r.payload.text?.includes('没有找到联系人')));else{await t.bot.fetch(callback('search_page:1'));assert.equal((nativeEdit().text.match(/<code>/g)||[]).length,10);assert.equal(deleted(99).length,1);assert.equal(await t.bot.store.get('admin_search_1'),'张');}await t.drain();requests=[];}
  });
  await test('过长或无效关键词保留输入与搜索上下文，普通备注不自动删除管理员文字',async()=>{
    const t=instance();accurateApi();await t.bot.fetch(callback('contact_search'));const prompt=await pendingSearch(t);requests=[];await t.bot.fetch(update(1,99,'字'.repeat(65),{reply_to_message:{message_id:prompt.messageId}}));assert.equal(deleted(99).length,0);assert.equal((await pendingSearch(t)).messageId,prompt.messageId);assert.equal(await t.bot.store.get('admin_search_1'),null);await t.bot.fetch(update(1,199,'/note 2 备注'));assert.equal(deleted(199).length,0);await t.drain();
  });
  await test('结果编辑失败时保留关键词与搜索输入，不在失败前删除用户输入',async()=>{
    const t=instance(legacy([record(2)]));accurateApi();await t.bot.fetch(callback('contact_search'));const prompt=await pendingSearch(t),normal=apiHook;requests=[];apiHook=async(method,payload)=>method==='editMessageText'?Response.json({ok:false,error_code:400,description:'bad parse entities'}):normal(method,payload);assert.equal((await t.bot.fetch(update(1,99,'Alice',{reply_to_message:{message_id:prompt.messageId}}))).status,503);assert.equal(deleted(99).length,0);assert.equal((await pendingSearch(t)).messageId,prompt.messageId);await t.drain();
  });
  await test('结果新发明确失败同样保留关键词，不将未显示的搜索当成完成',async()=>{
    const t=instance(legacy([record(2)]));accurateApi();const normal=apiHook;apiHook=async(method,payload)=>method==='sendMessage'&&payload.text?.startsWith('🔎')?Response.json({ok:false,error_code:429,description:'Too Many Requests'}):normal(method,payload);assert.equal((await t.bot.fetch(update(1,99,'/search Alice'))).status,200);assert.equal(deleted(99).length,0);assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.text?.startsWith('🔎')).length,1);await t.drain();
  });
  await test('删除输入被拒绝或网络失败仍保留已显示结果，成功更新重投不重复搜索',async()=>{
    for(const failure of ['denied','network']){const t=instance(legacy([record(2)]));accurateApi();const normal=apiHook;apiHook=async(method,payload)=>{if(method==='deleteMessage'&&payload.message_id===99){if(failure==='network')throw Error('delete failed');return Response.json({ok:false,error_code:400,description:"message can't be deleted"});}return normal(method,payload);};assert.equal((await t.bot.fetch(update(1,99,'/search Alice'))).status,200);await t.bot.fetch(update(1,99,'/search Alice'));assert.equal(deleted(99).length,1);assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.text?.startsWith('🔎')).length,1);await t.drain();requests=[];}
  });
  await test('访客发送/search文字不会按管理员搜索输入删除或泄露搜索资料',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(update(2,99,'/search Alice'));assert.ok(!deletes().some(r=>r.payload.message_id===99));assert.equal(await t.bot.store.get('admin_search_1'),null);assert.equal(requests.filter(r=>r.method==='copyMessage').length,1);await t.drain();
  });
  await test('直接搜索成功清理旧输入状态；迟到旧搜索回复不转发给当前访客',async()=>{
    const t=instance(legacy([record(2)]));accurateApi();await t.bot.fetch(callback('contact_search'));const prompt=await pendingSearch(t);await t.bot.fetch(update(1,99,'/search Alice'));assert.equal(await pendingSearch(t),null);assert.equal(deleted(prompt.messageId).length,1);await runtime.setActiveAdminTarget(t.bot.store,'1','2','Alice');requests=[];await t.bot.fetch(update(1,100,'迟到词',{reply_to_message:{message_id:prompt.messageId}}));assert.equal(noAdminCopies().length,0);await t.drain();
  });
  await test('原生转发直接在同一消息挂昵称，使用forward而非copy且不新增引用卡片',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(native(1));const origin=await orig(t,2,1),button=markupEdits()[0].payload;assert.equal(origin.transport,'forward');assert.equal(requests.filter(r=>r.method==='forwardMessage').length,1);assert.equal(requests.filter(r=>r.method==='copyMessage').length,0);assert.equal(button.message_id,origin.relayedId);assert.equal(contactRows(button)[0].text,'💬 张三😀');assert.equal(cards().length,0);assert.equal(origin.relayContact,true);assert.equal(await t.bot.store.get('msg_'+origin.relayedId),'2');assert.equal(requests.filter(r=>['editMessageText','editMessageCaption','editMessageMedia'].includes(r.method)).length,0);await t.drain();
  });
  await test('原网址复制颜色按钮保持原样，访客入口只追加一行且清理只移除该行',async()=>{
    const bank={inline_keyboard:[[{text:'资源',url:'https://example.com/resource',style:'primary',icon_custom_emoji_id:'1234'}],[{text:'原复制',copy_text:{text:'资源ID'},style:'success'}]]};const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(native(1,{reply_markup:bank}));const first=(await orig(t,2,1)).relayedId;assert.deepEqual(markupEdits()[0].payload.reply_markup.inline_keyboard.slice(0,-1),bank.inline_keyboard);clock+=1100;await t.bot.fetch(native(2,{reply_markup:bank}));assert.equal(cleared(first).length,1);assert.deepEqual(cleared(first)[0].payload.reply_markup,bank);assert.equal(cards().length,0);assert.equal((await orig(t,2,1)).relayContact,false);await t.drain();
  });
  await test('以转发响应的实际原键盘为准，不用来源中不同的键盘覆盖它',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();const normal=apiHook,actual={inline_keyboard:[[{text:'实际资源',url:'https://example.com/actual'}]]};apiHook=async(method,payload)=>method==='forwardMessage'?Response.json({ok:true,result:{message_id:++messageCounter,forward_origin:channel,reply_markup:actual}}):normal(method,payload);await t.bot.fetch(native(1,{reply_markup:resources}));assert.deepEqual(markupEdits()[0].payload.reply_markup.inline_keyboard[0],actual.inline_keyboard[0]);assert.equal(cards().length,0);await t.drain();
  });
  await test('外部回调支付登录小程序与私有主页按钮不被冒充或删掉，继续引用备用',async()=>{
    for(const action of [{callback_data:'away_on'},{pay:true},{login_url:{url:'https://example.com/login'}},{web_app:{url:'https://example.com/app'}},{switch_inline_query:'资源'},{url:'tg://user?id=2'}]){const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(native(1,{reply_markup:{inline_keyboard:[[{text:'原按钮',...action}]]}}));assert.equal(markupEdits().length,0);assert.equal(cards().length,1);assert.equal(await t.bot.store.get('away_admin_1'),null);await t.drain();requests=[];}
  });
  await test('直接挂按钮被拒绝、限流或网络不明时只回退身份卡片，不重复转发实际内容',async()=>{
    for(const error of [400,429,'network']){const t=instance(legacy(auth(2)));accurateApi();const normal=apiHook;apiHook=async(method,payload)=>{if(method==='editMessageReplyMarkup'){if(error==='network')throw Error('markup response lost');return Response.json({ok:false,error_code:error,description:error===429?'Too Many Requests':"message can't be edited",parameters:{retry_after:2}});}return normal(method,payload);};await t.bot.fetch(native(1));assert.equal(requests.filter(r=>r.method==='forwardMessage').length,1);assert.equal(requests.filter(r=>r.method==='copyMessage').length,0);assert.equal(cards().length,1);assert.equal(cards()[0].payload.reply_parameters.message_id,(await orig(t,2,1)).relayedId);await t.drain();requests=[];}
  });
  await test('完整转发相册保持forwardMessages和分组，仅一个成员挂昵称，不产生引用卡片',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();for(const mid of [1,2])await t.bot.fetch(update(2,mid,undefined,{...photo('图'+mid),media_group_id:'forward_album',forward_origin:channel}));await mature(t);assert.equal(batchCalls()[0].method,'forwardMessages');assert.deepEqual(batchCalls()[0].payload.message_ids,[1,2]);assert.equal(markupEdits().length,1);assert.equal(contactRows(markupEdits()[0].payload).length,1);assert.equal(cards().length,0);assert.equal((await orig(t,2,1)).relayContact,true);assert.equal((await orig(t,2,2)).relayContact,false);assert.equal((await orig(t,2,1)).transport,'forward');await t.drain();
  });
  await test('部分送达转发相册不猜测来源键盘与编辑映射，引用实际送达成员',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();const normal=apiHook;apiHook=async(method,payload)=>method==='forwardMessages'?Response.json({ok:true,result:[{message_id:++messageCounter}]}):normal(method,payload);for(const mid of [1,2])await t.bot.fetch(update(2,mid,undefined,{...photo('图'+mid),media_group_id:'partial_forward',forward_origin:channel}));await mature(t);assert.equal(markupEdits().length,0);assert.equal(cards().length,1);assert.equal(await orig(t,2,1),null);assert.equal(await orig(t,2,2),null);assert.equal(await t.bot.store.get('msg_'+cards()[0].payload.reply_parameters.message_id),'2');await t.drain();
  });
  await test('管理员插入后保留原生转发的上一组昵称，之后只清理新组入口',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(native(1));const first=(await orig(t,2,1)).relayedId;await t.bot.fetch(update(1,99,'/admin'));clock+=1100;await t.bot.fetch(native(2));const second=(await orig(t,2,2)).relayedId;clock+=1100;await t.bot.fetch(native(3));assert.equal(cleared(first).length,0);assert.equal(cleared(second).length,1);assert.equal((await orig(t,2,1)).relayContact,true);assert.equal(cards().length,0);await t.drain();
  });
  await test('引用备用转为直接入口只删除旧引用，直接入口转备用只清理自身昵称行',async()=>{
    const t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(native(1,{reply_markup:resources}));const first=(await orig(t,2,1)).relayedId,card=JSON.parse(await t.bot.store.get('ui_relay_group_1')).messageId;clock+=1100;await t.bot.fetch(native(2));const second=(await orig(t,2,2)).relayedId;assert.equal(deleted(card).length,1);assert.equal(deleted(first).length,0);clock+=1100;await t.bot.fetch(native(3,{reply_markup:resources}));assert.equal(cleared(second).length,1);assert.equal(deleted(second).length,0);assert.equal(await t.bot.store.get('msg_'+first),'2');await t.drain();
  });
  await test('原生转发入口与连续组重建后恢复，重复投递不重复转发或挂按钮',async()=>{
    let t=instance(legacy(auth(2)));accurateApi();await t.bot.fetch(native(1));const first=(await orig(t,2,1)).relayedId;await t.bot.fetch(native(1));assert.equal(requests.filter(r=>r.method==='forwardMessage').length,1);assert.equal(markupEdits().length,1);await t.drain();t=instance(t.kv,t.storage);clock+=1100;await t.bot.fetch(native(2));assert.equal(cleared(first).length,1);assert.equal(await t.bot.store.get('msg_'+first),'2');assert.equal(cards().length,0);await t.drain();
  });
  await test('管理员方向的真实转发继续保留原生来源与键盘，不添加访客昵称',async()=>{
    const t=instance();accurateApi();await runtime.setActiveAdminTarget(t.bot.store,'1','2','对象');await t.bot.fetch(update(1,99,'原生资源',{forward_origin:channel,reply_markup:resources}));assert.equal(requests.filter(r=>r.method==='forwardMessage').length,1);assert.equal(markupEdits().length,0);assert.equal(cards().length,0);assert.equal((await orig(t,1,99)).replyMarkup,null);await t.drain();
  });
  console.log(passed+' search cleanup / native forward checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
