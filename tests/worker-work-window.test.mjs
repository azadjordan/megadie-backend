import test from 'node:test';
import assert from 'node:assert/strict';
import { dubaiDayStart, workWindow, workerWorkExpiresAt } from '../utils/workerWorkWindow.js';

test('three days means Dubai calendar days, including today', () => {
  const now = new Date('2026-11-20T19:59:59.999Z');
  assert.equal(dubaiDayStart(now).toISOString(), '2026-11-19T20:00:00.000Z');
  assert.equal(workWindow('last3', now).start.toISOString(), '2026-11-17T20:00:00.000Z');
  assert.equal(workWindow('last3', now).end.toISOString(), '2026-11-20T20:00:00.000Z');
  assert.equal(workWindow('yesterday', now).end.toISOString(), '2026-11-19T20:00:00.000Z');
  assert.equal(workWindow('today', new Date('2026-11-20T20:00:00Z')).start.toISOString(), '2026-11-20T20:00:00.000Z');
  assert.equal(workerWorkExpiresAt('2026-11-18T19:59:59Z').toISOString(), '2026-11-20T20:00:00.000Z');
  assert.equal(workWindow('all', now), null);
});
