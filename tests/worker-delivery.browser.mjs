// All API and outside navigation requests are intercepted. No production writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const origin = 'http://localhost:5173', orderId = '100000000000000000000001', workerId = '200000000000000000000001', otherId = '200000000000000000000002';
const metadata = () => ({ sessionId: 'worker-delivery-ui', sessionExpiresAt: Date.now() + 1800000, sessionAbsoluteExpiresAt: Date.now() + 28800000, sessionServerTime: Date.now() });

test('worker delivery browser flow', { timeout: 120000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  async function fixture(t, { width = 390, waiting = false, admin = false, map = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }); t.after(() => context.close());
    const state = { writes: [], unexpected: [], errors: [], lost: false, fail: false, denied: false,
      task: { orderId, orderNumber: 'ORD-TEST-ABC123', label: 'Al Noor Trading — ABC123', customerName: 'Al Noor Trading', version: 0, status: 'Shipping', packedAt: waiting ? null : '2026-11-17T08:00:00Z', deliveredAt: null, deliveryState: waiting ? 'waiting' : 'ready',
        worker: { id: workerId, name: 'Omar', enabled: true }, delivery: { contactName: 'Store recipient', phoneNumber: '+971501234567', secondaryPhoneNumber: '', address: 'Building 12, Shop 3, Al Ain', googleMapsUrl: map ? 'https://maps.app.goo.gl/saved-location' : '', notes: 'Use the side entrance.' },
        canAssign: admin, canDepart: !waiting, canDeliver: false, canReturn: false, canCorrect: false, readyReason: waiting ? 'Waiting for packing.' : '', items: [{ sku: 'RIB-RED', name: 'Red ribbon', qty: 10 }],
      },
    };
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()), method = req.method();
      if (!url.pathname.startsWith('/api/')) return url.origin === origin ? route.continue() : route.abort();
      const path = url.pathname.slice(4);
      const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
      const reply = (body, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (path === '/users/account/profile') return reply({ data: { _id: workerId, name: 'Omar', isWorker: !admin, isAdmin: admin, approvalStatus: 'Approved', ...metadata() } });
      if (path === '/users/session/activity') return reply({ data: metadata() });
      if (path === '/site-settings/maintenance-notice') return reply({ data: { enabled: false } });
      if (path === '/packing/orders') return reply({ groups: Object.fromEntries(['to_pack', 'ready_delivery', 'ready_handoff', 'in_delivery'].map(key => [key, { data: [], pagination: { page: 1, total: 0, hasNext: false } }])) });
      if (path === '/packing/deliveries') return reply({ data: state.denied || state.task.status !== 'Shipping' ? [] : [state.task], pagination: { page: 1, total: state.denied || state.task.status !== 'Shipping' ? 0 : 1, hasNext: false } });
      if (path === `/packing/deliveries/${orderId}`) return state.denied ? reply({ message: 'Reassigned' }, 403) : reply({ data: state.task });
      if (path === `/packing/deliveries/${orderId}/workers`) return reply({ data: [{ _id: workerId, name: 'Omar' }, { _id: otherId, name: 'Ahmed' }] });
      if (path === `/packing/deliveries/${orderId}/assignment` || path === `/packing/deliveries/${orderId}/movement`) {
        const body = req.postDataJSON(); state.writes.push(body);
        if (state.fail) { state.fail = false; state.task.version++; return reply({ message: 'Order changed. Reload and review.' }, 409); }
        assert.equal(body.expectedRevision, state.task.version);
        if (path.endsWith('assignment')) {
          state.task.worker = { id: body.workerId, name: 'Ahmed', enabled: true };
          if (!admin) state.denied = true;
        } else {
          if (body.action === 'departed') Object.assign(state.task, { deliveryState: 'out', canDepart: false, canDeliver: true, canReturn: true, canAssign: admin, canCorrect: admin });
          if (body.action === 'delivered') Object.assign(state.task, { status: 'Delivered', deliveryState: 'delivered', deliveredAt: '2026-11-17T09:00:00Z', canDepart: false, canDeliver: false, canReturn: false, canAssign: false, canCorrect: admin });
          if (body.action === 'returned') Object.assign(state.task, { deliveryState: 'returned', canDepart: true, canDeliver: false, canReturn: false, canAssign: admin, canCorrect: false });
          if (body.action === 'corrected') Object.assign(state.task, { status: 'Shipping', deliveryState: 'out', deliveredAt: null, canDepart: false, canDeliver: true, canReturn: true, canAssign: true, canCorrect: true });
        }
        state.task.version++;
        if (state.lost) { state.lost = false; return route.abort(); }
        return reply({ data: path.endsWith('assignment') ? { orderId } : state.task });
      }
      state.unexpected.push(method + ' ' + path); return reply({ message: 'Unexpected API' }, 500);
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => state.errors.push(error.message));
    t.after(() => { assert.deepEqual(state.unexpected, []); assert.deepEqual(state.errors, []); });
    return { context, page, state };
  }
  await t.test('delivery-only workers land on delivery cards with directions and calling, and cannot edit picking', async t => {
    const { page, state } = await fixture(t); await page.goto(origin + '/packing');
    await page.getByRole('heading', { name: 'Al Noor Trading' }).waitFor();
    const directions = page.getByRole('link', { name: 'Get directions', exact: true });
    assert.ok((await directions.getAttribute('href')).includes('destination=Building%2012'));
    assert.equal(await page.getByRole('link', { name: 'Call recipient' }).getAttribute('href'), 'tel:+971501234567');
    assert.equal(await page.getByRole('button', { name: 'Mark packed', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Mark delivered', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /Assign delivery|Change delivery worker/ }).count(), 0);
    assert.equal(state.writes.length, 0);
    await page.getByRole('link', { name: 'View delivery', exact: true }).click();
    await page.getByText('Use the side entrance.', { exact: true }).waitFor();
    await page.screenshot({ path: '../output/worker-delivery-ready-mobile.png', fullPage: true });
  });
  await t.test('departure and receipt each have a single explicit confirmation and double taps commit once', async t => {
    const { page, state } = await fixture(t); await page.goto(origin + '/packing/deliveries/' + orderId);
    await page.getByRole('button', { name: 'Mark out for delivery', exact: true }).click();
    let dialog = page.getByRole('dialog'); assert.equal(await dialog.getByRole('checkbox').count(), 0);
    await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] button')].some(button => button.textContent === 'Mark out for delivery' && !button.disabled));
    await dialog.getByRole('button', { name: 'Mark out for delivery', exact: true }).evaluate(button => { button.click(); button.click(); });
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(state.writes.length, 1); assert.equal(state.task.status, 'Shipping');
    await page.getByRole('button', { name: 'Mark delivered', exact: true }).click();
    await dialog.getByText('The customer has received the complete order.').waitFor();
    await dialog.getByRole('button', { name: 'Mark delivered', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await page.getByText('Delivered', { exact: true }).waitFor(); assert.deepEqual(state.writes.map(write => write.action), ['departed', 'delivered']);
  });
  await t.test('waiting for packing still exposes the location but cannot record departure', async t => {
    const { page, state } = await fixture(t, { waiting: true }); await page.goto(origin + '/packing/deliveries/' + orderId);
    await page.getByText('Waiting for packing.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Get directions' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Mark out for delivery' }).count(), 0); assert.equal(state.writes.length, 0);
  });
  await t.test('a saved pin opens its exact location; missing locations do not produce a guessed link', async t => {
    const { page, state } = await fixture(t, { map: true }); await page.goto(origin + '/packing/deliveries/' + orderId);
    assert.equal(await page.getByRole('link', { name: 'Open map' }).getAttribute('href'), state.task.delivery.googleMapsUrl);
    state.task.delivery.address = ''; state.task.delivery.googleMapsUrl = ''; state.task.version++; state.task.canDepart = false; state.task.readyReason = 'Delivery location is missing. Ask an admin to add the address or map.';
    await page.reload(); await page.getByText('No location saved.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('link', { name: /Get directions|Open map/ }).count(), 0);
  });
  await t.test('admins can change delivery responsibility without recording departure', async t => {
    const { page, state } = await fixture(t, { admin: true }); await page.goto(origin + '/packing/deliveries/' + orderId);
    await page.getByRole('button', { name: 'Change delivery worker' }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByLabel('Delivery worker', { exact: true }).selectOption(otherId);
    await dialog.getByRole('button', { name: 'Save delivery assignment' }).click(); await dialog.waitFor({ state: 'hidden' });
    await page.getByText('Carton ABC123 · Delivery: Ahmed', { exact: true }).waitFor();
    assert.equal(state.task.deliveryState, 'ready'); assert.equal(state.writes[0].action, undefined);
  });
  await t.test('workers have no assignment controls even with old cached permissions, and unassigned orders explain the wait', async t => {
    const { page, state } = await fixture(t);
    Object.assign(state.task, { worker: null, delivery: null, items: [], canAssign: true, canDepart: false, readyReason: 'Waiting for delivery assignment.' });
    await page.goto(origin + '/packing/deliveries/' + orderId);
    await page.getByText('Waiting for delivery assignment', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Assign delivery|Change delivery worker/ }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Mark out for delivery', exact: true }).count(), 0);
    assert.equal(state.writes.length, 0);
  });
  await t.test('an admin reassignment clears the former driver view on refresh', async t => {
    const { page, state } = await fixture(t); await page.goto(origin + '/packing/deliveries/' + orderId);
    await page.getByRole('link', { name: 'Get directions' }).waitFor();
    state.denied = true; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByText('This delivery is no longer assigned to you.').waitFor();
    assert.equal(await page.getByText('Building 12, Shop 3, Al Ain', { exact: true }).count(), 0);
    assert.equal(state.writes.length, 0);
  });
  await t.test('a lost departure response is recovered by reading without another departure or accidental receipt', async t => {
    const { page, state } = await fixture(t); state.lost = true; await page.goto(origin + '/packing/deliveries/' + orderId);
    await page.getByRole('button', { name: 'Mark out for delivery', exact: true }).click(); const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Mark out for delivery', exact: true }).click();
    await dialog.getByRole('button', { name: 'Check latest delivery' }).click();
    await dialog.getByText('This order is already out for delivery.').waitFor();
    assert.equal(state.writes.length, 1); assert.equal(await dialog.getByRole('button', { name: 'Mark delivered', exact: true }).count(), 0);
  });
  await t.test('a conflict requires a fresh review and an explicit second confirmation', async t => {
    const { page, state } = await fixture(t); state.fail = true; await page.goto(origin + '/packing/deliveries/' + orderId);
    await page.getByRole('button', { name: 'Mark out for delivery', exact: true }).click(); const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Mark out for delivery', exact: true }).click();
    await dialog.getByRole('button', { name: 'Check latest delivery' }).click();
    assert.equal(state.writes.length, 1); await dialog.getByRole('button', { name: 'Mark out for delivery', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(state.writes.length, 2); assert.equal(state.writes[1].expectedRevision, 1);
  });
  await t.test('return is under More and preserves packed readiness for another attempt', async t => {
    const { page, state } = await fixture(t); Object.assign(state.task, { deliveryState: 'out', canDepart: false, canDeliver: true, canReturn: true, canAssign: false });
    await page.goto(origin + '/packing/deliveries/' + orderId); await page.getByText('More', { exact: true }).click();
    await page.getByRole('button', { name: 'Returned to store', exact: true }).click(); const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Returned to store', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.ok(state.task.packedAt); await page.getByRole('button', { name: 'Mark out for delivery', exact: true }).waitFor(); assert.equal(state.writes[0].confirmedReturn, true);
  });
  await t.test('background changes cannot silently replace the revision being confirmed', async t => {
    const { page, state } = await fixture(t); await page.goto(origin + '/packing/deliveries/' + orderId);
    await page.getByRole('button', { name: 'Mark out for delivery', exact: true }).click(); const dialog = page.getByRole('dialog');
    await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] button')].some(button => button.textContent === 'Mark out for delivery' && !button.disabled));
    state.task.version++;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await dialog.getByText('This order changed. Check the latest delivery before confirming.').waitFor();
    assert.equal(state.writes.length, 0);
    await dialog.getByRole('button', { name: 'Check latest delivery' }).click();
    await dialog.getByRole('button', { name: 'Mark out for delivery', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(state.writes[0].expectedRevision, 1);
  });
  await t.test('admins recover a lost reassignment response without repeating the assignment', async t => {
    const { page, state } = await fixture(t, { admin: true }); state.lost = true; await page.goto(origin + '/packing/deliveries/' + orderId);
    await page.getByRole('button', { name: 'Change delivery worker' }).click(); const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Delivery worker', { exact: true }).selectOption(otherId); await dialog.getByRole('button', { name: 'Save delivery assignment' }).click();
    await dialog.getByRole('button', { name: 'Check latest assignment' }).click();
    await dialog.getByText('Current delivery worker: Ahmed', { exact: true }).waitFor();
    assert.equal(state.writes.length, 1); assert.equal(await dialog.getByRole('button', { name: 'Save delivery assignment' }).isDisabled(), true);
  });
  await t.test('admin corrections require a reason and acknowledgement, while workers have no correction control', async t => {
    const { page, state } = await fixture(t, { admin: true }); Object.assign(state.task, { status: 'Delivered', deliveryState: 'delivered', canDepart: false, canAssign: false, canCorrect: true });
    await page.goto(origin + '/packing/deliveries/' + orderId); await page.getByText('More', { exact: true }).click();
    await page.getByRole('button', { name: 'Correct recorded status', exact: true }).click(); const dialog = page.getByRole('dialog');
    const confirm = dialog.getByRole('button', { name: 'Correct recorded status', exact: true }); assert.equal(await confirm.isDisabled(), true);
    await dialog.getByLabel('Reason', { exact: true }).fill('Customer receipt recorded by mistake'); await dialog.getByRole('checkbox').check(); await confirm.click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(state.writes[0].confirmedCorrection, true); assert.ok(state.writes[0].note);
  });
  await t.test('offline disables writes and empty deliveries are explicit', async t => {
    const { page, context, state } = await fixture(t); await page.goto(origin + '/packing/deliveries/' + orderId);
    await page.getByRole('button', { name: 'Mark out for delivery', exact: true }).waitFor(); await context.setOffline(true);
    await page.getByText('Offline. Reconnect before updating delivery.').waitFor(); assert.equal(await page.getByRole('button', { name: 'Mark out for delivery', exact: true }).isDisabled(), true);
    await context.setOffline(false); state.denied = true; await page.goto(origin + '/packing?tab=deliveries');
    await page.getByText('No deliveries assigned to you.', { exact: false }).waitFor();
  });
  for (const width of [320, 1440]) await t.test(`delivery cards and details fit ${width}px without horizontal scrolling`, async t => {
    const { page } = await fixture(t, { width }); await page.goto(origin + '/packing?tab=deliveries'); await page.getByRole('link', { name: 'View delivery', exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('link', { name: 'View delivery', exact: true }).click(); await page.getByText('Use the side entrance.', { exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `../output/worker-delivery-${width}.png`, fullPage: true });
  });
});
