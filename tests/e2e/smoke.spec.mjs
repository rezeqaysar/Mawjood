// tests/e2e/smoke.spec.mjs — CI smoke test for the Expo web bundle.
//
// Asserts only what a static export can prove:
//   1. the page loads with HTTP 200,
//   2. no pageerror / uncaught exceptions during load,
//   3. no failed SAME-ORIGIN asset requests (fonts, chunks, icons),
//   4. the page renders non-empty text (the JS bundle actually booted).
//
// SCOPE (honest): this does not log in, hit Supabase, or walk any user
// journey — those need a backend. A green smoke test means the bundle is
// syntactically valid and servable; nothing more.
import { test, expect } from '@playwright/test';

test('web bundle loads and renders without fatal errors', async ({ page }) => {
  const pageErrors = [];
  const failedSameOrigin = [];

  page.on('pageerror', (err) => pageErrors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
  });
  page.on('response', (resp) => {
    if (resp.status() >= 400) {
      const url = new URL(resp.url());
      if (url.origin === page.url() || url.hostname === 'localhost') {
        failedSameOrigin.push(`${resp.status()} ${resp.url()}`);
      }
    }
  });

  const resp = await page.goto('/', { waitUntil: 'load' });
  expect(resp?.status(), 'root must serve HTTP 200').toBe(200);

  // Give the JS bundle a beat to boot and render.
  await page.waitForTimeout(4000);

  expect(pageErrors, `uncaught errors during load: ${pageErrors.join('\n')}`).toEqual([]);
  expect(
    failedSameOrigin,
    `failed same-origin requests: ${failedSameOrigin.join('\n')}`,
  ).toEqual([]);

  const text = (await page.locator('body').innerText()).trim();
  expect(text.length, 'body should render non-empty text').toBeGreaterThan(0);
});
