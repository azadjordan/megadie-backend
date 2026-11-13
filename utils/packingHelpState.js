import { reservationId as id, isReserved } from "./orderReservationPlan.js";

export function unresolvedPackingProducts(order, rows) {
  if (order.status !== "Shipping" || !order.packingSentAt || order.stockFinalizedAt) return new Set();
  const products = new Map();
  for (const item of order.orderItems || []) {
    const key = id(item.product), value = products.get(key) || { ordered: 0, reserved: 0, short: false };
    value.ordered += item.qty; products.set(key, value);
  }
  for (const row of rows) {
    if (!isReserved(row)) continue;
    const value = products.get(id(row.product));
    if (!value) continue;
    value.reserved += row.qty;
    value.short ||= Boolean(row.pickProblem && row.qty > (row.pickedQty || 0));
  }
  return new Set([...products].filter(([, value]) => value.short || value.reserved < value.ordered).map(([key]) => key));
}

export function activePackingHelp(order, rows) {
  const unresolved = unresolvedPackingProducts(order, rows);
  return (order.packingHelp || []).filter(request => !request.resolvedAt && unresolved.has(id(request.product)));
}

export function resolvePackingHelp(order, rows, now = new Date()) {
  const unresolved = unresolvedPackingProducts(order, rows);
  let changed = false;
  for (const request of order.packingHelp || []) {
    if (!request.resolvedAt && !unresolved.has(id(request.product))) {
      request.resolvedAt = now; changed = true;
    }
  }
  return changed;
}
