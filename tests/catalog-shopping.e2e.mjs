// Run against the frontend dev server: node --test tests/catalog-shopping.e2e.mjs
// Every API request is intercepted; this suite never connects to the database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {chromium} from 'playwright';

const origin = process.env.CATALOG_TEST_ORIGIN || 'http://localhost:5173';
const retiredRoot = '/__preview/ribbon-catalog';
const catalogId = '100000000000000000000001';
const materials = ['grosgrain', 'satin'].map(key => ({_id:key, key, label:key === 'satin' ? 'Satin' : 'Grosgrain'}));
const entries = materials.flatMap(material => Array.from({length:196}, (_, i) => ({
  _id:`${material.key}-${i}`, category:material._id, code:String(i).padStart(3, '0'),
  label:i === 7 ? 'ShellGrey' : `Color ${i}`, imageUrl:'https://catalog-fixture.invalid/swatch.svg',
  page:Math.floor(i / 49) + 1, position:i % 49 + 1,
})));
const savedSearch = '?material=satin&page=3&q=Color&searchPage=2';
const firstTile = page => page.getByRole('link', {name:/^View ribbons in /}).first();
const backLink = page => page.locator('main a:visible').filter({hasText:/^(Ribbon|Ribbon colors)$/});
const productTypesLink = page => page.locator('main a:visible').filter({hasText:/^(Shop|Product types)$/}).first();
const nextFrame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const screenshotDir = process.env.CATALOG_TEST_SCREENSHOTS;
const production = process.env.CATALOG_PRODUCTION_BUILD === 'true';
const root = '/shop/catalog/Ribbon';

test('Ribbon catalog shared shopping flow', {timeout:120000}, async t => {
  const browser = await chromium.launch({headless:true});
  t.after(() => browser.close());

  async function fixture(t, {admin = false, mobile = false, approvalStatus = 'Approved', signedIn = true} = {}) {
    const context = await browser.newContext({viewport:mobile ? {width:390, height:844} : {width:1280, height:900}});
    t.after(() => context.close());
    const state = {catalogActive:true, catalogStatus:200, hiddenEntries:[], selectionStatus:200, emptyProducts:false, productCount:17, reverseProducts:false, apiDelay:0, stockDelay:0, stockStatus:200, stockMaterial:null, products:[], requests:[], stockBatches:[], productStockBatches:[], unexpected:[], errors:[]};
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = {'Access-Control-Allow-Origin':origin, 'Access-Control-Allow-Credentials':'true', 'Access-Control-Allow-Headers':'content-type', 'Access-Control-Allow-Methods':'GET, POST, OPTIONS'};
      const reply = async (data, status = 200) => {
        if (state.apiDelay) await new Promise(resolve => setTimeout(resolve, state.apiDelay));
        return route.fulfill({status, headers, contentType:'application/json', body:JSON.stringify(data)});
      };
      if (url.pathname.startsWith('/api/')) {
        const path = url.pathname.slice(4);
        state.requests.push(`${request.method()} ${path}`);
        if (request.method() === 'OPTIONS') return route.fulfill({status:204, headers});
        if (path.startsWith(`/catalogs/${catalogId}/`) && !state.catalogActive) return reply({message:'Catalog not found'},404);
        if (path === '/products/availability' && request.method() === 'POST') {
          const ids = request.postDataJSON().productIds;
          state.productStockBatches.push(ids);
          return reply({data:ids.map(productId => ({productId, isAvailable:true, inStock:true, availability:{availableNow:100}}))});
        }
        if (path === `/catalogs/${catalogId}/availability` && request.method() === 'POST') {
          const ids = request.postDataJSON().entryIds;
          state.stockBatches.push(ids);
          if (state.stockDelay) await new Promise(resolve => setTimeout(resolve,state.stockDelay));
          if (state.stockStatus !== 200) return reply({message:'Stock check failed'},state.stockStatus);
          return reply({checkedAt:new Date().toISOString(),data:ids.filter(id => !state.hiddenEntries.includes(id)).map(entryId => {
            const inStock = Number(entryId.split('-').at(-1)) % 2 === 1 && (!state.stockMaterial || entryId.startsWith(state.stockMaterial));
            return {entryId, inStock, noStock:!inStock && !entryId.endsWith('-2')};
          })});
        }
        if (request.method() !== 'GET') {
          state.unexpected.push(`${request.method()} ${path}`);
          return route.abort();
        }
        if (path === '/users/account/profile') return signedIn ? reply({data:{_id:'fixture-user', name:'Catalog reviewer', isAdmin:admin, approvalStatus}}) : reply({message:'Not authenticated'},401);
        if (path === '/site-settings/maintenance-notice') return reply({data:{enabled:false}});
        if (path === '/filter-configs') return reply({data:['Ribbon', 'Creasing Matrix', 'Double Face Tape'].map(productType => ({productType, fields:[
          {key:'categoryKeys', label:'Material', ui:'chips', allowedValues:materials.map(m => m.key), multi:false},
          {key:'size', label:'Size', ui:'chips', allowedValues:['1 inch', '3/4 inch'], multi:true},
        ]}))});
        if (path === '/categories') return reply({data:materials});
        if (path === '/catalogs') {
          if (state.catalogStatus !== 200) return reply({message:'Catalog lookup failed'},state.catalogStatus);
          return reply({data:state.catalogActive && url.searchParams.get('productType') === 'Ribbon' ? {_id:catalogId, productType:'Ribbon', name:'Ribbon colors', layout:'color-grid', materials} : null});
        }
        if (path === `/catalogs/${catalogId}/entries`) {
          const material = url.searchParams.get('material');
          const page = Number(url.searchParams.get('page') || 1);
          const q = (url.searchParams.get('q') || '').toLowerCase();
          const rows = entries.filter(e => !state.hiddenEntries.includes(e._id) && e.category === material && (!q || `${e.code} ${e.label}`.toLowerCase().includes(q)));
          const visible = q ? rows.slice((page - 1) * 49, page * 49) : rows.filter(e => e.page === page);
          return reply({data:visible.map(entry => ({...entry, filters:{productType:'Ribbon', categoryKeys:material, catalogCode:entry.code}})),
            material:materials.find(m => m.key === material), pagination:{page, total:rows.length, pages:[1, 2, 3, 4]}, mode:q ? 'search' : 'browse'});
        }
        if (path.startsWith(`/catalogs/${catalogId}/entries/`)) {
          if (state.selectionStatus !== 200) return reply({message:'Selection failed'}, state.selectionStatus);
          const entry = entries.find(e => path.endsWith(`/${e._id}`) && !state.hiddenEntries.includes(e._id));
          return entry ? reply({data:{...entry, material:materials.find(m => m.key === entry.category), filters:{productType:'Ribbon', categoryKeys:entry.category, catalogCode:entry.code}}}) : reply({}, 404);
        }
        if (path === '/products') {
          state.products.push(Object.fromEntries(url.searchParams));
          const page = Number(url.searchParams.get('page') || 1);
          let products = Array.from({length:state.productCount}, (_, i) => ({
            _id:`product-${i}`, productType:url.searchParams.get('productType'),
            name:`Ribbon ${url.searchParams.get('catalogCode') || 'all colors'} option ${i + 1}`,
            size:i % 2 ? '3/4 inch' : '1 inch', grade:i % 2 ? 'B' : 'A+',
            packingUnit:i % 2 ? '35yd Roll' : '100yd Roll', catalogCode:url.searchParams.get('catalogCode'),
            images:[], moq:1, isAvailable:true,
          }));
          if (state.emptyProducts) products = [];
          if (url.searchParams.has('size')) products = products.filter(p => p.size === url.searchParams.get('size'));
          if (state.reverseProducts) products.reverse();
          return reply({data:products.slice((page - 1) * 16, page * 16), pagination:{page, limit:16, total:products.length, totalPages:Math.ceil(products.length / 16), hasPrev:page > 1, hasNext:products.length > page * 16}});
        }
        state.unexpected.push(path);
        return reply({message:'Unmocked request'}, 500);
      }
      if (url.origin === origin) return route.continue();
      if (request.resourceType() === 'image') return route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#d9cedd"/></svg>'});
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => state.errors.push(error.message));
    t.after(() => {
      assert.deepEqual(state.unexpected, [], 'No unmocked API calls or database mutations');
      assert.deepEqual(state.errors, [], 'No browser runtime errors');
    });
    return {page, context, state};
  }

  await t.test('selection keeps all variations; browser Back, Forward, filters, pagination and refresh preserve catalog return', async t => {
    const {page, state} = await fixture(t);
    await page.goto(origin + root + savedSearch);
    await firstTile(page).waitFor();
    const label = await firstTile(page).getAttribute('aria-label');
    await firstTile(page).focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(url => url.pathname === '/shop');
    await page.getByRole('button', {name:'Add to cart', exact:true}).first().waitFor();
    const selected = new URL(page.url()).searchParams;
    assert.equal(selected.get('categoryKeys'), 'satin');
    assert.ok(label.includes(selected.get('catalogCode')));
    assert.deepEqual([...selected.keys()].sort(), ['catalogCode', 'categoryKeys', 'productType']);
    assert.ok(state.products.every(p => !p.q && !p.searchPage && !p.grade && !p.size && !p.packingUnit));
    assert.equal(state.requests.filter(r => /\/entries\//.test(r)).length, 0, 'Normal selection needs no entry lookup');
    assert.match(await page.getByRole('heading', {level:1}).innerText(), /Color/);
    assert.ok(await page.locator('article').getByText('3/4 inch', {exact:true}).count() > 0);
    assert.ok(await page.locator('article').getByText('B', {exact:true}).count() > 0);
    assert.ok(await page.locator('article').getByText('35yd Roll', {exact:true}).count() > 0);
    await page.goBack();
    await firstTile(page).waitFor();
    assert.equal(new URL(page.url()).search, savedSearch);
    assert.equal(await page.getByRole('searchbox').inputValue(), 'Color');
    await page.goForward();
    await backLink(page).waitFor();
    await page.getByRole('button', {name:'Go to page 2', exact:true}).first().click();
    await page.waitForURL(url => url.searchParams.get('page') === '2');
    assert.equal(await backLink(page).getAttribute('href'), root + savedSearch);
    await page.reload();
    await backLink(page).waitFor();
    assert.equal(await backLink(page).getAttribute('href'), root + savedSearch);
    await page.getByRole('button', {name:'1 inch', exact:true}).click();
    await page.waitForURL(url => url.searchParams.get('size') === '1 inch');
    await page.getByRole('button', {name:'Reset Filters', exact:true}).click();
    await page.waitForURL(url => !url.searchParams.has('size') && !url.searchParams.has('catalogCode'));
    await page.getByRole('heading', {level:1, name:'Ribbon', exact:true}).waitFor();
    assert.equal(await backLink(page).getAttribute('href'), root + savedSearch);
    await productTypesLink(page).click();
    await page.locator('main').getByRole('link', {name:/Double Face Tape/}).click();
    await page.waitForURL(url => url.searchParams.get('productType') === 'Double Face Tape');
    await backLink(page).waitFor({state:'hidden'});
    await page.goBack();
    await page.getByRole('heading', {level:1, name:'Shop', exact:true}).waitFor();
    await page.goBack();
    await backLink(page).click();
    await firstTile(page).waitFor();
    assert.equal(new URL(page.url()).search, savedSearch);
  });

  await t.test('View All bypasses selection and retains catalog return', async t => {
    const {page, state} = await fixture(t);
    await page.goto(origin + root + savedSearch);
    await page.getByRole('link', {name:'View All', exact:true}).click();
    await page.getByRole('button', {name:'Add to cart', exact:true}).first().waitFor();
    assert.equal(state.products.at(-1).catalogCode, undefined);
    assert.equal(state.products.at(-1).categoryKeys, undefined);
    await backLink(page).click();
    await firstTile(page).waitFor();
    assert.equal(new URL(page.url()).search, savedSearch);
  });

  await t.test('a selection opened in a new tab resolves and can add a chosen SKU and quantity to cart', async t => {
    const {page, context} = await fixture(t);
    await page.goto(origin + root + '?material=grosgrain&page=3&q=007');
    await firstTile(page).waitFor();
    const href = await firstTile(page).getAttribute('href');
    const tab = await context.newPage();
    await tab.goto(origin + href);
    await tab.waitForURL(url => url.pathname === '/shop');
    await tab.getByRole('heading', {level:1, name:'007 · ShellGrey', exact:true}).waitFor();
    const card = tab.locator('article').first();
    await card.getByRole('textbox', {name:'Quantity', exact:true}).fill('3');
    await card.getByRole('button', {name:'Add to cart', exact:true}).click();
    await tab.waitForFunction(() => JSON.parse(localStorage.getItem('megadie.cart.v1') || '{}').items?.[0]?.quantity === 3);
    await tab.goto(origin + '/cart');
    await tab.getByRole('textbox', {name:'Quantity', exact:true}).waitFor();
    const items = await tab.evaluate(() => JSON.parse(localStorage.getItem('megadie.cart.v1')).items);
    assert.equal(items.length, 1);
    assert.equal(items[0].productId, 'product-0');
    assert.equal(items[0].product.catalogCode, '007');
    assert.equal(items[0].quantity, 3);
  });

  await t.test('missing colors and temporary selection failures keep a recovery path without opening unfiltered products', async t => {
    const {page, state} = await fixture(t);
    state.selectionStatus = 404;
    await page.goto(`${origin}${root}/${catalogId}/satin-7${savedSearch}`);
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /no longer available/);
    assert.equal(state.products.length, 0);
    assert.equal(await backLink(page).getAttribute('href'), root + savedSearch);
    state.selectionStatus = 500;
    await page.reload();
    await page.getByRole('button', {name:'Try again', exact:true}).waitFor();
    assert.equal(state.products.length, 0);
    state.selectionStatus = 200;
    state.emptyProducts = true;
    await page.getByRole('button', {name:'Try again', exact:true}).click();
    await page.waitForURL(url => url.pathname === '/shop');
    await page.getByText('No products available for this selection.', {exact:true}).waitFor();
    await backLink(page).click();
    await firstTile(page).waitFor();
    assert.equal(new URL(page.url()).search, savedSearch);
  });

  await t.test('mobile material/page selection and return fit the screen', async t => {
    const {page} = await fixture(t, {mobile:true});
    await page.goto(origin + root);
    await page.getByRole('button', {name:'Satin', exact:true}).click();
    await page.getByRole('navigation', {name:'Catalog pages', exact:true}).getByRole('button', {name:'Page 4', exact:true}).click();
    await page.waitForURL(url => url.searchParams.get('page') === '4');
    await page.locator('nav[aria-label="Catalog pages"] button[aria-label="Page 4"][aria-current="page"]').waitFor();
    assert.equal(await firstTile(page).getAttribute('aria-label'), 'View ribbons in 147 Color 147');
    if (screenshotDir) {
      mkdirSync(screenshotDir, {recursive:true});
      await page.evaluate(() => window.scrollTo({top:0, behavior:'instant'}));
      await page.screenshot({path:`${screenshotDir}/catalog-mobile.png`});
    }
    await firstTile(page).click();
    await page.waitForURL(url => url.pathname === '/shop');
    await page.getByRole('button', {name:'Add to cart', exact:true}).first().waitFor();
    await nextFrame(page);
    assert.equal(await backLink(page).getAttribute('href'), root + '?material=satin&page=4');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
    if (screenshotDir) await page.screenshot({path:`${screenshotDir}/products-mobile.png`});
    await backLink(page).click();
    await firstTile(page).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('page'), '4');
    assert.equal(await page.getByRole('button', {name:'Satin', exact:true}).getAttribute('aria-pressed'), 'true');
  });

  await t.test('approved customers retain direct filtered product links', async t => {
    const {page, state} = await fixture(t, {admin:false});
    assert.equal(state.requests.some(r => r.includes('/catalogs/preview')), false);
    await page.goto(origin + '/shop?productType=Ribbon&categoryKeys=satin&catalogCode=007');
    await page.getByRole('button', {name:'Add to cart', exact:true}).first().waitFor();
    assert.equal(await backLink(page).count(), 0);
    assert.equal(state.products.at(-1).catalogCode, '007');
    await page.getByRole('heading', {level:1, name:'Code 007', exact:true}).waitFor();
  });

  await t.test('the three views share heading positions and preserve catalog scroll without repeat requests', async t => {
    const {page, state} = await fixture(t);
    state.apiDelay = 120;
    await page.goto(origin + '/shop');
    const heading = page.getByRole('heading', {level:1});
    await heading.waitFor();
    await nextFrame(page);
    const entranceBox = await heading.boundingBox();
    if (screenshotDir) {
      mkdirSync(screenshotDir, {recursive:true});
      await page.screenshot({path:`${screenshotDir}/types-desktop.png`});
    }
    await page.locator('main').getByRole('link', {name:/Ribbon/}).click();
    await firstTile(page).waitFor();
    await nextFrame(page);
    const catalogBox = await heading.boundingBox();
    assert.equal(catalogBox.x, entranceBox.x);
    assert.equal(catalogBox.y, entranceBox.y);
    assert.equal(state.products.length, 0, 'Catalog does not fetch shop product lists');
    if (screenshotDir) await page.screenshot({path:`${screenshotDir}/catalog-desktop.png`});
    const pageRequests = state.requests.filter(r => /\/entries$/.test(r)).length;
    const tile = page.getByRole('link', {name:/^View ribbons in /}).nth(21);
    await tile.scrollIntoViewIfNeeded();
    await nextFrame(page);
    const catalogScroll = await page.evaluate(() => window.scrollY);
    assert.ok(catalogScroll > 200);
    await tile.click();
    await page.waitForURL(url => url.pathname === '/shop');
    await page.getByRole('button', {name:'Add to cart', exact:true}).first().waitFor();
    await nextFrame(page);
    const productsBox = await heading.boundingBox();
    assert.equal(productsBox.x, entranceBox.x);
    assert.equal(productsBox.y, entranceBox.y);
    assert.equal(state.requests.filter(r => /\/entries\//.test(r)).length, 0);
    if (screenshotDir) await page.screenshot({path:`${screenshotDir}/products-desktop.png`});
    await backLink(page).click();
    await firstTile(page).waitFor();
    await page.waitForFunction(expected => Math.abs(window.scrollY - expected) <= 2, catalogScroll, {timeout:5000});
    assert.equal(state.requests.filter(r => /\/entries$/.test(r)).length, pageRequests, 'Return reuses cached catalog page');
  });

  await t.test('small mobile screens keep navigation in place and the filter dialog supports keyboard return', async t => {
    const {page} = await fixture(t, {mobile:true});
    await page.setViewportSize({width:320, height:740});
    await page.goto(origin + '/shop');
    await page.getByRole('heading', {level:1, name:'Shop', exact:true}).waitFor();
    await nextFrame(page);
    if (screenshotDir) {
      mkdirSync(screenshotDir, {recursive:true});
      await page.screenshot({path:`${screenshotDir}/types-mobile.png`});
    }
    await page.locator('main').getByRole('link', {name:/Ribbon/}).click();
    await firstTile(page).waitFor();
    await nextFrame(page);
    const catalogNav = await productTypesLink(page).boundingBox();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await firstTile(page).click();
    await page.waitForURL(url => url.pathname === '/shop');
    await page.getByRole('button', {name:'Add to cart', exact:true}).first().waitFor();
    await nextFrame(page);
    const productsNav = await backLink(page).boundingBox();
    assert.equal(productsNav.x, catalogNav.x);
    assert.equal(productsNav.y, catalogNav.y);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const filters = page.getByRole('button', {name:/^Filters/});
    await filters.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('button', {name:'Close', exact:true}).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.getByRole('button', {name:'Show Products', exact:true}).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});
    assert.equal(await filters.evaluate(el => el === document.activeElement), true);
  });

  await t.test('catalog badges distinguish zero stock in one background batch without shifting or disabling colors', async t => {
    const {page,state} = await fixture(t);
    state.stockDelay = 700;
    await page.goto(origin + root);
    const stocked = page.getByRole('link', {name:'View ribbons in 007 ShellGrey',exact:true});
    await stocked.waitFor();
    await nextFrame(page);
    const before = await stocked.boundingBox();
    assert.equal(await stocked.getByText('In stock', {exact:true}).count(),0);
    assert.equal(await page.getByText('No stock', {exact:true}).count(),0, 'Loading stock is not a zero balance');
    await stocked.getByText('In stock', {exact:true}).waitFor();
    const after = await stocked.boundingBox();
    assert.equal(after.y,before.y);
    assert.equal(after.height,before.height,'Async badges reserve no extra card space');
    assert.equal(state.stockBatches.length,1);
    assert.equal(state.stockBatches[0].length,49);
    assert.deepEqual(state.stockBatches[0],[...state.stockBatches[0]].sort());
    assert.equal(state.products.length,0,'Stock flags do not download shop product cards');
    const unstocked = firstTile(page);
    assert.equal(await unstocked.getByText('In stock',{exact:true}).count(),0);
    await unstocked.getByText('No stock',{exact:true}).waitFor();
    for (const [tile, label] of [[stocked, 'In stock'], [unstocked, 'No stock']]) {
      const image = await tile.locator('img').boundingBox();
      const badge = await tile.getByText(label,{exact:true}).boundingBox();
      assert.ok(Math.abs(badge.x - image.x - 8) < 1 && Math.abs(badge.y - image.y - 8) < 1, 'Stock badges sit at the image top left');
      assert.equal(await tile.getAttribute('aria-describedby'), await tile.getByText(label,{exact:true}).getAttribute('id'));
    }
    const belowMinimum = page.getByRole('link',{name:'View ribbons in 002 Color 2',exact:true});
    assert.equal(await belowMinimum.getByText(/^(In stock|No stock)$/).count(),0, 'Stock below MOQ is not labelled no stock');
    assert.equal(await unstocked.evaluate(el => getComputedStyle(el).opacity),'1');
    assert.equal(await unstocked.locator('img').evaluate(el => getComputedStyle(el).filter),'none');
    await unstocked.click();
    await page.waitForURL(url => url.pathname === '/shop' && url.searchParams.get('catalogCode') === '000');
    await page.getByRole('button',{name:'Add to cart',exact:true}).first().waitFor();
  });

  await t.test('stock responses stay within their material; failed checks remove tags and reconnect can refresh them', async t => {
    const {page,state} = await fixture(t);
    state.stockDelay = 300;
    state.stockMaterial = 'grosgrain';
    await page.goto(origin + root);
    await firstTile(page).waitFor();
    await page.getByRole('button',{name:'Satin',exact:true}).click();
    await page.waitForURL(url => url.searchParams.get('material') === 'satin');
    const satinResponse = page.waitForResponse(response => response.url().endsWith('/availability') && response.request().postData()?.includes('satin-'));
    await satinResponse;
    await nextFrame(page);
    assert.equal(await page.getByText('In stock',{exact:true}).count(),0);
    await page.getByText('No stock',{exact:true}).first().waitFor();
    await page.getByRole('button',{name:'Grosgrain',exact:true}).click();
    await page.getByText('In stock',{exact:true}).first().waitFor();
    if (!production) {
    state.stockMaterial = 'satin';
    const reserved = page.waitForResponse(response => response.url().endsWith('/availability'));
    await page.evaluate(async () => {
      const {store} = await import('/src/app/store.js');
      const {apiSlice} = await import('/src/app/apiSlice.js');
      store.dispatch(apiSlice.util.invalidateTags([{type:'OrderAllocation',id:'LIST'}]));
    });
    await reserved;
    await page.getByText('In stock',{exact:true}).first().waitFor({state:'hidden'});
    await page.getByRole('link',{name:'View ribbons in 007 ShellGrey',exact:true}).getByText('No stock',{exact:true}).waitFor();
    state.stockMaterial = 'grosgrain';
    const adjusted = page.waitForResponse(response => response.url().endsWith('/availability'));
    await page.evaluate(async () => {
      const {store} = await import('/src/app/store.js');
      const {apiSlice} = await import('/src/app/apiSlice.js');
      store.dispatch(apiSlice.util.invalidateTags([{type:'InventoryProduct',id:'LIST'}]));
    });
    await adjusted;
    await page.getByText('In stock',{exact:true}).first().waitFor();
    const orderChanged = page.waitForResponse(response => response.url().endsWith('/availability'));
    await page.evaluate(async () => {
      const {store} = await import('/src/app/store.js');
      const {apiSlice} = await import('/src/app/apiSlice.js');
      store.dispatch(apiSlice.util.invalidateTags([{type:'Order',id:'LIST'}]));
    });
    await orderChanged;
    await page.getByText('In stock',{exact:true}).first().waitFor();
    }
    state.stockStatus = 500;
    const failure = page.waitForResponse(response => response.url().endsWith('/availability') && response.status() === 500);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await failure;
    await page.getByText('In stock',{exact:true}).first().waitFor({state:'hidden'});
    await page.getByText('No stock',{exact:true}).first().waitFor({state:'hidden'});
    assert.equal(await firstTile(page).isVisible(),true);
    state.stockStatus = 200;
    const recovered = page.waitForResponse(response => response.url().endsWith('/availability') && response.status() === 200);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await recovered;
    await page.getByText('In stock',{exact:true}).first().waitFor();
  });

  await t.test('shop stock batches reuse equivalent ID sets and refresh on focus or an older revisit', async t => {
    const {page,state} = await fixture(t);
    state.productCount = 3;
    await page.goto(`${origin}${root}/${catalogId}/grosgrain-7?material=grosgrain`);
    await page.getByText('Available: 100',{exact:true}).first().waitFor();
    assert.equal(state.productStockBatches.length,1);
    assert.deepEqual(state.productStockBatches[0],['product-0','product-1','product-2']);
    assert.equal(state.products[0].includeAvailability,'false','Cards can load independently of stock');
    if (!production) {
    state.reverseProducts = true;
    await page.evaluate(async () => {
      const {store} = await import('/src/app/store.js');
      const {apiSlice} = await import('/src/app/apiSlice.js');
      store.dispatch(apiSlice.util.invalidateTags([{type:'Product',id:'LIST'}]));
    });
    await page.locator('article').first().getByRole('heading',{name:'Ribbon 007 option 3',exact:true}).waitFor();
    await nextFrame(page);
    assert.equal(state.productStockBatches.length,1,'Reordered products reuse the same stock cache key');
    }
    const focused = page.waitForResponse(response => response.url().endsWith('/products/availability'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await focused;
    assert.equal(state.productStockBatches.length,2);
    await backLink(page).click();
    const tile = page.getByRole('link',{name:'View ribbons in 007 ShellGrey',exact:true});
    await tile.waitFor();
    // Advance the browser's age clock without waiting or expiring the cache's
    // separate 60-second unused-data timer.
    await page.clock.setSystemTime(Date.now() + 18000);
    const revisited = page.waitForResponse(response => response.url().endsWith('/products/availability'),{timeout:5000});
    await tile.click();
    await revisited;
    assert.equal(state.productStockBatches.length,3,'An older stock snapshot is refreshed on revisit');
  });

    await t.test('customer product-type entry uses published colors and omits hidden entries', async t => {
      const {page,state} = await fixture(t);
      state.hiddenEntries = ['grosgrain-0'];
      await page.goto(origin + '/shop');
      await page.getByRole('heading',{level:1,name:'Shop',exact:true}).waitFor();
      assert.equal(state.requests.some(request => request.startsWith('GET /catalogs')),false, 'The entrance does not fetch every type catalog');
      await page.locator('main').getByRole('link',{name:/^Ribbon/}).click();
      await firstTile(page).waitFor();
      assert.equal(new URL(page.url()).pathname,root);
      assert.equal(await firstTile(page).getAttribute('aria-label'),'View ribbons in 001 Color 1');
      await page.getByText('In stock',{exact:true}).first().waitFor();
      assert.equal(state.stockBatches[0].length,48);
      assert.equal(state.products.length,0);
      assert.equal(await page.getByText('Admin preview',{exact:true}).count(),0);
      assert.equal(state.requests.some(request => request.includes('/catalogs/preview')),false);
      assert.equal(state.requests.filter(request => request === 'GET /catalogs').length,1);
    });

    await t.test('unpublished and absent catalogs go to products and Back skips the resolver', async t => {
      for (const productType of ['Ribbon','Creasing Matrix','Double Face Tape']) {
        const {page,state} = await fixture(t);
        state.catalogActive = false;
        await page.goto(origin + '/shop');
        const typeLink = page.locator('main').getByRole('link',{name:new RegExp(`^${productType}`)});
        await typeLink.click();
        await page.getByRole('button',{name:'Add to cart',exact:true}).first().waitFor();
        assert.equal(new URL(page.url()).pathname,'/shop');
        assert.equal(new URL(page.url()).searchParams.get('productType'),productType);
        assert.equal(state.products.at(-1).productType,productType);
        assert.equal(state.requests.some(request => request.includes('/entries') || request.includes('/catalogs/preview')),false);
        await page.goBack();
        await page.getByRole('heading',{level:1,name:'Shop',exact:true}).waitFor();
        await typeLink.click();
        await page.getByRole('button',{name:'Add to cart',exact:true}).first().waitFor();
        assert.equal(state.requests.filter(request => request === 'GET /catalogs').length,1, 'Revisits reuse the type lookup');
      }
    });

    await t.test('a failed catalog lookup offers retry and does not masquerade as an absent catalog', async t => {
      const {page,state} = await fixture(t);
      state.catalogStatus = 500;
      await page.goto(origin + root);
      await page.getByRole('alert').waitFor();
      assert.equal(new URL(page.url()).pathname,root);
      assert.equal(state.products.length,0);
      state.catalogStatus = 200;
      await page.getByRole('button',{name:'Try again',exact:true}).click();
      await firstTile(page).waitFor();
      assert.equal(state.requests.filter(request => request === 'GET /catalogs').length,2);
    });

    await t.test('customer catalog routes enforce login and shop approval before catalog requests', async t => {
      for (const approvalStatus of ['Pending','Rejected']) {
        const {page,state} = await fixture(t,{approvalStatus});
        await page.goto(origin + root);
        await page.getByRole('heading',{level:1,name:approvalStatus === 'Pending' ? 'Shop access pending' : 'Shop access denied',exact:true}).waitFor();
        assert.equal(state.requests.some(request => request.includes('/catalogs')),false);
      }
      const {page,state} = await fixture(t,{signedIn:false});
      await page.goto(`${origin}${root}/${catalogId}/grosgrain-7`);
      await page.waitForURL(url => url.pathname === '/login');
      assert.equal(state.requests.some(request => request.includes('/catalogs')),false);
    });

    await t.test('admins enter the same catalog flow from the product-type card', async t => {
      const {page,state} = await fixture(t,{admin:true});
      await page.goto(origin + '/shop');
      await page.locator('main').getByRole('link',{name:/^Ribbon/}).click();
      const tile = page.getByRole('link',{name:'View ribbons in 007 ShellGrey',exact:true});
      await tile.click();
      await page.getByRole('heading',{level:1,name:'007 · ShellGrey',exact:true}).waitFor();
      assert.equal(await backLink(page).getAttribute('href'),root);
      assert.equal(await page.getByText('Admin preview',{exact:true}).count(),0);
      assert.equal(state.requests.some(request => request.includes('/catalogs/preview')),false);
    });

    await t.test('retired preview URLs are unavailable for customers and admins', async t => {
      for (const admin of [false,true]) {
        const {page,state} = await fixture(t,{admin});
        for (const path of [retiredRoot,`${retiredRoot}/${catalogId}/grosgrain-7`]) {
          await page.goto(origin + path);
          await page.getByRole('heading',{level:1,name:'This page is not on the map',exact:true}).waitFor();
        }
        assert.equal(state.requests.some(request => request.includes('/catalogs')),false);
      }
    });

    await t.test('legacy preview state is revalidated and return links use the published catalog', async t => {
      const {page,state} = await fixture(t,{admin:true});
      state.catalogActive = false;
      await page.goto(origin + '/shop');
      await page.getByRole('heading',{level:1,name:'Shop',exact:true}).waitFor();
      await page.evaluate(({path,catalogId}) => {
        const ribbonCatalogEntry = {_id:'grosgrain-7',catalogId,preview:true,code:'007',label:'Hidden draft',filters:{productType:'Ribbon',categoryKeys:'grosgrain',catalogCode:'007'}};
        history.pushState({usr:{ribbonCatalogEntry},key:'legacy-selection',idx:1},'',path);
        dispatchEvent(new PopStateEvent('popstate'));
      },{path:`${root}/${catalogId}/grosgrain-7?material=grosgrain`,catalogId});
      await page.getByRole('alert').waitFor();
      assert.equal(state.products.length,0,'An old preview payload cannot bypass publication');
      assert.equal(state.requests.filter(request => request === `GET /catalogs/${catalogId}/entries/grosgrain-7`).length,1);
      await page.evaluate(path => {
        history.pushState({usr:{ribbonCatalogSearch:'?material=satin&page=3',ribbonCatalogPreview:true},key:'legacy-return',idx:2},'',path);
        dispatchEvent(new PopStateEvent('popstate'));
      },'/shop?productType=Ribbon&categoryKeys=grosgrain&catalogCode=007');
      await page.getByRole('button',{name:'Add to cart',exact:true}).first().waitFor();
      assert.equal(await backLink(page).getAttribute('href'),root+'?material=satin&page=3');
      assert.equal(await page.getByText('Admin preview',{exact:true}).count(),0);
      assert.equal(state.requests.some(request => request.includes('/catalogs/preview')),false);
    });
});
