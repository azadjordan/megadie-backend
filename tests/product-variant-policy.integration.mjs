// Isolated localhost database only. Never imports server.js or development .env.
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import express from 'express';
import cookieParser from 'cookie-parser';
import Category from '../models/categoryModel.js';
import Product from '../models/productModel.js';
import PriceRule from '../models/priceRuleModel.js';
import User from '../models/userModel.js';
import routes from '../routes/productRoutes.js';
import { errorHandler } from '../middleware/errorMiddleware.js';
import { testSessionCookies } from './helpers/sessionCookie.mjs';

const uri = process.env.PRODUCT_VARIANT_TEST_URI;
test('discontinued tape variants are blocked without changing other products or shared pricing', { skip: !uri, timeout: 60000 }, async t => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_product_variant_test(?:\?|$)/);
  process.env.NODE_ENV = 'production'; process.env.JWT_SECRET = 'isolated-product-variant-test';
  await mongoose.connect(uri, { autoIndex: false }); await mongoose.connection.dropDatabase();
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const [paper, acrylic, ribbon] = await Category.create([{ productType: 'Double Face Tape', key: 'paper', label: 'Paper' }, { productType: 'Double Face Tape', key: 'acrylic', label: 'Acrylic' }, { productType: 'Ribbon', key: 'satin', label: 'Satin' }]);
  await PriceRule.create([{ code: 'TAPE-SHARED', productType: 'Double Face Tape', defaultPrice: 1.75 }, { code: 'RIBBON', productType: 'Ribbon', defaultPrice: 5 }]);
  const admin = await User.create({ name: 'Admin', email: 'variant-admin@test.invalid', phoneNumber: 'test', password: 'test-password', isAdmin: true });
  const cookie = await testSessionCookies()(admin);
  const app = express(); app.use(express.json(), cookieParser()); app.use('/api/products', routes); app.use(errorHandler);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function api(path, method = 'GET', body) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/products${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const base = { category: String(paper._id), productType: 'Double Face Tape', priceRule: 'TAPE-SHARED', size: '6 mm', packingUnit: '50m Roll', cbm: 0.00006 };
  const meta = await api('/meta'); assert.equal(meta.status, 200); assert.deepEqual(meta.body.data.variantsByProductType['Double Face Tape'], ['Plastic Core']); assert.ok(meta.body.data.variants.includes('Paper Core'));
  for (const category of [paper, acrylic]) {
    const payload = { ...base, category: String(category._id), variant: 'Paper Core' };
    for (const endpoint of ['', '/preview']) {
      const result = await api(endpoint, 'POST', payload); assert.equal(result.status, 400); assert.match([result.body.message, ...(result.body.errors || [])].join(" "), /discontinued/);
    }
    const spoofed = await api('', 'POST', { ...payload, productType: 'Ribbon' }); assert.equal(spoofed.status, 400);
  }
  assert.equal(await Product.countDocuments(), 0);
  const created = await api('', 'POST', { ...base, variant: 'Plastic Core' }); assert.equal(created.status, 201);
  const id = created.body.data.id || created.body.data._id;
  const before = await Product.findById(id).lean();
  const rejected = await api('/' + id, 'PUT', { variant: 'Paper Core' }); assert.equal(rejected.status, 400); assert.deepEqual(await Product.findById(id).lean(), before);
  assert.equal((await api('/preview', 'POST', { ...base, variant: 'Plastic Core' })).status, 200);
  const legacy = await api('', 'POST', { ...base, category: String(acrylic._id), size: '12 mm' }); assert.equal(legacy.status, 201);
  const legacyId = legacy.body.data.id || legacy.body.data._id, legacySku = legacy.body.data.sku;
  assert.equal((await api('/' + legacyId, 'PUT', { moq: 2 })).status, 200);
  assert.equal((await Product.findById(legacyId)).sku, legacySku, 'Unspecified legacy cores are not silently relabelled.');
  const unaffected = await api('', 'POST', { ...base, productType: 'Ribbon', category: String(ribbon._id), priceRule: 'RIBBON', variant: 'Paper Core' }); assert.equal(unaffected.status, 201);
  assert.equal(await PriceRule.countDocuments({ code: 'TAPE-SHARED', defaultPrice: 1.75 }), 1);
});
