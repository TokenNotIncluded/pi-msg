import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import { InlineQueue, Dashboard, nextHint, queueBlock } from '../src/dashboard.js';
import { Store, type Config, type Delivery } from '../src/core.js';

const config: Config = { executable: 'msg', agent: 'main', subscription: 'reader', remote: false, username: 'test', configDir: '/unused', mergeMs: 100, maxPending: 100 };
function delivery(id = 'one'): Delivery {
  return { message: { id, from: '@lightjunction#iteration-resilience-pi-1013', to: '@lightjunction#iteration-resilience-cli-1013', message: 'BODY' }, metadata: { kind: 'task', summary: 'summary can be removed before identity', requires_action: true }, state: 'pending', receivedAt: 'now', attempts: 0 };
}
test('common-prefix mailboxes remain complete before summaries; same owner is explicit', () => {
  const d = delivery(); const queue = new InlineQueue();
  const view = { channel: 'main', deliveries: [d, delivery('two')], listener: 'live', remote: true };
  for (const width of [40, 48, 60, 80]) {
    const text = queue.render(view, width, 30).map(stripVTControlCharacters).join('\n');
    assert.ok(text.includes('owner @lightjunction'));
    assert.ok(text.includes('#iteration-resilience-pi-1013'));
    assert.ok(text.includes('#iteration-resilience-cli-1013'));
    assert.ok(text.includes('+1 other entries'));
    assert.ok(!text.includes('summary can'));
  }
  const text = queue.render(view, 180, 30).join('\n');
  assert.ok(text.includes(d.message.from)); assert.ok(text.includes(d.message.to));
});
test('cross-owner same mailbox preserves both full owners and mailbox in wrapped bounded blocks', () => {
  const d = delivery(); d.message.from = '@alice#iteration-shared-mailbox'; d.message.to = '@bob#iteration-shared-mailbox';
  for (const width of [40, 60]) {
    const lines = queueBlock(d, width, true, { remote: false, theme: { fg: (_color, text) => `\x1b[32m${text}\x1b[0m` } });
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    const text = lines.map(stripVTControlCharacters).join('\n');
    assert.ok(text.includes(d.message.from)); assert.ok(text.includes(d.message.to));
  }
});
test('extremely narrow/short screens explicitly degrade instead of concealing mailbox suffixes', () => {
  const queue = new InlineQueue(); queue.expanded = true;
  const view = { channel: 'main', deliveries: [delivery()], listener: 'live', remote: true };
  for (const width of [1, 12, 24, 40]) for (const height of [1, 6, 15, 24]) {
    const lines = queue.render(view, width, height);
    assert.ok(lines.length <= Math.max(1, Math.min(8, Math.floor(height / 3))));
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(!lines.some(line => /#iteration[^\n]*[.…]/.test(stripVTControlCharacters(line))));
  }
  assert.ok(queue.render(view, 40, 12).some(line => line.includes('Addresses need details')));
});
test('ANSI/control input never reaches identity display and detail has full from/to plus honest next', () => {
  const d = delivery(); d.message.from += '\x1b[2J\n';
  const lines = queueBlock(d, 100, true);
  assert.ok(lines.every(line => !line.includes('\x1b') && !line.includes('\n')));
  const dashboard = new Dashboard(() => ({ channel: 'main', deliveries: [d], listener: 'live' }), () => {}, () => {}, () => 18, { id: 'one', history: false });
  const detail = dashboard.render(100).join('\n');
  assert.ok(detail.includes('From: @lightjunction#iteration-resilience-pi-1013'));
  assert.ok(detail.includes('To: @lightjunction#iteration-resilience-cli-1013'));
  assert.ok(detail.includes('/msg next one'));
  d.notification = { phase: 'queued', attempt: 0 }; assert.match(nextHint(d), /Queued in Pi, not completed/);
  d.deferred = true; assert.match(nextHint(d), /resume one/);
  d.state = 'claimed'; assert.match(nextHint(d), /current token/);
  d.state = 'completed'; assert.match(nextHint(d), /not a server receipt/);
});
test('queued/observed recovery is durable, never completion; leases and duplicate cursors stay independent', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-msg-recovery-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new Store(config, dir); const message = delivery().message;
  store.ingest([message], 'history'); store.ingest([message], 'live', 'live');
  store.notify(['one'], 'queued');
  assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).deliveries[0].notification.phase, 'queued');
  store = new Store(config, dir); store.recover();
  assert.equal(store.journal.deliveries[0]!.notification!.phase, 'recoverable');
  assert.equal(store.journal.deliveries[0]!.state, 'pending');
  assert.equal(store.journal.cursor, 'history'); assert.equal(store.journal.liveCursor, 'live');
  assert.equal(store.ingest([message], 'live2', 'live'), 0);
  assert.equal(store.pending().length, 1);
  store.notify(['one'], 'observed');
  const claim = store.claim('one', 5, 1000); const token = claim.token!;
  store = new Store(config, dir); store.recover();
  assert.throws(() => store.finish('one', token, true, 1001), /Stale/);
  assert.equal(store.pending()[0]!.notification!.phase, 'recoverable');
  const retry = store.claim('one', 5, 1001); store.finish('one', retry.token!, true, 1002);
  store.recover(); assert.equal(store.pending().length, 0);
});
