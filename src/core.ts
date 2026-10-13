import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, existsSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, fsyncSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface Config {
  executable: string;
  account?: string;
  server?: string;
  configDir?: string;
  username?: string;
  agent: string;
  subscription: string;
  remote: boolean;
  mergeMs: number;
  maxPending: number;
  /** External messages never gain user authority, even in automatic mode. */
  candidateMode?: 'manual' | 'followUp';
}
export interface Message {
  id: string; from: string; to: string; message: string; created_at?: string;
  type?: string; seq?: number;
}
export interface Metadata {
  kind: string; summary: string; task_id?: string; source_revision?: string;
  reply_to?: string; status?: string; evidence_refs?: unknown[]; requires_action: boolean;
  ref?: { id: string; revision: string };
}
export interface Delivery {
  message: Message; metadata: Metadata; state: 'pending' | 'claimed' | 'completed';
  attempts: number; receivedAt: string; leaseUntil?: number; token?: string; error?: string;
  deferred?: boolean;
  /** Pi queue acceptance/observation is not delivery completion. */
  notification?: { phase: 'queued' | 'observed' | 'recoverable'; attempt: number };
}
export interface Journal {
  version: 1; binding: string; cursor?: string; liveCursor?: string; historyComplete?: boolean; deliveries: Delivery[];
}
export function clean(value: unknown, max = 160): string {
  return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, max);
}
export function label(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error('Invalid mailbox/subscription label');
  return value;
}
export function binding(config: Config): string {
  return createHash('sha256').update(JSON.stringify([config.server ?? null, config.account ?? null, config.configDir ?? null, config.username ?? null, config.agent, config.subscription, config.remote])).digest('hex');
}
export function privateDir(path: string): void {
  const target = resolve(path);
  let current = target;
  while (current !== dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Private state path contains a symlink'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    current = dirname(current);
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const st = lstatSync(target);
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error('Private state directory requires owner-only permissions');
}
export function checkFile(path: string): void {
  if (!existsSync(path)) {
    // existsSync is false for a dangling symlink: lstat must still reject it.
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('Unsafe private file'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return;
  }
  const st = lstatSync(path);
  if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.nlink !== 1) throw new Error('Unsafe private file');
}
export function atomicJSON(path: string, value: unknown): void {
  privateDir(dirname(path)); checkFile(path);
  const temporary = path + '.' + randomUUID();
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    renameSync(temporary, path);
    const dir = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function stateRoot(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'pi-msg');
}
export function metadata(message: Message): Metadata {
  let object: Record<string, unknown> = {};
  try { const parsed = JSON.parse(message.message); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) object = parsed; } catch { /* Free-form bodies remain valid. */ }
  const kind = typeof object.kind === 'string' ? clean(object.kind, 32) : 'message';
  const ref = object.ref as Record<string, unknown> | undefined;
  return {
    kind, summary: clean(object.summary ?? (object.notification_only ? `${kind} reference` : message.message), 140),
    task_id: typeof object.task_id === 'string' ? clean(object.task_id, 128) : undefined,
    source_revision: typeof object.source_revision === 'string' ? clean(object.source_revision, 128) : undefined,
    reply_to: typeof object.reply_to === 'string' ? clean(object.reply_to, 128) : undefined,
    status: typeof object.status === 'string' ? clean(object.status, 48) : undefined,
    evidence_refs: Array.isArray(object.evidence_refs) ? object.evidence_refs.slice(0, 16) : undefined,
    requires_action: typeof object.requires_action === 'boolean' ? object.requires_action : !['progress', 'receipt'].includes(kind),
    ref: ref && typeof ref.id === 'string' && typeof ref.revision === 'string' ? { id: ref.id, revision: ref.revision } : undefined,
  };
}
export function validMessage(value: unknown): value is Message {
  const m = value as Message | undefined;
  return !!m && /^[A-Za-z0-9_-]{1,64}$/.test(m.id) && typeof m.from === 'string' && typeof m.to === 'string' && typeof m.message === 'string' && Buffer.byteLength(m.message) <= 65536;
}
export class Store {
  readonly path: string;
  journal: Journal;
  constructor(readonly config: Config, readonly directory = join(stateRoot(), binding(config))) {
    privateDir(directory); this.path = join(directory, 'journal.json'); checkFile(this.path);
    this.journal = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { version: 1, binding: binding(config), deliveries: [] };
    if (this.journal.version !== 1 || this.journal.binding !== binding(config) || !Array.isArray(this.journal.deliveries) || this.journal.deliveries.some(d => !validMessage(d.message) || !['pending', 'claimed', 'completed'].includes(d.state))) throw new Error('Invalid subscription journal');
  }
  save(): void { atomicJSON(this.path, this.journal); }
  ingest(items: unknown[], cursor: string, stream: 'history' | 'live' = 'history'): number {
    if (typeof cursor !== 'string' || !items.every(validMessage)) throw new Error('Invalid MSG inbox page');
    const seen = new Map(this.journal.deliveries.map(d => [d.message.id, d]));
    const added: Delivery[] = [];
    for (const item of items as Message[]) {
      const old = seen.get(item.id);
      if (old) {
        if (old.message.from !== item.from || old.message.to !== item.to || old.message.message !== item.message) throw new Error('MSG message ID conflicts with durable delivery');
        continue;
      }
      const d: Delivery = { message: item, metadata: metadata(item), state: 'pending', attempts: 0, receivedAt: new Date().toISOString() };
      added.push(d); seen.set(item.id, d);
    }
    if (this.pending().length + added.length > this.config.maxPending) throw new Error('Pending quota reached; cursor not advanced. Complete work or increase configured quota.');
    const previous = this.journal;
    const completed = previous.deliveries.filter(d => d.state === 'completed').slice(-1000);
    this.journal = { ...previous, [stream === 'live' ? 'liveCursor' : 'cursor']: cursor, deliveries: [...completed, ...previous.deliveries.filter(d => d.state !== 'completed'), ...added] };
    try { this.save(); } catch (e) { this.journal = previous; throw e; }
    return added.length;
  }
  pending(): Delivery[] { return this.journal.deliveries.filter(d => d.state !== 'completed'); }
  expire(now = Date.now()): number {
    let changed = 0;
    for (const d of this.journal.deliveries) if (d.state === 'claimed' && (d.leaseUntil ?? 0) <= now) {
      d.state = 'pending'; delete d.token; delete d.leaseUntil; changed++;
    }
    if (changed) this.save(); return changed;
  }
  claim(id: string, seconds = 300, now = Date.now()): Delivery {
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) throw new Error('Lease must be 5–3600 seconds');
    this.expire(now);
    const d = this.journal.deliveries.find(d => d.message.id === id);
    if (!d || d.state !== 'pending') throw new Error('Delivery is not pending');
    d.state = 'claimed'; d.token = randomUUID(); d.leaseUntil = now + seconds * 1000; d.attempts++; this.save(); return d;
  }
  finish(id: string, token: string, success: boolean, now = Date.now()): void {
    this.expire(now);
    const d = this.journal.deliveries.find(d => d.message.id === id);
    if (!d || d.state !== 'claimed' || d.token !== token) throw new Error('Stale or invalid delivery lease');
    d.state = success ? 'completed' : 'pending'; delete d.token; delete d.leaseUntil;
    d.error = success ? undefined : 'Handler reported failure; eligible for retry'; this.save();
  }
  defer(id: string, deferred: boolean): void {
    const d = this.journal.deliveries.find(d => d.message.id === id);
    if (!d || d.state !== 'pending') throw new Error('Only pending deliveries can be deferred');
    const previous = d.deferred;
    d.deferred = deferred;
    try { this.save(); } catch (e) { d.deferred = previous; throw e; }
  }
  notify(ids: string[], phase: 'queued' | 'observed' | 'recoverable'): void {
    const previous = this.journal;
    this.journal = { ...previous, deliveries: previous.deliveries.map(d => ids.includes(d.message.id) && d.state !== 'completed' ? { ...d, notification: { phase, attempt: d.attempts } } : d) };
    try { this.save(); } catch (e) { this.journal = previous; throw e; }
  }
  recover(): void {
    // Restart is not permission to execute. Interrupted notices need explicit /msg next.
    for (const d of this.journal.deliveries) {
      if (d.state === 'claimed') { d.state = 'pending'; delete d.token; delete d.leaseUntil; }
      if (d.state !== 'completed' && d.notification) d.notification = { phase: 'recoverable', attempt: d.attempts };
    }
    this.save();
  }
  lock(): () => void {
    const path = join(this.directory, 'owner.lock'); checkFile(path);
    if (existsSync(path)) {
      const owner = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid subscription owner lock');
      try { process.kill(owner.pid, 0); throw new Error('Subscription already active; choose an independent subscription ID'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
      unlinkSync(path);
    }
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); fsyncSync(fd); } finally { closeSync(fd); }
    return () => { if (existsSync(path)) unlinkSync(path); };
  }
}
export function compact(deliveries: Delivery[], budget = 4096): { items: unknown[]; omitted: number } {
  const items: unknown[] = []; let bytes = 2;
  for (const d of deliveries) {
    const item = { id: d.message.id, from: d.message.from, to: d.message.to, state: d.state, deferred: d.deferred === true, notification: d.notification, ...d.metadata, attempts: d.attempts };
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > budget) break;
    bytes += size; items.push(item);
  }
  return { items, omitted: deliveries.length - items.length };
}
