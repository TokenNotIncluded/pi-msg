import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJSON, checkFile, metadata, type Config, type Delivery } from './core.js';

/** Presentation only: task state remains in the receive journal, never synthesized as complete. */
export interface ConversationDelivery extends Delivery {
  outbound?: boolean;
  transport?: 'received' | 'sending' | 'sent' | 'failed';
}
export interface Outgoing {
  to: string; body: string; saved?: boolean;
  state?: 'sending' | 'sent' | 'failed'; createdAt?: string;
  receipt?: { id: string; to: string; status: string; from?: string; resource?: unknown; path?: unknown };
}
/** Reuses the existing retry outbox. No second persisted copy of message bodies. */
export class Outbox {
  private entries: Record<string, Outgoing>;
  private readonly path: string;
  constructor(private readonly config: Config, directory: string) {
    this.path = join(directory, 'outbox.json'); checkFile(this.path);
    this.entries = Object.assign(Object.create(null), existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {});
    for (const [id, item] of Object.entries(this.entries)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !item || typeof item.to !== 'string' || typeof item.body !== 'string' || (item.state !== undefined && !['sending', 'sent', 'failed'].includes(item.state))) throw new Error('Invalid private outbox');
    }
    // A saved receipt stays sent. An ambiguous interrupted send needs an explicit retry.
    let changed = false;
    for (const item of Object.values(this.entries)) if (!item.saved && item.state === 'sending') { item.state = 'failed'; changed = true; }
    if (changed) this.save();
  }
  private save(): void { atomicJSON(this.path, this.entries); }
  prepare(id: string, to: string, body: string): Outgoing {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid MSG message ID');
    if (Buffer.byteLength(body) > 65536) throw new Error('Message exceeds 64 KiB');
    const old = this.entries[id];
    if (old && (old.to !== to || old.body !== body)) throw new Error('Outbox message ID conflict');
    if (old?.saved) return old;
    if (old?.state === 'sending') throw new Error('Send already in progress for this message ID');
    const next: Outgoing = { to, body, state: 'sending', createdAt: old?.createdAt ?? new Date().toISOString() };
    this.entries[id] = next;
    try { this.save(); } catch (e) { if (old) this.entries[id] = old; else delete this.entries[id]; throw e; }
    return next;
  }
  finish(id: string, receipt?: Outgoing['receipt']): void {
    const old = this.entries[id]; if (!old) throw new Error('Unknown outbox ID');
    if (old.saved && !receipt) return;
    this.entries[id] = { ...old, state: receipt ? 'sent' : 'failed', saved: !!receipt, receipt };
    try { this.save(); } catch (e) { this.entries[id] = old; throw e; }
  }
  conversation(): ConversationDelivery[] {
    return Object.entries(this.entries).map(([id, entry]) => {
      // A local account alias is not necessarily the authenticated server username.
      const from = entry.receipt?.from ?? (this.config.username ? `@${this.config.username}#${this.config.agent}` : '(sender not reported)');
      const message = { id, from, to: entry.to, message: entry.body, created_at: entry.createdAt };
      return { message, metadata: { ...metadata(message), requires_action: false }, state: 'pending', attempts: 0,
        receivedAt: entry.createdAt ?? '', outbound: true, transport: entry.saved ? 'sent' : entry.state ?? 'failed' };
    });
  }
}
export function communicationPending(d: ConversationDelivery): boolean { return d.outbound === true && d.transport !== 'sent'; }
export function communicationStatus(d: ConversationDelivery): string { return d.outbound ? d.transport ?? 'failed' : 'received'; }
