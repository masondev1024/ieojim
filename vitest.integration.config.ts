import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        APP_ENV: 'test', OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '',
        BETTER_AUTH_SECRET: '', BETTER_AUTH_URL: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
      },
    },
  }))],
  test: { include: ['tests/integration/**/*.test.ts'], fileParallelism: false, testTimeout: 20000 },
});
