import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Dashboard, queueItems, queueLines, queueRow } from '../src/dashboard.js';
import type { Delivery } from '../src/core.js';

function delivery(id: string, state: Delivery['state'] = 'pending', created = '2026-10-13T01:00:00Z'): Delivery {
  return { message: { id, from: '@user#sender', to: '@user#receiver', created_at: created, message: `PRIVATE-BODY-${id}\nsecond line\n\x1b[2J第三行` },
    metadata: { kind: 'task', summary: `summary ${id} 中文 🐱`, requires_action: true }, state, attempts: 0, receivedAt: created };
}
test('queue is newest-first; claimed/deferred remain and completed only appears in explicit history', () => {
  const old = delivery('old'); const newest = delivery('new', 'claimed', '2026-10-13T03:00:00Z');
  old.deferred = true;
  const done = delivery('done', 'completed', '2026-10-13T02:00:00Z');
  const entries = [newest, old, done]; const original = JSON.stringify(entries);
  assert.deepEqual(queueItems(entries).map(d => d.message.id), ['new', 'old']);
  assert.deepEqual(queueItems(entries, true).map(d => d.message.id), ['new', 'done', 'old']);
  assert.equal(JSON.stringify(entries), original, 'sorting never mutates journal');
  const lines = queueLines(entries, 'live', 180);
  assert.ok(lines[0]?.includes('1 claimed')); assert.ok(lines[0]?.includes('1 deferred'));
  assert.ok(lines[1]?.includes('summary new')); assert.ok(!lines.join('\n').includes('PRIVATE-BODY'));
});
test('equal/missing timestamps use stable newest arrival order without inventing timestamps', () => {
  const a = delivery('a'); const b = delivery('b');
  delete a.message.created_at; delete b.message.created_at;
  a.receivedAt = 'unknown'; b.receivedAt = 'unknown';
  assert.deepEqual(queueItems([a, b]).map(d => d.message.id), ['b', 'a']);
});
test('bounded row places recipient at right and strips control content', () => {
  const d = delivery('x'); d.metadata.summary = '\x1b[2Junsafe summary';
  const row = queueRow(d, 80, true);
  assert.equal(visibleWidth(row), 80); assert.ok(row.endsWith('@user#receiver')); assert.ok(!row.includes('\x1b[2J'));
  for (const width of [0, 1, 12, 24, 40, 80]) assert.ok(visibleWidth(queueRow(d, width)) <= width);
});
test('160 entries remain navigable with selection/footer visible on small screens and resize', () => {
  const entries = Array.from({ length: 160 }, (_, i) => delivery(`id${i}`));
  let height = 20;
  const dashboard = new Dashboard(() => ({ channel: 'main', deliveries: entries, listener: 'live' }), () => {}, () => {}, () => height);
  for (const [width, rows] of [[80, 20], [40, 11], [12, 6], [40, 11], [80, 20]]) {
    height = rows!;
    for (let i = 0; i < 40; i++) {
      dashboard.handleInput('j');
      const lines = dashboard.render(width!);
      assert.ok(lines.length <= Math.min(18, height));
      assert.ok(lines.some(line => line.startsWith('›')), 'selected delivery remains visible');
      assert.ok(lines.at(-1)?.startsWith('↑↓/jk'), 'footer remains visible');
      assert.ok(lines.every(line => visibleWidth(line) <= width!));
    }
  }
});
test('expand/collapse preserves lines; viewing never changes delivery and completion removes it live', () => {
  const d = delivery('selected', 'claimed'); const done = delivery('done', 'completed');
  const entries = [done, d]; const before = JSON.stringify(entries); let closed = 0;
  const dashboard = new Dashboard(() => ({ channel: 'main', deliveries: entries, listener: 'live' }), () => {}, () => closed++);
  assert.ok(!dashboard.render(100).join('\n').includes('PRIVATE-BODY'));
  dashboard.handleInput('\r');
  const body = dashboard.render(100);
  assert.ok(body.some(line => line.includes('PRIVATE-BODY-selected')));
  assert.ok(body.some(line => line === 'second line'));
  assert.ok(body.every(line => !line.includes('\x1b[2J')));
  assert.equal(JSON.stringify(entries), before);
  dashboard.handleInput(' '); assert.ok(!dashboard.render(100).join('\n').includes('PRIVATE-BODY'));
  dashboard.handleInput('\r'); d.state = 'completed';
  assert.ok(dashboard.render(100).some(line => line.includes('No unfinished')));
  dashboard.handleInput('h'); assert.ok(dashboard.render(100).some(line => line.includes('saved history (2)')));
  dashboard.handleInput('\r'); assert.ok(dashboard.render(100).some(line => line.includes('PRIVATE-BODY')));
  dashboard.handleInput('\x1b'); dashboard.handleInput('h'); dashboard.handleInput('\x1b');
  assert.equal(closed, 1); dashboard.handleInput('\r'); assert.deepEqual(dashboard.render(100), []);
});
test('live arrival preserves selection by ID and disposed view cannot reopen', () => {
  const entries = [delivery('first')];
  const dashboard = new Dashboard(() => ({ channel: 'main', deliveries: entries, listener: 'live', error: 'offline' }), () => {}, () => {}, () => 10);
  dashboard.render(80);
  entries.push(delivery('new', 'pending', '2026-10-13T05:00:00Z'));
  assert.ok(dashboard.render(80).some(line => line.startsWith('›') && line.includes('summary first')));
  dashboard.handleInput('\r'); assert.ok(dashboard.render(80).some(line => line.includes('PRIVATE-BODY-first')));
  dashboard.dispose(); entries.push(delivery('late'));
  dashboard.handleInput('\r'); assert.deepEqual(dashboard.render(80), []);
});
test('empty and very short terminals are bounded', () => {
  for (const height of [1, 2, 3, 8]) {
    const dashboard = new Dashboard(() => ({ channel: 'main', deliveries: [], listener: 'stopped' }), () => {}, () => {}, () => height);
    assert.ok(dashboard.render(1).length <= height);
    assert.deepEqual(dashboard.render(0), []);
    dashboard.handleInput('\r'); dashboard.handleInput('j'); dashboard.handleInput('h');
    assert.ok(dashboard.render(40).length <= height);
  }
});
