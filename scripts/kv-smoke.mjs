import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Run the production store against actual SQLite storage and native KV bindings.
// The probe exists only in this in-memory test module, never in the deployment.
const source = await readFile(new URL('../chuanhuatong.js', import.meta.url), 'utf8');
const probe = `
export class KvMirrorProbe extends DurableObject {
  async fetch() {
    let nativeError = "";
    try { await this.env.BOT_KV.put("invalid", "x", { expiration: Date.now() + 86400000 }); }
    catch (error) { nativeError = error.message; }
    const store = new CoordinatedStore(this.ctx.storage, this.env.BOT_KV);
    const now = Date.now(), entries = {};
    for (let i = 0; i < 4; i++) {
      const record = { value: "saved", deleted: false, expiration: now + 86400000,
        metadata: { updatedAt: now }, revision: 1 };
      entries["v:old_" + i] = record; entries["o:old_" + i] = record;
    }
    const future = { value: "future", deleted: false, expiration: 2200000000, metadata: null, revision: 1 };
    entries["v:future"] = future; entries["o:future"] = future;
    await this.ctx.storage.put(entries);
    const result = await store.flushMirrors();
    const outbox = await this.ctx.storage.list({ prefix: "o:" });
    const local = await this.ctx.storage.get("v:old_0");
    const legacy = await this.env.BOT_KV.get("old_0", "text");
    const legacyFuture = await this.env.BOT_KV.get("future", "text");
    const listing = await this.env.BOT_KV.list({ prefix: "old_0" });
    return Response.json({ nativeError, result, pending: outbox.size, local, legacy, legacyFuture, listing, now });
  }
}
export default { fetch(request, env) { return env.PROBE.get(env.PROBE.idFromName("test")).fetch(request); } };
`;
const runtime = new Miniflare(convertV4MiniflareOptions({
  name: 'kv-expiration-smoke', modules: true,
  script: source.replace('export default {', 'const productionWorker = {') + probe,
  compatibilityDate: '2026-10-04', kvNamespaces: ['BOT_KV'],
  durableObjects: { PROBE: { className: 'KvMirrorProbe', useSQLite: true } },
  outboundService: () => { throw Error('Unexpected external HTTP in KV smoke test'); },
}));
try {
  const response = await runtime.dispatchFetch('https://worker.example/');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.nativeError, /Value out of range.*2147483647/);
  console.log('PASS native KV reproduces millisecond expiration int32 error');
  assert.equal(result.result.failedCount, 0); assert.equal(result.pending, 0);
  assert.equal(result.local.expiration, Math.floor((result.now + 86400000) / 1000));
  assert.equal(result.local.metadata.updatedAt, result.now); assert.equal(result.legacy, 'saved');
  assert.ok(Math.abs(result.listing.keys[0].expiration - result.local.expiration) <= 1);
  console.log('PASS native KV and SQLite repair four persisted outbox records with TTL');
  assert.equal(result.legacyFuture, 'future');
  console.log('PASS native KV mirrors a valid post-2038 expiration');
  console.log('3 KV workerd smoke cases passed (no external HTTP)');
} finally { await runtime.dispose(); }
