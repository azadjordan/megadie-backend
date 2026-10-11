import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import User from '../models/userModel.js';
import SiteSettings from '../models/siteSettingsModel.js';
import routes from '../routes/siteSettingsRoutes.js';

test('notice API defaults off, protects updates, and hides admin metadata', async t => {
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'local-notice-test-only';
  let state = null;
  const chain = value => ({ populate() { return this; }, lean: async () => value });
  t.mock.method(User, 'findById', id => ({ select: async () => ({ _id: id, isAdmin: id === 'admin' }) }));
  t.mock.method(SiteSettings, 'findById', () => chain(state));
  const writes = t.mock.method(SiteSettings, 'findByIdAndUpdate', (id, update) => {
    assert.equal(id, 'site');
    state = { ...update.$set, noticeUpdatedBy: { name: 'Test Admin' } };
    return chain(state);
  });
  const app = express();
  app.use(express.json(), cookieParser(), routes);
  app.use((err, req, res, next) => { res.status(res.statusCode >= 400 ? res.statusCode : 500).json({ message: err.message }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
  });
  const base = `http://127.0.0.1:${server.address().port}/maintenance-notice`;
  const request = (method = 'GET', body, role, suffix = '') => fetch(base + suffix, {
    method, headers: { 'Content-Type': 'application/json', ...(role ? { Cookie: `jwt=${jwt.sign({ userId: role }, process.env.JWT_SECRET)}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let response = await request();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).data.enabled, false);
  assert.equal(writes.mock.callCount(), 0);
  assert.equal((await request('PUT', { enabled: true })).status, 401);
  assert.equal((await request('PUT', { enabled: true }, 'customer')).status, 403);
  assert.equal((await request('GET', undefined, 'customer', '/admin')).status, 403);
  assert.equal((await request('PUT', { enabled: 'true' }, 'admin')).status, 400);
  assert.equal(writes.mock.callCount(), 0);
  response = await request('PUT', { enabled: true }, 'admin');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.updatedBy, 'Test Admin');
  const publicData = (await (await request()).json()).data;
  assert.equal(publicData.enabled, true);
  assert.deepEqual(Object.keys(publicData).sort(), ['enabled', 'message']);
  response = await request('PUT', { enabled: false }, 'admin');
  assert.equal((await response.json()).data.enabled, false);
  assert.equal((await (await request()).json()).data.enabled, false);
});
