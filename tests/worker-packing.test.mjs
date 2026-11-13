import test from "node:test";
import assert from "node:assert/strict";
import { packingSummary, canMarkPacked } from "../utils/packingState.js";

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
