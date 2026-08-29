import { useState, useEffect, useCallback, Component, type ReactNode } from 'react';
import { StoreProvider, useStore } from './store';
// Request persistent storage on startup — Chrome needs this to unlock the
// full device quota instead of the default ~10 GB best-effort cap.
// Firefox already grants persistence automatically, so this is a no-op there.
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  navigator.storage.persist().catch(() => { /* best-effort — UI in Backup.tsx shows the result */ });
}
import type { Page } from './types';

// System components — from v14-merged
import Dashboard from './components/Dashboard';
import Users from './components/Users';
import Backup from './components/Backup';
import Health from './components/Health';
import AppHealth from './components/AppHealth';
import Debug from './components/Debug';

// Site & Road Inspections components — from v11.9
import Inspections from './components/Inspections';
import Maps from './components/Maps';
import Reports from './components/Reports';
import Categories from './components/Categories';
import Clients from './components/Clients';

// Road Sweeping components — from v12.2
import SweepJobs from './components/sweep/SweepJobs';
import SweepAreas from './components/sweep/SweepAreas';
import SweepMaps from './components/sweep/SweepMaps';
import SweepReports from './components/sweep/SweepReports';
import SweepCategories from './components/sweep/SweepCategories';
import SweepJobSites from './components/sweep/SweepJobSites';
import SweepClients from './components/sweep/SweepClients';

/* ═══════════════════════════════════════
   ERROR BOUNDARY
   ═══════════════════════════════════════ */
interface EBState { hasError: boolean; error: string }
interface EBProps { children: ReactNode; compact?: boolean; onReset?: () => void }
class ErrorBoundary extends Component<EBProps, EBState> {
  constructor(props: EBProps) { super(props); this.state = { hasError: false, error: '' }; }
  static getDerivedStateFromError(error: Error): EBState { return { hasError: true, error: error.message }; }
  handleReset = () => { this.setState({ hasError: false, error: '' }); this.props.onReset?.(); };
  render() {
    if (this.state.hasError) {
      // Compact variant — used per-page so a crash in ONE feature (e.g. a
      // malformed sweep job) doesn't take down the sidebar/navigation too.
      // The person can tap to a different page to recover without reloading.
      if (this.props.compact) {
        return (
          <div className="flex items-center justify-center p-8">
            <div className="bg-white rounded-2xl shadow-sm border border-red-200 p-8 max-w-md w-full text-center">
              <div className="text-4xl mb-3">⚠️</div>
              <h2 className="text-lg font-bold text-gray-900 mb-2">This page hit an error</h2>
              <p className="text-gray-500 text-sm mb-5">{this.state.error}</p>
              <button onClick={this.handleReset} className="btn-primary w-full mb-2">Try Again</button>
              <p className="text-xs text-gray-400 mt-4">Your other data and pages are unaffected — use the sidebar to navigate away if this keeps happening.</p>
            </div>
          </div>
        );
      }
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
          <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
            <div className="text-5xl mb-4">⚠️</div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">Something went wrong</h1>
            <p className="text-gray-500 text-sm mb-6">{this.state.error}</p>
            <button onClick={this.handleReset} className="btn-primary w-full mb-2">Try Again</button>
            <button onClick={() => window.location.reload()} className="btn-secondary w-full">Reload Page</button>
            <p className="text-xs text-gray-400 mt-6">If this keeps happening, go to Backup &amp; Sync to export your data before clearing browser storage.</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ═══════════════════════════════════════
   OFFLINE INDICATOR
   ═══════════════════════════════════════ */
function OfflineIndicator() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  if (online) return null;
  return <div className="bg-amber-500 text-white text-center text-xs sm:text-sm py-1.5 px-4 font-medium">⚠️ Offline — map tiles won't load, but all data entry and features work normally</div>;
}

/* ═══════════════════════════════════════
   STORAGE WARNING
   ═══════════════════════════════════════ */
function StorageWarning() {
  const [warning, setWarning] = useState('');
  useEffect(() => {
    const handler = (e: Event) => setWarning((e as CustomEvent).detail);
    window.addEventListener('storage-error', handler);
    return () => window.removeEventListener('storage-error', handler);
  }, []);
  if (!warning) return null;
  return (
    <div className="bg-red-600 text-white text-center text-sm py-2.5 px-4 font-medium flex items-center justify-center gap-3 flex-wrap">
      <span>🚨 {warning}</span>
      <button onClick={() => setWarning('')} className="underline text-white/80 hover:text-white text-xs">Dismiss</button>
    </div>
  );
}

/* ═══════════════════════════════════════
   LOGIN SCREEN — from v14-merged branding
   ═══════════════════════════════════════ */
function LoginScreen() {
  const { login } = useStore();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  // "Stay logged in" defaults to ON — remembers session across browser restarts.
  // When OFF, session is cleared when the browser tab is closed.
  const [remember, setRemember] = useState<boolean>(() => {
    try { return localStorage.getItem('rsw_remember') !== 'false'; }
    catch { return true; }
  });

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    // Persist the remember preference BEFORE login so the session effect reads it
    try {
      if (remember) {
        localStorage.setItem('rsw_remember', 'true');
      } else {
        localStorage.setItem('rsw_remember', 'false');
        localStorage.removeItem('rsw_session');
      }
    } catch { /* ignore */ }
    const result = login(email, password);
    if (result) setError(result);
  };

  const toggleRemember = () => {
    setRemember(v => {
      const next = !v;
      try { localStorage.setItem('rsw_remember', next ? 'true' : 'false'); } catch { /* ignore */ }
      if (!next) {
        // Clear any stored session immediately when user turns this off
        try { localStorage.removeItem('rsw_session'); } catch { /* ignore */ }
      }
      return next;
    });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-orange-950 to-slate-900 p-4">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-orange-500/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl" />
      </div>
      <div className="w-full max-w-md relative">
        <div className="text-center mb-8">
          <img src="/icons/icon-192.png" alt="UNICUS RSW Logo" className="w-16 h-16 rounded-2xl mb-4 shadow-2xl mx-auto block" />
          <h1 className="text-2xl font-bold text-white">RSW Field App</h1>
          <p className="text-slate-400 text-sm mt-1">Road &amp; Stormwater · Inspection &amp; Sweeping</p>
        </div>
        <form onSubmit={handleLogin} className="bg-white rounded-2xl shadow-2xl p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Team Sign In</h2>
          {error && <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">{error}</div>}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
            <input type="text" className="input-field" value={email} onChange={e => setEmail(e.target.value)} placeholder="admin" required autoComplete="username" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input type="password" className="input-field" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" required autoComplete="current-password" />
          </div>

          {/* ── Stay Logged In ── */}
          <button
            type="button"
            onClick={toggleRemember}
            className="flex items-center gap-3 w-full py-2 px-1 rounded-lg hover:bg-gray-50 transition-colors group"
          >
            <div className={`relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 ${remember ? 'bg-orange-500' : 'bg-gray-300'}`}>
              <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform duration-200 ${remember ? 'translate-x-5' : 'translate-x-0'}`} />
            </div>
            <div className="text-left">
              <span className="text-sm font-medium text-gray-700 block">Stay logged in</span>
              <span className="text-xs text-gray-400">{remember ? 'Session saved — stays logged in after refresh' : 'Session clears when browser tab closes'}</span>
            </div>
          </button>

          <button type="submit" className="btn-primary w-full !py-3" style={{ background: '#E8620A' }}>Sign In →</button>
        </form>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════
   PAGE TITLES
   ═══════════════════════════════════════ */
const PAGE_TITLES: Partial<Record<Page, string>> = {
  dashboard: 'Dashboard',
  // Inspections section
  inspections: 'Inspections',
  maps: 'Maps',
  reports: 'Reports',
  categories: 'Categories',
  clients: 'Clients',
  // Sweep section
  sweeping: 'Sweep Jobs',
  'sweep-jobs': 'Sweep Jobs',
  'sweep-areas': 'Areas & Roads',
  'sweep-maps': 'Sweeping Maps',
  'sweep-reports': 'Sweep Reports',
  'sweep-categories': 'Sweep Categories',
  'sweep-sites': 'Job Sites',
  'sweep-clients': 'Sweep Clients',
  // System
  users: 'Users',
  backup: 'Backup & Sync',
  health: 'Server Health',
  'app-health': 'App Health',
  debug: 'Debug',
};

const VALID_PAGES: Page[] = [
  'dashboard',
  'inspections', 'maps', 'reports', 'categories', 'clients',
  'sweeping', 'sweep-jobs', 'sweep-areas', 'sweep-maps', 'sweep-reports', 'sweep-categories', 'sweep-sites', 'sweep-clients',
  'users', 'backup', 'health', 'app-health', 'debug',
];

/* ═══════════════════════════════════════
   SIDEBAR NAV STRUCTURE — from v14-merged
   Two fully separate sections:
   Road Sweeping (v12.2) and Site & Road Inspections (v11.9)
   ═══════════════════════════════════════ */
// v73.75 — Craig: "need option for driver/inspector [login] with only
// sweep maps and full inspection options plus the backup option." New
// restricted role — a driver/inspector account originally saw only Sweeping
// Maps, the whole Site & Road Inspections group, and Backup & Sync.
// v73.133 — Craig, revisiting this for the Android field build specifically:
// driver access should be the WHOLE Site & Road Inspections group (all of
// it), plus from Road Sweeping specifically: Sweep Jobs, Sweeping Maps,
// Job Sites, Backup & Sync, and Debug (for troubleshooting the app itself
// in the field) — NOT Areas & Roads, Sweep Reports, SW Categories, or Sweep
// Clients (those are office/planning tools). Marked via a `driverAllowed`
// flag on each nav item rather than inverting the existing `adminOnly`
// pattern, so the default for any new page added later is "not visible to
// driver" (safer default — a driver role should only ever see what's
// explicitly opted in, not accidentally gain access to a new admin page by
// omission).
type NavGroup = {
  title?: string;
  groupKey: string;
  color?: string;
  pages: { page: Page; label: string; icon: string; adminOnly?: boolean; driverAllowed?: boolean }[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    groupKey: 'top',
    pages: [{ page: 'dashboard', label: 'Dashboard', icon: '📊' }],
  },
  {
    title: 'Road Sweeping',
    groupKey: 'sweep',
    color: 'text-orange-400',
    pages: [
      { page: 'sweeping',           label: 'Sweep Jobs',      icon: '🧹', driverAllowed: true },
      { page: 'sweep-areas',        label: 'Areas & Roads',   icon: '🗺️' },
      { page: 'sweep-maps',         label: 'Sweeping Maps',   icon: '📍', driverAllowed: true },
      { page: 'sweep-reports',      label: 'Sweep Reports',   icon: '📊' },
      { page: 'sweep-categories',   label: 'SW Categories',   icon: '🏷️' },
      { page: 'sweep-sites',        label: 'Job Sites',       icon: '📌', driverAllowed: true },
      { page: 'sweep-clients',      label: 'Sweep Clients',   icon: '🏢' },
    ],
  },
  {
    title: 'Site & Road Inspections',
    groupKey: 'insp',
    color: 'text-indigo-400',
    pages: [
      { page: 'inspections', label: 'Inspections', icon: '🔍', driverAllowed: true },
      { page: 'maps',        label: 'Maps',        icon: '🗺️', driverAllowed: true },
      { page: 'reports',     label: 'Reports',     icon: '📋', driverAllowed: true },
      { page: 'categories',  label: 'Categories',  icon: '📁', driverAllowed: true },
      { page: 'clients',     label: 'Clients',     icon: '🏢', driverAllowed: true },
    ],
  },
  {
    title: 'System',
    groupKey: 'sys',
    pages: [
      { page: 'users',  label: 'Users',         icon: '👥', adminOnly: true },
      { page: 'backup', label: 'Backup & Sync', icon: '💾', driverAllowed: true },
      { page: 'health',     label: 'Server Health', icon: '❤️' },
      { page: 'app-health', label: 'App Health',    icon: '📱' },
      { page: 'debug',      label: 'Debug',         icon: '🐞', driverAllowed: true },
    ],
  },
];

// Flat lookup of every page a driver role may land on/navigate to — used by
// both the sidebar filter and the route guard below so they can never drift
// out of sync with each other (one list, not two).
const DRIVER_ALLOWED_PAGES: Page[] = NAV_GROUPS.flatMap(g => g.pages).filter(p => p.driverAllowed).map(p => p.page);
const DRIVER_DEFAULT_PAGE: Page = 'sweep-maps';

/* ═══════════════════════════════════════
   MAIN APP — v14-merged shell
   ═══════════════════════════════════════ */
function MainApp() {
  const { currentUser, logout, data } = useStore();
  const [page, setPage] = useState<Page>(() => currentUser?.role === 'driver' ? DRIVER_DEFAULT_PAGE : 'dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectionFilter, setInspectionFilter] = useState<string | null>(null);
  const [sweepExpanded, setSweepExpanded] = useState(true);
  const [inspExpanded, setInspExpanded] = useState(true);
  const [sysExpanded, setSysExpanded] = useState(true);

  const navigateTo = useCallback((newPage: Page, inspId?: string) => {
    setInspectionFilter(inspId || null);
    setPage(newPage);
    history.pushState({ page: newPage, inspId: inspId || null }, '', `#${newPage}`);
    setSidebarOpen(false);
  }, []);

  useEffect(() => {
    const hash = window.location.hash.replace('#', '') as Page;
    const isDriver = currentUser?.role === 'driver';
    const fallback = isDriver ? DRIVER_DEFAULT_PAGE : 'dashboard';
    const hashOk = VALID_PAGES.includes(hash) && (!isDriver || DRIVER_ALLOWED_PAGES.includes(hash));
    const startPage = hashOk ? hash : fallback;
    setPage(startPage);
    history.replaceState({ page: startPage, inspId: null }, '', `#${startPage}`);
  }, []); // eslint-disable-line

  // v73.75 — route guard for the driver role: the sidebar filter above only
  // stops a driver from CLICKING into a disallowed page, it doesn't stop
  // direct navigation (typed URL hash, browser back/forward via popstate,
  // or Dashboard's own onNavigate callback landing somewhere driver
  // shouldn't be). Runs on every page change, not just mount, since
  // popstate/navigateTo can change `page` well after the initial load.
  useEffect(() => {
    if (currentUser?.role === 'driver' && !DRIVER_ALLOWED_PAGES.includes(page)) {
      navigateTo(DRIVER_DEFAULT_PAGE);
    }
  }, [page, currentUser?.role, navigateTo]);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const state = e.state as { page?: Page; inspId?: string | null } | null;
      if (state?.page) { setPage(state.page); setInspectionFilter(state.inspId || null); }
      else { const fb = currentUser?.role === 'driver' ? DRIVER_DEFAULT_PAGE : 'dashboard'; history.pushState({ page: fb }, '', `#${fb}`); setPage(fb); }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const renderPage = () => {
    switch (page) {
      case 'dashboard':        return <Dashboard onNavigate={(p, inspId) => navigateTo(p as Page, inspId)} />;
      // ── Site & Road Inspections (v11.9 layout) ───────────────────────────────
      case 'inspections':      return <Inspections filterInspectionId={inspectionFilter} onClearFilter={() => setInspectionFilter(null)} />;
      case 'maps':             return <Maps onNavigateToInspection={(id) => navigateTo('inspections', id)} />;
      case 'reports':          return <Reports />;
      case 'categories':       return <Categories />;
      case 'clients':          return <Clients />;
      // ── Road Sweeping (v12.2 layout) ─────────────────────────────────────────
      case 'sweeping':         return <SweepJobs />;
      case 'sweep-jobs':       return <SweepJobs />;
      case 'sweep-areas':      return <SweepAreas />;
      case 'sweep-maps':       return <SweepMaps />;
      case 'sweep-reports':    return <SweepReports />;
      case 'sweep-categories': return <SweepCategories />;
      case 'sweep-sites':      return <SweepJobSites />;
      case 'sweep-clients':    return <SweepClients />;
      // ── System (v14-merged layout) ────────────────────────────────────────────
      case 'users':            return <Users />;
      case 'backup':           return <Backup />;
      case 'health':           return <Health />;
      case 'app-health':       return <AppHealth />;
      case 'debug':            return <Debug />;
      default:                 return <Dashboard onNavigate={(p) => navigateTo(p as Page)} />;
    }
  };

  // Active style per group
  const getActiveClass = (itemPage: Page, groupKey: string) => {
    if (page !== itemPage && !(itemPage === 'sweeping' && page === 'sweep-jobs')) {
      return 'text-slate-300 hover:bg-slate-700/50 hover:text-white';
    }
    if (groupKey === 'sweep') return 'bg-orange-600 text-white shadow-lg shadow-orange-600/30';
    if (groupKey === 'insp')  return 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30';
    return 'bg-slate-600 text-white shadow-lg';
  };

  // Count badges
  const badge = (p: Page) => {
    const counts: Partial<Record<Page, number>> = {
      inspections:      data.inspections?.length || 0,
      maps:             data.maps?.length || 0,
      reports:          data.reports?.length || 0,
      clients:          data.clients?.length || 0,
      sweeping:         data.sweepJobs?.length || 0,
      'sweep-jobs':     data.sweepJobs?.length || 0,
      'sweep-sites':    data.sweepJobSites?.length || 0,
      'sweep-clients':  data.sweepClients?.length || 0,
      'sweep-areas':    data.sweepAreas?.length || 0,
    };
    const n = counts[p];
    if (!n) return null;
    return <span className="ml-auto text-xs bg-slate-700 text-slate-300 rounded-md px-1.5 py-0.5 font-bold">{n}</span>;
  };

  const isExpanded = (gk: string) => {
    if (gk === 'sweep') return sweepExpanded;
    if (gk === 'insp') return inspExpanded;
    if (gk === 'sys') return sysExpanded;
    return true;
  };
  const toggleGroup = (gk: string) => {
    if (gk === 'sweep') setSweepExpanded(v => !v);
    if (gk === 'insp') setInspExpanded(v => !v);
    if (gk === 'sys') setSysExpanded(v => !v);
  };

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {sidebarOpen && <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* ── Sidebar ── */}
      <aside className={`fixed lg:static inset-y-0 left-0 z-50 w-64 bg-slate-900 flex flex-col transition-transform duration-300 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        {/* Logo/Brand — v14-merged */}
        <div className="p-5 border-b border-slate-700/50">
          <div className="flex items-center gap-3">
            <img src="/icons/icon-192.png" alt="UNICUS RSW Logo" className="w-10 h-10 rounded-xl shadow-lg flex-shrink-0" />
            <div>
              <h1 className="font-bold text-white text-sm">RSW Field App</h1>
              <p className="text-slate-400 text-xs">Inspection &amp; Sweeping</p>
              <p className="text-slate-500 text-[11px] mt-0.5">v{__APP_VERSION__}</p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 overflow-y-auto">
          {NAV_GROUPS.map((group, gi) => {
            const visiblePages = group.pages.filter(n => (!n.adminOnly || currentUser?.role === 'admin') && (currentUser?.role !== 'driver' || n.driverAllowed));
            if (!visiblePages.length) return null;
            const expanded = isExpanded(group.groupKey);

            return (
              <div key={group.groupKey} className={gi > 0 ? 'mt-1' : ''}>
                {group.title && (
                  <>
                    <div className="h-px bg-slate-700/50 mx-2 mb-2 mt-2" />
                    <button
                      onClick={() => toggleGroup(group.groupKey)}
                      className={`flex items-center justify-between w-full px-4 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-slate-800/50 transition ${group.color || 'text-slate-500'}`}
                    >
                      <span>{group.title}</span>
                      <span className="text-slate-500">{expanded ? '▾' : '▸'}</span>
                    </button>
                  </>
                )}
                {expanded && visiblePages.map(item => (
                  <button
                    key={item.page}
                    onClick={() => navigateTo(item.page)}
                    className={`sidebar-link w-full mb-0.5 ${getActiveClass(item.page, group.groupKey)}`}
                  >
                    <span className="text-lg">{item.icon}</span>
                    <span>{item.label}</span>
                    {badge(item.page)}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>

        {/* User info / logout */}
        <div className="p-4 border-t border-slate-700/50">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm" style={{ background: '#E8620A' }}>
              {(currentUser?.name || '?').charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{currentUser?.name}</p>
              <p className="text-xs text-slate-400 truncate">{currentUser?.role}</p>
            </div>
          </div>
          <button onClick={logout} className="w-full text-left text-sm text-slate-400 hover:text-white transition px-3 py-2 rounded-lg hover:bg-slate-800">🚪 Sign Out</button>
        </div>
      </aside>

      {/* ── Main Content ── */}
      <div className="flex-1 flex flex-col min-w-0">
        <OfflineIndicator />
        <StorageWarning />

        {/* Header — v14-merged */}
        <header className="bg-white border-b border-gray-200 px-4 lg:px-6 py-3 flex items-center justify-between sticky top-0 z-30">
          <div className="flex items-center gap-3">
            <button onClick={() => setSidebarOpen(true)} className="lg:hidden p-2 rounded-lg hover:bg-gray-100">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <h2 className="text-lg font-semibold text-gray-900">{PAGE_TITLES[page] || page}</h2>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 hidden sm:block">
              {new Date().toLocaleDateString('en-NZ', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Pacific/Auckland' })}
            </span>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-6 overflow-y-auto">
          <ErrorBoundary key={page} compact>
            {renderPage()}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

function AppRouter() {
  const { currentUser } = useStore();
  if (currentUser) return <MainApp />;
  return <LoginScreen />;
}

export function App() {
  return (
    <ErrorBoundary>
      <StoreProvider>
        <AppRouter />
      </StoreProvider>
    </ErrorBoundary>
  );
}
