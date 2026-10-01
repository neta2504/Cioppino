import { NavLink, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useEffect, useState, lazy, Suspense } from 'react';
// Routes are code-split so the initial dashboard payload doesn't ship the
// recharts bundle (~140KB) or any of the secondary pages. We also kick off
// a prefetch of every other route once the app mounts (see effect below),
// so by the time the user clicks a nav link the chunk is already cached
// and React doesn't have to fall back to the Suspense placeholder.
const dashboardLoader = () => import('./pages/Dashboard');
const agentsLoader    = () => import('./pages/Agents');
const accessLoader    = () => import('./pages/Access');
const tokensLoader    = () => import('./pages/Tokens');
const performanceLoader = () => import('./pages/Performance');
const projectsLoader  = () => import('./pages/Projects');
const activityLoader  = () => import('./pages/Activity');
const downloadsLoader = () => import('./pages/Downloads');
const settingsLoader  = () => import('./pages/Settings');
const Dashboard = lazy(dashboardLoader);
const Agents = lazy(agentsLoader);
const Access = lazy(accessLoader);
const Tokens = lazy(tokensLoader);
const Performance = lazy(performanceLoader);
const Projects = lazy(projectsLoader);
const ActivityPage = lazy(activityLoader);
const Downloads = lazy(downloadsLoader);
const Settings = lazy(settingsLoader);
import { Menu, X, Download } from 'lucide-react';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', png: '/ocean/dashboard.png' },
  { to: '/agents', label: 'Agents', png: '/ocean/agents.png' },
  { to: '/access', label: 'Access', png: '/ocean/access.png' },
  { to: '/projects', label: 'Projects', png: '/ocean/projects.png' },
  { to: '/tokens', label: 'Tokens', png: '/ocean/cost.png' },
  { to: '/performance', label: 'Performance', png: '/ocean/performance.png' },
  { to: '/activity', label: 'Activity', png: '/ocean/activity.png' },
  { to: '/downloads', label: 'Downloads', Icon: Download },
  { to: '/settings', label: 'Settings', png: '/ocean/settings.png' },
] as { to: string; label: string; png?: string; Icon?: any }[];

export default function App() {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  // Auto-close drawer on route change.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);
  // Prefetch every other route's JS chunk during idle time after the
  // initial dashboard renders. The chunks are tiny (≤10KB each) and being
  // already-cached means nav clicks never fall back to the Suspense loader
  // — no more "blue blank page" while a chunk downloads.
  useEffect(() => {
    const prefetchAll = () => {
      agentsLoader();
      accessLoader();
      tokensLoader();
      performanceLoader();
      projectsLoader();
      activityLoader();
      downloadsLoader();
      settingsLoader();
    };
    const w = window as unknown as { requestIdleCallback?: (cb: () => void) => number };
    if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(prefetchAll);
    else setTimeout(prefetchAll, 1500);
  }, []);
  return (
    <div className={`flex h-full bg-cream app-shell ${navOpen ? 'nav-open' : ''}`}>
      <button
        type="button"
        aria-label="Open navigation"
        className="mobile-nav-btn"
        onClick={() => setNavOpen(true)}
      >
        <Menu size={20} />
      </button>
      <button
        type="button"
        aria-label="Close navigation"
        className="mobile-nav-overlay"
        onClick={() => setNavOpen(false)}
      />
      <aside className="w-60 shrink-0 border-r border-ciop-100 bg-white/70 backdrop-blur flex flex-col relative app-sidebar">
        <button
          type="button"
          aria-label="Close navigation"
          className="mobile-nav-close"
          onClick={() => setNavOpen(false)}
        >
          <X size={18} />
        </button>
        <div className="relative flex items-center gap-3 px-6 pt-7 pb-9 mb-5 min-h-[44px] border-b border-ciop-100/70 overflow-hidden brand-block">
          <div className="absolute left-4 right-4 bottom-0 h-1.5 stripe-accent rounded-full opacity-75 pointer-events-none" />
          <div className="relative">
            <img src="/ocean/cioppino-icon.png" alt="Cioppino" width={44} height={44} decoding="async" fetchPriority="high" className="w-11 h-11 rounded-xl shadow-soft animate-bob brand-icon" />
            {/* steam wisps rising from the pot */}
            <span className="steam-wisp animate-steam" style={{ left: 14, top: -6, animationDelay: '0s' }} />
            <span className="steam-wisp animate-steam" style={{ left: 22, top: -6, animationDelay: '1.3s' }} />
            <span className="steam-wisp animate-steam" style={{ left: 30, top: -6, animationDelay: '2.6s' }} />
          </div>
          <div className="relative">
            <div className="font-display text-xl font-bold text-ciop-700 leading-none tracking-tight brand-name">
              Cioppino
            </div>
            <div className="text-[11px] text-espresso/60 mt-1 italic brand-tagline">where the agents simmer</div>
          </div>
        </div>
        <nav className="flex flex-col gap-1 px-4">
          {NAV.map(({ to, label, png, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `nav-link ${isActive ? 'nav-link-active' : ''}`}
            >
              {png ? (
                <img src={png} alt="" aria-hidden="true" className="w-[18px] h-[18px] object-contain nav-icon-img" />
              ) : Icon ? (
                <Icon size={18} aria-hidden="true" className="text-ciop-700 nav-icon-img" />
              ) : null}
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto">
          <img
            src="/ocean/nav-bottom.png"
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            className="w-full block select-none pointer-events-none nav-bottom-art"
          />
          <div className="text-[11px] text-espresso/50 px-7 py-3 border-t border-ciop-100/60 sidebar-footer">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-basil dot-running" />
              v0.1.0 · 100% local
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-auto app-main">
        {/* fallback=null keeps the previous route's content visible if a
            chunk download ever races a click — the user never sees a blank
            (or in ocean theme, dark blue) placeholder. Combined with the
            idle-prefetch above, navigation feels instantaneous. */}
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/access" element={<Access />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/downloads" element={<Downloads />} />
            <Route path="/tokens" element={<Tokens />} />
            <Route path="/performance" element={<Performance />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
