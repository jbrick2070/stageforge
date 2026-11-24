import { defineConfig } from '@playwright/test';

// PW_PORT lets parallel runs (or a busy 4179) use another dev-server port.
const PORT = Number(process.env.PW_PORT) || 4179;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Uses the installed Google Chrome so no browser download is needed.
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
