import { deliveryStockLockReason } from "./deliveryMovementState.js";
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

// Display totals are derived from actual order/allocation quantities, never from
// product-completion counts or an independently maintained counter.
export function packingUnitSummary(order, allocations) {
  const products = new Set((order.orderItems || []).map(item => id(item.product)));
  const totalUnits = (order.orderItems || []).reduce((sum, item) => sum + item.qty, 0);
  const pickedUnits = allocations.filter(row => (isReserved(row) || row.status === 'Deducted') && products.has(id(row.product)))
    .reduce((sum, row) => sum + (row.pickedQty || 0), 0);
  return { totalUnits, pickedUnits, remainingUnits: Math.max(0, totalUnits - pickedUnits) };
}

export function packingReadyToFinish(order, rows) {
  return order.status === 'Shipping' && Boolean(order.packingSentAt) && !order.packedAt && !order.stockFinalizedAt &&
    !deliveryStockLockReason(order) && canMarkPacked(order, rows) &&
    rows.every(row => row.status !== 'Deducted' && row.slot?.label && row.slot.store === 'AE1');
}

export function packingUnassignLockReason(order, allocations, hasInvoice) {
  if (deliveryStockLockReason(order)) return deliveryStockLockReason(order);
  if (!order.packingSentAt) return 'This order has no active worker assignment.';
  if (order.status !== 'Shipping') return 'Only unfinished orders can return to manual preparation.';
  if (order.stockFinalizedAt || allocations.some(row => row.status === 'Deducted')) return 'Stock has been deducted. The assignment cannot be removed.';
  if (order.packedAt) return 'Packing is complete. Reopen packing before removing the assignment.';
  if (hasInvoice) return 'This order has an invoice. Review billing before removing the assignment.';
  if (allocations.some(row => row.pickedQty > 0)) return 'Return the picked goods to their original slots and correct the picked quantities to zero first.';
  return '';
}
