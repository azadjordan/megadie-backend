import test from "node:test";
import assert from "node:assert/strict";
import { buildOrderReservationPlan as plan } from "../utils/orderReservationPlan.js";

const item = (product, qty) => ({ product, qty, sku: `SKU-${product}` });
const stock = (product, slot, qty, createdAt = "2026-01-01") => ({ _id: slot, product, slot: { _id: slot, label: slot, store: "AE1" }, qty, createdAt });

test("recommends smaller stock first, with deterministic newest-first tie breaking", () => {
  const result = plan({ orderItems: [item("p1", 9)] }, [], [stock("p1", "A10", 10), stock("p1", "A2", 3), stock("p1", "A3", 3, "2026-02-01")], []);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.changes.map(({ slotId, qty }) => [slotId, qty]), [["A3", 3], ["A2", 3], ["A10", 3]]);
});

test("checks every item and reports all shortages with other orders' reservations removed", () => {
  const result = plan({ orderItems: [item("p1", 10), item("p2", 4), item("p3", 1)] }, [], [stock("p1", "A1", 10), stock("p3", "A3", 1)], [{ product: "p1", slot: "A1", qty: 3 }]);
  assert.equal(result.issues.length, 2);
  assert.deepEqual(result.issues.map(({ sku, orderedQty, reservedQty, neededQty, availableQty, shortageQty }) => ({ sku, orderedQty, reservedQty, neededQty, availableQty, shortageQty })), [
    { sku: "SKU-p1", orderedQty: 10, reservedQty: 0, neededQty: 10, availableQty: 7, shortageQty: 3 },
    { sku: "SKU-p2", orderedQty: 4, reservedQty: 0, neededQty: 4, availableQty: 0, shortageQty: 4 },
  ]);
  assert.match(result.issues[1].message, /No stock slots/);
});

test("keeps existing quantities unchanged and fills only unused recommended slots", () => {
  const own = [{ product: "p1", slot: "A1", qty: 4, status: "Reserved" }];
  const result = plan({ orderItems: [item("p1", 12)] }, own, [stock("p1", "A1", 50), stock("p1", "A2", 8)], []);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.changes, [{ productId: "p1", slotId: "A2", qty: 8 }]);
  const short = plan({ orderItems: [item("p1", 12)] }, own, [stock("p1", "A1", 50)], []);
  assert.equal(short.issues[0].shortageQty, 8);
  assert.match(short.issues[0].message, /Review existing slot reservations/);
});

test("aggregates duplicate product lines and ignores cancelled reservations", () => {
  const result = plan({ orderItems: [item("p1", 2), item("p1", 3)] }, [{ product: "p1", slot: "A1", qty: 5, status: "Cancelled" }], [stock("p1", "A1", 5)], []);
  assert.equal(result.itemCount, 1);
  assert.equal(result.addedQty, 5);
  assert.equal(result.issues.length, 0);
});

test("reports invalid slots, invalid existing allocations, and over-reserved items", () => {
  for (const bad of [null, { _id: "A1", label: "A1", store: "AE2" }]) {
    const result = plan({ orderItems: [item("p1", 2)] }, [], [{ ...stock("p1", "A1", 2), slot: bad }], []);
    assert.equal(result.issues.length, 1);
    assert.equal(result.changes.length, 0);
  }
  assert.match(plan({ orderItems: [item("p1", 2)] }, [{ product: "p1", slot: "gone", qty: 2 }], [], []).issues[0].message, /missing stock/);
  assert.match(plan({ orderItems: [item("p1", 2)] }, [{ product: "p1", slot: "A1", qty: 3 }], [stock("p1", "A1", 5)], []).issues[0].message, /exceed the ordered/);
  assert.match(plan({ orderItems: [item("p1", 2)] }, [{ product: "p1", slot: "A1", qty: 2 }], [stock("p1", "A1", 2)], [{ product: "p1", slot: "A1", qty: 1 }]).issues[0].message, /exceed current stock/);
});

test("a fully reserved order is a no-op, and malformed orders are blocked", () => {
  assert.deepEqual(plan({ orderItems: [item("p1", 2)] }, [{ product: "p1", slot: "A1", qty: 2 }], [stock("p1", "A1", 2)], []).changes, []);
  assert.ok(plan({ orderItems: [item("p1", -1)] }, [], [], []).issues.length);
  assert.ok(plan({ orderItems: [] }, [], [], []).issues.length);
});
