import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import type {
  User, Client, Inspection, InspectionMap, Category, Report, CoverTemplate, AppData,
  SweepArea, SweepRoad, SweepZone, SweepJob, SweepClient, SweepJobSite, SweepFile, SweepCategory, SweepMap, SweepReport
} from './types';
import { logEvent } from './logger';

const uid = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
const now = () => new Date().toISOString();

// ── Cross-tab data sync (v73.122) ────────────────────────────────────────
// Craig: the "some things save, other places don't" bug was happening
// specifically while working across 3 Chrome tabs at once (Site & Road
// Inspections). Root cause: every tab loads its OWN in-memory copy of
// AppData once on open and keeps writing that whole copy back to IndexedDB
// as it changes — there was no mechanism for one tab to learn about another
// tab's writes. Sequence that loses data: Tab A and Tab B both open with
// the same snapshot → edit in Tab A saves → switch to Tab B and edit
// something unrelated → Tab B's save writes ITS in-memory copy (which
// still predates Tab A's edit) back over the top, silently erasing Tab A's
// change. This is unrelated to (and stacks on top of) the pagehide/
// visibilitychange fix in v73.121, which was a real bug for the
// close/background case but doesn't touch this multi-tab case at all.
//
// Fix: a BroadcastChannel (with a localStorage 'storage'-event fallback for
// browsers without it) that every tab pings after each successful IndexedDB
// write. Other open tabs, on receiving a ping, re-read the freshly-written
// IDB data and MERGE it into their own in-memory copy using the exact same
// per-record, newest-updatedAt-wins merge logic already used for
// server sync (mergeServerDataIntoLocal) — never a blind overwrite in
// either direction, so neither tab's edits can clobber the other's.
const TAB_ID = uid();
const DATA_SYNC_CHANNEL = 'rsw_data_sync_v73121';
let _bc: BroadcastChannel | null = null;
function getDataSyncChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!_bc) { try { _bc = new BroadcastChannel(DATA_SYNC_CHANNEL); } catch { _bc = null; } }
  return _bc;
}
function notifyOtherTabsDataChanged(): void {
  try {
    const bc = getDataSyncChannel();
    const msg = { tabId: TAB_ID, ts: Date.now() };
    if (bc) bc.postMessage(msg);
    // Fallback for browsers without BroadcastChannel: the 'storage' event
    // fires in every OTHER same-origin tab (never the tab that set the
    // item), so this doubles as the same "someone else wrote" signal.
    else localStorage.setItem(DATA_SYNC_CHANNEL, JSON.stringify(msg));
  } catch { /* best-effort — losing a cross-tab ping just delays sync, doesn't lose data */ }
}

// STABLE IDs — must be identical on every device so sync merges correctly.
// Never use uid() here — random IDs cause duplicates after sync.
const DEFAULT_CATEGORIES: Category[] = [
  {
    id: 'cat-insp-type-default', name: 'Inspection Types', type: 'inspection_type',
    items: [
      { id: 'ci-road-surface', name: 'Road Surface', description: 'Road surface inspection', color: '#4F46E5' },
      { id: 'ci-storm-drain', name: 'Storm Water Drain', description: 'Storm water drain inspection', color: '#0891B2' },
      { id: 'ci-storm-grate', name: 'Storm Water Grate', description: 'Storm water grate inspection', color: '#059669' },
      { id: 'ci-culvert', name: 'Culvert', description: 'Culvert inspection', color: '#D97706' },
      { id: 'ci-kerb-channel', name: 'Kerb & Channel', description: 'Kerb and channel inspection', color: '#DC2626' },
      { id: 'ci-catchpit', name: 'Catchpit', description: 'Catchpit inspection', color: '#7C3AED' },
      { id: 'ci-manhole', name: 'Manhole', description: 'Manhole inspection', color: '#BE185D' },
    ]
  },
  {
    id: 'cat-condition-default', name: 'Condition Ratings', type: 'condition',
    items: [
      { id: 'ci-excellent', name: 'Excellent', description: 'No defects, fully functional', color: '#059669' },
      { id: 'ci-good', name: 'Good', description: 'Minor wear, fully functional', color: '#10B981' },
      { id: 'ci-fair', name: 'Fair', description: 'Some deterioration, functional', color: '#F59E0B' },
      { id: 'ci-poor', name: 'Poor', description: 'Significant damage, limited function', color: '#F97316' },
      { id: 'ci-critical', name: 'Critical', description: 'Major failure, non-functional', color: '#DC2626' },
    ]
  },
  {
    id: 'cat-comment-default', name: 'Comment Categories', type: 'comment_category',
    items: [
      { id: 'ci-damage', name: 'Damage', description: 'Physical damage observed', color: '#DC2626' },
      { id: 'ci-blockage', name: 'Blockage', description: 'Blockage or obstruction', color: '#D97706' },
      { id: 'ci-wear', name: 'Wear & Tear', description: 'General wear and deterioration', color: '#F59E0B' },
      { id: 'ci-vegetation', name: 'Vegetation', description: 'Vegetation overgrowth', color: '#059669' },
      { id: 'si-erosion-4363', name: 'Erosion', description: 'Soil or material erosion', color: '#92400E' },
      { id: 'ci-safety', name: 'Safety Hazard', description: 'Immediate safety concern', color: '#BE123C' },
      { id: 'ci-note', name: 'General Note', description: 'General observation', color: '#6B7280' },
    ]
  }
];

const DEFAULT_SWEEP_CATEGORIES: import('./types').SweepCategory[] = [
  {
    id: 'sc-debris-type', name: 'Debris Types', categoryType: 'debris_type',
    items: [
      { id: 'si-leaf-litter-3368', name: 'Leaf litter', description: 'Fallen leaves and organic matter', color: '#65a30d' },
      { id: 'si-gravel---sand-1225', name: 'Gravel / sand', description: 'Loose gravel, sand, or sediment', color: '#d97706' },
      { id: 'si-litter---rubbish-3190', name: 'Litter / rubbish', description: 'General litter and rubbish', color: '#dc2626' },
      { id: 'si-mud-2851', name: 'Mud', description: 'Mud or clay deposits', color: '#92400e' },
      { id: 'si-vegetation-4506', name: 'Vegetation', description: 'Grass clippings, hedging debris', color: '#16a34a' },
    ]
  },
  {
    id: 'sc-zone-type', name: 'Zone Types', categoryType: 'zone_type',
    items: [
      { id: 'si-cbd-5119', name: 'CBD', description: 'Central business district', color: '#4f46e5' },
      { id: 'si-industrial-1254', name: 'Industrial', description: 'Industrial zone', color: '#0891b2' },
      { id: 'si-residential-8967', name: 'Residential', description: 'Residential area', color: '#059669' },
      { id: 'si-rural-5505', name: 'Rural', description: 'Rural or semi-rural road', color: '#65a30d' },
      { id: 'si-local-9168', name: 'Local', description: 'Local roads and streets', color: '#d97706' },
    ]
  },
  // v73.51 — Craig: "no add delete or edit option for zone kinds... its also
  // missing what's already in the drop down box." v73.46 added the 'zone_kind'
  // categoryType, the SW Categories section for it, and appended-custom-items
  // support in the New/Edit Zone form's dropdown — but never actually seeded
  // a matching category record anywhere (client here, or server SW_CAT_META/
  // SW_CAT_ID_TO_TYPE), so the SW Categories page had nothing to display and
  // the 5 built-ins that DO work in the dropdown (hardcoded in SweepJobs.tsx's
  // ZONE_KIND_ICONS/LABELS, kept exactly as-is below for backward
  // compatibility with already-saved zones using their short codes) were
  // invisible to category management. This entry's item names intentionally
  // match ZONE_KIND_LABELS's display text exactly so the two stay in sync at
  // a glance, even though the dropdown's built-in five keep using their fixed
  // short-code values ('carpark' etc.), not these item ids/names — renaming
  // one of these five here is a display-only edit for now; deleting one does
  // NOT remove it from the dropdown (the code default still exists) — same
  // limitation the category system already has for reference-only entries.
  {
    id: 'sc-zone-kind', name: 'Zone Type', categoryType: 'zone_kind',
    items: [
      { id: 'si-zk-carpark', name: 'Car Park', description: 'Built-in — used for the Car Park option in New/Edit Zone', color: '#0088ff' },
      { id: 'si-zk-business', name: 'Business/Industrial', description: 'Built-in — used for the Business/Industrial option in New/Edit Zone', color: '#7c3aed' },
      { id: 'si-zk-area', name: 'General Area', description: 'Built-in — used for the General Area option in New/Edit Zone', color: '#059669' },
      { id: 'si-zk-park', name: 'Park/Reserve', description: 'Built-in — used for the Park/Reserve option in New/Edit Zone', color: '#16a34a' },
      { id: 'si-zk-custom', name: 'Custom', description: 'Built-in — used for the Custom option in New/Edit Zone', color: '#6b7280' },
    ]
  },
  {
    id: 'sc-damage-type', name: 'Damage Types', categoryType: 'damage_type',
    items: [
      { id: 'si-🕳️-pothole-399', name: '🕳️ Pothole', description: 'Road surface pothole', color: '#dc2626' },
      { id: 'si-🧱-kerb-damage-1554', name: '🧱 Kerb Damage', description: 'Damaged kerb or channel', color: '#d97706' },
      { id: 'si-💧-drainage-issue-6924', name: '💧 Drainage Issue', description: 'Blocked or damaged drain', color: '#0891b2' },
      { id: 'si-🚧-marking-faded-1647', name: '🚧 Marking Faded', description: 'Road markings worn or faded', color: '#6b7280' },
      { id: 'si-⚠️-other-5257', name: '⚠️ Other', description: 'Other road damage', color: '#6366f1' },
    ]
  },
  {
    id: 'sc-damage-sev', name: 'Damage Severity', categoryType: 'damage_severity',
    items: [
      { id: 'si-low-7377', name: 'Low', description: 'Minor damage — monitor only', color: '#FCD34D' },
      { id: 'si-medium-4548', name: 'Medium', description: 'Moderate damage — schedule repair', color: '#FB923C' },
      { id: 'si-high-8490', name: 'High', description: 'Significant damage — urgent repair', color: '#EF4444' },
      { id: 'si-critical-5250', name: 'Critical', description: 'Hazardous — immediate action required', color: '#7F1D1D' },
    ]
  },
  {
    id: 'sc-frequency', name: 'Frequencies', categoryType: 'frequency',
    items: [
      { id: 'si-weekly-9271', name: 'Weekly', description: 'Once per week', color: '#4f46e5' },
      { id: 'si-fortnightly-8349', name: 'Fortnightly', description: 'Every two weeks', color: '#7c3aed' },
      { id: 'si-monthly-677', name: 'Monthly', description: 'Once per month', color: '#0891b2' },
      { id: 'si-quarterly-7758', name: 'Quarterly', description: 'Every three months', color: '#059669' },
    ]
  },
  {
    id: 'sc-crew-member', name: 'Crew Members', categoryType: 'crew_member',
    items: [
      { id: 'si-operator-7770', name: 'Operator', description: 'Sweeper machine operator', color: '#4f46e5' },
      { id: 'si-driver-6777', name: 'Driver', description: 'Vehicle driver', color: '#0891b2' },
      { id: 'si-spotter-7815', name: 'Spotter', description: 'Ground spotter / traffic controller', color: '#059669' },
      { id: 'si-supervisor-366', name: 'Supervisor', description: 'Site supervisor', color: '#d97706' },
    ]
  },
  {
    id: 'sc-equipment', name: 'Equipment / Vehicles', categoryType: 'equipment',
    items: [
      { id: 'si-road-sweeper-9732', name: 'Road Sweeper', description: 'Standard road sweeping vehicle', color: '#059669' },
      { id: 'si-vacuum-truck-8884', name: 'Vacuum Truck', description: 'Suction/vacuum sweeper', color: '#d97706' },
      { id: 'si-water-tanker-830', name: 'Water Tanker', description: 'Water suppression support vehicle', color: '#0891b2' },
      { id: 'si-support-vehicle-6799', name: 'Support Vehicle', description: 'Crew transport or support', color: '#6366f1' },
    ]
  },
  {
    id: 'sc-pass-count', name: 'Pass Counts', categoryType: 'pass_count',
    items: [
      { id: 'si-1-7940', name: '1', description: '1st pass', color: '#4f46e5' },
      { id: 'si-2-6467', name: '2', description: '2nd pass', color: '#0891b2' },
      { id: 'si-3-165', name: '3', description: '3rd pass', color: '#059669' },
      { id: 'si-4-3785', name: '4', description: '4th pass', color: '#d97706' },
      { id: 'si-5-5352', name: '5', description: '5th pass', color: '#dc2626' },
    ]
  },
  {
    id: 'sc-site-type', name: 'Site Types', categoryType: 'site_type',
    items: [
      { id: 'st-cbd-5119', name: 'CBD', description: 'Central business district', color: '#7c3aed' },
      { id: 'st-industrial-1254', name: 'Industrial', description: 'Industrial zone', color: '#0891b2' },
      { id: 'si-residential-8967', name: 'Residential', description: 'Residential area', color: '#059669' },
      { id: 'si-rural-5505', name: 'Rural', description: 'Rural or semi-rural area', color: '#65a30d' },
      { id: 'si-local-9168', name: 'Local', description: 'Local roads and streets', color: '#d97706' },
    ]
  },
  {
    id: 'sc-file-attach', name: 'File Attachment Types', categoryType: 'file_attachment',
    items: [
      { id: 'si-tmp-3526', name: 'TMP', description: 'Traffic Management Plan', color: '#4f46e5' },
      { id: 'si-jsa-923', name: 'JSA', description: 'Job Safety Analysis', color: '#dc2626' },
      { id: 'si-permit-3942', name: 'Permit', description: 'Work permit or authorisation', color: '#d97706' },
      { id: 'si-tip-site-2648', name: 'Tip Site', description: 'Tip site documentation', color: '#6b7280' },
      { id: 'si-water-point-5260', name: 'Water Point', description: 'Water point location or access', color: '#0891b2' },
      { id: 'si-photo-2780', name: 'Photo', description: 'Site or job photograph', color: '#059669' },
      { id: 'si-report-9302', name: 'Report', description: 'Job or inspection report', color: '#7c3aed' },
      { id: 'si-other-5945', name: 'Other', description: 'Other file type', color: '#92400e' },
    ]
  },
  {
    id: 'sc-weather', name: 'Weather Conditions', categoryType: 'weather',
    items: [
      { id: 'si-☀️-clear-3896', name: '☀️ Clear', description: 'Clear skies', color: '#d97706' },
      { id: 'si-☁️-cloudy-5768', name: '☁️ Cloudy', description: 'Overcast / cloudy', color: '#6b7280' },
      { id: 'si-🌦-light-rain-9806', name: '🌦 Light Rain', description: 'Light rain or drizzle', color: '#0891b2' },
      { id: 'si-🌧-heavy-rain-6301', name: '🌧 Heavy Rain', description: 'Heavy rain', color: '#1d4ed8' },
      { id: 'si-💨-windy-2666', name: '💨 Windy', description: 'Strong wind conditions', color: '#7c3aed' },
    ]
  },
  {
    id: 'sc-debris-level', name: 'Debris Levels', categoryType: 'debris_level',
    items: [
      { id: 'si-light-2218', name: 'Light', description: 'Minimal debris on road', color: '#059669' },
      { id: 'si-moderate-3292', name: 'Moderate', description: 'Moderate debris present', color: '#d97706' },
      { id: 'si-heavy-4952', name: 'Heavy', description: 'Heavy debris — multiple passes likely needed', color: '#dc2626' },
    ]
  },
  {
    id: 'sc-extra-expense', name: 'Extra Expenses', categoryType: 'extra_expense',
    items: [
      { id: 'si-🍔-food-and-meals-3681', name: '🍔 Food & Meals', description: 'Crew meals or food costs', color: '#d97706' },
      { id: 'si-🔧-parts-7594', name: '🔧 Parts', description: 'Equipment parts or repairs', color: '#0891b2' },
      { id: 'si-🛢️-oil---lubricants-7694', name: '🛢️ Oil / Lubricants', description: 'Engine oil, hydraulic fluid', color: '#6b7280' },
      { id: 'si-⛽-other-fuel-6151', name: '⛽ Other Fuel', description: 'Additional fuel not on main docket', color: '#059669' },
      { id: 'si-🚗-vehicle-costs-3932', name: '🚗 Vehicle Costs', description: 'Parking, tolls, etc.', color: '#7c3aed' },
      { id: 'si-📦-supplies-5880', name: '📦 Supplies', description: 'Consumables and materials', color: '#be185d' },
      { id: 'si-⚠️-other-5257', name: '⚠️ Other', description: 'Any other expense', color: '#dc2626' },
    ]
  },
  {
    id: 'sc-site-map-pin', name: 'Job Site Map Pins', categoryType: 'job_site_map_pin',
    items: [
      { id: 'si-water-point-1001', name: '💧 Water Point',  description: 'Water pickup or fill location', color: '#0891b2' },
      { id: 'si-tip-site-1002',   name: '🗑️ Tip Site',     description: 'Waste tip or dump site',        color: '#6b7280' },
      { id: 'si-hazard-1003',     name: '⚠️ Hazard',       description: 'Known hazard or risk area',      color: '#dc2626' },
      { id: 'si-access-1004',     name: '🚪 Access Point', description: 'Site access or entry point',     color: '#059669' },
      { id: 'si-other-1005',      name: '📍 Other',        description: 'Other point of interest',        color: '#7c3aed' },
    ]
  },
];

// ── SweepCategory de-duplication / clean-up ──────────────────────────────────
// BUG HISTORY: older app builds (pre-v58) sometimes (a) re-seeded the full set
// of default SW Category lists on every fresh load instead of only once, and
// (b) — specifically for Damage Types — split each item out into its own
// empty "list" (e.g. a category named "Pothole" with 0 items) instead of
// adding it as an item inside the single "Damage Types" list. Repeated sync
// cycles then kept ADDING these to the server/other devices forever, because
// the merge logic matches records by id and never recognises duplicates.
// This function repairs both problems, and is safe to run on every load/sync:
//   1. Drops empty "husk" categories (0 items) when a real list of the same
//      categoryType already has items — no data is lost since there was
//      nothing inside them.
//   2. Removes byte-identical duplicate categories (same categoryType + name
//      + items), keeping the oldest one.
//   3. Folds remaining categories that share the same categoryType + name
//      into a single record, unioning their items by name (case-insensitive).
function stripEmoji(name: string): string {
  return name.replace(/^(\p{Emoji}\uFE0F?|[\u{1F300}-\u{1FAFF}])\s*/u, '').trim().toLowerCase();
}

function itemsSignature(items: import('./types').SweepCategoryItem[]): string {
  return items
    .map(i => `${stripEmoji(i.name)}|${i.description || ''}|${i.color || ''}`)
    .sort()
    .join('::');
}

function consolidateSweepCategories(cats: import('./types').SweepCategory[]): import('./types').SweepCategory[] {
  if (!Array.isArray(cats) || cats.length === 0) return cats;

  // BUG FIX (v59.13): records whose categoryType was missing/empty (from very old
  // app builds, partial imports, or historical sync corruption) were silently
  // EXCLUDED from the output of this function entirely — `continue` below meant
  // they never made it into `result`. Because this function runs on every load
  // and after every push, the next push would then send a sweepCategories array
  // that simply never included that record again. The SERVER, however, still had
  // its own (possibly also-corrupted) copy of that id sitting in its data file —
  // and since the app stopped including it, there was no way for a fresh push to
  // ever overwrite or repair it. The record was permanently stuck showing
  // "Custom (0 items)" on the server dashboard even when the app's local copy
  // (under a different, healthy record) had the real items.
  //
  // Fix: instead of dropping untyped records, REPAIR them — match the record's
  // name against the known default category labels (case-insensitive) and
  // re-assign the correct categoryType. If no match is found, fall back to
  // categoryType 'custom' so the record is preserved as a genuine custom list
  // rather than disappearing. This guarantees every record always has a valid
  // categoryType before it's grouped/pushed, so the next sync can finally heal
  // any corrupted same-id record sitting on the server.
  // v59.16: collapse internal whitespace too, same reasoning as the server-side
  // mirror of this repair — exact match only, no fuzzy/word-subset guessing.
  const normCatName = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const NAME_TO_TYPE = new Map<string, import('./types').SweepCategory['categoryType']>(
    DEFAULT_SWEEP_CATEGORIES.map(d => [normCatName(d.name), d.categoryType])
  );
  // v71.0 BUG FIX: name-matching alone permanently fails once a user renames a
  // built-in list (e.g. "Damage Types" -> "Damage and points of interest" via
  // the Rename feature) — the record's `name` no longer matches any default
  // label, so a corrupted/blank categoryType could never be healed again, and
  // the record stayed mislabelled "Custom" forever regardless of how many times
  // this function ran. Since the 15 built-in lists (v73.51: zone_kind added) always keep their FIXED id
  // (sc-debris-type, sc-damage-type, etc.) even after a rename, matching by id
  // first is fully reliable and rename-proof. Only falls through to name-matching
  // (for id-less/legacy records) and then 'custom' if id isn't a recognised default.
  const ID_TO_TYPE = new Map<string, import('./types').SweepCategory['categoryType']>(
    DEFAULT_SWEEP_CATEGORIES.map(d => [d.id, d.categoryType])
  );
  // v59.17: also re-check records already stuck on categoryType 'custom' — an
  // earlier corrupted push (before this exact/whitespace matching existed) may
  // have permanently hard-set 'custom' on a record whose name is actually an
  // exact default-label match. See server.js applyMigrations() v59.17 for the
  // full reasoning (same fix, mirrored client-side).
  const repaired = cats.map(c => {
    if (!c) return c;
    const byId = ID_TO_TYPE.get(c.id);
    if (byId && c.categoryType !== byId) {
      return { ...c, categoryType: byId };
    }
    if (!c.categoryType) {
      const inferred = NAME_TO_TYPE.get(normCatName(c.name || ''));
      return { ...c, categoryType: inferred || 'custom' };
    }
    if (c.categoryType === 'custom') {
      const inferred = NAME_TO_TYPE.get(normCatName(c.name || ''));
      if (inferred) return { ...c, categoryType: inferred };
    }
    return c;
  });

  // Group by categoryType so we never merge across different list types.
  const byType = new Map<string, import('./types').SweepCategory[]>();
  for (const c of repaired) {
    if (!c || !c.categoryType) continue;
    const arr = byType.get(c.categoryType) || [];
    arr.push(c);
    byType.set(c.categoryType, arr);
  }

  const result: import('./types').SweepCategory[] = [];

  for (const [, group] of byType) {
    // Step 1 — drop empty husks ONLY when a sibling of the same type has items
    // AND the empty record is OLDER than (or same age as) the newest populated sibling.
    //
    // WHY THE TIMESTAMP CHECK IS REQUIRED:
    //   The grouped SW Categories view (v58.6+) lets users create multiple lists per
    //   categoryType (e.g. two "Crew Members" lists). When a user taps "+ New List",
    //   the list starts with 0 items. Without the timestamp check, the very next
    //   page reload or sync would call consolidateSweepCategories and silently delete
    //   the brand-new list — because a sibling (the default list) already has items.
    //   The result: new lists disappear before the user can add anything to them,
    //   and the change is never pushed to the server, so backups never see it either.
    //
    //   The fix mirrors server-side dropEmptyCategoryHusks: only drop an empty record
    //   if its timestamp is OLDER THAN the newest populated sibling.  A newer-timestamped
    //   empty record means the user deliberately created (or cleared) it recently.
    //
    // PORTING NOTE FOR FUTURE CHANGES:
    //   Any change to this step must stay in sync with dropEmptyCategoryHusks() in
    //   host-server/sync-server/server.js — they must use identical drop conditions or
    //   the client and server will disagree and fight over category records every sync.
    const newestPopulatedAt = group.reduce((best, c) => {
      if (c.items.length === 0) return best;
      const t = c.updatedAt || c.createdAt || '';
      return t > best ? t : best;
    }, '');

    let working: import('./types').SweepCategory[];
    if (newestPopulatedAt === '') {
      // No populated sibling exists yet — keep all records (nothing to lose)
      working = group;
    } else {
      // Keep: all populated records + empty records NEWER than the newest populated sibling
      // Drop: empty records that are older than (or same age as) the newest populated sibling
      working = group.filter(c => {
        if (c.items.length > 0) return true;
        const emptyAt = c.updatedAt || c.createdAt || '';
        return emptyAt > newestPopulatedAt; // newer empty → user just created it → keep
      });
    }
    if (working.length === 0) working = group; // safety: never end up with zero categories for a type

    // Step 2 — drop byte-identical duplicates (same name + same item signature),
    // keeping the earliest-created / fixed-id ("sc-...") record.
    const dedupKey = (c: import('./types').SweepCategory) =>
      `${c.name.trim().toLowerCase()}::${itemsSignature(c.items)}`;
    const dedupMap = new Map<string, import('./types').SweepCategory>();
    for (const c of working) {
      const key = dedupKey(c);
      const existing = dedupMap.get(key);
      if (!existing) { dedupMap.set(key, c); continue; }
      const existingIsFixed = existing.id.startsWith('sc-');
      const currentIsFixed  = c.id.startsWith('sc-');
      const existingTime = existing.createdAt || '';
      const currentTime  = c.createdAt || '';
      const preferCurrent = (currentIsFixed && !existingIsFixed)
        || (currentIsFixed === existingIsFixed && currentTime && existingTime && currentTime < existingTime);
      if (preferCurrent) dedupMap.set(key, c);
    }
    const deduped = Array.from(dedupMap.values());

    // Step 3 — fold remaining same-name lists into one, unioning items by name.
    const byName = new Map<string, import('./types').SweepCategory>();
    for (const c of deduped) {
      const nameKey = c.name.trim().toLowerCase();
      const existing = byName.get(nameKey);
      if (!existing) { byName.set(nameKey, { ...c, items: [...c.items] }); continue; }
      const seen = new Set(existing.items.map(i => stripEmoji(i.name)));
      const merged = [...existing.items];
      for (const item of c.items) {
        const key = stripEmoji(item.name);
        if (!seen.has(key)) { seen.add(key); merged.push(item); }
      }
      const preferExistingId = existing.id.startsWith('sc-') || !c.id.startsWith('sc-');
      byName.set(nameKey, {
        ...(preferExistingId ? existing : c),
        items: merged,
        updatedAt: now(),
      });
    }

    result.push(...byName.values());
  }

  return result;
}

// ── Inspection Categories de-duplication / clean-up ─────────────────────────
// Exact mirror of consolidateSweepCategories but for the plain `categories`
// collection (Site & Road Inspections). Category uses `type` instead of
// `categoryType` but the bugs are identical:
//  - records with a missing/empty `type` were previously silently excluded
//    from outputs, so a corrupted record would vanish from every future push
//    while the server kept its own stale copy indefinitely
//  - no dedup/fold pass existed for `categories` at all before this fix
function consolidateCategories(cats: Category[]): Category[] {
  if (!Array.isArray(cats) || cats.length === 0) return cats;

  // Build name→type repair map from the known defaults
  const NAME_TO_TYPE = new Map<string, Category['type']>(
    DEFAULT_CATEGORIES.map(d => [d.name.trim().toLowerCase(), d.type])
  );
  // v71.0: id-based repair first — rename-proof, mirrors the sweepCategories fix.
  const ID_TO_TYPE = new Map<string, Category['type']>(
    DEFAULT_CATEGORIES.map(d => [d.id, d.type])
  );

  // Repair records with missing/empty `type`
  const repaired = cats.map(c => {
    if (!c) return c;
    const byId = ID_TO_TYPE.get(c.id);
    if (byId && c.type !== byId) return { ...c, type: byId };
    if (!c.type) {
      const inferred = NAME_TO_TYPE.get((c.name || '').trim().toLowerCase());
      return { ...c, type: inferred || ('custom' as Category['type']) };
    }
    return c;
  });

  // Group by type
  const byType = new Map<string, Category[]>();
  for (const c of repaired) {
    if (!c || !c.type) continue;
    const arr = byType.get(c.type) || [];
    arr.push(c);
    byType.set(c.type, arr);
  }

  const result: Category[] = [];

  for (const [, group] of byType) {
    // Drop empty husks when a populated sibling exists AND the empty is older
    const newestPopulatedAt = group.reduce((best, c) => {
      if (!c.items || c.items.length === 0) return best;
      const t = c.updatedAt || c.createdAt || '';
      return t > best ? t : best;
    }, '');

    let working: Category[];
    if (newestPopulatedAt === '') {
      working = group;
    } else {
      working = group.filter(c => {
        if (c.items && c.items.length > 0) return true;
        const emptyAt = c.updatedAt || c.createdAt || '';
        return emptyAt > newestPopulatedAt;
      });
    }
    if (working.length === 0) working = group;

    // Dedupe byte-identical records (same name + same items), prefer stable `cat-` ids
    const dedupKey = (c: Category) =>
      `${c.name.trim().toLowerCase()}::${(c.items || []).map(i => `${i.name}|${i.description||''}|${i.color||''}`).sort().join('::')}`;
    const dedupMap = new Map<string, Category>();
    for (const c of working) {
      const key = dedupKey(c);
      const existing = dedupMap.get(key);
      if (!existing) { dedupMap.set(key, c); continue; }
      const existingIsFixed = existing.id.startsWith('cat-');
      const currentIsFixed  = c.id.startsWith('cat-');
      const existingTime = existing.createdAt || '';
      const currentTime  = c.createdAt || '';
      const preferCurrent = (currentIsFixed && !existingIsFixed)
        || (currentIsFixed === existingIsFixed && currentTime && existingTime && currentTime < existingTime);
      if (preferCurrent) dedupMap.set(key, c);
    }
    const deduped = Array.from(dedupMap.values());

    // Fold remaining same-name lists into one, unioning items by name
    const byName = new Map<string, Category>();
    for (const c of deduped) {
      const nameKey = c.name.trim().toLowerCase();
      const existing = byName.get(nameKey);
      if (!existing) { byName.set(nameKey, { ...c, items: [...(c.items || [])] }); continue; }
      const seen = new Set((existing.items || []).map(i => i.name.trim().toLowerCase()));
      const merged = [...(existing.items || [])];
      for (const item of (c.items || [])) {
        if (!seen.has(item.name.trim().toLowerCase())) {
          seen.add(item.name.trim().toLowerCase());
          merged.push(item);
        }
      }
      const preferExistingId = existing.id.startsWith('cat-') || !c.id.startsWith('cat-');
      byName.set(nameKey, {
        ...(preferExistingId ? existing : c),
        items: merged,
        updatedAt: now(),
      });
    }

    result.push(...byName.values());
  }

  return result;
}

const DEFAULT_ADMIN: User = {
  id: uid(), name: 'Admin', email: 'admin',
  role: 'admin', password: 'admin123', createdAt: now(), active: true
};

// v73.134 — Craig: a brand-new install (e.g. a fresh phone with the Android
// app, which has its own separate local data — see android/README.md) only
// ever had the seeded admin account, with no obvious way to get a driver
// account onto the device without first logging in as admin and using the
// Users page. Seeding a default driver account alongside DEFAULT_ADMIN
// means a fresh device already has both ready to go. Same security posture
// as DEFAULT_ADMIN itself (a well-known default meant to be changed) —
// Craig should change/remove this password once real driver accounts are
// set up, same as he'd want to for the admin default.
const DEFAULT_DRIVER: User = {
  id: uid(), name: 'Driver', email: 'driver',
  role: 'driver', password: 'driver123', createdAt: now(), active: true
};

// BUG FIX / FEATURE (Craig-requested, v73.11): removed the "Email" field from
// Add New User — logins are now a plain username (still stored in the
// `email` property internally to avoid a wider rename, see the User type
// comment), not required to look like an email address. The previous
// default admin account used email:'admin@inspection.com' as its login —
// changing that default alone would do nothing for anyone who already has
// data (IndexedDB persists across app updates; only a brand-new empty
// install ever uses DEFAULT_ADMIN), and Craig said outright "I won't be able
// to log back in" once that format stopped being expected. This migrates any
// EXISTING user whose login is still the exact old default
// ('admin@inspection.com') to the new plain 'admin' — but only if nothing
// else already uses that as a login, so it can never silently create a
// collision. Anyone who already customized their admin login away from the
// old default is left untouched (their login already isn't the exact string
// being matched here).
const OLD_DEFAULT_ADMIN_EMAIL = 'admin@inspection.com';
const NEW_DEFAULT_ADMIN_EMAIL = 'admin';
function migrateDefaultAdminLogin(users: User[]): User[] {
  if (!Array.isArray(users) || users.length === 0) return users;
  const hasOldDefault = users.some(u => u.email === OLD_DEFAULT_ADMIN_EMAIL);
  if (!hasOldDefault) return users;
  const collision = users.some(u => u.email === NEW_DEFAULT_ADMIN_EMAIL);
  if (collision) return users; // something already uses 'admin' as a login — don't touch anything, avoid ambiguity
  return users.map(u => u.email === OLD_DEFAULT_ADMIN_EMAIL ? { ...u, email: NEW_DEFAULT_ADMIN_EMAIL, updatedAt: now() } : u);
}

// ── IndexedDB helpers — replaces localStorage for rsw_data ───────────────────
// localStorage is capped at ~5-10 MB by every browser regardless of disk size.
// IndexedDB uses real disk space (browsers allocate up to ~60-80% of free disk).

const IDB_NAME    = 'rsw-field-app';
const IDB_VERSION = 1;
const IDB_STORE   = 'app-data';
const DATA_KEY    = 'rsw_data';

// ── Singleton IDB connection ─────────────────────────────────────────────────
// Opening a new connection on EVERY read/write causes iOS Safari and some
// Android browsers to block or silently fail, losing all saves.
// We keep one connection alive for the lifetime of the page.
let _idbConn: IDBDatabase | null = null;
let _idbConnecting: Promise<IDBDatabase> | null = null;

function openIDB(): Promise<IDBDatabase> {
  // Return existing live connection
  if (_idbConn && !(_idbConn as any)._closed) return Promise.resolve(_idbConn);
  // Return in-flight connection promise (prevents parallel open calls)
  if (_idbConnecting) return _idbConnecting;

  _idbConnecting = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = (e) => {
      _idbConn = (e.target as IDBOpenDBRequest).result;
      // If connection closes unexpectedly, clear so next call re-opens it
      _idbConn.onclose       = () => { _idbConn = null; _idbConnecting = null; };
      _idbConn.onversionchange = () => { _idbConn?.close(); _idbConn = null; _idbConnecting = null; };
      _idbConnecting = null;
      resolve(_idbConn);
    };
    req.onerror   = () => { _idbConnecting = null; reject(req.error); };
    req.onblocked = () => { _idbConnecting = null; reject(new Error('IndexedDB blocked')); };
  });
  return _idbConnecting;
}

async function idbGet(key: string): Promise<string | null> {
  try {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(req.error);
    });
  } catch { return null; }
}

// ── Debounced write queue ────────────────────────────────────────────────────
// Batches rapid successive saves (e.g. typing in a form) into one IDB write.
// Also provides localStorage fallback if IDB is unavailable.
let _pendingData: string | null = null;
let _writeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdbWrite(key: string, value: string): void {
  _pendingData = value;
  if (_writeTimer) clearTimeout(_writeTimer);
  _writeTimer = setTimeout(async () => {
    const toWrite = _pendingData;
    _pendingData = null;
    _writeTimer = null;
    if (!toWrite) return;
    try {
      const db = await openIDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(toWrite, key);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
      });
      // Mirror to localStorage as a belt-and-suspenders backup (up to its cap)
      try { localStorage.setItem(key, toWrite); } catch { /* ls full — idb is primary */ }
      notifyOtherTabsDataChanged();
    } catch (err) {
      // IDB failed — fall back to localStorage directly
      console.warn('[RSW] IDB write failed, falling back to localStorage:', err);
      try {
        localStorage.setItem(key, toWrite);
        notifyOtherTabsDataChanged();
      } catch {
        window.dispatchEvent(new CustomEvent('storage-error', {
          detail: 'Storage full! Export a backup from Backup & Sync, then delete old photos or inspections to free space.'
        }));
      }
    }
  }, 150); // 150ms debounce — fast enough to feel instant, slow enough to batch
}

async function idbSet(key: string, value: string): Promise<void> {
  scheduleIdbWrite(key, value);
}

// ── Immediate (non-debounced) write — used ONLY when the page is about to be
// hidden/closed/backgrounded and there's no time left to wait out the normal
// 150ms debounce (see scheduleIdbWrite above). Cancels any pending debounced
// write and performs the IDB put directly, right now, in this call stack —
// still async under the hood (IDB has no sync API) but starts immediately
// instead of being queued behind a setTimeout that a backgrounded/killed
// page may never get to run. This is the actual fix for saves silently not
// persisting: the old "flush on pagehide" call went through saveData() →
// idbSet() → scheduleIdbWrite(), which ALWAYS re-armed a fresh 150ms
// setTimeout regardless of urgency — on a page that's being torn down,
// mobile Safari/Chrome do not guarantee that timer ever fires.
async function flushIdbWriteNow(key: string, value: string): Promise<void> {
  if (_writeTimer) { clearTimeout(_writeTimer); _writeTimer = null; }
  _pendingData = null;
  try {
    const db = await openIDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
    try { localStorage.setItem(key, value); } catch { /* ls full — idb is primary */ }
    notifyOtherTabsDataChanged();
  } catch (err) {
    console.warn('[RSW] Immediate IDB flush failed, falling back to localStorage:', err);
    try {
      localStorage.setItem(key, value);
      notifyOtherTabsDataChanged();
    } catch {
      window.dispatchEvent(new CustomEvent('storage-error', {
        detail: 'Storage full! Export a backup from Backup & Sync, then delete old photos or inspections to free space.'
      }));
    }
  }
}

function getDefaultData(): AppData {
  return {
    users: [DEFAULT_ADMIN, DEFAULT_DRIVER], clients: [], inspections: [], maps: [],
    categories: DEFAULT_CATEGORIES, reports: [], coverTemplates: [],
    sweepAreas: [], sweepRoads: [], sweepZones: [], sweepJobs: [],
    sweepClients: [], sweepJobSites: [], sweepFiles: [],
    sweepCategories: DEFAULT_SWEEP_CATEGORIES, sweepMaps: [], sweepReports: [],
  };
}

async function loadData(): Promise<AppData> {
  try {
    // 1. Try IndexedDB (primary store)
    let d = await idbGet(DATA_KEY);

    // 2. If nothing in IDB, check localStorage (one-time migration OR IDB fallback)
    if (!d) {
      const legacy = localStorage.getItem('rsw_data');
      if (legacy) {
        d = legacy;
        // Mirror into IDB for future reads (don't remove from ls — it's our backup)
        scheduleIdbWrite(DATA_KEY, legacy);
      }
    }

    if (d) {
      const parsed = JSON.parse(d);
      const reports: Report[] = Array.isArray(parsed.reports) ? parsed.reports : [];
      const migratedReports = reports.map((r: Report) =>
        r.updatedAt ? r : { ...r, updatedAt: r.createdAt || now() }
      );
      // Migrate sweepAreas — add zoneType/roadIds if missing
      const sweepAreas = (Array.isArray(parsed.sweepAreas) ? parsed.sweepAreas : []).map(
        (a: SweepArea) => ({ ...a, zoneType: a.zoneType ?? '', roadIds: Array.isArray(a.roadIds) ? a.roadIds : [] })
      );
      // Migrate sweepJobs — add all fields introduced through v29–v35
      const sweepJobs = (Array.isArray(parsed.sweepJobs) ? parsed.sweepJobs : []).map(
        (j: SweepJob) => ({
          ...j,
          siteId:        j.siteId        ?? '',
          zoneIds:       Array.isArray(j.zoneIds)       ? j.zoneIds       : [], // v73.51
          fileIds:       Array.isArray(j.fileIds)       ? j.fileIds       : [],
          equipment:     j.equipment     ?? '',
          fuelDockets:   Array.isArray(j.fuelDockets)   ? j.fuelDockets   : [],
          extraExpenses: Array.isArray(j.extraExpenses)  ? j.extraExpenses  : [],
          tipRuns:       Array.isArray(j.tipRuns)        ? j.tipRuns        : [],
          // Ensure every road has damagePins[] (added in v58)
          roads: Array.isArray(j.roads) ? j.roads.map((r: any) => ({
            ...r,
            damagePins: Array.isArray(r.damagePins) ? r.damagePins : [],
          })) : [],
        })
      );
      return {
        users:           migrateDefaultAdminLogin(Array.isArray(parsed.users) ? parsed.users : [DEFAULT_ADMIN, DEFAULT_DRIVER]),
        clients:         Array.isArray(parsed.clients)         ? parsed.clients         : [],
        inspections:     Array.isArray(parsed.inspections)     ? parsed.inspections     : [],
        maps:            Array.isArray(parsed.maps)            ? parsed.maps            : [],
        categories:      Array.isArray(parsed.categories)
          ? consolidateCategories(parsed.categories)
          : DEFAULT_CATEGORIES,
        reports:         migratedReports,
        coverTemplates:  Array.isArray(parsed.coverTemplates)  ? parsed.coverTemplates  : [],
        sweepAreas,
        sweepRoads:      Array.isArray(parsed.sweepRoads)      ? parsed.sweepRoads      : [],
        sweepZones:      Array.isArray(parsed.sweepZones)      ? parsed.sweepZones      : [],
        sweepJobs,
        sweepClients:    Array.isArray(parsed.sweepClients)    ? parsed.sweepClients    : [],
        sweepJobSites:   Array.isArray(parsed.sweepJobSites) ? parsed.sweepJobSites.map((s: any) => {
          // Migrate legacy sitePins → mapPins
          const mapPins = s.mapPins ?? (s.sitePins ?? []);
          const { sitePins: _discard, ...rest } = s;
          return { mapPins, ...rest };
        }) : [],
        sweepFiles:      Array.isArray(parsed.sweepFiles)      ? parsed.sweepFiles      : [],
        sweepCategories: (() => {
          const raw = Array.isArray(parsed.sweepCategories) ? parsed.sweepCategories : DEFAULT_SWEEP_CATEGORIES;
          // FIX: include ALL known categoryTypes so defaults are always backfilled on load
          const allTypes = ['site_type','file_attachment','weather','debris_level','damage_severity','damage_type','extra_expense','job_site_map_pin','debris_type','zone_type','zone_kind','frequency','crew_member','equipment','pass_count']; // v73.51: zone_kind added — was missing since v73.46, the root cause of "No zone kinds list found"
          // Also ensure crew_member and equipment have items (populate from defaults if empty)
          const migrated = raw.map((c: import('./types').SweepCategory) => {
            if ((c.categoryType === 'crew_member' || c.categoryType === 'equipment') && c.items.length === 0) {
              const def = DEFAULT_SWEEP_CATEGORIES.find(d => d.categoryType === c.categoryType);
              return def ? { ...c, items: def.items } : c;
            }
            return c;
          });
          const missing = allTypes.filter(t => !migrated.some((c: import('./types').SweepCategory) => c.categoryType === t));
          const withDefaults = [...migrated, ...DEFAULT_SWEEP_CATEGORIES.filter(c => missing.includes(c.categoryType))];
          // FIX: clean up duplicate/empty-husk categories left behind by older
          // app builds (see consolidateSweepCategories for full history).
          return consolidateSweepCategories(withDefaults);
        })(),
        sweepMaps:       Array.isArray(parsed.sweepMaps)       ? parsed.sweepMaps       : [],
        sweepReports:    Array.isArray(parsed.sweepReports)    ? parsed.sweepReports    : [],
      };
    }
  } catch { /* corrupted */ }
  return getDefaultData();
}

async function saveData(data: AppData): Promise<void> {
  try {
    await idbSet(DATA_KEY, JSON.stringify(data));
  } catch {
    window.dispatchEvent(new CustomEvent('storage-error', {
      detail: 'Storage full! Export a backup immediately from Backup & Sync, then delete old data or photos to free space.'
    }));
  }
}

// Immediate variant of saveData — see flushIdbWriteNow() for why this exists
// and is NOT the same as calling saveData() from a pagehide/visibilitychange
// handler.
async function flushSaveDataNow(data: AppData): Promise<void> {
  try {
    await flushIdbWriteNow(DATA_KEY, JSON.stringify(data));
  } catch {
    window.dispatchEvent(new CustomEvent('storage-error', {
      detail: 'Storage full! Export a backup immediately from Backup & Sync, then delete old data or photos to free space.'
    }));
  }
}

// ── Server-deletion detection (v71.5) ────────────────────────────────────────
// Replaces the old auto-delete tombstone system. Instead of the server
// silently telling the app "these ids were deleted, remove them," the app now
// remembers which ids it last confirmed were present on the server, and
// compares that against each new Pull & Merge response. Any local record
// whose id WAS confirmed on the server before but is now missing is a
// candidate: it was manually deleted on the server (or another device),
// and the user gets asked whether to also delete it locally or keep it.
// Brand-new local records that were never pushed are never flagged, since
// they were never in the "known server ids" set to begin with.
const KNOWN_SERVER_IDS_KEY = 'rsw_known_server_ids';

function loadKnownServerIds(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(KNOWN_SERVER_IDS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function saveKnownServerIds(map: Record<string, string[]>): void {
  try { localStorage.setItem(KNOWN_SERVER_IDS_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

// ── Local (device-side) tombstones (v73.48) ──────────────────────────────────
// Craig: "old deleted files are being restored in the app... after docker
// rebuild." Independent of the sync server's own tombstone list (which lives
// in server data and can be lost/reset by a volume change or a rebuild),
// this device now keeps its OWN record of what it deleted, purely locally —
// see the addLocalTombstone() call site below and mergeServerDataIntoLocal's
// own comment for why this is the thing that actually stops resurrection.
export interface LocalTombstone { collection: string; id: string; label: string; deletedAt: string; }
const LOCAL_TOMBSTONES_KEY = 'rsw_local_tombstones';
const LOCAL_TOMBSTONE_MAX = 5000; // hard cap so this can't grow unbounded on a device with heavy churn

function loadLocalTombstones(): LocalTombstone[] {
  try {
    const raw = localStorage.getItem(LOCAL_TOMBSTONES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveLocalTombstones(list: LocalTombstone[]): void {
  try { localStorage.setItem(LOCAL_TOMBSTONES_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

function addLocalTombstone(collection: string, id: string, label: string): void {
  const list = loadLocalTombstones();
  if (list.some(t => t.collection === collection && t.id === id)) return; // already recorded
  list.push({ collection, id, label, deletedAt: new Date().toISOString() });
  // Cap from the oldest end — a device that's been in use a long time
  // shouldn't accumulate this forever; recent deletes matter most for
  // catching a resurrection right after it happens.
  while (list.length > LOCAL_TOMBSTONE_MAX) list.shift();
  saveLocalTombstones(list);
}

function localTombstoneIdSet(): Set<string> {
  return new Set(loadLocalTombstones().map(t => `${t.collection}:${t.id}`));
}

// Exposed for the App Health page — mirrors the host-server's own age-based
// tombstone prune (same safeguard: this only ever removes entries from this
// device's local "don't resurrect" list, never touches actual app data, and
// never affects the server's own tombstones).
export function getLocalTombstones(): LocalTombstone[] {
  return loadLocalTombstones().slice().sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export function pruneLocalTombstones(olderThanDays: number): { removedCount: number; remaining: number } {
  const list = loadLocalTombstones();
  const before = list.length;
  if (olderThanDays <= 0) {
    saveLocalTombstones([]);
    return { removedCount: before, remaining: 0 };
  }
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const kept = list.filter(t => t.deletedAt >= cutoff);
  saveLocalTombstones(kept);
  return { removedCount: before - kept.length, remaining: kept.length };
}

// Best-effort human-readable label for a record, for the confirmation dialog.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function labelForRecord(rec: any): string {
  return rec?.name || rec?.title || rec?.jobNumber || rec?.filename || rec?.email || rec?.id || 'Untitled';
}

// ── Client-side merge helpers — mirror server merge logic exactly ───────────
// v71.9 BUG FIX: pushToServer() was found doing a raw overwrite of local data
// with the server's response (`merged[k] = raw[k]`) instead of merging —
// exactly the "Push & Sync deletes local data that isn't on the server yet"
// bug from an earlier round, which had regressed back in during a branch
// port. These helpers used to be redefined inline inside pullFromServer only;
// promoting them to module scope lets BOTH pushToServer and pullFromServer
// merge every response the same safe, additive way — local-only records can
// no longer be dropped by either sync direction.
const unionStrings = (a: string[], b: string[]): string[] =>
  [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unionById = <T extends { id?: string }>(winner: T[], loser: T[]): T[] => {
  const map = new Map<string, T>();
  for (const x of (Array.isArray(loser)  ? loser  : [])) if (x?.id) map.set(x.id, x);
  for (const x of (Array.isArray(winner) ? winner : [])) if (x?.id) map.set(x.id, x);
  return Array.from(map.values());
};

const mergeRecord = <T extends { id: string; updatedAt?: string; createdAt?: string }>(
  server: T, local: T
): { winner: T; loser: T } => {
  const st = server.updatedAt || server.createdAt || '';
  const lt = local.updatedAt  || local.createdAt  || '';
  return lt >= st
    ? { winner: local,  loser: server }
    : { winner: server, loser: local  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mergeArrays = <T extends { id: string; updatedAt?: string; createdAt?: string }>(
  serverArr: T[], localArr: T[]
): T[] => {
  const map = new Map<string, T>();
  for (const item of (serverArr || [])) { if (item?.id) map.set(item.id, item); }
  for (const item of (localArr || [])) {
    if (!item?.id) continue;
    const existing = map.get(item.id);
    if (!existing) { map.set(item.id, item); continue; }
    const { winner, loser } = mergeRecord(existing, item);
    map.set(item.id, { ...loser, ...winner });
  }
  return Array.from(map.values());
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mergeInspections = (serverArr: any[], localArr: any[]): any[] => {
  const map = new Map<string, any>();
  for (const item of (serverArr || [])) { if (item?.id) map.set(item.id, item); }
  for (const item of (localArr || [])) {
    if (!item?.id) continue;
    const existing = map.get(item.id);
    if (!existing) { map.set(item.id, item); continue; }
    const { winner, loser } = mergeRecord(existing, item);
    map.set(item.id, {
      ...loser, ...winner,
      photos:   unionById(winner.photos   || [], loser.photos   || []),
      comments: unionById(winner.comments || [], loser.comments || []),
    });
  }
  return Array.from(map.values());
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mergeCategories = (serverArr: any[], localArr: any[]): any[] => {
  const map = new Map<string, any>();
  for (const item of (serverArr || [])) { if (item?.id) map.set(item.id, item); }
  for (const item of (localArr || [])) {
    if (!item?.id) continue;
    const existing = map.get(item.id);
    if (!existing) { map.set(item.id, item); continue; }
    const { winner, loser } = mergeRecord(existing, item);
    map.set(item.id, {
      ...loser, ...winner,
      items: unionById(winner.items || [], loser.items || []),
    });
  }
  return Array.from(map.values());
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mergeMaps = (serverArr: any[], localArr: any[]): any[] => {
  const map = new Map<string, any>();
  for (const item of (serverArr || [])) { if (item?.id) map.set(item.id, item); }
  for (const item of (localArr || [])) {
    if (!item?.id) continue;
    const existing = map.get(item.id);
    if (!existing) { map.set(item.id, item); continue; }
    const { winner, loser } = mergeRecord(existing, item);
    map.set(item.id, { ...loser, ...winner, pins: unionById(winner.pins || [], loser.pins || []) });
  }
  return Array.from(map.values());
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mergeSweepJobs = (serverArr: any[], localArr: any[]): any[] => {
  const map = new Map<string, any>();
  for (const item of (serverArr || [])) { if (item?.id) map.set(item.id, item); }
  for (const item of (localArr || [])) {
    if (!item?.id) continue;
    const existing = map.get(item.id);
    if (!existing) { map.set(item.id, item); continue; }
    const { winner, loser } = mergeRecord(existing, item);
    const roadsMap = new Map<string, any>();
    for (const r of (loser.roads  || [])) if (r?.roadId) roadsMap.set(r.roadId, r);
    for (const r of (winner.roads || [])) {
      if (!r?.roadId) continue;
      const ex = roadsMap.get(r.roadId);
      if (!ex) { roadsMap.set(r.roadId, r); continue; }
      // v73.9 — mirrors the equivalent server.js fix: segmentSettings
      // (SegmentRunDetail[], per-road per-job run data for multi-segment
      // roads — see utils/segmentStats.ts) has no `id` field, keyed by
      // `segIdx` instead, so it can't use unionById directly. Was previously
      // only shallow-spread (`{...ex, ...r}`), same silent-drop risk as
      // damagePins had before this file's own fix for that.
      const segMap = new Map<number, any>();
      for (const ss of (ex.segmentSettings || [])) if (typeof ss?.segIdx === 'number') segMap.set(ss.segIdx, ss);
      for (const ss of (r.segmentSettings  || [])) {
        if (typeof ss?.segIdx !== 'number') continue;
        const exSeg = segMap.get(ss.segIdx);
        segMap.set(ss.segIdx, exSeg ? { ...exSeg, ...ss } : ss);
      }
      roadsMap.set(r.roadId, {
        ...ex, ...r,
        damagePins: unionById(r.damagePins || [], ex.damagePins || []),
        segmentSettings: [...segMap.values()].sort((a, b) => a.segIdx - b.segIdx),
      });
    }
    const tipMap = new Map<string, any>();
    for (const t of (loser.tipRuns  || [])) if (t?.id) tipMap.set(t.id, t);
    for (const t of (winner.tipRuns || [])) {
      if (!t?.id) continue;
      const ex = tipMap.get(t.id);
      tipMap.set(t.id, ex ? { ...ex, ...t, trips: unionById(t.trips || [], ex.trips || []) } : t);
    }
    map.set(item.id, {
      ...loser, ...winner,
      roads:         Array.from(roadsMap.values()),
      fuelDockets:   unionById(winner.fuelDockets   || [], loser.fuelDockets   || []),
      extraExpenses: unionById(winner.extraExpenses || [], loser.extraExpenses || []),
      tipRuns:       Array.from(tipMap.values()),
      fileIds:       unionStrings(winner.fileIds  || [], loser.fileIds  || []),
      areaIds:       unionStrings(winner.areaIds  || [], loser.areaIds  || []),
    });
  }
  return Array.from(map.values());
};

// v73.39 — `unionById` (defined above) always takes the ROAD-level winner's
// copy of any segment id present on both sides — it doesn't look at each
// segment's OWN updatedAt at all. That's inconsistent with server.js's
// `mergeSubArrayById`, which resolves each item by its own recency. Now that
// segments carry a real `updatedAt` (see saveRoad() in SweepJobs.tsx), this
// client-side path should resolve the same way the server does, or a
// pull-then-push round trip could silently pick a different winner than the
// server already agreed on. Mirrors server.js's mergeSubArrayById exactly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unionSegmentsByRecency = (serverArr: any[], clientArr: any[]): any[] => {
  const map = new Map<string, any>();
  for (const item of (serverArr || [])) if (item?.id) map.set(item.id, item);
  for (const item of (clientArr || [])) {
    if (!item?.id) continue;
    const existing = map.get(item.id);
    if (!existing) { map.set(item.id, item); continue; }
    const st = existing.updatedAt || existing.createdAt || '';
    const ct = item.updatedAt || item.createdAt || '';
    map.set(item.id, ct >= st ? { ...existing, ...item } : { ...item, ...existing });
  }
  return Array.from(map.values());
};

// v73.9 — found via Craig's "check the host-server for anything dropping
// silently" audit request (a sibling session's fix, reconciled into this
// one): sweepRoads was using the generic mergeArrays (whole-record
// field-union) even though `segments` (RouteSegment[]) has its own per-item
// id and gets edited independently in the road editor — same risk class as
// maps.pins/sweepJobSites.mapPins, just missed because `points` (no
// per-point id, deliberately unmerged, see CLAUDE_CONTEXT.md) sits right
// next to it. Mirrors the equivalent server.js fix exactly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mergeSweepRoads = (serverArr: any[], localArr: any[]): any[] => {
  const map = new Map<string, any>();
  for (const item of (serverArr || [])) { if (item?.id) map.set(item.id, item); }
  for (const item of (localArr || [])) {
    if (!item?.id) continue;
    const existing = map.get(item.id);
    if (!existing) { map.set(item.id, item); continue; }
    const { winner, loser } = mergeRecord(existing, item);
    map.set(item.id, {
      ...loser, ...winner,
      segments: (winner.segments || loser.segments) ? unionSegmentsByRecency(winner.segments || [], loser.segments || []) : winner.segments,
    });
  }
  return Array.from(map.values());
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mergeSweepJobSites = (serverArr: any[], localArr: any[]): any[] => {
  const map = new Map<string, any>();
  for (const item of (serverArr || [])) { if (item?.id) map.set(item.id, item); }
  for (const item of (localArr || [])) {
    if (!item?.id) continue;
    const existing = map.get(item.id);
    if (!existing) { map.set(item.id, item); continue; }
    const { winner, loser } = mergeRecord(existing, item);
    map.set(item.id, {
      ...loser, ...winner,
      mapPins: unionById(winner.mapPins || [], loser.mapPins || []),
      fileIds: unionStrings(winner.fileIds || [], loser.fileIds || []),
      areaIds: unionStrings(winner.areaIds || [], loser.areaIds || []),
    });
  }
  return Array.from(map.values());
};

const MERGE_KNOWN_KEYS: string[] = [
  'users','clients','inspections','maps','categories','reports','coverTemplates',
  'sweepAreas','sweepRoads','sweepZones','sweepJobs','sweepClients','sweepJobSites',
  'sweepFiles','sweepCategories','sweepMaps','sweepReports',
];

// Applies the full set of collection-aware merges above between a server
// response and the current local data — used by BOTH pushToServer and
// pullFromServer so a sync in either direction can only add/update local
// data, never silently drop something the device already had.
function mergeServerDataIntoLocal(server: Partial<AppData>, local: AppData, localTombstoneIds?: Set<string>): AppData {
  const merged: AppData = { ...local };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const srv = server as any; const loc = local as any;
  // v73.48 — Craig: "old deleted files are being restored in the app...
  // after docker rebuild." Root cause: this function has always been purely
  // additive by design (v71.9 fix, see its own comment above) — anything
  // present in the server's response and not yet present locally gets added
  // in. That's correct for a record THIS device never had. But if THIS
  // device is the one that deleted a record, and it later reappears in the
  // server's response — because another device restored it, "Keep" was
  // clicked on it elsewhere, or (the case that matches "after docker
  // rebuild") the server's own tombstone list was lost/reset by a volume
  // change and a device that still held the old copy re-pushed it — this
  // device had absolutely nothing telling it not to silently re-add
  // something it had deliberately removed. Server-side tombstones can only
  // ever be as durable as the server's own data; they say nothing about
  // what THIS specific device intentionally deleted. Filtering the
  // server's response against this device's own local tombstone list
  // (recorded independently, see addLocalTombstone below) before any merge
  // runs means a record this device deleted can never silently reappear on
  // this device again, regardless of what happens server-side or on any
  // other device.
  if (localTombstoneIds && localTombstoneIds.size > 0) {
    for (const col of MERGE_KNOWN_KEYS) {
      const arr = srv[col] as { id: string }[] | undefined;
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const kept = arr.filter(r => !localTombstoneIds.has(`${col}:${r.id}`));
      if (kept.length !== arr.length) srv[col] = kept; // only replace when something was actually filtered
    }
  }
  merged.users           = mergeArrays(srv.users          || [], loc.users          || []);
  merged.clients         = mergeArrays(srv.clients        || [], loc.clients        || []);
  merged.inspections     = mergeInspections(srv.inspections  || [], loc.inspections  || []) as typeof merged.inspections;
  merged.maps            = mergeMaps(srv.maps             || [], loc.maps           || []) as typeof merged.maps;
  merged.categories      = mergeCategories(srv.categories  || [], loc.categories    || []) as typeof merged.categories;
  merged.reports         = mergeArrays(srv.reports        || [], loc.reports        || []);
  merged.coverTemplates  = mergeArrays(srv.coverTemplates || [], loc.coverTemplates || []);
  merged.sweepAreas      = mergeArrays(srv.sweepAreas     || [], loc.sweepAreas     || []);
  merged.sweepRoads      = mergeSweepRoads(srv.sweepRoads    || [], loc.sweepRoads     || []) as typeof merged.sweepRoads;
  // v73.27 — a Zone is a flat record (id/name/kind/color/points/areaM2/notes),
  // no nested per-item arrays like a Road's `segments` — generic mergeArrays
  // (same whole-record field-union as sweepAreas) is correct here, same
  // reasoning as sweepAreas above it.
  merged.sweepZones      = mergeArrays(srv.sweepZones     || [], loc.sweepZones     || []) as typeof merged.sweepZones;
  merged.sweepJobs       = mergeSweepJobs(srv.sweepJobs   || [], loc.sweepJobs      || []) as typeof merged.sweepJobs;
  merged.sweepClients    = mergeArrays(srv.sweepClients   || [], loc.sweepClients   || []);
  merged.sweepJobSites   = mergeSweepJobSites(srv.sweepJobSites || [], loc.sweepJobSites || []) as typeof merged.sweepJobSites;
  merged.sweepFiles      = mergeArrays(srv.sweepFiles     || [], loc.sweepFiles     || []);
  merged.sweepCategories = mergeCategories(srv.sweepCategories || [], loc.sweepCategories || []) as typeof merged.sweepCategories;
  merged.sweepMaps       = mergeMaps(srv.sweepMaps        || [], loc.sweepMaps      || []) as typeof merged.sweepMaps;
  merged.sweepReports    = mergeArrays(srv.sweepReports   || [], loc.sweepReports   || []);
  for (const k of Object.keys(srv)) {
    if (!MERGE_KNOWN_KEYS.includes(k) && Array.isArray(srv[k]) && !k.startsWith('_legacy')) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (merged as any)[k] = mergeArrays(srv[k] || [], loc[k] || []);
    }
  }
  return merged;
}

export interface ServerDeletionCandidate {
  collection: string;
  id: string;
  label: string;
}

interface StoreContextType {
  data: AppData;
  currentUser: User | null;
  syncServerUrl: string;
  syncToken: string;
  setSyncConfig: (url: string, token: string) => void;
  syncStatus: 'idle' | 'syncing' | 'success' | 'error';
  syncError: string;
  lastSyncAt: string;
  pushToServer: () => Promise<string>;
  pullFromServer: () => Promise<string>;
  pendingServerDeletions: ServerDeletionCandidate[];
  resolveServerDeletions: (actions: { collection: string; id: string; action: 'delete' | 'keep' }[]) => Promise<string>;
  login: (email: string, password: string) => string;
  logout: () => void;
  addUser: (u: Omit<User, 'id' | 'createdAt'>) => void;
  updateUser: (u: User) => void;
  deleteUser: (id: string) => void;
  resetPassword: (id: string, pw: string) => void;
  addClient: (c: Omit<Client, 'id' | 'createdAt'>) => Client;
  updateClient: (c: Client) => void;
  deleteClient: (id: string) => void;
  addInspection: (i: Omit<Inspection, 'id' | 'createdAt' | 'updatedAt'>) => Inspection;
  updateInspection: (i: Inspection) => void;
  deleteInspection: (id: string) => void;
  addMap: (m: Omit<InspectionMap, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateMap: (m: InspectionMap) => void;
  deleteMap: (id: string) => void;
  addCategory: (c: Omit<Category, 'id'>) => void;
  updateCategory: (c: Category) => void;
  deleteCategory: (id: string) => void;
  cleanupCategories: () => number;
  addReport: (r: Omit<Report, 'id' | 'createdAt' | 'updatedAt'>) => Report;
  updateReport: (r: Report) => void;
  deleteReport: (id: string) => void;
  addCoverTemplate: (t: Omit<CoverTemplate, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateCoverTemplate: (t: CoverTemplate) => void;
  deleteCoverTemplate: (id: string) => void;
  exportData: () => string;
  importData: (json: string) => string;
  setData: (d: AppData) => void;
  // ── Sweeping ──
  addSweepArea: (a: Omit<SweepArea, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateSweepArea: (a: SweepArea) => void;
  deleteSweepArea: (id: string) => void;
  addSweepRoad: (r: Omit<SweepRoad, 'id' | 'createdAt' | 'updatedAt'>) => SweepRoad;
  updateSweepRoad: (r: SweepRoad) => void;
  deleteSweepRoad: (id: string) => void;
  addSweepZone: (z: Omit<SweepZone, 'id' | 'createdAt' | 'updatedAt'>) => SweepZone;
  updateSweepZone: (z: SweepZone) => void;
  deleteSweepZone: (id: string) => void;
  addSweepJob: (j: Omit<SweepJob, 'id' | 'createdAt' | 'updatedAt'>) => SweepJob;
  updateSweepJob: (j: SweepJob) => void;
  deleteSweepJob: (id: string) => void;
  addSweepClient: (c: Omit<SweepClient, 'id' | 'createdAt'>) => SweepClient;
  updateSweepClient: (c: SweepClient) => void;
  deleteSweepClient: (id: string) => void;
  addSweepJobSite: (s: Omit<SweepJobSite, 'id' | 'createdAt' | 'updatedAt'>) => SweepJobSite;
  updateSweepJobSite: (s: SweepJobSite) => void;
  deleteSweepJobSite: (id: string) => void;
  addSweepFile: (f: Omit<SweepFile, 'id' | 'createdAt'>) => SweepFile;
  updateSweepFile: (f: SweepFile) => void;
  deleteSweepFile: (id: string) => void;
  addSweepCategory: (c: Omit<SweepCategory, 'id'>) => void;
  updateSweepCategory: (c: SweepCategory) => void;
  deleteSweepCategory: (id: string) => void;
  cleanupSweepCategories: () => number;
  addSweepMap: (m: Omit<SweepMap, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateSweepMap: (m: SweepMap) => void;
  deleteSweepMap: (id: string) => void;
  addSweepReport: (r: Omit<SweepReport, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateSweepReport: (r: SweepReport) => void;
  deleteSweepReport: (id: string) => void;
}

const StoreContext = createContext<StoreContextType | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setData]             = useState<AppData>(getDefaultData);
  const [dbReady, setDbReady]       = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  // Load data from IndexedDB on mount (auto-migrates from localStorage if needed)
  useEffect(() => {
    loadData().then(loaded => {
      setData(loaded);
      // ── Session restore ────────────────────────────────────────────────────
      // Store credentials (email + password) rather than the user-object ID so
      // that session restoration works even when IndexedDB falls back to fresh
      // default data with newly-generated IDs.
      try {
        // Read from localStorage (persists across browser restarts when "Stay logged in" is ON)
        // Also check sessionStorage as a fallback for single-session logins
        const raw = localStorage.getItem('rsw_session') || sessionStorage.getItem('rsw_session');
        if (raw) {
          const { email, password } = JSON.parse(raw) as { email: string; password: string };
          if (email && password) {
            const valid = loaded.users.find(
              x => x.email === email && x.password === password && x.active
            );
            setCurrentUser(valid || null);
            if (!valid) {
              // Credentials no longer valid — clear both stores
              localStorage.removeItem('rsw_session');
              sessionStorage.removeItem('rsw_session');
            }
          }
        }
      } catch { setCurrentUser(null); }
      setDbReady(true);
    }).catch(() => setDbReady(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [syncServerUrl, setSyncServerUrl] = useState<string>(() => localStorage.getItem('rsw_sync_url') || '');
  const [syncToken, setSyncToken] = useState<string>(() => localStorage.getItem('rsw_sync_token') || '');
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncError, setSyncError] = useState('');
  const [lastSyncAt, setLastSyncAt] = useState<string>(() => localStorage.getItem('rsw_last_sync') || '');
  const [pendingServerDeletions, setPendingServerDeletions] = useState<ServerDeletionCandidate[]>([]);

  const setSyncConfig = useCallback((url: string, token: string) => {
    const cleanUrl = url.replace(/\/$/, '');
    setSyncServerUrl(cleanUrl);
    setSyncToken(token);
    localStorage.setItem('rsw_sync_url', cleanUrl);
    localStorage.setItem('rsw_sync_token', token);
  }, []);

  // All sweep collection keys for sync
  const ALL_SWEEP_KEYS: (keyof AppData)[] = [
    'sweepAreas','sweepRoads','sweepZones','sweepJobs','sweepClients','sweepJobSites',
    'sweepFiles','sweepCategories','sweepMaps','sweepReports'
  ];
  const ALL_INSPECTION_KEYS: (keyof AppData)[] = [
    'users','clients','inspections','maps','categories','reports','coverTemplates'
  ];
  const ALL_KEYS = [...ALL_INSPECTION_KEYS, ...ALL_SWEEP_KEYS];

  const pushToServer = useCallback(async (): Promise<string> => {
    if (!syncServerUrl) return 'No sync server URL configured. Go to Backup & Sync → Sync Settings.';
    setSyncStatus('syncing');
    setSyncError('');
    try {
      // v73.40 — Craig: "make push aware [a record] has been deleted by
      // another user there no point having it not work." Before v73.40,
      // ONLY Pull & Merge ever checked for server-side deletions — Push had
      // no deletion-awareness at all, so a device that still had a
      // since-deleted record (never pulled since the delete, or the local
      // "known server ids" baseline in localStorage got reset — see the
      // pull-side comment above) would silently resurrect it on the server
      // the moment it pushed, with no warning to anyone. Fixed by checking
      // the server's tombstone list (GET /tombstones — already existed for
      // the host-server dashboard's own use, never previously consulted by
      // the app) before sending, and holding back any local record that
      // matches one — same Keep/Delete review dialog used for the pull-side
      // case (`pendingServerDeletions`/`resolveServerDeletions`), not a
      // separate mechanism. Never blocks or fails the push over this: if the
      // tombstone check itself fails (older host-server without the
      // endpoint, network hiccup), the push proceeds exactly as before —
      // this is strictly additive safety, not a new point of failure.
      let payloadData = data;
      try {
        const tsResp = await fetch(`${syncServerUrl}/tombstones`, {
          headers: { 'X-Sync-Token': syncToken },
        });
        if (tsResp.ok) {
          const tsResult = await tsResp.json();
          const tombstones = (tsResult?.tombstones || []) as { collection: string; id: string }[];
          if (tombstones.length > 0) {
            const tombstonedByCol = new Map<string, Set<string>>();
            for (const t of tombstones) {
              if (!tombstonedByCol.has(t.collection)) tombstonedByCol.set(t.collection, new Set());
              tombstonedByCol.get(t.collection)!.add(t.id);
            }
            const held: ServerDeletionCandidate[] = [];
            const filtered: AppData = { ...data };
            for (const col of ALL_KEYS) {
              const tombIds = tombstonedByCol.get(col as string);
              if (!tombIds || tombIds.size === 0) continue;
              const arr = data[col] as { id: string }[] | undefined;
              if (!Array.isArray(arr) || arr.length === 0) continue;
              const conflicting = arr.filter(r => tombIds.has(r.id));
              if (conflicting.length === 0) continue;
              conflicting.forEach(rec => held.push({ collection: col as string, id: rec.id, label: labelForRecord(rec) }));
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (filtered[col] as any) = arr.filter(r => !tombIds.has(r.id));
            }
            if (held.length > 0) {
              payloadData = filtered;
              setPendingServerDeletions(prev => {
                const map = new Map(prev.map(c => [`${c.collection}:${c.id}`, c]));
                for (const c of held) map.set(`${c.collection}:${c.id}`, c);
                return Array.from(map.values());
              });
              logEvent('push', `Held back ${held.length} record(s) deleted by another user — review in the dialog before they'll sync (Keep restores on next push, Delete removes locally).`);
            }
          }
        }
        // tsResp not ok (e.g. older host-server without /tombstones) — fall
        // through and push the full, unfiltered data, same as pre-v73.40.
      } catch {
        // Network hiccup fetching tombstones — same fallback: push proceeds
        // unfiltered rather than blocking on a check that couldn't run.
      }

      const resp = await fetch(`${syncServerUrl}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Token': syncToken },
        body: JSON.stringify({ data: payloadData, mode: 'merge' }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const result = await resp.json();
      const raw = result.data as AppData;
      // v71.9 BUG FIX: this used to do `merged[k] = raw[k]` for every
      // collection — a raw overwrite that trusted the server's response as
      // complete truth. Any gap between that response and what's actually on
      // this device (a record added moments before the push, a retried
      // request, another device syncing at the same instant) meant the local
      // record was silently deleted the instant the response was applied.
      // mergeServerDataIntoLocal() runs the same additive, collection-aware
      // merge Pull & Merge already used, so push can now only add/update
      // local data from the response — never make something local disappear.
      const merged: AppData = mergeServerDataIntoLocal(raw, data, localTombstoneIdSet());
      // v71.5: auto-delete propagation removed. A push only ever adds/updates
      // local data from the server's response — it no longer deletes local
      // records based on the server's tombstone list. Manual deletes on the
      // server now only affect the server; Pull & Merge is where the user is
      // asked whether a record missing from the server should be removed
      // locally too (see pullFromServer below).
      // FIX: clean up duplicate/empty-husk SW Category lists and Inspection
      // Category lists every sync so corruption from old app builds (or the
      // server's own data) can never re-accumulate on this device.
      merged.sweepCategories = consolidateSweepCategories(merged.sweepCategories || []);
      merged.categories      = consolidateCategories(merged.categories || []);
      saveData(merged);
      setData(merged);
      const ts = new Date().toISOString();
      setLastSyncAt(ts);
      localStorage.setItem('rsw_last_sync', ts);
      setSyncStatus('success');
      const changed = ALL_KEYS
        .filter(k => (data[k] as unknown[]).length !== (merged[k] as unknown[]).length)
        .map(k => `${k} ${(data[k] as unknown[]).length}→${(merged[k] as unknown[]).length}`);
      logEvent('push', changed.length > 0
        ? `Pushed & merged OK. Changed: ${changed.join(', ')}`
        : 'Pushed & merged OK. No record-count changes.');
      return '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sync failed';
      setSyncError(msg);
      setSyncStatus('error');
      logEvent('sync-error', `Push failed: ${msg}`);
      return msg;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncServerUrl, syncToken, data]);

  const pullFromServer = useCallback(async (): Promise<string> => {
    if (!syncServerUrl) return 'No sync server URL configured.';
    setSyncStatus('syncing');
    setSyncError('');
    try {
      const resp = await fetch(`${syncServerUrl}/sync`, {
        headers: { 'X-Sync-Token': syncToken },
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const result = await resp.json();
      const raw = result.data as AppData;

      // ── Apply collection-aware merges (shared helper — see module scope) ────
      const merged: AppData = mergeServerDataIntoLocal(raw, data, localTombstoneIdSet());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const srv = raw as any; const loc = data as any;

      // v71.5: auto-delete propagation removed — a record missing from the
      // server response is NEVER silently removed locally anymore. Instead,
      // detect which local records were previously confirmed on the server
      // (from the last sync) but are missing from THIS response — those are
      // candidates for the user to review. Anything never previously
      // confirmed on the server (i.e. new/unsynced local records) is left
      // alone entirely; it just hasn't been pushed yet.
      const knownIds = loadKnownServerIds();
      const candidates: ServerDeletionCandidate[] = [];
      for (const col of ALL_KEYS) {
        const newServerIds = new Set(((srv[col] as { id: string }[] | undefined) || []).map(r => r.id));
        const prevServerIds = new Set(knownIds[col] || []);
        const localRecords = (loc[col] as { id: string }[] | undefined) || [];
        for (const rec of localRecords) {
          if (prevServerIds.has(rec.id) && !newServerIds.has(rec.id)) {
            candidates.push({ collection: col, id: rec.id, label: labelForRecord(rec) });
          }
        }
        knownIds[col] = Array.from(newServerIds);
      }
      saveKnownServerIds(knownIds);
      if (candidates.length > 0) {
        // Merge with (don't clobber) any candidates still pending from an
        // earlier pull the user hasn't resolved yet.
        setPendingServerDeletions(prev => {
          const map = new Map(prev.map(c => [`${c.collection}:${c.id}`, c]));
          for (const c of candidates) map.set(`${c.collection}:${c.id}`, c);
          return Array.from(map.values());
        });
      }
      // FIX: see consolidateSweepCategories — repairs old-build duplicate/
      // empty-husk SW Category lists and Inspection Category lists on every
      // pull so they don't keep piling up across devices.
      merged.sweepCategories = consolidateSweepCategories(merged.sweepCategories || []);
      merged.categories      = consolidateCategories(merged.categories || []);
      saveData(merged);
      setData(merged);
      const ts = new Date().toISOString();
      setLastSyncAt(ts);
      localStorage.setItem('rsw_last_sync', ts);
      setSyncStatus('success');
      const changed = ALL_KEYS
        .filter(k => (data[k] as unknown[]).length !== (merged[k] as unknown[]).length)
        .map(k => `${k} ${(data[k] as unknown[]).length}→${(merged[k] as unknown[]).length}`);
      logEvent('pull', changed.length > 0
        ? `Pulled & merged OK. Changed: ${changed.join(', ')}`
        : 'Pulled & merged OK. No record-count changes.');
      return '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Pull failed';
      setSyncError(msg);
      setSyncStatus('error');
      logEvent('sync-error', `Pull failed: ${msg}`);
      return msg;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncServerUrl, syncToken, data]);

  // Applies the user's choices from the "record missing/deleted on server"
  // dialog. 'delete' removes the record from local data (finalising the
  // deletion that happened on the server).
  //
  // v73.48 BUG FIX — "Keep" not actually restoring, dialog kept reappearing.
  // 'keep' used to just clear the item from the pending list and rely on
  // "the NEXT Push & Sync will send it back up." That was never true for the
  // push-side case (pushToServer, v73.40): every push re-fetches the
  // server's tombstone list and filters ANY locally-held record matching a
  // tombstone out of the payload BEFORE sending — regardless of whether the
  // user had already chosen "Keep" for it last time, because that choice
  // was never recorded anywhere the next push could see it. So the record
  // was filtered out again, re-added to pendingServerDeletions again, and
  // the dialog reappeared every single sync — exactly Craig's report ("the
  // popup keeps coming back... it just drops it instead of restoring").
  // Fix: "Keep" now explicitly calls the host-server's existing
  // `POST /tombstones/remove` endpoint (already built for this exact
  // purpose — see its own comment in server.js) for every kept id. Only
  // once the tombstone is actually gone server-side is the item cleared
  // from the pending list; the very next push then has nothing left to
  // filter it against, sends the record through normally, and the server
  // merge restores it for good. If the untombstone call fails (offline, no
  // sync server configured, older host-server without the endpoint), the
  // item is deliberately left in the pending list — surfaced as an error
  // rather than silently pretending it was resolved — so the user gets a
  // real reason instead of an unexplained repeat popup.
  const resolveServerDeletions = useCallback(async (
    actions: { collection: string; id: string; action: 'delete' | 'keep' }[]
  ): Promise<string> => {
    const deletes = actions.filter(a => a.action === 'delete');
    const keeps   = actions.filter(a => a.action === 'keep');

    if (deletes.length > 0) {
      setData(prev => {
        const next: AppData = { ...prev };
        for (const { collection, id } of deletes) {
          const col = collection as keyof AppData;
          const arr = next[col];
          if (Array.isArray(arr)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (next[col] as any) = (arr as { id: string }[]).filter(r => r.id !== id);
          }
        }
        return next; // persisted automatically by the saveData(data) effect below
      });
    }

    let untombstoneError = '';
    let keptOk: { collection: string; id: string }[] = keeps;
    if (keeps.length > 0 && syncServerUrl) {
      try {
        const resp = await fetch(`${syncServerUrl}/tombstones/remove`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sync-Token': syncToken },
          body: JSON.stringify({ items: keeps.map(k => ({ id: k.id, collection: k.collection })) }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
          throw new Error(err.error || `HTTP ${resp.status}`);
        }
        logEvent('info', `Restored ${keeps.length} record(s) kept from the deletion dialog — will re-sync to server on next Push.`);
      } catch (err) {
        untombstoneError = err instanceof Error ? err.message : 'Failed to clear server tombstone';
        keptOk = []; // leave these in the pending list — nothing was actually resolved
        logEvent('sync-error', `Keep failed for ${keeps.length} record(s): ${untombstoneError}. They will be shown again next sync.`);
      }
    } else if (keeps.length > 0) {
      // No sync server configured — nothing to untombstone against, so
      // there's no server-side tombstone to worry about resurfacing.
      keptOk = keeps;
    }

    const resolvedKeys = new Set([...deletes, ...keptOk].map(a => `${a.collection}:${a.id}`));
    setPendingServerDeletions(prev => prev.filter(c => !resolvedKeys.has(`${c.collection}:${c.id}`)));

    return untombstoneError;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncServerUrl, syncToken]);


  // ── Debounced IndexedDB persistence (v73.35) ────────────────────────────────
  // BUG FIX: this used to call `saveData(data)` — a full JSON.stringify of the
  // ENTIRE AppData object (every job, photo, report) — synchronously on every
  // single state change, including every keystroke. As total app data has
  // grown this got progressively heavier and was the single biggest
  // contributor to the app "lagging badly." Fix: coalesce bursts of rapid
  // changes into one write 500ms after the last change. A pending write is
  // flushed IMMEDIATELY (see flushIdbWriteNow) on unmount, tab hide, and
  // pagehide so the final edit is never lost.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dataRef = useRef<AppData>(data);
  dataRef.current = data;
  useEffect(() => {
    if (!dbReady) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null; // v73.138 — must clear on natural fire too, not just on
                                    // cancel, or saveTimerRef.current stays a stale "truthy"
                                    // handle forever and the flush-gate below (v73.138) can
                                    // never tell "already saved" apart from "still pending".
      saveData(data);
    }, 500);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [data, dbReady]);
  // v73.120 — Craig: "some things would save and other places it would not…
  // come back to find that that was not saved." Root cause: the ONLY exit
  // hook here was `pagehide`, and its "flush" called saveData(data) — which
  // itself goes through the 150ms-debounced scheduleIdbWrite() and re-arms a
  // FRESH setTimeout instead of writing immediately. On a page being closed,
  // backgrounded, or killed by the OS (very common on Android/PWA — this app
  // is used in the field on Android devices per its own hardware profile),
  // that inner 150ms timer frequently never gets a chance to run, so the
  // very last edit before close/background — often the one the user cared
  // about most — was silently dropped. `pagehide` also does not fire
  // reliably at all on some mobile browsers when the OS suspends a
  // backgrounded tab; `visibilitychange`→hidden is the one event mobile
  // browsers are required to fire before suspending, so it's now the
  // primary flush trigger, with `pagehide` and `beforeunload` as
  // additional, harmless-if-redundant safety nets for desktop tab
  // close/refresh. All three call flushSaveDataNow(), which writes to IDB
  // immediately instead of scheduling another debounced write.
  // v73.138 — Craig: app crashing specifically when taking the "next set" of
  // GPS photos in the field, worsening with a "cascading effect" the more
  // photos were taken. Root cause: flush() above ran UNCONDITIONALLY on
  // every single visibilitychange→hidden event — and opening the camera
  // (which every GPS photo does) backgrounds the tab, firing that event
  // every time. Before v73.135 (per-photo auto-save), that was wasteful but
  // harmless — repeatedly flushing the same small, unchanged dataset. Once
  // v73.135 started genuinely growing `data.inspections` with each newly
  // auto-saved photo BEFORE the next camera launch, every subsequent camera
  // open now triggered a full JSON.stringify + IndexedDB write of the
  // ENTIRE, ever-growing app dataset — at the exact moment the camera app
  // is launching and competing hardest for memory/CPU on a phone. That's a
  // realistic mobile-browser crash mechanism, and it explains both "still
  // holds the last GPS location" (the crash interrupts execution before the
  // NEXT capture's state updates even apply) and the cascading/worsening
  // pattern (each successive flush's payload is bigger than the last).
  // Fix: only perform the immediate flush if a write is actually PENDING
  // (saveTimerRef.current set means something changed since the last write
  // and hasn't been persisted yet) — if nothing is pending, the data is
  // already fully saved and there is nothing this flush would protect;
  // skip it entirely rather than redundantly re-serializing an unchanged,
  // possibly large dataset on every single tab-hide.
  useEffect(() => {
    const flush = () => {
      if (!saveTimerRef.current) return; // nothing pending — already saved, skip
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      flushSaveDataNow(dataRef.current);
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v73.122 — Craig: same "some things save, other places don't" symptom,
  // but happening specifically across 3 Chrome tabs open at once (Site &
  // Road Inspections). See the cross-tab sync block above saveData() for
  // the full root-cause writeup: each tab keeps its own in-memory copy and,
  // without this, a save in one tab can be silently overwritten by an
  // older in-memory copy saving from another tab. This listens for other
  // tabs' write pings (BroadcastChannel, or the 'storage' event as a
  // fallback for browsers without it) and MERGES their freshly-written data
  // into this tab's own copy — record-by-record, newest-updatedAt-wins,
  // same logic as server sync — rather than overwriting in either
  // direction. Also re-merges when this tab becomes visible again, in case
  // it missed a ping while backgrounded/throttled.
  useEffect(() => {
    if (!dbReady) return;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const reloadAndMerge = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => {
        reloadTimer = null;
        try {
          const fresh = await loadData();
          setData(prev => {
            const merged = mergeServerDataIntoLocal(fresh, prev, localTombstoneIdSet());
            return JSON.stringify(merged) === JSON.stringify(prev) ? prev : merged;
          });
        } catch { /* a missed cross-tab merge just means the next ping/visibility change will catch it */ }
      }, 250); // batch a burst of pings (e.g. several fields saved in quick succession in the other tab) into one reload
    };
    const bc = getDataSyncChannel();
    const onBcMessage = (e: MessageEvent) => {
      if (e?.data?.tabId === TAB_ID) return; // BroadcastChannel already excludes the sender, but stay defensive
      reloadAndMerge();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== DATA_SYNC_CHANNEL) return; // 'storage' event fallback already excludes the tab that wrote it
      reloadAndMerge();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') reloadAndMerge(); };
    bc?.addEventListener('message', onBcMessage);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      bc?.removeEventListener('message', onBcMessage);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisible);
      if (reloadTimer) clearTimeout(reloadTimer);
    };
  }, [dbReady]);

  // ── Live add/update/delete logging (v71.9, throttled in v73.35) ───────────
  // Instead of hand-adding a logEvent() call to every one of the ~45 add/
  // update/delete functions in this file (easy to miss one, and it wouldn't
  // catch imports/restores/sync merges anyway), this diffs `data` against its
  // previous value and logs exactly what changed, per record, per collection
  // — regardless of WHAT caused the change. A collection whose array
  // reference didn't change is skipped instantly; only the 1–2 collections
  // actually touched get their records compared.
  //
  // BUG FIX (v73.35): this used to run on EVERY `data` change (every
  // keystroke), doing `JSON.stringify(before) !== JSON.stringify(rec)` per
  // touched record — a second full serialization pass stacked directly on
  // top of the saveData() write above, and unlike saveData it wasn't
  // debounced at all. It's now debounced on the same 500ms cadence, so a
  // burst of edits gets diffed once against the state before the burst.
  const prevDataRef = useRef<AppData | null>(null);
  const diffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!dbReady) return;
    if (diffTimerRef.current) clearTimeout(diffTimerRef.current);
    diffTimerRef.current = setTimeout(() => {
      const prev = prevDataRef.current;
      if (prev) {
        for (const col of ALL_KEYS) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const prevArr = (prev as any)[col] as { id: string }[] | undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const currArr = (data as any)[col] as { id: string }[] | undefined;
          if (prevArr === currArr) continue; // this collection wasn't touched
          const prevMap = new Map((prevArr || []).map(r => [r.id, r]));
          const currMap = new Map((currArr || []).map(r => [r.id, r]));
          for (const [id, rec] of currMap) {
            const before = prevMap.get(id);
            if (!before) {
              logEvent('add', `${col}: ${labelForRecord(rec)}`);
            } else if (before !== rec && JSON.stringify(before) !== JSON.stringify(rec)) {
              logEvent('update', `${col}: ${labelForRecord(rec)}`);
            }
          }
          for (const [id, rec] of prevMap) {
            if (!currMap.has(id)) {
              logEvent('delete', `${col}: ${labelForRecord(rec)}`);
              addLocalTombstone(col as string, id, labelForRecord(rec));
            }
          }
        }
      }
      prevDataRef.current = data;
    }, 500);
    return () => { if (diffTimerRef.current) clearTimeout(diffTimerRef.current); };
  }, [data, dbReady]);

  // Global runtime error capture — uncaught exceptions and unhandled promise
  // rejections anywhere in the app get written to the same debug log as
  // type 'error', so Craig can download a day's log after something crashes
  // without needing to reproduce it live in front of anyone.
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      logEvent('error', `${e.message} (${e.filename || 'app'}:${e.lineno || 0})`);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
      logEvent('error', `Unhandled promise rejection: ${reason}`);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  // ── Session persistence ────────────────────────────────────────────────────
  // IMPORTANT: Only SAVE the session here when a user is logged in.
  // Do NOT clear it when currentUser is null — that would delete the stored
  // credentials on initial mount (before loadData resolves) causing logout on
  // every browser refresh. Clearing is handled explicitly in logout().
  useEffect(() => {
    if (currentUser) {
      const session = JSON.stringify({ email: currentUser.email, password: currentUser.password });
      const remember = localStorage.getItem('rsw_remember') !== 'false';
      if (remember) {
        // Persist across browser restarts ("Stay logged in" is ON)
        localStorage.setItem('rsw_session', session);
        sessionStorage.removeItem('rsw_session');
      } else {
        // Only persist for this tab session ("Stay logged in" is OFF)
        sessionStorage.setItem('rsw_session', session);
        localStorage.removeItem('rsw_session');
      }
      localStorage.removeItem('rsw_user'); // remove legacy key
    }
    // No else-branch: let logout() handle explicit clearing.
  }, [currentUser]);

  const login = useCallback((email: string, password: string): string => {
    const user = data.users.find(u => u.email === email && u.password === password && u.active);
    if (!user) return 'Invalid username or password';
    setCurrentUser(user);
    return '';
  }, [data.users]);

  const logout = useCallback(() => {
    setCurrentUser(null);
    localStorage.removeItem('rsw_session');
    sessionStorage.removeItem('rsw_session');
    localStorage.removeItem('rsw_user');
  }, []);

  const addUser = useCallback((u: Omit<User, 'id' | 'createdAt'>) => {
    const t = now();
    setData(prev => ({ ...prev, users: [...prev.users, { ...u, id: uid(), createdAt: t, updatedAt: t }] }));
  }, []);
  const updateUser = useCallback((u: User) => {
    // FIX: stamp updatedAt so mergeArrays can correctly order user edits during sync
    setData(prev => ({ ...prev, users: prev.users.map(x => x.id === u.id ? { ...u, updatedAt: now() } : x) }));
    // If the current user's record was updated (e.g. password change), refresh
    // the session so the stored credentials stay valid across page reloads.
    setCurrentUser(prev => {
      if (prev?.id === u.id) {
        const sess = JSON.stringify({ email: u.email, password: u.password });
        if (localStorage.getItem('rsw_remember') !== 'false') {
          localStorage.setItem('rsw_session', sess);
        } else {
          sessionStorage.setItem('rsw_session', sess);
        }
        return u;
      }
      return prev;
    });
  }, []);
  const deleteUser = useCallback((id: string) => {
    setData(prev => ({ ...prev, users: prev.users.filter(x => x.id !== id) }));
  }, []);
  const resetPassword = useCallback((id: string, pw: string) => {
    setData(prev => ({ ...prev, users: prev.users.map(x => x.id === id ? { ...x, password: pw, updatedAt: now() } : x) }));
    // If the current user's password was reset, update the stored session so
    // they aren't kicked out on next page refresh.
    setCurrentUser(prev => {
      if (prev?.id === id) {
        const updated = { ...prev, password: pw };
        const sess = JSON.stringify({ email: updated.email, password: pw });
        if (localStorage.getItem('rsw_remember') !== 'false') {
          localStorage.setItem('rsw_session', sess);
        } else {
          sessionStorage.setItem('rsw_session', sess);
        }
        return updated;
      }
      return prev;
    });
  }, []);

  const addClient = useCallback((c: Omit<Client, 'id' | 'createdAt'>): Client => {
    const t = now();
    const newClient: Client = { ...c, id: uid(), createdAt: t, updatedAt: t };
    setData(prev => ({ ...prev, clients: [...prev.clients, newClient] }));
    return newClient;
  }, []);
  const updateClient = useCallback((c: Client) => {
    setData(prev => ({ ...prev, clients: prev.clients.map(x => x.id === c.id ? { ...c, updatedAt: now() } : x) }));
  }, []);
  const deleteClient = useCallback((id: string) => {
    setData(prev => ({
      ...prev,
      clients: prev.clients.filter(x => x.id !== id),
      inspections: prev.inspections.map(i => i.assignedClientId === id ? { ...i, assignedClientId: '' } : i),
      reports: prev.reports.map(r => r.clientId === id ? { ...r, clientId: '' } : r),
      coverTemplates: (prev.coverTemplates || []).map(t => t.clientId === id ? { ...t, clientId: '', clientName: t.clientName } : t),
    }));
  }, []);

  const addInspection = useCallback((i: Omit<Inspection, 'id' | 'createdAt' | 'updatedAt'>): Inspection => {
    const t = now();
    const newItem: Inspection = { ...i, id: uid(), createdAt: t, updatedAt: t };
    setData(prev => ({ ...prev, inspections: [...prev.inspections, newItem] }));
    return newItem;
  }, []);
  const updateInspection = useCallback((i: Inspection) => {
    setData(prev => ({ ...prev, inspections: prev.inspections.map(x => x.id === i.id ? { ...i, updatedAt: now() } : x) }));
  }, []);
  const deleteInspection = useCallback((id: string) => {
    setData(prev => ({
      ...prev,
      inspections: prev.inspections.filter(x => x.id !== id),
      // Cascade: remove this inspection ID from every report that references it
      reports: prev.reports.map(r =>
        r.inspectionIds.includes(id)
          ? { ...r, inspectionIds: r.inspectionIds.filter(rid => rid !== id), updatedAt: new Date().toISOString() }
          : r
      ),
    }));
  }, []);

  const addMap = useCallback((m: Omit<InspectionMap, 'id' | 'createdAt' | 'updatedAt'>) => {
    const t = now();
    setData(prev => ({ ...prev, maps: [...prev.maps, { ...m, id: uid(), createdAt: t, updatedAt: t }] }));
  }, []);
  const updateMap = useCallback((m: InspectionMap) => {
    setData(prev => ({ ...prev, maps: prev.maps.map(x => x.id === m.id ? { ...m, updatedAt: now() } : x) }));
  }, []);
  const deleteMap = useCallback((id: string) => {
    setData(prev => ({
      ...prev,
      maps: prev.maps.filter(x => x.id !== id),
      // Cascade: strip map references from all inspections that used this map
      inspections: prev.inspections.map(ins => {
        const hadPin = ins.mapId === id || (ins.mapPins || []).some(mp => mp.mapId === id);
        if (!hadPin) return ins;
        return {
          ...ins,
          mapId:       ins.mapId === id ? '' : ins.mapId,
          mapPinId:    ins.mapId === id ? '' : (ins.mapPinId ?? ''),
          mapSnapshot: ins.mapId === id ? '' : (ins.mapSnapshot ?? ''),
          mapPins: (ins.mapPins || []).filter(mp => mp.mapId !== id),
          updatedAt: new Date().toISOString(),
        };
      }),
    }));
  }, []);

  const addCategory = useCallback((c: Omit<Category, 'id'>) => {
    // FIX: add timestamps so mergeArrays can correctly identify this record
    setData(prev => ({ ...prev, categories: [...prev.categories, { ...c, id: uid(), createdAt: now(), updatedAt: now() }] }));
  }, []);
  const updateCategory = useCallback((c: Category) => {
    // FIX: add updatedAt so mergeArrays can correctly sort winner during sync
    setData(prev => ({ ...prev, categories: prev.categories.map(x => x.id === c.id ? { ...c, updatedAt: now() } : x) }));
  }, []);
  const deleteCategory = useCallback((id: string) => {
    setData(prev => ({ ...prev, categories: prev.categories.filter(x => x.id !== id) }));
  }, []);

  const addCoverTemplate = useCallback((t: Omit<CoverTemplate, 'id' | 'createdAt' | 'updatedAt'>) => {
    setData(prev => ({ ...prev, coverTemplates: [...(prev.coverTemplates || []), { ...t, id: uid(), createdAt: now(), updatedAt: now() }] }));
  }, []);
  const updateCoverTemplate = useCallback((t: CoverTemplate) => {
    setData(prev => ({ ...prev, coverTemplates: (prev.coverTemplates || []).map(x => x.id === t.id ? { ...t, updatedAt: now() } : x) }));
  }, []);
  const deleteCoverTemplate = useCallback((id: string) => {
    setData(prev => ({ ...prev, coverTemplates: (prev.coverTemplates || []).filter(x => x.id !== id) }));
  }, []);

  const addReport = useCallback((r: Omit<Report, 'id' | 'createdAt' | 'updatedAt'>): Report => {
    const t = now();
    const newItem: Report = { ...r, id: uid(), createdAt: t, updatedAt: t };
    setData(prev => ({ ...prev, reports: [...prev.reports, newItem] }));
    return newItem;
  }, []);
  const updateReport = useCallback((r: Report) => {
    setData(prev => ({ ...prev, reports: prev.reports.map(x => x.id === r.id ? { ...r, updatedAt: now() } : x) }));
  }, []);
  const deleteReport = useCallback((id: string) => {
    setData(prev => ({ ...prev, reports: prev.reports.filter(x => x.id !== id) }));
  }, []);

  // ── Sweeping ──────────────────────────────────────────────────────────────

  const addSweepArea = useCallback((a: Omit<SweepArea, 'id' | 'createdAt' | 'updatedAt'>) => {
    const t = now();
    setData(prev => ({ ...prev, sweepAreas: [...(prev.sweepAreas || []), { ...a, id: uid(), createdAt: t, updatedAt: t }] }));
  }, []);
  const updateSweepArea = useCallback((a: SweepArea) => {
    setData(prev => ({ ...prev, sweepAreas: (prev.sweepAreas || []).map(x => x.id === a.id ? { ...a, updatedAt: now() } : x) }));
  }, []);
  const deleteSweepArea = useCallback((id: string) => {
    setData(prev => {
      // Collect road IDs belonging to this area before removing them
      const removedRoadIds = new Set(
        (prev.sweepRoads || []).filter(r => r.areaId === id).map(r => r.id)
      );
      return {
        ...prev,
        sweepAreas: (prev.sweepAreas || []).filter(x => x.id !== id),
        sweepRoads: (prev.sweepRoads || []).filter(x => x.areaId !== id),
        sweepZones: (prev.sweepZones || []).filter(x => x.areaId !== id),
        // Cascade: strip orphaned road entries from every sweep job
        sweepJobs: removedRoadIds.size === 0 ? (prev.sweepJobs || []) :
          (prev.sweepJobs || []).map(j => {
            const roads = j.roads.filter(jr => !removedRoadIds.has(jr.roadId));
            const areaIds = j.areaIds.filter(aid => aid !== id);
            if (roads.length === j.roads.length && areaIds.length === j.areaIds.length) return j;
            return { ...j, roads, areaIds, updatedAt: now() };
          }),
      };
    });
  }, []);

  const addSweepRoad = useCallback((r: Omit<SweepRoad, 'id' | 'createdAt' | 'updatedAt'>): SweepRoad => {
    const t = now();
    const newId = uid();
    const newRoad: SweepRoad = { ...r, id: newId, createdAt: t, updatedAt: t };
    setData(prev => ({
      ...prev,
      sweepRoads: [...(prev.sweepRoads || []), newRoad],
      // Also register the road ID in the parent area so area.roadIds stays in sync
      sweepAreas: (prev.sweepAreas || []).map(a =>
        a.id === r.areaId
          ? { ...a, roadIds: [...a.roadIds, newId], updatedAt: t }
          : a
      ),
    }));
    return newRoad;
  }, []);
  const updateSweepRoad = useCallback((r: SweepRoad) => {
    setData(prev => {
      const oldRoad = (prev.sweepRoads || []).find(x => x.id === r.id);
      const areaChanged = oldRoad && oldRoad.areaId !== r.areaId;
      return {
        ...prev,
        sweepRoads: (prev.sweepRoads || []).map(x => x.id === r.id ? { ...r, updatedAt: now() } : x),
        // Keep area.roadIds in sync if road moved to a different area
        sweepAreas: areaChanged
          ? (prev.sweepAreas || []).map(a => {
              if (a.id === oldRoad.areaId) return { ...a, roadIds: a.roadIds.filter(rid => rid !== r.id) };
              if (a.id === r.areaId) return { ...a, roadIds: [...a.roadIds.filter(rid => rid !== r.id), r.id] };
              return a;
            })
          : (prev.sweepAreas || []),
      };
    });
  }, []);
  const deleteSweepRoad = useCallback((id: string) => {
    setData(prev => ({
      ...prev,
      sweepRoads: (prev.sweepRoads || []).filter(x => x.id !== id),
      sweepAreas: (prev.sweepAreas || []).map(a => ({ ...a, roadIds: a.roadIds.filter(rid => rid !== id) })),
    }));
  }, []);

  // v73.27 — Zone CRUD. Deliberately simpler than the Road equivalents above:
  // a Zone has no `SweepArea.roadIds`-style back-reference to keep in sync
  // (nothing else currently needs "all zone ids for this area" as a fast
  // lookup the way sweep-job road attachment does — `sweepZones.filter(z =>
  // z.areaId === id)` is plenty cheap at realistic zone counts), and moving
  // a zone between areas needs no special-case handling for the same reason.
  const addSweepZone = useCallback((z: Omit<SweepZone, 'id' | 'createdAt' | 'updatedAt'>): SweepZone => {
    const t = now();
    const newZone: SweepZone = { ...z, id: uid(), createdAt: t, updatedAt: t };
    setData(prev => ({ ...prev, sweepZones: [...(prev.sweepZones || []), newZone] }));
    return newZone;
  }, []);
  const updateSweepZone = useCallback((z: SweepZone) => {
    setData(prev => ({
      ...prev,
      sweepZones: (prev.sweepZones || []).map(x => x.id === z.id ? { ...z, updatedAt: now() } : x),
    }));
  }, []);
  const deleteSweepZone = useCallback((id: string) => {
    setData(prev => ({ ...prev, sweepZones: (prev.sweepZones || []).filter(x => x.id !== id) }));
  }, []);

  const addSweepJob = useCallback((j: Omit<SweepJob, 'id' | 'createdAt' | 'updatedAt'>): SweepJob => {
    const t = now();
    const newItem: SweepJob = { ...j, id: uid(), createdAt: t, updatedAt: t };
    setData(prev => ({ ...prev, sweepJobs: [...(prev.sweepJobs || []), newItem] }));
    return newItem;
  }, []);
  const updateSweepJob = useCallback((j: SweepJob) => {
    setData(prev => ({ ...prev, sweepJobs: (prev.sweepJobs || []).map(x => x.id === j.id ? { ...j, updatedAt: now() } : x) }));
  }, []);
  const deleteSweepJob = useCallback((id: string) => {
    setData(prev => ({ ...prev, sweepJobs: (prev.sweepJobs || []).filter(x => x.id !== id) }));
  }, []);

  const addSweepClient = useCallback((c: Omit<SweepClient, 'id' | 'createdAt'>): SweepClient => {
    const t = now();
    const newItem: SweepClient = { ...c, id: uid(), createdAt: t, updatedAt: t };
    setData(prev => ({ ...prev, sweepClients: [...(prev.sweepClients || []), newItem] }));
    return newItem;
  }, []);
  const updateSweepClient = useCallback((c: SweepClient) => {
    setData(prev => ({ ...prev, sweepClients: (prev.sweepClients || []).map(x => x.id === c.id ? { ...c, updatedAt: now() } : x) }));
  }, []);
  const deleteSweepClient = useCallback((id: string) => {
    setData(prev => ({
      ...prev,
      sweepClients: (prev.sweepClients || []).filter(x => x.id !== id),
      // Cascade: clear clientId on any sweep jobs that reference this client
      sweepJobs: (prev.sweepJobs || []).map(j =>
        j.clientId === id ? { ...j, clientId: '', updatedAt: now() } : j
      ),
      // Cascade: clear clientId on any job sites that reference this client
      sweepJobSites: (prev.sweepJobSites || []).map(s =>
        s.clientId === id ? { ...s, clientId: '', updatedAt: now() } : s
      ),
    }));
  }, []);

  const addSweepJobSite = useCallback((s: Omit<SweepJobSite, 'id' | 'createdAt' | 'updatedAt'>): SweepJobSite => {
    const t = now();
    const newSite: SweepJobSite = { ...s, id: uid(), createdAt: t, updatedAt: t };
    setData(prev => ({ ...prev, sweepJobSites: [...(prev.sweepJobSites || []), newSite] }));
    return newSite;
  }, []);
  const updateSweepJobSite = useCallback((s: SweepJobSite) => {
    setData(prev => ({ ...prev, sweepJobSites: (prev.sweepJobSites || []).map(x => x.id === s.id ? { ...s, updatedAt: now() } : x) }));
  }, []);
  const deleteSweepJobSite = useCallback((id: string) => {
    setData(prev => ({
      ...prev,
      sweepJobSites: (prev.sweepJobSites || []).filter(x => x.id !== id),
      // Cascade: clear siteId on any sweep jobs that reference this site
      sweepJobs: (prev.sweepJobs || []).map(j =>
        j.siteId === id ? { ...j, siteId: '', updatedAt: now() } : j
      ),
    }));
  }, []);

  const addSweepFile = useCallback((f: Omit<SweepFile, 'id' | 'createdAt'>): SweepFile => {
    const t = now();
    const newFile: SweepFile = { ...f, id: uid(), createdAt: t, updatedAt: t };
    setData(prev => ({ ...prev, sweepFiles: [...(prev.sweepFiles || []), newFile] }));
    return newFile;
  }, []);
  const updateSweepFile = useCallback((f: SweepFile) => {
    setData(prev => ({ ...prev, sweepFiles: (prev.sweepFiles || []).map(x => x.id === f.id ? { ...f, updatedAt: now() } : x) }));
  }, []);
  const deleteSweepFile = useCallback((id: string) => {
    setData(prev => ({
      ...prev,
      sweepFiles: (prev.sweepFiles || []).filter(x => x.id !== id),
      // Cascade: remove file ID from any sweep jobs and job sites that reference it
      sweepJobs: (prev.sweepJobs || []).map(j =>
        j.fileIds?.includes(id)
          ? { ...j, fileIds: j.fileIds.filter(fid => fid !== id), updatedAt: now() }
          : j
      ),
      sweepJobSites: (prev.sweepJobSites || []).map(s =>
        s.fileIds?.includes(id)
          ? { ...s, fileIds: s.fileIds.filter(fid => fid !== id), updatedAt: now() }
          : s
      ),
    }));
  }, []);

  const addSweepCategory = useCallback((c: Omit<SweepCategory, 'id'>) => {
    const t = now();
    setData(prev => ({ ...prev, sweepCategories: [...(prev.sweepCategories || []), { ...c, id: uid(), createdAt: t, updatedAt: t }] }));
  }, []);
  const updateSweepCategory = useCallback((c: SweepCategory) => {
    // FIX: add updatedAt so mergeArrays correctly sorts winner during sync
    setData(prev => ({ ...prev, sweepCategories: (prev.sweepCategories || []).map(x => x.id === c.id ? { ...c, updatedAt: now() } : x) }));
  }, []);
  const deleteSweepCategory = useCallback((id: string) => {
    setData(prev => ({ ...prev, sweepCategories: (prev.sweepCategories || []).filter(x => x.id !== id) }));
  }, []);
  // One-click repair for the duplicate/empty-husk "Damage Types" style
  // corruption left behind by older app builds. Returns how many records
  // were removed so the UI can show a confirmation message.
  const cleanupSweepCategories = useCallback((): number => {
    let removed = 0;
    setData(prev => {
      const before = prev.sweepCategories || [];
      const after = consolidateSweepCategories(before);
      removed = before.length - after.length;
      return { ...prev, sweepCategories: after };
    });
    return removed;
  }, []);
  const cleanupCategories = useCallback((): number => {
    let removed = 0;
    setData(prev => {
      const before = prev.categories || [];
      const after = consolidateCategories(before);
      removed = before.length - after.length;
      return { ...prev, categories: after };
    });
    return removed;
  }, []);

  const addSweepMap = useCallback((m: Omit<SweepMap, 'id' | 'createdAt' | 'updatedAt'>) => {
    const t = now();
    setData(prev => ({ ...prev, sweepMaps: [...(prev.sweepMaps || []), { ...m, id: uid(), createdAt: t, updatedAt: t }] }));
  }, []);
  const updateSweepMap = useCallback((m: SweepMap) => {
    setData(prev => ({ ...prev, sweepMaps: (prev.sweepMaps || []).map(x => x.id === m.id ? { ...m, updatedAt: now() } : x) }));
  }, []);
  const deleteSweepMap = useCallback((id: string) => {
    setData(prev => ({ ...prev, sweepMaps: (prev.sweepMaps || []).filter(x => x.id !== id) }));
  }, []);

  const addSweepReport = useCallback((r: Omit<SweepReport, 'id' | 'createdAt' | 'updatedAt'>) => {
    const t = now();
    setData(prev => ({ ...prev, sweepReports: [...(prev.sweepReports || []), { ...r, id: uid(), createdAt: t, updatedAt: t }] }));
  }, []);
  const updateSweepReport = useCallback((r: SweepReport) => {
    setData(prev => ({ ...prev, sweepReports: (prev.sweepReports || []).map(x => x.id === r.id ? { ...r, updatedAt: now() } : x) }));
  }, []);
  const deleteSweepReport = useCallback((id: string) => {
    setData(prev => ({ ...prev, sweepReports: (prev.sweepReports || []).filter(x => x.id !== id) }));
  }, []);

  const exportData = useCallback((): string => JSON.stringify(data, null, 2), [data]);

  const importData = useCallback((json: string): string => {
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed !== 'object' || parsed === null) return 'Invalid data format';
      // Forward-compatibility: carry forward ANY array-valued key the backup file
      // contains that isn't one of the known AppData fields below — e.g. a future
      // collection added to the app before this function is updated to know about
      // it by name. Without this, a Full Restore would silently drop new data types.
      const KNOWN_KEYS = new Set([
        'users','clients','inspections','maps','categories','reports','coverTemplates',
        'sweepAreas','sweepRoads','sweepZones','sweepJobs','sweepClients','sweepJobSites','sweepFiles',
        'sweepCategories','sweepMaps','sweepReports',
      ]);
      const extras: Record<string, unknown> = {};
      Object.keys(parsed).forEach(k => {
        if (!KNOWN_KEYS.has(k) && k !== 'deletedIds' && Array.isArray(parsed[k])) {
          extras[k] = parsed[k];
        }
      });
      const restored: AppData = {
        ...extras, // spread first so the explicit known fields below always take precedence
        users:           Array.isArray(parsed.users)           ? parsed.users           : [DEFAULT_ADMIN, DEFAULT_DRIVER],
        clients:         Array.isArray(parsed.clients)         ? parsed.clients         : [],
        inspections:     Array.isArray(parsed.inspections)     ? parsed.inspections     : [],
        maps:            Array.isArray(parsed.maps)            ? parsed.maps            : [],
        categories:      Array.isArray(parsed.categories)
          ? consolidateCategories(parsed.categories)
          : DEFAULT_CATEGORIES,
        reports:         Array.isArray(parsed.reports)         ? parsed.reports         : [],
        coverTemplates:  Array.isArray(parsed.coverTemplates)  ? parsed.coverTemplates  : [],
        sweepAreas:      Array.isArray(parsed.sweepAreas)      ? parsed.sweepAreas      : [],
        sweepRoads:      Array.isArray(parsed.sweepRoads)      ? parsed.sweepRoads      : [],
        sweepZones:      Array.isArray(parsed.sweepZones)      ? parsed.sweepZones      : [],
        sweepJobs:       Array.isArray(parsed.sweepJobs)       ? parsed.sweepJobs.map((j: any) => ({ ...j, zoneIds: Array.isArray(j.zoneIds) ? j.zoneIds : [] })) : [], // v73.51
        sweepClients:    Array.isArray(parsed.sweepClients)    ? parsed.sweepClients    : [],
        sweepJobSites:   Array.isArray(parsed.sweepJobSites) ? parsed.sweepJobSites.map((s: any) => {
          // Migrate legacy sitePins → mapPins
          const mapPins = s.mapPins ?? (s.sitePins ?? []);
          const { sitePins: _discard, ...rest } = s;
          return { mapPins, ...rest };
        }) : [],
        sweepFiles:      Array.isArray(parsed.sweepFiles)      ? parsed.sweepFiles      : [],
        sweepCategories: (() => {
          // v73.51 — same missing-categoryType backfill as loadData() above,
          // applied here too so restoring an OLDER backup (made before
          // zone_kind existed) doesn't reintroduce the exact "No zone kinds
          // list found" gap this release fixes for normal app loads.
          const raw = Array.isArray(parsed.sweepCategories) ? parsed.sweepCategories : DEFAULT_SWEEP_CATEGORIES;
          const missing = DEFAULT_SWEEP_CATEGORIES
            .map(c => c.categoryType)
            .filter(t => !raw.some((c: import('./types').SweepCategory) => c.categoryType === t));
          const withDefaults = [...raw, ...DEFAULT_SWEEP_CATEGORIES.filter(c => missing.includes(c.categoryType))];
          return consolidateSweepCategories(withDefaults);
        })(),
        sweepMaps:       Array.isArray(parsed.sweepMaps)       ? parsed.sweepMaps       : [],
        sweepReports:    Array.isArray(parsed.sweepReports)    ? parsed.sweepReports    : [],
      };
      if (restored.users.length === 0) restored.users = [DEFAULT_ADMIN, DEFAULT_DRIVER];
      restored.users = migrateDefaultAdminLogin(restored.users);
      saveData(restored);
      setData(restored);
      return '';
    } catch { return 'Failed to parse JSON data'; }
  }, []);

  const safeSetData = useCallback((d: AppData) => { saveData(d); setData(d); }, []);

  return (
    <StoreContext.Provider value={{
      data, currentUser,
      syncServerUrl, syncToken, setSyncConfig,
      syncStatus, syncError, lastSyncAt,
      pushToServer, pullFromServer, pendingServerDeletions, resolveServerDeletions,
      login, logout,
      addUser, updateUser, deleteUser, resetPassword,
      addClient, updateClient, deleteClient,
      addInspection, updateInspection, deleteInspection,
      addMap, updateMap, deleteMap,
      addCategory, updateCategory, deleteCategory, cleanupCategories,
      addReport, updateReport, deleteReport,
      addCoverTemplate, updateCoverTemplate, deleteCoverTemplate,
      exportData, importData, setData: safeSetData,
      addSweepArea, updateSweepArea, deleteSweepArea,
      addSweepRoad, updateSweepRoad, deleteSweepRoad,
      addSweepZone, updateSweepZone, deleteSweepZone,
      addSweepJob, updateSweepJob, deleteSweepJob,
      addSweepClient, updateSweepClient, deleteSweepClient,
      addSweepJobSite, updateSweepJobSite, deleteSweepJobSite,
      addSweepFile, updateSweepFile, deleteSweepFile,
      addSweepCategory, updateSweepCategory, deleteSweepCategory, cleanupSweepCategories,
      addSweepMap, updateSweepMap, deleteSweepMap,
      addSweepReport, updateSweepReport, deleteSweepReport,
    }}>
      {dbReady ? children : (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6' }}>
          <div style={{ textAlign: 'center', color: '#6b7280' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🗄️</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Loading RSW Field App…</div>
            <div style={{ fontSize: 13 }}>Opening local database</div>
          </div>
        </div>
      )}
    </StoreContext.Provider>
  );
}

export function useStore(): StoreContextType {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be inside StoreProvider');
  return ctx;
}
