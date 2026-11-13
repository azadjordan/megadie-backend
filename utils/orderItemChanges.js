import crypto from "node:crypto";
import mongoose from "mongoose";
import Order from "../models/orderModel.js";
import User from "../models/userModel.js";
import Invoice from "../models/invoiceModel.js";
import Product from "../models/productModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import SlotItem from "../models/slotItemModel.js";
import { transaction, lockOrder, lockStock, recomputeAllocationStatus, ReservationError } from "./orderReservations.js";
import { reservationId as id } from "./orderReservationPlan.js";
import { buildOrderItemChangePlan } from "./orderItemChangePlan.js";
import { logInventoryMovement } from "./inventoryMovement.js";

const active = { $or: [{ status: "Reserved" }, { status: { $exists: false } }] };
const reject = (message, status = 409, refresh = false, issues) => Object.assign(new ReservationError(message, status, issues), { refresh });
const assertRevision = revision => { if (!Number.isSafeInteger(revision) || revision < 0) throw reject("Reload the order before editing its items.", 400, true); };
const snapshot = items => items.map(item => ({ product: id(item.product), sku: item.sku, productName: item.productName || "", qty: item.qty, unitPrice: item.unitPrice, lineTotal: item.qty * item.unitPrice }));

async function load(orderId, session) {
  const order = await Order.findById(orderId).select("+reservationRevision +packingReports +packingActivity +itemChanges").session(session);
  if (!order) throw reject("Order not found.", 404);
  return order;
}
export async function orderItemsLockReason(order, session = null) {
  if (order.stockFinalizedAt || await OrderAllocation.exists({ order: order._id, status: "Deducted" }).session(session)) return "Stock finalized. Order items are locked.";
  if (order.status !== "Shipping") return "Items can only be changed while the order is Shipping.";
  if (order.invoice || await Invoice.exists({ order: order._id }).session(session)) return "Invoice exists. Order items are locked.";
  if (order.packedAt) return "Order is Packed. Reopen packing before editing its items.";
  return "";
}
async function rowsFor(orderId, session) {
  return OrderAllocation.find({ order: orderId }).populate("slot", "label store isActive").sort({ _id: 1 }).session(session).lean();
}
function normalize(order, incoming, products) {
  if (!Array.isArray(incoming) || incoming.length > 500) throw reject("Supply the complete item list (up to 500 rows).", 400);
  const seen = new Set(), added = new Set(), oldProducts = new Set(order.orderItems.map(i => id(i.product)));
  const meta = new Map(products.map(p => [id(p), p]));
  return incoming.map(row => {
    if (!row || !Number.isSafeInteger(row.qty) || row.qty < 1) throw reject("Every retained item needs a positive whole-number quantity. Use Remove item to remove a line.", 400);
    if (row.key !== undefined) {
      if (typeof row.key !== "string" || !/^line-\d+$/.test(row.key) || seen.has(row.key)) throw reject("Invalid or duplicate existing order item.", 400);
      const index = Number(row.key.slice(5)), old = order.orderItems[index];
      if (row.key !== 'line-' + index) throw reject("Invalid existing order item key.", 400);
      if (!old) throw reject("This order item changed. Reload the editor.", 409, true);
      if (row.unitPrice !== undefined && row.unitPrice !== old.unitPrice) throw reject("Existing item prices cannot be changed here.", 400);
      if (row.productId !== undefined && row.productId !== id(old.product)) throw reject("An existing item's product cannot be changed. Remove it and add another product.", 400);
      seen.add(row.key);
      return { product: id(old.product), sku: old.sku, productName: old.productName || "", qty: row.qty, unitPrice: old.unitPrice };
    }
    if (typeof row.productId !== "string" || !mongoose.isValidObjectId(row.productId) || oldProducts.has(row.productId) || added.has(row.productId)) throw reject("Select a new product once. Change the quantity on existing items instead of adding them again.", 400);
    const product = meta.get(row.productId);
    if (!product || product.isActive === false) throw reject("The added product no longer exists or is inactive.", 400);
    if (typeof row.unitPrice !== "number" || !Number.isFinite(row.unitPrice) || row.unitPrice < 0 || !Number.isSafeInteger(Math.round(row.unitPrice * 100)) || Math.abs(row.unitPrice * 100 - Math.round(row.unitPrice * 100)) > 0.000001) throw reject("Enter an agreed price with up to two decimal places for every added item.", 400);
    added.add(row.productId);
    return { product: row.productId, sku: product.sku, productName: product.name, qty: row.qty, unitPrice: row.unitPrice };
  });
}
async function planFor(order, incoming, version, session) {
  const ids = [...new Set([...order.orderItems.map(i => id(i.product)), ...(Array.isArray(incoming) ? incoming.map(i => i?.productId).filter(v => typeof v === "string" && mongoose.isValidObjectId(v)) : [])])];
  const [products, allocations, stock, others] = await Promise.all([
    Product.find({ _id: { $in: ids } }).select("name sku packingUnit isActive").sort({ _id: 1 }).session(session).lean(),
    rowsFor(order._id, session),
    SlotItem.find({ product: { $in: ids } }).populate("slot", "label store isActive").sort({ _id: 1 }).session(session).lean(),
    OrderAllocation.find({ product: { $in: ids }, order: { $ne: order._id }, ...active }).select("product slot qty status").session(session).lean(),
  ]);
  const items = normalize(order, incoming, products);
  const plan = buildOrderItemChangePlan({ order, items, products, allocations, stock, others });
  if (!Number.isSafeInteger(Math.round(plan.afterTotal * 100))) throw reject("The proposed order total is too large.", 400);
  const changed = JSON.stringify(snapshot(order.orderItems)) !== JSON.stringify(snapshot(items));
  const cancelOrder = !items.length;
  const token = crypto.createHash("sha256").update(JSON.stringify({ orderId: id(order), customerId: id(order.user), version, before: snapshot(order.orderItems), items, plan, cancelOrder })).digest("hex");
  const before = new Map(), after = new Map();
  for (const item of order.orderItems) before.set(id(item.product), (before.get(id(item.product)) || 0) + item.qty);
  for (const item of items) after.set(id(item.product), (after.get(id(item.product)) || 0) + item.qty);
  const workerChanges = [...new Set([...before.keys(), ...after.keys()])].filter(productId => before.get(productId) !== after.get(productId)).map(productId => ({ product: productId, sku: products.find(product => id(product) === productId)?.sku || order.orderItems.find(item => id(item.product) === productId)?.sku, fromQty: before.get(productId) || 0, toQty: after.get(productId) || 0, unit: products.find(product => id(product) === productId)?.packingUnit || 'units' }));
  return { ...plan, items, token, changed, cancelOrder, workerChanges, requiresPhysicalReturn: plan.returns.length > 0 || (cancelOrder && Boolean(order.packingSentAt)), canSave: changed && !plan.issues.length };
}
function publicPlan(plan) {
  return { token: plan.token, changed: plan.changed, cancelOrder: plan.cancelOrder, requiresPhysicalReturn: plan.requiresPhysicalReturn, canSave: plan.canSave, returns: plan.returns, issues: plan.issues, beforeTotal: plan.beforeTotal, afterTotal: plan.afterTotal };
}
export async function getOrderItemsEditor(orderId) {
  return transaction(async session => {
    const order = await load(orderId, session);
    const [allocations, products, customer, reason] = await Promise.all([
      rowsFor(orderId, session), Product.find({ _id: { $in: order.orderItems.map(i => i.product) } }).select("name sku packingUnit").session(session).lean(),
      User.findById(order.user).select("name").session(session).lean(), orderItemsLockReason(order, session),
    ]);
    return {
      orderId: id(order), orderNumber: order.orderNumber, customerName: customer?.name || "Unknown client", workerName: order.assignedTo || "", sentAt: order.packingSentAt || null,
      version: order.reservationRevision || 0, status: order.status, lockReason: reason, canEdit: !reason, deliveryCharge: order.deliveryCharge || 0, extraFee: order.extraFee || 0,
      items: order.orderItems.map((item, index) => {
        const p = products.find(p => id(p) === id(item.product)), rows = allocations.filter(r => id(r.product) === id(item.product) && (!r.status || r.status === "Reserved"));
        return { key: 'line-' + index, productId: id(item.product), name: p?.name || item.productName || item.sku, sku: item.sku, unit: p?.packingUnit || "units", qty: item.qty, unitPrice: item.unitPrice,
          pickedQty: rows.reduce((sum,r) => sum + (r.pickedQty || 0), 0), reservedQty: rows.reduce((sum,r) => sum + r.qty, 0), problemQty: rows.reduce((sum,r) => sum + (r.pickProblem ? r.qty - (r.pickedQty || 0) : 0), 0) };
      }),
      history: (order.itemChanges || []).slice(-10).reverse(),
    };
  });
}
export async function previewOrderItems({ orderId, expectedRevision, items }) {
  assertRevision(expectedRevision);
  return transaction(async session => {
    const order = await load(orderId, session), reason = await orderItemsLockReason(order, session);
    if (reason) throw reject(reason, 409, true);
    if ((order.reservationRevision || 0) !== expectedRevision) throw reject("Order changed. Reload the latest order and review your draft before saving.", 409, true);
    return publicPlan(await planFor(order, items, expectedRevision, session));
  });
}
export async function saveOrderItems({ orderId, actor, expectedRevision, items, token, confirmedPhysicalReturn, cancelOrder }) {
  assertRevision(expectedRevision);
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw reject("Check the proposed changes before saving.", 400, true);
  return transaction(async session => {
    const current = await User.findOneAndUpdate({ _id: actor._id, isAdmin: true }, { $inc: { staffRevision: 1 } }, { new: true, session });
    if (!current) throw reject("Admin access changed. Sign in again.", 403, true);
    const order = await lockOrder(orderId, session, { expectedRevision, includeItemChanges: true });
    const reason = await orderItemsLockReason(order, session);
    if (reason) throw reject(reason, 409, true);
    const productIds = [...new Set([...order.orderItems.map(i => id(i.product)), ...(Array.isArray(items) ? items.map(i => i?.productId).filter(v => typeof v === "string" && mongoose.isValidObjectId(v)) : [])])];
    await lockStock({ product: { $in: productIds } }, session);
    const plan = await planFor(order, items, expectedRevision, session);
    if (plan.issues.length) throw reject("No changes saved. Resolve the reported stock issues and check the changes again.", 409, true, plan.issues);
    if (plan.token !== token) throw reject("Stock or return quantities changed. Check the latest plan and confirm any returns again.", 409, true);
    if (!plan.changed) throw reject("No order items have changed.", 400);
    if (plan.requiresPhysicalReturn && confirmedPhysicalReturn !== true) throw reject("Confirm the listed goods are physically back in their original slots.", 400);
    if (plan.cancelOrder && cancelOrder !== true) throw reject("Confirm whole-order cancellation when removing every item.", 400);
    const changes = plan.allocations.filter(r => r.qty !== r.previousQty || r.pickedQty !== r.previousPickedQty || r.pickProblem !== r.previousProblem);
    for (const row of changes) {
      if (!row.qty) {
        if (row.allocationId) await OrderAllocation.deleteOne({ _id: row.allocationId, order: order._id }).session(session);
      } else {
        const update = { qty: row.qty, pickedQty: row.pickedQty, pickProblem: row.pickProblem, status: "Reserved", by: current._id, ...(row.pickedQty !== row.previousPickedQty ? { pickedBy: current._id, pickedAt: new Date() } : {}) };
        if (row.allocationId) await OrderAllocation.updateOne({ _id: row.allocationId, order: order._id }, { $set: update, $unset: { expiresAt: "" } }, { session, runValidators: true });
        else {
          const saved = await OrderAllocation.findOneAndUpdate({ order: order._id, product: row.productId, slot: row.slotId }, { $set: update, $unset: { expiresAt: "", deductedAt: "", deductedBy: "", pickedBy: "", pickedAt: "" } }, { new: true, session, upsert: true, runValidators: true, setDefaultsOnInsert: true });
          row.allocationId = id(saved);
        }
      }
      const delta = row.qty - row.previousQty;
      if (delta) await logInventoryMovement({ type: delta > 0 ? "RESERVE" : "RELEASE", product: row.productId, slot: row.slotId, order: order._id, allocation: row.allocationId || undefined, qty: Math.abs(delta), actor: current._id,
        note: plan.cancelOrder ? "Order cancelled after item removal." : "Admin changed order items.", meta: { reason: "ORDER_ITEMS_CHANGED", returnedPickedQty: row.previousPickedQty - row.pickedQty, physicalReturnConfirmed: confirmedPhysicalReturn === true, orderNumber: order.orderNumber } }, session);
    }
    order.itemChanges ||= [];
    order.itemChanges.push({ by: current._id, byName: current.name, before: snapshot(order.orderItems), after: snapshot(plan.items), returns: plan.returns.map(r => ({ product: r.productId, sku: r.sku, slot: r.slotId, slotLabel: r.slot, qty: r.qty })), cancelled: plan.cancelOrder });
    order.packingActivity ||= [];
    order.packingActivity.push({ action: "ORDER_ITEMS_CHANGED", actor: current._id, actorName: current.name, note: plan.cancelOrder ? "Order cancelled after removing all items." : "Order items updated. Review the revised items and quantities.", changes: plan.workerChanges, at: new Date() });
    if (plan.cancelOrder) {
      // Preserve the original item list on the cancelled order for its history.
      await OrderAllocation.deleteMany({ order: order._id }).session(session);
      order.status = "Cancelled"; order.packingSentAt = undefined; order.packingWorker = undefined; order.packedAt = undefined; order.packedBy = undefined;
      order.deliveredAt = null; order.allocationStatus = "Unallocated"; order.allocatedAt = null;
      order.packingSummary = { totalItems: new Set(order.orderItems.map(i => id(i.product))).size, collectedItems: 0, inProgressItems: 0, needsHelp: false };
      for (const request of order.packingHelp || []) if (!request.resolvedAt) request.resolvedAt = new Date();
    } else order.orderItems = plan.items;
    await order.save({ session });
    if (!plan.cancelOrder) await recomputeAllocationStatus(orderId, session);
    return { orderId: id(order), version: order.reservationRevision, cancelled: plan.cancelOrder };
  });
}
export async function searchOrderItemProducts(search) {
  const term = typeof search === "string" ? search.trim().slice(0, 100) : "";
  if (term.length < 2) return [];
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const products = await Product.find({ isActive: { $ne: false }, $or: [{ name: { $regex: escaped, $options: "i" } }, { sku: { $regex: escaped, $options: "i" } }] }).select("name sku packingUnit").sort({ sku: 1, _id: 1 }).limit(12).lean();
  const ids = products.map(p => p._id);
  const [stock, reservations] = await Promise.all([
    SlotItem.find({ product: { $in: ids } }).populate("slot", "label store isActive").select("product slot qty").lean(),
    OrderAllocation.find({ product: { $in: ids }, ...active }).select("product slot qty").lean(),
  ]);
  const held = new Map();
  for (const row of reservations) { const key = id(row.product) + ':' + id(row.slot); held.set(key, (held.get(key) || 0) + row.qty); }
  return products.map(p => ({ productId: id(p), name: p.name, sku: p.sku, unit: p.packingUnit || "units", availableQty: stock.filter(s => id(s.product) === id(p) && s.slot?.label && s.slot.store === "AE1" && s.slot.isActive !== false).reduce((sum,s) => sum + Math.max(0,s.qty - (held.get(id(p)+':'+id(s.slot)) || 0)),0) }));
}
