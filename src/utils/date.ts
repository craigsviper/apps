// ── Local-date helpers ──────────────────────────────────────────────────────
// BUG FIX (Craig-reported, v72.7): date.toISOString().slice(0, 10) — used
// throughout the app to get "today" as YYYY-MM-DD — always returns the UTC
// date, not the browser's local date. For New Zealand (UTC+12/+13), local
// time is far enough ahead of UTC that for most of the working day the UTC
// date is still "yesterday". This made the debug log bucket entries under
// the wrong day (Craig saw "12-7-26" showing when it was actually the 13th
// in NZ), and the same pattern also set the wrong default date on new
// inspections, reports, and sweep-job records for most of the day.
//
// Use localDateKey()/localMonthKey() anywhere a YYYY-MM/YYYY-MM-DD bucket key
// or default-date value is needed — never `.toISOString().slice(...)` on a
// value that represents "today" for a person.
//
// formatDMY() is the display counterpart — Craig prefers DD/MM/YYYY for
// anything shown on screen (NZ convention). Storage/keys stay YYYY-MM-DD
// (or YYYY-MM) since that format sorts correctly as plain strings; only the
// on-screen label changes.

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "Today" (or the given Date) as YYYY-MM-DD in the browser's local timezone. */
export function localDateKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "This month" (or the given Date) as YYYY-MM in the browser's local timezone. */
export function localMonthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/**
 * Formats a YYYY-MM-DD key (or any Date-parseable string/Date) as DD/MM/YYYY
 * for display. Falls back to the raw input if it can't be parsed.
 */
export function formatDMY(input: string | Date): string {
  const d = input instanceof Date ? input : new Date(input.length === 10 ? input + 'T00:00:00' : input);
  if (Number.isNaN(d.getTime())) return typeof input === 'string' ? input : '';
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}
