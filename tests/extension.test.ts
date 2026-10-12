import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import piMsg from '../extensions/index.js';
import { Dashboard } from '../src/dashboard.js';

test('project subscription overrides global fallback; 100 messages coalesce into one ref-only follow-up', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-msg-extension-')); const previousHome = process.env.HOME; const previousState = process.env.XDG_STATE_HOME;
  process.env.HOME = dir; process.env.XDG_STATE_HOME = join(dir, 'state');
  t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; if (previousState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousState; rmSync(dir, { recursive: true, force: true }); });
  mkdirSync(join(dir, '.pi'), { mode: 0o700 });
  mkdirSync(join(dir, '.config/pi-msg'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, '.config/pi-msg/config.json'), JSON.stringify({
    enabled: false, executable: '/must-not-execute-global-cli', remote: false,
    configDir: join(dir, 'global-cli'), username: 'tester', agent: 'global', subscription: 'shared-global',
  }), { mode: 0o600 });
  const executable = join(dir, 'msg');
  writeFileSync(executable, `#!/usr/bin/env node
const fs=require('fs');const a=process.argv;
if(a.includes('inbox')) {const items=a.includes('--cursor')?[]:Array.from({length:100},(_,i)=>({id:'id'+i,from:'@test#worker'+i,to:'@test#main',message:JSON.stringify({kind:i<50?'result':'progress',summary:'PRIVATE-BODY-SENTINEL',ref:{id:'ref'+i,revision:'rev'},notification_only:true})}));console.log(JSON.stringify({status:'ok',data:{items,cursor:'c1',has_more:false}}));}
else if(a.includes('--once'))fs.writeFileSync(a[a.indexOf('--cursor-file')+1],'{}',{mode:0o600});
else setInterval(()=>{},1000);
`, { mode: 0o700 });
  writeFileSync(join(dir, '.pi/msg.json'), JSON.stringify({ enabled: true, executable, configDir: join(dir, 'cli'), username: 'tester', remote: false, agent: 'main', subscription: 'reader', mergeMs: 100, maxPending: 200 }), { mode: 0o600 });
  const handlers = new Map<string, (...args: unknown[]) => unknown>(); const tools = new Map<string, unknown>(); const wakes: { text: string; options: unknown }[] = [];
  const pi = {
    on: (name: string, handler: unknown) => handlers.set(name, handler as (...args: unknown[]) => unknown),
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerCommand: () => {},
    sendUserMessage: (text: string, options: unknown) => wakes.push({ text, options }),
  } as unknown as ExtensionAPI;
  piMsg(pi);
  const context = { cwd: dir, hasUI: false, ui: { setStatus: () => {}, notify: () => {} } };
  try {
    await handlers.get('session_start')!({}, context); await sleep(300);
    assert.equal(wakes.length, 1); assert.deepEqual(wakes[0]?.options, { deliverAs: 'followUp' });
    assert.ok(!wakes[0]?.text.includes('PRIVATE-BODY-SENTINEL')); assert.ok(wakes[0]?.text.includes('ref0@rev'));
    assert.ok(tools.has('msg_delivery')); assert.ok(tools.has('msg_send'));
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    handlers.get('before_agent_start')!(event); assert.match(event.systemPromptOptions.sections.msg_collaboration!, /LOCAL adapter leases/);
  } finally { await handlers.get('session_shutdown')!({}); }
});
test('channel browser reads fixed bodies only on selection; escape and terminal safety', async () => {
  let reads = 0; let closed = false;
  const dashboard = new Dashboard([{ name: 'main' }], {
    channel: async channel => ({ channel, messages: [{ id: 'fixed-id', from: '@user#worker', to: '@user#main', message: 'summary' }], deliveries: [], hasMore: false, listener: 'live', pending: 0 }),
    older: async () => { throw new Error('unexpected'); }, refresh: async () => { throw new Error('unexpected'); },
    read: async () => { reads++; return '\x1b[2JPRIVATE-BODY'; },
  }, () => {}, () => { closed = true; });
  dashboard.handleInput('\r'); await sleep(0); assert.equal(reads, 0);
  dashboard.handleInput('\r'); await sleep(0); assert.equal(reads, 1);
  // pi-tui may add its own harmless SGR resets. The untrusted payload's
  // clear-screen command must never survive sanitization.
  assert.ok(dashboard.render(60).every(line => !line.includes('\x1b[2J')));
  assert.ok(dashboard.render(60).some(line => line.includes('PRIVATE-BODY')));
  dashboard.handleInput('\x1b'); dashboard.handleInput('\x1b'); dashboard.handleInput('\x1b'); assert.equal(closed, true);
});
