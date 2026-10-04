const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const source=fs.readFileSync(require('node:path').resolve(__dirname, '../chuanhuatong.js'),'utf8');
let clock=Date.now(),requests=[],mode='ok',release=null;
class Clock extends Date { static now(){return clock;} }
const runtime=vm.createContext({URL,URLSearchParams,Response,Request,TextEncoder,Date:Clock,crypto:crypto.webcrypto,AbortController,clearTimeout,
  setTimeout:(fn,ms)=>ms===500?(fn(),0):setTimeout(fn,ms),console:{warn(){},error(){},log(){}},
  fetch:async(url,options)=>{
    const method=url.split('/').pop();
    if(method==='siteverify')return Response.json({success:mode!=='challengeFail'});
    const payload=JSON.parse(options.body);requests.push({method,payload});
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
async function test(name,fn){clock=Date.now();requests=[];mode='ok';release=null;await fn();passed++;console.log('PASS '+name);}
(async()=>{
  await test('验证确认不等待欢迎通知，KV保持未授权时第一条消息仍立即转发',async()=>{
    const t=instance();mode='holdWelcome';
    const response=await within(grant(t));assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
    assert.equal(t.kv.data.get('auth_2'),undefined);
    await within((async()=>{while(!release)await new Promise(resolve=>setTimeout(resolve,1));})());
    assert.ok(release,'welcome request began in background');
    assert.equal((await within(t.bot.fetch(webhook()))).status,200);
    assert.equal(requests.filter(r=>r.method==='copyMessage').length,1);
    assert.ok(!requests.some(r=>r.payload.text?.includes('请先发送')));
    release();await t.drain();
  });
  await test('DO实例重建后授权仍即时有效，不依赖KV镜像',async()=>{
    const first=instance();await grant(first);await first.drain();
    const second=instance(first.kv,first.storage);
    assert.equal((await second.bot.fetch(webhook())).status,200);
    assert.equal(requests.filter(r=>r.method==='copyMessage').length,1);
    await second.drain();
  });
  await test('快速连发三条成功、第四条被限流，过程中没有直接KV写入',async()=>{
    const t=instance(legacy([['auth_2','true']]));
    const responses=await Promise.all([101,102,103,104].map(id=>t.bot.fetch(webhook(id))));
    assert.ok(responses.every(r=>r.status===200));assert.equal(requests.filter(r=>r.method==='copyMessage').length,3);
    assert.ok(requests.some(r=>r.payload.text?.includes('发得有点快')));
    assert.equal(t.kv.operations.filter(o=>o.op==='put').length,0);await t.drain();
  });
  await test('重复及并发Webhook只转发一次，重建后仍去重',async()=>{
    const t=instance(legacy([['auth_2','true']]));await Promise.all([t.bot.fetch(webhook()),t.bot.fetch(webhook())]);
    await t.bot.fetch(webhook());await t.drain();
    const restart=instance(t.kv,t.storage);await restart.bot.fetch(webhook());await restart.drain();
    assert.equal(requests.filter(r=>r.method==='copyMessage').length,1);
  });
  await test('发送结果未知时记录检查点并确认Webhook，不自动重复创建消息',async()=>{
    const t=instance(legacy([['auth_2','true']]));mode='networkFail';assert.equal((await t.bot.fetch(webhook())).status,200);
    assert.equal((await t.storage.get('s:2:101')).state,'uncertain');assert.ok(await t.storage.get('u:101'));
    mode='ok';assert.equal((await t.bot.fetch(webhook())).status,200);assert.equal(requests.filter(r=>r.method==='copyMessage').length,1);
    assert.equal(await t.bot.store.get('inbox_2'),null);assert.equal(await t.bot.store.get('replied_2'),null);await t.drain();
  });
  await test('旧授权、昵称、映射及TTL自动读取，过期数据不会复活',async()=>{
    const t=instance(legacy([['auth_2','true'],['msg_7','2'],['recent_2',JSON.stringify({id:'2',firstName:'旧昵称',updatedAt:clock})]],{'msg_7':{expiration:Math.floor(clock/1000)+1},'recent_2':{expiration:Math.floor(clock/1000)+86400}}));
    assert.equal(await t.bot.store.get('auth_2'),'true');assert.equal(await t.bot.store.get('msg_7'),'2');
    assert.match(await t.bot.store.get('recent_2'),/旧昵称/);clock+=2000;
    assert.equal(await t.bot.store.get('msg_7'),null);
  });
  await test('250及1000访客首屏仅10人，首次KV操作低于100，翻页不再读取旧KV',async()=>{
    for(const count of [250,1000]) {
      const entries=[];for(let i=2;i<count+2;i++)entries.push(['recent_'+i,JSON.stringify({id:String(i),firstName:'访客😀',updatedAt:clock-i})],['auth_'+i,'true']);
      const t=instance(legacy(entries));const list=await runtime.buildRecentUsersText(t.bot.store);
      assert.equal(list.replyMarkup.inline_keyboard.flat().filter(b=>b.callback_data.startsWith('focus:')).length,10);
      assert.ok(t.kv.operations.length<100,'KV count='+t.kv.operations.length);
      const original=t.kv.operations.length;await runtime.buildRecentUsersText(t.bot.store,1);assert.equal(t.kv.operations.length,original);
      console.log('  '+count+' users: '+original+' legacy KV operations initially, 0 on next page');
    }
  });
  await test('已授权列表容忍坏JSON、null、数组、非法时间和ISO日期',async()=>{
    const entries=[['auth_2','true'],['recent_2',JSON.stringify({id:'2',firstName:'异常时间',updatedAt:'bad date'})],['auth_3','true'],['recent_3','null'],['auth_4','true'],['recent_4','[1,2]'],['auth_5','true'],['recent_5','{broken'],['auth_6','true'],['recent_6',JSON.stringify({id:'6',firstName:'ISO',updatedAt:new Date(clock).toISOString()})]];
    const t=instance(legacy(entries));const list=await runtime.buildAuthedUsersText(t.bot.store,'1',cfg);
    assert.equal(list.replyMarkup.inline_keyboard.flat().filter(b=>b.callback_data.startsWith('focus:')).length,5);assert.match(list.text,/ISO/);assert.match(list.text,/30天内无消息/);
  });
  await test('镜像写入合并为最新值，短间隔不重复写同一KV键',async()=>{
    const t=instance();await t.bot.store.put('auth_2','true');await t.bot.store.put('auth_2','false');await t.bot.store.put('auth_2','true');
    await t.bot.store.flushMirrors();assert.equal(t.kv.data.get('auth_2'),'true');assert.equal(t.kv.operations.filter(o=>o.op==='put').length,1);
    await t.bot.store.put('auth_2','false');await t.bot.store.flushMirrors();assert.equal(t.kv.operations.filter(o=>o.op==='put').length,1);
    clock+=1500;await t.bot.store.flushMirrors();assert.equal(t.kv.data.get('auth_2'),'false');assert.equal(t.kv.operations.filter(o=>o.op==='put').length,2);
  });
  await test('KV写入故障不阻塞授权，待同步任务保留且恢复后写回',async()=>{
    const t=instance();t.kv.failWrites=true;await grant(t);await t.drain();await t.bot.alarm();
    assert.equal(await t.bot.store.get('auth_2'),'true');assert.ok(await t.storage.get('o:auth_2'));assert.ok(t.storage.alarm>clock);
    t.kv.failWrites=false;clock+=2000;await t.bot.alarm();assert.equal(t.kv.data.get('auth_2'),'true');assert.equal(await t.storage.get('o:auth_2'),undefined);
  });
  await test('镜像过程中更新记录不会丢失新值，下次同步最新状态',async()=>{
    const t=instance(),original=t.kv.put;
    await t.bot.store.put('auth_2','true');t.kv.put=async(...args)=>{await original(...args);await t.bot.store.put('auth_2','false');t.kv.put=original;};
    await t.bot.store.flushMirrors();assert.equal(await t.bot.store.get('auth_2'),'false');assert.ok(await t.storage.get('o:auth_2'));
    clock+=1500;await t.bot.store.flushMirrors();assert.equal(t.kv.data.get('auth_2'),'false');
  });
  await test('撤销与封禁立即生效，即使旧KV仍是已授权',async()=>{
    const t=instance(legacy([['auth_2','true']]));await runtime.revokeAuth('2',{BOT_KV:t.bot.store},cfg);
    assert.equal(t.kv.data.get('auth_2'),'true');requests=[];await t.bot.fetch(webhook());assert.equal(requests.filter(r=>r.method==='copyMessage').length,0);
    await runtime.banUser('2',{BOT_KV:t.bot.store},cfg);assert.equal((await t.bot.fetch(verification())).status,403);await t.drain();
  });
  await test('重复验证只通知一次，通知失败不撤销授权',async()=>{
    const t=instance();mode='welcomeFail';await grant(t);await grant(t);await t.drain();
    assert.equal(await t.bot.store.get('auth_2'),'true');assert.equal(requests.filter(r=>r.payload.text?.includes('新访客接入')).length,1);
  });
  await test('授权已落盘但上次网页响应丢失时，再提交无需重用Turnstile令牌',async()=>{
    const t=instance();await grant(t);await t.drain();mode='challengeFail';
    assert.equal((await grant(t)).status,200);assert.equal(requests.filter(r=>r.payload.text?.includes('新访客接入')).length,1);
  });
  await test('伪造签名、过期和未来时间、失败Turnstile均不授权',async()=>{
    for(const bad of ['bad signature',initData(2,clock/1000-3700),initData(2,clock/1000+600)]) {
      const t=instance();assert.equal((await t.bot.fetch(verification(bad))).status,403);assert.equal(await t.bot.store.get('auth_2'),null);
    }
    const t=instance();mode='challengeFail';assert.equal((await grant(t)).status,403);assert.equal(await t.bot.store.get('auth_2'),null);
  });
  await test('缺少绑定明确返回503，伪造Webhook在进入协调器前拒绝',async()=>{
    const t=instance(),worker=vm.runInContext('worker',runtime),bindings={...t.bindings};delete bindings.BOT_STATE;
    assert.equal((await worker.fetch(webhook(),bindings,{waitUntil(){}})).status,503);
    const forged=webhook();forged.headers.set('X-Telegram-Bot-Api-Secret-Token','wrong');
    assert.equal((await worker.fetch(forged,t.bindings,{waitUntil(){}})).status,403);
  });
  await test('真实Worker入口转入同一协调器，验证后即时转发',async()=>{
    const t=instance(),worker=vm.runInContext('worker',runtime);assert.equal((await worker.fetch(verification(),t.bindings,{})).status,200);
    assert.equal((await worker.fetch(webhook(),t.bindings,{})).status,200);assert.equal(requests.filter(r=>r.method==='copyMessage').length,1);await t.drain();
  });
  await test('删除记录同步后清理本地墓碑也不从旧KV缓存复活',async()=>{
    const t=instance(legacy([['auth_2','true']]));await t.bot.store.list({prefix:'auth_'});await t.bot.store.delete('auth_2');await t.bot.store.flushMirrors();
    t.kv.data.set('auth_2','true');await t.bot.store.sweepExpired();assert.equal(await t.bot.store.get('auth_2'),null);
    const list=await t.bot.store.list({prefix:'auth_'});assert.equal(list.keys.length,0);
  });
  await test('原页面提交成功后立即调用close，失败时保持窗口并允许重试',async()=>{
    const html=await (await runtime.serveTurnstilePage({turnstileSiteKey:'TEST'})).text();
    const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
    for(const fail of [false,true]) {
      const elements=new Map(),element=id=>{if(!elements.has(id))elements.set(id,{style:{},value:'',textContent:''});return elements.get(id);};
      let closed=0,resets=0,delays=0,posts=0;
      const ui=vm.createContext({URLSearchParams,AbortController,clearTimeout(){},document:{getElementById:element,querySelector:()=>element('h2')},window:{Telegram:{WebApp:{initData:'SIGNED_DATA',ready(){},disableClosingConfirmation(){},close(){closed++;}}},turnstile:{reset(){resets++;}}},setTimeout(fn,ms){if(ms!==15000)delays++;return 1;},fetch:async()=>{posts++;return fail?new Response('验证失败',{status:403}):Response.json({ok:true});}});
      vm.runInContext(script,ui);await ui.onSuccess('TOKEN');assert.equal(closed,fail?0:1);assert.equal(delays,0);assert.equal(resets,fail?1:0);assert.equal(posts,1);
      if(fail){await ui.onSuccess('NEW_TOKEN');assert.equal(posts,2);}
    }
  });
  console.log(`${passed} stability checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1});
