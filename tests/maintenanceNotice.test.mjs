import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import User from '../models/userModel.js';
import AdminSession from '../models/adminSessionModel.js';
import SiteSettings from '../models/siteSettingsModel.js';
import routes from '../routes/siteSettingsRoutes.js';
import { MAINTENANCE_MESSAGE, MAINTENANCE_MESSAGE_MAX_LENGTH } from '../utils/maintenanceNotice.js';

test('editable notice API preserves visibility and messages, validates atomically, and protects private metadata', async t => {
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'local-notice-test-only';
  const now = Math.floor(Date.now() / 1000);
  const sessionId = 'a'.repeat(64);
  let state = null;
  const chain = value => ({ populate() { return this; }, lean: async () => value });
  t.mock.method(User, 'findById', id => ({ select: async () => ({ _id: id, isAdmin: id === 'admin' }) }));
  t.mock.method(AdminSession, 'findOne', () => chain({ _id: sessionId, user: 'admin', startedAt: new Date(now * 1000), idleExpiresAt: new Date((now + 1800) * 1000), absoluteExpiresAt: new Date((now + 28800) * 1000) }));
  t.mock.method(SiteSettings, 'findById', () => chain(state));
  const writes = t.mock.method(SiteSettings, 'findByIdAndUpdate', (id, update, options) => {
    assert.equal(id, 'site');
    assert.equal(options.runValidators, true);
    state = { maintenanceNoticeEnabled: false, maintenanceNoticeMessage: MAINTENANCE_MESSAGE, ...state, ...update.$set, noticeUpdatedBy: { name: 'Test Admin' } };
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
    method, headers: { 'Content-Type': 'application/json', ...(role ? { Cookie: `jwt=${jwt.sign({ userId: role, iat: now, ...(role === 'admin' ? { sessionId } : {}) }, process.env.JWT_SECRET, { expiresIn: '8h' })}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let response = await request();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await response.json()).data, { enabled: false, message: MAINTENANCE_MESSAGE });
  assert.equal(writes.mock.callCount(), 0);
  for (const body of [{ enabled: true }, { message: 'Unauthorized text' }]) {
    assert.equal((await request('PUT', body)).status, 401);
    assert.equal((await request('PUT', body, 'customer')).status, 403);
  }
  assert.equal((await request('GET', undefined, 'customer', '/admin')).status, 403);
  for (const body of [{}, { enabled: 'true' }, { message: '' }, { message: ' \n\t ' }, { message: null }, { message: 123 }, { message: {} }, { message: 'x'.repeat(501) }, { enabled: true, message: '' }]) {
    assert.equal((await request('PUT', body, 'admin')).status, 400, JSON.stringify(body));
  }
  assert.equal(writes.mock.callCount(), 0);

  // Message-only updates prepare the next notice without making it visible.
  response = await request('PUT', { message: '  Our store closes\n at 4 PM today.  ' }, 'admin');
  let data = (await response.json()).data;
  assert.equal(response.status, 200);
  assert.equal(data.enabled, false);
  assert.equal(data.message, 'Our store closes at 4 PM today.');
  assert.equal(data.updatedBy, 'Test Admin');
  assert.equal((await (await request()).json()).data.message, MAINTENANCE_MESSAGE, 'Hidden custom messages are available only to admins');
  assert.equal((await (await request('GET', undefined, 'admin', '/admin')).json()).data.message, data.message);

  // Older toggle-only clients keep the saved custom message intact.
  response = await request('PUT', { enabled: true }, 'admin');
  data = (await response.json()).data;
  assert.equal(data.enabled, true);
  assert.equal(data.message, 'Our store closes at 4 PM today.');
  const publicData = (await (await request()).json()).data;
  assert.deepEqual(publicData, { enabled: true, message: data.message });
  assert.deepEqual(Object.keys(publicData).sort(), ['enabled', 'message']);
  const current = structuredClone(state);
  assert.equal((await request('PUT', { enabled: false, message: ' ' }, 'admin')).status, 400);
  assert.deepEqual(state, current);

  const longest = 'x'.repeat(MAINTENANCE_MESSAGE_MAX_LENGTH);
  data = (await (await request('PUT', { message: longest }, 'admin')).json()).data;
  assert.equal(data.enabled, true);
  assert.equal(data.message, longest);
  data = (await (await request('PUT', { enabled: false }, 'admin')).json()).data;
  assert.equal(data.enabled, false);
  assert.equal(data.message, longest);
  data = (await (await request('PUT', { enabled: true, message: 'New notice shown in one action.' }, 'admin')).json()).data;
  assert.deepEqual({ enabled: data.enabled, message: data.message }, { enabled: true, message: 'New notice shown in one action.' });

  // Existing documents without a message continue showing the original text.
  state = { maintenanceNoticeEnabled: true };
  assert.deepEqual((await (await request()).json()).data, { enabled: true, message: MAINTENANCE_MESSAGE });
});
