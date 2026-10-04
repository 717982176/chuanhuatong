const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict');
const source=fs.readFileSync(process.argv[2] || require('node:path').resolve(__dirname, '../chuanhuatong.js'),'utf8');
const config={adminId:'1',apiUrl:'https://example.invalid/'};
let requests=[], mode='ok';
const context=vm.createContext({Response,URL,console:{log(){},warn(){},error(){}},setTimeout:(fn)=>{fn();return 0;},
  fetch:async(url,options)=>{
    const method=url.split('/').pop(),payload=JSON.parse(options.body);
    requests.push({method,payload});
    if(method==='getChat') {
      if(mode==='profileNetwork') throw new Error('profile unavailable');
      return Response.json(mode==='profileFail'?{ok:false,error_code:400,description:'chat not found'}:
        {ok:true,result:{id:payload.chat_id,first_name:'目标😀',username:'target_user'}});
    }
    if((mode==='sendFail'&&method==='sendMessage'&&payload.chat_id!=='1')||(mode==='copyFail'&&method==='copyMessage')) {
      return Response.json({ok:false,error_code:403,description:'Forbidden: bot was blocked by the user'},{status:403});
    }
    return Response.json({ok:true,result:{message_id:99}});
  }});
vm.runInContext(source.replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }').replace('export class BotCoordinator', 'class BotCoordinator').replace('export default {','const worker = {'),context);
function kv(entries=[], keyInfo={}) {
  const values=new Map(entries);
  return {values,get:async key=>values.get(key)||null,put:async(key,value,options={})=>{
    values.set(key,value); keyInfo[key]={metadata:options.metadata,expiration:options.expirationTtl?Math.floor(Date.now()/1000)+options.expirationTtl:undefined};
  },delete:async key=>values.delete(key),
    list:async({prefix})=>({keys:[...values.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name,...keyInfo[name]})),list_complete:true})};
}
function recent(id,name,time) {return ['recent_'+id,JSON.stringify({id,firstName:name,username:'',updatedAt:time})];}
async function ids(storage) {return Array.from(await context.getRecentFocusUsers(storage,12,'1'),u=>u.id);}
let passed=0;
async function test(name,run) {requests=[];mode='ok';await run();passed++;console.log('PASS '+name);}
(async()=>{
  await test('成功 /send 新联系人进入切换列表，保存昵称及时间，保持原验证状态',async()=>{
    const storage=kv(),start=Date.now();
    await context.handleAdminMessage({message_id:1},'/send 2 你好',{BOT_KV:storage},config);
    const record=JSON.parse(storage.values.get('recent_2'));
    assert.equal(record.firstName,'目标😀');
    assert.equal(record.username,'target_user');
    assert.ok(record.updatedAt>=start);
    assert.equal(storage.values.get('replied_2'),'true');
    assert.ok(!storage.values.has('auth_2'));
    assert.deepEqual(await ids(storage),['2']);
    const dialog=await context.buildSwitchDialog(storage,'1');
    assert.ok(dialog.replyMarkup.inline_keyboard.flat().some(b=>b.text==='目标😀'&&b.callback_data==='focus:2'));
  });
  await test('发送失败不创建联系人或成功沟通标记',async()=>{
    mode='sendFail';
    const storage=kv();
    await context.handleAdminMessage({message_id:1},'/send 2 你好',{BOT_KV:storage},config);
    assert.ok(!storage.values.has('recent_2'));
    assert.ok(!storage.values.has('replied_2'));
    assert.deepEqual(await ids(storage),[]);
  });
  await test('已有联系人保留昵称，成功发送更新排序时间，不额外请求资料',async()=>{
    const storage=kv([recent('2','已知名字',1),recent('3','另一个',Date.now()-60000),['auth_2','true'],['auth_3','true']]);
    await context.handleAdminMessage({message_id:1},'/send 2 再联系',{BOT_KV:storage},config);
    assert.equal(JSON.parse(storage.values.get('recent_2')).firstName,'已知名字');
    assert.ok(!requests.some(r=>r.method==='getChat'));
    assert.deepEqual(await ids(storage),['2','3']);
  });
  await test('管理员回复转发消息同样刷新最近沟通记录',async()=>{
    const storage=kv([['msg_7','2'],recent('2','原昵称',1),['auth_2','true']]);
    await context.handleAdminMessage({message_id:9,reply_to_message:{message_id:7}},'回复',{BOT_KV:storage},config);
    assert.ok(JSON.parse(storage.values.get('recent_2')).updatedAt>1);
    assert.equal(storage.values.get('replied_2'),'true');
    assert.deepEqual(await ids(storage),['2']);
  });
  await test('当前会话成功发送刷新时间',async()=>{
    const storage=kv([['active_admin_1',JSON.stringify({userId:'2',name:'原昵称',updatedAt:Date.now()})],recent('2','原昵称',1)]);
    await context.handleAdminMessage({message_id:9},'继续沟通',{BOT_KV:storage},config);
    assert.ok(JSON.parse(storage.values.get('recent_2')).updatedAt>1);
    assert.deepEqual(await ids(storage),['2']);
  });
  await test('当前会话发送失败保留之前的联系人时间',async()=>{
    mode='copyFail';
    const storage=kv([['active_admin_1',JSON.stringify({userId:'2',name:'原昵称',updatedAt:Date.now()})],recent('2','原昵称',1),['auth_2','true']]);
    await context.handleAdminMessage({message_id:9},'继续沟通',{BOT_KV:storage},config);
    assert.equal(JSON.parse(storage.values.get('recent_2')).updatedAt,1);
    assert.ok(!storage.values.has('replied_2'));
  });
  await test('旧版只有 replied 标记的成功推送联系人也能显示 ID',async()=>{
    const storage=kv([['replied_7','true']],{'replied_7':{expiration:Math.floor(Date.now()/1000)+180*86400}});
    const users=await context.getRecentFocusUsers(storage,12,'1');
    assert.equal(users[0].id,'7');
    assert.equal(users[0].name,'访客7');
    assert.equal(storage.values.size,1);
  });
  await test('封禁联系人仍不显示，未验证且未主动联系的访客仍不显示',async()=>{
    const storage=kv([recent('2','封禁',Date.now()),['replied_2','true'],['lock_2',String(Date.now()+60000)],recent('3','待验证',Date.now()),recent('4','已通过',Date.now()-1000),['auth_4','true']]);
    assert.deepEqual(await ids(storage),['4']);
  });
  await test('合并最近记录和回复记录去重，排除管理员本人',async()=>{
    const storage=kv([recent('2','联系人',Date.now()-1000),['replied_2','true'],recent('1','管理员',Date.now()),['replied_1','true']]);
    assert.deepEqual(await ids(storage),['2']);
  });
  await test('近30天历史联系人按沟通时间排序，筛选后取数量上限',async()=>{
    const now=Date.now();
    const storage=kv([['replied_2','true'],recent('3','已沟通',now-1000),['replied_3','true'],recent('4','已验证',now-2000),['auth_4','true'],recent('5','待验证',now)],{'replied_2':{metadata:{updatedAt:now-3000}}});
    assert.deepEqual(await ids(storage),['3','4','2']);
    assert.deepEqual(Array.from(await context.getRecentFocusUsers(storage,1,'1'),u=>u.id),['3']);
  });
  await test('30天以内显示、超过30天和无法确认时间的记录不显示',async()=>{
    const now=Date.now(),day=86400000;
    const storage=kv([recent('2','近期',now-29*day),['auth_2','true'],recent('3','很久前',now-31*day),['auth_3','true'],['replied_4','true'],['replied_5','true']],
      {'replied_5':{expiration:Math.floor((now-31*day)/1000)+180*86400}});
    assert.deepEqual(await ids(storage),['2']);
    assert.equal(storage.values.size,6);
  });
  await test('旧最近记录超过30天，但成功回复元数据在30天内时展示',async()=>{
    const now=Date.now();
    const storage=kv([recent('2','旧昵称',now-40*86400000),['replied_2','true']],{'replied_2':{metadata:{updatedAt:now-86400000}}});
    assert.deepEqual(await ids(storage),['2']);
  });
  await test('最多展示最近12人，不改动更早联系人和消息映射',async()=>{
    const now=Date.now(),entries=[];
    for(let i=2;i<18;i++) entries.push(recent(String(i),'访客'+i,now-i*1000),['auth_'+i,'true']);
    entries.push(['msg_77','17']);
    const storage=kv(entries),dialog=await context.buildSwitchDialog(storage,'1');
    const buttons=dialog.replyMarkup.inline_keyboard.flat().filter(b=>b.callback_data.startsWith('focus:'));
    assert.equal(buttons.length,12);
    assert.equal(buttons[0].callback_data,'focus:2');
    assert.equal(storage.values.get('msg_77'),'17');
    assert.equal(storage.values.size,33);
  });
  for(const failure of ['profileFail','profileNetwork']) {
    await test(failure+'：资料查询失败仍保存已经成功发送的联系人',async()=>{
      mode=failure;
      const storage=kv();
      await context.handleAdminMessage({message_id:1},'/send 2 你好',{BOT_KV:storage},config);
      assert.equal(storage.values.get('replied_2'),'true');
      assert.deepEqual(await ids(storage),['2']);
      assert.equal(requests.filter(r=>r.method==='sendMessage'&&r.payload.chat_id==='2').length,1);
    });
  }
  console.log(`${passed} offline checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1});
