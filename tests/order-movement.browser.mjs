// Every API is intercepted: no production database or real customer records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const origin = 'http://localhost:5173';
const id = '100000000000000000000001';
const metadata = () => ({ sessionId: 'movement-test', sessionExpiresAt: Date.now() + 1800000, sessionAbsoluteExpiresAt: Date.now() + 28800000, sessionServerTime: Date.now() });
const profile = { _id: '200000000000000000000001', name: 'Admin', isAdmin: true, approvalStatus: 'Approved' };

test('delivery movement browser flow', { timeout: 120000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  async function fixture(t, { width = 1400, out = false, returned = false, unassigned = false, legacyCompany = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 950 } }); t.after(() => context.close());
    const state = { writes: [], unexpected: [], errors: [], fail: false, lost: false,
      order: { _id: id, orderNumber: 'ORD-MOVEMENT', user: { _id: 'client', name: 'Azad Store' }, status: 'Shipping', allocationStatus: 'Allocated', orderItems: [{ product: 'p1', sku: 'SKU1', qty: 10, unitPrice: 2 }], stockChecksPending: 0, totalPrice: 20, listAction: out ? 'mark-delivered' : 'mark-out-for-delivery', createdAt: '2026-11-16T08:00:00Z' },
      view: { orderId: id, orderNumber: 'ORD-MOVEMENT', status: 'Shipping', version: 0, manualPreparation: true, readyReason: '', isOut: out, holdsGoods: out || returned, history: [], movement: out || returned ? { method: legacyCompany ? 'company' : 'courier', handler: legacyCompany ? 'Former owner' : 'Courier A', departedAt: '2026-11-16T08:00:00Z', ...(returned ? { returnedAt: '2026-11-16T09:00:00Z' } : {}) } : null },
    };
    state.order.deliveryMovement = state.view.movement;
    state.view.deliveryWorker = unassigned ? null : { id: '200000000000000000000001', name: 'Arun', enabled: true };
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return url.origin === origin ? route.continue() : route.abort();
      const path = url.pathname.slice(4), method = request.method();
      const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
      const reply = (body, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (path === '/users/account/profile') return reply({ data: { ...profile, ...metadata() } });
      if (path === '/users/session/activity') return reply({ data: metadata() });
      if (path === '/site-settings/maintenance-notice') return reply({ data: { enabled: false } });
      if (path === `/packing/deliveries/${id}` && method === 'GET') return reply({ data: { orderId: id, customerName: 'Azad Store', orderNumber: 'ORD-MOVEMENT', version: state.view.version, worker: null, delivery: null, deliveryState: state.view.isOut ? 'out' : 'ready', canAssign: true, canDepart: false, canDeliver: false, canReturn: false, canCorrect: false, items: [], status: state.order.status } });
      if (path === '/orders/work-summary') return reply({ data: {} });
      if (path === '/orders' && method === 'GET') return reply({ data: [state.order], pagination: { page: 1, totalPages: 1, total: 1, limit: 20 } });
      if (path === `/orders/${id}` && method === 'GET') return reply({ data: state.order });
      if (path === `/orders/${id}/allocations` && method === 'GET') return reply({ data: [{ _id: 'allocation', product: { _id: 'p1', name: 'Ribbon', sku: 'SKU1' }, slot: { _id: 'slot', label: 'A1-AE1' }, qty: 10, pickedQty: 10, status: 'Reserved' }] });
      if (path === `/orders/${id}/items-editor` && method === 'GET') return reply({ data: { orderId: id, orderNumber: 'ORD-MOVEMENT', customerName: 'Azad Store', version: state.view.version, status: 'Shipping', canEdit: true, lockReason: '', history: [], deliveryCharge: 0, extraFee: 0, items: [{ key: 'line-0', productId: 'p1', sku: 'SKU1', name: 'Ribbon', unit: 'units', qty: 10, unitPrice: 2, reservedQty: 10, pickedQty: 0, problemQty: 0 }] } });
      if (path === '/slot-items/by-product/p1') return reply({ data: [] });
      if (path === `/orders/${id}/movement` && method === 'GET') return reply({ data: state.view });
      if (path === `/orders/${id}/movement` && method === 'POST') {
        const body = request.postDataJSON(); state.writes.push(body);
        if (state.fail) { state.fail = false; return reply({ message: 'Order changed. Reload delivery details and review before saving.' }, 409); }
        assert.equal(body.expectedRevision, state.view.version);
        const at = new Date().toISOString();
        const assigned = state.view.deliveryWorker;
        const actualMethod = assigned ? 'company' : body.method;
        const actualHandler = assigned ? assigned.name : body.handler;
        if (body.action === 'departed') { state.view.movement = { method: actualMethod, handler: actualHandler, departedAt: at }; state.view.isOut = true; state.view.holdsGoods = true; }
        if (body.action === 'returned') { state.view.movement.returnedAt = at; state.view.isOut = false; }
        if (body.action === 'reshelved') { state.view.movement.slotsReturnedAt = at; state.view.holdsGoods = false; }
        if (['delivered', 'collected'].includes(body.action)) { state.view.status = 'Delivered'; state.view.deliveredAt = at; state.view.deliveredBy = state.view.isOut ? state.view.movement.handler : body.handler; state.view.movement ||= { method: body.method, handler: body.handler }; state.view.isOut = false; state.view.holdsGoods = false; }
        state.view.history.push({ action: body.action, method: body.method, handler: body.handler, at, actorName: 'Admin' }); state.view.version++;
        state.order.deliveryMovement = state.view.movement; state.order.status = state.view.status;
        state.order.listAction = state.view.isOut ? 'mark-delivered' : 'mark-out-for-delivery';
        state.order.deliveredBy = state.view.deliveredBy;
        if (state.view.status === 'Delivered') state.order.listAction = 'create-invoice';
        if (state.lost) { state.lost = false; return route.abort(); }
        return reply({ data: state.view });
      }
      state.unexpected.push(`${method} ${path}`); return reply({ message: 'Unexpected API' }, 500);
    });
    const page = await context.newPage(); page.on('pageerror', error => state.errors.push(error.message));
    t.after(() => { assert.deepEqual(state.unexpected, []); assert.deepEqual(state.errors, []); });
    await page.goto(origin + '/admin/orders');
    await page.getByRole('button', { name: out ? 'Mark delivered' : 'Mark out for delivery', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: out ? 'Mark delivered' : 'Mark out for delivery', exact: true }).waitFor();
    return { page, state, dialog: page.getByRole('dialog') };
  }
  async function more(page, label) {
    await page.getByRole('button', { name: /^More actions for / }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  }
  await t.test('assigned delivery uses its account without typed names', async t => {
    const { page, state, dialog } = await fixture(t);
    assert.equal(await dialog.getByRole('combobox').count(), 0); assert.equal(await dialog.getByRole('checkbox').count(), 0);
    await dialog.getByText('Arun', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('textbox').count(), 0);
    await dialog.getByRole('button', { name: 'Mark out for delivery', exact: true }).evaluate(button => { button.click(); button.click(); });
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(state.writes.length, 1); assert.equal(state.writes[0].handler, undefined); assert.equal(state.writes[0].method, undefined);
    assert.equal(state.view.status, 'Shipping');
    await page.getByRole('group', { name: 'Delivery', exact: true }).getByText('Out for delivery', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Mark delivered', exact: true }).click();
    assert.equal(await dialog.getByRole('textbox').count(), 0); assert.equal(await dialog.getByRole('checkbox').count(), 0);
    await dialog.getByRole('button', { name: 'Mark delivered', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(state.view.status, 'Delivered'); assert.deepEqual(state.writes.map(w => w.action), ['departed', 'delivered']);
  });
  for (const [value, name, width] of [['azad', 'Azad', 1440], ['momani', 'Momani', 320]]) await t.test(`${name} is an explicit owner choice with no typed name at ${width}px`, async t => {
    const { page, dialog, state } = await fixture(t, { unassigned: true, width });
    const select = dialog.getByRole('combobox', { name: 'Delivery method', exact: true });
    assert.deepEqual(await select.locator('option').allTextContents(), ['Choose delivery method', 'Azad', 'Momani', 'Courier', 'Customer collection']);
    assert.equal(await dialog.getByRole('button', { name: 'Mark out for delivery', exact: true }).isDisabled(), true);
    await select.selectOption(value);
    assert.equal(await dialog.getByRole('textbox').count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `../output/delivery-owner-${value}-${width}.png`, fullPage: true });
    await dialog.getByRole('button', { name: 'Mark out for delivery', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(state.writes[0].handler, name); assert.equal(state.writes[0].method, 'company'); assert.equal(state.view.isOut, true);
  });
  await t.test('courier requires its own name and switching choices clears stale input', async t => {
    const { dialog, state } = await fixture(t, { unassigned: true });
    const select = dialog.getByRole('combobox', { name: 'Delivery method', exact: true });
    const confirm = dialog.getByRole('button', { name: 'Mark out for delivery', exact: true });
    await select.selectOption('azad'); await select.selectOption('courier');
    const input = dialog.getByLabel('Courier name', { exact: true });
    assert.equal(await input.inputValue(), ''); assert.equal(await confirm.isDisabled(), true);
    await input.fill('   '); assert.equal(await confirm.isDisabled(), true);
    await input.fill('Courier A'); assert.equal(await confirm.isDisabled(), false);
    await select.selectOption('momani'); assert.equal(await dialog.getByRole('textbox').count(), 0);
    await confirm.click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(state.writes[0].handler, 'Momani'); assert.equal(state.writes[0].method, 'company');
  });
  await t.test('courier choice submits its required name', async t => {
    const { dialog, state } = await fixture(t, { unassigned: true });
    await dialog.getByRole('combobox', { name: 'Delivery method', exact: true }).selectOption('courier');
    await dialog.getByLabel('Courier name', { exact: true }).fill('Courier B');
    await dialog.getByRole('button', { name: 'Mark out for delivery', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(state.writes[0].handler, 'Courier B'); assert.equal(state.writes[0].method, 'courier');
  });
  await t.test('an older company departure completes using its recorded name without asking for an owner', async t => {
    const { dialog, state } = await fixture(t, { out: true, unassigned: true, legacyCompany: true });
    await dialog.getByText('Handed to: Former owner', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('combobox').count(), 0); assert.equal(await dialog.getByRole('textbox').count(), 0);
    await dialog.getByRole('button', { name: 'Mark delivered', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(state.writes[0].handler, undefined); assert.equal(state.writes[0].method, undefined);
    assert.equal(state.view.deliveredBy, 'Former owner');
  });
  await t.test('customer collection uses an explicit choice without inventing departure', async t => {
    const { page, dialog, state } = await fixture(t, { unassigned: true }); await dialog.getByRole('button', { name: 'Close' }).click();
    await more(page, 'Mark delivered');
    await dialog.getByText('This also covers customer collection.', { exact: false }).waitFor();
    await dialog.getByRole('combobox', { name: 'Delivery method', exact: true }).selectOption('collection'); assert.equal(await dialog.getByRole('checkbox').count(), 0);
    await dialog.getByRole('button', { name: 'Confirm customer collection', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(state.writes[0].action, 'collected'); assert.equal(state.view.movement.departedAt, undefined);
    await more(page, 'Delivery history'); await dialog.getByText('Collected by customer', { exact: true }).waitFor();
  });
  await t.test('return is an exception under More and keeps goods packed for another departure', async t => {
    const { page, dialog, state } = await fixture(t, { out: true }); await dialog.getByRole('button', { name: 'Close' }).click();
    await more(page, 'Returned to store');
    assert.equal(await dialog.getByRole('checkbox').count(), 0);
    await dialog.getByRole('button', { name: 'Returned to store', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(state.view.holdsGoods, true); assert.equal(state.view.isOut, false);
    await page.getByRole('button', { name: 'Mark out for delivery', exact: true }).click();
    assert.equal(await dialog.getByRole('checkbox').count(), 0);
    await dialog.getByRole('button', { name: 'Mark out for delivery', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(state.writes.map(w => w.action), ['returned', 'departed']);
  });
  await t.test('physical return confirmation appears when editing items on a returned order', async t => {
    const { page, dialog, state } = await fixture(t, { returned: true }); await dialog.getByRole('button', { name: 'Close' }).click();
    await page.goto(origin + `/admin/orders/${id}`);
    await page.getByRole('button', { name: 'Edit items', exact: true }).click();
    await dialog.getByRole('checkbox', { name: 'Every unit is physically back in its original slot.' }).waitFor();
    const proceed = dialog.getByRole('button', { name: 'Continue', exact: true });
    assert.equal(await proceed.isDisabled(), true); assert.equal(state.writes.length, 0);
    await dialog.getByRole('checkbox').check(); await proceed.click();
    await page.getByRole('dialog', { name: 'Edit order items', exact: true }).waitFor();
    assert.equal(state.writes[0].action, 'reshelved'); assert.equal(state.view.holdsGoods, false);
  });
  await t.test('stale conflicts require a fresh read, keeping the attempted action explicit', async t => {
    const { dialog, state } = await fixture(t); state.fail = true;
    await dialog.getByRole('button', { name: 'Mark out for delivery', exact: true }).click();
    await dialog.getByRole('button', { name: 'Check latest delivery' }).click();
    await dialog.getByRole('button', { name: 'Mark out for delivery', exact: true }).waitFor(); assert.equal(state.writes.length, 1);
  });
  await t.test('a lost departure response cannot turn into a delivery or duplicate departure', async t => {
    const { dialog, state } = await fixture(t); state.lost = true;
    await dialog.getByRole('button', { name: 'Mark out for delivery', exact: true }).click();
    await dialog.getByRole('button', { name: 'Check latest delivery' }).click();
    await dialog.getByText('This order is already out for delivery.', { exact: true }).waitFor();
    assert.equal(state.writes.length, 1); assert.equal(await dialog.getByRole('button', { name: 'Mark delivered', exact: true }).count(), 0);
    assert.equal(await dialog.getByRole('button', { name: 'Mark out for delivery', exact: true }).count(), 0);
  });
  await t.test('order details shows one next action and protects stock while goods are out', async t => {
    const { page, dialog } = await fixture(t, { out: true }); await dialog.getByRole('button', { name: 'Close' }).click();
    await page.goto(origin + `/admin/orders/${id}`);
    await page.getByLabel('Delivery movement').getByText('Out for delivery', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Send to worker', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Edit items', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Mark delivered', exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Mark delivered', exact: true }).click();
    assert.equal(await dialog.getByRole('checkbox').count(), 0);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await page.screenshot({ path: '../output/simple-delivery-details.png', fullPage: true });
  });
  for (const width of [320, 390, 1440]) await t.test(`simple confirmation fits at ${width}px and supports keyboard dismissal`, async t => {
    const { page, dialog } = await fixture(t, { width });
    const box = await dialog.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `../output/simple-delivery-${width}.png`, fullPage: true });
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: 'Mark out for delivery', exact: true }).evaluate(node => node === document.activeElement), true);
  });
});
