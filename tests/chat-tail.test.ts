import test from 'node:test';
import assert from 'node:assert/strict';
import { InlineQueue, conversationItems } from '../src/dashboard.js';
import type { ConversationDelivery } from '../src/conversation.js';

function record(id: string, second: number, outbound = false): ConversationDelivery {
  const receivedAt = new Date(Date.UTC(2026, 9, 13, 1, 0, second)).toISOString();
  return { message: { id, from: outbound ? '@owner#main' : '@owner#worker', to: outbound ? '@owner#worker' : '@owner#main', message: 'private body ' + id, created_at: '2000-01-01T00:00:00Z' }, metadata: { kind: 'progress', summary: id, requires_action: false }, state: 'pending', attempts: 0, receivedAt, outbound, transport: outbound ? 'sent' : 'received' };
}
test('collapsed chat tail follows durable arrivals at bottom and older entries leave only the visible window', () => {
  const entries = [record('old', 0), record('middle', 1), record('latest', 2, true)];
  entries[0]!.message.created_at = '2099-01-01T00:00:00Z';
  const queue = new InlineQueue(); const view = { channel: 'main', deliveries: entries, listener: 'live' };
  const before = JSON.stringify(entries);
  let lines = queue.render(view, 180, 30);
  assert.ok(!lines.slice(1).join('\n').includes('old'));
  assert.ok(lines[1]?.includes('middle')); assert.ok(lines[2]?.includes('latest') && lines[2]?.includes('sent'));
  assert.equal(JSON.stringify(entries), before, 'render does not reorder/mutate original records');
  entries.push(record('new-arrival', 3));
  lines = queue.render(view, 180, 30);
  assert.ok(lines[1]?.includes('latest')); assert.ok(lines[2]?.includes('new-arrival'));
  assert.ok(!lines.slice(1).join('\n').includes('middle'));
  assert.equal(entries.length, 4, 'old records remain persisted, not completed or removed');
  assert.deepEqual(conversationItems(entries).map(d => d.message.id), ['old', 'middle', 'latest', 'new-arrival']);
  assert.deepEqual(queue.render(view, 180, 30), lines, 'duplicate redraw does not change order');
});
test('expanded old page remains anchored, counts new records once, and bottom/fold resume follow', () => {
  const entries = Array.from({ length: 12 }, (_, i) => record('entry-' + i, i));
  const view = { channel: 'main', deliveries: entries, listener: 'live' };
  const queue = new InlineQueue(); queue.render(view, 180, 24); queue.expanded = true;
  queue.move(entries, -6);
  assert.equal(queue.selected(entries)?.message.id, 'entry-5');
  const page = queue.render(view, 180, 24).slice(1, -1);
  entries.push(record('arrival-a', 12), record('arrival-b', 13, true));
  let lines = queue.render(view, 180, 24);
  assert.ok(lines[0]?.includes('2 new'));
  assert.deepEqual(lines.slice(1, -1), page, 'new arrivals do not displace expanded reading');
  assert.equal(queue.selected(entries)?.message.id, 'entry-5');
  assert.equal(queue.render(view, 180, 24)[0]?.includes('2 new'), true, 'repeated events do not increment count');
  queue.move(entries, 100);
  assert.equal(queue.selected(entries)?.message.id, 'arrival-b');
  assert.ok(!queue.render(view, 180, 24)[0]?.includes('2 new'));
  entries.push(record('arrival-c', 14));
  assert.equal(queue.selected(entries)?.message.id, 'arrival-c', 'bottom resumes automatic follow');
  queue.move(entries, -10); queue.expanded = false;
  lines = queue.render(view, 180, 24);
  assert.ok(lines[2]?.includes('arrival-c'), 'fold returns to latest tail');
  assert.ok(entries.every(d => d.state === 'pending' && d.attempts === 0), 'navigation is not task completion');
});
