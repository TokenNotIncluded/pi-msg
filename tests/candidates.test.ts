import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { Store, type Config, type Delivery } from '../src/core.js';
import { candidates, candidateLines, candidateKey, candidateNotice } from '../src/candidates.js';

const config: Config = { executable: 'msg', agent: 'main', subscription: 'test', remote: false, username: 'test', configDir: '/unused', mergeMs: 100, maxPending: 100 };
const delivery = (id: string): Delivery => ({ message: { id, from: '@test#worker', to: '@test#main', message: 'PRIVATE FULL BODY' }, metadata: { kind: 'result', summary: '结果完成 🐱', requires_action: true }, state: 'pending', attempts: 0, receivedAt: 'now' });

test('candidate rendering is bounded, terminal safe, and does not mutate delivery state', () => {
  const items = Array.from({ length: 100 }, (_, i) => delivery(`id${i}`));
  items[0]!.message.from = '\x1b[2Jworker\u202e';
  items[0]!.metadata.summary += '\x1b[2J';
  const before = JSON.stringify(items);
  for (const width of [0, 1, 12, 40, 80]) {
    const lines = candidateLines(items, 'live', new Set([candidateKey(items[0]!)]), width);
    assert.ok(lines.length <= 3);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(lines.every(line => !line.includes('\x1b[2J') && !line.includes('\u202e')));
  }
  assert.equal(JSON.stringify(items), before);
  assert.ok(candidateLines(items, 'live', new Set(), 160)[2]?.includes('+98 more'));
  const notice = candidateNotice(items.slice(0, 1));
  assert.ok(!notice.includes('PRIVATE FULL BODY'));
  assert.ok(!notice.includes('\x1b[2J'));
  assert.match(notice, /external agent/);
});

test('real Pi custom-message method queues external provenance without steering busy work', async () => {
  const received: unknown[] = [];
  const receiver = { isStreaming: true, agent: {
    followUp: (message: unknown) => received.push(message),
    steer: () => { throw new Error('Must not interrupt active work'); },
  } } as unknown as AgentSession;
  await AgentSession.prototype.sendCustomMessage.call(receiver, {
    customType: 'msg-candidates', content: candidateNotice([delivery('one')]),
    display: true, details: { source: 'external-agent', ids: ['one'] },
  }, { triggerTurn: true, deliverAs: 'followUp' });
  assert.equal(received.length, 1);
  assert.equal((received[0] as { role: string }).role, 'custom');
  assert.equal((received[0] as { customType: string }).customType, 'msg-candidates');
});

test('defer survives reload, remains pending, and rejects claimed or missing deliveries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-msg-candidates-'));
  try {
    const s = new Store(config, dir);
    s.ingest([{ id: 'one', from: '@test#worker', to: '@test#main', message: 'hello' }], 'cursor');
    s.defer('one', true);
    const restored = new Store(config, dir);
    assert.equal(restored.pending().length, 1);
    assert.equal(candidates(restored.journal.deliveries).length, 0);
    restored.defer('one', false);
    assert.equal(candidates(restored.journal.deliveries).length, 1);
    restored.claim('one');
    assert.equal(candidates(restored.journal.deliveries).length, 0);
    assert.throws(() => restored.defer('one', true), /Only pending/);
    assert.throws(() => restored.defer('missing', false), /Only pending/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
