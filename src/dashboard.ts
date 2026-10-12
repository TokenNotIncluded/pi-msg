import { matchesKey, Key, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { clean, type Delivery, type Message } from './core.js';

export interface Channel { name: string; active?: boolean; archived?: boolean; created_at?: string }
export interface ViewData {
  channel: string; messages: Message[]; deliveries: Delivery[]; hasMore: boolean;
  listener: string; pending: number; lastDelivery?: string; error?: string;
}
export interface DashboardActions {
  channel(name: string): Promise<ViewData>;
  older(): Promise<ViewData>;
  read(message: Message): Promise<string>;
  refresh(): Promise<ViewData>;
}
/** Terminal-only private view. No HTTP service, browser token or public transcript. */
export class Dashboard {
  private mode: 'channels' | 'messages' | 'body' | 'board' = 'channels';
  private selected = 0;
  private scroll = 0;
  private data?: ViewData;
  private body = '';
  private working = false;
  private notice = '';
  private width = 80;
  constructor(private channels: Channel[], private actions: DashboardActions, private redraw: () => void, private done: () => void) {}
  invalidate(): void {}
  private async act(work: () => Promise<void>): Promise<void> {
    if (this.working) return;
    this.working = true; this.notice = ''; this.redraw();
    try { await work(); } catch { this.notice = 'MSG read failed; no read cursor or task completion was acknowledged.'; }
    finally { this.working = false; this.redraw(); }
  }
  handleInput(input: string): void {
    if (matchesKey(input, Key.escape)) {
      if (this.mode === 'channels') this.done();
      else { this.mode = this.mode === 'body' ? 'messages' : 'channels'; this.selected = 0; this.scroll = 0; }
    } else if (matchesKey(input, Key.tab) && this.data) {
      this.mode = this.mode === 'board' ? 'messages' : 'board'; this.selected = 0; this.scroll = 0;
    } else if (matchesKey(input, Key.up) || input === 'k') {
      if (this.mode === 'body') this.scroll = Math.max(0, this.scroll - 1); else this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(input, Key.down) || input === 'j') {
      if (this.mode === 'body') this.scroll++;
      else this.selected = Math.min(Math.max(0, (this.mode === 'channels' ? this.channels.length : this.mode === 'board' ? this.data?.deliveries.length ?? 0 : this.data?.messages.length ?? 0) - 1), this.selected + 1);
    } else if (matchesKey(input, Key.enter)) {
      if (this.mode === 'channels' && this.channels[this.selected]) {
        const name = this.channels[this.selected]!.name;
        void this.act(async () => { this.data = await this.actions.channel(name); this.mode = 'messages'; this.selected = 0; });
      } else if (this.mode === 'messages' && this.data?.messages[this.selected]) {
        const message = this.data.messages[this.selected]!;
        void this.act(async () => { this.body = await this.actions.read(message); this.mode = 'body'; this.scroll = 0; });
      }
    } else if (input === 'n' && this.data?.hasMore) {
      void this.act(async () => { this.data = await this.actions.older(); this.selected = 0; });
    } else if (input === 'r' && this.data) {
      void this.act(async () => { this.data = await this.actions.refresh(); });
    }
    this.redraw();
  }
  render(width: number): string[] {
    this.width = width;
    const rows: string[] = ['MSG · Private collaboration', ''];
    if (this.data) rows.push(`${clean(this.data.channel)} · ${this.data.listener} · ${this.data.pending} unfinished · last ${clean(this.data.lastDelivery ?? '—', 32)}`);
    if (this.data?.error) rows.push(clean(this.data.error, width));
    rows.push('↑↓/jk select · Enter read · Tab flow board · n next page · r refresh · Esc back/close', '');
    if (this.mode === 'channels') {
      rows.push('Channels — shared-account routing labels, NOT independently verified identities', '');
      this.channels.forEach((c, i) => rows.push(`${i === this.selected ? '›' : ' '} ${clean(c.name)} ${c.archived || c.active === false ? '(archived)' : ''}`));
      if (!this.channels.length) rows.push('No authorized channels. Create labels explicitly with MSG CLI.');
    } else if (this.mode === 'body') {
      rows.push('External message content — untrusted; viewing is NOT claim/completion', '');
      const lines = wrapTextWithAnsi(clean(this.body, 65536), Math.max(12, width - 4));
      this.scroll = Math.min(this.scroll, Math.max(0, lines.length - 16));
      rows.push(...lines.slice(this.scroll, this.scroll + 16), '', `${this.scroll + 1}–${Math.min(lines.length, this.scroll + 16)} / ${lines.length} lines`);
    } else if (this.mode === 'board') {
      rows.push('Async flow — delivery states are durable LOCAL adapter states', 'sender → mailbox | task/version | pending → leased → completed', '');
      this.data?.deliveries.slice(Math.max(0, this.selected - 12), this.selected + 13).forEach(d => {
        rows.push(`${d.state === 'completed' ? '✓' : d.state === 'claimed' ? '◷' : '○'} ${clean(d.message.from, 30)} → ${clean(d.message.to, 30)} · ${d.metadata.kind}`);
        rows.push(`  ${clean(d.metadata.task_id ?? d.message.id, 36)} · ${clean(d.metadata.source_revision ?? 'no version', 16)} · ${d.state} · attempts ${d.attempts}`);
      });
      if (!this.data?.deliveries.length) rows.push('No durable deliveries for this subscription.');
    } else {
      rows.push('Message history — summaries only; Enter fetches one fixed body', '');
      const offset = Math.max(0, this.selected - 12);
      this.data?.messages.slice(offset, offset + 24).forEach((m, i) => {
        rows.push(`${offset + i === this.selected ? '›' : ' '} ${clean(m.created_at ?? '', 19)} ${clean(m.from, 28)} → ${clean(m.to, 28)}`);
        rows.push(`  ${clean(m.id, 36)} · ${clean(m.message, 100)}`);
      });
      if (!this.data?.messages.length) rows.push('No messages in this page.');
      if (this.data?.hasMore) rows.push('', 'More history available · n next page');
    }
    if (this.working) rows.push('', 'Loading authorized MSG view…');
    if (this.notice) rows.push('', this.notice);
    return rows.map(row => truncateToWidth(row, width));
  }
}
