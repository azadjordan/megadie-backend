import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import mongoose from "mongoose";
import { errorHandler } from "../middleware/errorMiddleware.js";
import CustomerPaymentReceipt from "../models/customerPaymentReceiptModel.js";
import Invoice from "../models/invoiceModel.js";
import Payment from "../models/paymentModel.js";
import User from "../models/userModel.js";
import paymentRoutes from "../routes/paymentRoutes.js";
import { testSessionCookies } from "./helpers/sessionCookie.mjs";

const uri = process.env.PAYMENT_RECORDING_TEST_URI;

test("admin payment recording on a disposable replica set", { skip: !uri }, async (t) => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_payment_recording_test(?:\?|$)/);
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = "isolated-payment-recording-test";
  await mongoose.connect(uri, { autoCreate: false, autoIndex: false });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  await mongoose.connection.dropDatabase();

  const makeUser = (name, extra = {}) => User.create({
    name, email: `${name}@test.invalid`, phoneNumber: name,
    password: "test-password", approvalStatus: "Approved", ...extra,
  });
  const admin = await makeUser("Admin", { isAdmin: true });
  const cookie = await testSessionCookies()(admin);
  const app = express();
  app.use(express.json(), cookieParser());
  app.use("/payments", paymentRoutes, errorHandler);
  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });

  const request = async (path, { amount, key, method = "POST" } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/payments${path}`, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json", ...(key && { "Idempotency-Key": key }) },
      body: method === "POST" ? JSON.stringify({
        amount, paymentMethod: "Cash", receivedBy: "Company Account",
      }) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const directPath = (invoice) => `/from-invoice/${invoice._id}`;
  const receiptPath = (customer) => `/customer/${customer._id}/allocate`;
  const makeInvoice = (customer, dueDate = "2030-01-01", amountMinor = 10000) => Invoice.create({
    user: customer._id, source: "Manual", amountMinor, dueDate,
    invoiceItems: [{ description: "Test goods", qty: 1, unitPriceMinor: amountMinor, lineTotalMinor: amountMinor }],
  });

  async function assertTotals(invoice, paid, due, entries) {
    const saved = await Invoice.findById(invoice._id).lean();
    assert.equal(saved.paidTotalMinor, paid);
    assert.equal(saved.balanceDueMinor, due);
    assert.equal(await Payment.countDocuments({ invoice: invoice._id }), entries);
  }

  await t.test("simultaneous invoice payments cannot exceed the balance", async () => {
    const invoice = await makeInvoice(await makeUser("Direct"));
    const results = await Promise.all([
      request(directPath(invoice), { amount: 60 }),
      request(directPath(invoice), { amount: 60 }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 400]);
    await assertTotals(invoice, 6000, 4000, 1);
  });

  await t.test("invoice and receipt recording share the same balance", async () => {
    const customer = await makeUser("Both");
    const invoice = await makeInvoice(customer);
    const results = await Promise.all([
      request(directPath(invoice), { amount: 60, key: randomUUID() }),
      request(receiptPath(customer), { amount: 60, key: randomUUID() }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 400]);
    assert.equal(await CustomerPaymentReceipt.countDocuments({ user: customer._id }), Number(results[1].status === 201));
    await assertTotals(invoice, 6000, 4000, 1);
  });

  await t.test("concurrent retries share one payment and reject altered details", async () => {
    const invoice = await makeInvoice(await makeUser("Retry"));
    const key = randomUUID();
    const [first, second] = await Promise.all([
      request(directPath(invoice), { amount: 25, key }),
      request(directPath(invoice), { amount: 25, key }),
    ]);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual(first, second);
    assert.equal((await request(directPath(invoice), { amount: 30, key })).status, 409);
    assert.equal((await request(directPath(invoice), { amount: 25, key: "bad-key" })).status, 400);
    await assertTotals(invoice, 2500, 7500, 1);
  });

  await t.test("a receipt can be retried after it has paid every invoice", async () => {
    const customer = await makeUser("Receipt");
    const firstInvoice = await makeInvoice(customer);
    const secondInvoice = await makeInvoice(customer, "2030-02-01", 4000);
    const payment = { amount: 140, key: randomUUID() };
    const result = await request(receiptPath(customer), payment);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.data.allocations.length, 2);
    assert.deepEqual(await request(receiptPath(customer), payment), result);
    assert.equal(await CustomerPaymentReceipt.countDocuments({ user: customer._id }), 1);
    await assertTotals(firstInvoice, 10000, 0, 1);
    await assertTotals(secondInvoice, 4000, 0, 1);
  });

  await t.test("an interrupted balance update rolls back the payment and its request key", async () => {
    const invoice = await makeInvoice(await makeUser("Rollback"));
    const payment = { amount: 20, key: randomUUID() };
    const original = Invoice.updateOne;
    Invoice.updateOne = async () => { throw new Error("Injected balance update failure"); };
    try {
      assert.equal((await request(directPath(invoice), payment)).status, 500);
    } finally {
      Invoice.updateOne = original;
    }
    await assertTotals(invoice, 0, 10000, 0);
    assert.equal((await request(directPath(invoice), payment)).status, 201);
    await assertTotals(invoice, 2000, 8000, 1);
  });

  await t.test("repeated deletion adjusts a balance only once", async () => {
    const invoice = await makeInvoice(await makeUser("Deletion"));
    const removed = await request(directPath(invoice), { amount: 30 });
    assert.equal(removed.status, 201);
    assert.equal((await request(directPath(invoice), { amount: 20 })).status, 201);
    const results = await Promise.all([
      request(`/${removed.body.data._id}`, { method: "DELETE" }),
      request(`/${removed.body.data._id}`, { method: "DELETE" }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 404]);
    await assertTotals(invoice, 2000, 8000, 1);
  });
});
