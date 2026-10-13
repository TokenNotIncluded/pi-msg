import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { Dashboard, queueLines, queueRow, transportMarker } from '../src/dashboard.js';
import type { Delivery } from '../src/core.js';

const delivery: Delivery = {
  message: { id: 'one', from: '@u#sender\x1b[2J', to: '@u#receiver\x1b[31m', message: 'PRIVATE BODY' },
  metadata: { kind: 'task', summary: '中文 🐱\x1b[2J summary', requires_action: true },
  state: 'pending', attempts: 0, receivedAt: '2026-10-13T01:00:00Z',
};

test('strip and queue use configured LOCAL/NET with honest unknown fallback', () => {
  const before = JSON.stringify(delivery);
  for (const remote of [false, true, undefined]) {
    const marker = remote === false ? '[LOCAL]' : remote === true ? '[NET]' : '[UNKNOWN]';
    assert.equal(transportMarker(remote), marker);
    const strip = queueLines([delivery], 'live', 100, undefined, { remote });
    assert.ok(strip.every(line => line.includes(marker)));
    const dashboard = new Dashboard(() => ({ channel: 'channel', deliveries: [delivery], listener: 'live', remote }), () => {}, () => {});
    assert.ok(dashboard.render(100).slice(0, 2).every(line => line.includes(marker)));
    assert.ok(!strip.join('\n').includes('PRIVATE BODY'));
  }
  assert.equal(JSON.stringify(delivery), before);
});

test('trusted theme styles sanitized roles distinctly; no-color and narrow widths stay safe', () => {
  const saved = process.env.NO_COLOR;
  const calls: Array<[string, string]> = [];
  const theme: Pick<Theme, 'fg'> = { fg: (color, text) => {
    calls.push([color, text]);
    assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(text), 'external controls never reach theme');
    return `\x1b[${color === 'accent' ? 34 : 32}m${text}\x1b[0m`;
  } };
  const labels = new Map([[delivery.message.from, 'role\x1b[2J中文']]);
  try {
    delete process.env.NO_COLOR;
    const row = queueRow(delivery, 100, true, labels, { remote: false, theme });
    assert.ok(row.includes('\x1b[34m')); assert.ok(row.includes('\x1b[32m'));
    assert.ok(calls.some(([color]) => color === 'accent')); assert.ok(calls.some(([color]) => color === 'success'));
    assert.equal(visibleWidth(row), 100); assert.ok(row.includes(' → '));
    for (const width of [0, 1, 8, 12, 24, 35, 36, 40, 80]) {
      assert.ok(visibleWidth(queueRow(delivery, width, true, labels, { remote: true, theme })) <= width);
      assert.ok(queueLines([delivery], 'live', width, labels, { remote: true, theme }).every(line => visibleWidth(line) <= width));
    }
    assert.ok(queueRow(delivery, 24, true, labels, { remote: true, theme }).includes(' → '), 'narrow rows retain direction');
    process.env.NO_COLOR = '';
    const plain = queueRow(delivery, 100, true, labels, { remote: true, theme });
    assert.ok(!plain.includes('\x1b')); assert.ok(plain.includes('[NET]')); assert.ok(plain.includes(' → '));
    assert.ok(plain.indexOf('@u#sender') < plain.indexOf('@u#receiver'));
    assert.ok(!queueRow(delivery, 100).includes('\x1b'), 'missing theme remains plain');
  } finally {
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});
