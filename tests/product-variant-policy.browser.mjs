// Every API is intercepted; no production database is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const origin = 'http://localhost:5173', productId = '100000000000000000000001';
test('product editors offer only plastic cores for tape, including cached older metadata', { timeout: 60000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  for (const edit of [false, true]) await t.test(edit ? 'edit tape and preserve unspecified legacy cores' : 'create tape and switch product types', async t => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } }); t.after(() => context.close());
    const unexpected = [];
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return url.origin === origin ? route.continue() : route.abort();
      const path = url.pathname.slice(4), reply = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/users/account/profile') return reply({ data: { _id: 'admin', name: 'Admin', isAdmin: true, approvalStatus: 'Approved', sessionId: 'variant-browser', sessionExpiresAt: Date.now() + 1800000, sessionAbsoluteExpiresAt: Date.now() + 28800000, sessionServerTime: Date.now() } });
      if (path === '/site-settings/maintenance-notice') return reply({ data: { enabled: false } });
      if (path === '/users/session/activity') return reply({ data: {} });
      if (path === '/products/meta') return reply({ data: { productTypes: ['Double Face Tape', 'Ribbon'], variants: ['Plastic Core', 'Paper Core'], sizes: ['6 mm', '12 mm'], grades: [], finishes: [], packingUnits: ['50m Roll'], tags: [], ribbonCatalogCodes: [], skuTokens: {} } });
      if (path === '/categories') return reply({ data: [{ _id: 'paper', key: 'paper', label: 'Paper', productType: 'Double Face Tape' }, { _id: 'satin', key: 'satin', label: 'Satin', productType: 'Ribbon' }] });
      if (path === '/price-rules') return reply({ data: [{ _id: 'rule', code: 'TAPE-SHARED', productType: 'Double Face Tape', defaultPrice: 1.75 }] });
      if (path === '/products/preview') return reply({ data: { sku: 'DFT-PREVIEW', name: 'Tape preview' } });
      if (path === '/products/' + productId) return reply({ data: { _id: productId, name: 'Acrylic tape', productType: 'Double Face Tape', category: 'paper', size: '12 mm', priceRule: 'TAPE-SHARED', packingUnit: '50m Roll', cbm: 0.00008, images: [], tags: [], isActive: true } });
      unexpected.push(request.method() + ' ' + path); return route.abort();
    });
    t.after(() => assert.deepEqual(unexpected, []));
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.goto(origin + '/admin/inventory/products/' + (edit ? productId + '/edit' : 'new'));
    if (!edit) {
      await page.getByRole('combobox').nth(0).selectOption('Double Face Tape');
      await page.getByRole('combobox').nth(1).selectOption('paper');
      await page.getByRole('combobox').nth(2).selectOption('TAPE-SHARED');
    }
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    const variant = page.getByLabel('Variant', { exact: true });
    assert.deepEqual(await variant.locator('option').allTextContents(), ['None', 'Plastic Core']);
    assert.equal(await variant.inputValue(), edit ? '' : 'Plastic Core');
    if (!edit) {
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('combobox').nth(0).selectOption('Ribbon'); await page.getByRole('combobox').nth(1).selectOption('satin');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      assert.ok((await page.getByLabel('Variant', { exact: true }).locator('option').allTextContents()).includes('Paper Core'));
    }
  });
});
