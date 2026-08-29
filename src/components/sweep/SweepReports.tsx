import { useState, useEffect, useRef, useMemo } from 'react';
import { useStore } from '../../store';
import type { SweepJob } from '../../types';
import { Chart } from '../../utils/chartSetup'; // bundled — works offline, never blocked by Firefox ETP
import { localDateKey, localMonthKey, formatDMY } from '../../utils/date';
import { getRoadRunEntries, hasSegmentRunData } from '../../utils/segmentStats';

const baseOpts = (yLabel?: string) => ({
  responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
  plugins: { legend: { display: false } },
  scales: { y: { beginAtZero: true, ticks: { stepSize: 1 }, title: yLabel ? { display: true, text: yLabel } : undefined } },
});
const pieOpts = {
  responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
  plugins: { legend: { position: 'bottom' as const, labels: { font: { size: 11 }, padding: 12 } } },
};

// ── Chart cards: update-in-place instead of destroy+recreate to fix stale data bug ──
function BarChartCard({ title, labels, data, color, yLabel, height = 200 }:
  { title: string; labels: string[]; data: number[]; color: string; yLabel?: string; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) {
      chartRef.current.data.labels = [...labels];
      chartRef.current.data.datasets[0].data = [...data];
      chartRef.current.update('none'); return;
    }
    chartRef.current = new Chart(ref.current, {
      type: 'bar',
      data: { labels: [...labels], datasets: [{ label: title, data: [...data], backgroundColor: color + 'cc', borderColor: color, borderWidth: 1.5, borderRadius: 6 }] },
      options: baseOpts(yLabel),
    });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, data]);
  return (<div className="card p-4"><h3 className="font-semibold text-gray-700 mb-3 text-sm">{title}</h3><div style={{ height }}><canvas ref={ref} /></div></div>);
}

function LineChartCard({ title, labels, data, color, yLabel, height = 200 }:
  { title: string; labels: string[]; data: number[]; color: string; yLabel?: string; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) {
      chartRef.current.data.labels = [...labels];
      chartRef.current.data.datasets[0].data = [...data];
      chartRef.current.update('none'); return;
    }
    chartRef.current = new Chart(ref.current, {
      type: 'line',
      data: { labels: [...labels], datasets: [{ label: title, data: [...data], borderColor: color, backgroundColor: color + '22', tension: 0.4, fill: true, pointRadius: 4, pointHoverRadius: 6 }] },
      options: baseOpts(yLabel),
    });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, data]);
  return (<div className="card p-4"><h3 className="font-semibold text-gray-700 mb-3 text-sm">{title}</h3><div style={{ height }}><canvas ref={ref} /></div></div>);
}

function PieChartCard({ title, labels, data, colors, type = 'pie', height = 240 }:
  { title: string; labels: string[]; data: number[]; colors: string[]; type?: 'pie'|'doughnut'; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) {
      chartRef.current.data.labels = [...labels];
      chartRef.current.data.datasets[0].data = [...data];
      chartRef.current.update('none'); return;
    }
    chartRef.current = new Chart(ref.current, {
      type,
      data: { labels: [...labels], datasets: [{ data: [...data], backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
      options: pieOpts,
    });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, data]);
  return (<div className="card p-4"><h3 className="font-semibold text-gray-700 mb-3 text-sm">{title}</h3><div style={{ height }}><canvas ref={ref} /></div></div>);
}

// ── CanvasChart: inline reactive chart (replaces static ref-callback pattern in Debris tab) ──
function CanvasChart({ labels, data, colors, type, yLabel, height = 220 }:{
  labels: string[]; data: number[]; colors: string[]; type: 'bar'|'pie'|'doughnut'; yLabel?: string; height?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) {
      chartRef.current.data.labels = [...labels];
      chartRef.current.data.datasets[0].data = [...data];
      chartRef.current.update('none'); return;
    }
    const isRound = type === 'pie' || type === 'doughnut';
    chartRef.current = new Chart(ref.current, {
      type,
      data: { labels: [...labels], datasets: [{ data: [...data], backgroundColor: isRound ? colors : colors.map(c => c + 'cc'), borderColor: isRound ? '#fff' : colors, borderWidth: isRound ? 2 : 1.5, borderRadius: isRound ? 0 : 6 }] },
      options: isRound ? pieOpts : { ...baseOpts(yLabel), maintainAspectRatio: false },
    });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, data]);
  return <div style={{ height }}><canvas ref={ref} /></div>;
}

type Period = 'day'|'month'|'year';
function buildTimeBuckets(period: Period): { key: string; label: string }[] {
  const now = new Date(); const buckets: { key: string; label: string }[] = [];
  if (period === 'day') {
    for (let i = 13; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); buckets.push({ key: localDateKey(d), label: d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' }) }); }
  } else if (period === 'month') {
    for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); buckets.push({ key: localMonthKey(d), label: d.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' }) }); }
  } else {
    for (let i = 4; i >= 0; i--) { const yr = now.getFullYear() - i; buckets.push({ key: String(yr), label: String(yr) }); }
  }
  return buckets;
}
function jobMatchesBucket(job: SweepJob, key: string, period: Period): boolean {
  if (!job.date) return false;
  if (period === 'day') return job.date.slice(0, 10) === key;
  if (period === 'month') return job.date.slice(0, 7) === key;
  return job.date.slice(0, 4) === key;
}
// Normalise any docket date to ISO YYYY-MM-DD for bucket comparison.
// Docket dates can be stored as DD-MM-YYYY (text input) or YYYY-MM-DD (date input).
function normaliseDocketDate(dateStr: string): string {
  if (!dateStr) return '';
  // Already ISO: starts with 4-digit year
  if (/^\d{4}-/.test(dateStr)) return dateStr.slice(0, 10);
  // DD-MM-YYYY or D-M-YYYY
  const m = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  // DD/MM/YYYY
  const m2 = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  return dateStr;
}
// Fuel dockets have their OWN date — bucket by docket date, not the parent job date
function docketMatchesBucket(docketDate: string, key: string, period: Period): boolean {
  if (!docketDate) return false;
  const iso = normaliseDocketDate(docketDate);
  if (!iso) return false;
  if (period === 'day')   return iso.slice(0, 10) === key;
  if (period === 'month') return iso.slice(0, 7)  === key;
  return iso.slice(0, 4) === key;
}
// Tip trips gained their own optional date field so a multi-day job's tip runs can be
// bucketed on the day they actually happened, not lumped under the job's overall date.
// Falls back to the parent job's date for older trips recorded before that field existed.
function tripMatchesBucket(tripDate: string | undefined, jobDate: string | undefined, key: string, period: Period): boolean {
  return docketMatchesBucket(tripDate || jobDate || '', key, period);
}
function PeriodToggle({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
      {(['day','month','year'] as Period[]).map(p => (
        <button key={p} onClick={() => onChange(p)}
          className={`px-3 py-1 text-xs font-semibold rounded-md transition capitalize ${value === p ? 'bg-white text-orange-600 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
          {p === 'day' ? '14 Days' : p === 'month' ? '12 Months' : '5 Years'}
        </button>
      ))}
    </div>
  );
}

const DEBRIS_PALETTE: Record<string, string> = { light: '#86efac', moderate: '#fde68a', heavy: '#fca5a5', 'very heavy': '#f87171', low: '#86efac', medium: '#fde68a', high: '#fca5a5', critical: '#ef4444' };
// debrisColor: first checks user-defined SW Category colours, then falls back to the keyword palette
function debrisColor(level: string, catColorMap?: Record<string, string>): string {
  // Exact match from SW Categories (user-defined colour)
  if (catColorMap) {
    if (catColorMap[level]) return catColorMap[level];
    // Case-insensitive exact match
    const lower = level.toLowerCase();
    const found = Object.entries(catColorMap).find(([k]) => k.toLowerCase() === lower);
    if (found) return found[1];
  }
  // Fallback: keyword palette
  const k = (level || '').toLowerCase();
  for (const [word, col] of Object.entries(DEBRIS_PALETTE)) { if (k.includes(word)) return col; }
  const FB = ['#a5b4fc','#67e8f9','#86efac','#fde68a','#fca5a5','#c084fc','#f9a8d4'];
  return FB[Math.abs([...k].reduce((a, c) => a + c.charCodeAt(0), 0)) % FB.length];
}
function formatDate(iso: string) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return iso; }
}

export default function SweepReports() {
  const { data } = useStore();
  const allJobs = data.sweepJobs || [];
  const areas   = data.sweepAreas || [];
  const sweepRoads = data.sweepRoads || [];
  const sweepClients = data.sweepClients || [];
  const sweepCategories = data.sweepCategories || [];

  // Build a colour map from the user-defined Debris Levels in SW Categories → {name: colour}
  const debrisCatColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    sweepCategories
      .filter(c => c.categoryType === 'debris_level')
      .flatMap(c => c.items || [])
      .forEach(item => { if (item.name && item.color) map[item.name] = item.color; });
    return map;
  }, [sweepCategories]);

  const [statusFilter, setStatusFilter] = useState<'completed' | 'in_progress' | 'all'>('completed');

  const jobs = useMemo(() => {
    if (statusFilter === 'completed')   return allJobs.filter(j => j.status === 'completed');
    if (statusFilter === 'in_progress') return allJobs.filter(j => j.status === 'in_progress');
    return allJobs;
  }, [allJobs, statusFilter]);

  const [activeTab, setActiveTab] = useState(0);
  const [period, setPeriod] = useState<Period>('month');
  const [debrisPeriod, setDebrisPeriod] = useState<Period>('month');
  const [fuelPeriod, setFuelPeriod] = useState<Period>('month');
  const [tipPeriod, setTipPeriod] = useState<Period>('month');
  const [selectedJob, setSelectedJob] = useState<string>('');
  const [selectedFuelJob, setSelectedFuelJob] = useState<string>('all');
  const [selectedTipJob, setSelectedTipJob] = useState<string>('all');

  useEffect(() => { if (!selectedJob && jobs.length > 0) setSelectedJob(jobs[0].id); }, [jobs, selectedJob]);

  const buckets = useMemo(() => buildTimeBuckets(period), [period]);
  const debrisBuckets = useMemo(() => buildTimeBuckets(debrisPeriod), [debrisPeriod]);
  const fuelBuckets = useMemo(() => buildTimeBuckets(fuelPeriod), [fuelPeriod]);

  const countPerBucket = useMemo(() => buckets.map(b => jobs.filter(j => jobMatchesBucket(j, b.key, period)).length), [buckets, jobs, period]);
  const kmPerBucket    = useMemo(() => buckets.map(b => jobs.filter(j => jobMatchesBucket(j, b.key, period)).reduce((sum, j) => sum + (j.roads || []).reduce((s, r) => s + (r.metresSwept || 0), 0), 0) / 1000), [buckets, jobs, period]);

  const areaLabels = areas.map(a => a.name);
  const distByArea = useMemo(() => areas.map(a => { let m = 0; jobs.forEach(j => (j.roads || []).forEach(jr => { const rd = sweepRoads.find(r => r.id === jr.roadId); if (rd?.areaId === a.id) m += jr.metresSwept || 0; })); return Math.round(m / 100) / 10; }), [areas, jobs, sweepRoads]);
  const jobsByArea = useMemo(() => areas.map(a => jobs.filter(j => (j.areaIds || []).includes(a.id) || (j.roads || []).some(jr => sweepRoads.find(r => r.id === jr.roadId)?.areaId === a.id)).length), [areas, jobs, sweepRoads]);

  const allDamagePins = useMemo(() => jobs.flatMap(j => (j.roads || []).flatMap(r => r.damagePins || [])), [jobs]);
  // v73.7: same fix as debris level below — a pin left with no damage type/
  // severity selected shouldn't count as a real "Unknown" data point in
  // these charts, only ones where a value was actually chosen.
  const damageTypeMap = useMemo(() => { const m: Record<string,number> = {}; allDamagePins.forEach(p => { const t = p.damageType || ''; if (!t) return; m[t] = (m[t] || 0) + 1; }); return m; }, [allDamagePins]);
  const damageLabels  = Object.keys(damageTypeMap);
  const damageCounts  = damageLabels.map(l => damageTypeMap[l]);
  const DAMAGE_COLORS = ['#dc2626','#d97706','#0891b2','#6b7280','#7c3aed','#059669','#be185d','#0d9488'];
  const severityMap   = useMemo(() => { const m: Record<string,number> = {}; allDamagePins.forEach(p => { const s = p.severity || ''; if (!s) return; m[s] = (m[s] || 0) + 1; }); return m; }, [allDamagePins]);
  const severityLabels = Object.keys(severityMap);
  const severityCounts = severityLabels.map(l => severityMap[l]);
  const SEV_COLORS     = ['#86efac','#fde68a','#fca5a5','#ef4444','#6b7280'];

  const allStatuses  = ['planned','in_progress','completed'] as const;
  const statusLabels = ['Planned','In Progress','Completed'];
  const statusCounts = useMemo(() => allStatuses.map(s => allJobs.filter(j => j.status === s).length), [allJobs]);
  const STATUS_COLORS = ['#6b7280','#f59e0b','#059669'];

  const debrisJobObj      = useMemo(() => jobs.find(j => j.id === selectedJob), [jobs, selectedJob]);
  const debrisRoadLabels  = useMemo(() => (debrisJobObj?.roads || []).map(r => { const rd = sweepRoads.find(sr => sr.id === r.roadId); return rd?.name || r.roadId.slice(0, 8); }), [debrisJobObj, sweepRoads]);
  const debrisRoadValues  = useMemo(() => (debrisJobObj?.roads || []).map(r => Math.round((r.metresSwept / 1000) * 100) / 100), [debrisJobObj]);
  // v73.7 BUG FIX: used to default a road with no debris level recorded to
  // the literal string 'Unknown', which then flowed into the road-card badge
  // AND both pie charts below as a real, countable value — so "nothing was
  // ever selected for this road" looked identical to "Unknown debris was
  // found here," and the charts filled up with an "Unknown" slice that
  // wasn't real recorded data. Empty string instead — the road card's own
  // `{level || '—'}` already handles that correctly (shows a dash), and both
  // pie charts below now filter empty values out before counting, so only
  // roads where a debris level was actually selected in the dropdown appear.
  //
  // v73.9 BUG FIX (Craig-reported): "segments data ... not included in all
  // graphs data in the sweep reports". A road drawn with multiple segments in
  // Areas & Roads keeps its real debris/coverage/pass data in
  // `road.segmentSettings[]`, NOT on `road.debrisLevel` — that field only
  // gets used for single-segment roads (see utils/segmentStats.ts for the
  // full explanation). Reading `r.debrisLevel` directly, as every one of
  // these aggregations did before, meant a multi-segment road silently
  // contributed NOTHING to every debris chart below, no matter how much
  // debris data was actually recorded per-segment. `getRoadRunEntries()` is
  // the fix: it returns one entry per segment for a segmented road (each
  // segment's own debris level counted separately, which is the more
  // accurate representation anyway — a 3-segment road can legitimately have
  // 3 different debris levels) or a single entry from the road-level fields
  // otherwise, so every chart now sees the real data regardless of how the
  // road was recorded.
  const debrisJobEntries  = useMemo(() =>
    (debrisJobObj?.roads || []).flatMap(r => getRoadRunEntries(r, sweepRoads.find(sr => sr.id === r.roadId))),
    [debrisJobObj, sweepRoads]);
  // Per-road-card display: one badge per road showing EVERY distinct segment
  // debris level found (not just the first), so a mixed-debris multi-segment
  // road doesn't misleadingly look uniform.
  const debrisRoadBadges  = useMemo(() => (debrisJobObj?.roads || []).map(r => {
    const road = sweepRoads.find(sr => sr.id === r.roadId);
    const entries = getRoadRunEntries(r, road);
    const levels = [...new Set(entries.map(e => e.debrisLevel).filter(Boolean))];
    return { levels, isSeg: hasSegmentRunData(r, road), segCount: entries.length };
  }), [debrisJobObj, sweepRoads]);
  const allDebrisLevelMap = useMemo(() => {
    const m: Record<string, number> = {};
    jobs.forEach(j => (j.roads || []).forEach(r => {
      const road = sweepRoads.find(sr => sr.id === r.roadId);
      getRoadRunEntries(r, road).forEach(e => { if (!e.debrisLevel) return; m[e.debrisLevel] = (m[e.debrisLevel] || 0) + 1; });
    }));
    return m;
  }, [jobs, sweepRoads]);
  const debrisAllLabels   = Object.keys(allDebrisLevelMap);
  const debrisAllCounts   = debrisAllLabels.map(l => allDebrisLevelMap[l]);
  const debrisAllColors   = useMemo(() => debrisAllLabels.map(l => debrisColor(l, debrisCatColorMap)), [debrisAllLabels, debrisCatColorMap]);
  const debrisTimeData    = useMemo(() => debrisBuckets.map(b =>
    jobs.filter(j => jobMatchesBucket(j, b.key, debrisPeriod))
        .reduce((sum, j) => sum + (j.roads || []).flatMap(r => getRoadRunEntries(r, sweepRoads.find(sr => sr.id === r.roadId))).filter(e => e.debrisLevel !== '').length, 0)
  ), [debrisBuckets, jobs, debrisPeriod, sweepRoads]);

  // ── Overview stats ──────────────────────────────────────────────────────
  const totalKm      = useMemo(() => jobs.reduce((s, j) => s + (j.roads || []).reduce((ss, r) => ss + (r.metresSwept || 0), 0), 0) / 1000, [jobs]);
  const totalRoads   = useMemo(() => jobs.reduce((s, j) => s + (j.roads || []).length, 0), [jobs]);
  const totalDamage  = useMemo(() => allDamagePins.length, [allDamagePins]);
  const avgKmPerJob  = jobs.length ? totalKm / jobs.length : 0;
  const avgRoadsPerJob = jobs.length ? totalRoads / jobs.length : 0;

  const mostActiveArea = useMemo(() => {
    if (!areas.length) return null;
    const idx = distByArea.indexOf(Math.max(...distByArea, 0.01));
    return distByArea[idx] > 0 ? { name: areaLabels[idx], km: distByArea[idx] } : null;
  }, [distByArea, areaLabels, areas]);

  const totalFuelLitres = useMemo(() => jobs.reduce((s, j) => s + (j.fuelDockets || []).reduce((ss, d) => ss + (parseFloat(d.totalLitres) || 0), 0), 0), [jobs]);
  const totalFuelCost   = useMemo(() => jobs.reduce((s, j) => s + (j.fuelDockets || []).reduce((ss, d) => ss + (parseFloat(d.totalCost) || 0), 0), 0), [jobs]);

  // ── Tip Runs ────────────────────────────────────────────────────────────
  const tipBuckets       = useMemo(() => buildTimeBuckets(tipPeriod), [tipPeriod]);
  // Flatten all trips across all jobs → [{trip, run, job, roadName}]
  const allTipTrips = useMemo(() => jobs.flatMap(j =>
    (j.tipRuns || []).flatMap(run => {
      const road = sweepRoads.find(r => r.id === run.roadId);
      return (run.trips || []).map(trip => ({ trip, run, job: j, roadName: road?.name || 'Unknown Road' }));
    })
  ), [jobs, sweepRoads]);
  const totalTripCount  = allTipTrips.length;
  // Calculate km per trip (returnHubKm - departHubKm) where available
  const tripKms = allTipTrips.map(t => {
    const dep = parseFloat(t.trip.departHubKm);
    const ret = parseFloat(t.trip.returnHubKm);
    return (!isNaN(dep) && !isNaN(ret) && ret > dep) ? ret - dep : null;
  });
  const totalTipKm = tripKms.reduce<number>((s, v) => s + (v ?? 0), 0);
  const tripsPerBucket = useMemo(() => tipBuckets.map(b =>
    jobs.flatMap(j => (j.tipRuns || []).flatMap(r => (r.trips || []).map(t => ({ t, j }))))
        .filter(({ t, j }) => tripMatchesBucket(t.date, j.date, b.key, tipPeriod))
        .length
  ), [tipBuckets, jobs, tipPeriod]);
  const kmPerTipBucket = useMemo(() => tipBuckets.map(b =>
    jobs.flatMap(j => (j.tipRuns || []).flatMap(r => (r.trips || []).map(t => ({ t, j }))))
        .filter(({ t, j }) => tripMatchesBucket(t.date, j.date, b.key, tipPeriod))
        .reduce((s, { t }) => {
          const dep = parseFloat(t.departHubKm), ret = parseFloat(t.returnHubKm);
          return s + ((!isNaN(dep) && !isNaN(ret) && ret > dep) ? ret - dep : 0);
        }, 0)
  ), [tipBuckets, jobs, tipPeriod]);
  const tipJobObj   = useMemo(() => selectedTipJob === 'all' ? null : jobs.find(j => j.id === selectedTipJob) || null, [jobs, selectedTipJob]);
  const jobsWithTips = useMemo(() => jobs.filter(j => (j.tipRuns || []).some(r => (r.trips || []).length > 0)), [jobs]);

  const recentJobs = useMemo(() => [...jobs].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 5), [jobs]);

  const now = new Date();
  const thisMonthKey  = localMonthKey(now);
  const lastMonthKey  = localMonthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const thisMonthJobs = useMemo(() => jobs.filter(j => (j.date || '').slice(0, 7) === thisMonthKey).length, [jobs, thisMonthKey]);
  const lastMonthJobs = useMemo(() => jobs.filter(j => (j.date || '').slice(0, 7) === lastMonthKey).length, [jobs, lastMonthKey]);
  const thisMonthKm   = useMemo(() => jobs.filter(j => (j.date || '').slice(0, 7) === thisMonthKey).reduce((s, j) => s + (j.roads || []).reduce((ss, r) => ss + (r.metresSwept || 0), 0), 0) / 1000, [jobs, thisMonthKey]);
  const lastMonthKm   = useMemo(() => jobs.filter(j => (j.date || '').slice(0, 7) === lastMonthKey).reduce((s, j) => s + (j.roads || []).reduce((ss, r) => ss + (r.metresSwept || 0), 0), 0) / 1000, [jobs, lastMonthKey]);
  const uniqueCrew    = useMemo(() => { const s = new Set<string>(); jobs.forEach(j => { if (j.crewMember) s.add(j.crewMember); }); return [...s]; }, [jobs]);

  // ── Fuel ───────────────────────────────────────────────────────────────
  const allDockets   = useMemo(() => jobs.flatMap(j => (j.fuelDockets || []).map(fd => ({ ...fd, job: j }))), [jobs]);
  const fuelJobObj   = useMemo(() => selectedFuelJob === 'all' ? null : jobs.find(j => j.id === selectedFuelJob) || null, [jobs, selectedFuelJob]);
  const scopedDockets = useMemo(() => fuelJobObj ? (fuelJobObj.fuelDockets || []) : allDockets, [fuelJobObj, allDockets]);
  const fuelTotalLitres = useMemo(() => scopedDockets.reduce((s, d) => s + (parseFloat(d.totalLitres) || 0), 0), [scopedDockets]);
  const fuelTotalCost   = useMemo(() => scopedDockets.reduce((s, d) => s + (parseFloat(d.totalCost) || 0), 0), [scopedDockets]);
  const fuelDisplayCostPerL = useMemo(() => { const vals = scopedDockets.map(d => d.costPerLitre?.trim()).filter((v): v is string => !!v && v !== ''); if (!vals.length) return '—'; const u = [...new Set(vals)]; return u.length === 1 ? `$${u[0]}` : 'varies'; }, [scopedDockets]);
  const fuelLitresPerBucket = useMemo(() => fuelBuckets.map(b => allDockets.filter(d => docketMatchesBucket(d.date || '', b.key, fuelPeriod)).reduce((s, d) => s + (parseFloat(d.totalLitres) || 0), 0)), [fuelBuckets, allDockets, fuelPeriod]);
  const fuelCostPerBucket   = useMemo(() => fuelBuckets.map(b => allDockets.filter(d => docketMatchesBucket(d.date || '', b.key, fuelPeriod)).reduce((s, d) => s + (parseFloat(d.totalCost) || 0), 0)), [fuelBuckets, allDockets, fuelPeriod]);
  const fuelJobDockets      = useMemo(() => fuelJobObj ? (fuelJobObj.fuelDockets || []) : [], [fuelJobObj]);

  const TABS = ['📈 Overview','🛣️ By Area','⚠️ Damage','📊 Status','🗑️ Debris Levels','⛽ Fuel','🚛 Tip Runs'];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">📊 Sweep Reports</h1>
          <p className="text-sm text-gray-500 mt-1">
            {statusFilter === 'completed' ? 'Showing completed jobs only' : statusFilter === 'in_progress' ? 'Showing in-progress jobs only' : 'Showing all jobs'}
            {' '}— {jobs.length} job{jobs.length !== 1 ? 's' : ''}
          </p>
        </div>
        {/* Status filter toggle */}
        <div className="flex gap-1 bg-gray-100 p-1 rounded-xl text-sm font-medium">
          {([
            { value: 'completed',   label: '✅ Completed',   color: 'text-green-600'  },
            { value: 'in_progress', label: '🔄 In Progress', color: 'text-amber-600'  },
            { value: 'all',         label: '📋 All Jobs',    color: 'text-indigo-600' },
          ] as const).map(opt => (
            <button key={opt.value} onClick={() => setStatusFilter(opt.value)}
              className={`px-3 py-1.5 rounded-lg transition whitespace-nowrap ${statusFilter === opt.value ? `bg-white shadow-sm ${opt.color}` : 'text-gray-500 hover:text-gray-800'}`}>
              {opt.label}
              <span className="ml-1 text-xs font-normal text-gray-400">
                ({opt.value === 'completed' ? allJobs.filter(j=>j.status==='completed').length
                  : opt.value === 'in_progress' ? allJobs.filter(j=>j.status==='in_progress').length
                  : allJobs.length})
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Top stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: statusFilter === 'completed' ? 'Completed Jobs' : statusFilter === 'in_progress' ? 'In-Progress Jobs' : 'Total Jobs', value: jobs.length, icon: statusFilter === 'in_progress' ? '🔄' : '✅', color: 'text-green-600' },
          { label: 'Total km Swept', value: `${totalKm.toFixed(1)} km`,   icon: '🛣️', color: 'text-blue-600'   },
          { label: 'Total Roads',    value: totalRoads,                   icon: '🔢', color: 'text-indigo-600' },
          { label: 'Damage Pins',    value: totalDamage,                  icon: '⚠️', color: 'text-red-600'    },
        ].map(s => (
          <div key={s.label} className="card p-4 text-center">
            <div className="text-2xl mb-1">{s.icon}</div>
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl overflow-x-auto">
        {TABS.map((t, i) => (
          <button key={i} onClick={() => setActiveTab(i)}
            className={`flex-1 min-w-max px-3 py-2 text-sm font-medium rounded-lg transition whitespace-nowrap ${activeTab === i ? 'bg-white text-orange-600 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}>{t}</button>
        ))}
      </div>

      {/* ── OVERVIEW ────────────────────────────────────────────────── */}
      {activeTab === 0 && (
          <div className="space-y-5">

            {/* Month-over-month strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Jobs This Month',  value: thisMonthJobs,                          sub: `${lastMonthJobs} last month`,                    icon: '📅', color: 'text-orange-600' },
                { label: 'km This Month',    value: `${thisMonthKm.toFixed(1)} km`,          sub: `${lastMonthKm.toFixed(1)} km last month`,        icon: '📏', color: 'text-blue-600'   },
                { label: 'Avg km / Job',     value: `${avgKmPerJob.toFixed(1)} km`,          sub: `${avgRoadsPerJob.toFixed(1)} roads / job avg`,   icon: '📐', color: 'text-indigo-600' },
                { label: 'Total Fuel Cost',  value: totalFuelLitres > 0 ? `$${totalFuelCost.toFixed(0)}` : '—', sub: totalFuelLitres > 0 ? `${totalFuelLitres.toFixed(0)} L total` : 'No fuel dockets', icon: '⛽', color: 'text-green-600' },
              ].map(s => (
                <div key={s.label} className="card p-4">
                  <div className="text-xl mb-1">{s.icon}</div>
                  <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
                  <div className="text-xs font-medium text-gray-600 mt-0.5">{s.label}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{s.sub}</div>
                </div>
              ))}
            </div>

            {/* Time charts */}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-sm text-gray-500 font-medium">
                {statusFilter === 'in_progress' ? 'In-progress' : statusFilter === 'completed' ? 'Completed' : 'All'} jobs over time
              </p>
              <PeriodToggle value={period} onChange={setPeriod} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <LineChartCard title={`Jobs per ${period === 'day' ? 'Day' : period === 'month' ? 'Month' : 'Year'}`} labels={buckets.map(b => b.label)} data={countPerBucket} color="#f97316" yLabel="Jobs" />
              <BarChartCard  title={`km Swept per ${period === 'day' ? 'Day' : period === 'month' ? 'Month' : 'Year'}`}       labels={buckets.map(b => b.label)} data={kmPerBucket.map(v => Math.round(v * 10) / 10)} color="#0891b2" yLabel="km" />
            </div>

            {/* Area summary + recent jobs */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {areas.length > 0 && (
                <div className="card p-4 space-y-3">
                  <h3 className="font-semibold text-gray-700 text-sm">🗺️ km Swept by Area</h3>
                  {areas.map((a, i) => {
                    const km = distByArea[i]; const maxKm = Math.max(...distByArea, 0.1); const pct = Math.round((km / maxKm) * 100);
                    return (
                      <div key={a.id}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="font-medium text-gray-700 truncate">{a.name}</span>
                          <span className="text-gray-500 shrink-0 ml-2">{km.toFixed(1)} km · {jobsByArea[i]} job{jobsByArea[i] !== 1 ? 's' : ''}</span>
                        </div>
                        <div className="w-full bg-gray-100 rounded-full h-1.5">
                          <div className="h-1.5 rounded-full bg-orange-400 transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="card p-4 space-y-2">
                <h3 className="font-semibold text-gray-700 text-sm">🕒 Recent Completed Jobs</h3>
                {recentJobs.length === 0 ? <p className="text-xs text-gray-400">No completed jobs yet.</p> : (
                  <div className="space-y-2">
                    {recentJobs.map(j => {
                      const km = (j.roads || []).reduce((s, r) => s + (r.metresSwept || 0), 0) / 1000;
                      const client = sweepClients.find(c => c.id === j.clientId);
                      const damage = (j.roads || []).flatMap(r => r.damagePins || []).length;
                      return (
                        <div key={j.id} className="flex items-start gap-2 p-2 bg-gray-50 rounded-lg">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {j.jobNumber && <span className="text-xs font-bold text-orange-600">#{j.jobNumber}</span>}
                              <span className="text-xs font-semibold text-gray-800 truncate">{j.title || 'Untitled'}</span>
                            </div>
                            <div className="flex gap-2 mt-0.5 text-xs text-gray-400 flex-wrap">
                              <span>📅 {formatDate(j.date)}</span>
                              <span>🛣️ {km.toFixed(1)} km</span>
                              {j.crewMember && <span>👷 {j.crewMember}</span>}
                              {client && <span>🏢 {client.name}</span>}
                              {damage > 0 && <span className="text-red-500">⚠️ {damage}</span>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Crew / damage / highlights row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {uniqueCrew.length > 0 && (
                <div className="card p-4 space-y-2">
                  <h3 className="font-semibold text-gray-700 text-sm">👷 Crew Activity</h3>
                  {uniqueCrew.map(crew => {
                    const cj = jobs.filter(j => j.crewMember === crew);
                    const ck = cj.reduce((s, j) => s + (j.roads || []).reduce((ss, r) => ss + (r.metresSwept || 0), 0), 0) / 1000;
                    return (
                      <div key={crew} className="flex justify-between items-center text-xs">
                        <span className="font-medium text-gray-700 truncate">{crew}</span>
                        <span className="text-gray-500 shrink-0 ml-2">{cj.length} jobs · {ck.toFixed(1)} km</span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="card p-4 space-y-2">
                <h3 className="font-semibold text-gray-700 text-sm">⚠️ Damage Summary</h3>
                {damageLabels.length === 0 ? <p className="text-xs text-gray-400">No damage pins recorded.</p> : (
                  <>
                    {damageLabels.slice(0, 5).map((label, i) => (
                      <div key={label} className="flex justify-between items-center text-xs">
                        <span className="font-medium text-gray-700 truncate">{label}</span>
                        <span className="text-red-600 font-bold shrink-0 ml-2">{damageCounts[i]}</span>
                      </div>
                    ))}
                    {totalDamage > 0 && <div className="pt-1 border-t border-gray-100 flex justify-between text-xs font-semibold"><span className="text-gray-600">Total</span><span className="text-red-600">{totalDamage}</span></div>}
                  </>
                )}
              </div>

              <div className="card p-4 space-y-2">
                <h3 className="font-semibold text-gray-700 text-sm">⭐ Highlights</h3>
                <div className="space-y-2 text-xs text-gray-600">
                  {mostActiveArea && <div className="flex justify-between"><span className="text-gray-500">Most active area</span><span className="font-semibold text-orange-600 truncate ml-2">{mostActiveArea.name}</span></div>}
                  {jobs.length > 0 && (() => {
                    const top = [...jobs].sort((a, b) => (b.roads || []).reduce((s, r) => s + (r.metresSwept || 0), 0) - (a.roads || []).reduce((s, r) => s + (r.metresSwept || 0), 0))[0];
                    return <div className="flex justify-between"><span className="text-gray-500">Longest job</span><span className="font-semibold text-blue-600">{((top.roads || []).reduce((s, r) => s + (r.metresSwept || 0), 0) / 1000).toFixed(1)} km</span></div>;
                  })()}
                  <div className="flex justify-between"><span className="text-gray-500">Avg km / job</span><span className="font-semibold">{avgKmPerJob.toFixed(1)} km</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Avg roads / job</span><span className="font-semibold">{avgRoadsPerJob.toFixed(1)}</span></div>
                  {uniqueCrew.length > 0 && <div className="flex justify-between"><span className="text-gray-500">Active crew</span><span className="font-semibold">{uniqueCrew.length} member{uniqueCrew.length !== 1 ? 's' : ''}</span></div>}
                  {totalFuelLitres > 0 && <div className="flex justify-between"><span className="text-gray-500">Total fuel</span><span className="font-semibold text-green-600">{totalFuelLitres.toFixed(0)} L · ${totalFuelCost.toFixed(0)}</span></div>}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── BY AREA ─────────────────────────────────────────────────── */}
        {activeTab === 1 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-sm text-gray-500 font-medium">Completed jobs by area</p>
              <PeriodToggle value={period} onChange={setPeriod} />
            </div>
            {areas.length === 0 ? <div className="card text-center py-8 text-gray-400">No areas configured yet.</div> : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <BarChartCard title="km Swept by Area" labels={areaLabels} data={distByArea} color="#059669" yLabel="km" />
                <BarChartCard title="Completed Jobs by Area" labels={areaLabels} data={jobsByArea} color="#0891b2" yLabel="Jobs" />
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <LineChartCard title={`Total km per ${period === 'day' ? 'Day' : period === 'month' ? 'Month' : 'Year'}`} labels={buckets.map(b => b.label)} data={kmPerBucket.map(v => Math.round(v * 10) / 10)} color="#059669" yLabel="km" />
              <LineChartCard title={`Completed Jobs per ${period === 'day' ? 'Day' : period === 'month' ? 'Month' : 'Year'}`} labels={buckets.map(b => b.label)} data={countPerBucket} color="#f97316" yLabel="Jobs" />
            </div>
          </div>
        )}

        {/* ── DAMAGE ──────────────────────────────────────────────────── */}
        {activeTab === 2 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-sm text-gray-500 font-medium">Damage from completed jobs only</p>
            </div>
            {allDamagePins.length === 0 ? <div className="card text-center py-8 text-gray-400">No damage pins recorded in completed jobs.</div> : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <BarChartCard title="Damage Pins by Type" labels={damageLabels.length ? damageLabels : ['No data']} data={damageCounts.length ? damageCounts : [0]} color="#dc2626" yLabel="Count" />
                <PieChartCard title="Damage Type Distribution" labels={damageLabels.length ? damageLabels : ['No data']} data={damageCounts.length ? damageCounts : [0]} colors={DAMAGE_COLORS} type="pie" />
                {severityLabels.length > 0 && <BarChartCard title="Damage by Severity" labels={severityLabels} data={severityCounts} color="#d97706" yLabel="Count" />}
                {severityLabels.length > 0 && <PieChartCard title="Severity Distribution" labels={severityLabels} data={severityCounts} colors={SEV_COLORS} type="doughnut" />}
              </div>
            )}
          </div>
        )}

        {/* ── STATUS ──────────────────────────────────────────────────── */}
        {activeTab === 3 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-sm text-gray-500 font-medium">Overall job status across all jobs</p>
              <PeriodToggle value={period} onChange={setPeriod} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <PieChartCard title="All Jobs by Status" labels={statusLabels} data={statusCounts} colors={STATUS_COLORS} type="doughnut" />
              <LineChartCard title={`Completed Jobs per ${period === 'day' ? 'Day' : period === 'month' ? 'Month' : 'Year'} (cumulative)`} labels={buckets.map(b => b.label)} data={countPerBucket.reduce((acc, v, i) => { acc.push((acc[i-1]||0)+v); return acc; }, [] as number[])} color="#059669" yLabel="Jobs" />
              <BarChartCard title={`Completed Jobs per ${period === 'day' ? 'Day' : period === 'month' ? 'Month' : 'Year'}`} labels={buckets.map(b => b.label)} data={countPerBucket} color="#059669" yLabel="Jobs" />
              <div className="card p-4 space-y-3">
                <h3 className="font-semibold text-gray-700 text-sm">Status Breakdown</h3>
                {allStatuses.map((s, i) => {
                  const count = statusCounts[i]; const pct = allJobs.length ? Math.round((count / allJobs.length) * 100) : 0;
                  return (
                    <div key={s}>
                      <div className="flex justify-between text-sm mb-1"><span className="text-gray-600">{statusLabels[i]}</span><span className="font-semibold">{count} <span className="text-gray-400 font-normal">({pct}%)</span></span></div>
                      <div className="w-full bg-gray-100 rounded-full h-2"><div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: STATUS_COLORS[i] }} /></div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── DEBRIS LEVELS ───────────────────────────────────────────── */}
        {activeTab === 4 && (
          <div className="space-y-4">
            <div className="card p-4 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h3 className="font-semibold text-gray-700">Debris Across All Completed Jobs</h3>
                <PeriodToggle value={debrisPeriod} onChange={setDebrisPeriod} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <BarChartCard title={`Roads with Debris per ${debrisPeriod === 'day' ? 'Day' : debrisPeriod === 'month' ? 'Month' : 'Year'}`} labels={debrisBuckets.map(b => b.label)} data={debrisTimeData} color="#f97316" yLabel="Roads" />
                {debrisAllLabels.length > 0 ? <PieChartCard title="Debris Level Distribution (all completed jobs)" labels={debrisAllLabels} data={debrisAllCounts} colors={debrisAllColors} type="doughnut" /> : <div className="card p-4 flex items-center justify-center text-gray-400 text-sm">No debris level data recorded yet</div>}
              </div>
            </div>
            <div className="card p-4 space-y-3">
              <h3 className="font-semibold text-gray-700">Debris Detail — Pick a Completed Job</h3>
              {jobs.length === 0 ? <div className="text-center py-6 text-gray-400 text-sm">No completed jobs yet.</div> : (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="text-sm font-medium text-gray-600 whitespace-nowrap">Select job:</label>
                    <select className="input-field flex-1 min-w-0 max-w-xs" value={selectedJob} onChange={e => setSelectedJob(e.target.value)}>
                      {jobs.map(j => <option key={j.id} value={j.id}>{j.jobNumber ? `#${j.jobNumber} — ` : ''}{j.title || 'Untitled'}{j.date ? ` (${j.date})` : ''}</option>)}
                    </select>
                  </div>
                  {debrisJobObj && (
                    <>
                      <div className="bg-gray-50 rounded-xl p-3 flex flex-wrap gap-4 text-sm">
                        <span><span className="text-gray-400">Date:</span> <strong>{debrisJobObj.date || '—'}</strong></span>
                        <span><span className="text-gray-400">Crew:</span> <strong>{debrisJobObj.crewMember || '—'}</strong></span>
                        <span><span className="text-gray-400">Roads:</span> <strong>{debrisJobObj.roads?.length || 0}</strong></span>
                        <span><span className="text-gray-400">km swept:</span> <strong>{((debrisJobObj.roads || []).reduce((s, r) => s + (r.metresSwept || 0), 0) / 1000).toFixed(1)} km</strong></span>
                      </div>
                      {debrisRoadLabels.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                          {debrisRoadLabels.map((name, i) => {
                            const road = debrisJobObj.roads[i];
                            const badge = debrisRoadBadges[i];
                            return (
                              <div key={i} className="flex items-center gap-3 p-3 rounded-xl border border-gray-200 bg-white">
                                <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: badge.levels.length ? debrisColor(badge.levels[0], debrisCatColorMap) : '#d1d5db' }} />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-semibold text-gray-800 truncate">{name}{badge.isSeg && <span className="ml-1.5 text-xs font-normal text-blue-500">({badge.segCount} segments)</span>}</p>
                                  <p className="text-xs text-gray-500">{(road.metresSwept / 1000).toFixed(2)} km</p>
                                </div>
                                {/* v73.9: one badge per distinct debris level found across this road's segments, instead of a single (often wrong/blank) value */}
                                <div className="flex flex-wrap gap-1 justify-end shrink-0 max-w-[45%]">
                                  {badge.levels.length === 0 && <span className="text-xs font-semibold px-2 py-1 rounded-full bg-gray-100 text-gray-500">—</span>}
                                  {badge.levels.map(l => (
                                    <span key={l} className="text-xs font-semibold px-2 py-1 rounded-full" style={{ backgroundColor: debrisColor(l, debrisCatColorMap) + '55', color: '#374151' }}>{l}</span>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {debrisRoadLabels.length > 0 && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="card p-4">
                            <h3 className="font-semibold text-gray-700 mb-3 text-sm">km Swept per Road</h3>
                            <CanvasChart labels={debrisRoadLabels} data={debrisRoadValues} colors={debrisRoadBadges.map(b => b.levels.length ? debrisColor(b.levels[0], debrisCatColorMap) : '#d1d5db')} type="bar" yLabel="km" height={220} />
                          </div>
                          {(() => {
                            // v73.9: was counting one entry per road (debrisRoadLevels) — now
                            // counts one entry per segment for multi-segment roads via debrisJobEntries.
                            const lm: Record<string,number> = {}; debrisJobEntries.forEach(e => { if (!e.debrisLevel) return; lm[e.debrisLevel] = (lm[e.debrisLevel]||0)+1; });
                            const ll = Object.keys(lm); const lc = ll.map(l => lm[l]); const lcol = ll.map(l => debrisColor(l, debrisCatColorMap));
                            return ll.length > 0 ? <PieChartCard title="Debris Level Distribution (this job)" labels={ll} data={lc} colors={lcol} type="doughnut" /> : null;
                          })()}
                        </div>
                      )}
                      {(debrisJobObj.roads?.length || 0) === 0 && <p className="text-center text-gray-400 text-sm py-4">This job has no roads recorded.</p>}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* ── FUEL ────────────────────────────────────────────────────── */}
        {activeTab === 5 && (
          <div className="space-y-4">
            <div className="card p-4 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h3 className="font-semibold text-gray-700">⛽ Fuel Usage Across All Completed Jobs</h3>
                <PeriodToggle value={fuelPeriod} onChange={setFuelPeriod} />
              </div>
              {allDockets.length === 0 ? (
                <div className="text-center py-6 text-gray-400 text-sm">No fuel dockets recorded yet. Add them in Sweep Jobs → Edit Job → ⛽ Fuel tab.</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      { label: 'Total Litres',  value: `${fuelTotalLitres.toFixed(3)} L`, icon: '💧', color: 'text-blue-600'   },
                      { label: 'Total Cost',    value: `$${fuelTotalCost.toFixed(2)}`,    icon: '💲', color: 'text-green-600'  },
                      { label: '$/Litre',       value: fuelDisplayCostPerL,               icon: '📊', color: 'text-indigo-600' },
                      { label: 'Dockets',       value: allDockets.length,                 icon: '🧾', color: 'text-orange-600' },
                    ].map(s => (<div key={s.label} className="bg-gray-50 rounded-xl p-3 text-center"><div className="text-xl mb-0.5">{s.icon}</div><div className={`text-lg font-bold ${s.color}`}>{s.value}</div><div className="text-xs text-gray-500 mt-0.5">{s.label}</div></div>))}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <BarChartCard title={`Litres per ${fuelPeriod === 'day' ? 'Day' : fuelPeriod === 'month' ? 'Month' : 'Year'}`} labels={fuelBuckets.map(b => b.label)} data={fuelLitresPerBucket.map(v => Math.round(v * 10) / 10)} color="#0891b2" yLabel="Litres" />
                    <BarChartCard title={`Fuel Cost per ${fuelPeriod === 'day' ? 'Day' : fuelPeriod === 'month' ? 'Month' : 'Year'} ($)`} labels={fuelBuckets.map(b => b.label)} data={fuelCostPerBucket.map(v => Math.round(v * 100) / 100)} color="#059669" yLabel="Cost ($)" />
                  </div>
                </>
              )}
            </div>

            <div className="card p-4 space-y-3">
              <h3 className="font-semibold text-gray-700">🧾 Fuel Details — Pick a Completed Job</h3>
              {jobs.length === 0 ? <div className="text-center py-6 text-gray-400 text-sm">No completed jobs yet.</div> : (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="text-sm font-medium text-gray-600 whitespace-nowrap">Select job:</label>
                    <select className="input-field flex-1 min-w-0 max-w-sm" value={selectedFuelJob} onChange={e => setSelectedFuelJob(e.target.value)}>
                      <option value="all">— All completed jobs —</option>
                      {jobs.map(j => <option key={j.id} value={j.id}>{j.jobNumber ? `#${j.jobNumber} — ` : ''}{j.title || 'Untitled'}{j.date ? ` (${j.date})` : ''}{(j.fuelDockets || []).length === 0 ? ' · no fuel' : ` · ${(j.fuelDockets || []).length} docket(s)`}</option>)}
                    </select>
                  </div>
                  {selectedFuelJob === 'all' && (
                    allDockets.length === 0 ? <p className="text-center text-gray-400 text-sm py-4">No fuel dockets on any completed job.</p> : (
                      <div className="overflow-x-auto rounded-xl border border-gray-200">
                        <table className="w-full text-xs text-left">
                          <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide"><tr><th className="px-3 py-2">Job</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Litres</th><th className="px-3 py-2">$/L</th><th className="px-3 py-2">Total</th><th className="px-3 py-2">Hub (km)</th><th className="px-3 py-2">Notes</th></tr></thead>
                          <tbody className="divide-y divide-gray-100">
                            {allDockets.map((d, i) => (
                              <tr key={d.id} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                                <td className="px-3 py-2 font-medium text-gray-800 whitespace-nowrap">{d.job.jobNumber ? `#${d.job.jobNumber}` : d.job.title || '—'}</td>
                                <td className="px-3 py-2 whitespace-nowrap">{d.date || '—'}</td>
                                <td className="px-3 py-2 text-blue-700 font-semibold">{d.totalLitres || '—'} L</td>
                                <td className="px-3 py-2">{d.costPerLitre ? `$${d.costPerLitre}` : '—'}</td>
                                <td className="px-3 py-2 text-green-700 font-semibold">{d.totalCost ? `$${d.totalCost}` : '—'}</td>
                                <td className="px-3 py-2">{d.hubKm || '—'}</td>
                                <td className="px-3 py-2 text-gray-500 truncate max-w-[120px]">{d.notes || ''}</td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot className="bg-indigo-50 font-semibold text-indigo-700"><tr><td className="px-3 py-2" colSpan={2}>Totals</td><td className="px-3 py-2">{fuelTotalLitres.toFixed(3)} L</td><td className="px-3 py-2">{fuelDisplayCostPerL}</td><td className="px-3 py-2">${fuelTotalCost.toFixed(2)}</td><td className="px-3 py-2" colSpan={2}>{allDockets.length} docket(s)</td></tr></tfoot>
                        </table>
                      </div>
                    )
                  )}
                  {selectedFuelJob !== 'all' && fuelJobObj && (
                    <>
                      <div className="bg-gray-50 rounded-xl p-3 flex flex-wrap gap-4 text-sm">
                        <span><span className="text-gray-400">Date:</span> <strong>{fuelJobObj.date || '—'}</strong></span>
                        {fuelJobObj.startDate && <span><span className="text-gray-400">Start:</span> <strong>{fuelJobObj.startDate}</strong></span>}
                        {fuelJobObj.finishDate && <span><span className="text-gray-400">Finish:</span> <strong>{fuelJobObj.finishDate}</strong></span>}
                        <span><span className="text-gray-400">Crew:</span> <strong>{fuelJobObj.crewMember || '—'}</strong></span>
                        <span><span className="text-gray-400">Equipment:</span> <strong>{fuelJobObj.equipment || '—'}</strong></span>
                        <span><span className="text-gray-400">Dockets:</span> <strong>{fuelJobDockets.length}</strong></span>
                      </div>
                      {fuelJobDockets.length === 0 ? <p className="text-center text-gray-400 text-sm py-4">No fuel dockets for this job.</p> : (
                        <>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            {[
                              { label: 'Litres', value: `${fuelJobDockets.reduce((s,d)=>s+(parseFloat(d.totalLitres)||0),0).toFixed(3)} L`, icon: '💧', color: 'text-blue-600' },
                              { label: 'Cost',   value: `$${fuelJobDockets.reduce((s,d)=>s+(parseFloat(d.totalCost)||0),0).toFixed(2)}`,     icon: '💲', color: 'text-green-600' },
                              { label: '$/L',    value: (() => { const v=fuelJobDockets.map(d=>d.costPerLitre?.trim()).filter((x): x is string=>!!x&&x!==''); if(!v.length) return '—'; const u=[...new Set(v)]; return u.length===1?`$${u[0]}`:'varies'; })(), icon: '📊', color: 'text-indigo-600' },
                              { label: 'Dockets', value: fuelJobDockets.length, icon: '🧾', color: 'text-orange-600' },
                            ].map(s => (<div key={s.label} className="bg-gray-50 rounded-xl p-3 text-center"><div className="text-xl mb-0.5">{s.icon}</div><div className={`text-lg font-bold ${s.color}`}>{s.value}</div><div className="text-xs text-gray-500 mt-0.5">{s.label}</div></div>))}
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {fuelJobDockets.map((fd, i) => (
                              <div key={fd.id} className="border border-gray-200 rounded-xl p-4 bg-white space-y-2">
                                <div className="flex items-center justify-between"><span className="text-sm font-semibold text-gray-700">🧾 Docket #{i+1}</span><span className="text-xs text-gray-400">{fd.date || '—'}</span></div>
                                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600">
                                  <div>💧 <strong className="text-blue-700">{fd.totalLitres || '—'} L</strong></div>
                                  <div>⏲ Hub: <strong>{fd.hubKm || '—'} km</strong></div>
                                  <div>💲 <strong className="text-green-700">${fd.totalCost || '—'}</strong></div>
                                  <div>$/L: <strong>{fd.costPerLitre ? `$${fd.costPerLitre}` : '—'}</strong></div>
                                </div>
                                {fd.notes && <p className="text-xs text-gray-400 italic">{fd.notes}</p>}
                                {fd.photo && <img src={fd.photo} alt="Fuel docket" className="w-full h-28 object-cover rounded-lg border border-gray-200 mt-1" />}
                              </div>
                            ))}
                          </div>
                          {fuelJobDockets.length > 1 && <BarChartCard title="Litres per Docket" labels={fuelJobDockets.map((d,i)=>d.date||`Docket ${i+1}`)} data={fuelJobDockets.map(d=>parseFloat(d.totalLitres)||0)} color="#0891b2" yLabel="Litres" height={180} />}
                        </>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}

      {/* ── TIP RUNS ──────────────────────────────────────────────── */}
      {activeTab === 6 && (
        <div className="space-y-4">
          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h3 className="font-semibold text-gray-700">🚛 Tip Run Overview</h3>
              <PeriodToggle value={tipPeriod} onChange={setTipPeriod} />
            </div>
            {totalTripCount === 0 ? (
              <div className="text-center py-6 text-gray-400 text-sm">No tip runs recorded yet. Add them in Sweep Jobs → Edit Job → 💡 Tip tab.</div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: 'Total Trips',   value: totalTripCount,                                                      icon: '🚛', color: 'text-orange-600' },
                    { label: 'Total km',      value: totalTipKm > 0 ? `${totalTipKm.toFixed(1)} km` : '—',               icon: '📏', color: 'text-blue-600'   },
                    { label: 'Avg km/Trip',   value: totalTripCount > 0 && totalTipKm > 0 ? `${(totalTipKm / totalTripCount).toFixed(1)} km` : '—', icon: '📐', color: 'text-indigo-600' },
                    { label: 'Jobs with Tips',value: jobsWithTips.length,                                                  icon: '📋', color: 'text-green-600'  },
                  ].map(s => (<div key={s.label} className="bg-gray-50 rounded-xl p-3 text-center"><div className="text-xl mb-0.5">{s.icon}</div><div className={`text-lg font-bold ${s.color}`}>{s.value}</div><div className="text-xs text-gray-500 mt-0.5">{s.label}</div></div>))}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <BarChartCard title={`Trips per ${tipPeriod === 'day' ? 'Day' : tipPeriod === 'month' ? 'Month' : 'Year'}`} labels={tipBuckets.map(b => b.label)} data={tripsPerBucket} color="#f97316" yLabel="Trips" />
                  <BarChartCard title={`km per ${tipPeriod === 'day' ? 'Day' : tipPeriod === 'month' ? 'Month' : 'Year'}`} labels={tipBuckets.map(b => b.label)} data={kmPerTipBucket.map(v => Math.round(v * 10) / 10)} color="#0891b2" yLabel="km" />
                </div>
              </>
            )}
          </div>

          <div className="card p-4 space-y-3">
            <h3 className="font-semibold text-gray-700">🧾 Tip Run Details — Pick a Job</h3>
            {jobsWithTips.length === 0 ? (
              <div className="text-center py-6 text-gray-400 text-sm">No jobs with tip runs yet.</div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="text-sm font-medium text-gray-600 whitespace-nowrap">Select job:</label>
                  <select className="input-field flex-1 min-w-0 max-w-sm" value={selectedTipJob} onChange={e => setSelectedTipJob(e.target.value)}>
                    <option value="all">— All jobs —</option>
                    {jobsWithTips.map(j => {
                      const tripCount = (j.tipRuns || []).reduce((s, r) => s + (r.trips || []).length, 0);
                      return <option key={j.id} value={j.id}>{j.jobNumber ? `#${j.jobNumber} — ` : ''}{j.title || 'Untitled'}{j.date ? ` (${j.date})` : ''} · {tripCount} trip{tripCount !== 1 ? 's' : ''}</option>;
                    })}
                  </select>
                </div>

                {/* All jobs summary table */}
                {selectedTipJob === 'all' && (
                  <div className="overflow-x-auto rounded-xl border border-gray-200">
                    <table className="w-full text-xs text-left">
                      <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide">
                        <tr><th className="px-3 py-2">Job</th><th className="px-3 py-2">Road</th><th className="px-3 py-2">Depart</th><th className="px-3 py-2">Depart km</th><th className="px-3 py-2">Return</th><th className="px-3 py-2">Return km</th><th className="px-3 py-2">Trip km</th></tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {allTipTrips.map(({ trip, job: j, roadName }, i) => {
                          const dep = parseFloat(trip.departHubKm), ret = parseFloat(trip.returnHubKm);
                          const tripKm = (!isNaN(dep) && !isNaN(ret) && ret > dep) ? (ret - dep).toFixed(1) : '—';
                          return (
                            <tr key={trip.id} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                              <td className="px-3 py-2 font-medium text-gray-800 whitespace-nowrap">{j.jobNumber ? `#${j.jobNumber}` : j.title || '—'}</td>
                              <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{roadName}</td>
                              <td className="px-3 py-2 text-indigo-700 font-semibold">{trip.departTime || '—'}</td>
                              <td className="px-3 py-2">{trip.departHubKm ? `${trip.departHubKm} km` : '—'}</td>
                              <td className="px-3 py-2 text-orange-700 font-semibold">{trip.returnTime || '—'}</td>
                              <td className="px-3 py-2">{trip.returnHubKm ? `${trip.returnHubKm} km` : '—'}</td>
                              <td className="px-3 py-2 text-green-700 font-semibold">{tripKm !== '—' ? `${tripKm} km` : '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot className="bg-indigo-50 font-semibold text-indigo-700">
                        <tr>
                          <td className="px-3 py-2" colSpan={6}>{totalTripCount} trip{totalTripCount !== 1 ? 's' : ''}</td>
                          <td className="px-3 py-2">{totalTipKm > 0 ? `${totalTipKm.toFixed(1)} km` : '—'}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}

                {/* Single job detail */}
                {selectedTipJob !== 'all' && tipJobObj && (() => {
                  const jobRuns = tipJobObj.tipRuns || [];
                  const jobTrips = jobRuns.flatMap(r => {
                    const road = sweepRoads.find(rd => rd.id === r.roadId);
                    return (r.trips || []).map(t => ({ trip: t, roadName: road?.name || 'Unknown Road' }));
                  });
                  const jobTripKm = jobTrips.reduce((s, { trip: t }) => {
                    const dep = parseFloat(t.departHubKm), ret = parseFloat(t.returnHubKm);
                    return s + ((!isNaN(dep) && !isNaN(ret) && ret > dep) ? ret - dep : 0);
                  }, 0);
                  return (
                    <>
                      <div className="bg-gray-50 rounded-xl p-3 flex flex-wrap gap-4 text-sm">
                        <span><span className="text-gray-400">Date:</span> <strong>{tipJobObj.date || '—'}</strong></span>
                        <span><span className="text-gray-400">Crew:</span> <strong>{tipJobObj.crewMember || '—'}</strong></span>
                        <span><span className="text-gray-400">Trips:</span> <strong>{jobTrips.length}</strong></span>
                        {jobTripKm > 0 && <span><span className="text-gray-400">Total km:</span> <strong>{jobTripKm.toFixed(1)} km</strong></span>}
                      </div>
                      {jobTrips.length === 0 ? (
                        <p className="text-center text-gray-400 text-sm py-4">No tip trips for this job.</p>
                      ) : (
                        <>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            {[
                              { label: 'Trips',      value: jobTrips.length,                                          icon: '🚛', color: 'text-orange-600' },
                              { label: 'Total km',   value: jobTripKm > 0 ? `${jobTripKm.toFixed(1)} km` : '—',      icon: '📏', color: 'text-blue-600'   },
                              { label: 'Avg km',     value: jobTrips.length > 0 && jobTripKm > 0 ? `${(jobTripKm / jobTrips.length).toFixed(1)} km` : '—', icon: '📐', color: 'text-indigo-600' },
                              { label: 'Roads',      value: new Set(jobRuns.map(r => r.roadId)).size,                 icon: '🛣️', color: 'text-green-600'  },
                            ].map(s => (<div key={s.label} className="bg-gray-50 rounded-xl p-3 text-center"><div className="text-xl mb-0.5">{s.icon}</div><div className={`text-lg font-bold ${s.color}`}>{s.value}</div><div className="text-xs text-gray-500 mt-0.5">{s.label}</div></div>))}
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {jobTrips.map(({ trip, roadName }, i) => {
                              const dep = parseFloat(trip.departHubKm), ret = parseFloat(trip.returnHubKm);
                              const tkm = (!isNaN(dep) && !isNaN(ret) && ret > dep) ? (ret - dep).toFixed(1) : null;
                              return (
                                <div key={trip.id} className="border border-gray-200 rounded-xl p-4 bg-white space-y-2">
                                  <div className="flex items-center justify-between">
                                    <span className="text-sm font-semibold text-gray-700">🚛 Trip #{i + 1}</span>
                                    <span className="text-xs text-gray-400 truncate max-w-[120px]">{roadName}</span>
                                  </div>
                                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600">
                                    <div>🕐 Depart: <strong className="text-indigo-700">{trip.departTime || '—'}</strong></div>
                                    <div>📍 Hub out: <strong>{trip.departHubKm ? `${trip.departHubKm} km` : '—'}</strong></div>
                                    <div>🕐 Return: <strong className="text-orange-700">{trip.returnTime || '—'}</strong></div>
                                    <div>📍 Hub in: <strong>{trip.returnHubKm ? `${trip.returnHubKm} km` : '—'}</strong></div>
                                  </div>
                                  {tkm && <p className="text-xs font-semibold text-green-700">📏 {tkm} km round trip</p>}
                                </div>
                              );
                            })}
                          </div>
                          {(() => {
                            // Group this job's trips by date (falling back to the job's own date for
                            // older trips recorded before TipTrip gained its own date field). Only worth
                            // a chart once trips actually span more than one day — this is the case
                            // Craig asked for: a multi-day job's tip runs broken down per day.
                            const byDate = new Map<string, number>();
                            jobTrips.forEach(({ trip: t }) => {
                              const raw = t.date || tipJobObj.date || '';
                              const iso = normaliseDocketDate(raw);
                              const key = iso || '(no date)';
                              byDate.set(key, (byDate.get(key) || 0) + 1);
                            });
                            const distinctDates = [...byDate.keys()].filter(k => k !== '(no date)');
                            if (distinctDates.length < 2) return null;
                            const sorted = [...byDate.entries()].sort(([a], [b]) => a === '(no date)' ? 1 : b === '(no date)' ? -1 : a.localeCompare(b));
                            return (
                              <BarChartCard
                                title="Trips per Day"
                                labels={sorted.map(([date]) => date === '(no date)' ? 'No date' : formatDMY(date))}
                                data={sorted.map(([, count]) => count)}
                                color="#0891b2" yLabel="Trips" height={180}
                              />
                            );
                          })()}
                          {jobTrips.length > 1 && (
                            <BarChartCard
                              title="km per Trip"
                              labels={jobTrips.map((_, i) => `Trip ${i + 1}`)}
                              data={jobTrips.map(({ trip: t }) => { const d = parseFloat(t.departHubKm), r = parseFloat(t.returnHubKm); return (!isNaN(d) && !isNaN(r) && r > d) ? Math.round((r - d) * 10) / 10 : 0; })}
                              color="#f97316" yLabel="km" height={180}
                            />
                          )}
                        </>
                      )}
                    </>
                  );
                })()}
              </>
            )}
          </div>
        </div>
      )}

      {jobs.length === 0 && (
        <div className="text-center py-8 text-gray-400 card">
          <div className="text-4xl mb-3">📊</div>
          <p className="font-medium text-gray-600">No {statusFilter === 'in_progress' ? 'in-progress' : statusFilter === 'completed' ? 'completed' : ''} sweep jobs yet</p>
          <p className="text-sm mt-1">Charts and analytics will appear once jobs match the selected filter.</p>
          {allJobs.length > 0 && <p className="text-xs mt-3 text-amber-600 bg-amber-50 inline-block px-3 py-1 rounded-full">{allJobs.length} job{allJobs.length !== 1 ? 's' : ''} exist — try a different filter above</p>}
        </div>
      )}
    </div>
  );
}
