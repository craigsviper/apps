import { useState } from 'react';
import { useStore } from '../store';
import type { Client } from '../types';

const emptyClient = (): Omit<Client, 'id' | 'createdAt'> => ({
  name: '', company: '', email: '', phone: '', address: '',
  contractNumber: '', loginEmail: '', loginPassword: '', notes: '', active: true,
});

type ActiveFilter = 'all' | 'active' | 'inactive';

export default function Clients() {
  const { data, addClient, updateClient, deleteClient } = useStore();
  const [showForm, setShowForm]           = useState(false);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [saveMsg, setSaveMsg]             = useState('');
  const [form, setForm]                   = useState(emptyClient());
  const [search, setSearch]               = useState('');
  const [detailClient, setDetailClient]   = useState<Client | null>(null);
  const [activeFilter, setActiveFilter]   = useState<ActiveFilter>('all');

  const openAdd = () => { setForm(emptyClient()); setEditingClient(null); setShowForm(true); };
  const openEdit = (c: Client) => {
    setEditingClient(c);
    setForm({ name: c.name, company: c.company, email: c.email, phone: c.phone,
              address: c.address, contractNumber: c.contractNumber || '',
              loginEmail: c.loginEmail || '',
              loginPassword: c.loginPassword || '', notes: c.notes, active: c.active });
    setShowForm(true);
  };
  const closeForm = () => { setShowForm(false); setEditingClient(null); setSaveMsg(''); };

  const handleSave = () => {
    if (!form.name.trim()) return;
    const flash = (m: string) => { setSaveMsg(m); setTimeout(() => setSaveMsg(''), 3500); };
    if (editingClient) {
      updateClient({ ...editingClient, ...form });
      flash('✅ Client saved — keep editing or close when done');
    } else {
      const created = addClient(form);
      setEditingClient(created as Client);
      flash('✅ Client created — keep editing or close when done');
    }
  };

  const counts = {
    all:      data.clients.length,
    active:   data.clients.filter(c => c.active).length,
    inactive: data.clients.filter(c => !c.active).length,
  };

  const filtered = data.clients.filter(c => {
    if (activeFilter === 'active'   && !c.active) return false;
    if (activeFilter === 'inactive' &&  c.active) return false;
    return (
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.company.toLowerCase().includes(search.toLowerCase()) ||
      c.email.toLowerCase().includes(search.toLowerCase())
    );
  });

  const clientReportCount     = (id: string) => data.reports.filter(r => r.clientId === id).length;
  const clientInspectionCount = (id: string) => data.inspections.filter(i => i.assignedClientId === id).length;

  /* ── Detail view ─────────────────────────────────────────────────────── */
  if (detailClient) {
    const inspections = data.inspections.filter(i => i.assignedClientId === detailClient.id);
    const reports     = data.reports.filter(r => r.clientId === detailClient.id);
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <button onClick={() => setDetailClient(null)} className="btn-secondary">← Back</button>
          <h1 className="text-2xl font-bold text-gray-900">{detailClient.name}</h1>
          <span className={`badge ${detailClient.active ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
            {detailClient.active ? 'Active' : 'Inactive'}
          </span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <div className="card">
              <h2 className="font-semibold text-gray-900 mb-4">Client Details</h2>
              <div className="grid grid-cols-2 gap-4 text-sm">
                {detailClient.company && <div><span className="text-gray-500">Company:</span><span className="font-medium ml-1">{detailClient.company}</span></div>}
                {detailClient.email   && <div><span className="text-gray-500">Email:</span><span className="font-medium ml-1">{detailClient.email}</span></div>}
                {detailClient.phone   && <div><span className="text-gray-500">Phone:</span><span className="font-medium ml-1">{detailClient.phone}</span></div>}
                {detailClient.address && <div className="col-span-2"><span className="text-gray-500">Address:</span><span className="font-medium ml-1">{detailClient.address}</span></div>}
                <div><span className="text-gray-500">Created:</span><span className="font-medium ml-1">{new Date(detailClient.createdAt).toLocaleDateString()}</span></div>
              </div>
              {detailClient.notes && (
                <div className="mt-4 p-3 bg-gray-50 rounded-lg">
                  <span className="text-xs font-medium text-gray-500 uppercase">Notes</span>
                  <p className="text-sm text-gray-700 mt-1">{detailClient.notes}</p>
                </div>
              )}
            </div>
            <div className="card">
              <h2 className="font-semibold text-gray-900 mb-4">Assigned Inspections ({inspections.length})</h2>
              {inspections.length === 0 ? (
                <p className="text-gray-400 text-sm text-center py-4">No inspections assigned to this client yet.</p>
              ) : (
                <div className="space-y-2">
                  {inspections.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(ins => (
                    <div key={ins.id} className="p-3 bg-gray-50 rounded-lg">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-medium text-sm text-gray-900">{ins.title}</span>
                          <div className="flex gap-3 text-xs text-gray-500 mt-0.5">
                            <span>{ins.type}</span><span>{ins.date}</span>
                            {ins.location && <span>📍 {ins.location}</span>}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          {ins.condition && (
                            <span className={`badge ${ins.condition === 'Excellent' || ins.condition === 'Good' ? 'bg-emerald-100 text-emerald-700' : ins.condition === 'Fair' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>{ins.condition}</span>
                          )}
                          <span className={`badge ${ins.status === 'completed' || ins.status === 'reviewed' ? 'bg-emerald-100 text-emerald-700' : ins.status === 'in_progress' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                            {ins.status.replace('_', ' ')}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="card">
              <h2 className="font-semibold text-gray-900 mb-4">Reports ({reports.length})</h2>
              {reports.length === 0 ? (
                <p className="text-gray-400 text-sm text-center py-4">No reports generated for this client yet.</p>
              ) : (
                <div className="space-y-2">
                  {reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(report => (
                    <div key={report.id} className="p-3 bg-gray-50 rounded-lg">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-medium text-sm text-gray-900">{report.title}</span>
                          <div className="flex gap-3 text-xs text-gray-500 mt-0.5">
                            <span>{report.date}</span><span>{report.inspectionIds.length} inspections</span><span>{report.detailLevel}</span>
                          </div>
                        </div>
                        <span className={`badge ${report.status === 'final' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>{report.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="space-y-4">
            <div className="card">
              <h3 className="font-semibold text-gray-900 mb-3">Actions</h3>
              <div className="space-y-2">
                <button onClick={() => openEdit(detailClient)} className="btn-primary w-full">✏️ Edit Client</button>
                <button onClick={() => { if (confirm(`Delete client "${detailClient.name}"?`)) { deleteClient(detailClient.id); setDetailClient(null); } }} className="btn-danger w-full">🗑️ Delete Client</button>
              </div>
            </div>
            <div className="card">
              <h3 className="font-semibold text-gray-900 mb-2">Summary</h3>
              <div className="space-y-2 text-sm text-gray-600">
                <p>🔍 {inspections.length} inspection(s)</p>
                <p>📊 {reports.length} report(s)</p>
                <p>✅ {inspections.filter(i => i.status === 'completed' || i.status === 'reviewed').length} completed</p>
                <p>⚠️ {inspections.filter(i => i.condition === 'Critical' || i.condition === 'Poor').length} critical/poor</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── List view ───────────────────────────────────────────────────────── */
  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🏢 Clients</h1>
          <p className="text-sm text-gray-500 mt-1">Manage clients and assign inspections & reports</p>
        </div>
        <button onClick={openAdd} className="btn-primary">+ New Client</button>
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

      {/* Inline form — same layout as Sweep Clients */}
      {showForm && (
        <div className="card p-5 border-2 border-teal-300 bg-teal-50">
          <h2 className="font-semibold text-gray-900 mb-4">{editingClient ? 'Edit Client' : 'New Client'}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            {([
              ['name',            'Name *'],
              ['company',         'Company'],
              ['email',           'Email'],
              ['phone',           'Phone'],
              ['address',         'Address'],
              ['contractNumber',  'Contract Number'],
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
            {saveMsg && (
              <div className={`px-3 py-2 rounded-lg text-sm font-medium ${saveMsg.startsWith('✅') ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
                {saveMsg}
              </div>
            )}
            <button onClick={closeForm} className="btn-secondary">Close</button>
            <button onClick={handleSave} className="btn-primary">{editingClient ? 'Save Changes' : 'Create Client'}</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map(client => (
          <div key={client.id} className="card p-4 cursor-pointer hover:shadow-md transition"
            onClick={() => setDetailClient(client)}>
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-teal-100 flex items-center justify-center text-teal-600 font-bold">
                  {client.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">{client.name}</h3>
                  {client.company && <p className="text-xs text-gray-500">{client.company}</p>}
                </div>
              </div>
              <span className={`badge ${client.active ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                {client.active ? 'Active' : 'Inactive'}
              </span>
            </div>
            {client.email   && <p className="text-xs text-gray-500">✉️ {client.email}</p>}
            {client.phone   && <p className="text-xs text-gray-500">📞 {client.phone}</p>}
            {client.address && <p className="text-xs text-gray-500 mt-1 truncate">📍 {client.address}</p>}
            <div className="flex gap-4 text-xs text-gray-500 mt-2 pt-2 border-t border-gray-100">
              <span>{clientInspectionCount(client.id)} inspections</span>
              <span>{clientReportCount(client.id)} reports</span>
            </div>
            <div className="flex gap-2 mt-3 pt-3 border-t border-gray-100" onClick={e => e.stopPropagation()}>
              <button onClick={() => openEdit(client)} className="text-xs px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 flex-1">Edit</button>
              <button onClick={() => { if (confirm(`Delete client "${client.name}"?`)) deleteClient(client.id); }} className="text-xs px-3 py-1.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100">Delete</button>
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="col-span-3 text-center py-12 text-gray-400">
            <div className="text-4xl mb-3">🏢</div>
            <p className="font-medium">{search ? 'No clients match your search' : activeFilter !== 'all' ? `No ${activeFilter} clients` : 'No clients yet'}</p>
            {activeFilter !== 'all' && (
              <button onClick={() => setActiveFilter('all')} className="text-teal-600 text-sm font-medium mt-2 hover:underline">Show all clients</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
