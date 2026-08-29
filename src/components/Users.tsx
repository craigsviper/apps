import { useState } from 'react';
import { useStore } from '../store';
import type { User } from '../types';

// BUG FIX / FEATURE (Craig-requested, v73.11): "remove email from the add new
// user as it not going to be used anymore" — logins are now a plain username
// derived from the person's name (this is exactly how the default admin
// account's login became "admin" — the name "Admin", slugified), rather than
// a separate field the admin has to type. Still stored in the `email`
// property internally (see the User type comment) to avoid a wider rename.
function slugifyUsername(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'user';
}
function uniqueUsername(name: string, existing: User[]): string {
  const base = slugifyUsername(name);
  if (!existing.some(u => u.email === base)) return base;
  let n = 2;
  while (existing.some(u => u.email === `${base}${n}`)) n++;
  return `${base}${n}`;
}

export default function Users() {
  const { data, currentUser, addUser, updateUser, deleteUser, resetPassword } = useStore();
  const [showAdd, setShowAdd] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [showReset, setShowReset] = useState<string | null>(null);
  const [newPw, setNewPw] = useState('');
  const [sendInvite, setSendInvite] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [form, setForm] = useState({ name: '', email: '', role: 'user' as 'admin' | 'user' | 'driver', password: '', active: true });

  const isAdmin = currentUser?.role === 'admin';
  if (!isAdmin) return <div className="card text-center py-12"><p className="text-gray-500">You need admin privileges to manage users.</p></div>;

  const [addSaveMsg, setAddSaveMsg] = useState('');

  const handleAdd = () => {
    if (!form.name) { setAddSaveMsg('⚠️ Name is required'); setTimeout(() => setAddSaveMsg(''), 3000); return; }
    if (!sendInvite && !form.password) { setAddSaveMsg('⚠️ Set a password or enable auto-generate'); setTimeout(() => setAddSaveMsg(''), 3000); return; }
    const username = uniqueUsername(form.name, data.users);
    addUser({ name: form.name, email: username, role: form.role, password: sendInvite ? Math.random().toString(36).slice(2, 10) : form.password, active: true });
    const msg = `✅ User "${form.name}" created — login: ${username}${sendInvite ? ' (auto-generated password)' : ''}`;
    setAddSaveMsg(msg);
    setTimeout(() => setAddSaveMsg(''), 8000); // longer than usual — this is the only place the login username is shown
    // Clear form fields so user can add another without closing modal
    setForm({ name: '', email: '', role: 'user', password: '', active: true });
    // Do NOT close modal — user closes manually with Cancel/×
  };

  const [editSaveMsg, setEditSaveMsg] = useState('');

  const handleUpdate = () => {
    if (!editUser) return;
    updateUser(editUser);
    setEditSaveMsg('✅ User updated');
    setTimeout(() => setEditSaveMsg(''), 3000);
    // Do NOT close modal — user closes manually with Cancel/×
  };

  const handleReset = (userId: string) => {
    if (!newPw) return;
    resetPassword(userId, newPw);
    setNewPw('');
    setShowReset(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
          <p className="text-gray-500 text-sm mt-1">Manage team members and their access levels</p>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary">+ Add User</button>
      </div>

      {saveMsg && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-800">{saveMsg}</div>
      )}

      {/* Add User Modal */}
      {showAdd && (
        <div className="modal-overlay" onClick={() => { setShowAdd(false); setAddSaveMsg(''); }}>
          <div className="modal-content max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">Add New User</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name *</label>
                <input className="input-field" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="John Smith" />
                <p className="text-xs text-gray-400 mt-1">Login username is generated from the name automatically — shown once the user is created.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select className="input-field" value={form.role} onChange={e => setForm({ ...form, role: e.target.value as 'admin' | 'user' | 'driver' })}>
                  <option value="user">Normal User</option>
                  <option value="admin">Admin</option>
                  {/* v73.75 — Craig: driver/inspector accounts that only see
                      Sweeping Maps, all of Site & Road Inspections, and
                      Backup & Sync (see App.tsx's DRIVER_ALLOWED_PAGES). */}
                  <option value="driver">Driver / Inspector (restricted)</option>
                </select>
              </div>
              <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div>
                  <div className="text-sm font-medium text-gray-700">Auto-generate Password</div>
                  <div className="text-xs text-gray-500">Toggle on to auto-generate; off to set manually</div>
                </div>
                <button onClick={() => setSendInvite(!sendInvite)}
                  className={`relative w-12 h-6 rounded-full transition-colors ${sendInvite ? 'bg-indigo-600' : 'bg-gray-300'}`}>
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${sendInvite ? 'translate-x-6' : 'translate-x-0.5'}`} />
                </button>
              </div>
              {!sendInvite && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Password *</label>
                  <input className="input-field" type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="Set a password" />
                </div>
              )}
              {addSaveMsg && <p className={`text-sm font-medium ${addSaveMsg.startsWith('✅') ? 'text-emerald-700' : 'text-red-600'}`}>{addSaveMsg}</p>}
              <div className="flex gap-2 justify-end pt-2">
                <button onClick={() => { setShowAdd(false); setAddSaveMsg(''); }} className="btn-secondary">Close</button>
                <button onClick={handleAdd} className="btn-primary">Create User</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editUser && (
        <div className="modal-overlay" onClick={() => { setEditUser(null); setEditSaveMsg(''); }}>
          <div className="modal-content max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">Edit User</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                <input className="input-field" value={editUser.name} onChange={e => setEditUser({ ...editUser, name: e.target.value })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
                <input className="input-field" type="text" value={editUser.email} onChange={e => setEditUser({ ...editUser, email: e.target.value })} />
                <p className="text-xs text-gray-400 mt-1">Used to log in — plain username, not an email address.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select className="input-field" value={editUser.role} onChange={e => setEditUser({ ...editUser, role: e.target.value as 'admin' | 'user' | 'driver' })}>
                  <option value="user">Normal User</option>
                  <option value="admin">Admin</option>
                  <option value="driver">Driver / Inspector (restricted)</option>
                </select>
              </div>
              <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <span className="text-sm font-medium text-gray-700">Active</span>
                <button onClick={() => setEditUser({ ...editUser, active: !editUser.active })}
                  className={`relative w-12 h-6 rounded-full transition-colors ${editUser.active ? 'bg-emerald-500' : 'bg-gray-300'}`}>
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${editUser.active ? 'translate-x-6' : 'translate-x-0.5'}`} />
                </button>
              </div>
              {editSaveMsg && <p className="text-sm font-medium text-emerald-700">{editSaveMsg}</p>}
              <div className="flex gap-2 justify-end pt-2">
                <button onClick={() => { setEditUser(null); setEditSaveMsg(''); }} className="btn-secondary">Close</button>
                <button onClick={handleUpdate} className="btn-primary">Save Changes</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {showReset && (
        <div className="modal-overlay" onClick={() => setShowReset(null)}>
          <div className="modal-content max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">Reset Password</h2>
            <p className="text-sm text-gray-500 mb-4">For: {data.users.find(u => u.id === showReset)?.name}</p>
            <input className="input-field mb-4" type="password" value={newPw} onChange={e => setNewPw(e.target.value)} placeholder="New password" />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowReset(null)} className="btn-secondary">Cancel</button>
              <button onClick={() => handleReset(showReset)} className="btn-primary">Reset</button>
            </div>
          </div>
        </div>
      )}

      {/* User List */}
      <div className="card overflow-hidden !p-0">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="table-header">User</th>
                <th className="table-header">Role</th>
                <th className="table-header">Status</th>
                <th className="table-header">Created</th>
                <th className="table-header text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.users.map(user => (
                <tr key={user.id} className="hover:bg-gray-50">
                  <td className="table-cell">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-semibold text-sm">
                        {user.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="font-medium text-gray-900">{user.name}</div>
                        <div className="text-xs text-gray-500">{user.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="table-cell">
                    <span className={`badge ${user.role === 'admin' ? 'bg-purple-100 text-purple-700' : user.role === 'driver' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="table-cell">
                    <span className={`badge ${user.active ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                      {user.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="table-cell text-gray-500">{new Date(user.createdAt).toLocaleDateString()}</td>
                  <td className="table-cell text-right">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => setEditUser(user)} className="px-2 py-1 rounded text-xs bg-gray-100 hover:bg-indigo-100 text-gray-600 hover:text-indigo-700 font-medium transition" title="Edit user">✏️ Edit</button>
                      <button onClick={() => { setShowReset(user.id); setNewPw(''); }} className="px-2 py-1 rounded text-xs bg-gray-100 hover:bg-amber-100 text-gray-600 hover:text-amber-700 font-medium transition" title="Reset Password">🔑</button>
                      {user.id !== currentUser?.id && (
                        <button onClick={() => { if (confirm('Delete this user?')) deleteUser(user.id); }} className="px-2 py-1 rounded text-xs bg-gray-100 hover:bg-red-100 text-gray-600 hover:text-red-600 font-medium transition" title="Delete">🗑️</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
