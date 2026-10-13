import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
if(a.includes('inbox') && a.includes('--tail')) console.log(JSON.stringify({status:'ok',data:{items:[],cursor:'live-tail',has_more:false}}));
else if(a.includes('inbox')) {const items=a.includes('--cursor')?[]:Array.from({length:100},(_,i)=>({id:'id'+i,from:'@test#worker'+i,to:'@test#main',message:JSON.stringify({kind:i<50?'result':'progress',summary:'PRIVATE-BODY-SENTINEL',ref:{id:'ref'+i,revision:'rev'},notification_only:true})}));console.log(JSON.stringify({status:'ok',data:{items,cursor:'c1',has_more:false}}));}
else if(a.includes('--once'))fs.writeFileSync(a[a.indexOf('--cursor-file')+1],'{}',{mode:0o600});
else setInterval(()=>{},1000);
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
  const context = { cwd: dir, mode: 'tui', hasUI: true, ui: {
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
      assert.ok(dashboard.render(80).some(line => line.includes('unfinished queue') || line.includes('saved history')));
      dashboard.handleInput('\r'); dashboard.handleInput('\x1b'); dashboard.dispose();
    },
  } };
  try {
    await handlers.get('session_start')!({}, context); await sleep(300);
    assert.ok(widget); assert.equal(widget().render(120).length, 3);
    const journal = (await (tools.get('msg_inbox') as { execute: (id: string, args: object) => Promise<unknown> }).execute('before', {}));
    await commandHandler!('ui', context);
    assert.equal(customCalls, 0, '/msg ui must not invoke custom or capture focus');
    assert.ok(widget!().render(180).length <= 8);
    assert.ok(widget!().render(180).some(line => line.includes('unfinished queue')));
    assert.equal('handleInput' in widget!(), false, 'widget itself never owns plain input');
    await commandHandler!('', context);
    assert.equal(widget!().render(180).length, 3, '/msg toggles back to compact strip');
    assert.deepEqual([...shortcuts.keys()].sort(), ['ctrl+alt+d', 'ctrl+alt+down', 'ctrl+alt+m', 'ctrl+alt+up']);
    await shortcuts.get('ctrl+alt+m')!.handler(context);
    await shortcuts.get('ctrl+alt+down')!.handler(context);
    assert.ok(widget!().render(180).some(line => line.startsWith('›') && line.includes('worker98')));
    await shortcuts.get('ctrl+alt+up')!.handler(context);
    assert.ok(widget!().render(180).some(line => line.startsWith('›') && line.includes('worker99')));
    await shortcuts.get('ctrl+alt+d')!.handler(context);
    assert.equal(customCalls, 1, 'only explicit modified details shortcut opens overlay');
    await commandHandler!('history', context);
    assert.ok(widget!().render(180)[0]?.includes('saved history'));
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
      assert.ok(widget!().render(120)[0]?.includes('1 deferred'));
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
    const claim = JSON.parse((await deliveryTool.execute('claim', { action: 'claim', id: 'id99' })).content[0]!.text);
    assert.ok(widget!().render(180)[0]?.includes('100 unfinished'), 'claimed remains in current queue');
    await deliveryTool.execute('complete', { action: 'complete', id: 'id99', token: claim.token });
    assert.ok(widget!().render(180)[0]?.includes('99 unfinished'), 'actual completion removes delivery from current queue');
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    handlers.get('before_agent_start')!(event); assert.match(event.systemPromptOptions.sections.msg_collaboration!, /LOCAL adapter leases/);
  } finally { await handlers.get('session_shutdown')!({}); }
});
