import test from 'node:test';
import assert from 'node:assert/strict';
import sendTelegramAlert from '../utils/sendTelegramAlert.js';

test('Telegram supports plain packing messages and reports failure for durable retries', async t => {
  const original = { fetch: globalThis.fetch, token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
  t.after(() => {
    globalThis.fetch = original.fetch;
    for (const [key, value] of [['TELEGRAM_BOT_TOKEN', original.token], ['TELEGRAM_CHAT_ID', original.chat]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
  globalThis.fetch = () => { throw new Error('Network must not be called without configuration'); };
  assert.equal(await sendTelegramAlert('test'), false);
  await assert.rejects(sendTelegramAlert('test', { strict: true }), /not configured/);
  process.env.TELEGRAM_BOT_TOKEN = 'isolated-fake-token'; process.env.TELEGRAM_CHAT_ID = 'fake-chat';
  let payload;
  globalThis.fetch = async (_url, options) => { payload = JSON.parse(options.body); assert.ok(options.signal); return { ok: true, json: async () => ({ ok: true }) }; };
  assert.equal(await sendTelegramAlert('SKU_[25] & client *name*', { plainText: true, strict: true }), true);
  assert.equal(payload.parse_mode, undefined); assert.equal(payload.text, 'SKU_[25] & client *name*');
  await sendTelegramAlert('existing request'); assert.equal(payload.parse_mode, 'Markdown');
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(sendTelegramAlert('test', { strict: true }), /delivery failed/);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false }) });
  await assert.rejects(sendTelegramAlert('test', { strict: true }), /delivery failed/);
});
