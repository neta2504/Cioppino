import { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

type Tone = {
  bg: string;        // header background classes
  title: string;     // title color class
  ring: string;      // soft ring/glow
  emoji?: string;    // tiny accent decoration
};

const TONES: Record<string, Tone> = {
  '/dashboard':   { bg: 'from-ciop-100/80 via-ciop-50/60 to-cream',       title: 'text-ciop-700',  ring: 'shadow-[0_8px_24px_-12px_rgba(30,120,152,0.45)]' },
  '/agents':      { bg: 'from-emerald-100/70 via-cream to-ciop-50/60',    title: 'text-basil',     ring: 'shadow-[0_8px_24px_-12px_rgba(47,163,136,0.45)]' },
  '/access':      { bg: 'from-amber-100/70 via-cream to-orange-50',       title: 'text-amber-700', ring: 'shadow-[0_8px_24px_-12px_rgba(200,164,92,0.45)]' },
  '/activity':    { bg: 'from-ciop-100/70 via-cream to-teal-50',          title: 'text-ciop-700',  ring: 'shadow-[0_8px_24px_-12px_rgba(30,120,152,0.45)]' },
  '/downloads':   { bg: 'from-indigo-100/70 via-cream to-ciop-50/60',     title: 'text-ciop-700',  ring: 'shadow-[0_8px_24px_-12px_rgba(99,102,241,0.4)]' },
  '/projects':    { bg: 'from-rose-100/60 via-cream to-amber-50',         title: 'text-coral',     ring: 'shadow-[0_8px_24px_-12px_rgba(244,123,92,0.4)]' },
  '/cost':        { bg: 'from-amber-50 via-cream to-ciop-50/60',          title: 'text-ciop-700',  ring: 'shadow-[0_8px_24px_-12px_rgba(242,166,90,0.45)]' },
  '/performance': { bg: 'from-teal-100/70 via-cream to-ciop-100/60',      title: 'text-ciop-700',  ring: 'shadow-[0_8px_24px_-12px_rgba(125,201,183,0.55)]' },
  '/settings':    { bg: 'from-slate-100 via-cream to-ciop-50/60',         title: 'text-ciop-800',  ring: 'shadow-[0_8px_24px_-12px_rgba(15,42,58,0.25)]' },
};

function toneFor(pathname: string): Tone {
  for (const key of Object.keys(TONES)) if (pathname.startsWith(key)) return TONES[key];
  return TONES['/dashboard'];
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  const { pathname } = useLocation();
  const tone = toneFor(pathname);
  return (
    <div
      className={`relative px-8 pt-7 pb-5 mb-5 bg-gradient-to-r ${tone.bg} border-b border-ciop-100/70 overflow-hidden ${tone.ring} page-header`}
    >
      {/* faint wave shimmer behind text */}
      <div
        className="absolute inset-0 opacity-40 pointer-events-none"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='40' viewBox='0 0 160 40'><path d='M0 22 Q 20 6 40 22 T 80 22 T 120 22 T 160 22' fill='none' stroke='%231E7898' stroke-opacity='0.10' stroke-width='1.5'/></svg>\")",
        }}
      />
      <div className="absolute inset-x-0 bottom-0 h-1.5 stripe-accent opacity-75 pointer-events-none" />
      <div className="relative flex items-center justify-between gap-4 min-h-[44px]">
        <div>
          <h1 className={`font-display text-3xl font-bold tracking-tight leading-tight ${tone.title}`}>
            {title}
          </h1>
          {subtitle && <p className="text-espresso/65 text-sm mt-1">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
export function MetricCard({
  label,
  value,
  sub,
  Icon,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  Icon?: any;
  tone?: 'default' | 'tomato' | 'saffron' | 'basil';
}) {
  const toneBg =
    tone === 'tomato'
      ? 'from-ciop-100 to-ciop-50'
      : tone === 'saffron'
        ? 'from-amber-100 to-orange-50'
        : tone === 'basil'
          ? 'from-emerald-100 to-emerald-50'
          : 'from-ciop-50 to-white';
  const iconBg =
    tone === 'tomato' ? 'bg-ciop-500 text-white' : tone === 'basil' ? 'bg-emerald-600 text-white' : tone === 'saffron' ? 'bg-amber-500 text-white' : 'bg-ciop-100 text-ciop-700';
  return (
    <div className={`card card-hover p-5 bg-gradient-to-br ${toneBg} metric-card metric-tone-${tone}`}>
      <div className="flex items-start justify-between">
        <div className="text-xs uppercase tracking-wider text-espresso/60 font-semibold metric-label">{label}</div>
        {Icon && (
          <div className={`w-9 h-9 rounded-xl ${iconBg} flex items-center justify-center shadow-soft metric-icon`}>
            <Icon size={18} />
          </div>
        )}
      </div>
      <div className="font-display text-3xl font-bold mt-3 text-espresso metric-value">{value}</div>
      {sub && <div className="text-xs text-espresso/60 mt-2 metric-sub">{sub}</div>}
    </div>
  );
}

export function StatusDot({ running }: { running: boolean }) {
  return running ? (
    <span className="dot-running w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />
  ) : (
    <span className="w-2.5 h-2.5 rounded-full bg-espresso/20 inline-block" />
  );
}

export function Pill({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'green' | 'amber' | 'red' }) {
  const cls =
    tone === 'green'
      ? 'bg-emerald-100 text-emerald-800'
      : tone === 'amber'
        ? 'bg-amber-100 text-amber-800'
        : tone === 'red'
          ? 'bg-red-100 text-red-800'
          : 'bg-ciop-50 text-ciop-700';
  return <span className={`pill ${cls}`}>{children}</span>;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card p-12 text-center">
      <img src="/icon.png" alt="" className="w-16 h-16 mx-auto opacity-40 mb-4" />
      <div className="font-display text-lg text-espresso/70">{title}</div>
      {hint && <div className="text-sm text-espresso/50 mt-1">{hint}</div>}
    </div>
  );
}

// Warning banner shown when the backend's OS-process lister is unavailable.
// In that state we cannot tell which agents are running, and the perf charts
// stay empty — surface it explicitly instead of leaving the user guessing.
export function ProcListerBanner({ procLister }: { procLister?: { ok: boolean; error?: string } }) {
  if (!procLister || procLister.ok) return null;
  return (
    <div className="mx-8 mb-4 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 px-4 py-3 text-sm">
      <div className="font-semibold mb-1">Process list unavailable</div>
      <div className="opacity-90">
        Cioppino couldn’t read the OS process list, so running state and live
        CPU / memory / GPU samples can’t be collected. This usually means
        antivirus / endpoint software (e.g. Microsoft Defender) blocked the
        underlying call. See the <em>Troubleshooting</em> section in the README.
      </div>
      {procLister.error && (
        <div className="opacity-60 text-xs mt-1 break-all">Detail: {procLister.error}</div>
      )}
    </div>
  );
}
