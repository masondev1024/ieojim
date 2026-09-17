import { defineConfig, devices } from '@playwright/test';

// Explicit staging-only checks. Fresh browser contexts own every test record.
export default defineConfig({
  testDir: './tests',
  testMatch: ['**/e2e/workspace.spec.ts', '**/e2e/security.spec.ts', '**/e2e/approved-copy.spec.ts', '**/e2e/current-plan-brief.spec.ts', '**/e2e/departure-landing.spec.ts', '**/e2e/departure-workspace.spec.ts', '**/remote/platform.spec.ts'],
  fullyParallel: false, workers: 1, retries: 0,
  timeout: 60000, expect: { timeout: 15000 },
  reporter: [['list'], ['json', { outputFile: 'artifacts/staging-browser-results.json' }]],
  use: { baseURL: 'https://ieojim-staging.masondev1024.workers.dev', trace: 'off', screenshot: 'only-on-failure' },
  projects: [{ name: 'staging-chromium', use: { ...devices['Desktop Chrome'] } }],
});
