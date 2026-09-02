import type { BrowserActionHistoryEntry, BrowserDiagnosticEntry } from "@openbot/contracts/ipc";

const DIAGNOSTIC_LIMIT = 100;
const ACTION_LIMIT = 100;

export class BrowserDiagnostics {
  readonly #diagnostics: BrowserDiagnosticEntry[] = [];
  readonly #actions: BrowserActionHistoryEntry[] = [];

  add(entry: Omit<BrowserDiagnosticEntry, "timestamp">): void {
    pushRing(this.#diagnostics, { ...entry, timestamp: new Date().toISOString() }, DIAGNOSTIC_LIMIT);
  }

  action(entry: Omit<BrowserActionHistoryEntry, "timestamp">): void {
    pushRing(this.#actions, { ...entry, timestamp: new Date().toISOString() }, ACTION_LIMIT);
  }

  snapshot(): { diagnostics: BrowserDiagnosticEntry[]; actions: BrowserActionHistoryEntry[] } {
    return { diagnostics: this.#diagnostics.slice(-50), actions: this.#actions.slice(-50) };
  }

  clearDiagnostics(): void {
    this.#diagnostics.length = 0;
  }

  get errorCount(): number {
    return this.#diagnostics.filter((entry) => entry.level === "error").length;
  }
}

function pushRing<T>(entries: T[], entry: T, limit: number): void {
  entries.push(entry);
  if (entries.length > limit) entries.splice(0, entries.length - limit);
}
