import { buildCartonLabel, resolveOrderDelivery } from "./orderDelivery.js";

const id = (value) => String(value?._id || value?.id || value || "");
const positiveInteger = (value) => Number.isInteger(value) && value > 0;
const sort = new Intl.Collator("en", { numeric: true });

// Only the fields intentionally needed by the person preparing/delivering leave here.
export function buildFulfillmentSheet(order, allocations, generatedAt = new Date()) {
  const problems = [];
  const notices = [];
  const products = new Map();
  const delivery = resolveOrderDelivery(order);
  if (order.status !== "Shipping") problems.push("Order is not Shipping. Confirm reservations before preparing it.");
  if (!delivery.savedToOrder) problems.push("Review and save the delivery details for this order.");
  if (delivery.missingFields.length) problems.push("Delivery details are incomplete: add a contact, phone, and address or map.");

  for (const item of order.orderItems || []) {
    const productId = id(item.product);
    if (!productId || !positiveInteger(item.qty)) {
      problems.push("An order item has an invalid product or quantity.");
      continue;
    }
    const previous = products.get(productId);
    if (previous) previous.orderedQty += item.qty;
    else products.set(productId, {
      productId, sku: item.sku || "Unknown SKU", name: item.productName || "",
      orderedQty: item.qty, allocatedQty: 0,
    });
  }
  if (!products.size) problems.push("Order has no valid items.");

  const picks = [];
  let hasReserved = false;
  let hasDeducted = false;
  for (const row of allocations) {
    if (row.status === "Cancelled") continue;
    if (row.status && !["Reserved", "Deducted"].includes(row.status)) {
      problems.push("An allocation has an unknown status.");
      continue;
    }
    const product = products.get(id(row.product));
    if (!product) { problems.push("An allocation references a product outside this order."); continue; }
    if (!positiveInteger(row.qty)) { problems.push(`${product.sku}: invalid allocation quantity.`); continue; }
    product.allocatedQty += row.qty;
    hasDeducted ||= row.status === "Deducted";
    hasReserved ||= row.status !== "Deducted";
    if (!row.slot?.label || row.slot?.store !== "AE1") {
      problems.push(`${product.sku}: missing slot or unexpected store; confirm the stock location.`);
    }
    picks.push({
      slot: row.slot?.label || "Unknown slot", sku: product.sku, name: product.name,
      qty: row.qty, deducted: row.status === "Deducted",
    });
  }
  for (const product of products.values()) {
    if (product.allocatedQty !== product.orderedQty) {
      problems.push(`${product.sku}: ordered ${product.orderedQty}, allocated ${product.allocatedQty}. Confirm quantities before picking.`);
    }
  }
  if (hasReserved && hasDeducted) problems.push("Allocations are partly deducted; resolve before preparing.");
  if (hasDeducted || order.stockFinalizedAt) {
    notices.push("Stock already deducted — check what has physically been collected before picking again.");
  }
  picks.sort((a, b) => sort.compare(a.slot, b.slot) || sort.compare(a.sku, b.sku));
  return {
    orderId: id(order), orderNumber: order.orderNumber, status: order.status,
    label: buildCartonLabel(order.user?.name, order.orderNumber, id(order)),
    generatedAt: generatedAt.toISOString(), delivery,
    picks, items: [...products.values()],
    problems: [...new Set(problems)], notices,
  };
}
