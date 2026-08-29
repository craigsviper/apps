import { useState, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { Chart } from '../utils/chartSetup'; // bundled — works offline, never blocked by Firefox ETP
import { localDateKey, localMonthKey } from '../utils/date';

type Period = 'day' | 'month' | 'year';

function buildBuckets(period: Period) {
  const now = new Date(); const out: {key:string;label:string}[] = [];
  if (period === 'day') { for (let i=13;i>=0;i--) { const d=new Date(now); d.setDate(d.getDate()-i); out.push({key:localDateKey(d),label:d.toLocaleDateString('en-NZ',{day:'numeric',month:'short'})}); } }
  else if (period === 'month') { for (let i=11;i>=0;i--) { const d=new Date(now.getFullYear(),now.getMonth()-i,1); out.push({key:localMonthKey(d),label:d.toLocaleDateString('en-NZ',{month:'short',year:'2-digit'})}); } }
  else { for (let i=4;i>=0;i--) { const yr=now.getFullYear()-i; out.push({key:String(yr),label:String(yr)}); } }
  return out;
}

function jobInBucket(job: any, key: string, period: Period) {
  if (!job.date) return false;
  if (period==='day') return job.date.slice(0,10)===key;
  if (period==='month') return job.date.slice(0,7)===key;
  return job.date.slice(0,4)===key;
}
// Docket dates may be stored as DD-MM-YYYY (text input) or YYYY-MM-DD (date input)
function normaliseDocketDate(dateStr: string): string {
  if (!dateStr) return '';
  if (/^\d{4}-/.test(dateStr)) return dateStr.slice(0, 10); // already ISO
  const m = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  const m2 = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2,'0')}-${m2[1].padStart(2,'0')}`;
  return dateStr;
}
function docketInBucket(docketDate: string, key: string, period: Period): boolean {
  const iso = normaliseDocketDate(docketDate);
  if (!iso) return false;
  if (period==='day') return iso.slice(0,10)===key;
  if (period==='month') return iso.slice(0,7)===key;
  return iso.slice(0,4)===key;
}

function MiniChart({labels,data,color,type='bar'}:{labels:string[];data:number[];color:string;type?:'bar'|'line'}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<InstanceType<typeof Chart> | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) {
      chartRef.current.data.labels = [...labels];
      chartRef.current.data.datasets[0].data = [...data];
      chartRef.current.update('none');
      return;
    }
    chartRef.current = new Chart(ref.current, {
      type,
      data: { labels: [...labels], datasets: [{ data: [...data], backgroundColor: type==='bar' ? color+'bb' : color+'22', borderColor: color, borderWidth: 1.5, fill: type==='line', tension: 0.4, pointRadius: 2, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: { duration: 200 }, plugins: { legend: { display: false } }, scales: { x: { ticks: { font: { size: 9 }, maxRotation: 45 } }, y: { beginAtZero: true, ticks: { font: { size: 9 } } } } },
    } as any);
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, data]);
  return <canvas ref={ref}/>;
}

export default function Dashboard({ onNavigate }: { onNavigate: (page: string, inspId?: string) => void }) {
  const { data } = useStore();
  const [period, setPeriod] = useState<Period>('month');

  const inspections = data.inspections||[];
  const insDone = inspections.filter(i=>i.status==='completed'||i.status==='reviewed').length;
  const insProgress = inspections.filter(i=>i.status==='in_progress').length;
  const insCritical = inspections.filter(i=>i.condition==='Critical'||i.condition==='Poor').length;

  const allJobs = data.sweepJobs||[];
  const completedJobs = allJobs.filter(j=>j.status==='completed');
  const inProgressJobs = allJobs.filter(j=>j.status==='in_progress');
  const totalKm = completedJobs.reduce((s,j)=>s+(j.roads||[]).reduce((rs:number,r:any)=>rs+(r.metresSwept||0),0),0)/1000;
  const totalDamage = completedJobs.reduce((s,j)=>s+(j.roads||[]).reduce((rs:number,r:any)=>rs+(r.damagePins||[]).length,0),0);
  const totalFuelL = completedJobs.reduce((s,j)=>s+(j.fuelDockets||[]).reduce((fs:number,f:any)=>fs+(parseFloat(f.totalLitres)||0),0),0);
  const totalFuelCost = completedJobs.reduce((s,j)=>s+(j.fuelDockets||[]).reduce((fs:number,f:any)=>fs+(parseFloat(f.totalCost)||0),0),0);
  const totalExpenses = completedJobs.reduce((s,j)=>s+(j.extraExpenses||[]).reduce((es:number,e:any)=>es+(parseFloat(e.totalCost)||0),0),0);
  const totalTipKm = completedJobs.reduce((s,j)=>s+(j.tipRuns||[]).reduce((ts:number,run:any)=>ts+run.trips.reduce((tts:number,t:any)=>tts+Math.max(0,(parseFloat(t.returnHubKm)||0)-(parseFloat(t.departHubKm)||0)),0),0),0);

  const sweepAreas = data.sweepAreas||[];
  const sweepRoads = data.sweepRoads||[];
  const buckets = buildBuckets(period);
  const jobsPerBucket    = buckets.map(b=>completedJobs.filter(j=>jobInBucket(j,b.key,period)).length);
  const kmPerBucket      = buckets.map(b=>Math.round(completedJobs.filter(j=>jobInBucket(j,b.key,period)).reduce((s,j)=>s+(j.roads||[]).reduce((rs:number,r:any)=>rs+(r.metresSwept||0),0),0)/100)/10);
  // Fuel: bucket each docket by its OWN date, not the parent job date
  const allFuelDockets = completedJobs.flatMap((j:any) => (j.fuelDockets||[]).map((f:any) => ({...f, job: j})));
  const fuelPerBucket  = buckets.map(b => Math.round(allFuelDockets.filter(d => docketInBucket(d.date||'', b.key, period)).reduce((s:number,d:any) => s+(parseFloat(d.totalLitres)||0), 0)*10)/10);
  const expensePerBucket = buckets.map(b=>Math.round(completedJobs.filter(j=>jobInBucket(j,b.key,period)).reduce((s,j)=>s+(j.extraExpenses||[]).reduce((es:number,e:any)=>es+(parseFloat(e.totalCost)||0),0),0)*100)/100);
  const recentJobs = [...allJobs].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,5);

  const PBtn = () => (
    <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
      {(['day','month','year'] as Period[]).map(p=>(
        <button key={p} onClick={()=>setPeriod(p)} className={`px-3 py-1 text-xs font-semibold rounded-md transition capitalize ${period===p?'bg-white text-orange-600 shadow-sm':'text-gray-500 hover:text-gray-800'}`}>
          {p==='day'?'14 Days':p==='month'?'12 Months':'5 Years'}
        </button>
      ))}
    </div>
  );

  const statusColors: Record<string,string> = {planned:'bg-gray-100 text-gray-600',in_progress:'bg-amber-100 text-amber-700',completed:'bg-green-100 text-green-700'};

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-gray-500 text-sm mt-1">Sweeping & Inspection overview</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={()=>onNavigate('sweeping')} className="btn-primary">+ New Sweep Job</button>
          <button onClick={()=>onNavigate('sweep-reports')} className="btn-secondary">📊 Reports</button>
          <button onClick={()=>onNavigate('inspections')} className="btn-secondary">+ Inspection</button>
        </div>
      </div>

      {/* Sweep stats */}
      <div>
        <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">🧹 Road Sweeping — Completed Jobs</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          {[
            {label:'Total Jobs',   value:allJobs.length,              icon:'🧹',color:'text-orange-600',nav:'sweeping'},
            {label:'Completed',    value:completedJobs.length,        icon:'✅',color:'text-green-600', nav:'sweep-reports'},
            {label:'In Progress',  value:inProgressJobs.length,       icon:'🔄',color:'text-amber-600', nav:'sweeping'},
            {label:'Areas',        value:sweepAreas.length,           icon:'🗺️',color:'text-blue-600',  nav:'sweep-areas'},
            {label:'km Swept',     value:`${totalKm.toFixed(1)}km`,   icon:'📏',color:'text-indigo-600',nav:null},
            {label:'Damage Pins',  value:totalDamage,                 icon:'⚠️',color:'text-red-600',   nav:null},
            {label:'Fuel (L)',     value:totalFuelL.toFixed(1),       icon:'⛽',color:'text-cyan-600',  nav:'sweep-reports'},
            {label:'Tip km',       value:`${totalTipKm}km`,           icon:'🗑️',color:'text-gray-600',  nav:null},
          ].map(s=>(
            <div key={s.label} onClick={()=>s.nav&&onNavigate(s.nav)} className={`stat-card text-center ${s.nav?'cursor-pointer hover:shadow-md':''} transition`}>
              <div className="text-2xl mb-1">{s.icon}</div>
              <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-xs text-gray-500 leading-tight mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Cost cards */}
      <div className="grid grid-cols-3 gap-3">
        {[
          {label:'Fuel Cost (completed)',  value:`$${totalFuelCost.toFixed(2)}`,               icon:'⛽',color:'text-cyan-700', bg:'bg-cyan-50'},
          {label:'Extra Expenses',          value:`$${totalExpenses.toFixed(2)}`,               icon:'💲',color:'text-amber-700',bg:'bg-amber-50'},
          {label:'Total Costs',             value:`$${(totalFuelCost+totalExpenses).toFixed(2)}`,icon:'💰',color:'text-indigo-700',bg:'bg-indigo-50'},
        ].map(s=>(
          <div key={s.label} className={`rounded-xl p-4 ${s.bg} flex items-center gap-3`}>
            <span className="text-3xl">{s.icon}</span>
            <div><div className={`text-xl font-bold ${s.color}`}>{s.value}</div><div className="text-xs text-gray-600">{s.label}</div></div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide">📊 Trends — Completed Jobs</h2>
          <PBtn/>
        </div>
        {(
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              {title:'Jobs Completed',      data:jobsPerBucket,    color:'#f97316',type:'bar'  as const},
              {title:'km Swept',            data:kmPerBucket,      color:'#0891b2',type:'line' as const},
              {title:'Litres Fuelled',      data:fuelPerBucket,    color:'#059669',type:'bar'  as const},
              {title:'Extra Expenses ($)',   data:expensePerBucket, color:'#d97706',type:'bar'  as const},
            ].map(c=>(
              <div key={c.title} className="card p-3">
                <h3 className="text-xs font-semibold text-gray-600 mb-2">{c.title}</h3>
                <div style={{height:110}}><MiniChart labels={buckets.map(b=>b.label)} data={c.data} color={c.color} type={c.type}/></div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent jobs + Quick actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-900">Recent Sweep Jobs</h3>
            <button onClick={()=>onNavigate('sweeping')} className="text-xs text-indigo-600 hover:underline">View all →</button>
          </div>
          {recentJobs.length===0?(
            <p className="text-gray-400 text-sm text-center py-6">No sweep jobs yet.</p>
          ):(
            <div className="divide-y divide-gray-100">
              {recentJobs.map(j=>{
                const km=(j.roads||[]).reduce((s:number,r:any)=>s+(r.metresSwept||0),0)/1000;
                return (
                  <div key={j.id} className="flex items-center gap-3 py-2 hover:bg-gray-50 px-1 rounded transition">
                    <span className="text-lg">🧹</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{j.title||'Untitled'}</p>
                      <p className="text-xs text-gray-500">{j.jobNumber} · {j.date} · {km.toFixed(1)} km</p>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${statusColors[j.status]||'bg-gray-100 text-gray-600'}`}>
                      {j.status==='in_progress'?'In Progress':j.status==='completed'?'Done':'Planned'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card space-y-2">
          <h3 className="font-semibold text-gray-900 mb-2">Quick Actions</h3>
          {[
            {label:'🧹 + New Sweep Job',  action:()=>onNavigate('sweeping'),      cls:'btn-primary'},
            {label:'📊 Sweep Reports',    action:()=>onNavigate('sweep-reports'),  cls:'btn-secondary'},
            {label:'🗺️ Areas & Roads',    action:()=>onNavigate('sweep-areas'),   cls:'btn-secondary'},
            {label:'📋 + New Inspection', action:()=>onNavigate('inspections'),    cls:'btn-secondary'},
            {label:'📈 Insp. Reports',    action:()=>onNavigate('reports'),        cls:'btn-secondary'},
            {label:'⚙️ SW Categories',    action:()=>onNavigate('sweep-categories'),cls:'btn-secondary'},
          ].map(a=>(
            <button key={a.label} onClick={a.action} className={`${a.cls} w-full text-sm`}>{a.label}</button>
          ))}

          {sweepAreas.length>0&&(
            <div className="pt-3 border-t border-gray-100">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Areas</p>
              {sweepAreas.slice(0,5).map(a=>{
                const roads=sweepRoads.filter(r=>r.areaId===a.id);
                const aKm=completedJobs.reduce((s,j)=>s+(j.roads||[]).filter((jr:any)=>sweepRoads.find(r=>r.id===jr.roadId)?.areaId===a.id).reduce((rs:number,r:any)=>rs+(r.metresSwept||0),0),0)/1000;
                return (
                  <div key={a.id} className="flex items-center gap-2 py-1">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{backgroundColor:a.color}}/>
                    <span className="text-xs text-gray-700 flex-1 truncate">{a.name}</span>
                    <span className="text-xs text-gray-400 shrink-0">{roads.length}r · {aKm.toFixed(1)}km</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Inspection stats */}
      <div>
        <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">📋 Site & Road Inspections</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            {label:'Total',       value:inspections.length,icon:'📋',color:'text-indigo-600'},
            {label:'Completed',   value:insDone,           icon:'✅',color:'text-green-600'},
            {label:'In Progress', value:insProgress,       icon:'🔄',color:'text-amber-600'},
            {label:'Critical',    value:insCritical,       icon:'⚠️',color:'text-red-600'},
          ].map(s=>(
            <div key={s.label} onClick={()=>onNavigate('inspections')} className="stat-card cursor-pointer hover:shadow-md transition text-center">
              <div className="text-2xl mb-1">{s.icon}</div>
              <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-xs text-gray-500">{s.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
