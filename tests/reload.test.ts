import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } from '@earendil-works/pi-coding-agent';
import { Store, binding, type Config } from '../src/core.js';
import { Outbox, communicationPending } from '../src/conversation.js';

// This is an isolated public SDK reload, not a reload of the agent running this test.
test('public Pi reload shuts down the owner and restores received/sent records without duplicates or completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-msg-reload-'));
  const home = process.env.HOME; const stateHome = process.env.XDG_STATE_HOME;
  process.env.HOME = dir; process.env.XDG_STATE_HOME = join(dir, 'state');
  mkdirSync(join(dir, '.pi'), { mode: 0o700 });
  const executable = join(dir, 'msg');
  const calls = join(dir, 'sends'); const incoming = join(dir, 'incoming.json');
  const message = (id: string) => ({ id, from: '@peer#worker', to: '@tester#main', message: JSON.stringify({ kind: 'task', summary: id, requires_action: true }) });
  writeFileSync(incoming, JSON.stringify([message('first')]));
  writeFileSync(executable, `#!/usr/bin/env node
const fs=require('fs'),a=process.argv;
if(a.includes('send')) {fs.appendFileSync(${JSON.stringify(calls)},'call\\n');setTimeout(()=>console.log(JSON.stringify({status:'ok',data:{from:'@tester#main'}})),150);}
else if(a.includes('--tail')) console.log(JSON.stringify({status:'ok',data:{items:[],cursor:'tail',has_more:false}}));
else if(a.includes('inbox')) console.log(JSON.stringify({status:'ok',data:{items:JSON.parse(fs.readFileSync(${JSON.stringify(incoming)},'utf8')),cursor:'next',has_more:false}}));
else if(a.includes('--once')) fs.writeFileSync(a[a.indexOf('--cursor-file')+1],'{}',{mode:0o600});
else setInterval(()=>console.log('{}'),50);
`, { mode: 0o700 });
  const config: Config = { executable, configDir: join(dir, 'cli'), username: 'tester', remote: false, agent: 'main', subscription: 'reload', mergeMs: 100, maxPending: 200, candidateMode: 'manual' };
  writeFileSync(join(dir, '.pi/msg.json'), JSON.stringify({ ...config, enabled: true }), { mode: 0o600 });
  const extensionPath = process.env.PI_MSG_TEST_EXTENSION ?? resolve('extensions/index.ts');
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, additionalExtensionPaths: [extensionPath], noSkills: true, noPromptTemplates: true, noThemes: true });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(), tools: ['msg_*'] }));
    const errors: string[] = [];
    await session.bindExtensions({ mode: 'json', onError: error => errors.push(JSON.stringify(error)) });
    const directory = join(dir, 'state/pi-msg', binding(config));
    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 100; i++) { if (predicate()) return; await sleep(20); }
      assert.fail('bounded reload fixture did not reconcile');
    };
    await waitFor(() => existsSync(join(directory, 'journal.json')) && new Store(config, directory).journal.deliveries.length === 1);
    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = session!.getToolDefinition(name); assert.ok(tool);
      return tool.execute('harness', args, undefined, undefined, session!.extensionRunner.createToolContext('harness', undefined));
    };
    const outgoing = { message_id: 'outgoing', to: '@peer#worker', body: 'private outbound body' };
    const sending = call('msg_send', outgoing);
    await waitFor(() => existsSync(calls));
    // Shutdown must wait for the in-flight send before releasing the lock and reloading outbox.
    await session.reload(); await sending;
    const box = new Outbox(config, directory);
    assert.equal(box.conversation().length, 1); assert.equal(box.conversation()[0]?.transport, 'sent');
    assert.equal(box.conversation().filter(communicationPending).length, 0);
    await call('msg_send', outgoing);
    assert.equal(readFileSync(calls, 'utf8'), 'call\n', 'saved receipt survives real runtime replacement without another send');
    writeFileSync(incoming, JSON.stringify([message('first'), message('after-reload')]));
    await waitFor(() => new Store(config, directory).journal.deliveries.length === 2);
    await session.reload();
    await waitFor(() => new Store(config, directory).journal.deliveries.length === 2);
    const journal = new Store(config, directory).journal;
    assert.deepEqual(journal.deliveries.map(d => d.message.id), ['first', 'after-reload']);
    assert.ok(journal.deliveries.every(d => d.state === 'pending' && d.attempts === 0 && !d.token && !d.notification));
    const before = readFileSync(join(directory, 'journal.json'), 'utf8');
    await call('msg_inbox', { history: true });
    assert.equal(readFileSync(join(directory, 'journal.json'), 'utf8'), before, 'reading never claims or completes');
    assert.equal(session.messages.length, 0, 'no model requests or synthetic user turns');
    assert.deepEqual(errors, []);
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    assert.equal(existsSync(join(directory, 'owner.lock')), false);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (stateHome === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = stateHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
