// Optional, opt-in cost estimation for token usage.
//
// Cioppino tracks raw token volume by default. When the user turns on cost
// estimation in Settings, this module maps each model name to a price entry and
// converts token counts into an estimated USD cost.
//
// IMPORTANT: costs are *estimates* based on public API list prices. They do not
// reflect Pro/Max subscription billing. Everything here is local and static —
// no network calls. Users can override the table from Settings.

import { getSetting } from '../db/index.js';

/** Price rates are expressed in USD per million tokens ($/MTok). */
export interface PriceEntry {
  /** Legacy rows without a match mode retain case-insensitive substring matching. */
  pattern: string;
  match?: 'model' | 'substring';
  /** Friendly label for the table editor. */
  label: string;
  input: number;
  output: number;
  cacheWrite: number | null;
  cacheRead: number | null;
}

export const PRICING_VERIFIED_AT = '2026-09-22';
export const PRICING_SOURCES = [
  { name: 'Anthropic', url: 'https://platform.claude.com/docs/en/about-claude/pricing' },
  { name: 'OpenAI', url: 'https://developers.openai.com/api/docs/pricing' },
  { name: 'Google', url: 'https://ai.google.dev/gemini-api/docs/pricing' },
];
const PRICING_REVIEWS = [
  { reviewOn: '2026-11-22', message: 'Recheck GPT-5.6 Sol: promotional pricing is guaranteed only through at least November 21, 2026.' },
  { reviewOn: '2027-01-01', message: 'Update Gemini 3.6/3.7/3.8 Flash: the published promotional rates end December 31, 2026.' },
];

function model(pattern: string, label: string, input: number, output: number, cacheWrite: number | null, cacheRead: number | null): PriceEntry {
  return { pattern, match: 'model', label, input, output, cacheWrite, cacheRead };
}

// Standard text/short-context rates. Anthropic writes use the five-minute tier.
// Null means no separate fee is listed; Google token-hour storage is excluded.
export const DEFAULT_PRICE_TABLE: PriceEntry[] = [
  // Anthropic: PRICING_SOURCES[0].
  model('claude-fable-5.1', 'Claude Fable 5.1', 10, 50, 12.5, 0.25),
  model('claude-mythos-5.1', 'Claude Mythos 5.1 (limited)', 10, 50, 12.5, 0.25),
  model('claude-fable-5', 'Claude Fable 5', 10, 50, 12.5, 1),
  model('claude-mythos-5', 'Claude Mythos 5 (limited)', 10, 50, 12.5, 1),
  model('claude-opus-5.5', 'Claude Opus 5.5', 4, 20, 5, 0.2),
  model('claude-opus-5', 'Claude Opus 5', 5, 25, 6.25, 0.5),
  model('claude-opus-4.8', 'Claude Opus 4.8', 5, 25, 6.25, 0.5),
  model('claude-opus-4.7', 'Claude Opus 4.7', 5, 25, 6.25, 0.5),
  model('claude-opus-4.6', 'Claude Opus 4.6', 5, 25, 6.25, 0.5),
  model('claude-opus-4.5', 'Claude Opus 4.5', 5, 25, 6.25, 0.5),
  model('claude-opus-4-5-20251101', 'Claude Opus 4.5 Nov 2025', 5, 25, 6.25, 0.5),
  model('claude-opus-4.1', 'Claude Opus 4.1 (legacy)', 15, 75, 18.75, 1.5),
  model('claude-opus-4', 'Claude Opus 4 (legacy)', 15, 75, 18.75, 1.5),
  model('claude-sonnet-5', 'Claude Sonnet 5', 2, 10, 2.5, 0.2),
  model('claude-sonnet-4.6', 'Claude Sonnet 4.6', 3, 15, 3.75, 0.3),
  model('claude-sonnet-4.5', 'Claude Sonnet 4.5', 3, 15, 3.75, 0.3),
  model('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5 Sep 2025', 3, 15, 3.75, 0.3),
  model('claude-sonnet-4', 'Claude Sonnet 4 (legacy)', 3, 15, 3.75, 0.3),
  model('claude-haiku-4.5', 'Claude Haiku 4.5', 1, 5, 1.25, 0.1),
  model('claude-haiku-4-5-20251001', 'Claude Haiku 4.5 Oct 2025', 1, 5, 1.25, 0.1),
  model('claude-haiku-3.5', 'Claude Haiku 3.5 (legacy)', 0.8, 4, 1, 0.08),
  // OpenAI: PRICING_SOURCES[1], standard and specialized (Codex) tables.
  model('gpt-6-astra', 'GPT-6 Astra', 10, 50, 12.5, 1),
  model('gpt-6-sol', 'GPT-6 Sol', 2, 10, 2.5, 0.2),
  model('gpt-6-luna', 'GPT-6 Luna', 0.1, 0.5, 0.125, 0.01),
  model('gpt-5.6-sol', 'GPT-5.6 Sol (promotion)', 4, 20, 5, 0.4),
  model('gpt-5.6-terra', 'GPT-5.6 Terra', 2, 12, 2.5, 0.2),
  model('gpt-5.6-luna', 'GPT-5.6 Luna', 0.2, 1.2, 0.25, 0.02),
  model('gpt-5.5', 'GPT-5.5', 5, 30, null, 0.5),
  model('gpt-5.5-pro', 'GPT-5.5 Pro', 30, 180, null, null),
  model('gpt-5.4', 'GPT-5.4', 2.5, 15, null, 0.25),
  model('gpt-5.4-mini', 'GPT-5.4 mini', 0.75, 4.5, null, 0.075),
  model('gpt-5.4-nano', 'GPT-5.4 nano', 0.2, 1.25, null, 0.02),
  model('gpt-5.4-pro', 'GPT-5.4 Pro', 30, 180, null, null),
  model('gpt-5.3-codex', 'GPT-5.3 Codex', 1.75, 14, null, 0.175),
  model('gpt-5.2', 'GPT-5.2', 1.75, 14, null, 0.175),
  model('gpt-5.2-pro', 'GPT-5.2 Pro', 21, 168, null, null),
  model('gpt-5.1', 'GPT-5.1', 1.25, 10, null, 0.125),
  model('gpt-5', 'GPT-5', 1.25, 10, null, 0.125),
  model('gpt-5-mini', 'GPT-5 mini', 0.25, 2, null, 0.025),
  model('gpt-5-nano', 'GPT-5 nano', 0.05, 0.4, null, 0.005),
  model('gpt-5-pro', 'GPT-5 Pro', 15, 120, null, null),
  model('gpt-4.1', 'GPT-4.1', 2, 8, null, 0.5),
  model('gpt-4.1-mini', 'GPT-4.1 mini', 0.4, 1.6, null, 0.1),
  model('gpt-4.1-nano', 'GPT-4.1 nano', 0.1, 0.4, null, 0.025),
  model('gpt-4o', 'GPT-4o', 2.5, 10, null, 1.25),
  model('gpt-4o-2024-05-13', 'GPT-4o May 2024', 5, 15, null, null),
  model('gpt-4o-mini', 'GPT-4o mini', 0.15, 0.6, null, 0.075),
  model('o1', 'OpenAI o1', 15, 60, null, 7.5),
  model('o1-pro', 'OpenAI o1 Pro', 150, 600, null, null),
  model('o3', 'OpenAI o3', 2, 8, null, 0.5),
  model('o3-mini', 'OpenAI o3 mini', 1.1, 4.4, null, 0.55),
  model('o3-pro', 'OpenAI o3 Pro', 20, 80, null, null),
  model('o4-mini', 'OpenAI o4 mini', 1.1, 4.4, null, 0.275),
  model('gpt-4-turbo-2024-04-09', 'GPT-4 Turbo April 2024', 10, 30, null, null),
  model('gpt-4-0613', 'GPT-4 June 2023', 30, 60, null, null),
  // Google: PRICING_SOURCES[2], paid standard text, <=200k for Pro.
  model('gemini-3.8-flash', 'Gemini 3.8 Flash (promotion)', 0.75, 3.75, null, 0.075),
  model('gemini-3.7-flash', 'Gemini 3.7 Flash (promotion)', 0.75, 3.75, null, 0.075),
  model('gemini-3.6-flash', 'Gemini 3.6 Flash (promotion)', 0.75, 3.75, null, 0.075),
  model('gemini-3.5-flash', 'Gemini 3.5 Flash', 1.5, 9, null, 0.15),
  model('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 0.3, 2.5, null, 0.03),
  model('gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 0.25, 1.5, null, 0.025),
  model('gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', 2, 12, null, 0.2),
  model('gemini-3.1-pro-preview-customtools', 'Gemini 3.1 Pro Preview Custom Tools', 2, 12, null, 0.2),
  model('gemini-3-flash-preview', 'Gemini 3 Flash Preview', 0.5, 3, null, 0.05),
  model('gemini-2.5-pro', 'Gemini 2.5 Pro', 1.25, 10, null, 0.125),
  model('gemini-2.5-flash', 'Gemini 2.5 Flash', 0.3, 2.5, null, 0.03),
  model('gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 0.1, 0.4, null, 0.01),
];

export function getPricingInfo(now = Date.now()) {
  return {
    verifiedAt: PRICING_VERIFIED_AT,
    sources: PRICING_SOURCES,
    reviews: PRICING_REVIEWS.map((review) => ({
      ...review,
      due: now >= Date.parse(`${review.reviewOn}T00:00:00Z`),
    })),
  };
}

export interface UsageTokens {
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}

/** Whether cost estimation is enabled (off by default). */
export function isCostEnabled(): boolean {
  return getSetting('costEnabled') === 'true';
}

/**
 * Resolve the effective price table: user override from Settings when valid,
 * otherwise the built-in defaults.
 */
export function parsePriceTable(value: unknown): PriceEntry[] {
  if (!Array.isArray(value)) throw new TypeError('Price table must be an array.');
  return value.map((row: unknown, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError(`Price row ${index + 1} must be an object.`);
    }
    const e = row as Record<string, unknown>;
    if (typeof e.pattern !== 'string' || !e.pattern.trim()) {
      throw new TypeError(`Price row ${index + 1} requires a model or pattern.`);
    }
    if (e.match !== undefined && e.match !== 'model' && e.match !== 'substring') {
      throw new TypeError(`Price row ${index + 1} has an invalid match mode.`);
    }
    if (e.label !== undefined && typeof e.label !== 'string') {
      throw new TypeError(`Price row ${index + 1} has an invalid label.`);
    }
    const rate = (key: string, nullable = false): number | null => {
      const n = e[key];
      if (nullable && n === null) return null;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
        throw new TypeError(`Price row ${index + 1}: ${key} must be a finite nonnegative number${nullable ? ' or null' : ''}.`);
      }
      return n;
    };
    return {
      pattern: e.pattern,
      ...(e.match === undefined ? {} : { match: e.match }),
      label: e.label ?? e.pattern,
      input: rate('input')!,
      output: rate('output')!,
      cacheWrite: rate('cacheWrite', true),
      cacheRead: rate('cacheRead', true),
    };
  });
}

export function getPriceSettings() {
  const raw = getSetting('priceTable');
  const base = { defaultPriceTable: DEFAULT_PRICE_TABLE, pricingInfo: getPricingInfo() };
  if (raw === undefined) return { ...base, priceTable: DEFAULT_PRICE_TABLE, customPriceTable: false };
  try {
    return { ...base, priceTable: parsePriceTable(JSON.parse(raw)), customPriceTable: true };
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
    const priceTableError = 'Saved price table is invalid. Pricing is unavailable; correct the table or reset to defaults and save.';
    console.error(`[cioppino] ${priceTableError}`);
    return { ...base, priceTable: [], customPriceTable: true, priceTableError };
  }
}

export function getPriceTable(): PriceEntry[] {
  return getPriceSettings().priceTable;
}

function modelId(value: string): string {
  return value.trim().toLowerCase()
    .replace(/^(?:anthropic|openai|google|models)\//, '')
    .replace(/(\d)\.(?=\d)/g, '$1-');
}

/** Find the price entry for a model name, or undefined if none matches. */
export function priceFor(model: string | null | undefined, table: PriceEntry[]): PriceEntry | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  for (const entry of table) {
    if (!entry.pattern) continue;
    if (entry.match === 'model'
      ? modelId(model) === modelId(entry.pattern)
      : m.includes(entry.pattern.toLowerCase())) return entry;
  }
  return undefined;
}

/**
 * Null distinguishes an unpriced model from an explicitly zero-priced model.
 */
export function costForUsage(u: UsageTokens, table: PriceEntry[]): number | null {
  const entry = priceFor(u.model, table);
  if (!entry) return null;
  const M = 1_000_000;
  return (
    ((u.inputTokens || 0) / M) * entry.input +
    ((u.outputTokens || 0) / M) * entry.output +
    ((u.cacheCreateTokens || 0) / M) * (entry.cacheWrite ?? 0) +
    ((u.cacheReadTokens || 0) / M) * (entry.cacheRead ?? 0)
  );
}
