import { useEffect, useState } from 'react';
import { api, Settings as S, PriceEntry, apiKeys } from '../lib/api';
import { useCachedQuery } from '../lib/useCachedQuery';
import { PageHeader } from '../components/Bits';
import { Save, Trash2, Plus, X, RotateCcw } from 'lucide-react';

export default function Settings() {
  const settingsQ = useCachedQuery(apiKeys.settings(), () => api.settings());
  // Local editable copy; seeded from the cached snapshot so the form never
  // shows "Loading…" on a return visit.
  const [s, setS] = useState<S | null>(settingsQ.data ?? null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Keep the form in sync when a freshly fetched snapshot arrives, but only
  // if the user hasn't started editing (no unsaved changes vs. the snapshot).
  useEffect(() => {
    if (settingsQ.data && s === null) setS(settingsQ.data);
  }, [settingsQ.data, s]);

  if (!s) return <div className="p-8" role={settingsQ.error ? 'alert' : undefined}>
    {settingsQ.error ? `Settings could not be loaded: ${settingsQ.error.message}` : 'Loading…'}
  </div>;

  async function save(override?: Partial<S>) {
    if (!s || saving) return;
    const merged = override ? { ...s, ...override } : s;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    if (override) setS(merged);
    try {
      await api.saveSettings(override ?? merged);
      const fresh = await api.settings();
      setS(override ? { ...s, costEnabled: fresh.costEnabled } : fresh);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (error) {
      if (override) setS(s);
      setSaveError(error instanceof Error ? error.message : 'Settings could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function wipe() {
    if (!confirm('This will erase all Cioppino-stored data (agents, access, usage, samples). Continue?')) return;
    await api.wipe();
    location.reload();
  }

  const priceTable: PriceEntry[] = s.priceTable ?? [];
  const setPriceTable = (next: PriceEntry[]) => setS({ ...s, priceTable: next });
  const updateRate = (i: number, key: 'pattern' | 'label' | 'input' | 'output' | 'cacheWrite' | 'cacheRead', value: string) => {
    const parsed = key === 'pattern' || key === 'label' ? value
      : value === '' && (key === 'cacheWrite' || key === 'cacheRead') ? null
      : value === '' ? NaN : Number(value);
    const next = priceTable.map((e, idx) =>
      idx === i ? { ...e, [key]: parsed } : e,
    );
    setPriceTable(next);
  };
  const addRow = () =>
    setPriceTable([...priceTable, { pattern: '', match: 'model', label: '', input: 0, output: 0, cacheWrite: null, cacheRead: null }]);
  const removeRow = (i: number) => setPriceTable(priceTable.filter((_, idx) => idx !== i));
  const resetTable = () => {
    if (s.defaultPriceTable && confirm('Replace the editable price table with the current defaults? Custom rows will be replaced only when you click Save.')) {
      setPriceTable(s.defaultPriceTable.map((e) => ({ ...e })));
      setSaved(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Tune Cioppino's scan intervals and storage."
        actions={
          <button className="btn-primary" disabled={saving} onClick={() => save()}>
            <Save size={16} /> {saving ? 'Saving…' : saved ? 'Saved!' : 'Save'}
          </button>
        }
      />

      <fieldset disabled={saving} className="px-8 pb-8 space-y-6">
        {saveError && <p role="alert" className="text-red-700">{saveError}</p>}
        <div className="card p-5">
          <h2 className="font-display text-lg font-semibold mb-3">Intervals & retention</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Discovery / token rescan (seconds)">
              <input
                type="number"
                min={10}
                value={s.scanIntervalSec}
                onChange={(e) => setS({ ...s, scanIntervalSec: parseInt(e.target.value, 10) })}
                className="w-full px-3 py-2 rounded-xl border border-ciop-100 bg-white"
              />
            </Field>
            <Field label="Performance sampler (ms)">
              <input
                type="number"
                min={1000}
                step={500}
                value={s.perfIntervalMs}
                onChange={(e) => setS({ ...s, perfIntervalMs: parseInt(e.target.value, 10) })}
                className="w-full px-3 py-2 rounded-xl border border-ciop-100 bg-white"
              />
            </Field>
            <Field label="Retention (days)">
              <input
                type="number"
                min={1}
                max={90}
                value={s.retentionDays}
                onChange={(e) => setS({ ...s, retentionDays: parseInt(e.target.value, 10) })}
                className="w-full px-3 py-2 rounded-xl border border-ciop-100 bg-white"
              />
            </Field>
            <Field label="Codex input/output token split (0–1, default 0.7)">
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={s.codexInputRatio}
                onChange={(e) => setS({ ...s, codexInputRatio: parseFloat(e.target.value) })}
                className="w-full px-3 py-2 rounded-xl border border-ciop-100 bg-white"
              />
            </Field>
          </div>
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between mb-1">
            <h2 className="font-display text-lg font-semibold">Cost estimation</h2>
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!s.costEnabled}
                onChange={(e) => save({ costEnabled: e.target.checked })}
                className="h-4 w-4 accent-ciop-600"
              />
              Estimate cost
            </label>
          </div>
          <p className="text-sm text-espresso/60 mb-4">
            Off by default. When enabled, Cioppino converts token volume to an estimated USD cost using the
            editable per-model rates below ($/million tokens). Estimates use API list prices and may not reflect
            subscription billing. Models that match no row are excluded (shown as <em>n/a</em>).
          </p>
          <div className="text-sm text-espresso/60 mb-4 space-y-2">
            <p>
              Standard text, short-context estimates only. Anthropic cache writes assume five minutes.
              Long context, one-hour caches, storage, tools, audio/images, regional and service-tier
              adjustments are not calculated. Current rates also apply to older usage, not historical invoices.
            </p>
            <p>
              Model mode matches an exact version (case-insensitive; dots and hyphens in version numbers
              are equivalent). Only known provider prefixes are ignored; unknown versions and snapshots
              are not guessed. Custom substring rules keep their first-match order.
              Blank cache rates mean n/a: no separate charge is included, not a promise that caching is free.
            </p>
            {s.pricingInfo && <>
              <p>
                Built-in defaults verified {s.pricingInfo.verifiedAt}. Sources:{' '}
                {s.pricingInfo.sources.map((source, i) => <span key={source.name}>
                  {i > 0 && ' · '}
                  <a className="underline" href={source.url} target="_blank" rel="noreferrer">{source.name}</a>
                </span>)}
                . No automatic price downloads.
              </p>
              {s.pricingInfo.reviews.map((review) => <p key={review.reviewOn}
                role={review.due ? 'alert' : undefined}
                className={review.due ? 'text-amber-800' : undefined}>
                {review.due ? 'Default pricing review overdue' : 'Default pricing review due'} {review.reviewOn}: {review.message}
              </p>)}
            </>}
            {s.priceTableError && <p role="alert" className="text-red-700">{s.priceTableError}</p>}
          </div>

          {s.costEnabled && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-espresso/60 border-b border-ciop-100">
                      <th className="py-2 pr-2">Model / pattern</th>
                      <th className="py-2 pr-2">Match mode</th>
                      <th className="py-2 pr-2">Label</th>
                      <th className="py-2 pr-2 text-right">Input</th>
                      <th className="py-2 pr-2 text-right">Output</th>
                      <th className="py-2 pr-2 text-right">Cache write</th>
                      <th className="py-2 pr-2 text-right">Cache read</th>
                      <th className="py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {priceTable.map((e, i) => (
                      <tr key={i} className="border-b border-ciop-50">
                        <td className="py-1 pr-2">
                          <input
                            value={e.pattern}
                            aria-label={`Model or pattern ${i + 1}`}
                            onChange={(ev) => updateRate(i, 'pattern', ev.target.value)}
                            className="w-28 px-2 py-1 rounded-lg border border-ciop-100 bg-white font-mono text-xs"
                          />
                        </td>
                        <td className="py-1 pr-2">
                          <select aria-label={`Match mode ${i + 1}`} value={e.match ?? 'substring'}
                            onChange={(ev) => {
                              const match = ev.target.value === 'model' ? 'model' : 'substring';
                              setPriceTable(priceTable.map((row, idx) => idx === i ? { ...row, match } : row));
                            }}
                            className="px-2 py-1 rounded-lg border border-ciop-100 bg-white">
                            <option value="model">Model</option>
                            <option value="substring">Substring</option>
                          </select>
                        </td>
                        <td className="py-1 pr-2">
                          <input
                            value={e.label}
                            onChange={(ev) => updateRate(i, 'label', ev.target.value)}
                            className="w-32 px-2 py-1 rounded-lg border border-ciop-100 bg-white text-xs"
                          />
                        </td>
                        {(['input', 'output', 'cacheWrite', 'cacheRead'] as const).map((k) => (
                          <td key={k} className="py-1 pr-2 text-right">
                            <input
                              type="number"
                              min={0}
                              step="any"
                              aria-label={`${k} rate ${i + 1}`}
                              placeholder="n/a"
                              value={e[k] ?? ''}
                              onChange={(ev) => updateRate(i, k, ev.target.value)}
                              className="w-20 px-2 py-1 rounded-lg border border-ciop-100 bg-white text-xs text-right"
                            />
                          </td>
                        ))}
                        <td className="py-1 text-right">
                          <button
                            onClick={() => removeRow(i)}
                            className="p-1 text-espresso/40 hover:text-red-600"
                            title="Remove row"
                          >
                            <X size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-2 mt-3">
                <button className="btn border border-ciop-200 bg-white hover:bg-ciop-50 text-sm" onClick={addRow}>
                  <Plus size={14} /> Add model
                </button>
                <button className="btn border border-ciop-200 bg-white hover:bg-ciop-50 text-sm" onClick={resetTable}>
                  <RotateCcw size={14} /> Reset to defaults
                </button>
              </div>
            </>
          )}
        </div>

        <div className="card p-5 border-red-200">
          <h2 className="font-display text-lg font-semibold mb-2 text-red-700">Danger zone</h2>
          <p className="text-sm text-espresso/60 mb-3">Wipe all locally-stored Cioppino data. This won't touch your agents.</p>
          <button className="btn bg-red-600 text-white hover:bg-red-700" onClick={wipe}>
            <Trash2 size={16} /> Wipe all data
          </button>
        </div>
      </fieldset>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-espresso/60 font-semibold mb-1">{label}</div>
      {children}
    </div>
  );
}
