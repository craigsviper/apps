import { useState } from 'react';
import { useStore } from '../../store';
import type { SweepClient } from '../../types';

const EMPTY: Omit<SweepClient,'id'|'createdAt'> = {
  name:'', company:'', email:'', phone:'', address:'', notes:'', contractNumber:'', active:true
};

type ActiveFilter = 'all' | 'active' | 'inactive';

export default function SweepClients() {
  const { data, addSweepClient, updateSweepClient, deleteSweepClient } = useStore();
  const clients = data.sweepClients || [];
  const jobs    = data.sweepJobs    || [];

  const [form, setForm]           = useState<Omit<SweepClient,'id'|'createdAt'>>(EMPTY);
  const [editing, setEditing]     = useState<SweepClient | null>(null);
  const [showForm, setShowForm]   = useState(false);
  const [clientMsg, setClientMsg] = useState('');
  const [search, setSearch]       = useState('');
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('all');

  const counts = {
    all:      clients.length,
    active:   clients.filter(c => c.active !== false).length,
    inactive: clients.filter(c => c.active === false).length,
  };

  const filtered = clients.filter(c => {
    if (activeFilter === 'active'   && c.active === false) return false;
    if (activeFilter === 'inactive' && c.active !== false) return false;
    return (
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.company.toLowerCase().includes(search.toLowerCase())
    );
  });

  const openNew  = () => { setForm(EMPTY); setEditing(null); setShowForm(true); };
  const openEdit = (c: SweepClient) => { setForm(c); setEditing(c); setShowForm(true); };
  const closeForm = () => { setShowForm(false); setEditing(null); setClientMsg(''); };

  const save = () => {
    if (!form.name.trim()) return;
    const flash = (m: string) => { setClientMsg(m); setTimeout(() => setClientMsg(''), 3500); };
    if (editing) {
      updateSweepClient({ ...editing, ...form });
      flash('✅ Client saved — keep editing or close when done');
    } else {
      const created = addSweepClient(form);
      setEditing(created as SweepClient);
      flash('✅ Client created — keep editing or close when done');
    }
  };

  const jobCount = (id: string) => jobs.filter(j => j.clientId === id).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🏢 Sweep Clients</h1>
          <p className="text-sm text-gray-500 mt-1">Clients for road sweeping contracts</p>
        </div>
        <button onClick={openNew} className="btn-primary">+ New Client</button>
      </div>

      {/* Active / Inactive filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {([
          { key: 'all',      label: 'All Clients', icon: '🏢', active: 'bg-gray-800 text-white shadow',      pill: 'bg-gray-600 text-white' },
          { key: 'active',   label: 'Active',       icon: '✅', active: 'bg-emerald-600 text-white shadow',  pill: 'bg-emerald-400 text-white' },
          { key: 'inactive', label: 'Inactive',     icon: '⛔', active: 'bg-red-500 text-white shadow',      pill: 'bg-red-400 text-white' },
        ] as { key: ActiveFilter; label: string; icon: string; active: string; pill: string }[]).map(t => (
          <button key={t.key} onClick={() => setActiveFilter(t.key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
              activeFilter === t.key ? t.active : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}>
            <span>{t.icon}</span>
            <span>{t.label}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold min-w-[20px] text-center ${
              activeFilter === t.key ? t.pill : 'bg-gray-100 text-gray-600'
            }`}>{counts[t.key]}</span>
          </button>
        ))}
      </div>

      <input className="input-field" placeholder="Search clients…" value={search} onChange={e => setSearch(e.target.value)} />

      {showForm && (
        <div className="card p-5 border-2 border-orange-300 bg-orange-50">
          <h2 className="font-semibold text-gray-900 mb-4">{editing ? 'Edit Client' : 'New Client'}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            {([
              ['name',           'Name *'],
              ['company',        'Company'],
              ['email',          'Email'],
              ['phone',          'Phone'],
              ['address',        'Address'],
              ['contractNumber', 'Contract Number'],
            ] as [keyof typeof form, string][]).map(([k, l]) => (
              <div key={k}>
                <label className="block text-sm font-medium text-gray-700 mb-1">{l}</label>
                <input className="input-field" value={form[k] as string}
                  onChange={e => setForm({ ...form, [k]: e.target.value })} />
              </div>
            ))}
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <textarea className="input-field" rows={2} value={form.notes}
                onChange={e => setForm({ ...form, notes: e.target.value })} />
            </div>
            {/* Active / Inactive toggle */}
            <div className="sm:col-span-2 flex items-center justify-between p-3 bg-white rounded-lg border border-gray-200">
              <div>
                <span className="text-sm font-medium text-gray-700">Client Status</span>
                <p className="text-xs text-gray-400 mt-0.5">{form.active ? 'Active — visible in job assignments' : 'Inactive — hidden from job assignments'}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs font-semibold ${form.active ? 'text-emerald-600' : 'text-red-500'}`}>
                  {form.active ? 'Active' : 'Inactive'}
                </span>
                <button onClick={() => setForm({ ...form, active: !form.active })}
                  className={`relative w-12 h-6 rounded-full transition-colors ${form.active ? 'bg-emerald-500' : 'bg-red-400'}`}>
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${form.active ? 'translate-x-6' : 'translate-x-0.5'}`} />
                </button>
              </div>
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            {clientMsg && (
              <div className={`px-3 py-2 rounded-lg text-sm font-medium ${clientMsg.startsWith('✅') ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
                {clientMsg}
              </div>
            )}
            <button onClick={closeForm} className="btn-secondary">Close</button>
            <button onClick={save} className="btn-primary">{editing ? 'Save Changes' : 'Create Client'}</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map(c => (
          <div key={c.id} className="card p-4">
            <div className="flex items-start justify-between mb-2">
              <div>
                <h3 className="font-semibold text-gray-900">{c.name}</h3>
                {c.company && <p className="text-sm text-gray-500">{c.company}</p>}
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="text-xs px-2 py-0.5 bg-orange-100 text-orange-700 rounded-full font-medium">
                  {jobCount(c.id)} job{jobCount(c.id) !== 1 ? 's' : ''}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${c.active !== false ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                  {c.active !== false ? 'Active' : 'Inactive'}
                </span>
              </div>
            </div>
            {c.contractNumber && <p className="text-xs text-gray-500 mb-1">Contract: {c.contractNumber}</p>}
            {c.email   && <p className="text-xs text-gray-500">✉️ {c.email}</p>}
            {c.phone   && <p className="text-xs text-gray-500">📞 {c.phone}</p>}
            {c.address && <p className="text-xs text-gray-500 mt-1">📍 {c.address}</p>}
            <div className="flex gap-2 mt-3 pt-3 border-t border-gray-100">
              <button onClick={() => openEdit(c)} className="text-xs px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 flex-1">Edit</button>
              <button onClick={() => deleteSweepClient(c.id)} className="text-xs px-3 py-1.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100">Delete</button>
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="col-span-3 text-center py-12 text-gray-400">
            <div className="text-4xl mb-3">🏢</div>
            <p className="font-medium">{search ? 'No clients match your search' : activeFilter !== 'all' ? `No ${activeFilter} clients` : 'No sweep clients yet'}</p>
            {activeFilter !== 'all' && (
              <button onClick={() => setActiveFilter('all')} className="text-orange-600 text-sm font-medium mt-2 hover:underline">Show all clients</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
