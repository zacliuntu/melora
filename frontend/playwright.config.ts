import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', timeout: 240_000, expect: { timeout: 15_000 }, workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: process.env.MELODY_TEST_URL || 'http://127.0.0.1:17865',
    viewport: { width: 1440, height: 1100 }, trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] } },
});
