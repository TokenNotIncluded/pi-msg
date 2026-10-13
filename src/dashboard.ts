import { matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { clean, type Delivery } from './core.js';
import { displayHandle } from './labels.js';

export interface QueueView {
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
export function queueRow(d: Delivery, width: number, selected = false, labels?: ReadonlyMap<string, string>): string {
  const prefix = selected ? '› ' : '  ';
  if (width < 24) return truncateToWidth(`${prefix}${displayHandle(d.message.from, labels)} → ${displayHandle(d.message.to, labels)} · ${clean(d.metadata.summary)}`, width);
  const edge = Math.min(labels?.size ? 40 : 24, Math.floor((width - 8) / 4));
  const from = truncateToWidth(displayHandle(d.message.from, labels), edge);
  const to = truncateToWidth(displayHandle(d.message.to, labels), edge);
  const middleWidth = Math.max(1, width - 8 - visibleWidth(from) - visibleWidth(to));
  const summary = truncateToWidth(`${d.state}${d.deferred ? '/deferred' : ''} · ${clean(d.metadata.summary, 140)}`, middleWidth);
  const gap = Math.max(0, middleWidth - visibleWidth(summary));
  return truncateToWidth(`${prefix}${from} │ ${summary}${' '.repeat(gap)} │ ${to}`, width);
}
export function queueLines(deliveries: Delivery[], state: string, width: number, labels?: ReadonlyMap<string, string>): string[] {
  if (width < 1) return [];
  const items = queueItems(deliveries);
  const claimed = items.filter(d => d.state === 'claimed').length;
  const deferred = items.filter(d => d.deferred).length;
  return [`MSG ${clean(state, 24)} · ${items.length} unfinished · ${claimed} claimed${deferred ? ` · ${deferred} deferred` : ''} · /msg expand`, ...items.slice(0, 2).map(d => queueRow(d, width, false, labels))]
    .map(line => truncateToWidth(line, width));
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
    const title = `MSG · ${this.history ? 'saved history' : 'unfinished queue'} (${items.length}) · ${clean(view.channel, 64)} · ${clean(view.listener, 24)}`;
    const footer = this.expandedId ? '↑↓/jk scroll · Enter fold · Esc back' : '↑↓/jk · Enter open · h hist · Esc close';
    if (height === 1) return [truncateToWidth(title, width)];
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
      rows.push(...items.slice(start, start + slots).map(d => queueRow(d, width, d.message.id === this.selectedId, view.labels)));
      if (!items.length && slots > 0) rows.push(this.history ? 'No saved deliveries in this subscription.' : 'No unfinished deliveries. h: saved history');
    }
    rows.push(footer);
    return rows.slice(0, height).map(row => truncateToWidth(row, width));
  }
}
