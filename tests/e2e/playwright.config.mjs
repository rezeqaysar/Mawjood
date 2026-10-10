// tests/e2e/playwright.config.mjs — Playwright config for CI smoke tests.
//
// The webServer serves the Expo web export (apps/mobile/dist) with the
// dependency-free static server above; Playwright then asserts the
// bundle loads and renders without fatal errors. This is a SMOKE test
// only — full user journeys require a live backend (Supabase) and are
// deliberately out of scope here.
export default {
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8901',
  },
  webServer: {
    // NOTE: Playwright executes webServer commands with cwd = this config
    // file's directory (tests/e2e/), so paths are relative to tests/e2e/.
    command: 'node static-server.mjs ../../apps/mobile/dist 8901',
    port: 8901,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
};
