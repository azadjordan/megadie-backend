import { reservationId as id, isReserved } from "./orderReservationPlan.js";

export function packingSummary(order, allocations) {
  const products = new Map();
  for (const item of order.orderItems || []) {
    const key = id(item.product);
    const total = products.get(key) || { ordered: 0, reserved: 0, picked: 0 };
    total.ordered += item.qty;
    products.set(key, total);
  }
  let needsHelp = false;
  for (const row of allocations) {
    if (!isReserved(row) && row.status !== "Deducted") continue;
    const product = products.get(id(row.product));
    if (!product) { needsHelp = true; continue; }
    product.reserved += row.qty;
    product.picked += row.pickedQty || 0;
    if (row.pickProblem && row.qty > (row.pickedQty || 0)) needsHelp = true;
    if ((row.pickedQty || 0) > row.qty) needsHelp = true;
  }
  const values = [...products.values()];
  needsHelp ||= values.some(p => p.reserved !== p.ordered);
  return {
    totalItems: products.size,
    collectedItems: values.filter(p => p.ordered > 0 && p.picked === p.ordered).length,
    inProgressItems: values.filter(p => p.picked > 0 && p.picked < p.ordered).length,
    needsHelp,
  };
}

export function canMarkPacked(order, allocations) {
  const summary = packingSummary(order, allocations);
  return summary.totalItems > 0 && !summary.needsHelp && summary.collectedItems === summary.totalItems;
}
