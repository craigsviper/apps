export interface User {
  id: string;
  name: string;
  email: string;      // login username (v73.11+ — no longer required to be a real email address; field name kept as-is to avoid a wider rename, but the UI now labels/treats it as "Username")
  role: 'admin' | 'user' | 'driver';
  password: string;
  createdAt: string;
  updatedAt?: string;  // for sync merge ordering
  active: boolean;
}

export interface Client {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  address: string;
  contractNumber: string;  // added v54.3
  loginEmail: string;
  loginPassword: string;
  notes: string;
  createdAt: string;
  updatedAt?: string;  // added for sync merge ordering
  active: boolean;
}

export interface Photo {
  id: string;
  data: string;
  comment: string;
  takenAt: string;
  lat?: number;      // GPS latitude when photo was taken
  lng?: number;      // GPS longitude when photo was taken
  mapId?: string;    // linked map (from Map & Pin Locations)
  pinId?: string;    // linked pin on that map
}

export interface InspComment {
  id: string;
  text: string;
  category: string;
  createdAt: string;
  createdBy: string;
}

export interface MapPin {
  id: string;
  x: number;
  y: number;
  lat?: number;
  lng?: number;
  label: string;
  description: string;
  inspectionId: string;
  color: string;
}

export interface InspectionMap {
  id: string;
  name: string;
  type: 'uploaded' | 'online' | 'company';
  imageData: string;
  url: string;
  pins: MapPin[];
  centerLat?: number;
  centerLng?: number;
  zoom?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryItem {
  id: string;
  name: string;
  description: string;
  color: string;
}

export interface Category {
  id: string;
  name: string;
  type: 'inspection_type' | 'condition' | 'comment_category' | 'custom';
  items: CategoryItem[];
  createdAt?: string;  // for sync merge ordering
  updatedAt?: string;  // for sync merge ordering
}

export interface MapPinLink {
  mapId: string;
  pinId: string;
  snapshot: string;
}

export interface Inspection {
  id: string;
  title: string;
  type: string;
  date: string;
  location: string;
  latitude: string;
  longitude: string;
  mapId: string;
  mapPinId: string;
  mapSnapshot?: string;
  mapPins?: MapPinLink[];
  description: string;
  photos: Photo[];
  comments: InspComment[];
  condition: string;
  status: 'draft' | 'in_progress' | 'completed' | 'reviewed';
  assignedClientId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CoverPage {
  companyName: string;
  companyTagline: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  reportTitle: string;
  reportSubtitle: string;
  preparedBy: string;
  preparedFor: string;
  reportDate: string;
  reportNumber: string;
  coverNotes: string;
  primaryColor: string;
  headerTextColor: string;
  titleTextColor: string;
  bodyTextColor: string;
  accentTextColor: string;
  showLogo: boolean;
  logoData: string;
  reportTypeLabel: string;
  titleFontSize: number;
  subtitleFontSize: number;
  bodyFontSize: number;
  accentFontSize: number;
  headerFontSize: number;
  taglineFontSize: number;
  logoSize: number;
  coverBodyText: string;
}

export interface Report {
  id: string;
  title: string;
  date: string;
  inspectionIds: string[];
  clientId: string;
  createdBy: string;
  categories: string[];
  includePhotos: boolean;
  includeComments: boolean;
  includeMaps: boolean;
  detailLevel: 'summary' | 'standard' | 'detailed';
  status: 'draft' | 'final';
  createdAt: string;
  updatedAt: string;
  notes: string;
  coverPage?: CoverPage;
}

export interface CoverTemplate {
  id: string;
  name: string;
  description: string;
  clientId: string;
  clientName: string;
  cover: CoverPage;
  createdAt: string;
  updatedAt: string;
}

// ─── Road Sweeping ────────────────────────────────────────────────────────────

export interface RoadPoint {
  lat: number;
  lng: number;
  transitAfter?: boolean; // when true: edge FROM this point TO the next is invisible + not counted in km
  // v73.68 — which real-world street this point came from, when known. Only ever
  // set for points added via Select Roads/Lasso (sourced from an OSM RoadFeature's
  // own `name`); hand-drawn Draw Points points, and any real-road-routing gap-fill
  // detour splice (fillGapsWithRealRoads), are left untagged since neither has a
  // single well-defined street name. Purely a client-side editing aid for
  // "Split Segment by Street" — never required, never validated, safe to be
  // missing/stale on any point.
  streetName?: string;
}

// v73.100 — Turnaround Points: independent markers (NOT part of the ordered
// RoadPoint[] path) placed at one end of a dead-end/cul-de-sac road so OSRM's
// /match snap can be told "the vehicle turns around here" via a tightened
// per-point radius, instead of OSRM guessing and sometimes snapping onto an
// unwanted nearby road or extending the match past the real end of the road.
// Per-segment (RouteSegment.turnarounds below), never global. Purely a
// snap-time hint — never rendered as part of the route line, never included
// in km totals.
export interface TurnaroundPoint {
  id: string;
  // v73.108 — explicit discriminant tag, added purely as defensive
  // belt-and-suspenders per Craig's audit spec. Structurally this app never
  // needed one (turnarounds live in their own `RouteSegment.turnarounds`
  // array, never merged into `roadSegments`/`RouteSegment.points` — see
  // isTurnaroundPoint()/isRouteSegment() guards in SweepJobs.tsx and the
  // v73.108 changelog entry for the full audit trail), but it makes that
  // guarantee checkable by a simple `.type` read rather than "trust the
  // array it's sitting in", and matches the exact shape Craig's spec asked for.
  type: 'turnaround';
  lat: number;
  lng: number;
}

export type DamagePinType = string; // managed via SW Categories → Damage Types
export type DamageSeverity = string; // managed via SW Categories → Damage Severity

export interface DamagePin {
  id: string;
  lat: number;
  lng: number;
  label: string;
  description: string;
  color: string;       // legacy fallback colour
  bgColor?: string;    // fill colour of the pin circle (overrides severity auto-colour)
  outerColor?: string; // border/ring colour of the pin circle (default: white)
  damageType?: DamagePinType;
  severity?: DamageSeverity;
  photo?: string;
  pinMode?: 'damage' | 'standard'; // 'damage' = damage type+severity pin, 'standard' = custom label+colour pin
  createdAt: string;
  updatedAt?: string;
}

export interface RouteSegment {
  id: string;
  label: string;
  points: RoadPoint[];
  color?: string;      // per-segment colour override; undefined = use road/area colour
  transit?: boolean;   // when true: segment is invisible on saved map + excluded from km total
  // v73.100 — Turnaround Points: independent end-of-road markers for this
  // segment, used as an OSRM /match snapping hint (see TurnaroundPoint
  // above) — NOT part of `points`, never rendered as a route line, never
  // counted in km.
  turnarounds?: TurnaroundPoint[];
  updatedAt?: string;  // v73.39 — stamped only when THIS segment's own content actually
                        // changed (points/label/color), via a load-time snapshot diff in
                        // saveRoad(). Without this, the server's id-based segment merge
                        // (mergeSubArrayById) always compared blank-vs-blank and fell back
                        // to "whichever side is `client` in this merge call wins" instead of
                        // genuine recency — found while investigating a reported segment
                        // duplication/content-loss issue.
}

export interface SweepRoad {
  id: string;
  name: string;
  areaId: string;
  points: RoadPoint[];          // primary/first-segment points (kept for backward compat)
  segments?: RouteSegment[];    // multi-segment support (Feature 3)
  color?: string;               // custom route color override (Feature 2); undefined = use area color
  showNumbers?: boolean;        // show point numbers on map (Feature 2); undefined = true
  showMarkers?: boolean;        // show point circle markers on map; undefined = true (false = lines only)
  lengthMetres: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

// v73.27 — Craig: a drawable polygon for car parks / business sites / general
// areas — visually similar to a Road but tracks area (m²/ha), not length, and
// is NEVER included in sweep km totals (that's the whole point of it — a
// Zone marks ground that's swept/inspected as a block, not a linear route).
// Deliberately its own collection rather than reusing SweepRoad with a flag:
// a Road's `points`/`segments` are an ORDERED PATH (A→B→C), a Zone's `points`
// is a closed POLYGON boundary — different geometry, different rendering
// (filled shape vs line), different math (shoelace area vs cumulative
// distance). Named `zoneKind` (not `zoneType`, which `SweepArea` already
// uses for something unrelated — an Area's own categorisation) to avoid
// confusion between the two.
//
// v73.46 — widened from a closed union to `string` so a zone can also be
// tagged with a custom type added via SW Categories → Zone Kinds (the
// closed set of 5 was previously the only option, with no way to add,
// edit, or delete what's available). The 5 original values ('carpark',
// 'business', 'area', 'park', 'custom') remain valid and keep their
// existing icon/label lookups (ZONE_KIND_ICONS/ZONE_KIND_LABELS in
// SweepJobs.tsx) for backward compatibility with already-saved zones —
// nothing about existing data changes, this only adds more possible
// values going forward.
export type SweepZoneKind = string;
export const BUILTIN_ZONE_KINDS = ['carpark', 'business', 'area', 'park', 'custom'] as const;

// v73.49 — Craig: "want to be able to add extra sub zones in a main zone...
// transparent like zone 1 [outline only]... add names anywhere in the sub
// zones and the main zones." A sub-zone is its own independent polygon
// piece nested inside a parent Zone — same relationship a Road's
// `segments` already have to the road (RouteSegment[] — see types.ts
// above), not a new top-level collection. Deliberately given its own `id`,
// `updatedAt`/`createdAt` (see mergeSubArrayById in server.js, which every
// other id-bearing nested array in this app already relies on to survive
// concurrent multi-device edits without silently overwriting one side).
export interface SweepSubZone {
  id: string;
  name: string;                 // may be blank — Craig wants labels "when wanted", not mandatory
  points: RoadPoint[];          // closed polygon boundary, same shape as SweepZone.points
  color: string;                // independent of the parent zone's color — each sub-zone can differ
  fillEnabled: boolean;         // false = outline only ("transparent... i just draw lines")
  labelPos: RoadPoint | null;   // null = auto-center (current default look); set = user dragged the label
  createdAt: string;
  updatedAt: string;
}

export interface SweepZone {
  id: string;
  name: string;
  areaId: string;
  zoneKind: SweepZoneKind;
  color: string;
  points: RoadPoint[];     // closed polygon boundary (no transitAfter/segments — a Zone has no line concept)
  areaM2: number;          // derived from points via the shoelace formula, stored so lists don't recompute on every render
  notes: string;
  // v73.49 — both new, both optional-with-defaults so every zone saved
  // before this release keeps rendering exactly as it did (filled, label
  // auto-centered) with zero migration needed — see zoneFillEnabled()/
  // zoneLabelPos() helpers in SweepJobs.tsx, which apply the `?? true` /
  // `?? null` defaults everywhere a zone gets read, rather than requiring
  // every already-saved record to be rewritten.
  fillEnabled?: boolean;
  labelPos?: RoadPoint | null;
  subZones?: SweepSubZone[];
  createdAt: string;
  updatedAt: string;
}

export interface SweepArea {
  id: string;
  name: string;
  description: string;
  color: string;
  zoneType: string; // managed via SW Categories → Zone Types
  roadIds: string[];
  createdAt: string;
  updatedAt: string;
}

// Per-segment sweep run details (one entry per route segment of the road)
export interface SegmentRunDetail {
  segIdx:         number;    // index into road.segments[]
  coverageMethod: 'ab' | 'percent' | 'landmark' | 'visual' | 'full';
  percentSwept?:  number;
  fromLandmark?:  string;
  toLandmark?:    string;
  visualNote?:    string;
  passCount:      number;
  debrisLevel:    string;
  debrisType?:    string;    // v73.6: e.g. "Leaf litter", "Gravel / sand" — from SW Categories 'debris_type', distinct from debrisLevel (light/moderate/heavy)
  weather?:       string;
  startDate?:     string;    // DD-MM-YYYY
  startTime?:     string;    // HH:MM (24h)
  finishDate?:    string;    // DD-MM-YYYY
  finishTime?:    string;    // HH:MM (24h)
  notes:          string;
}

export interface SweepJobRoad {
  roadId: string;
  coverageMethod: 'ab' | 'percent' | 'landmark' | 'visual' | 'full';
  startPoint?: RoadPoint;
  endPoint?: RoadPoint;
  percentSwept?: number;
  fromLandmark?: string;
  toLandmark?: string;
  visualNote?: string;
  metresSwept: number;
  damagePins: DamagePin[];
  passCount: number;
  debrisLevel: string;
  debrisType?: string;      // v73.6: what kind of debris, from SW Categories 'debris_type' — distinct from debrisLevel (how much)
  weather?: string;
  startDate?: string;      // DD-MM-YYYY
  startTime?: string;      // HH:MM (24h)
  finishDate?: string;     // DD-MM-YYYY
  finishTime?: string;     // HH:MM (24h)
  fuelDocketId?: string;
  notes: string;
  segmentSettings?: SegmentRunDetail[];  // per-segment run details (multi-segment roads)
}

// Extra expense recorded per job (food, parts, oil, other)
export interface ExtraExpense {
  id: string;
  expenseType: string;   // from SW Categories → Extra Expenses
  date: string;          // DD-MM-YYYY
  totalCost: string;     // e.g. "45.50"
  notes?: string;
  photo?: string;        // base64
  createdAt: string;
}

// Single trip to a tip site and back
export interface TipTrip {
  id: string;
  date?: string;          // DD-MM-YYYY (matches FuelDocket.date) — added so a multi-day job can log tip runs against the actual day they happened, not just the job's overall date
  departTime: string;    // HH:MM (24h)
  departHubKm: string;   // odometer reading at depart
  returnTime: string;    // HH:MM (24h)
  returnHubKm: string;   // odometer reading on return
}

// All tip runs for a specific road on this job
export interface TipRun {
  id: string;
  roadId: string;        // which road these trips belong to
  trips: TipTrip[];
}

// Fuel docket recorded per sweep job
export interface FuelDocket {
  id: string;
  date: string;          // DD-MM-YYYY
  costPerLitre: string;  // e.g. "2.209"
  totalLitres: string;   // e.g. "86.990"
  totalCost: string;     // e.g. "192.00"
  hubKm: string;         // odometer / hub reading in km
  photo?: string;        // base64 image
  notes?: string;
  createdAt: string;
}

// Sweep-specific file attachment
export interface SweepFile {
  id: string;
  name: string;
  fileType: string; // managed via SW Categories → File Attachment Types
  data: string;           // base64
  mimeType: string;
  sizeBytes: number;
  linkedTo: 'job' | 'site' | 'shared';
  linkedId: string;       // jobId or siteId or '' for shared
  createdAt: string;
  updatedAt?: string;
}

// Sweep-specific client (separate from inspection clients)
export interface SweepClient {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
  contractNumber: string;
  createdAt: string;
  updatedAt?: string;  // for sync merge ordering
  active: boolean;
}

// Job Site — reusable location library
// Pin on a job site map (water pickups, tip sites, hazards, etc.)
export interface SiteMapPin {
  id: string;
  lat: number;
  lng: number;
  label: string;
  pinType: string; // 'Water Point' | 'Tip Site' | 'Hazard' | 'Access' | 'Other'
  color: string;
  notes?: string;
}

export interface SweepJobSite {
  id: string;
  name: string;
  siteType: string; // managed via SW Categories → Site Types
  clientId: string;       // links to SweepClient
  address: string;
  notes: string;
  fileIds: string[];      // links to SweepFile
  areaIds: string[];      // pre-linked sweep areas
  mapCenter?: [number, number]; // [lat, lng] last saved map centre
  mapZoom?: number;
  mapPins: SiteMapPin[];  // pins for water points, tip sites, etc.
  createdAt: string;
  updatedAt: string;
}

// Sweep-specific category
export interface SweepCategoryItem {
  id: string;
  name: string;
  description: string;
  color: string;
}

export interface SweepCategory {
  id: string;
  name: string;
  categoryType: 'debris_type' | 'zone_type' | 'zone_kind' | 'damage_type' | 'frequency' | 'custom' | 'crew_member' | 'equipment' | 'pass_count' | 'site_type' | 'file_attachment' | 'weather' | 'debris_level' | 'damage_severity' | 'extra_expense' | 'job_site_map_pin';
  items: SweepCategoryItem[];
  createdAt?: string;  // for sync merge ordering
  updatedAt?: string;  // for sync merge ordering
}

// Sweep-specific map — upgraded to match InspectionMap capabilities
export interface SweepMap {
  id: string;
  name: string;
  type: 'uploaded' | 'online' | 'company';  // aligned with InspectionMap
  mapType?: 'google' | 'osm' | 'reference'; // kept for backward compatibility
  imageData: string;      // base64 for uploaded/company maps
  url: string;            // embed URL for online maps
  pins: MapPin[];         // location pins (linked to sweep jobs via inspectionId field)
  centerLat?: number;
  centerLng?: number;
  zoom?: number;
  linkedJobIds: string[]; // sweep-specific: jobs linked to this map
  notes: string;
  createdAt: string;
  updatedAt: string;
}

// Sweep report with chart config
export interface SweepReport {
  id: string;
  title: string;
  date: string;
  jobIds: string[];
  clientId: string;
  areaIds: string[];
  createdBy: string;
  notes: string;
  status: 'draft' | 'final';
  createdAt: string;
  updatedAt: string;
}

export interface SweepJob {
  id: string;
  jobNumber: string;
  title: string;
  status: 'planned' | 'in_progress' | 'completed';
  clientId: string;
  siteId: string;
  areaIds: string[];
  zoneIds: string[]; // v73.51 — Craig: "zones is missing from edit sweep job" — zones a job covers, alongside areaIds/roads
  roads: SweepJobRoad[];
  crewMember: string;
  equipment: string;
  date: string;
  startDate?: string;       // DD-MM-YYYY
  finishDate?: string;      // DD-MM-YYYY
  startTime: string;
  endTime: string;
  weather: string;          // kept for backward compat / job-level summary
  notes: string;
  fileIds: string[];
  fuelDockets: FuelDocket[];
  extraExpenses: ExtraExpense[];
  tipRuns: TipRun[];
  createdAt: string;
  updatedAt: string;
}

// Page type — includes all sweep sub-pages
export type Page =
  | 'dashboard'
  | 'inspections' | 'maps' | 'reports' | 'categories'
  | 'users' | 'clients' | 'backup' | 'health' | 'app-health' | 'debug'
  | 'sweeping'
  | 'sweep-jobs' | 'sweep-maps' | 'sweep-reports' | 'sweep-categories'
  | 'sweep-sites' | 'sweep-clients' | 'sweep-areas';

export interface AppData {
  users: User[];
  clients: Client[];
  inspections: Inspection[];
  maps: InspectionMap[];
  categories: Category[];
  reports: Report[];
  coverTemplates: CoverTemplate[];
  sweepAreas: SweepArea[];
  sweepRoads: SweepRoad[];
  sweepZones: SweepZone[];
  sweepJobs: SweepJob[];
  sweepClients: SweepClient[];
  sweepJobSites: SweepJobSite[];
  sweepFiles: SweepFile[];
  sweepCategories: SweepCategory[];
  sweepMaps: SweepMap[];
  sweepReports: SweepReport[];
}
