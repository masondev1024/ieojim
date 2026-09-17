import { defineConfig } from '@playwright/test';
import staging from './playwright.staging.config';

// Same deployed Worker/data, separate origin: explicitly verify both entry surfaces.
export default defineConfig({
  ...staging,
  testMatch: [...(staging.testMatch as string[]), '**/remote/domain.spec.ts'],
  reporter: [['list'], ['json', { outputFile: 'artifacts/custom-domain/browser-results.json' }]],
  use: { ...staging.use, baseURL: 'https://ieojim.jungseongheon.org' },
  projects: [{ name: 'domain-chromium', use: staging.projects![0].use }],
});
