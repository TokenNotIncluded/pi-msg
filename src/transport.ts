import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Config, type Message, Store, checkFile, privateDir } from './core.js';

export interface Page { items: Message[]; cursor: string; has_more: boolean }
export function argumentsFor(config: Config): string[] {
  return [...(config.account ? ['--account', config.account] : []), ...(config.server ? ['--server', config.server] : []), ...(config.configDir ? ['--config-dir', config.configDir] : []), ...(config.username ? ['--username', config.username] : []), ...(!config.remote ? ['--offline'] : []), '--agent', config.agent, '--format', 'json'];
}
export async function command(config: Config, args: string[], signal?: AbortSignal, raw = false): Promise<unknown> {
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(config.executable, [...argumentsFor(config), ...args], { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let size = 0; const output: Buffer[] = []; let ended = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
    const force = setTimeout(() => child.kill('SIGKILL'), 32_000);
    const finish = (error?: Error) => {
      if (ended) return; ended = true; clearTimeout(timer); clearTimeout(force);
      error ? reject(error) : resolve(Buffer.concat(output).toString('utf8'));
    };
    child.stdout?.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) { child.kill('SIGKILL'); finish(new Error('MSG output exceeds 2 MiB')); } else output.push(chunk); });
    child.stderr?.resume();
    child.on('error', () => finish(new Error('MSG CLI could not start or was cancelled')));
    child.on('close', code => finish(code === 0 ? undefined : new Error(`MSG CLI failed (${code ?? 'signal'}); check CLI authentication/configuration outside the model context`)));
  });
  if (raw) return result;
  try {
    const envelope = JSON.parse(result);
    if (envelope.status !== 'ok') throw new Error('not ok');
    return envelope.data;
  } catch { throw new Error('MSG CLI did not return a successful JSON envelope'); }
}
export class Subscription {
  private abort = new AbortController();
  private child?: ChildProcess;
  private loop?: Promise<void>;
  private draining = false;
  private again = false;
  private unlock?: () => void;
  private timer?: NodeJS.Timeout;
  private retry = 0;
  private cursorFile: string;
  state: 'stopped' | 'connecting' | 'live' | 'reconnecting' | 'paused' = 'stopped';
  lastDelivery?: string;
  lastError?: string;
  constructor(readonly store: Store, readonly onDelivery: () => void, readonly onState: () => void = () => {}) {
    this.cursorFile = join(store.directory, 'listen-cursor.json');
  }
  async start(): Promise<void> {
    if (this.state !== 'stopped') return;
    this.unlock = this.store.lock();
    try {
      // Load after taking the lock: another process may have advanced the journal.
      this.store.journal = new Store(this.store.config, this.store.directory).journal;
      this.store.recover(); this.abort = new AbortController();
      this.state = 'connecting'; this.onState();
      // Establish the new live-reader boundary BEFORE reconciling the inbox.
      // This closes the drain/spawn race without scanning listener history.
      checkFile(this.cursorFile);
      if (!existsSync(this.cursorFile)) await command(this.store.config, ['listen', ...(this.store.config.remote ? ['--remote'] : []), '--cursor-file', this.cursorFile, '--event', 'subagent.message', '--from-now', '--once', '--max-pages', '1'], this.abort.signal, true);
      // Independent live and backfill cursors: a large unrelated event history
      // must not delay a fresh message or discard unfinished historical work.
      if (!this.store.journal.liveCursor) {
        const tail = await command(this.store.config, ['agent', 'inbox', ...(this.store.config.remote ? ['--remote'] : []), '--tail', '--limit', '1'], this.abort.signal) as Page;
        if (!tail || !Array.isArray(tail.items) || tail.items.length || typeof tail.cursor !== 'string' || tail.has_more !== false) throw new Error('MSG CLI must support inbox --tail');
        this.store.ingest([], tail.cursor, 'live');
      }
      void this.drain().catch(() => { this.lastError = 'Inbox reconciliation failed; durable cursors retained'; this.child?.kill('SIGTERM'); });
      this.scheduleLeases();
      this.loop = this.listen();
      if (this.store.pending().length) this.onDelivery();
    } catch (e) { await this.stop(); throw e; }
  }
  private async drain(): Promise<void> {
    if (this.draining) { this.again = true; return; }
    this.draining = true;
    try {
      do {
        this.again = false;
        let hasMore: boolean;
        do {
          const config = this.store.config;
          const value = await command(config, ['agent', 'inbox', ...(config.remote ? ['--remote'] : []), '--limit', '50', '--cursor', this.store.journal.liveCursor!], this.abort.signal) as Page;
          if (!value || !Array.isArray(value.items) || typeof value.cursor !== 'string' || typeof value.has_more !== 'boolean') throw new Error('MSG inbox page shape is not supported');
          const previous = this.store.journal.liveCursor;
          const count = this.store.ingest(value.items, value.cursor, 'live');
          if (count) { this.lastDelivery = new Date().toISOString(); this.onDelivery(); }
          hasMore = value.has_more;
          if (hasMore && value.cursor === previous) throw new Error('MSG inbox pagination did not advance');
        } while (hasMore && !this.abort.signal.aborted);
        if (!this.store.journal.historyComplete && !this.abort.signal.aborted) {
          const config = this.store.config;
          const previous = this.store.journal.cursor;
          const history = await command(config, ['agent', 'inbox', ...(config.remote ? ['--remote'] : []), '--limit', '50', ...(previous ? ['--cursor', previous] : [])], this.abort.signal) as Page;
          if (!history || !Array.isArray(history.items) || typeof history.cursor !== 'string' || typeof history.has_more !== 'boolean') throw new Error('Unsupported history page');
          if (history.has_more && history.cursor === previous) throw new Error('History cursor did not advance');
          if (this.store.ingest(history.items, history.cursor)) { this.lastDelivery = new Date().toISOString(); this.onDelivery(); }
          if (history.has_more) this.again = true;
          else { this.store.journal.historyComplete = true; this.store.save(); }
        }
        // Recheck live work between bounded history pages; listener hints can
        // still enqueue reconciliation while this serialized worker runs.
      } while (this.again && !this.abort.signal.aborted);
    } finally { this.draining = false; }
  }
  private async listen(): Promise<void> {
    while (!this.abort.signal.aborted && this.state !== 'paused') {
      // Every reconnection first reconciles the durable inbox cursor, so a lost
      // listener event is a hint lost, never the only copy of a task.
      try {
        await this.drain();
        checkFile(this.cursorFile);
        this.state = 'live'; this.onState();
        await new Promise<void>((resolve, reject) => {
          const config = this.store.config;
          const child = spawn(config.executable, [...argumentsFor(config), 'listen', ...(config.remote ? ['--remote'] : []), '--cursor-file', this.cursorFile, '--event', 'subagent.message', '--interval', '1'], { stdio: ['ignore', 'pipe', 'pipe'], signal: this.abort.signal });
          this.child = child;
          // Notifications contain no authoritative payload. Any output nudges
          // a serialized inbox drain, rather than being copied into a prompt.
          child.stdout?.on('data', () => {
            void this.drain().catch(() => { this.lastError = 'Inbox reconciliation failed; reconnecting without advancing unpersisted work'; child.kill('SIGTERM'); });
          });
          child.stderr?.resume();
          child.on('error', () => reject(new Error('Listener could not start')));
          child.on('close', code => { this.child = undefined; code === 0 ? resolve() : reject(new Error('Listener disconnected')); });
        });
        this.retry = 0;
      } catch {
        if (this.abort.signal.aborted) break;
        if (this.store.pending().length >= this.store.config.maxPending) {
          this.state = 'paused'; this.lastError = 'Pending quota reached; complete work, then reconnect'; this.onState(); break;
        }
        this.lastError = 'Listener/reconciliation unavailable; retrying with durable inbox cursor';
      }
      if (this.abort.signal.aborted) break;
      this.state = 'reconnecting'; this.onState();
      await sleep(Math.min(30_000, 500 * 2 ** this.retry++) + Math.floor(Math.random() * 250), undefined, { signal: this.abort.signal }).catch(() => {});
    }
  }
  scheduleLeases(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.state === 'stopped') return;
    const deadlines = this.store.pending().flatMap(d => d.leaseUntil === undefined ? [] : [d.leaseUntil]);
    if (!deadlines.length) return;
    this.timer = setTimeout(() => { if (this.store.expire()) this.onDelivery(); this.scheduleLeases(); }, Math.max(1, Math.min(...deadlines) - Date.now()));
  }
  async stop(): Promise<void> {
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    const child = this.child;
    if (child) { child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await new Promise<void>(r => child.once('close', () => r())); clearTimeout(timer); }
    await this.loop;
    // An aborted CLI drain may still be finalizing its journal write.
    while (this.draining) await sleep(10);
    this.unlock?.(); this.unlock = undefined; this.state = 'stopped'; this.onState();
  }
}
export async function send(config: Config, directory: string, to: string, body: string, id: string): Promise<{ id: string; to: string; status: string; resource?: unknown; path?: unknown }> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Message ID must match MSG retry-safe ID syntax');
  if (Buffer.byteLength(body) > 65536) throw new Error('Message exceeds 64 KiB');
  privateDir(directory);
  const path = join(directory, 'send-' + randomUUID());
  writeFileSync(path, body, { flag: 'wx', mode: 0o600 });
  try {
    const result = await command(config, ['agent', 'send', to, '--file', path, '--message-id', id, ...(config.remote ? ['--remote', '--receipt'] : [])]) as Record<string, unknown>;
    // Local MSG has no native receipt yet; discard its body in this adapter.
    return { id, to, status: 'saved', ...(config.remote ? { resource: result.resource, path: result.path } : {}) };
  } finally { unlinkSync(path); }
}
