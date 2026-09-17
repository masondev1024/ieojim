import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1, retries: 0,
  timeout: 45000, expect: { timeout: 10000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node --import tsx scripts/dev-e2e.ts',
    url: 'http://127.0.0.1:5174/api/config',
    reuseExistingServer: false,
    timeout: 90000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
