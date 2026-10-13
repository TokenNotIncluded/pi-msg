import { matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { clean, type Delivery } from './core.js';
import { displayHandle } from './labels.js';

/** Transport is actual subscription configuration, never inferred from a handle. */
export interface QueuePresentation { remote?: boolean; theme?: Pick<Theme, 'fg'>; }
export function transportMarker(remote?: boolean): string {
  return remote === true ? '[NET]' : remote === false ? '[LOCAL]' : '[UNKNOWN]';
}
function roleColor(text: string, role: 'sender' | 'recipient', theme?: Pick<Theme, 'fg'>): string {
  // Width utilities can add their own reset sequence to truncated plain text.
  const plain = stripVTControlCharacters(text);
  return theme && process.env.NO_COLOR === undefined ? theme.fg(role === 'sender' ? 'accent' : 'success', plain) : plain;
}
function fit(text: string, width: number, theme?: Pick<Theme, 'fg'>): string {
  const line = truncateToWidth(text, width);
  return theme && process.env.NO_COLOR === undefined ? line : stripVTControlCharacters(line);
}
export interface QueueView extends QueuePresentation {
  channel: string; deliveries: Delivery[]; listener: string; error?: string;
  labels?: ReadonlyMap<string, string>;
}
/** A read-only projection of this subscription, never an account-wide inbox scan. */
export function queueItems(deliveries: Delivery[], history = false): Delivery[] {
  return deliveries.map((delivery, index) => ({ delivery, index }))
    .filter(({ delivery }) => history || delivery.state !== 'completed')
    .sort((a, b) => {
      const time = (d: Delivery) => Date.parse(d.message.created_at ?? '') || Date.parse(d.receivedAt) || 0;
      return time(b.delivery) - time(a.delivery) || b.index - a.index;
    }).map(({ delivery }) => delivery);
}
/** Sender left, recipient right, summary in the middle; routing labels are not identities. */
export function queueRow(d: Delivery, width: number, selected = false, labels?: ReadonlyMap<string, string>, presentation: QueuePresentation = {}): string {
  if (width < 1) return '';
  const prefix = `${selected ? '› ' : '  '}${transportMarker(presentation.remote)} `;
  // Sanitize external handles/labels before adding only trusted theme escapes.
  const sender = displayHandle(d.message.from, labels);
  const recipient = displayHandle(d.message.to, labels);
  if (width < 36) {
    const available = Math.max(0, width - visibleWidth(prefix) - 3);
    const left = Math.ceil(available / 2);
    const from = roleColor(truncateToWidth(sender, left, '…'), 'sender', presentation.theme);
    const to = roleColor(truncateToWidth(recipient, available - left, '…'), 'recipient', presentation.theme);
    return fit(`${prefix}${from} → ${to}`, width, presentation.theme);
  }
  const edge = Math.max(1, Math.min(labels?.size ? 40 : 24, Math.floor((width - visibleWidth(prefix) - 6) / 4)));
  const from = roleColor(truncateToWidth(sender, edge), 'sender', presentation.theme);
  const to = roleColor(truncateToWidth(recipient, edge), 'recipient', presentation.theme);
  const middleWidth = Math.max(1, width - visibleWidth(prefix) - 6 - visibleWidth(from) - visibleWidth(to));
  const summary = truncateToWidth(`${d.state}${d.deferred ? '/deferred' : ''} · ${clean(d.metadata.summary, 140)}`, middleWidth);
  const gap = Math.max(0, middleWidth - visibleWidth(summary));
  return fit(`${prefix}${from} → ${summary}${' '.repeat(gap)} │ ${to}`, width, presentation.theme);
}
export function queueLines(deliveries: Delivery[], state: string, width: number, labels?: ReadonlyMap<string, string>, presentation: QueuePresentation = {}): string[] {
  if (width < 1) return [];
  const items = queueItems(deliveries);
  const claimed = items.filter(d => d.state === 'claimed').length;
  const deferred = items.filter(d => d.deferred).length;
  return [`MSG ${transportMarker(presentation.remote)} ${clean(state, 24)} · ${items.length} unfinished · ${claimed} claimed${deferred ? ` · ${deferred} deferred` : ''} · /msg expand`, ...items.slice(0, 2).map(d => queueRow(d, width, false, labels, presentation))]
    .map(line => fit(line, width, presentation.theme));
}

/** Compact temporary overlay; expanding a saved body has no delivery side effects. */
export class Dashboard {
  private history = false;
  private selectedId?: string;
  private expandedId?: string;
  private scroll = 0;
  private closed = false;
  constructor(private view: () => QueueView, private redraw: () => void, private done: () => void,
    private height: () => number = () => 18) {}
  invalidate(): void {}
  dispose(): void { this.closed = true; }
  private items(): Delivery[] {
    const items = queueItems(this.view().deliveries, this.history);
    if (!items.some(d => d.message.id === this.selectedId)) this.selectedId = items[0]?.message.id;
    if (this.expandedId && !items.some(d => d.message.id === this.expandedId)) { this.expandedId = undefined; this.scroll = 0; }
    return items;
  }
  handleInput(input: string): void {
    if (this.closed) return;
    const items = this.items();
    const selected = Math.max(0, items.findIndex(d => d.message.id === this.selectedId));
    if (input === 'q' || matchesKey(input, Key.ctrl('c'))) {
      this.closed = true; this.done(); return;
    }
    if (matchesKey(input, Key.escape)) {
      if (this.expandedId) { this.expandedId = undefined; this.scroll = 0; }
      else { this.closed = true; this.done(); return; }
    } else if (input === 'h') {
      this.history = !this.history; this.expandedId = undefined; this.scroll = 0; this.items();
    } else if (matchesKey(input, Key.enter) || input === ' ') {
      this.expandedId = this.expandedId ? undefined : this.selectedId; this.scroll = 0;
    } else if (matchesKey(input, Key.up) || input === 'k') {
      if (this.expandedId) this.scroll = Math.max(0, this.scroll - 1);
      else this.selectedId = items[Math.max(0, selected - 1)]?.message.id;
    } else if (matchesKey(input, Key.down) || input === 'j') {
      if (this.expandedId) this.scroll++;
      else this.selectedId = items[Math.min(items.length - 1, selected + 1)]?.message.id;
    }
    this.redraw();
  }
  render(width: number): string[] {
    if (this.closed || width < 1) return [];
    const height = Math.max(1, Math.min(18, Math.floor(this.height())));
    const items = this.items();
    const view = this.view();
    const title = `MSG ${transportMarker(view.remote)} · ${this.history ? 'saved history' : 'unfinished queue'} (${items.length}) · ${clean(view.channel, 64)} · ${clean(view.listener, 24)}`;
    const footer = this.expandedId ? '↑↓/jk scroll · Enter fold · Esc back' : '↑↓/jk · Enter open · h hist · Esc close';
    if (height === 1) return [fit(title, width, view.theme)];
    const rows = [title];
    const budget = height - 2;
    if (this.expandedId) {
      const d = items.find(d => d.message.id === this.expandedId)!;
      // Preserve line breaks, but strip control/escape sequences from external content.
      const lines = d.message.message.slice(0, 65536).split(/\r?\n/).flatMap(line => wrapTextWithAnsi(clean(line, 65536), Math.max(1, width)));
      const bodyBudget = Math.max(0, budget - 1);
      this.scroll = Math.min(this.scroll, Math.max(0, lines.length - bodyBudget));
      if (budget > 0) rows.push(`External content · ${d.state} · viewing ≠ completion · ${this.scroll + 1}/${lines.length}`);
      rows.push(...lines.slice(this.scroll, this.scroll + bodyBudget));
    } else {
      const errorRows = view.error && budget > 1 ? 1 : 0;
      const slots = budget - errorRows;
      const selected = Math.max(0, items.findIndex(d => d.message.id === this.selectedId));
      const start = Math.max(0, selected - Math.max(0, slots - 1));
      if (view.error && errorRows) rows.push(clean(view.error, width));
      rows.push(...items.slice(start, start + slots).map(d => queueRow(d, width, d.message.id === this.selectedId, view.labels, view)));
      if (!items.length && slots > 0) rows.push(this.history ? 'No saved deliveries in this subscription.' : 'No unfinished deliveries. h: saved history');
    }
    rows.push(footer);
    return rows.slice(0, height).map(row => fit(row, width, view.theme));
  }
}
