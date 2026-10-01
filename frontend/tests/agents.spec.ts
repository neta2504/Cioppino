import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page, request }) => {
  await request.post('/__test/reset');
  await request.post('/__test/agents', { data: {} });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:5189(?:\/|$))/, (route) => route.abort());
});

test('eight agent cards include one Warp entry with honest capability details', async ({ page }) => {
  await page.goto('/agents');
  for (const name of ['Kiro CLI', 'Kiro IDE', 'Junie CLI', 'goose CLI', 'goose Desktop', 'Pi Coding Agent', 'Zed', 'Warp']) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('Warp Agent', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /Warp Warp/ }).click();
  await expect(page.getByText('Whole application, not AI-only', { exact: true })).toBeVisible();
  await expect(page.getByText(/Includes Warp Agent/)).toBeVisible();
  await expect(page.getByText('Not yet supported', { exact: true }).first()).toBeVisible();
});

test('Pi details distinguish reported tokens from Activity estimates', async ({ page }) => {
  await page.goto('/agents');
  await page.getByRole('button', { name: /Pi Coding Agent Pi/ }).click();
  await expect(page.getByText('Reported Pi usage; missing models remain unpriced', { exact: true })).toBeVisible();
  await expect(page.getByText(/Standalone binaries and custom session directories are not detected/)).toBeVisible();
});

test('Tokens and Activity disclose unsupported telemetry instead of implying zero usage', async ({ page }) => {
  await page.goto('/tokens');
  await expect(page.getByText('Monitoring coverage', { exact: true })).toBeVisible();
  await expect(page.getByText(/Not yet supported:.*Kiro CLI/)).toBeVisible();
  await expect(page.getByText(/Pi: Tokens uses reported usage/)).toBeVisible();
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page.getByText(/Missing records are not evidence of zero usage/)).toBeVisible();
});

test('sanitized config inspection failures appear in agent details', async ({ page, request }) => {
  await request.post('/__test/agents', { data: { issue: true } });
  await page.goto('/agents');
  await page.getByRole('button', { name: /Zed Zed Industries/ }).click();
  await expect(page.getByRole('alert')).toHaveText('A user configuration could not be inspected.');
});
