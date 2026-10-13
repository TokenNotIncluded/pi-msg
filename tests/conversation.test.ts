import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Outbox, communicationPending, communicationStatus } from '../src/conversation.js';
import { Store, type Config } from '../src/core.js';
import { queueItems } from '../src/dashboard.js';

const config: Config = { executable: 'msg', remote: false, username: 'alias', agent: 'main', subscription: 'test', mergeMs: 100, maxPending: 200 };
test('outbox persists retry material, recovers ambiguous sends, and keeps saved receipts without task candidates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-msg-conversation-'));
  try {
    const box = new Outbox(config, dir);
    box.prepare('saved', '@peer#worker', 'body');
    assert.throws(() => box.prepare('saved', '@peer#worker', 'body'), /already in progress/);
    assert.throws(() => box.prepare('saved', '@peer#other', 'body'), /conflict/);
    box.finish('saved', { id: 'saved', to: '@peer#worker', status: 'saved', from: '@real#main' });
    box.prepare('interrupted', '@peer#worker', 'retry body');
    const before = readFileSync(join(dir, 'outbox.json'), 'utf8');
    const restored = new Outbox(config, dir);
    const records = restored.conversation();
    assert.equal(records.find(d => d.message.id === 'saved')?.message.from, '@real#main');
    assert.equal(communicationStatus(records[0]!), 'sent');
    assert.equal(communicationPending(records[0]!), false);
    assert.equal(communicationStatus(records[1]!), 'failed');
    assert.equal(communicationPending(records[1]!), true);
    assert.equal(queueItems(records).length, 0, 'outbound never becomes actionable work');
    assert.equal(restored.prepare('saved', '@peer#worker', 'body').saved, true);
    restored.prepare('interrupted', '@peer#worker', 'retry body');
    restored.finish('interrupted', { id: 'interrupted', to: '@peer#worker', status: 'saved' });
    assert.equal(new Outbox(config, dir).conversation().filter(communicationPending).length, 0);
    assert.equal(statSync(join(dir, 'outbox.json')).mode & 0o777, 0o600);
    assert.ok(before.includes('retry body'));
    assert.throws(() => restored.prepare('oversize', '@peer#w', 'x'.repeat(65537)), /64 KiB/);
    assert.equal(restored.conversation().length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy outbox migration and received journal stay read-only, deduplicated, and task-independent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-msg-conversation-'));
  try {
    writeFileSync(join(dir, 'outbox.json'), JSON.stringify({ legacy: { to: '@peer#w', body: 'legacy', saved: true }, retry: { to: '@peer#w', body: 'unsaved' } }), { mode: 0o600 });
    const box = new Outbox(config, dir);
    assert.equal(box.conversation()[0]?.transport, 'sent');
    assert.equal(box.conversation()[1]?.transport, 'failed');
    const store = new Store(config, dir);
    const message = { id: 'received', from: '@peer#w', to: '@alias#main', message: JSON.stringify({ kind: 'task', summary: 'work', requires_action: true }) };
    store.ingest([message], 'c1');
    store.ingest([message], 'c2', 'live');
    const snapshot = readFileSync(store.path, 'utf8');
    const records = [...store.journal.deliveries, ...box.conversation()];
    assert.equal(records.length, 3);
    assert.equal(queueItems(records).length, 1);
    assert.equal(communicationStatus(records[0]!), 'received');
    assert.equal(communicationPending(records[0]!), false);
    assert.equal(new Store(config, dir).journal.deliveries[0]?.state, 'pending');
    assert.equal(readFileSync(store.path, 'utf8'), snapshot, 'projection cannot claim or complete');
    assert.equal(store.journal.cursor, 'c1'); assert.equal(store.journal.liveCursor, 'c2');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
