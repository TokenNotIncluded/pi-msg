import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, compact, metadata, clean, binding, atomicJSON, privateDir, type Config, type Message } from '../src/core.js';

export const config: Config = { executable: 'msg', agent: 'main', subscription: 'test', remote: false, mergeMs: 50, maxPending: 100 };
export const message = (id: string, body = 'hello'): Message => ({ id, from: '@test#worker', to: '@test#main', message: body });
function fixture(t: { after: (fn: () => void) => void }, overrides: Partial<Config> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-msg-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return new Store({ ...config, ...overrides }, dir);
}
test('journal saves cursor with pending delivery and deduplicates retries', t => {
  const s = fixture(t); assert.equal(s.ingest([message('one')], 'cursor-1'), 1);
  assert.equal(s.ingest([message('one')], 'cursor-2'), 0);
  const restored = new Store(s.config, s.directory); assert.equal(restored.journal.cursor, 'cursor-2'); assert.equal(restored.pending().length, 1);
});
test('ID conflicts fail closed without advancing cursor', t => {
  const s = fixture(t); s.ingest([message('one')], 'c1'); assert.throws(() => s.ingest([message('one', 'changed')], 'c2'), /conflict/); assert.equal(s.journal.cursor, 'c1');
});
test('duplicate IDs in a single page are not duplicate tasks', t => {
  const s = fixture(t); assert.equal(s.ingest([message('one'), message('one')], 'c1'), 1);
});
test('conflicting duplicate in the same page does not partially commit', t => {
  const s = fixture(t); assert.throws(() => s.ingest([message('one'), message('one', 'other')], 'c1')); assert.equal(s.pending().length, 0); assert.equal(s.journal.cursor, undefined);
});
test('invalid message page cannot advance durable cursor', t => {
  const s = fixture(t); assert.throws(() => s.ingest([{ id: 'no-body' }], 'c1')); assert.equal(s.journal.cursor, undefined);
});
test('quota protects uncompleted work rather than deleting it', t => {
  const s = fixture(t, { maxPending: 1 }); s.ingest([message('one')], 'c1'); assert.throws(() => s.ingest([message('two')], 'c2'), /quota/); assert.equal(s.journal.cursor, 'c1'); assert.equal(s.pending().length, 1);
});
test('claim is not completion; complete requires current token', t => {
  const s = fixture(t); s.ingest([message('one')], 'c1'); const d = s.claim('one', 5, 1000);
  assert.equal(d.state, 'claimed'); assert.throws(() => s.finish('one', 'wrong', true, 2000)); s.finish('one', d.token!, true, 2000); assert.equal(s.pending().length, 0);
});
test('lease expiry invalidates stale completion and allows redelivery', t => {
  const s = fixture(t); s.ingest([message('one')], 'c1'); const token = s.claim('one', 5, 1000).token!;
  assert.throws(() => s.finish('one', token, true, 6001), /lease/); const d = s.claim('one', 5, 7000); assert.equal(d.attempts, 2); assert.notEqual(d.token, token);
});
test('crash recovery resets claim, preserves body and read position', t => {
  const s = fixture(t); s.ingest([message('one', 'original')], 'c1'); s.claim('one');
  const reopened = new Store(s.config, s.directory); reopened.recover(); assert.equal(reopened.pending()[0]?.state, 'pending'); assert.equal(reopened.pending()[0]?.message.message, 'original'); assert.equal(reopened.journal.cursor, 'c1');
});
test('failed work requeues rather than silently acknowledging', t => {
  const s = fixture(t); s.ingest([message('one')], 'c1'); const token = s.claim('one').token!; s.finish('one', token, false); assert.equal(s.pending()[0]?.state, 'pending'); assert.ok(s.pending()[0]?.error);
});
test('summary view is byte bounded and does not mutate original body', t => {
  const s = fixture(t); s.ingest([message('one', '汉'.repeat(1000)), message('two')], 'c1'); const view = compact(s.pending(), 512);
  assert.ok(Buffer.byteLength(JSON.stringify(view.items)) <= 512); assert.ok(view.omitted > 0); assert.equal(s.pending()[0]?.message.message.length, 1000);
});
test('structured notification exposes fixed refs but not duplicated body', () => {
  const m = metadata(message('one', JSON.stringify({ kind: 'result', ref: { id: 'resource-id', revision: 'rev' }, notification_only: true })));
  assert.equal(m.summary, 'result reference'); assert.equal(m.requires_action, true); assert.deepEqual(m.ref, { id: 'resource-id', revision: 'rev' });
});
test('progress defaults to no model wake; explicit blockers wake', () => {
  assert.equal(metadata(message('one', '{"kind":"progress"}')).requires_action, false);
  assert.equal(metadata(message('two', '{"kind":"blocker"}')).requires_action, true);
  assert.equal(metadata(message('three', '{"kind":"progress","requires_action":true}')).requires_action, true);
});
test('terminal controls cannot enter prompts or dashboard labels', () => { assert.equal(clean('x\x1b[31m\u202ey'), 'x [31m y'); });
test('subscription bindings differ across mailbox, account, service and reader', () => {
  for (const field of ['agent', 'subscription', 'account', 'server', 'configDir', 'username'] as const) assert.notEqual(binding(config), binding({ ...config, [field]: 'other' }));
});
test('a second active owner cannot advance the same journal', t => {
  const s = fixture(t); const unlock = s.lock(); assert.throws(() => s.lock(), /already active/); unlock(); s.lock()();
});
test('unsafe world-readable state is rejected', t => {
  const s = fixture(t); chmodSync(s.directory, 0o755); assert.throws(() => privateDir(s.directory), /owner-only/);
});
test('symlink and dangling symlink state targets are rejected', t => {
  const s = fixture(t); const target = join(s.directory, 'target'); writeFileSync(target, '{}', { mode: 0o600 });
  const link = join(s.directory, 'link'); symlinkSync(target, link); assert.throws(() => atomicJSON(link, {}), /Unsafe/);
  const dangling = join(s.directory, 'dangling'); symlinkSync(join(s.directory, 'absent'), dangling); assert.throws(() => atomicJSON(dangling, {}), /Unsafe/);
});
test('symlink state directory ancestors are rejected', t => {
  const s = fixture(t); const link = join(s.directory, 'alias'); symlinkSync(s.directory, link); assert.throws(() => privateDir(join(link, 'nested')), /symlink/);
});
