import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page, request }) => {
  await request.post('/__test/reset');
  // Existing external font loading is a separate release-plan task.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:5189(?:\/|$))/, (route) => route.abort());
});

test('verified defaults, decimal precision and explicit n/a cache rates render', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByText('Built-in defaults verified 2026-09-22.')).toBeVisible();
  await expect(page.getByLabel('Model or pattern 1', { exact: true })).toHaveValue('claude-fable-5.1');
  await expect(page.getByLabel('Match mode 1', { exact: true })).toHaveValue('model');
  const gpt = page.locator('tr').filter({ has: page.locator('input[value="gpt-4.1"]') });
  await expect(gpt.getByLabel(/^input rate/)).toHaveValue('2');
  await expect(gpt.getByLabel(/^cacheWrite rate/)).toHaveValue('');
  await gpt.getByLabel(/^cacheRead rate/).fill('0.0125');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved!' })).toBeVisible();
  await page.reload();
  await expect(gpt.getByLabel(/^cacheRead rate/)).toHaveValue('0.0125');
});

test('custom tables survive; reset can be cancelled and requires Save', async ({ page, request }) => {
  await request.post('/__test/reset', { data: { custom: true } });
  await page.goto('/settings');
  await expect(page.getByLabel('input rate 1', { exact: true })).toHaveValue('42');
  await expect(page.getByLabel('Match mode 1', { exact: true })).toHaveValue('substring');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(page.getByLabel('input rate 1', { exact: true })).toHaveValue('42');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(page.getByLabel('Model or pattern 1', { exact: true })).toHaveValue('claude-fable-5.1');
  expect((await (await request.get('/api/settings')).json()).priceTable).toHaveLength(1);
  await page.reload();
  await expect(page.getByLabel('input rate 1', { exact: true })).toHaveValue('42');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved!' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Match mode 1', { exact: true })).toHaveValue('model');
  expect((await (await request.get('/api/settings')).json()).priceTable.length).toBeGreaterThan(60);
});

test('invalid input is visible and an intentionally empty table stays empty', async ({ page, request }) => {
  await request.post('/__test/reset', { data: { custom: true } });
  await page.goto('/settings');
  await page.getByLabel('input rate 1', { exact: true }).fill('-1');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('nonnegative');
  expect((await (await request.get('/api/settings')).json()).priceTable[0].input).toBe(42);
  await page.getByRole('button', { name: 'Remove row' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved!' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Model or pattern 1', { exact: true })).toHaveCount(0);
  expect((await (await request.get('/api/settings')).json()).priceTable).toEqual([]);
});

test('Tokens and Activity show partial estimates and see saved rate changes', async ({ page }) => {
  await page.goto('/tokens');
  await expect(page.getByRole('status')).toContainText('tokens have no matching price');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const gpt = page.locator('tr').filter({ has: page.locator('input[value="gpt-4.1"]') });
  await gpt.getByLabel(/^output rate/).fill('12');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved!' })).toBeVisible();
  await page.getByRole('link', { name: 'Tokens', exact: true }).click();
  await expect(page.getByText('$14.00', { exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page.getByText(/Unmatched models are unpriced/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'n/a', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await expect(page.getByText(/\(partial\)/).first()).toBeVisible();
});

test('toggling cost does not persist unsaved prices or a reset', async ({ page, request }) => {
  await request.post('/__test/reset', { data: { custom: true } });
  await page.goto('/settings');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await page.getByRole('checkbox', { name: 'Estimate cost' }).uncheck();
  await expect(page.getByRole('button', { name: 'Saved!' })).toBeVisible();
  const saved = await (await request.get('/api/settings')).json();
  expect(saved.priceTable).toHaveLength(1);
  expect(saved.priceTable[0].input).toBe(42);
  expect(saved.costEnabled).toBe(false);
  await page.getByRole('checkbox', { name: 'Estimate cost' }).check();
  await expect(page.getByLabel('Model or pattern 1', { exact: true })).toHaveValue('claude-fable-5.1');
  await page.reload();
  await expect(page.getByLabel('Model or pattern 1', { exact: true })).toHaveValue('gpt-4');
});

test('matching mode edits survive save and reload', async ({ page, request }) => {
  await request.post('/__test/reset', { data: { custom: true } });
  await page.goto('/settings');
  await page.getByLabel('Model or pattern 1', { exact: true }).fill('gpt-4.1');
  await page.getByLabel('Match mode 1', { exact: true }).selectOption('model');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved!' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Match mode 1', { exact: true })).toHaveValue('model');
  expect((await (await request.get('/api/settings')).json()).priceTable[0].match).toBe('model');
});
