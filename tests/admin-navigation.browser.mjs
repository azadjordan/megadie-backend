// All APIs are intercepted; these checks never reach a database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.ADMIN_UI_TEST_ORIGIN || 'http://localhost:5173';

test('admin navigation, filters and pagination', { timeout: 60000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  async function fixture(t, width = 1440) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    t.after(() => context.close());
    const state = { requests: [], unexpected: [], errors: [] };
    const absolute = Date.now() + 28800000;
    const metadata = () => ({ sessionId: 'admin-ui-session', sessionExpiresAt: Date.now() + 1800000, sessionAbsoluteExpiresAt: absolute, sessionServerTime: Date.now() });
    const order = { _id: '100000000000000000000001', orderNumber: 'ORD-UI-001', user: { name: 'Ahmed Trading' }, createdAt: '2026-11-14T09:00:00Z', status: 'Shipping', allocationStatus: 'Allocated', orderItems: [{ product: 'p1', qty: 10, unitPrice: 25 }], assignedTo: 'Ahmed', packingSentAt: '2026-11-14T09:00:00Z', packingSummary: { totalItems: 1, collectedItems: 0 }, listAction: 'view-packing' };
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (!url.pathname.startsWith('/api/')) return url.origin === origin ? route.continue() : route.abort();
      const path = url.pathname.slice(4), method = req.method();
      const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
      const reply = body => route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify(body) });
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
      state.requests.push({ path, method, query: Object.fromEntries(url.searchParams) });
      if (path === '/users/account/profile') return reply({ data: { _id: 'owner', name: 'Owner', email: 'owner@test.invalid', isAdmin: true, approvalStatus: 'Approved', ...metadata() } });
      if (path === '/users/session/activity') return reply({ data: metadata() });
      if (path === '/site-settings/maintenance-notice') return reply({ data: { enabled: false } });
      if (path === '/orders/work-summary') return reply({ data: { all: 155, needsAdmin: 1, preparation: 100, toInvoice: 5, toDeliver: 5, toFinalize: 5, needsStockCheck: 2 } });
      const page = Number(url.searchParams.get('page')) || 1, limit = Number(url.searchParams.get('limit')) || 10;
      const totalPages = Math.ceil(155 / limit);
      const pagination = { page, limit, total: 155, totalPages, hasPrev: page > 1, hasNext: page < totalPages };
      if (path === '/orders') return reply({ data: [order], pagination });
      if (path === '/invoices') return reply({ data: [], pagination });
      if (path === '/users') return reply({ data: [], pagination });
      if (path === '/products/meta') return reply({ data: { productTypes: [] } });
      if (path === '/categories' || path === '/slots') return reply({ data: [], page, pages: totalPages, limit, total: 155 });
      if (path === '/slots/summary') return reply({ data: {} });
      state.unexpected.push(method + ' ' + path);
      return route.fulfill({ status: 500, body: 'Unexpected mocked API' });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', err => state.errors.push(err.message));
    t.after(() => { assert.deepEqual(state.unexpected, []); assert.deepEqual(state.errors, []); });
    return { page, state };
  }

  await t.test('visible filters and pagination retain each other; resetting filters retains page size', async t => {
    const { page, state } = await fixture(t);
    await page.goto(origin + '/admin/orders?page=2&limit=20&work=preparation&paymentStatus=paymentDue&status=Shipping&search=Ahmed');
    const paginations = page.getByRole('navigation', { name: 'Pagination', exact: true });
    const pagination = paginations.first(), bottomPagination = paginations.last();
    await pagination.getByText('Page 2 of 8', { exact: true }).waitFor();
    assert.equal(await paginations.count(), 2);
    assert.equal(await page.getByRole('button', { name: 'Filters', exact: true }).count(), 0);
    assert.equal(await page.getByRole('combobox', { name: 'Billing', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('combobox', { name: 'Order stage', exact: true }).isVisible(), true);
    await bottomPagination.getByRole('button', { name: 'Next page', exact: true }).click();
    await pagination.getByText('Page 3 of 8', { exact: true }).waitFor();
    await bottomPagination.getByText('Page 3 of 8', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('work'), 'preparation');
    assert.equal(new URL(page.url()).searchParams.get('search'), 'Ahmed');
    await page.goBack();
    await pagination.getByText('Page 2 of 8', { exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Order stage', exact: true }).selectOption('Processing');
    await pagination.getByText('Page 1 of 8', { exact: true }).waitFor();
    assert.equal(await pagination.getByRole('button', { name: 'Previous page' }).isDisabled(), true);
    const query = new URL(page.url()).searchParams;
    assert.equal(query.get('paymentStatus'), 'paymentDue'); assert.equal(query.get('limit'), '20');
    await page.getByRole('combobox', { name: 'Per page', exact: true }).selectOption('50');
    await pagination.getByText('Page 1 of 4', { exact: true }).waitFor();
    assert.equal(state.requests.filter(req => req.path === '/orders').at(-1).query.status, 'Processing');
    await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
    await page.getByRole('button', { name: 'Reset filters', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(new URL(page.url()).search, '?limit=50');
    assert.equal(await page.getByRole('combobox', { name: 'Per page', exact: true }).inputValue(), '50');
    assert.equal(await page.getByRole('combobox', { name: 'Billing', exact: true }).inputValue(), 'all');
  });

  await t.test('mobile drawer contains focus, closes with Escape, navigates and cleans up on desktop resize', async t => {
    const { page } = await fixture(t, 390);
    await page.goto(origin + '/admin/orders');
    const toggle = page.getByRole('button', { name: 'Toggle admin navigation', exact: true });
    await toggle.click();
    const drawer = page.getByRole('dialog', { name: 'Admin navigation', exact: true });
    const close = drawer.getByRole('button', { name: 'Close admin navigation', exact: true });
    assert.equal(await close.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('main').evaluate(node => Boolean(node.closest('[inert]'))), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await drawer.getByRole('button', { name: 'Logout', exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await close.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
    await toggle.click();
    await drawer.getByRole('link', { name: 'Invoices', exact: true }).click();
    await page.waitForURL('**/admin/invoices');
    await drawer.waitFor({ state: 'hidden' });
    await page.locator('main').getByText('Invoices', { exact: true }).waitFor();
    assert.equal(await page.locator('main').evaluate(node => Boolean(node.closest('[inert]'))), false);
    await page.getByRole('navigation', { name: 'Pagination', exact: true }).waitFor();
    await toggle.click();
    assert.equal(await drawer.getByRole('link', { name: 'Invoices', exact: true }).getAttribute('aria-current'), 'page');
    await page.setViewportSize({ width: 1024, height: 800 });
    await drawer.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.body.style.overflow), '');
    const navigation = page.getByRole('navigation', { name: 'Admin navigation', exact: true });
    assert.equal(await navigation.getByRole('link').count(), 12);
    assert.equal(await navigation.getByRole('link', { name: 'Invoices', exact: true }).getAttribute('aria-current'), 'page');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  });

  await t.test('shared pagination works in billing and inventory with the correct navigation selection', async t => {
    const { page } = await fixture(t);
    for (const [path, label] of [['/admin/invoices', 'Invoices'], ['/admin/categories', 'Categories'], ['/admin/inventory/slots', 'Inventory']]) {
      await page.goto(origin + path);
      const navigation = page.getByRole('navigation', { name: 'Admin navigation', exact: true });
      assert.equal(await navigation.getByRole('link', { name: label, exact: true }).getAttribute('aria-current'), 'page');
      const pagination = page.getByRole('navigation', { name: 'Pagination', exact: true });
      await pagination.getByRole('button', { name: 'Next page', exact: true }).click();
      await pagination.getByText(/^Page 2 of /).waitFor();
      await pagination.getByRole('button', { name: 'Previous page', exact: true }).click();
      await pagination.getByText(/^Page 1 of /).waitFor();
      assert.equal(await pagination.getByRole('button', { name: 'Previous page', exact: true }).isDisabled(), true);
    }
  });
});
