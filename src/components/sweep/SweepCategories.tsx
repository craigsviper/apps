import { useState } from 'react';
import { useStore } from '../../store';
import type { SweepCategory, SweepCategoryItem } from '../../types';

const uid = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
const nowStr = () => new Date().toISOString();

/* ── Category section config ── */
type CatType = SweepCategory['categoryType'];

interface SectionDef {
  type: CatType;
  icon: string;
  label: string;
  description: string;
  usedIn: string;
}

const SECTIONS: SectionDef[] = [
  {
    type: 'damage_type', icon: '⚠️', label: 'Damage Types',
    description: 'Types of road damage that appear in the Damage Pins dropdown on sweep job maps.',
    usedIn: 'Sweep Jobs → Road Detail → Damage Pins',
  },
  {
    type: 'debris_type', icon: '🌿', label: 'Debris Types',
    description: 'Types of debris collected during sweeping. Used as reference labels in job notes and reports.',
    usedIn: 'Sweep Jobs → Road Settings → Debris Notes',
  },
  {
    type: 'zone_type', icon: '🗺️', label: 'Area Zone Types',
    description: 'Zone classifications for Areas & Roads.',
    usedIn: 'Areas & Roads → Area Zone Type selector',
  },
  {
    type: 'zone_kind', icon: '📍', label: 'Zone Type',
    description: 'Kinds of drawn zone shape (car park, business, park, etc.) available in the New/Edit Zone form\'s Zone Type dropdown. Renamed from "Zone Kinds" (v73.51) to match that dropdown\'s own label exactly, and to stop being confused with the separate "Area Zone Types" list above.',
    usedIn: 'Areas & Roads → Zone → New/Edit Zone → Zone Type selector',
  },
  {
    type: 'frequency', icon: '🔁', label: 'Sweep Frequencies',
    description: 'Scheduled sweep frequencies — used as reference labels in job notes and reports.',
    usedIn: 'Reports & job notes reference',
  },
  {
    type: 'crew_member', icon: '👷', label: 'Crew Members / Roles',
    description: 'Crew member names or roles available for quick selection when creating sweep jobs.',
    usedIn: 'Sweep Jobs → Job Info → Crew Member',
  },
  {
    type: 'equipment', icon: '🚛', label: 'Equipment & Vehicles',
    description: 'Vehicles and equipment types used during sweeping operations.',
    usedIn: 'Sweep Jobs → Job Info → Equipment',
  },
  {
    type: 'pass_count', icon: '🔢', label: 'Pass Counts',
    description: 'Number-of-passes options available in the Pass Count dropdown when creating or editing sweep jobs.',
    usedIn: 'Sweep Jobs → Road Detail → Pass Count',
  },
  {
    type: 'site_type', icon: '📌', label: 'Site Types',
    description: 'Site type classifications used in Job Sites.',
    usedIn: 'Job Sites → New/Edit Job Site → Site Type dropdown',
  },
  {
    type: 'file_attachment', icon: '📎', label: 'File Attachment Types',
    description: 'Categories for file attachments in job sites and shared libraries.',
    usedIn: 'Job Sites → File Attachments → File Type dropdown',
  },
  {
    type: 'weather', icon: '🌤️', label: 'Weather Conditions',
    description: 'Weather condition options recorded per road during sweep jobs.',
    usedIn: 'Sweep Jobs → Sweep Run Details → 🌤️ Weather dropdown',
  },
  {
    type: 'debris_level', icon: '🗑️', label: 'Debris Levels',
    description: 'Debris level classifications in road quick settings.',
    usedIn: 'Sweep Jobs → Sweep Run Details → Debris Level',
  },
  {
    type: 'damage_severity', icon: '🚨', label: 'Damage Severity',
    description: 'Severity levels for damage pins on road maps.',
    usedIn: 'Sweep Jobs → Road Map → Add/Edit Damage Pin → Severity',
  },
  {
    type: 'extra_expense', icon: '💲', label: 'Extra Expenses',
    description: 'Expense types for recording additional job costs (food, parts, oil, etc.).',
    usedIn: 'Sweep Jobs → Edit Job → 💲 Expenses tab → Expense Type dropdown',
  },
  {
    type: 'job_site_map_pin', icon: '📍', label: 'Job Sites Map & Pins',
    description: 'Pin types available when adding map pins to a Job Site. Each item becomes an option in the pin type dropdown (include an emoji prefix e.g. 💧 Water Point).',
    usedIn: 'Job Sites → Edit/New Job Site → Map & Pins tab → Pin Type dropdown',
  },
  // Note: 'custom' categoryType is preserved in the type system for future use
  // but is not shown in the UI as it has no consumer in the current app
];

const PRESET_COLORS = ['#4f46e5','#0891b2','#059669','#d97706','#dc2626','#7c3aed','#be185d','#65a30d','#0e7490','#92400e'];

/* ════════════════════════════════════ */
export default function SweepCategories() {
  const { data, updateSweepCategory, deleteSweepCategory, cleanupSweepCategories } = useStore();
  const cats = data.sweepCategories || [];
  const [cleanupMsg, setCleanupMsg] = useState('');

  const runCleanup = () => {
    const removed = cleanupSweepCategories();
    setCleanupMsg(
      removed > 0
        ? `✅ Cleaned up ${removed} duplicate/empty list${removed !== 1 ? 's' : ''}.`
        : '✅ No duplicates found — everything looks tidy.'
    );
    setTimeout(() => setCleanupMsg(''), 5000);
  };

  const [activeType, setActiveType] = useState<CatType>('damage_type');

  /* ── Add/Edit item — modal, matching Site & Road Inspections Categories ── */
  const [itemModal, setItemModal] = useState<{ catId: string; item: SweepCategoryItem | null } | null>(null);
  const [itemForm, setItemForm] = useState<{ name: string; description: string; color: string }>({
    name: '', description: '', color: PRESET_COLORS[0],
  });

  /* ── Rename existing list ── */
  const [renamingCatId, setRenamingCatId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');

  const section = SECTIONS.find(s => s.type === activeType)!;
  const sectionCats = cats.filter(c => c.categoryType === activeType);

  /* ── helpers ── */
  const isDuplicateItem = (catId: string, name: string, excludeId?: string) => {
    const cat = cats.find(c => c.id === catId);
    if (!cat) return false;
    return cat.items.some(i => i.name.trim().toLowerCase() === name.trim().toLowerCase() && i.id !== excludeId);
  };

  // Duplicate-list-name check — scoped to the same section (categoryType) since
  // lists in different sections (e.g. "Equipment" vs "Damage Types") may share a name.
  const isDuplicateCategoryName = (name: string, categoryType: CatType, excludeId?: string) =>
    cats.some(c => c.categoryType === categoryType
      && c.name.trim().toLowerCase() === name.trim().toLowerCase()
      && c.id !== excludeId);

  const isInUse = (cat: SweepCategory) => {
    // Check if any sweep job references items from this category
    if (cat.categoryType === 'crew_member') {
      return (data.sweepJobs || []).some(j => cat.items.some(i => j.crewMember === i.name));
    }
    if (cat.categoryType === 'damage_type') {
      return (data.sweepJobs || []).some(j =>
        j.roads.some(r => r.damagePins.some(p => cat.items.some(i => p.damageType === i.name)))
      );
    }
    return false;
  };

  const openAddItem = (cat: SweepCategory) => {
    setItemForm({ name: '', description: '', color: PRESET_COLORS[cat.items.length % PRESET_COLORS.length] });
    setItemModal({ catId: cat.id, item: null });
  };

  const openEditItem = (cat: SweepCategory, item: SweepCategoryItem) => {
    setItemForm({ name: item.name, description: item.description, color: item.color });
    setItemModal({ catId: cat.id, item });
  };

  const saveItemModal = () => {
    if (!itemModal || !itemForm.name.trim()) return;
    const cat = cats.find(c => c.id === itemModal.catId);
    if (!cat) return;
    if (isDuplicateItem(cat.id, itemForm.name, itemModal.item?.id)) {
      alert(`"${itemForm.name.trim()}" already exists in this list.`);
      return;
    }
    if (itemModal.item) {
      // Update existing item
      const updated = {
        ...cat,
        items: cat.items.map(i => i.id === itemModal.item!.id
          ? { ...i, ...itemForm, name: itemForm.name.trim(), updatedAt: nowStr() }
          : i),
      };
      updateSweepCategory(updated);
    } else {
      // Add new item
      const newItem: SweepCategoryItem = { id: uid(), ...itemForm, name: itemForm.name.trim() };
      updateSweepCategory({ ...cat, items: [...cat.items, newItem] });
    }
    setItemModal(null);
  };

  const deleteItem = (cat: SweepCategory, itemId: string) => {
    if (!confirm('Remove this item? It may be in use in existing records.')) return;
    updateSweepCategory({ ...cat, items: cat.items.filter(i => i.id !== itemId) });
  };

  const deleteCat = (cat: SweepCategory) => {
    const used = isInUse(cat);
    const msg = used
      ? `⚠️ This category may be in use by existing sweep jobs. Delete it anyway?`
      : `Delete the category "${cat.name}" and all its items?`;
    if (!confirm(msg)) return;
    deleteSweepCategory(cat.id);
  };

  const saveRename = (cat: SweepCategory) => {
    if (!renameVal.trim()) return;
    if (isDuplicateCategoryName(renameVal, cat.categoryType, cat.id)) {
      alert(`A "${section.label}" list named "${renameVal.trim()}" already exists.`);
      return;
    }
    updateSweepCategory({ ...cat, name: renameVal.trim() });
    setRenamingCatId(null);
  };

  /* ════════════════════════════════════════════ */
  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🏷️ SW Categories</h1>
          <p className="text-sm text-gray-500 mt-1">Manage dropdown options and reference lists used across the Road Sweeping module</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button onClick={runCleanup} className="btn-secondary text-xs whitespace-nowrap" title="Removes duplicate and empty lists left behind by older app versions">
            🧹 Clean Up Duplicate Lists
          </button>
          {cleanupMsg && <span className="text-xs text-emerald-700 font-medium">{cleanupMsg}</span>}
        </div>
      </div>

      {/* Add/Edit Item modal — matches Site & Road Inspections → Categories */}
      {itemModal && (
        <div className="modal-overlay" onClick={() => setItemModal(null)}>
          <div className="modal-content max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">{itemModal.item ? 'Edit Item' : 'Add Item'}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input className="input-field" value={itemForm.name}
                  onChange={e => setItemForm({ ...itemForm, name: e.target.value })}
                  onKeyDown={e => e.key === 'Enter' && saveItemModal()}
                  placeholder="Item name" autoFocus />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input className="input-field" value={itemForm.description}
                  onChange={e => setItemForm({ ...itemForm, description: e.target.value })}
                  onKeyDown={e => e.key === 'Enter' && saveItemModal()}
                  placeholder="Description (optional)" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Color</label>
                <div className="flex gap-2 flex-wrap">
                  {PRESET_COLORS.map(c => (
                    <button key={c} onClick={() => setItemForm({ ...itemForm, color: c })}
                      className={`w-8 h-8 rounded-full border-2 transition ${itemForm.color === c ? 'border-gray-900 scale-110' : 'border-transparent'}`}
                      style={{ backgroundColor: c }} />
                  ))}
                  <input type="color" value={itemForm.color} onChange={e => setItemForm({ ...itemForm, color: e.target.value })} className="w-8 h-8 rounded cursor-pointer" />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setItemModal(null)} className="btn-secondary">Cancel</button>
                <button onClick={saveItemModal} className="btn-primary">{itemModal.item ? 'Update' : 'Add'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-4">

        {/* ── Sidebar navigation ── */}
        <div className="lg:w-56 shrink-0">
          <nav className="card p-2 space-y-0.5">
            {SECTIONS.map(s => {
              const count = cats.filter(c => c.categoryType === s.type).reduce((acc, c) => acc + c.items.length, 0);
              return (
                <button key={s.type}
                  onClick={() => setActiveType(s.type)}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium text-left transition
                    ${activeType === s.type ? 'bg-orange-50 text-orange-800 border border-orange-200' : 'text-gray-600 hover:bg-gray-50'}`}>
                  <span className="text-base">{s.icon}</span>
                  <span className="flex-1 leading-tight">{s.label}</span>
                  {count > 0 && (
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${activeType === s.type ? 'bg-orange-200 text-orange-800' : 'bg-gray-100 text-gray-500'}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* ── Main content ── */}
        <div className="flex-1 space-y-4 min-w-0">

          {/* Section header */}
          <div className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-gray-900">{section.icon} {section.label}</h2>
                <p className="text-sm text-gray-500 mt-0.5">{section.description}</p>
                <p className="text-xs text-orange-600 font-medium mt-1">📍 Used in: {section.usedIn}</p>
              </div>
            </div>
          </div>

          {/* Category lists */}
          {sectionCats.length === 0 && (
            <div className="card text-center py-12 text-gray-400">
              <div className="text-4xl mb-3">{section.icon}</div>
              <p className="font-medium text-gray-600 mb-1">No {section.label.toLowerCase()} list found</p>
              <p className="text-sm">This built-in list appears to be missing — try Backup &amp; Sync → Push/Pull, or contact support if it doesn't reappear.</p>
            </div>
          )}

          {/* Card + item layout mirrors Site & Road Inspections → Categories exactly:
              header row (name, + Add Item, edit, delete) then always-visible item
              rows with hover-reveal edit/delete actions. No collapse/expand. */}
          {sectionCats.map(cat => {
            const isRenaming = renamingCatId === cat.id;

            return (
              <div key={cat.id} className="card">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    {isRenaming ? (
                      <div className="flex gap-2 items-center">
                        <input className="input-field max-w-xs" value={renameVal}
                          onChange={e => setRenameVal(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveRename(cat); if (e.key === 'Escape') setRenamingCatId(null); }}
                          autoFocus />
                        <button onClick={() => saveRename(cat)} className="btn-primary text-xs">Save</button>
                        <button onClick={() => setRenamingCatId(null)} className="btn-secondary text-xs">Cancel</button>
                      </div>
                    ) : (
                      <>
                        <h3 className="font-semibold text-gray-900">{cat.name}</h3>
                        <span className="badge bg-gray-100 text-gray-600 mt-1">{cat.items.length} item{cat.items.length !== 1 ? 's' : ''}</span>
                      </>
                    )}
                  </div>
                  {!isRenaming && (
                    <div className="flex gap-2">
                      <button onClick={() => openAddItem(cat)}
                        className="text-orange-600 hover:text-orange-800 text-sm font-medium">+ Add Item</button>
                      <button onClick={() => { setRenamingCatId(cat.id); setRenameVal(cat.name); }}
                        className="text-gray-400 hover:text-gray-600 text-sm" title="Rename">✏️</button>
                      <button onClick={() => deleteCat(cat)}
                        className="text-red-400 hover:text-red-600 text-sm" title="Delete">🗑️</button>
                    </div>
                  )}
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
                          <button onClick={() => openEditItem(cat, item)}
                            className="p-1 text-gray-400 hover:text-gray-600">✏️</button>
                          <button onClick={() => deleteItem(cat, item.id)}
                            className="p-1 text-red-400 hover:text-red-600">🗑️</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
