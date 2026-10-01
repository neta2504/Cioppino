import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['pricing.spec.ts', 'agents.spec.ts'],
  globalTeardown: './tests/pricing-teardown.ts',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5189',
    browserName: 'chromium',
    ...(process.env.CIOPPINO_TEST_BROWSER ? { channel: process.env.CIOPPINO_TEST_BROWSER } : {}),
  },
  webServer: {
    command: 'node --import tsx ../backend/tests/pricing-browser-server.ts',
    url: 'http://127.0.0.1:5189/api/ready',
    reuseExistingServer: false,
  },
});
