// Start the frontend locally, then run: node tests/maintenanceNotice.browser.mjs
// All API traffic is mocked; this never changes production settings.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  let enabled = false;
  let failSave = false;
  let failRead = false;
  const message = 'We’re carrying out temporary maintenance. Please contact us to confirm stock availability during this time.';
  await context.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    let data = [];
    if (url.pathname.includes('/site-settings/maintenance-notice')) {
      if ((request.method() === 'PUT' && failSave) || (request.method() === 'GET' && failRead)) {
        return route.fulfill({ status: 503, json: { message: 'Test failure' } });
      }
      if (request.method() === 'PUT') enabled = request.postDataJSON().enabled;
      data = { enabled, message, updatedBy: 'Test Admin', updatedAt: '2026-10-11T12:00:00Z' };
    } else if (url.pathname.endsWith('/users/account/profile')) {
      data = { _id: 'test-admin', name: 'Test Admin', isAdmin: true, approvalStatus: 'Approved' };
    }
    await route.fulfill({ json: { data, total: 0 } });
  });
  const admin = await context.newPage();
  const client = await context.newPage();
  const errors = [];
  for (const page of [admin, client]) page.on('pageerror', e => errors.push(e.message));
  await admin.goto('http://127.0.0.1:5173/admin');
  await admin.getByRole('button', { name: 'Show notice', exact: true }).click();
  await admin.getByRole('button', { name: 'Hide notice', exact: true }).waitFor();
  await client.setViewportSize({ width: 390, height: 844 });
  await client.goto('http://127.0.0.1:5173/');
  const banner = client.getByRole('complementary', { name: 'Maintenance notice' });
  await banner.waitFor();
  await client.getByRole('button', { name: 'Pause maintenance notice' }).click();
  assert.equal(await client.locator('.maintenance-notice-track').evaluate(el => getComputedStyle(el).animationPlayState), 'paused');
  assert.equal(await client.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const heights = await client.locator('header').evaluate(el => ({ measured: el.getBoundingClientRect().height, css: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-header-h')) }));
  assert.ok(Math.abs(heights.measured - heights.css) < 1);
  await client.screenshot({ path: '/tmp/megadie-notice-mobile.png' });
  await client.emulateMedia({ reducedMotion: 'reduce' });
  await client.getByRole('button', { name: 'Play maintenance notice' }).waitFor({ state: 'hidden' });
  assert.equal(await client.locator('.maintenance-notice-track').evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.equal(await client.locator('.maintenance-notice-text').evaluate(el => getComputedStyle(el).whiteSpace), 'normal');
  await client.emulateMedia({ reducedMotion: 'no-preference' });
  await client.setViewportSize({ width: 1440, height: 900 });
  await client.getByRole('button', { name: /maintenance notice/ }).waitFor({ state: 'hidden' });
  failRead = true;
  await client.evaluate(() => window.dispatchEvent(new Event('focus')));
  await client.waitForResponse(r => r.url().includes('/maintenance-notice') && r.status() === 503);
  assert.equal(await banner.isVisible(), true);
  failRead = false;
  failSave = true;
  await admin.getByRole('button', { name: 'Hide notice', exact: true }).click();
  await admin.getByRole('alert').filter({ hasText: 'Couldn’t confirm' }).waitFor();
  assert.equal(enabled, true);
  failSave = false;
  await admin.getByRole('button', { name: 'Hide notice', exact: true }).click();
  await admin.getByRole('button', { name: 'Show notice', exact: true }).waitFor();
  await client.evaluate(() => window.dispatchEvent(new Event('focus')));
  await banner.waitFor({ state: 'hidden' });
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.screenshot({ path: '/tmp/megadie-notice-admin.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: show/hide, mobile layout, header height, pause, reduced motion, desktop fit, read/save failures, and refresh across sessions.');
} finally { await browser.close(); }
