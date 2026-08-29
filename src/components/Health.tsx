import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { logEvent } from '../logger';

type ServerHealth = {
  status: string; version: string; schemaVersion: string;
  hasData: boolean; dataHash: string | null; dataFileSize: number;
  collections: Record<string, number>;
  disk: { total: number; used: number; available: number; percentage: number } | null;
  backup: { intervalMinutes: number; maxBackups: number; count: number; latest: { filename?: string } | string | null };
  drift: { unknownKeys: string[]; hasUnknownKeys: boolean };
  migration: { needsMigration: boolean };
  tombstones: { count: number; retentionDays: number; olderThanRetention: number; oldest: string | null; byCollection: Record<string, number> };
  timestamp: string;
};

const fmtBytes = (b: number) => b > 1e9 ? (b / 1e9).toFixed(1) + 'GB' : b > 1e6 ? (b / 1e6).toFixed(1) + 'MB' : (b / 1e3).toFixed(0) + 'KB';

export default function Health() {
  const { syncServerUrl, syncToken } = useStore();
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [healthErr, setHealthErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [pruneDays, setPruneDays] = useState(90);
  const [pruneMsg, setPruneMsg] = useState('');

  const loadHealth = useCallback(async () => {
    if (!syncServerUrl) { setHealthErr('No sync server configured — set one up in Backup & Sync first.'); return; }
    setLoading(true);
    setHealthErr('');
    try {
      const r = await fetch(`${syncServerUrl}/health`, { headers: { 'X-Sync-Token': syncToken }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const h: ServerHealth = await r.json();
      setHealth(h);
      setPruneDays(h.tombstones?.retentionDays ?? 90);
    } catch (e) {
      setHealthErr(e instanceof Error ? e.message : 'Failed to reach sync server');
    } finally {
      setLoading(false);
    }
  }, [syncServerUrl, syncToken]);

  useEffect(() => { loadHealth(); }, [loadHealth]);

  const pruneTombstones = async () => {
    if (!syncServerUrl) return;
    const days = Math.max(0, Math.round(pruneDays) || 0);
    const confirmMsg = days === 0
      ? 'Delete every tombstone entry, regardless of age? A backup will be created first. Built-in category lists can\'t be affected.'
      : `Delete tombstone entries older than ${days} day${days !== 1 ? 's' : ''}? A backup will be created first.`;
    if (!confirm(confirmMsg)) return;
    try {
      const r = await fetch(`${syncServerUrl}/tombstones/prune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Token': syncToken },
        body: JSON.stringify({ olderThanDays: days }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setPruneMsg(j.removedCount > 0
        ? `🧹 Pruned ${j.removedCount} old tombstone${j.removedCount !== 1 ? 's' : ''} (${j.before} → ${j.remainingTombstones})`
        : (j.message || 'No tombstones matched — nothing pruned.'));
      logEvent('info', `Pruned tombstones (older than ${days}d): ${j.removedCount ?? 0} removed`);
      loadHealth();
    } catch (e) {
      setPruneMsg('❌ ' + (e instanceof Error ? e.message : 'Prune failed'));
    } finally {
      setTimeout(() => setPruneMsg(''), 6000);
    }
  };

  const cols = health?.collections || {};

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">❤️ Health</h1>
          <p className="text-sm text-gray-500 mt-1">Sync server status, disk, and tombstones</p>
        </div>
        <button onClick={loadHealth} disabled={loading} className="btn-secondary text-xs">{loading ? '⏳ Loading…' : '🔄 Refresh'}</button>
      </div>

      {healthErr && <div className="card p-4 text-sm text-red-700 bg-red-50 border-red-200">❌ {healthErr}</div>}

      {health && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="card p-4">
            <h3 className="font-semibold text-gray-900 mb-2">Server Info</h3>
            <div className="text-sm space-y-1 text-gray-600">
              <div className="flex justify-between"><span>Status</span><span className="text-emerald-600 font-medium">Online</span></div>
              <div className="flex justify-between"><span>Schema Version</span><span>{health.schemaVersion || '?'}</span></div>
              <div className="flex justify-between"><span>Data File Size</span><span>{health.dataFileSize ? fmtBytes(health.dataFileSize) : '—'}</span></div>
              <div className="flex justify-between"><span>Updated</span><span className="text-xs">{new Date(health.timestamp).toLocaleString()}</span></div>
            </div>
          </div>

          {health.disk && (
            <div className="card p-4">
              <h3 className="font-semibold text-gray-900 mb-2">Disk Usage</h3>
              <div className="text-sm space-y-1 text-gray-600">
                <div className="flex justify-between"><span>Used</span><span>{fmtBytes(health.disk.used)} ({health.disk.percentage}%)</span></div>
                <div className="flex justify-between"><span>Available</span>
                  <span className={health.disk.percentage > 90 ? 'text-red-600' : health.disk.percentage > 70 ? 'text-amber-600' : 'text-emerald-600'}>
                    {fmtBytes(health.disk.available)}
                  </span>
                </div>
                <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden mt-2">
                  <div className={`h-full ${health.disk.percentage > 90 ? 'bg-red-500' : health.disk.percentage > 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    style={{ width: `${health.disk.percentage}%` }} />
                </div>
              </div>
            </div>
          )}

          <div className="card p-4">
            <h3 className="font-semibold text-gray-900 mb-2">Backup Config</h3>
            <div className="text-sm space-y-1 text-gray-600">
              <div className="flex justify-between"><span>Interval</span><span>{health.backup?.intervalMinutes ?? 60} min</span></div>
              <div className="flex justify-between"><span>Count</span><span>{health.backup?.count ?? 0}</span></div>
              <div className="flex justify-between"><span>Latest</span>
                <span className="text-xs font-mono">
                  {health.backup?.latest ? (typeof health.backup.latest === 'string' ? health.backup.latest : health.backup.latest.filename || '—').replace('rsw-server-backup-', '').replace('.json', '') : 'None'}
                </span>
              </div>
            </div>
          </div>

          <div className="card p-4">
            <h3 className="font-semibold text-gray-900 mb-2">Collections</h3>
            <div className="text-sm space-y-1 text-gray-600 max-h-40 overflow-y-auto">
              {Object.entries(cols).map(([k, v]) => (
                <div key={k} className="flex justify-between"><span>{k}</span><span>{v}</span></div>
              ))}
            </div>
          </div>

          <div className="card p-4">
            <h3 className="font-semibold text-gray-900 mb-2">Schema / Migration</h3>
            <div className="text-sm space-y-1 text-gray-600">
              <div className="flex justify-between"><span>Migration needed</span>
                <span className={health.migration?.needsMigration ? 'text-amber-600' : 'text-emerald-600'}>
                  {health.migration?.needsMigration ? 'Yes' : 'None ✓'}
                </span>
              </div>
              <div className="flex justify-between"><span>Drift keys</span><span className="text-xs">{(health.drift?.unknownKeys || []).join(', ') || 'None ✓'}</span></div>
            </div>
          </div>

          <div className="card p-4">
            <h3 className="font-semibold text-gray-900 mb-2">🪦 Tombstones</h3>
            <div className="text-sm space-y-1 text-gray-600">
              <div className="flex justify-between"><span>Total</span><span>{health.tombstones?.count ?? 0}</span></div>
              <div className="flex justify-between"><span>Retention</span><span>{health.tombstones?.retentionDays ?? 90} days</span></div>
              <div className="flex justify-between"><span>Older than retention</span>
                <span className={(health.tombstones?.olderThanRetention || 0) > 0 ? 'text-amber-600' : 'text-emerald-600'}>
                  {health.tombstones?.olderThanRetention ?? 0}
                </span>
              </div>
              <div className="flex justify-between"><span>Oldest</span><span className="text-xs">{health.tombstones?.oldest ? new Date(health.tombstones.oldest).toLocaleDateString() : '—'}</span></div>
              {health.tombstones?.byCollection && Object.keys(health.tombstones.byCollection).length > 0 && (
                <div className="text-xs pt-1 border-t border-gray-100 mt-1">
                  {Object.entries(health.tombstones.byCollection).map(([c, n]) => <div key={c} className="flex justify-between"><span>{c}</span><span>{n}</span></div>)}
                </div>
              )}
              <div className="flex items-center gap-2 pt-2">
                <input type="number" min={0} value={pruneDays} onChange={e => setPruneDays(parseInt(e.target.value, 10) || 0)}
                  className="input-field w-20 text-sm" title="Delete tombstones older than this many days. 0 = delete all." />
                <span className="text-xs text-gray-400">days old</span>
                <button onClick={pruneTombstones} className="ml-auto px-3 py-1.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium">🧹 Prune</button>
              </div>
              {pruneMsg && <p className="text-xs text-gray-600 pt-1">{pruneMsg}</p>}
              <p className="text-xs text-gray-400 pt-1">Deletes tombstones older than the number above (0 = delete every tombstone). A backup is taken first. Built-in category lists can't be deleted, so this is safe routine cleanup.</p>
            </div>
          </div>
        </div>
      )}

      {/* Debug Log now lives on its own page — see Debug in the sidebar (moved out of
          Health per Craig's request, so it's not buried under sync-server status cards). */}
      <div className="card p-4 text-sm text-gray-500 flex items-center gap-2">
        <span>🐞</span>
        <span>Looking for the device activity/debug log? It's moved to its own <strong className="text-gray-700">Debug</strong> page in the sidebar.</span>
      </div>
    </div>
  );
}
