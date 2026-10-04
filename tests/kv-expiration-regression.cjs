const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
let clock = 1791100000123;
class Clock extends Date { static now() { return clock; } }
const runtime = vm.createContext({ Date: Clock, console });
const source = fs.readFileSync(process.env.KV_TEST_SOURCE || path.resolve(__dirname, '../chuanhuatong.js'), 'utf8');
vm.runInContext(source.replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject {}')
  .replace('export class BotCoordinator', 'class BotCoordinator').replace('export default {', 'const worker = {'), runtime);
class Storage {
  constructor() { this.data = new Map(); }
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { if (typeof key === 'string') this.data.set(key, structuredClone(value)); else for (const [name, record] of Object.entries(key)) await this.put(name, record); }
  async delete(key) { this.data.delete(key); }
  async list({ prefix = '', startAfter, limit = 1000 } = {}) { return new Map([...this.data].sort(([a], [b]) => a.localeCompare(b)).filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).slice(0, limit).map(([key, record]) => [key, structuredClone(record)])); }
  async transaction(run) { return run(this); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
}
function fixture() {
  const storage = new Storage(), writes = [], deleted = [];
  const kv = {
    fail: false, beforePut: null,
    async put(key, value, options) {
      for (const field of ['expiration', 'expirationTtl']) if (options[field] !== undefined && (!Number.isInteger(options[field]) || options[field] > 2147483647 || options[field] < -2147483648)) throw new TypeError('Value out of range. Must be between -2147483648 and 2147483647 (inclusive).');
      if (this.beforePut) await this.beforePut();
      if (this.fail) throw Error('KV unavailable');
      writes.push({ key, value, options: structuredClone(options) });
    },
    async delete(key) { if (this.fail) throw Error('KV unavailable'); deleted.push(key); },
    async list() { return { keys: [], list_complete: true }; },
  };
  runtime.storageArg = storage; runtime.kvArg = kv;
  const store = vm.runInContext('new CoordinatedStore(storageArg, kvArg)', runtime);
  return { storage, kv, store, writes, deleted };
}
async function seed(t, key, expiration, revision = 1) {
  const record = { value: 'saved', deleted: false, expiration, metadata: { updatedAt: clock }, revision };
  await t.storage.put({ [`v:${key}`]: record, [`o:${key}`]: record });
}
let count = 0;
async function test(name, run) { await run(); count++; console.log('PASS ' + name); }
(async () => {
  await test('四条存量毫秒到期记录自动修正并完成镜像，不修改资料时间', async () => {
    const t = fixture(), expiration = clock + 86400000;
    for (let i = 0; i < 4; i++) await seed(t, `recent_${i}`, expiration);
    assert.equal((await t.store.flushMirrors()).failedCount, 0);
    assert.equal(t.writes.length, 4);
    for (let i = 0; i < 4; i++) {
      const record = await t.storage.get(`v:recent_${i}`);
      assert.equal(record.expiration, Math.floor(expiration / 1000));
      assert.equal(record.metadata.updatedAt, clock);
      assert.equal(record.value, 'saved');
      assert.equal(await t.storage.get(`o:recent_${i}`), undefined);
      assert.equal(t.writes[i].options.expiration, undefined);
      assert.ok(t.writes[i].options.expirationTtl >= 60 && t.writes[i].options.expirationTtl <= 86400);
    }
  });
  await test('2038年后的合法秒时间戳以相对TTL写入，超长TTL限制在int32范围', async () => {
    const t = fixture();
    await seed(t, 'future', 2200000000); await seed(t, 'long', 9000000000);
    assert.equal((await t.store.flushMirrors()).failedCount, 0);
    assert.equal((await t.storage.get('v:future')).expiration, 2200000000);
    assert.ok(t.writes[0].options.expirationTtl > 60);
    assert.equal(t.writes[1].options.expirationTtl, 2147483647);
  });
  await test('过期毫秒记录不会复活，余期不足60秒仅删除镜像', async () => {
    const t = fixture(); await seed(t, 'expired', clock - 1); await seed(t, 'soon', Math.floor(clock / 1000) + 60);
    assert.equal(await t.store.get('expired'), null);
    assert.equal((await t.store.flushMirrors()).failedCount, 0);
    assert.deepEqual(t.deleted, ['expired', 'soon']); assert.equal(t.writes.length, 0);
  });
  await test('新写入规范化到期时间，字符串TTL不会拼接；非法参数不建立任务', async () => {
    const t = fixture(); await t.store.put('ms', 'a', { expiration: clock + 86400000 });
    await t.store.put('ttl', 'b', { expirationTtl: '3600' });
    assert.equal((await t.storage.get('v:ttl')).expiration, Math.floor(clock / 1000) + 3600);
    assert.equal((await t.storage.get('v:ms')).expiration, Math.floor((clock + 86400000) / 1000));
    for (const expiration of [NaN, Infinity, -1, 1.5, {}, 'oops']) await assert.rejects(t.store.put('bad', 'x', { expiration }));
    for (const expirationTtl of [0, -1, 1.5, 2147483648, 'oops']) await assert.rejects(t.store.put('bad', 'x', { expirationTtl }));
    assert.equal(await t.storage.get('o:bad'), undefined);
  });
  await test('失败镜像保留修正后的任务，KV恢复后正常重试', async () => {
    const t = fixture(); await seed(t, 'retry', clock + 86400000); t.kv.fail = true;
    assert.equal((await t.store.flushMirrors()).failedCount, 1);
    assert.equal((await t.storage.get('o:retry')).expiration, Math.floor((clock + 86400000) / 1000));
    t.kv.fail = false; clock += 2000; assert.equal((await t.store.flushMirrors()).failedCount, 0);
    assert.equal(await t.storage.get('o:retry'), undefined);
  });
  await test('镜像期间的新版本不被旧任务修正或清除', async () => {
    const t = fixture(); await seed(t, 'race', clock + 86400000);
    t.kv.beforePut = async () => { t.kv.beforePut = null; await t.store.put('race', 'new', { expirationTtl: 3600 }); };
    await t.store.flushMirrors();
    assert.equal((await t.storage.get('o:race')).value, 'new');
    assert.equal((await t.storage.get('v:race')).expiration, Math.floor(clock / 1000) + 3600);
    clock += 1500; await t.store.flushMirrors(); assert.equal(t.writes.at(-1).value, 'new');
  });
  await test('坏任务保持待处理但不阻塞同批有效任务；无期限记录不增加TTL', async () => {
    const t = fixture(); await seed(t, 'bad', 'not-a-date'); await seed(t, 'valid', null);
    assert.equal((await t.store.flushMirrors()).failedCount, 1);
    assert.ok(await t.storage.get('o:bad')); assert.equal(await t.storage.get('o:valid'), undefined);
    assert.equal(t.writes[0].options.expirationTtl, undefined);
  });
  await test('列表导出使用秒到期时间，已过期毫秒记录从列表排除', async () => {
    const t = fixture(); await seed(t, 'active', clock + 86400000); await seed(t, 'expired', clock - 1000);
    const page = await t.store.list(); assert.equal(page.keys.length, 1);
    assert.equal(page.keys[0].expiration, Math.floor((clock + 86400000) / 1000));
  });
  await test('持续失败按任务延迟重试，实例重建保留延迟，新写入重置延迟', async () => {
    const t = fixture(); await seed(t, 'backoff', null); t.kv.fail = true;
    for (let i = 1; i <= 11; i++) {
      assert.equal((await t.store.flushMirrors()).failedCount, 1);
      const pending = await t.storage.get('o:backoff');
      assert.equal(pending.mirrorRetryAt - clock, Math.min(900000, 2000 * 2 ** (i - 1)));
      assert.equal((await t.store.flushMirrors()).failedCount, 0);
      runtime.storageArg = t.storage; runtime.kvArg = t.kv;
      const restarted = vm.runInContext('new CoordinatedStore(storageArg, kvArg)', runtime);
      assert.equal((await restarted.flushMirrors()).failedCount, 0);
      clock = pending.mirrorRetryAt;
    }
    await t.store.put('backoff', 'new');
    assert.equal((await t.storage.get('o:backoff')).mirrorRetryAt, undefined);
    t.kv.fail = false; await t.store.flushMirrors(); assert.equal(t.writes.at(-1).value, 'new');
  });
  await test('旧版本失败不会给并发新版本增加重试延迟', async () => {
    const t = fixture(); await seed(t, 'race_failure', null); t.kv.fail = true;
    t.kv.beforePut = async () => { t.kv.beforePut = null; await t.store.put('race_failure', 'new'); };
    await t.store.flushMirrors();
    const pending = await t.storage.get('o:race_failure');
    assert.equal(pending.value, 'new'); assert.equal(pending.mirrorRetryAt, undefined);
  });
  console.log(`${count} KV expiration cases passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
