export const reservationId = (value) => String(value?._id || value?.id || value || "");
export const isReserved = (row) => !row.status || row.status === "Reserved";
const validQty = (qty) => Number.isSafeInteger(qty) && qty > 0;

// One policy for the bulk action: preserve existing picks, then use the same
// smaller-on-hand-slot-first recommendations shown by the per-item UI.
export function buildOrderReservationPlan(order, allocations, stock, otherReservations) {
  const products = new Map();
  const issues = [];
  const changes = [];
  for (const item of order.orderItems || []) {
    const productId = reservationId(item.product);
    if (!productId || !validQty(item.qty)) {
      issues.push({ productId, sku: item.sku || "Unknown SKU", message: "Invalid ordered product or quantity. Review this order item." });
      continue;
    }
    const product = products.get(productId) || { productId, sku: item.sku || "Unknown SKU", orderedQty: 0 };
    product.orderedQty += item.qty;
    products.set(productId, product);
  }
  if (!products.size && !issues.length) issues.push({ message: "This order has no items to reserve." });
  const key = (row) => `${reservationId(row.product)}:${reservationId(row.slot)}`;
  const others = new Map();
  for (const row of otherReservations.filter(isReserved)) {
    others.set(key(row), (others.get(key(row)) || 0) + row.qty);
  }
  const stocks = new Map(stock.map((row) => [key(row), row]));
  const current = allocations.filter(isReserved);
  for (const row of current) {
    if (!products.has(reservationId(row.product))) {
      issues.push({ productId: reservationId(row.product), message: "A reservation references an item outside this order. Remove it before reserving all items." });
    }
  }
  for (const product of products.values()) {
    const own = current.filter((row) => reservationId(row.product) === product.productId);
    const reservedQty = own.reduce((sum, row) => sum + row.qty, 0);
    const neededQty = Math.max(0, product.orderedQty - reservedQty);
    const occupied = new Set(own.map((row) => reservationId(row.slot)));
    const candidates = stock.filter((row) => reservationId(row.product) === product.productId)
      .sort((a, b) => a.qty - b.qty || new Date(b.createdAt || 0) - new Date(a.createdAt || 0) || reservationId(a).localeCompare(reservationId(b)));
    const usable = candidates.filter((row) => row.slot?.label && row.slot?.store === "AE1" && validQty(row.qty) && !occupied.has(reservationId(row.slot)));
    const available = (row) => Math.max(0, row.qty - (others.get(key(row)) || 0));
    const availableQty = usable.reduce((sum, row) => sum + available(row), 0);
    const base = { ...product, reservedQty, neededQty, availableQty, shortageQty: Math.max(0, neededQty - availableQty) };
    const messages = [];
    if (reservedQty > product.orderedQty) messages.push("Existing reservations exceed the ordered quantity. Review and reduce them.");
    for (const row of own) {
      const slot = stocks.get(key(row));
      if (!validQty(row.qty)) messages.push("An existing reservation has an invalid quantity.");
      else if (!slot?.slot?.label || slot.slot.store !== "AE1") messages.push("An existing reservation has missing stock or an invalid store slot. Review its stock location.");
      else if (row.qty > available(slot)) messages.push(`${slot.slot.label}: existing reservations exceed current stock availability. Review the reserved quantity.`);
    }
    if (neededQty > availableQty) {
      if (!candidates.length) messages.push("No stock slots found. Check the stock location and slot assignment.");
      else if (candidates.some((row) => !row.slot?.label || row.slot?.store !== "AE1")) messages.push("Not enough stock in valid AE1 slots. Review the stock locations.");
      else if (occupied.size) messages.push("Not enough stock in recommended unreserved slots. Review existing slot reservations or add stock.");
      else messages.push("Insufficient available stock. Replenish stock or review other orders' reservations.");
    }
    if (messages.length) {
      issues.push({ ...base, message: [...new Set(messages)].join(" ") });
      continue;
    }
    let remaining = neededQty;
    for (const row of usable) {
      if (!remaining) break;
      const qty = Math.min(available(row), remaining);
      if (!qty) continue;
      changes.push({ productId: product.productId, slotId: reservationId(row.slot), qty });
      remaining -= qty;
    }
  }
  return { issues, changes, itemCount: products.size, addedQty: changes.reduce((sum, row) => sum + row.qty, 0) };
}
