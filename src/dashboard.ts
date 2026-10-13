import { matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { clean } from './core.js';
import { communicationPending, communicationStatus, type ConversationDelivery as Delivery } from './conversation.js';
import { displayHandle } from './labels.js';

/** Transport is actual subscription configuration, never inferred from a handle. */
export interface QueuePresentation { remote?: boolean; theme?: Pick<Theme, 'fg'>; tasks?: boolean; transportOnly?: boolean; }
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
    .filter(({ delivery }) => history || (!delivery.outbound && delivery.metadata.requires_action && delivery.state !== 'completed'))
    .sort((a, b) => {
      const time = (d: Delivery) => Date.parse(d.message.created_at ?? '') || Date.parse(d.receivedAt) || 0;
      return time(b.delivery) - time(a.delivery) || b.index - a.index;
    }).map(({ delivery }) => delivery);
}
/** Chat order follows durable local arrival, not an untrusted sender clock. */
export function conversationItems(deliveries: Delivery[]): Delivery[] {
  return deliveries.map((delivery, index) => ({ delivery, index }))
    .sort((a, b) => {
      const time = (d: Delivery) => Date.parse(d.receivedAt) || Date.parse(d.message.created_at ?? '') || 0;
      return time(a.delivery) - time(b.delivery) || a.index - b.index;
    }).map(({ delivery }) => delivery);
}
/** Sender left, recipient right, summary in the middle; routing labels are not identities. */
export function queueRow(d: Delivery, width: number, selected = false, labels?: ReadonlyMap<string, string>, presentation: QueuePresentation = {}): string {
  if (width < 1) return '';
  const prefix = `${selected ? '› ' : '  '}${transportMarker(presentation.remote)} `;
  // Sanitize external handles/labels before adding only trusted theme escapes.
  const sender = displayHandle(d.message.from, labels);
  const recipient = displayHandle(d.message.to, labels);
  if (visibleWidth(prefix + sender + ' → ' + recipient) > width) return fit(`${prefix}→ addresses need /msg details`, width, presentation.theme);
  const from = roleColor(sender, 'sender', presentation.theme);
  const to = roleColor(recipient, 'recipient', presentation.theme);
  const middleWidth = width - visibleWidth(prefix) - 6 - visibleWidth(from) - visibleWidth(to);
  if (middleWidth < 1) return fit(`${prefix}${from} → ${to}`, width, presentation.theme);
  const summary = truncateToWidth(`${presentation.tasks ? d.state + (d.deferred ? '/deferred' : '') + (d.notification ? '/' + d.notification.phase : '') : communicationStatus(d)} · ${clean(d.metadata.summary, 140)}`, middleWidth);
  const gap = Math.max(0, middleWidth - visibleWidth(summary));
  return fit(`${prefix}${from} → ${summary}${' '.repeat(gap)} │ ${to}`, width, presentation.theme);
}
/** Complete identities precede summary/labels; never present a partial mailbox. */
export function queueBlock(d: Delivery, width: number, selected = false, presentation: QueuePresentation = {}): string[] {
  const from = clean(stripVTControlCharacters(d.message.from), 512);
  const to = clean(stripVTControlCharacters(d.message.to), 512);
  const a = /^(@[A-Za-z0-9_-]+)(#[A-Za-z0-9_-]+)$/.exec(from);
  const b = /^(@[A-Za-z0-9_-]+)(#[A-Za-z0-9_-]+)$/.exec(to);
  const owner = a && b && a[1] === b[1] ? a[1] : undefined;
  const prefix = `${selected ? '›' : ' '} ${transportMarker(presentation.remote)}`;
  const lines = owner ? [`${prefix} owner ${owner}`, `from ${a![2]}`, `to ${b![2]}`] : [`${prefix} from ${from}`, `to ${to}`];
  const addresses = lines.flatMap((line, index) => wrapTextWithAnsi(roleColor(line, index === lines.length - 1 ? 'recipient' : 'sender', presentation.theme), Math.max(1, width)));
  return [...addresses, fit(presentation.tasks ? `${d.state}${d.deferred ? ' / deferred' : ''}${d.notification ? ' / ' + d.notification.phase : ''}` : communicationStatus(d), width, presentation.theme)];
}
function viewKey(d: Delivery): string { return `${d.outbound ? 'sent' : 'received'}:${d.message.id}`; }
function boundedRows(items: Delivery[], width: number, budget: number, selectedId: string | undefined, labels: ReadonlyMap<string, string> | undefined, presentation: QueuePresentation, total = items.length): string[] {
  if (budget < 1 || !items.length) return [];
  const chosen = items.find(d => viewKey(d) === selectedId) ?? items[0]!;
  const fits = (d: Delivery) => visibleWidth(`  ${transportMarker(presentation.remote)} ${displayHandle(d.message.from, labels)} → ${displayHandle(d.message.to, labels)}`) <= width;
  if (items.slice(0, budget).every(fits)) return items.slice(0, budget).map(d => queueRow(d, width, viewKey(d) === selectedId, labels, presentation));
  const block = queueBlock(chosen, width, viewKey(chosen) === selectedId, presentation);
  const others = total > 1 ? [`+${total - 1} other entries · /msg up/down`] : [];
  if (block.length + others.length <= budget) return [...block, ...others];
  return [fit(`${viewKey(chosen) === selectedId ? '› ' : ''}Addresses need details (${total} entries) · Ctrl+Alt+D /msg details`, width, presentation.theme)];
}
export function nextHint(d: Delivery): string {
  if (d.outbound) return d.transport === 'sent' ? 'Sent: saved transport receipt, not proof of reading or task completion.' : 'Send pending/failed: retry msg_send with the same ID, recipient and body. Not sent until a saved receipt.';
  if (d.state === 'completed') return 'Completed locally; viewing is not a server receipt.';
  if (d.state === 'claimed') return 'Claimed locally; complete/fail with the current token, or wait for lease expiry. Viewing is not completion.';
  if (d.deferred) return `Deferred; /msg resume ${d.message.id}, then /msg next ${d.message.id}. No work is authorized by this message.`;
  if (!d.metadata.requires_action) return 'Informational; no automatic wake. Read the fixed reference only if relevant to authorized work.';
  if (d.notification?.phase === 'queued') return 'Queued in Pi, not completed; wait for the safe follow-up boundary. After an interrupted restart use /msg next ID. No new authority.';
  if (d.notification?.phase === 'observed') return 'Notice entered Pi, not proof of processing. Use msg_read and claim only for authorized work; completion needs the lease token.';
  return `Pending${d.notification ? ' / ' + d.notification.phase : ''}; /msg next ${d.message.id} queues an external notice, not completion or new authority. Then msg_read and msg_delivery claim for authorized work.`;
}
export function queueLines(deliveries: Delivery[], state: string, width: number, labels?: ReadonlyMap<string, string>, presentation: QueuePresentation = {}, budget = 8): string[] {
  if (width < 1) return [];
  const items = (presentation.tasks ? queueItems(deliveries) : conversationItems(deliveries)).filter(d => !presentation.transportOnly || communicationPending(d));
  const claimed = items.filter(d => !d.outbound && d.state === 'claimed').length;
  const deferred = items.filter(d => !d.outbound && d.deferred).length;
  const tail = presentation.tasks ? items : items.slice(-Math.min(2, Math.max(0, budget - 1)));
  const rows = boundedRows(tail, width, Math.max(0, budget - 1), !presentation.tasks && tail.length ? viewKey(tail[tail.length - 1]!) : undefined, labels, presentation, items.length);
  const simple = rows.every(row => row.includes(' → '));
  const summary = presentation.tasks ? `${items.length} task pending · ${claimed} claimed${deferred ? ` · ${deferred} deferred` : ''}` : `${items.length} conversation records · ${items.filter(communicationPending).length} send pending`;
  return [`MSG ${transportMarker(presentation.remote)} ${clean(state, 24)} · ${summary} · /msg history /msg tasks`, ...(simple ? rows.slice(0, 2) : rows)]
    .map(line => fit(line, width, presentation.theme));
}

/** Unfocused widget: selection is driven only by explicit commands/modified shortcuts. */
export class InlineQueue {
  expanded = false;
  history = true;
  transportOnly = false;
  private selectedId?: string;
  private following = true;
  private known?: Set<string>;
  private newCount = 0;
  reset(): void { this.expanded = false; this.history = true; this.transportOnly = false; this.selectedId = undefined; this.following = true; this.known = undefined; this.newCount = 0; }
  private items(deliveries: Delivery[]): Delivery[] {
    const items = (this.history ? conversationItems(deliveries) : queueItems(deliveries)).filter(d => !this.transportOnly || communicationPending(d));
    if (this.history && !this.transportOnly) {
      const keys = new Set(items.map(viewKey));
      if (this.known && this.expanded && !this.following) this.newCount += [...keys].filter(key => !this.known!.has(key)).length;
      this.known = keys;
      if (!this.expanded) this.following = true;
      if (this.following) { this.selectedId = items.length ? viewKey(items[items.length - 1]!) : undefined; this.newCount = 0; }
    }
    if (!items.some(d => viewKey(d) === this.selectedId)) this.selectedId = items.length ? viewKey(items[this.history ? items.length - 1 : 0]!) : undefined;
    return items;
  }
  selected(deliveries: Delivery[]): Delivery | undefined {
    return this.items(deliveries).find(d => viewKey(d) === this.selectedId);
  }
  move(deliveries: Delivery[], delta: number): void {
    const items = this.items(deliveries);
    const index = Math.max(0, items.findIndex(d => viewKey(d) === this.selectedId));
    const next = items[Math.max(0, Math.min(items.length - 1, index + delta))];
    this.selectedId = next ? viewKey(next) : undefined;
    if (this.history && !this.transportOnly) { this.following = !!next && next === items[items.length - 1]; if (this.following) this.newCount = 0; }
  }
  render(view: QueueView, width: number, availableRows = 24): string[] {
    const presentation = { ...view, tasks: !this.history, transportOnly: this.transportOnly };
    const items = this.items(view.deliveries);
    if (!this.expanded) return queueLines(view.deliveries, view.listener, width, view.labels, presentation, Math.max(1, Math.min(8, Math.floor(availableRows / 3))))
      .slice(0, Math.max(1, Math.min(8, Math.floor(availableRows / 3))));
    if (width < 1) return [];
    // Reserve most terminal rows for the transcript/editor, even after expansion.
    const height = Math.max(1, Math.min(8, Math.floor(availableRows / 3)));
    const title = `MSG ${transportMarker(view.remote)} ${clean(view.listener, 24)} · ${this.history ? this.transportOnly ? 'send pending' : 'conversation records' : 'task queue'} (${items.length}) · ${this.history ? items.filter(communicationPending).length + ' send pending' : items.filter(d => d.state === 'claimed').length + ' claimed · ' + items.filter(d => d.deferred).length + ' deferred'}`;
    const heading = this.newCount ? `${title} · ${this.newCount} new · /msg down to latest` : title;
    const rows = [view.error ? `${heading} · ${clean(view.error, 120)}` : heading];
    if (height > 2) {
      const slots = height - 2;
      const index = Math.max(0, items.findIndex(d => viewKey(d) === this.selectedId));
      const start = Math.max(0, index - slots + 1);
      rows.push(...boundedRows(items.slice(start), width, slots, this.selectedId, view.labels, presentation, items.length));
      if (!items.length) rows.push('No entries in this view. /msg history');
    }
    if (height > 1) rows.push('Ctrl+Alt+↑↓ select · Ctrl+Alt+D details · /msg history /msg tasks · /msg fold');
    return rows.map(row => fit(row, width, view.theme));
  }
}

/** Compact temporary details overlay; viewing a saved body has no delivery side effects. */
export class Dashboard {
  private history = true;
  private selectedId?: string;
  private expandedId?: string;
  private scroll = 0;
  private closed = false;
  constructor(private view: () => QueueView, private redraw: () => void, private done: () => void,
    private height: () => number = () => 18, initial?: { id: string; history: boolean; outbound?: boolean }) {
    if (initial) { this.selectedId = `${initial.outbound ? 'sent' : 'received'}:${initial.id}`; this.expandedId = this.selectedId; this.history = initial.history; }
  }
  invalidate(): void {}
  dispose(): void { this.closed = true; }
  private items(): Delivery[] {
    const items = this.history ? conversationItems(this.view().deliveries) : queueItems(this.view().deliveries);
    if (!items.some(d => viewKey(d) === this.selectedId)) this.selectedId = items.length ? viewKey(items[this.history ? items.length - 1 : 0]!) : undefined;
    if (this.expandedId && !items.some(d => viewKey(d) === this.expandedId)) { this.expandedId = undefined; this.scroll = 0; }
    return items;
  }
  handleInput(input: string): void {
    if (this.closed) return;
    const items = this.items();
    const selected = Math.max(0, items.findIndex(d => viewKey(d) === this.selectedId));
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
      else this.selectedId = items[Math.max(0, selected - 1)] ? viewKey(items[Math.max(0, selected - 1)]!) : undefined;
    } else if (matchesKey(input, Key.down) || input === 'j') {
      if (this.expandedId) this.scroll++;
      else this.selectedId = items[Math.min(items.length - 1, selected + 1)] ? viewKey(items[Math.min(items.length - 1, selected + 1)]!) : undefined;
    }
    this.redraw();
  }
  render(width: number): string[] {
    if (this.closed || width < 1) return [];
    const height = Math.max(1, Math.min(18, Math.floor(this.height())));
    const items = this.items();
    const view = this.view();
    const title = `MSG ${transportMarker(view.remote)} · ${this.history ? 'conversation records' : 'task queue'} (${items.length}) · ${clean(view.channel, 64)} · ${clean(view.listener, 24)}`;
    const footer = this.expandedId ? '↑↓/jk scroll · Enter fold · Esc back' : '↑↓/jk · Enter open · h records/tasks · Esc close';
    if (height === 1) return [fit(title, width, view.theme)];
    const rows = [title];
    const budget = height - 2;
    if (this.expandedId) {
      const d = items.find(d => viewKey(d) === this.expandedId)!;
      // Preserve line breaks, but strip control/escape sequences from external content.
      const detail = [`From: ${clean(stripVTControlCharacters(d.message.from), 512)}`, `To: ${clean(stripVTControlCharacters(d.message.to), 512)}`, nextHint(d), '', ...d.message.message.slice(0, 65536).split(/\r?\n/)];
      const lines = detail.flatMap(line => wrapTextWithAnsi(clean(stripVTControlCharacters(line), 65536), Math.max(1, width)));
      const bodyBudget = Math.max(0, budget - 1);
      this.scroll = Math.min(this.scroll, Math.max(0, lines.length - bodyBudget));
      if (budget > 0) rows.push(`External content · ${communicationStatus(d)} · viewing ≠ completion · ${this.scroll + 1}/${lines.length}`);
      rows.push(...lines.slice(this.scroll, this.scroll + bodyBudget));
    } else {
      const errorRows = view.error && budget > 1 ? 1 : 0;
      const slots = budget - errorRows;
      const selected = Math.max(0, items.findIndex(d => viewKey(d) === this.selectedId));
      const start = Math.max(0, selected - Math.max(0, slots - 1));
      if (view.error && errorRows) rows.push(clean(view.error, width));
      rows.push(...boundedRows(items.slice(start), width, slots, this.selectedId, view.labels, { ...view, tasks: !this.history }, items.length));
      if (!items.length && slots > 0) rows.push(this.history ? 'No conversation records in this subscription.' : 'No pending tasks. h: conversation records');
    }
    rows.push(footer);
    return rows.slice(0, height).map(row => fit(row, width, view.theme));
  }
}
