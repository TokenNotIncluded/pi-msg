import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandleLabels, displayHandle } from '../src/labels.js';
import { queueLines } from '../src/dashboard.js';
import type { Delivery } from '../src/core.js';

test('explicit label binding/unbinding keeps stable handles and unknown fallback', () => {
  const labels = new HandleLabels();
  assert.equal(displayHandle('@owner#worker', labels.entries), '@owner#worker');
  labels.bind('@owner#worker', 'Patch reviewer');
  assert.equal(displayHandle('@owner#worker', labels.entries), '@owner#worker (Patch reviewer)');
  assert.equal(displayHandle('@other#worker', labels.entries), '@other#worker');
  assert.equal(displayHandle('@owner#worker2', labels.entries), '@owner#worker2');
  labels.unbind('@owner#worker');
  assert.equal(displayHandle('@owner#worker', labels.entries), '@owner#worker');
});
test('same label is not a unique identity; new run/restart has no inherited associations', () => {
  const run = new HandleLabels();
  run.bind('@owner#one', 'reviewer'); run.bind('@owner#two', 'reviewer');
  assert.equal(run.entries.size, 2);
  assert.equal(new HandleLabels().entries.size, 0, 'no disk/global mappings');
  run.clear(); assert.equal(displayHandle('@owner#one', run.entries), '@owner#one');
});
test('bare names, control sequences and oversized labels cannot become bindings', () => {
  const labels = new HandleLabels();
  for (const handle of ['worker', '#worker', '@owner', '@owner#worker other']) assert.throws(() => labels.bind(handle, 'reviewer'));
  for (const text of ['', ' ', '\x1b[2J', 'line\nbreak', 'x'.repeat(65)]) assert.throws(() => labels.bind('@owner#worker', text));
  assert.equal(labels.entries.size, 0);
  for (let i = 0; i < 128; i++) labels.bind(`@owner#worker${i}`, 'reviewer');
  assert.throws(() => labels.bind('@owner#overflow', 'reviewer'), /limit/);
  labels.bind('@owner#worker0', 'Updated');
  labels.unbind('@owner#worker1'); labels.bind('@owner#overflow', 'reviewer');
  assert.equal(labels.entries.size, 128);
});
test('queue works with no plugin or labels; explicit display metadata cannot change routing or delivery', () => {
  const labels = new HandleLabels(); labels.bind('@owner#sender', 'Alice'); labels.bind('@owner#receiver', 'Bob');
  const d: Delivery = { message: { id: 'one', from: '@owner#sender', to: '@owner#receiver', message: 'body' },
    metadata: { kind: 'task', summary: 'summary', requires_action: true }, state: 'pending', attempts: 0, receivedAt: 'now' };
  const before = JSON.stringify(d);
  const without = queueLines([d], 'live', 180).join('\n');
  assert.ok(without.includes('@owner#sender')); assert.ok(!without.includes('Alice'));
  const withLabels = queueLines([d], 'live', 180, labels.entries).join('\n');
  assert.ok(withLabels.includes('@owner#sender (Alice)')); assert.ok(withLabels.includes('@owner#receiver (Bob)'));
  assert.equal(JSON.stringify(d), before);
});
