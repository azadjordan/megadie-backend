import test from "node:test";
import assert from "node:assert/strict";
import { packingSummary, canMarkPacked, packingUnitSummary, packingReadyToFinish } from "../utils/packingState.js";

test("reservations alone do not imply collection and duplicate product lines share one picking target", () => {
  const order = { orderItems: [{ product: "ribbon", qty: 6 }, { product: "ribbon", qty: 4 }] };
  const rows = [{ product: "ribbon", qty: 6, pickedQty: 6 }, { product: "ribbon", qty: 4 }];
  assert.deepEqual(packingSummary(order, rows), { totalItems: 1, collectedItems: 0, inProgressItems: 1, needsHelp: false });
  assert.equal(canMarkPacked(order, rows), false);
  rows[1].pickedQty = 4;
  assert.equal(canMarkPacked(order, rows), true);
});

test("shortages, under-reservations and invalid collected totals block Packed", () => {
  const order = { orderItems: [{ product: "ribbon", qty: 10 }] };
  for (const row of [{ qty: 10, pickedQty: 6, pickProblem: true }, { qty: 6, pickedQty: 6 }, { qty: 10, pickedQty: 11 }]) {
    assert.equal(packingSummary(order, [{ product: "ribbon", ...row }]).needsHelp, true);
    assert.equal(canMarkPacked(order, [{ product: "ribbon", ...row }]), false);
  }
  assert.equal(canMarkPacked({ orderItems: [] }, []), false);
});

test("progress counts complete products across locations and ignores cancelled allocations", () => {
  const order = { orderItems: [{ product: "rolls", qty: 10 }, { product: "packs", qty: 2 }] };
  const rows = [{ product: "rolls", qty: 6, pickedQty: 6 }, { product: "rolls", qty: 4, pickedQty: 4 }, { product: "packs", qty: 2, pickedQty: 2 }, { product: "other", qty: 9, status: "Cancelled", pickProblem: true }];
  assert.deepEqual(packingSummary(order, rows), { totalItems: 2, collectedItems: 2, inProgressItems: 0, needsHelp: false });
});


test('unit progress includes partial picks, split reservations and duplicate order lines', () => {
  const order = { orderItems: [{ product: 'rolls', qty: 7 }, { product: 'rolls', qty: 3 }, { product: 'boxes', qty: 2 }] };
  const rows = [{ product: 'rolls', qty: 6, pickedQty: 4 }, { product: 'rolls', qty: 4, pickedQty: 2 }, { product: 'boxes', qty: 2, pickedQty: 1 }, { product: 'rolls', qty: 99, pickedQty: 99, status: 'Cancelled' }];
  assert.deepEqual(packingUnitSummary(order, rows), { totalUnits: 12, pickedUnits: 7, remainingUnits: 5 });
});

test('card readiness requires published, unfinished packing with valid actual locations', () => {
  const order = { status: 'Shipping', packingSentAt: new Date(), orderItems: [{ product: 'rolls', qty: 10 }] };
  const rows = [{ product: 'rolls', qty: 10, pickedQty: 10, slot: { label: 'A1-AE1', store: 'AE1', isActive: false } }];
  assert.equal(packingReadyToFinish(order, rows), true);
  for (const change of [{ packingSentAt: null }, { status: 'Delivered' }, { packedAt: new Date() }, { stockFinalizedAt: new Date() }, { deliveryMovement: { departedAt: new Date() } }]) assert.equal(packingReadyToFinish({ ...order, ...change }, rows), false);
  assert.equal(packingReadyToFinish(order, [{ ...rows[0], slot: null }]), false);
  assert.equal(packingReadyToFinish(order, [{ ...rows[0], pickedQty: 7 }]), false);
});
