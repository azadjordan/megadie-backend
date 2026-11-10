// All API traffic is intercepted; this never changes production notices.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const origin = process.env.NOTICE_TEST_ORIGIN || 'http://127.0.0.1:5173';
const defaultMessage = 'We’re carrying out temporary maintenance. Please contact us to confirm stock availability during this time.';
const customMessage = 'Our warehouse is being reorganized today. Please contact us to confirm stock availability before collecting an order. Online ordering remains available.';
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const state = { enabled: false, message: defaultMessage, failSave: false, failPublicRead: false, writes: [], errors: [] };
  const absolute = Date.now() + 28800000;
  const metadata = () => ({ sessionId: 'fixture-admin-session', sessionAbsoluteExpiresAt: absolute, sessionExpiresAt: Date.now() + 1800000, sessionServerTime: Date.now() });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return url.origin === origin ? route.continue() : route.abort();
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,PUT,POST,OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const reply = (body, status = 200) => route.fulfill({ status, headers, json: body });
    let data = [];
    if (url.pathname.includes('/site-settings/maintenance-notice')) {
      const adminRead = url.pathname.endsWith('/admin');
      if ((request.method() === 'PUT' && state.failSave) || (request.method() === 'GET' && !adminRead && state.failPublicRead)) return reply({ message: 'Test failure' }, 503);
      if (request.method() === 'PUT') {
        const body = request.postDataJSON();
        state.writes.push(body);
        if (Object.hasOwn(body, 'enabled')) state.enabled = body.enabled;
        if (Object.hasOwn(body, 'message')) state.message = body.message;
      }
      data = { enabled: state.enabled, message: state.enabled || adminRead || request.method() === 'PUT' ? state.message : defaultMessage, ...(adminRead || request.method() === 'PUT' ? { updatedBy: 'Test Admin', updatedAt: new Date().toISOString() } : {}) };
    } else if (url.pathname.endsWith('/users/session/activity')) {
      data = metadata();
    } else if (url.pathname.endsWith('/users/account/profile')) {
      data = { ...metadata(), _id: 'test-admin', name: 'Test Admin', isAdmin: true, approvalStatus: 'Approved' };
    }
    return reply({ data, total: 0 });
  });
  const admin = await context.newPage();
  const client = await context.newPage();
  for (const page of [admin, client]) page.on('pageerror', e => state.errors.push(e.message));
  const refreshClient = async (status = 200) => {
    const response = client.waitForResponse(r => new URL(r.url()).pathname === '/api/site-settings/maintenance-notice' && r.status() === status);
    await client.evaluate(() => window.dispatchEvent(new Event('focus')));
    await response;
  };
  const message = admin.getByLabel('Notice message', { exact: true });
  const control = admin.locator('section[aria-labelledby="maintenance-notice-title"]');
  await admin.goto(origin + '/admin');
  await message.waitFor();
  assert.equal(await message.inputValue(), defaultMessage);
  assert.equal(await message.getAttribute('maxlength'), '500');
  await message.fill(customMessage);
  assert.equal(await control.getByLabel('Notice preview').textContent(), customMessage);
  assert.equal(state.writes.length, 0);
  await admin.getByRole('button', { name: 'Save message', exact: true }).click();
  await control.getByRole('status').filter({ hasText: 'Message saved' }).waitFor();
  assert.equal(state.enabled, false);
  assert.deepEqual(state.writes.at(-1), { message: customMessage });
  assert.equal(await message.inputValue(), customMessage);

  await admin.getByRole('button', { name: 'Show notice', exact: true }).click();
  await admin.getByRole('button', { name: 'Hide notice', exact: true }).waitFor();
  assert.deepEqual(state.writes.at(-1), { enabled: true, message: customMessage });
  await client.setViewportSize({ width: 390, height: 844 });
  await client.goto(origin + '/');
  const banner = client.getByRole('complementary', { name: 'Maintenance notice' });
  await banner.waitFor();
  assert.match(await banner.textContent(), /Our warehouse is being reorganized today/);
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
  state.failPublicRead = true;
  await refreshClient(503);
  assert.equal(await banner.isVisible(), true);
  state.failPublicRead = false;

  const updatedMessage = 'Our store reopens tomorrow at 9 AM.';
  await message.fill(updatedMessage);
  await admin.getByRole('button', { name: 'Update visible message', exact: true }).click();
  await control.getByRole('status').filter({ hasText: 'Visible notice message updated' }).waitFor();
  assert.equal(state.enabled, true);
  assert.deepEqual(state.writes.at(-1), { message: updatedMessage });
  assert.equal(await message.inputValue(), updatedMessage);
  await refreshClient();
  await banner.getByText(updatedMessage, { exact: true }).first().waitFor();

  const draft = 'This message is prepared for our next notice.';
  await message.fill(draft);
  const refreshed = admin.waitForResponse(r => r.url().endsWith('/maintenance-notice/admin'));
  await admin.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  assert.equal(await message.inputValue(), draft, 'Background refresh keeps unsaved edits');
  await admin.getByRole('button', { name: 'Hide notice', exact: true }).click();
  await admin.getByRole('button', { name: 'Show notice', exact: true }).waitFor();
  assert.deepEqual(state.writes.at(-1), { enabled: false });
  assert.equal(state.message, updatedMessage);
  assert.equal(await message.inputValue(), draft);
  await refreshClient();
  await banner.waitFor({ state: 'hidden' });
  await admin.getByRole('button', { name: 'Show notice', exact: true }).click();
  await admin.getByRole('button', { name: 'Hide notice', exact: true }).waitFor();
  assert.equal(state.message, draft);

  await message.fill(' \n ');
  assert.equal(await admin.getByRole('button', { name: 'Update visible message' }).isDisabled(), true);
  assert.equal(await admin.getByRole('button', { name: 'Hide notice', exact: true }).isDisabled(), false);
  await admin.getByRole('button', { name: 'Hide notice', exact: true }).click();
  await admin.getByRole('button', { name: 'Show notice', exact: true }).waitFor();
  assert.equal(await admin.getByRole('button', { name: 'Show notice', exact: true }).isDisabled(), true);
  await admin.getByRole('button', { name: 'Use default text', exact: true }).click();
  assert.equal(await message.inputValue(), defaultMessage);
  assert.equal(state.message, draft, 'Restoring the default requires a save or show action');
  state.failSave = true;
  await admin.getByRole('button', { name: 'Save message', exact: true }).click();
  await control.getByRole('alert').filter({ hasText: 'Couldn’t confirm' }).waitFor();
  assert.equal(await message.inputValue(), defaultMessage);
  assert.equal(state.message, draft);
  state.failSave = false;
  await admin.getByRole('button', { name: 'Save message', exact: true }).click();
  await control.getByRole('status').filter({ hasText: 'Message saved' }).waitFor();
  assert.equal(state.enabled, false);

  const literal = '<img src=x onerror="window.__noticeExecuted=true"> Maintenance today.';
  await message.fill(literal);
  assert.equal(await control.getByLabel('Notice preview').locator('img').count(), 0);
  await admin.getByRole('button', { name: 'Show notice', exact: true }).click();
  await admin.getByRole('button', { name: 'Hide notice', exact: true }).waitFor();
  await refreshClient();
  await banner.getByText(literal, { exact: true }).first().waitFor();
  assert.equal(await banner.locator('img').count(), 0);
  assert.equal(await client.evaluate(() => window.__noticeExecuted), undefined);
  await message.fill('x'.repeat(500));
  await control.getByText('500/500', { exact: true }).waitFor();
  await admin.getByRole('button', { name: 'Discard changes', exact: true }).click();
  assert.equal(await message.inputValue(), literal);
  await message.fill(customMessage);
  await control.screenshot({ path: '/tmp/megadie-notice-admin-desktop.png' });
  for (const width of [390, 320]) {
    await admin.setViewportSize({ width, height: 844 });
    assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await admin.setViewportSize({ width: 390, height: 1000 });
  await control.screenshot({ path: '/tmp/megadie-notice-admin.png' });
  assert.deepEqual(state.errors, []);
  console.log('PASS: editable messages, hidden drafts, atomic show, visible updates, hide preserving edits, polling, validation, save failure recovery, default restore, safe text rendering, mobile layout and reduced motion.');
} finally { await browser.close(); }
