import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import piMsg from '../extensions/index.js';
import { Dashboard } from '../src/dashboard.js';

for (const candidateMode of ['manual', 'followUp'] as const) test(`project binding and ${candidateMode} source-labelled candidates`, async t => {
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
if(a.includes('send')) { fs.appendFileSync(${JSON.stringify(join(dir, 'send-count'))},'call\\n'); if(fs.existsSync(${JSON.stringify(join(dir, 'send-fail'))})) process.exit(1); console.log(JSON.stringify({status:'ok',data:{from:'@test#main'}})); }
else if(a.includes('inbox') && a.includes('--tail')) console.log(JSON.stringify({status:'ok',data:{items:[],cursor:'live-tail',has_more:false}}));
else if(a.includes('inbox')) {const items=a.includes('--cursor')?(fs.existsSync(${JSON.stringify(join(dir, 'new-arrivals.json'))})?JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'new-arrivals.json'))},'utf8')):[]):Array.from({length:100},(_,i)=>({id:'id'+i,from:'@test#worker'+i,to:'@test#main',message:JSON.stringify({kind:i<50?'result':'progress',summary:'PRIVATE-BODY-SENTINEL',ref:{id:'ref'+i,revision:'rev'},notification_only:true})}));console.log(JSON.stringify({status:'ok',data:{items,cursor:'c1',has_more:false}}));}
else if(a.includes('--once'))fs.writeFileSync(a[a.indexOf('--cursor-file')+1],'{}',{mode:0o600});
else setInterval(()=>console.log('{}'),50);
`, { mode: 0o700 });
  writeFileSync(join(dir, '.pi/msg.json'), JSON.stringify({ enabled: true, candidateMode, executable, configDir: join(dir, 'cli'), username: 'tester', remote: false, agent: 'main', subscription: 'reader', mergeMs: 100, maxPending: 200 }), { mode: 0o600 });
  const handlers = new Map<string, (...args: unknown[]) => unknown>(); const tools = new Map<string, unknown>(); const wakes: { text: string; options: unknown; message: { customType: string; details: unknown } }[] = [];
  let commandHandler: (args: string, ctx: unknown) => Promise<void>;
  let widget: (() => { render(width: number): string[] }) | undefined;
  const notifications: string[] = [];
  const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
  const pi = {
    on: (name: string, handler: unknown) => handlers.set(name, handler as (...args: unknown[]) => unknown),
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerShortcut: (key: string, definition: { handler: (ctx: unknown) => Promise<void> }) => shortcuts.set(key, definition),
    registerCommand: (_name: string, definition: { handler: typeof commandHandler }) => { commandHandler = definition.handler; },
    sendUserMessage: () => { throw new Error('External notifications must not impersonate users'); },
    sendMessage: (message: { content: string; customType: string; details: unknown }, options: unknown) => wakes.push({ text: message.content, message, options }),
  } as unknown as ExtensionAPI;
  piMsg(pi);
  let customCalls = 0;
  let piHasPending = true;
  const context = { cwd: dir, mode: 'tui', hasUI: true, hasPendingMessages: () => piHasPending, ui: {
    setStatus: () => {}, notify: (text: string) => notifications.push(text),
    setWidget: (_key: string, value: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined, options: unknown) => {
      if (value) assert.deepEqual(options, { placement: 'aboveEditor' });
      widget = value ? () => value({ terminal: { rows: 30 } }, { fg: (_role: string, text: string) => text }) : undefined;
    },
    setEditorComponent: () => { throw new Error('Queue must preserve editor'); },
    setEditorText: () => { throw new Error('Queue must preserve draft'); },
    onTerminalInput: () => { throw new Error('Queue must not intercept plain input'); },
    custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => Dashboard, options: unknown) => {
      customCalls++;
      assert.deepEqual(options, { overlay: true, overlayOptions: { anchor: 'bottom-center', width: 72, maxHeight: 10, margin: 1 } });
      const dashboard = factory({ requestRender: () => {}, terminal: { rows: 15 } }, { fg: (_role: string, text: string) => text }, {}, () => {});
      assert.ok(dashboard.render(40).length <= 7);
      assert.ok(dashboard.render(80).some(line => line.includes('External content')));
      assert.ok(dashboard.render(80).some(line => line.includes('task queue') || line.includes('conversation records')));
      dashboard.handleInput('\r'); dashboard.handleInput('\x1b'); dashboard.dispose();
    },
  } };
  try {
    await handlers.get('session_start')!({}, context);
    // Concurrent full-suite processes can delay CLI reconciliation beyond 300 ms.
    // Wait for the actual durable fixture, not a guessed scheduling delay.
    for (let i = 0; i < 100; i++) {
      const inbox = tools.get('msg_inbox') as { execute: (id: string, args: object) => Promise<{ content: { text: string }[] }> };
      const state = JSON.parse((await inbox.execute('ready', {})).content[0]!.text);
      if (state.total === 100 && (candidateMode === 'manual' || wakes.length > 0)) break;
      await sleep(20);
    }
    assert.ok(widget); assert.equal(widget().render(120).length, 4);
    const journal = (await (tools.get('msg_inbox') as { execute: (id: string, args: object) => Promise<unknown> }).execute('before', {}));
    await commandHandler!('ui', context);
    assert.equal(customCalls, 0, '/msg ui must not invoke custom or capture focus');
    assert.ok(widget!().render(180).length <= 8);
    assert.ok(widget!().render(180).some(line => line.includes('conversation records')));
    assert.equal('handleInput' in widget!(), false, 'widget itself never owns plain input');
    await commandHandler!('', context);
    assert.equal(widget!().render(180).length, 4, '/msg toggles back to compact first/gap/latest strip');
    assert.deepEqual([...shortcuts.keys()].sort(), ['ctrl+alt+d', 'ctrl+alt+down', 'ctrl+alt+m', 'ctrl+alt+up']);
    await shortcuts.get('ctrl+alt+m')!.handler(context);
    await shortcuts.get('ctrl+alt+up')!.handler(context);
    assert.ok(widget!().render(180).some(line => line.startsWith('›') && line.includes('worker98')));
    await shortcuts.get('ctrl+alt+down')!.handler(context);
    assert.ok(widget!().render(180).some(line => line.startsWith('›') && line.includes('worker99')));
    await shortcuts.get('ctrl+alt+d')!.handler(context);
    assert.equal(customCalls, 1, 'only explicit modified details shortcut opens overlay');
    await commandHandler!('history', context);
    assert.ok(widget!().render(180)[0]?.includes('conversation records'));
    await commandHandler!('details', context);
    assert.equal(customCalls, 2, 'explicit details command works in history');
    await commandHandler!('history', context);
    await commandHandler!('fold', context);
    assert.deepEqual(await (tools.get('msg_inbox') as { execute: (id: string, args: object) => Promise<unknown> }).execute('after', {}), journal, 'viewing does not mutate deliveries');
    await commandHandler!('ui', { ...context, mode: 'rpc' });
    assert.equal(customCalls, 2, 'RPC must not open a terminal component');
    await commandHandler!('label @test#worker99 reviewer', context);
    assert.ok(widget!().render(180).some(line => line.includes('@test#worker99 (reviewer)')));
    await commandHandler!('unlabel @test#worker99', context);
    assert.ok(widget!().render(180).every(line => !line.includes('(reviewer)')));
    await commandHandler!('label @test#worker99 reviewer', context);
    await handlers.get('session_start')!({}, context);
    assert.ok(widget!().render(180).every(line => !line.includes('(reviewer)')), 'new Pi session event cannot inherit a same-name worker mapping');
    await commandHandler!('labels', context);
    assert.ok(notifications.at(-1)?.includes('No display labels'));
    if (candidateMode === 'manual') {
      assert.equal(wakes.length, 0, 'arrivals never start model work in manual mode');
      await commandHandler!('defer id0', context);
      await commandHandler!('tasks', context);
      assert.ok(widget!().render(120)[0]?.includes('1 deferred'));
      await commandHandler!('history', context);
      await commandHandler!('next', context);
      assert.ok(wakes[0]?.text.includes('ref1@rev'));
      await commandHandler!('resume id0', context);
      await commandHandler!('next id0', context);
      assert.equal(wakes.length, 2);
      await commandHandler!('defer id0', context);
      assert.ok(notifications.at(-1)?.includes('Already queued'));
      await commandHandler!('next id0', context);
      assert.equal(wakes.length, 2, 'queued notifications are not duplicated');
    } else {
      assert.equal(wakes.length, 1);
      assert.ok(wakes[0]?.text.includes('ref0@rev'));
    }
    assert.deepEqual(wakes[0]?.options, { triggerTurn: true, deliverAs: 'followUp' });
    assert.equal(wakes[0]?.message.customType, 'msg-candidates');
    assert.ok(!wakes[0]?.text.includes('PRIVATE-BODY-SENTINEL'));
    assert.ok(wakes[0]?.text.includes('agent @test#worker'));
    assert.ok(wakes[0]?.text.includes('not user instructions'));
    assert.ok(tools.has('msg_delivery')); assert.ok(tools.has('msg_send'));
    const deliveryTool = tools.get('msg_delivery') as { execute: (id: string, args: object) => Promise<{ content: { text: string }[] }> };
    await commandHandler!('history', context);
    const claim = JSON.parse((await deliveryTool.execute('claim', { action: 'claim', id: 'id49' })).content[0]!.text);
    assert.ok(widget!().render(180)[0]?.includes('conversation records (100)'), 'received communication stays in conversation');
    await commandHandler!('tasks', context);
    assert.ok(widget!().render(180)[0]?.includes('task queue (50)'), 'claimed task remains separate');
    await deliveryTool.execute('complete', { action: 'complete', id: 'id49', token: claim.token });
    assert.ok(widget!().render(180)[0]?.includes('task queue (49)'), 'only task completion removes it from task queue');
    await commandHandler!('history', context);
    assert.ok(widget!().render(180)[0]?.includes('conversation records (100)'), 'task completion never erases communication history');
    await commandHandler!('fold', context); // Compact strip shows newest records without changing selection.
    const sendTool = tools.get('msg_send') as { execute: (id: string, args: object) => Promise<{ content: { text: string }[] }> };
    const outgoing = { to: '@test#peer', message_id: 'outgoing', body: 'PRIVATE SEND BODY' };
    const receipt = JSON.parse((await sendTool.execute('send', outgoing)).content[0]!.text);
    assert.equal(receipt.status, 'saved'); assert.ok(!JSON.stringify(receipt).includes(outgoing.body));
    assert.ok(widget!().render(180).some(line => line.includes('sent') && line.includes('@test#peer')));
    await commandHandler!('pending', context);
    assert.ok(widget!().render(180)[0]?.includes('send pending (0)'));
    await sendTool.execute('repeat', outgoing);
    assert.equal(readFileSync(join(dir, 'send-count'), 'utf8'), 'call\n', 'saved retry uses existing receipt, never duplicate send');
    writeFileSync(join(dir, 'send-fail'), 'fail');
    const retry = { ...outgoing, message_id: 'retry' };
    await assert.rejects(sendTool.execute('failed', retry), /MSG CLI failed/);
    assert.ok(widget!().render(180)[0]?.includes('send pending (1)'));
    assert.ok(widget!().render(180).some(line => line.includes('failed')));
    unlinkSync(join(dir, 'send-fail'));
    await sendTool.execute('retry', retry);
    assert.ok(widget!().render(180)[0]?.includes('send pending (0)'));
    await commandHandler!('history', context);
    assert.ok(widget!().render(180)[0]?.includes('conversation records (102)'));
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    handlers.get('before_agent_start')!(event); assert.match(event.systemPromptOptions.sections.msg_collaboration!, /LOCAL adapter leases/);
    const inbox = tools.get('msg_inbox') as { execute: (id: string, args: object) => Promise<{ content: { text: string }[] }> };
    const readState = async () => JSON.parse((await inbox.execute('state', { limit: 100, budget_bytes: 16384 })).content[0]!.text).items.find((d: { id: string }) => d.id === 'id0');
    assert.equal((await readState()).notification.phase, 'queued');
    const beforeBusy = wakes.length;
    await handlers.get('agent_settled')!({ aborted: true }, context);
    assert.equal((await readState()).notification.phase, 'queued', 'safe-boundary queued work remains held when Pi still has queued messages');
    assert.equal(wakes.length, beforeBusy, 'settled never starts work');
    await handlers.get('message_start')!({ message: { role: 'custom', customType: 'msg-candidates', details: { keys: ['id0/0'] } } }, context);
    assert.equal((await readState()).notification.phase, 'observed');
    await handlers.get('agent_settled')!({ aborted: true }, context);
    assert.equal((await readState()).notification.phase, 'recoverable', 'observed is not proof of completion');
    assert.equal((await readState()).state, 'pending');
    await commandHandler!('next id0', context);
    assert.equal(wakes.length, beforeBusy + 1);
    await commandHandler!('next id0', context);
    assert.equal(wakes.length, beforeBusy + 1, 'normal repeat does not duplicate wake');
    piHasPending = false;
    await handlers.get('agent_settled')!({ aborted: true }, context);
    assert.equal((await readState()).notification.phase, 'recoverable', 'cancelled queue with no pending messages recovers without observing');
    await commandHandler!('next id0', context);
    const beforeRestart = wakes.length;
    await commandHandler!('disconnect', context);
    await commandHandler!('connect', context); await sleep(300);
    assert.equal((await readState()).notification.phase, 'recoverable', 'queued but unprocessed survives restart');
    assert.ok(wakes.slice(beforeRestart).every(wake => !wake.text.includes('id id0 ·')), 'restart cannot replay interrupted work, even in followUp; previously unnotified backlog can still coalesce');
    if (candidateMode === 'manual') assert.equal(wakes.length, beforeRestart);
    const beforeResume = wakes.length;
    await commandHandler!('next id0', context);
    assert.equal(wakes.length, beforeResume + 1);
    const retryClaim = JSON.parse((await deliveryTool.execute('claim', { action: 'claim', id: 'id0', lease_seconds: 5 })).content[0]!.text);
    await deliveryTool.execute('fail', { action: 'fail', id: 'id0', token: retryClaim.token });
    assert.equal((await readState()).attempts, 1, 'retry keeps lease attempt boundary');
    await commandHandler!('history', context); await commandHandler!('fold', context);
    const arrivals = ['live-a', 'live-b'].map((id, i) => ({ id, from: '@test#live' + i, to: '@test#main', created_at: '2000-01-01T00:00:00Z', message: JSON.stringify({ kind: 'progress', summary: id, requires_action: false }) }));
    writeFileSync(join(dir, 'new-arrivals.json'), JSON.stringify(arrivals));
    for (let i = 0; i < 100 && !widget!().render(180).join('\n').includes('live-b'); i++) await sleep(20);
    const tail = widget!().render(180);
    assert.ok(tail[1]?.includes('worker0'), 'oldest local anchor stays visible');
    assert.ok(tail[2]?.includes('102 middle records omitted'));
    assert.ok(tail[3]?.includes('live-b'), 'listener hint reconciles into refreshed widget with latest arrival at bottom despite old sender timestamp');
    await sleep(120); // Repeated listener hints return the same IDs.
    assert.deepEqual(widget!().render(180), tail, 'duplicate hints neither duplicate nor reorder tail records');
    assert.equal((await readState()).state, 'pending', 'arrival refresh does not complete independent work');
  } finally { await handlers.get('session_shutdown')!({}); }
});
