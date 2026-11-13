import { reservationId as id, isReserved } from "./orderReservationPlan.js";

const sumByProduct = items => {
  const totals = new Map();
  for (const item of items) totals.set(id(item.product), (totals.get(id(item.product)) || 0) + item.qty);
  return totals;
};
const total = (items, order) => items.reduce((sum, row) => sum + row.qty * row.unitPrice, 0) + (order.deliveryCharge || 0) + (order.extraFee || 0);
const stable = (a, b) => id(a).localeCompare(id(b));

// Pure planning: never infer a physical pick from a reservation or a new target.
export function buildOrderItemChangePlan({ order, items, allocations, stock, others, products }) {
  const before = sumByProduct(order.orderItems), after = sumByProduct(items);
  const metadata = new Map(products.map(p => [id(p), p]));
  const own = allocations.filter(isReserved).map(row => ({
    allocationId: id(row), productId: id(row.product), slotId: id(row.slot),
    slotLabel: row.slot?.label || "Unknown slot", qty: row.qty, pickedQty: row.pickedQty || 0,
    pickProblem: Boolean(row.pickProblem), previousQty: row.qty, previousPickedQty: row.pickedQty || 0,
    previousProblem: Boolean(row.pickProblem),
  }));
  const issues = [], returns = [];
  const issue = (productId, message) => issues.push({ productId, sku: metadata.get(productId)?.sku || order.orderItems.find(i => id(i.product) === productId)?.sku || "Order", message });
  if (allocations.some(row => row.status === "Cancelled" && row.pickedQty > 0)) issues.push({ message: "A cancelled reservation still records picked goods. Review its physical return before editing." });
  const seen = new Set();
  for (const row of own) {
    const key = row.productId + ':' + row.slotId;
    if (seen.has(key)) issue(row.productId, "Duplicate reservations need review before editing this order.");
    seen.add(key);
    if (!before.has(row.productId)) issue(row.productId, "A reservation belongs to a product outside this order. Review reservations first.");
    if (!Number.isSafeInteger(row.qty) || row.qty < 1 || !Number.isSafeInteger(row.pickedQty) || row.pickedQty < 0 || row.pickedQty > row.qty) issue(row.productId, "A reservation has an invalid quantity or picked total.");
  }
  if (issues.length) return { issues, returns, allocations: own, beforeTotal: total(order.orderItems, order), afterTotal: total(items, order) };
  const heldByOthers = new Map();
  for (const row of others.filter(isReserved)) {
    const key = id(row.product) + ':' + id(row.slot);
    heldByOthers.set(key, (heldByOthers.get(key) || 0) + row.qty);
  }
  const reported = new Set((order.packingReports || []).map(row => id(row.product) + ':' + id(row.slot)));
  for (const productId of new Set([...before.keys(), ...after.keys()])) {
    const oldQty = before.get(productId) || 0, newQty = after.get(productId) || 0;
    if (oldQty === newQty) continue; // Unrelated shortages remain untouched.
    if (!Number.isSafeInteger(newQty)) { issue(productId, "The total ordered quantity is too large."); continue; }
    if (newQty > oldQty && metadata.get(productId)?.isActive === false) { issue(productId, "This product is inactive. Its quantity cannot be increased."); continue; }
    const rows = own.filter(row => row.productId === productId);
    let release = Math.max(0, rows.reduce((sum, row) => sum + row.qty, 0) - newQty);
    // Short/unpicked holds go first; preserve every collected unit still needed.
    for (const row of [...rows].sort((a,b) => Number(b.pickProblem) - Number(a.pickProblem) || a.allocationId.localeCompare(b.allocationId))) {
      const qty = Math.min(release, row.qty - row.pickedQty);
      row.qty -= qty; release -= qty;
      if (row.qty === row.pickedQty) row.pickProblem = false;
    }
    // Fewest return locations first, with deterministic ties for preview/save.
    for (const row of [...rows].sort((a,b) => b.pickedQty - a.pickedQty || a.allocationId.localeCompare(b.allocationId))) {
      if (!release) break;
      const qty = Math.min(release, row.pickedQty);
      if (!qty) continue;
      if (!row.slotId || row.slotLabel === "Unknown slot" || !metadata.has(productId)) issue(productId, "Picked goods are missing their product or original slot. Review them before editing.");
      returns.push({ allocationId: row.allocationId, productId, sku: metadata.get(productId)?.sku || "Unknown product", name: metadata.get(productId)?.name || "Unknown product", unit: metadata.get(productId)?.packingUnit || "units", slotId: row.slotId, slot: row.slotLabel, qty });
      row.qty -= qty; row.pickedQty -= qty; release -= qty;
      if (row.qty === row.pickedQty) row.pickProblem = false;
    }
    let needed = Math.max(0, newQty - rows.reduce((sum, row) => sum + row.qty, 0));
    if (!needed) continue;
    const candidates = stock.filter(s => id(s.product) === productId && s.slot?.label && s.slot.store === "AE1" && s.slot.isActive !== false && Number.isSafeInteger(s.qty) && s.qty > 0)
      .sort((a,b) => a.qty - b.qty || new Date(b.createdAt || 0) - new Date(a.createdAt || 0) || stable(a,b));
    const requested = needed;
    for (const source of candidates) {
      if (!needed) break;
      const slotId = id(source.slot), key = productId + ':' + slotId;
      let row = own.find(r => r.productId === productId && r.slotId === slotId);
      if (reported.has(key) || row?.previousProblem) continue;
      const free = Math.max(0, source.qty - (heldByOthers.get(key) || 0) - (row?.qty || 0));
      const qty = Math.min(needed, free);
      if (!qty) continue;
      if (!row) {
        row = { allocationId: null, productId, slotId, slotLabel: source.slot.label, qty: 0, pickedQty: 0, pickProblem: false, previousQty: 0, previousPickedQty: 0, previousProblem: false };
        own.push(row);
      }
      row.qty += qty; needed -= qty;
    }
    if (needed) issue(productId, 'Cannot reserve the added quantity. Need ' + requested + ', available ' + (requested - needed) + '; ' + needed + ' still missing.');
  }
  return { issues, returns, allocations: own, beforeTotal: total(order.orderItems, order), afterTotal: items.length ? total(items, order) : 0 };
}
