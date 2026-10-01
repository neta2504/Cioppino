import { Router } from 'express';
import { getSetting, setSetting } from './db/index.js';
import { getPriceSettings, parsePriceTable } from './tokens/pricing.js';

// Mounted behind the server's /api authentication middleware.
export const settingsRouter = Router();

settingsRouter.get('/', (_req, res) => {
  const codexInputRatio = parseFloat(getSetting('codexInputRatio') || '0.7');
  res.json({
    codexInputRatio: Number.isFinite(codexInputRatio) ? codexInputRatio : 0.7,
    scanIntervalSec: parseInt(getSetting('scanIntervalSec') || '60', 10),
    perfIntervalMs: parseInt(getSetting('perfIntervalMs') || '3000', 10),
    retentionDays: parseInt(getSetting('retentionDays') || '7', 10),
    costEnabled: getSetting('costEnabled') === 'true',
    ...getPriceSettings(),
  });
});

settingsRouter.post('/', (req, res) => {
  const { codexInputRatio, scanIntervalSec, perfIntervalMs, retentionDays, costEnabled, priceTable } = req.body || {};
  let cleanPrices: ReturnType<typeof parsePriceTable> | undefined;
  if (priceTable !== undefined) {
    try {
      cleanPrices = parsePriceTable(priceTable);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return res.status(400).json({ error: error.message });
    }
  }
  if (typeof codexInputRatio === 'number' && codexInputRatio >= 0 && codexInputRatio <= 1) {
    setSetting('codexInputRatio', String(codexInputRatio));
  }
  if (scanIntervalSec) setSetting('scanIntervalSec', String(scanIntervalSec));
  if (perfIntervalMs) setSetting('perfIntervalMs', String(perfIntervalMs));
  if (retentionDays) setSetting('retentionDays', String(retentionDays));
  if (typeof costEnabled === 'boolean') setSetting('costEnabled', costEnabled ? 'true' : 'false');
  if (cleanPrices !== undefined) setSetting('priceTable', JSON.stringify(cleanPrices));
  res.json({ ok: true });
});
