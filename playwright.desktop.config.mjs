import { defineConfig } from '@playwright/test';

// Desktop smoke tests boot the BUILT Electron app in desktop/build/app, so run
// `npm run desktop:prepare` before `npm run test:desktop`. The default
// `npx playwright test` (playwright.config.mjs) stays web-only.
export default defineConfig({
  testDir: 'tests/desktop',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
});
