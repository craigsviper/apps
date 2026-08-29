import { useState, useEffect, useCallback, useRef } from 'react';
import {
  listLogDates, getLogEntries, deleteLog, deleteAllLogs, downloadLog,
  getRetentionDays, setRetentionDays, type LogType,
} from '../logger';
import { formatDMY, localDateKey } from '../utils/date';

// BUG FIX / FEATURE (Craig-reported): the on-device Debug Log used to live
// under Health, buried below the sync-server status cards — Craig asked a
// while back to move it to its own sidebar entry, matching how the
// host-server dashboard has its own standalone "Debug" page (see
// host-server/sync-server/server.js's renderDebugPage / the screenshot he
// sent from the server dashboard). Moved wholesale out of Health.tsx.
//
// Also added the "Live — today's log" view: a small auto-refreshing
// terminal-style panel showing today's entries as they're written, instead
// of only the collapsed per-day list below it. Craig reported this existed
// at some point and then disappeared — grepping the history found no trace
// of it ever having existed client-side OR on the host-server dashboard.
// (v72.9 assumed the server dashboard already had it and was just missing
// here — that assumption was wrong; v73.0 added it there too, for real.)
// Built to match the host-server dashboard's version as closely as makes
// sense for an in-app page.

const LOG_TYPE_COLOR: Record<LogType, string> = {
  push: 'text-blue-600', pull: 'text-emerald-600', 'sync-error': 'text-red-600',
  add: 'text-emerald-700', update: 'text-amber-700', delete: 'text-gray-500',
  info: 'text-gray-500', error: 'text-red-700',
};

// Same semantic colors, lightened for the dark "Live" terminal-style panel.
const LOG_TYPE_COLOR_DARK: Record<LogType, string> = {
  push: 'text-blue-400', pull: 'text-emerald-400', 'sync-error': 'text-red-400',
  add: 'text-emerald-400', update: 'text-amber-400', delete: 'text-gray-400',
  info: 'text-gray-400', error: 'text-red-400',
};

const LIVE_POLL_MS = 3000;

export default function Debug() {
  const [logDates, setLogDates] = useState<string[]>([]);
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [retention, setRetention] = useState(getRetentionDays());
  const [liveEntries, setLiveEntries] = useState(() => getLogEntries(localDateKey()));
  const [liveOn, setLiveOn] = useState(true);
  const liveBoxRef = useRef<HTMLDivElement>(null);

  const refreshLogDates = useCallback(() => setLogDates(listLogDates()), []);
  const refreshLive = useCallback(() => setLiveEntries(getLogEntries(localDateKey())), []);

  useEffect(() => { refreshLogDates(); refreshLive(); }, [refreshLogDates, refreshLive]);

  // Auto-refresh the live panel while it's toggled on and the page is visible
  // — polling (not a push mechanism), same pattern as the server dashboard's
  // own auto-refresh, cheap since it's just a localStorage read.
  useEffect(() => {
    if (!liveOn) return;
    const id = setInterval(() => {
      refreshLive();
      refreshLogDates(); // today's entry count / a fresh day rolling over should reflect promptly too
    }, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [liveOn, refreshLive, refreshLogDates]);

  // Auto-scroll the live panel to the newest (bottom) entry when it grows —
  // matches the server dashboard's "Live" box behaviour.
  const prevCountRef = useRef(0);
  useEffect(() => {
    if (liveEntries.length > prevCountRef.current && liveBoxRef.current) {
      liveBoxRef.current.scrollTop = liveBoxRef.current.scrollHeight;
    }
    prevCountRef.current = liveEntries.length;
  }, [liveEntries]);

  const saveRetention = (days: number) => {
    setRetention(days);
    setRetentionDays(days);
    refreshLogDates();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🐞 Debug</h1>
          <p className="text-sm text-gray-500 mt-1">This device's activity log — every add/update/delete, sync push/pull, and error, captured locally. Nothing is sent anywhere.</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>Keep last</span>
          <input type="number" min={1} value={retention} onChange={e => saveRetention(parseInt(e.target.value, 10) || 1)}
            className="input-field w-16 text-sm" />
          <span>days</span>
          <button onClick={() => { if (confirm('Delete all local debug logs on this device?')) { deleteAllLogs(); refreshLogDates(); refreshLive(); } }}
            className="ml-2 text-red-500 hover:text-red-700">🗑️ Delete all</button>
        </div>
      </div>

      {/* ── Live — today's log ── */}
      <div className="card p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
          <h3 className="font-semibold text-gray-900">Live — today's log</h3>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
              <input type="checkbox" checked={liveOn} onChange={e => setLiveOn(e.target.checked)} />
              Auto-refresh
            </label>
            <button onClick={refreshLive} className="btn-secondary text-xs">🔄 Refresh</button>
          </div>
        </div>
        <div ref={liveBoxRef} className="bg-gray-900 rounded-lg p-3 max-h-72 overflow-y-auto space-y-0.5">
          {liveEntries.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-4">No entries yet today — they'll appear here live as the app does things.</p>
          ) : liveEntries.map((e, i) => (
            <div key={i} className="text-xs font-mono">
              <span className="text-gray-500">[{new Date(e.ts).toLocaleTimeString()}]</span>{' '}
              <span className={`font-semibold ${LOG_TYPE_COLOR_DARK[e.type]}`}>[{e.type}]</span>{' '}
              <span className="text-gray-300">{e.msg}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── All log files ── */}
      <div className="card p-4">
        <h3 className="font-semibold text-gray-900 mb-3">All log files</h3>
        {logDates.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4">No log entries yet — they'll appear here after your next push/pull.</p>
        ) : (
          <div className="space-y-2">
            {logDates.map(date => {
              const entries = getLogEntries(date);
              const isOpen = openDate === date;
              return (
                <div key={date} className="border border-gray-200 rounded-lg">
                  <div className="flex items-center justify-between p-2.5">
                    <button onClick={() => setOpenDate(isOpen ? null : date)} className="flex-1 flex items-center gap-2 text-left text-sm font-medium text-gray-800">
                      <span>{isOpen ? '▲' : '▼'}</span>
                      <span>{formatDMY(date)}</span>
                      <span className="text-xs text-gray-400">({entries.length} entries)</span>
                    </button>
                    <div className="flex gap-1">
                      <button onClick={() => downloadLog(date)} className="px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 rounded-lg">⬇️ Download</button>
                      <button onClick={() => { if (confirm(`Delete the log for ${formatDMY(date)}?`)) { deleteLog(date); refreshLogDates(); if (isOpen) setOpenDate(null); } }}
                        className="px-2 py-1 text-xs text-red-500 hover:bg-red-50 rounded-lg">🗑️</button>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="border-t border-gray-100 p-2.5 max-h-64 overflow-y-auto space-y-1 bg-gray-50">
                      {entries.length === 0 ? <p className="text-xs text-gray-400">(no entries)</p> : entries.slice().reverse().map((e, i) => (
                        <div key={i} className="text-xs font-mono">
                          <span className="text-gray-400">{new Date(e.ts).toLocaleTimeString()}</span>{' '}
                          <span className={`font-semibold ${LOG_TYPE_COLOR[e.type]}`}>[{e.type}]</span>{' '}
                          <span className="text-gray-700">{e.msg}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
