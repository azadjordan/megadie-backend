// All APIs are intercepted; no database or live API is accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = 'http://localhost:5173', orderId = '100000000000000000000001';
test('recent work expires while offline and saved summaries contain no operational controls', { timeout: 60000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  async function fixture(t, width = 320, { aged = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 850 } }); t.after(() => context.close());
    const now = new Date('2026-11-20T19:59:50Z').getTime(), expiresAt = aged ? '2026-11-20T20:00:00Z' : '2026-11-22T20:00:00Z';
    const midnight = '2026-11-20T20:00:00Z';
    const profile = { _id: '200000000000000000000001', name: 'Worker', email: 'worker@test.invalid', isWorker: true, isAdmin: false, approvalStatus: 'Approved' };
    const metadata = { sessionId: 'fixture-work-session', sessionExpiresAt: now + 1800000, sessionAbsoluteExpiresAt: now + 28800000, sessionServerTime: now };
    const card = { orderId, orderNumber: 'ORD-TEST-ABC123', ...(aged ? {} : { customerName: 'Grand Printing', label: 'Grand Printing — ABC123' }), cartonReference: 'ABC123', privacyRefreshAt: midnight, version: 10, expiresAt,
      totalItems: 1, totalUnits: 10, items: [{ sku: 'RIB-TEST', name: 'Ribbon', qty: 10, unit: '100yd Roll', allocations: [], alternatives: [] }],
      work: [{ type: 'delivered', completedAt: aged ? '2026-11-18T10:00:00Z' : '2026-11-20T10:00:00Z', active: true, expiresAt }],
    };
    const state = { offline: false, denied: false, writes: [], unexpected: [] };
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return url.origin === origin ? route.continue() : route.abort();
      const path = url.pathname.slice(4), method = request.method();
      const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
      const reply = (data, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(data) });
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (path === '/users/account/profile') return reply({ data: { ...profile, ...metadata } });
      if (path === '/users/session/activity') return reply({ data: metadata });
      if (path === '/site-settings/maintenance-notice') return reply({ data: { enabled: false } });
      if (method !== 'GET') { state.writes.push(path); return reply({ message: 'Forbidden' }, 403); }
      if (path === '/packing/orders') return reply({ groups: Object.fromEntries(['to_pack', 'ready_delivery', 'ready_handoff'].map(key => [key, { data: [], pagination: { page: 1, total: 0, hasNext: false } }])) });
      if (path === '/packing/deliveries') return reply({ data: [], pagination: { page: 1, total: 0, hasNext: false } });
      if (state.offline) return route.abort('failed');
      if (state.denied) return reply({ message: 'History expired or access changed.' }, 403);
      if (path === '/packing/recent-work') return reply({ data: [card], counts: { packed: 0, delivered: 1 }, pagination: { page: 1, total: 1, hasNext: false }, checkedAt: new Date(now), refreshAt: midnight, monthly: { month: '2026-11', delivered: 15 } });
      if (path === `/packing/orders/${orderId}` || path === `/packing/deliveries/${orderId}`) return reply({ data: { ...card, scope: 'recent-work', status: 'Delivered', deliveryState: 'delivered', delivery: null } });
      state.unexpected.push(path); return reply({ message: 'Unexpected API' }, 500);
    });
    const page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => assert.fail(error.message));
    await page.clock.install({ time: new Date(now) });
    return { page, state };
  }

  await t.test('daily history and totals clear at Dubai midnight even if refresh fails', async t => {
    const { page, state } = await fixture(t);
    await page.goto(origin + '/packing?tab=recent');
    await page.getByRole('heading', { name: 'Grand Printing', exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px navigation must not overflow');
    await page.getByText('View items · 1 item · 10 units', { exact: true }).click();
    await page.getByText('10 × 100yd Roll', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Mark packed|Mark delivered|Assign delivery|Record payment/ }).count(), 0);
    state.offline = true; await page.clock.fastForward(11000);
    await page.getByText('A new day has started. Refresh to see your current work history.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Grand Printing', exact: true }).count(), 0);
    assert.equal(await page.locator('article').count(), 0);
    assert.deepEqual(state.unexpected, []); assert.deepEqual(state.writes, []);
  });
  for (const path of [`/packing/orders/${orderId}`, `/packing/deliveries/${orderId}`]) await t.test('saved link expires without retaining the old card: ' + path, async t => {
    const { page, state } = await fixture(t, 390, { aged: true }); await page.goto(origin + path);
    await page.getByRole('heading', { name: 'Carton ABC123', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: /Get directions|Call recipient/ }).count(), 0);
    state.offline = true; await page.clock.fastForward(11000);
    await page.getByText('This completed task is outside your three-day work history. Contact an admin if you need help.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Carton ABC123', exact: true }).count(), 0);
    assert.deepEqual(state.unexpected, []); assert.deepEqual(state.writes, []);
  });
  await t.test('today names disappear at midnight while the permitted carton summary remains', async t => {
    const { page, state } = await fixture(t, 390); await page.goto(origin + `/packing/deliveries/${orderId}`);
    await page.getByRole('heading', { name: 'Grand Printing', exact: true }).waitFor();
    state.offline = true; await page.clock.fastForward(11000);
    await page.getByRole('heading', { name: 'Carton ABC123', exact: true }).waitFor();
    assert.equal(await page.getByText('Grand Printing', { exact: true }).count(), 0);
    assert.equal(await page.getByText('View items · 1 item · 10 units', { exact: true }).count(), 1);
  });
  await t.test('monthly order total is independent of the selected day and offers no older order list', async t => {
    const { page } = await fixture(t); await page.goto(origin + '/packing?tab=recent');
    const total = page.locator('[aria-label="Monthly delivery total"]');
    await total.getByText('15', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Yesterday', exact: true }).click();
    await total.getByText('15', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Day before yesterday', exact: true }).click();
    await total.getByText('15', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Last 7 days|This month/ }).count(), 0);
  });
  await t.test('permission errors remove a previously displayed history card', async t => {
    const { page, state } = await fixture(t); await page.goto(origin + '/packing?tab=recent');
    await page.getByRole('heading', { name: 'Grand Printing', exact: true }).waitFor();
    state.denied = true; await page.getByRole('button', { name: 'Refresh work history', exact: true }).click();
    await page.getByText('Work history is no longer available to this account.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Grand Printing', exact: true }).count(), 0);
    assert.deepEqual(state.unexpected, []);
  });
});
