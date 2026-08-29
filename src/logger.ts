// ── App activity/debug log ──────────────────────────────────────────────────
// Lightweight local log of what the app is doing, day by day, so Craig can
// see what did/didn't sync and download it when something needs debugging.
// Stored in localStorage (small text, not the main dataset — that's IndexedDB).
// One JSON array per calendar day; auto-pruned to a configurable retention.
//
// v71.9: this used to only log push/pull attempts (aggregate record-count
// deltas) — no live per-record detail. Now also captures, automatically for
// EVERY record in EVERY collection (no per-CRUD-function wiring needed):
//   - add    — a record appears that wasn't there before
//   - update — a record's content changed
//   - delete — a record that was there is now gone
// via a single diff effect in store.tsx that compares the data object before
// and after every change (see `prevDataRef` / the data-diff useEffect). This
// catches manual edits, imports/restores, AND sync merges alike — nothing to
// remember to instrument when a new CRUD function is added later. Uncaught
// runtime errors and unhandled promise rejections are also captured globally
// (see initGlobalErrorLogging in store.tsx) as type 'error'.

import { localDateKey } from './utils/date';

export type LogType = 'push' | 'pull' | 'sync-error' | 'add' | 'update' | 'delete' | 'info' | 'error';
export interface LogEntry { ts: string; type: LogType; msg: string; }

const KEY_PREFIX = 'rsw_log_';
const RETENTION_KEY = 'rsw_log_retention_days';
const DEFAULT_RETENTION = 4;
const MAX_ENTRIES_PER_DAY = 1000; // cap so one runaway day can't fill localStorage

const todayKey = (d = new Date()) => KEY_PREFIX + localDateKey(d);

export function getRetentionDays(): number {
  const v = parseInt(localStorage.getItem(RETENTION_KEY) || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_RETENTION;
}

export function setRetentionDays(days: number) {
  const n = Math.max(1, Math.round(days) || DEFAULT_RETENTION);
  localStorage.setItem(RETENTION_KEY, String(n));
  pruneOldLogs();
}

export function logEvent(type: LogType, msg: string) {
  try {
    const key = todayKey();
    const raw = localStorage.getItem(key);
    const entries: LogEntry[] = raw ? JSON.parse(raw) : [];
    entries.push({ ts: new Date().toISOString(), type, msg });
    if (entries.length > MAX_ENTRIES_PER_DAY) entries.splice(0, entries.length - MAX_ENTRIES_PER_DAY);
    localStorage.setItem(key, JSON.stringify(entries));
    pruneOldLogs();
  } catch { /* localStorage full/unavailable — logging is best-effort, never breaks the app */ }
}

export function listLogDates(): string[] {
  const dates: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(KEY_PREFIX)) dates.push(k.slice(KEY_PREFIX.length));
  }
  return dates.sort().reverse(); // newest first
}

export function getLogEntries(date: string): LogEntry[] {
  try { return JSON.parse(localStorage.getItem(KEY_PREFIX + date) || '[]'); } catch { return []; }
}

export function deleteLog(date: string) {
  localStorage.removeItem(KEY_PREFIX + date);
}

export function deleteAllLogs() {
  listLogDates().forEach(deleteLog);
}

// Deletes any day older than the retention window — called after every write
// so the log never needs a separate "cleanup job"; it just self-trims.
export function pruneOldLogs() {
  const keep = getRetentionDays();
  listLogDates().slice(keep).forEach(deleteLog);
}

export function downloadLog(date: string) {
  const entries = getLogEntries(date);
  const lines = entries.map(e => `[${e.ts}] [${e.type.toUpperCase()}] ${e.msg}`).join('\n')
    || '(no entries)';
  const blob = new Blob([lines], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rsw-app-log-${date}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
