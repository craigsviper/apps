import { useState } from 'react';
import { useStore } from '../store';
import type { Category, CategoryItem, CoverTemplate } from '../types';

const uid = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
const COLORS = ['#4F46E5', '#0891B2', '#059669', '#D97706', '#DC2626', '#7C3AED', '#BE185D', '#6B7280', '#92400E', '#0D9488'];

export default function Categories() {
  const { data, addCategory, updateCategory, deleteCategory, addCoverTemplate, updateCoverTemplate, deleteCoverTemplate } = useStore();
  const [editCat, setEditCat] = useState<Category | null>(null);
  const [showAddCat, setShowAddCat] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [newCatType, setNewCatType] = useState<Category['type']>('custom');
  const [editItem, setEditItem] = useState<{ catId: string; item: CategoryItem | null } | null>(null);
  const [itemForm, setItemForm] = useState({ name: '', description: '', color: '#4F46E5' });

  // Cover template state
  const [showSaveTemplateModal, setShowSaveTemplateModal] = useState<CoverTemplate | null | 'new'>(null);
  const [templateForm, setTemplateForm] = useState<{
    name: string; description: string; clientId: string;
    companyName: string; companyTagline: string; companyPhone: string;
    companyEmail: string; companyAddress: string;
    reportTypeLabel: string; preparedBy: string;
    primaryColor: string; headerTextColor: string; titleTextColor: string;
  }>({ name: '', description: '', clientId: '', companyName: '', companyTagline: '',
    companyPhone: '', companyEmail: '', companyAddress: '',
    reportTypeLabel: 'Road & Storm Water Inspection', preparedBy: '',
    primaryColor: '#1e3a5f', headerTextColor: '#ffffff', titleTextColor: '#1e3a5f' });
  const [expandedTemplate, setExpandedTemplate] = useState<string | null>(null);

  const isDuplicateCategoryName = (name: string, excludeId?: string) =>
    data.categories.some(c => c.name.trim().toLowerCase() === name.trim().toLowerCase() && c.id !== excludeId);

  const isDuplicateItem = (catId: string, name: string, excludeId?: string) => {
    const cat = data.categories.find(c => c.id === catId);
    if (!cat) return false;
    return cat.items.some(i => i.name.trim().toLowerCase() === name.trim().toLowerCase() && i.id !== excludeId);
  };

  const handleAddCategory = () => {
    if (!newCatName.trim()) return;
    if (isDuplicateCategoryName(newCatName)) {
      alert(`A category named "${newCatName.trim()}" already exists.`);
      return;
    }
    addCategory({ name: newCatName, type: newCatType, items: [] });
    setNewCatName('');
    setNewCatType('custom');
    setShowAddCat(false);
  };

  const handleAddItem = (catId: string) => {
    if (!itemForm.name.trim()) return;
    const cat = data.categories.find(c => c.id === catId);
    if (!cat) return;
    if (isDuplicateItem(catId, itemForm.name)) {
      alert(`"${itemForm.name.trim()}" already exists in this category.`);
      return;
    }
    const newItem: CategoryItem = { id: uid(), ...itemForm };
    updateCategory({ ...cat, items: [...cat.items, newItem] });
    setItemForm({ name: '', description: '', color: '#4F46E5' });
    setEditItem(null);
  };

  const handleUpdateItem = (catId: string, itemId: string) => {
    const cat = data.categories.find(c => c.id === catId);
    if (!cat) return;
    if (isDuplicateItem(catId, itemForm.name, itemId)) {
      alert(`"${itemForm.name.trim()}" already exists in this category.`);
      return;
    }
    updateCategory({ ...cat, items: cat.items.map(i => i.id === itemId ? { ...i, ...itemForm } : i) });
    setEditItem(null);
  };

  const handleDeleteItem = (catId: string, itemId: string) => {
    const cat = data.categories.find(c => c.id === catId);
    if (!cat) return;
    updateCategory({ ...cat, items: cat.items.filter(i => i.id !== itemId) });
  };

  const typeLabel = (t: string) => {
    const m: Record<string, string> = { inspection_type: 'Inspection Type', condition: 'Condition Rating', comment_category: 'Comment Category', custom: 'Custom' };
    return m[t] || t;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Categories</h1>
          <p className="text-gray-500 text-sm mt-1">Manage inspection types, conditions, custom categories, and cover page templates</p>
        </div>
        <button onClick={() => setShowAddCat(true)} className="btn-primary">+ Add Category</button>
      </div>

      {showAddCat && (
        <div className="modal-overlay" onClick={() => setShowAddCat(false)}>
          <div className="modal-content max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">Add New Category</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category Name</label>
                <input className="input-field" value={newCatName} onChange={e => setNewCatName(e.target.value)} placeholder="Enter category name" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                <select className="input-field" value={newCatType} onChange={e => setNewCatType(e.target.value as Category['type'])}>
                  <option value="inspection_type">Inspection Type</option>
                  <option value="condition">Condition Rating</option>
                  <option value="comment_category">Comment Category</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setShowAddCat(false)} className="btn-secondary">Cancel</button>
                <button onClick={handleAddCategory} className="btn-primary">Add Category</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editItem && (
        <div className="modal-overlay" onClick={() => setEditItem(null)}>
          <div className="modal-content max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">{editItem.item ? 'Edit Item' : 'Add Item'}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input className="input-field" value={itemForm.name} onChange={e => setItemForm({ ...itemForm, name: e.target.value })} placeholder="Item name" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input className="input-field" value={itemForm.description} onChange={e => setItemForm({ ...itemForm, description: e.target.value })} placeholder="Description" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Color</label>
                <div className="flex gap-2 flex-wrap">
                  {COLORS.map(c => (
                    <button key={c} onClick={() => setItemForm({ ...itemForm, color: c })}
                      className={`w-8 h-8 rounded-full border-2 transition ${itemForm.color === c ? 'border-gray-900 scale-110' : 'border-transparent'}`}
                      style={{ backgroundColor: c }} />
                  ))}
                  <input type="color" value={itemForm.color} onChange={e => setItemForm({ ...itemForm, color: e.target.value })} className="w-8 h-8 rounded cursor-pointer" />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setEditItem(null)} className="btn-secondary">Cancel</button>
                <button onClick={() => editItem.item ? handleUpdateItem(editItem.catId, editItem.item.id) : handleAddItem(editItem.catId)} className="btn-primary">
                  {editItem.item ? 'Update' : 'Add'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {data.categories.map(cat => (
          <div key={cat.id} className="card">
            <div className="flex items-center justify-between mb-4">
              <div>
                {editCat?.id === cat.id ? (
                  <div className="flex gap-2 items-center">
                    <input className="input-field max-w-xs" value={editCat.name} onChange={e => setEditCat({ ...editCat, name: e.target.value })} />
                    <button onClick={() => {
                      if (!editCat.name.trim()) return;
                      if (isDuplicateCategoryName(editCat.name, editCat.id)) {
                        alert(`A category named "${editCat.name.trim()}" already exists.`);
                        return;
                      }
                      updateCategory(editCat); setEditCat(null);
                    }} className="btn-primary text-xs">Save</button>
                    <button onClick={() => setEditCat(null)} className="btn-secondary text-xs">Cancel</button>
                  </div>
                ) : (
                  <>
                    <h3 className="font-semibold text-gray-900">{cat.name}</h3>
                    <span className="badge bg-gray-100 text-gray-600 mt-1">{typeLabel(cat.type)}</span>
                  </>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={() => { setItemForm({ name: '', description: '', color: COLORS[cat.items.length % COLORS.length] }); setEditItem({ catId: cat.id, item: null }); }}
                  className="text-indigo-600 hover:text-indigo-800 text-sm font-medium">+ Add Item</button>
                <button onClick={() => setEditCat(cat)} className="text-gray-400 hover:text-gray-600 text-sm">✏️</button>
                <button onClick={() => { if (confirm('Delete this category?')) deleteCategory(cat.id); }} className="text-red-400 hover:text-red-600 text-sm">🗑️</button>
              </div>
            </div>
            {cat.items.length === 0 ? (
              <p className="text-gray-400 text-sm text-center py-4">No items yet. Add your first item.</p>
            ) : (
              <div className="space-y-2">
                {cat.items.map(item => (
                  <div key={item.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg group">
                    <div className="flex items-center gap-3">
                      <div className="w-4 h-4 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                      <div>
                        <div className="font-medium text-sm text-gray-900">{item.name}</div>
                        {item.description && <div className="text-xs text-gray-500">{item.description}</div>}
                      </div>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition">
                      <button onClick={() => { setItemForm({ name: item.name, description: item.description, color: item.color }); setEditItem({ catId: cat.id, item }); }}
                        className="p-1 text-gray-400 hover:text-gray-600">✏️</button>
                      <button onClick={() => handleDeleteItem(cat.id, item.id)} className="p-1 text-red-400 hover:text-red-600">🗑️</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── COVER PAGE TEMPLATES ─────────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900">🎨 Cover Page Templates</h2>
            <p className="text-gray-500 text-sm mt-0.5">Save report cover page styles — global or per client. Load them instantly when creating reports.</p>
          </div>
          <span className="badge bg-purple-100 text-purple-700">{(data.coverTemplates || []).length} template{(data.coverTemplates || []).length !== 1 ? 's' : ''}</span>
        </div>

        {(data.coverTemplates || []).length === 0 ? (
          <div className="card text-center py-8">
            <p className="text-3xl mb-2">🎨</p>
            <p className="text-gray-500 font-medium">No cover templates yet</p>
            <p className="text-gray-400 text-sm mt-1">Save a template from the Cover Page Editor when creating a report.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {(data.coverTemplates || []).map(tpl => {
              const client = data.clients.find(c => c.id === tpl.clientId);
              const isExpanded = expandedTemplate === tpl.id;
              return (
                <div key={tpl.id} className="card">
                  <div className="flex items-start justify-between gap-3">
                    {/* Colour swatch */}
                    <div className="w-10 h-10 rounded-xl shrink-0 border border-gray-200 shadow-sm"
                      style={{ backgroundColor: tpl.cover.primaryColor }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-gray-900">{tpl.name}</span>
                        {tpl.clientId ? (
                          <span className="badge bg-blue-100 text-blue-700 text-xs">👤 {client?.name || tpl.clientName}</span>
                        ) : (
                          <span className="badge bg-gray-100 text-gray-600 text-xs">🌐 Global</span>
                        )}
                      </div>
                      {tpl.description && <p className="text-xs text-gray-500 mt-0.5">{tpl.description}</p>}
                      <p className="text-xs text-gray-400 mt-1">
                        {tpl.cover.companyName} · {tpl.cover.primaryColor}
                      </p>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => setExpandedTemplate(isExpanded ? null : tpl.id)}
                        className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition text-sm"
                        title="Preview"
                      >👁️</button>
                      <button
                        onClick={() => {
                          setTemplateForm({
                            name: tpl.name,
                            description: tpl.description,
                            clientId: tpl.clientId,
                            companyName: tpl.cover.companyName || '',
                            companyTagline: tpl.cover.companyTagline || '',
                            companyPhone: tpl.cover.companyPhone || '',
                            companyEmail: tpl.cover.companyEmail || '',
                            companyAddress: tpl.cover.companyAddress || '',
                            reportTypeLabel: tpl.cover.reportTypeLabel || 'Road & Storm Water Inspection',
                            preparedBy: tpl.cover.preparedBy || '',
                            primaryColor: tpl.cover.primaryColor || '#1e3a5f',
                            headerTextColor: tpl.cover.headerTextColor || '#ffffff',
                            titleTextColor: tpl.cover.titleTextColor || '#1e3a5f',
                          });
                          setShowSaveTemplateModal(tpl);
                        }}
                        className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition text-sm"
                        title="Edit"
                      >✏️</button>
                      <button
                        onClick={() => { if (confirm(`Delete template "${tpl.name}"?`)) deleteCoverTemplate(tpl.id); }}
                        className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition text-sm"
                        title="Delete"
                      >🗑️</button>
                    </div>
                  </div>

                  {/* Expanded preview */}
                  {isExpanded && (
                    <div className="mt-4 pt-4 border-t border-gray-100">
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                        <div><span className="text-gray-400">Company:</span><br/><span className="font-medium">{tpl.cover.companyName || '—'}</span></div>
                        <div><span className="text-gray-400">Tagline:</span><br/><span className="font-medium">{tpl.cover.companyTagline || '—'}</span></div>
                        <div><span className="text-gray-400">Phone:</span><br/><span className="font-medium">{tpl.cover.companyPhone || '—'}</span></div>
                        <div><span className="text-gray-400">Email:</span><br/><span className="font-medium">{tpl.cover.companyEmail || '—'}</span></div>
                        <div><span className="text-gray-400">Address:</span><br/><span className="font-medium">{tpl.cover.companyAddress || '—'}</span></div>
                        <div><span className="text-gray-400">Prepared By:</span><br/><span className="font-medium">{tpl.cover.preparedBy || '—'}</span></div>
                      </div>
                      <div className="mt-3 flex items-center gap-3">
                        <div className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full border border-gray-200" style={{ backgroundColor: tpl.cover.primaryColor }} />
                          <span className="text-xs text-gray-500">Header</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full border border-gray-200" style={{ backgroundColor: tpl.cover.headerTextColor }} />
                          <span className="text-xs text-gray-500">Header text</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full border border-gray-200" style={{ backgroundColor: tpl.cover.titleTextColor }} />
                          <span className="text-xs text-gray-500">Title text</span>
                        </div>
                      </div>
                      {tpl.cover.coverNotes && (
                        <div className="mt-3 p-3 bg-gray-50 rounded-lg text-xs text-gray-600 italic">"{tpl.cover.coverNotes.slice(0, 120)}{tpl.cover.coverNotes.length > 120 ? '…' : ''}"</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit Template Modal */}
      {showSaveTemplateModal && showSaveTemplateModal !== 'new' && (
        <div className="modal-overlay" onClick={() => setShowSaveTemplateModal(null)}>
          <div className="modal-content max-w-lg p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-1">✏️ Edit Cover Template</h2>
            <p className="text-sm text-gray-500 mb-4">Update the template name, details and cover page settings.</p>
            <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">

              {/* Template metadata */}
              <div className="p-3 bg-gray-50 rounded-xl border border-gray-100">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Template Info</p>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Template Name <span className="text-red-500">*</span></label>
                    <input className="input-field" value={templateForm.name} autoFocus
                      onChange={e => setTemplateForm(p => ({ ...p, name: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                    <input className="input-field" value={templateForm.description}
                      onChange={e => setTemplateForm(p => ({ ...p, description: e.target.value }))}
                      placeholder="Optional notes about this template" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Assign to Client</label>
                    <select className="input-field" value={templateForm.clientId}
                      onChange={e => setTemplateForm(p => ({ ...p, clientId: e.target.value }))}>
                      <option value="">🌐 Global (all clients)</option>
                      {data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              {/* Company info */}
              <div className="p-3 bg-gray-50 rounded-xl border border-gray-100">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Company Information</p>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Company Name</label>
                    <input className="input-field" value={templateForm.companyName}
                      onChange={e => setTemplateForm(p => ({ ...p, companyName: e.target.value }))} placeholder="Company name" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Tagline</label>
                    <input className="input-field" value={templateForm.companyTagline}
                      onChange={e => setTemplateForm(p => ({ ...p, companyTagline: e.target.value }))} placeholder="Company tagline" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                      <input className="input-field" value={templateForm.companyPhone}
                        onChange={e => setTemplateForm(p => ({ ...p, companyPhone: e.target.value }))} placeholder="Phone" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                      <input className="input-field" value={templateForm.companyEmail}
                        onChange={e => setTemplateForm(p => ({ ...p, companyEmail: e.target.value }))} placeholder="Email" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                    <input className="input-field" value={templateForm.companyAddress}
                      onChange={e => setTemplateForm(p => ({ ...p, companyAddress: e.target.value }))} placeholder="Address" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Default Prepared By</label>
                    <input className="input-field" value={templateForm.preparedBy}
                      onChange={e => setTemplateForm(p => ({ ...p, preparedBy: e.target.value }))} placeholder="Name of person preparing reports" />
                  </div>
                </div>
              </div>

              {/* Cover style */}
              <div className="p-3 bg-gray-50 rounded-xl border border-gray-100">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Cover Style</p>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Report Type Label</label>
                    <input className="input-field" value={templateForm.reportTypeLabel}
                      onChange={e => setTemplateForm(p => ({ ...p, reportTypeLabel: e.target.value }))}
                      placeholder="e.g. Road & Storm Water Inspection" />
                    <p className="text-xs text-gray-400 mt-1">The banner text shown on the cover page.</p>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Header Colour</label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={templateForm.primaryColor}
                          onChange={e => setTemplateForm(p => ({ ...p, primaryColor: e.target.value }))}
                          className="w-10 h-10 rounded cursor-pointer border border-gray-200" />
                        <input className="input-field flex-1 font-mono text-xs" value={templateForm.primaryColor}
                          onChange={e => setTemplateForm(p => ({ ...p, primaryColor: e.target.value }))} />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Header Text</label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={templateForm.headerTextColor}
                          onChange={e => setTemplateForm(p => ({ ...p, headerTextColor: e.target.value }))}
                          className="w-10 h-10 rounded cursor-pointer border border-gray-200" />
                        <input className="input-field flex-1 font-mono text-xs" value={templateForm.headerTextColor}
                          onChange={e => setTemplateForm(p => ({ ...p, headerTextColor: e.target.value }))} />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Title Text</label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={templateForm.titleTextColor}
                          onChange={e => setTemplateForm(p => ({ ...p, titleTextColor: e.target.value }))}
                          className="w-10 h-10 rounded cursor-pointer border border-gray-200" />
                        <input className="input-field flex-1 font-mono text-xs" value={templateForm.titleTextColor}
                          onChange={e => setTemplateForm(p => ({ ...p, titleTextColor: e.target.value }))} />
                      </div>
                    </div>
                  </div>
                  {/* Live colour preview */}
                  <div className="rounded-lg overflow-hidden border border-gray-200 mt-1" style={{ height: 48 }}>
                    <div className="h-full flex items-center px-3 gap-2" style={{ backgroundColor: templateForm.primaryColor }}>
                      <span className="text-xs font-bold uppercase tracking-widest" style={{ color: templateForm.headerTextColor }}>
                        {templateForm.companyName || 'Company Name'}
                      </span>
                    </div>
                  </div>
                  <div className="text-xs font-bold uppercase tracking-widest" style={{ color: templateForm.titleTextColor }}>
                    {templateForm.reportTypeLabel || 'Report Type Label'} ← title colour
                  </div>
                </div>
              </div>

            </div>
            <div className="flex gap-3 pt-4">
              <button onClick={() => setShowSaveTemplateModal(null)} className="btn-secondary flex-1">Cancel</button>
              <button
                disabled={!templateForm.name.trim()}
                onClick={() => {
                  const tpl = showSaveTemplateModal as CoverTemplate;
                  const client = data.clients.find(c => c.id === templateForm.clientId);
                  updateCoverTemplate({
                    ...tpl,
                    name: templateForm.name,
                    description: templateForm.description,
                    clientId: templateForm.clientId,
                    clientName: client?.name || '',
                    cover: {
                      ...tpl.cover,
                      companyName:     templateForm.companyName,
                      companyTagline:  templateForm.companyTagline,
                      companyPhone:    templateForm.companyPhone,
                      companyEmail:    templateForm.companyEmail,
                      companyAddress:  templateForm.companyAddress,
                      reportTypeLabel: templateForm.reportTypeLabel || 'Road & Storm Water Inspection',
                      preparedBy:      templateForm.preparedBy,
                      primaryColor:    templateForm.primaryColor,
                      headerTextColor: templateForm.headerTextColor,
                      titleTextColor:  templateForm.titleTextColor,
                    },
                  });
                  setShowSaveTemplateModal(null);
                }}
                className="btn-primary flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >✅ Save Changes</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
