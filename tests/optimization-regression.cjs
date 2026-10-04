const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const source=fs.readFileSync(require('node:path').resolve(__dirname, '../chuanhuatong.js'),'utf8');
let clock=Date.now(),requests=[],mode='ok',release=null;
class Clock extends Date { static now(){return clock;} }
let apiHook=null;
const runtime=vm.createContext({URL,URLSearchParams,Response,Request,TextEncoder,Date:Clock,crypto:crypto.webcrypto,AbortController,clearTimeout,
  setTimeout:(fn,ms)=>ms===500?(fn(),0):setTimeout(fn,ms),console:{warn(){},error(){},log(){}},
  fetch:async(url,options)=>{
    const method=url.split('/').pop();
    if(method==='siteverify')return Response.json({success:mode!=='challengeFail'});
    const payload=JSON.parse(options.body);requests.push({method,payload});
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
  transaction(fn){return this.enqueue(()=>fn({get:async k=>this.rawGet(k),put:async(k,v)=>this.rawPut(k,v),delete:async k=>this.rawDelete(k)}));}
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

(async()=>{
  await test('回执网络阻塞不拖住后续消息；回执失败不使成功消息重投',async()=>{
    const t=instance(legacy([['auth_2','true']])),releases=[];
    apiHook=async(method,payload)=>{if(method==='sendMessage'&&payload.chat_id==='2')await new Promise(resolve=>releases.push(resolve));return null;};
    assert.equal((await within(t.bot.fetch(update(2,1,'第一条')))).status,200);
    assert.equal((await within(t.bot.fetch(update(2,2,'第二条')))).status,200);
    assert.equal(requests.filter(r=>r.method==='copyMessage').length,2);
    for(const resolve of releases)resolve();await t.drain();
    apiHook=async(method,payload)=>{if(method==='sendMessage'&&payload.chat_id==='2')throw Error('receipt failed');return null;};
    await t.bot.fetch(update(2,3,'第三条'));await t.drain();await t.bot.fetch(update(2,3,'第三条'));await t.drain();
    assert.equal(requests.filter(r=>r.method==='copyMessage').length,3);
  });
  await test('慢 KV 镜像在队列外运行，管理员指令仍能处理',async()=>{
    const t=instance(),original=t.kv.put;let unblock;
    await t.bot.store.put('auth_2','true');
    t.kv.put=async(...args)=>{await new Promise(resolve=>{unblock=resolve;});t.kv.put=original;return original(...args);};
    const alarmTask=t.bot.alarm();
    while(!unblock)await new Promise(resolve=>setTimeout(resolve,1));
    assert.equal((await within(t.bot.fetch(update(1,1,'/admin')))).status,200);
    unblock();await alarmTask;await t.drain();
  });
  await test('管理员备注保存、修改、删除均不会转发给访客',async()=>{
    const t=instance(legacy([['recent_2',JSON.stringify({id:'2',firstName:'张三😀',updatedAt:clock})]]));
    await t.bot.fetch(update(1,1,'/note 2 客户 <A>&😀'));
    assert.equal(JSON.parse(await t.bot.store.get('note_2')).text,'客户 <A>&😀');
    const list=await runtime.buildRecentUsersText(t.bot.store);assert.match(list.text,/客户 &lt;A&gt;&amp;😀/);
    await t.bot.fetch(update(1,2,'/note 2 修改'));assert.equal(JSON.parse(await t.bot.store.get('note_2')).text,'修改');
    await t.bot.fetch(update(1,3,'/note 2 -'));assert.equal(await t.bot.store.get('note_2'),null);
    assert.ok(!requests.some(r=>r.method==='copyMessage'||r.payload.chat_id==='2'));await t.drain();
  });
  await test('回复映射备注与菜单输入固定对象，切换会话不会改错备注',async()=>{
    const t=instance(legacy([['msg_7','2']]));
    await t.bot.fetch(update(1,1,'/note 原备注',{reply_to_message:{message_id:7}}));
    assert.equal(JSON.parse(await t.bot.store.get('note_2')).text,'原备注');
    await runtime.requestAdminInput('note','2',rEnv(t),rCfg(t));
    await runtime.setActiveAdminTarget(t.bot.store,'1','3','第三人');
    await t.bot.fetch(update(1,2,'菜单备注',{reply_to_message:{message_id:99}}));
    assert.equal(JSON.parse(await t.bot.store.get('note_2')).text,'菜单备注');assert.equal(await t.bot.store.get('note_3'),null);await t.drain();
  });
  await test('备注限制按 Unicode 字符计算，访客不能修改备注',async()=>{
    const t=instance(legacy([['auth_2','true']]));
    await t.bot.fetch(update(1,1,'/note 2 '+'😀'.repeat(80)));assert.equal(Array.from(JSON.parse(await t.bot.store.get('note_2')).text).length,80);
    await t.bot.fetch(update(1,2,'/note 2 '+'😀'.repeat(81)));assert.equal(Array.from(JSON.parse(await t.bot.store.get('note_2')).text).length,80);
    await t.bot.fetch(update(2,3,'/note 2 访客篡改'));assert.notEqual(JSON.parse(await t.bot.store.get('note_2')).text,'访客篡改');await t.drain();
  });
  await test('搜索匹配昵称、用户名、备注和 ID；NFKC 兼容花体名字',async()=>{
    const t=instance(legacy([['auth_2','true'],['recent_2',JSON.stringify({id:'2',firstName:'𝖳𝖾𝗌𝗍 𝖠𝖻𝖼',username:'Test_Abc',updatedAt:clock})],['note_2',JSON.stringify({text:'合作方',firstName:'旧名'})]]));
    for(const q of ['test abc','@test_abc','合作方','2']) {
      const result=await runtime.buildContactSearch(t.bot.store,'1',q);assert.match(result.text,/1 人/);assert.ok(result.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='focus:2'));
    }
    const empty=await runtime.buildContactSearch(t.bot.store,'1','不存在');assert.match(empty.text,/没有找到/);
  });
  await test('搜索 23 个结果按 10/10/3 翻页；备注保留过期最近记录的昵称',async()=>{
    const entries=[];for(let i=2;i<25;i++)entries.push(['auth_'+i,'true'],['note_'+i,JSON.stringify({text:'客户',firstName:'旧昵称'+i})]);
    const t=instance(legacy(entries));
    for(const [page,n]of [[0,10],[1,10],[2,3]]){
      const result=await runtime.buildContactSearch(t.bot.store,'1','客户',page);assert.equal(result.replyMarkup.inline_keyboard.flat().filter(b=>b.callback_data.startsWith('focus:')).length,n);assert.match(result.text,/旧昵称/);
    }
  });
  await test('搜索命令和强制回复不会转发；过期翻页有提示；非管理员无访问权限',async()=>{
    const t=instance(legacy([['auth_2','true']]));
    await t.bot.fetch(update(1,1,'/search 2'));assert.equal(await t.bot.store.get('admin_search_1'),'2');
    await runtime.requestAdminInput('search',null,rEnv(t),rCfg(t));await t.bot.fetch(update(1,2,'2',{reply_to_message:{message_id:99}}));
    const c=rCfg(t);await t.bot.store.delete('admin_search_1');
    await runtime.handleCallback({id:'q',from:{id:1},data:'search_page:1',message:{message_id:9}},rEnv(t),c);assert.ok(requests.some(r=>r.payload.text?.includes('搜索已过期')));
    const count=requests.length;await runtime.handleCallback({id:'q2',from:{id:2},data:'diagnostics'},rEnv(t),c);
    assert.equal(requests.length,count+1);assert.equal(requests.at(-1).method,'answerCallbackQuery');await t.drain();
  });
  await test('默认闲置 30 分钟退出；无时间的旧会话和未来时间不会误发',async()=>{
    const t=instance();await runtime.setActiveAdminTarget(t.bot.store,'1','2','访客');clock+=30*60000;
    assert.equal(await runtime.getActiveAdminTarget(t.bot.store,'1'),null);
    for(const value of [{userId:'2',name:'旧会话'},{userId:'2',updatedAt:clock+1000}]){await t.bot.store.put('active_admin_1',JSON.stringify(value));assert.equal(await runtime.getActiveAdminTarget(t.bot.store,'1'),null);}
    await t.bot.fetch(update(1,1,'普通消息'));assert.equal(requests.filter(r=>r.method==='copyMessage').length,0);await t.drain();
  });
  await test('闲置时长可调整/关闭；成功沟通刷新，失败不延长',async()=>{
    const t=instance();await t.bot.fetch(update(1,1,'/session 5'));assert.equal(await runtime.getSessionIdleMinutes(t.bot.store,'1'),5);
    await runtime.setActiveAdminTarget(t.bot.store,'1','2','访客');clock+=4*60000;
    await t.bot.fetch(update(1,2,'成功消息'));const sentAt=JSON.parse(await t.bot.store.get('active_admin_1')).updatedAt;assert.equal(sentAt,clock);
    apiHook=async method=>method==='copyMessage'?Response.json({ok:false,error_code:403,description:'blocked'}):null;
    clock+=60000;await t.bot.fetch(update(1,3,'失败消息'));assert.equal(JSON.parse(await t.bot.store.get('active_admin_1')).updatedAt,sentAt);
    apiHook=null;await t.bot.fetch(update(1,4,'/session off'));clock+=2*60*60000;assert.ok(await runtime.getActiveAdminTarget(t.bot.store,'1'));await t.drain();
  });
  await test('定向推送其他人不改变当前会话；备注命令不刷新闲置时间',async()=>{
    const t=instance();await runtime.setActiveAdminTarget(t.bot.store,'1','2','访客');const original=JSON.parse(await t.bot.store.get('active_admin_1')).updatedAt;
    clock+=1000;await t.bot.fetch(update(1,1,'/send 3 你好'));await t.bot.fetch(update(1,2,'/note 2 测试'));
    const active=JSON.parse(await t.bot.store.get('active_admin_1'));assert.equal(active.userId,'2');assert.equal(active.updatedAt,original);await t.drain();
  });
  await test('切换更新控制台收件人、保留昵称链接；封禁联系人不能通过旧按钮切换',async()=>{
    const t=instance(legacy([['recent_2',JSON.stringify({id:'2',firstName:'张三',updatedAt:clock})]]));
    await runtime.handleCallback({id:'q',from:{id:1},data:'nfocus:2'},rEnv(t),rCfg(t));
    assert.ok(requests.some(r=>r.payload.text?.includes('当前对话联系人：') && r.payload.text.includes('<a href="tg://user?id=2">张三</a>')));
    await t.bot.store.put('lock_3',String(clock+10000));await runtime.handleCallback({id:'q2',from:{id:1},data:'focus:3'},rEnv(t),rCfg(t));
    assert.equal((await runtime.getActiveAdminTarget(t.bot.store,'1')).userId,'2');await t.drain();
  });
  await test('访客相册乱序更新收齐后合并、只回执一次、每张图片均可回复',async()=>{
    batchResponses();const t=instance(legacy([['auth_2','true']]));
    for(const id of [12,10,11])assert.equal((await t.bot.fetch(album(2,'g1',id))).status,200);
    assert.equal(batchCalls().length,0);await mature(t);
    assert.equal(batchCalls().length,1);assert.deepEqual(batchCalls()[0].payload.message_ids,[10,11,12]);
    for(const id of [900,901,902])assert.equal(await t.bot.store.get('msg_'+id),'2');
    assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.text?.includes('相册送出')).length,1);
  });
  await test('相册成员重复投递不重复收集；实例重建仍保留待发送相册',async()=>{
    batchResponses();const t=instance(legacy([['auth_2','true']]));await t.bot.fetch(album(2,'g2',10));await t.bot.fetch(album(2,'g2',10));await t.bot.fetch(album(2,'g2',11));
    const restart=instance(t.kv,t.storage);await mature(restart);assert.equal(batchCalls().length,1);assert.deepEqual(batchCalls()[0].payload.message_ids,[10,11]);
    await restart.bot.fetch(album(2,'g2',10));await mature(restart);assert.equal(batchCalls().length,1);
  });
  await test('十张图片只消耗一次限额；三组相册允许、第四组只提示一次',async()=>{
    batchResponses();const t=instance(legacy([['auth_2','true']]));
    for(let id=1;id<=10;id++)await t.bot.fetch(album(2,'g3',id));
    await t.bot.fetch(album(2,'g4',11));await t.bot.fetch(album(2,'g5',12));await t.bot.fetch(album(2,'g6',13));await t.bot.fetch(album(2,'g6',14));
    assert.equal(requests.filter(r=>r.payload.text?.includes('发得有点快')).length,1);await mature(t);assert.equal(batchCalls().length,3);
  });
  await test('管理员相册固定首个收件人，中途切换不分发给不同人',async()=>{
    batchResponses();const t=instance();await runtime.setActiveAdminTarget(t.bot.store,'1','2','第二人');
    await t.bot.fetch(album(1,'admin1',10));await runtime.setActiveAdminTarget(t.bot.store,'1','3','第三人');await t.bot.fetch(album(1,'admin1',11));await mature(t);
    assert.equal(batchCalls().length,1);assert.equal(batchCalls()[0].method,'copyMessages');assert.equal(batchCalls()[0].payload.chat_id,'2');
    assert.equal((await runtime.getActiveAdminTarget(t.bot.store,'1')).userId,'3');
  });
  await test('相册明确回复优先于当前会话，即使回复信息在后到的成员上',async()=>{
    batchResponses();const t=instance(legacy([['msg_7','2']]));await runtime.setActiveAdminTarget(t.bot.store,'1','3','第三人');
    await t.bot.fetch(album(1,'admin2',10));await t.bot.fetch(album(1,'admin2',11,7));await mature(t);
    assert.equal(batchCalls()[0].payload.chat_id,'2');assert.equal((await runtime.getActiveAdminTarget(t.bot.store,'1')).userId,'2');
  });
  await test('相册无当前收件人时可等待同组明确回复，否则提示先选择',async()=>{
    batchResponses();const t=instance(legacy([['msg_7','2']]));await t.bot.fetch(album(1,'admin3',10));await t.bot.fetch(album(1,'admin3',11,7));await mature(t);assert.equal(batchCalls()[0].payload.chat_id,'2');
    await runtime.clearActiveAdminTarget(t.bot.store,'1');await t.bot.fetch(album(1,'admin4',12));await mature(t);assert.equal(batchCalls().length,1);assert.ok(requests.some(r=>r.payload.text?.includes('请先选择联系人')));
  });
  await test('冲突回复和失效映射不发送相册',async()=>{
    batchResponses();const t=instance(legacy([['msg_7','2'],['msg_8','3']]));await t.bot.fetch(album(1,'admin5',10,7));await t.bot.fetch(album(1,'admin5',11,8));await mature(t);assert.equal(batchCalls().length,0);
    await t.bot.fetch(album(1,'admin6',12,999));await mature(t);assert.equal(batchCalls().length,0);
  });
  await test('相册等待期间撤销授权/封禁即停止发送',async()=>{
    batchResponses();for(const action of ['revoke','ban']){
      const t=instance(legacy([['auth_2','true']]));await t.bot.fetch(album(2,'g7',10));
      if(action==='revoke')await t.bot.store.delete('auth_2');else await t.bot.store.put('lock_2',String(clock+10000));
      await mature(t);
    }
    assert.equal(batchCalls().length,0);
  });
  await test('相册网络结果不明确时不盲目重发，重启后也不重发',async()=>{
    apiHook=async method=>{if(method==='copyMessages')throw Error('network outcome unknown');return null;};
    const t=instance(legacy([['auth_2','true']]));await t.bot.fetch(album(2,'g8',10));await mature(t);assert.equal(batchCalls().length,1);
    const restart=instance(t.kv,t.storage);await mature(restart);assert.equal(batchCalls().length,1);assert.equal((await restart.bot.diagnostics()).failedAlbums,1);
  });
  await test('发送中状态在重建后标记待确认；已发送检查点只恢复映射',async()=>{
    batchResponses();const t=instance();await t.storage.put('a:2:crash',{state:'sending',kind:'visitor',fromId:'2',targetId:'1',ids:[1],createdAt:clock,updatedAt:clock,dueAt:clock});
    await t.storage.put('a:2:sent',{state:'sent',kind:'visitor',fromId:'2',targetId:'1',ids:[2,3],resultIds:[801,802],createdAt:clock,updatedAt:clock,dueAt:clock});
    await mature(t);assert.equal(batchCalls().length,0);assert.equal(await t.bot.store.get('msg_801'),'2');assert.equal((await t.bot.diagnostics()).failedAlbums,1);
  });
  await test('Telegram 部分跳过图片会显示部分送达，不伪称全部成功',async()=>{
    apiHook=async method=>method==='copyMessages'?Response.json({ok:true,result:[{message_id:900}]}):null;
    const t=instance(legacy([['auth_2','true']]));await t.bot.fetch(album(2,'g9',10));await t.bot.fetch(album(2,'g9',11));await mature(t);
    assert.ok(requests.some(r=>r.payload.text?.includes('1/2')));assert.ok((await t.bot.diagnostics()).stats.failures.some(f=>f.label==='相册部分送达'));
  });
  await test('明确的 429 根据 retry_after 延后；明确的 400 不自动重试',async()=>{
    let attempts=0;apiHook=async(method,payload)=>{if(method!=='copyMessages')return null;if(attempts++===0)return Response.json({ok:false,error_code:429,parameters:{retry_after:3},description:'Too many requests'});return Response.json({ok:true,result:payload.message_ids.map(()=>({message_id:900}))});};
    const t=instance(legacy([['auth_2','true']]));await t.bot.fetch(album(2,'g10',10));await mature(t);assert.equal(batchCalls().length,1);clock+=4000;await t.bot.alarm();await t.drain();assert.equal(batchCalls().length,2);
    apiHook=async method=>method==='copyMessages'?Response.json({ok:false,error_code:400,description:'Bad album'}):null;
    await t.bot.fetch(album(2,'g11',11));await mature(t);await mature(t);assert.equal(batchCalls().length,3);
  });
  await test('晚到的相册成员仍会补发；大量完成记录不会饿死新相册',async()=>{
    batchResponses();const t=instance(legacy([['auth_2','true']]));await t.bot.fetch(album(2,'g12',10));await mature(t);await t.bot.fetch(album(2,'g12',11));await mature(t);assert.equal(batchCalls().length,2);
    for(let i=0;i<1005;i++)await t.storage.put('a:0:'+String(i).padStart(5,'0'),{state:'done',createdAt:clock,updatedAt:clock});
    await t.bot.fetch(album(2,'zznew',12));await mature(t);assert.equal(batchCalls().length,3);
  });
  await test('诊断保留最近失败与耗时，HTML 安全且脱敏，不公开完整 Webhook 地址',async()=>{
    const t=instance();await t.bot.recordFailure('测试','<script>TEST_TOKEN_PLACEHOLDER TEST_WEBHOOK_SECRET TEST_TURNSTILE_SECRET');
    apiHook=async method=>method==='getWebhookInfo'?Response.json({ok:true,result:{url:'https://bot.example/secret/path?key=secret',pending_update_count:3,last_error_date:clock/1000,last_error_message:'TEST_TOKEN_PLACEHOLDER <bad>'}}):null;
    await t.bot.fetch(update(1,1,'/diagnose'));const payload=requests.find(r=>r.method==='sendMessage'&&r.payload.text?.includes('运行诊断')).payload;
    assert.match(payload.text,/待投递更新：3/);assert.ok(!payload.text.includes('secret/path'));assert.ok(!payload.text.includes('TEST_TOKEN_PLACEHOLDER'));assert.ok(!payload.text.includes('TEST_WEBHOOK_SECRET'));assert.ok(!payload.text.includes('<script>'));assert.match(payload.text,/&lt;script&gt;/);
    await t.bot.recordApi('test',123,true);const d=await t.bot.diagnostics();assert.ok(d.stats.apiCount>0);assert.equal(d.stats.lastRequestStatus,200);await t.drain();
  });
  await test('诊断窗口限制最后 100 次接口耗时及最后 10 次失败',async()=>{
    const t=instance();for(let i=0;i<105;i++)await t.bot.recordApi('test',i,true);for(let i=0;i<15;i++)await t.bot.recordFailure('failure',String(i));
    const d=await t.bot.diagnostics();assert.equal(d.stats.apiCount,100);assert.equal(d.stats.apiTotalMs,5450);assert.equal(d.stats.failures.length,10);assert.equal(d.stats.failures[0].reason,'5');
  });
  await test('管理员回执失败不会让成功复制重发',async()=>{
    const t=instance();await runtime.setActiveAdminTarget(t.bot.store,'1','2','访客');
    apiHook=async(method,payload)=>{if(method==='sendMessage'&&payload.text?.includes('发送成功'))throw Error('admin receipt failed');return null;};
    await t.bot.fetch(update(1,1,'你好'));await t.drain();await t.bot.fetch(update(1,1,'你好'));assert.equal(requests.filter(r=>r.method==='copyMessage').length,1);
  });
  await test('相册后紧接普通消息时先转发相册，减少顺序颠倒',async()=>{
    batchResponses();const t=instance(legacy([['auth_2','true']]));await t.bot.fetch(album(2,'order',10));await t.bot.fetch(album(2,'order',11));await t.bot.fetch(update(2,12,'后面的文字'));
    const calls=requests.filter(r=>['copyMessages','copyMessage'].includes(r.method));assert.deepEqual(calls.map(r=>r.method),['copyMessages','copyMessage']);await t.drain();
  });
  await test('同一相册成员换更新 ID 重复到达不会重新切换管理员当前会话',async()=>{
    batchResponses();const t=instance(legacy([['msg_7','2']]));await t.bot.fetch(album(1,'duplicate',10,7));await runtime.setActiveAdminTarget(t.bot.store,'1','3','第三人');
    const duplicate=album(1,'duplicate',10,7),body=await duplicate.json();body.update_id=999999;
    await t.bot.fetch(new Request(duplicate.url,{method:'POST',headers:duplicate.headers,body:JSON.stringify(body)}));
    assert.equal((await runtime.getActiveAdminTarget(t.bot.store,'1')).userId,'3');await mature(t);
  });
  await test('KV 同步失败进入诊断且限频记录，授权和待同步任务仍保留',async()=>{
    const t=instance();await t.bot.store.put('auth_2','true');t.kv.failWrites=true;await t.bot.alarm();
    assert.equal(await t.bot.store.get('auth_2'),'true');assert.ok(await t.storage.get('o:auth_2'));
    assert.equal((await t.bot.diagnostics()).stats.failures.filter(f=>f.label==='KV 同步').length,1);
    clock+=2000;await t.bot.alarm();assert.equal((await t.bot.diagnostics()).stats.failures.filter(f=>f.label==='KV 同步').length,1);
  });
  console.log(passed+' optimization checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
