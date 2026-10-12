import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store, type Config } from '../src/core.js';
import { Subscription, command, send } from '../src/transport.js';

function fake(t: { after: (fn: () => void) => void }, code: string): Store {
  const dir = mkdtempSync(join(tmpdir(), 'pi-msg-cli-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = join(dir, 'msg'); writeFileSync(executable, '#!/usr/bin/env node\n' + code, { mode: 0o700 });
  const config: Config = { executable, agent: 'main', subscription: 'test', remote: false, mergeMs: 50, maxPending: 100 };
  return new Store(config, join(dir, 'state'));
}
test('CLI errors are compact and do not leak stderr credentials', async t => {
  const s = fake(t, 'console.error("SECRET-CREDENTIAL");process.exit(1);');
  await assert.rejects(command(s.config, ['agent', 'list']), error => !String(error).includes('SECRET-CREDENTIAL'));
});
test('JSON error envelope is not treated as success', async t => {
  const s = fake(t, 'console.log(JSON.stringify({status:"error",error:"SECRET"}));');
  await assert.rejects(command(s.config, []), /successful JSON envelope/);
});
test('bounded CLI output rejects oversized bodies', async t => {
  const s = fake(t, 'process.stdout.write("x".repeat(3*1024*1024));'); await assert.rejects(command(s.config, []), /2 MiB/);
});
test('send hides local repeated body and retains exact retry ID', async t => {
  const s = fake(t, `const fs=require('fs');const a=process.argv;const id=a[a.indexOf('--message-id')+1];const body=fs.readFileSync(a[a.indexOf('--file')+1],'utf8');console.log(JSON.stringify({status:'ok',data:{id,message:body}}));`);
  const receipt = await send(s.config, s.directory, '@test#worker', 'BODY-NOT-REPEATED', 'same-id');
  assert.deepEqual(receipt, { id: 'same-id', to: '@test#worker', status: 'saved' }); assert.ok(!JSON.stringify(receipt).includes('BODY-NOT-REPEATED'));
});
test('background subscription reconciles a lost hint on reconnect; stop cancels', async t => {
  const s = fake(t, `const fs=require('fs');const path=require('path');const args=process.argv;const root=path.dirname(args[1]);const marker=path.join(root,'disconnected');
if(args.includes('inbox') && args.includes('--tail')) console.log(JSON.stringify({status:'ok',data:{items:[],cursor:'live-tail',has_more:false}}));
else if(args.includes('inbox')){let items=fs.existsSync(marker)?[{id:'recovered',from:'@test#worker',to:'@test#main',message:'done'}]:[]; console.log(JSON.stringify({status:'ok',data:{items,cursor:items.length?'c2':'c1',has_more:false}}));}
else if(args.includes('--once')){fs.writeFileSync(args[args.indexOf('--cursor-file')+1],'{}',{mode:0o600});}
else {if(!fs.existsSync(marker)){fs.writeFileSync(marker,'1');process.exit(1);}else setInterval(()=>{},1000);}`);
  let notified = 0; const sub = new Subscription(s, () => notified++); t.after(async () => sub.stop());
  await sub.start();
  for (let i = 0; i < 100 && !s.pending().length; i++) await sleep(30);
  assert.equal(s.pending()[0]?.message.id, 'recovered'); assert.ok(notified > 0);
  await sub.stop(); assert.equal(sub.state, 'stopped');
});
test('live delivery does not wait for unrelated historical backfill', async t => {
  const s = fake(t, `const fs=require('fs');const path=require('path');const a=process.argv;const marker=path.join(path.dirname(a[1]),'arrival');
if(a.includes('inbox')) {
 const cursor=a.includes('--cursor')?a[a.indexOf('--cursor')+1]:'';
 let items=[],next='live0',more=false;
 if(!a.includes('--tail') && cursor.startsWith('live')) {if(fs.existsSync(marker) && cursor==='live0') items=[{id:'urgent',from:'@test#worker',to:'@test#main',message:'blocker'}];next=items.length?'live1':cursor;}
 else if(!a.includes('--tail')) {next='history'+(Number(cursor.replace('history',''))+1);more=true;}
 console.log(JSON.stringify({status:'ok',data:{items,cursor:next,has_more:more}}));
} else if(a.includes('--once')) fs.writeFileSync(a[a.indexOf('--cursor-file')+1],'{}',{mode:0o600});
else {setTimeout(()=>{fs.writeFileSync(marker,'1');process.stdout.write('hint\\n');},20);setInterval(()=>{},1000);}`);
  const sub = new Subscription(s, () => {});
  try {
    await sub.start();
    for (let i=0;i<100 && !s.pending().length;i++) await sleep(20);
    assert.equal(s.pending()[0]?.message.id, 'urgent');
    assert.equal(s.journal.historyComplete, undefined);
    assert.match(s.journal.cursor!, /^history/);
    assert.equal(s.journal.liveCursor, 'live1');
    assert.equal(sub.state, 'live');
  } finally { await sub.stop(); }
});
test('listener byte bursts are hints, never arbitrary prompt bodies', async t => {
  const s = fake(t, `const fs=require('fs'); const a=process.argv;
if(a.includes('inbox')) console.log(JSON.stringify({status:'ok',data:{items:[],cursor:'c1',has_more:false}}));
else if(a.includes('--once')) fs.writeFileSync(a[a.indexOf('--cursor-file')+1],'{}',{mode:0o600});
else {setTimeout(()=>process.stdout.write('UNTRUSTED-FAKE-MESSAGE'),10);setInterval(()=>{},1000);}`);
  let notified = 0; const sub = new Subscription(s, () => notified++);
  try { await sub.start(); await sleep(150); assert.equal(notified, 0); assert.equal(s.pending().length, 0); } finally { await sub.stop(); }
});
test('local real CLI: event arrival, compact receipt, independent journal, crash recovery', { skip: !process.env.MSG_PI_TEST_CLI }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-msg-real-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cfg: Config = { executable: process.env.MSG_PI_TEST_CLI!, configDir: join(directory, 'mailboxes'), username: 'tester', agent: 'main', subscription: 'main-reader', remote: false, mergeMs: 50, maxPending: 100 };
  await command(cfg, ['agent', 'create', 'main']); await command(cfg, ['agent', 'create', 'worker']);
  const s = new Store(cfg, join(directory, 'subscription')); let delivered = 0;
  const sub = new Subscription(s, () => delivered++);
  try {
    await sub.start(); const receipt = await send({ ...cfg, agent: 'worker' }, s.directory, '@tester#main', '{"kind":"result","summary":"patch delivered","source_revision":"abc"}', 'offline-retry-safe');
    assert.equal(receipt.status, 'saved');
    await send({ ...cfg, agent: 'worker' }, s.directory, '@tester#main', '{"kind":"result","summary":"patch delivered","source_revision":"abc"}', 'offline-retry-safe');
    for (let i = 0; i < 120 && !s.pending().length; i++) await sleep(100);
    assert.equal(s.pending().length, 1); assert.ok(delivered > 0); const d = s.claim('offline-retry-safe');
    await sub.stop(); const resumed = new Store(cfg, s.directory); const restarted = new Subscription(resumed, () => delivered++);
    try { await restarted.start(); assert.equal(resumed.pending()[0]?.state, 'pending'); assert.equal(resumed.pending()[0]?.message.message.includes('patch delivered'), true); } finally { await restarted.stop(); }
    assert.equal(d.attempts, 1);
  } finally { await sub.stop(); }
});
