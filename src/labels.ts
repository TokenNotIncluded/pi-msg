import { clean } from './core.js';

/** Explicit, session-local display metadata. Never changes a routing key or identity. */
export class HandleLabels {
  private labels = new Map<string, string>();
  get entries(): ReadonlyMap<string, string> { return this.labels; }
  bind(handle: string, text: string): void {
    this.checkHandle(handle);
    if (!text.trim() || text.length > 64 || clean(text, 64) !== text) throw new Error('Display label must be 1–64 characters without terminal controls');
    if (!this.labels.has(handle) && this.labels.size >= 128) throw new Error('Display label limit reached (128 per Pi session); unlabel unused handles first');
    this.labels.set(handle, text.trim());
  }
  unbind(handle: string): void { this.checkHandle(handle); this.labels.delete(handle); }
  clear(): void { this.labels.clear(); }
  private checkHandle(handle: string): void {
    if (!/^@[A-Za-z0-9][A-Za-z0-9_-]{0,63}#[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(handle)) throw new Error('Use an exact MSG handle: @owner#mailbox; no name matching');
  }
}
export function displayHandle(handle: string, labels?: ReadonlyMap<string, string>): string {
  const text = labels?.get(handle);
  // The stable handle stays first, including when a narrow terminal truncates the label.
  return text ? `${clean(handle, 132)} (${clean(text, 64)})` : clean(handle, 132);
}
