import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { InlineQueue, conversationItems } from '../src/dashboard.js';
import type { ConversationDelivery } from '../src/conversation.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Config } from '../src/core.js';

function record(index: number): ConversationDelivery {
  return { message: { id: 'id' + index, from: '@owner#worker', to: '@owner#main', message: 'PRIVATE BODY', created_at: new Date(2000 + index, 0, 1).toISOString() }, metadata: { kind: 'progress', summary: 'anchor-' + index, requires_action: false }, state: 'pending', attempts: 0, receivedAt: '2026-10-13T01:00:00Z' };
}
test('zero/one/two local records show no artificial gap or repeated endpoint', () => {
  for (const count of [0, 1, 2]) {
    const entries = Array.from({ length: count }, (_, i) => record(i));
    const queue = new InlineQueue();
    const lines = queue.render({ channel: 'main', deliveries: entries, listener: 'live' }, 180, 30);
    assert.equal(lines.length, count + 1);
    assert.ok(!lines.join('\n').includes('omitted'));
    for (let i = 0; i < count; i++) assert.equal(lines.filter(line => line.includes('anchor-' + i)).length, 1);
  }
});
test('same local timestamp preserves stable arrival order while sender timestamps differ', () => {
  const entries = [record(0), record(1), record(2), record(3)];
  entries[0]!.message.created_at = '2099-01-01T00:00:00Z';
  entries[3]!.message.created_at = '1999-01-01T00:00:00Z';
  const snapshot = JSON.stringify(entries);
  assert.deepEqual(conversationItems(entries).map(d => d.message.id), ['id0', 'id1', 'id2', 'id3']);
  const queue = new InlineQueue(); const view = { channel: 'main', deliveries: entries, listener: 'live' };
  const lines = queue.render(view, 180, 30);
  assert.ok(lines[1]?.includes('anchor-0')); assert.ok(lines[2]?.includes('2 middle records omitted')); assert.ok(lines[3]?.includes('anchor-3'));
  assert.deepEqual(queue.render(view, 180, 30), lines);
  assert.equal(JSON.stringify(entries), snapshot);
});
test('duplicate ingest and task completion cannot move equal-time chat anchors after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-msg-anchor-order-'));
  const config: Config = { executable: 'msg', agent: 'main', subscription: 'anchors', remote: false, username: 'owner', mergeMs: 100, maxPending: 200 };
  try {
    const store = new Store(config, dir);
    const messages = [record(0), record(1), record(2)].map(d => d.message);
    store.ingest(messages, 'first');
    for (const d of store.journal.deliveries) d.receivedAt = '2026-10-13T01:00:00Z';
    store.save();
    const claimed = store.claim('id1'); store.finish('id1', claimed.token!, true);
    store.ingest(messages, 'duplicate');
    assert.equal(store.journal.deliveries[0]?.message.id, 'id1', 'existing storage still groups completed tasks first');
    const restored = new Store(config, dir);
    assert.deepEqual(conversationItems(restored.journal.deliveries).map(d => d.message.id), ['id0', 'id1', 'id2']);
    const lines = new InlineQueue().render({ channel: 'main', deliveries: restored.journal.deliveries, listener: 'live' }, 180, 30);
    assert.ok(lines[1]?.includes('@owner#worker')); assert.ok(lines[2]?.includes('1 middle records omitted'));
    assert.equal(restored.journal.deliveries.filter(d => d.state === 'pending').length, 2);
    assert.equal(restored.journal.deliveries.length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('first/latest layout remains bounded and explicitly degrades when full addresses cannot fit', () => {
  const entries = [record(0), record(1), record(2)];
  for (const d of entries) { d.message.from = '@owner#iteration-resilience-long-common-prefix-source'; d.message.to = '@owner#iteration-resilience-long-common-prefix-recipient'; }
  const view = { channel: 'main', deliveries: entries, listener: 'live' };
  for (const width of [0, 1, 12, 40, 180]) for (const rows of [1, 6, 9, 12, 24, 30]) {
    const lines = new InlineQueue().render(view, width, rows);
    assert.ok(lines.length <= Math.max(1, Math.min(8, Math.floor(rows / 3))));
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(!lines.join('\n').includes('PRIVATE BODY'));
  }
  const narrow = new InlineQueue().render(view, 40, 24);
  assert.ok(narrow.join('\n').includes('First/latest need expanded history'));
  const complete = new InlineQueue().render(view, 180, 30);
  assert.equal(complete.filter(line => line.includes('iteration-resilience-long-common-prefix-source')).length, 2);
  assert.ok(complete[2]?.includes('1 middle records omitted'));
});
