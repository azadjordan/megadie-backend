import { deliveryStockLockReason } from "./deliveryMovementState.js";
import mongoose from "mongoose";
import Order from "../models/orderModel.js";
import User from "../models/userModel.js";
import Slot from "../models/slotModel.js";
import SlotItem from "../models/slotItemModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import Invoice from "../models/invoiceModel.js";
import { transaction, lockOrder, lockStock, recomputeAllocationStatus, ReservationError } from "./orderReservations.js";
import { reservationId as id, isReserved, buildOrderReservationPlan } from "./orderReservationPlan.js";
import { packingSummary, packingUnitSummary, packingReadyToFinish, packingUnassignLockReason } from "./packingState.js";
import { buildCartonLabel, resolveOrderDelivery, validatePreparationMode, validateDeliveryDetails, getCustomerLocation, normalizeDeliveryDetails, getCustomerDeliveryDefaults } from "./orderDelivery.js";
import { logInventoryMovement } from "./inventoryMovement.js";
import { orderItemsLockReason } from "./orderItemChanges.js";
import { activePackingHelp, resolvePackingHelp } from "./packingHelpState.js";
import { packingPublicationLockReason, packingReopenLockReason } from './packingInvoicePolicy.js';

const validId = value => typeof value === "string" && mongoose.isValidObjectId(value);
const active = { $or: [{ status: "Reserved" }, { status: { $exists: false } }] };
const noteText = value => {
  if (value != null && (typeof value !== "string" || value.trim().length > 500)) throw new ReservationError("Notes must be text of at most 500 characters.", 400);
  return value?.trim() || "";
};
const positive = value => Number.isSafeInteger(value) && value > 0;

function assertAccess(order, actor, { published = true } = {}) {
  if (!actor?.isAdmin && (!actor?.isWorker || !order.packingSentAt || id(order.packingWorker) !== id(actor))) throw new ReservationError("This packing task is no longer assigned to you.", 403);
  if (published && !order.packingSentAt) throw new ReservationError("This order has not been sent to a worker.");
}

async function lockActor(actor, session) {
  const current = await User.findOneAndUpdate({ _id: actor._id, $or: [{ isAdmin: true }, { isWorker: true }] }, { $inc: { staffRevision: 1 } }, { new: true, session });
  if (!current) throw new ReservationError("Your packing access changed. Sign in again.", 403);
  return current;
}

function activity(order, actor, action, values = {}) {
  order.packingActivity ||= [];
  order.packingActivity.push({ action, actor: actor._id, actorName: actor.name, ...values, at: new Date() });
}

async function allocationsFor(orderId, session) {
  return OrderAllocation.find({ order: orderId, status: { $ne: "Cancelled" } })
    .populate("product", "name sku packingUnit")
    .populate("slot", "label store isActive")
    .sort({ createdAt: 1, _id: 1 }).session(session || null).lean();
}

export async function getPackingView(orderId, actor, session = null) {
  const order = await Order.findOne({ _id: orderId, ...(actor.isAdmin ? {} : { packingWorker: actor._id, packingSentAt: { $ne: null } }) }).select("+reservationRevision +packingReports +packingReportsRevision +packingActivity +packingHelp")
    .populate("user", actor.isAdmin ? "name phoneNumber secondaryPhoneNumber address deliveryGoogleMapsUrl deliveryNotes deliveryContactName deliveryPhoneNumber" : "name")
    .populate("packingWorker", "name isWorker isAdmin")
    .populate("packedBy", "name").session(session).lean();
  if (!order) throw new ReservationError("Packing order is no longer available to this account.", actor.isAdmin ? 404 : 403);
  assertAccess(order, actor, { published: !actor.isAdmin });
  if (!actor.isAdmin && order.preparationMode === 'prepare_deliver' && order.deliveryDetails == null) {
    // Older tasks can still rely on profile defaults. Only assigned delivery
    // workers reach this branch; the returned DTO below stays narrowly scoped.
    order.user = await User.findById(id(order.user)).select('name phoneNumber secondaryPhoneNumber deliveryContactName deliveryPhoneNumber address deliveryGoogleMapsUrl deliveryNotes').session(session).lean() || order.user;
  }
  // Lean reads do not apply schema defaults to orders created before packing.
  const reports = order.packingReports || [];
  const history = order.packingActivity || [];
  const itemEvents = history.filter(event => event.action === "ORDER_ITEMS_CHANGED");
  const rows = await allocationsFor(orderId, session);
  const help = activePackingHelp(order, rows);
  const products = new Map();
  for (const item of order.orderItems) {
    const productId = id(item.product);
    const existing = products.get(productId);
    if (existing) existing.qty += item.qty;
    else products.set(productId, { productId, sku: item.sku, name: item.productName || item.sku, unit: "units", qty: item.qty, pickedQty: 0, reservedQty: 0, allocations: [], alternatives: [] });
  }
  const stock = await SlotItem.find({ product: { $in: [...products.keys()] } })
    .populate("slot", "label store isActive").sort({ qty: 1, createdAt: -1, _id: 1 }).session(session).lean();
  const reservations = await OrderAllocation.find({ product: { $in: [...products.keys()] }, ...active }).select("product slot qty").session(session).lean();
  const reserved = new Map();
  for (const row of reservations) {
    const key = `${id(row.product)}:${id(row.slot)}`;
    reserved.set(key, (reserved.get(key) || 0) + row.qty);
  }
  const problems = [];
  for (const row of rows) {
    const p = products.get(id(row.product));
    if (!p) { problems.push("A reservation belongs to a product outside this order. Ask an admin to review it."); continue; }
    if (row.product?.name) p.name = row.product.name;
    if (row.product?.packingUnit) p.unit = row.product.packingUnit;
    p.pickedQty += row.pickedQty || 0;
    p.reservedQty += row.qty;
    if (!row.slot?.label || row.slot?.store !== "AE1" || (row.slot?.isActive === false && row.qty > (row.pickedQty || 0))) problems.push(`${p.sku}: stock location needs admin review.`);
    p.allocations.push({ allocationId: id(row), slotId: id(row.slot), slot: row.slot?.label || "Unknown slot", qty: row.qty, pickedQty: row.pickedQty || 0, problemQty: row.pickProblem ? Math.max(0, row.qty - (row.pickedQty || 0)) : 0, status: row.status || "Reserved", canPick: !deliveryStockLockReason(order) && isReserved(row) && !row.pickProblem && !order.stockFinalizedAt && Boolean(row.slot?.label && row.slot.store === 'AE1' && row.slot.isActive !== false) });
  }
  for (const row of stock) {
    if (!row.slot?.label || row.slot.store !== "AE1" || row.slot.isActive === false) continue;
    const p = products.get(id(row.product));
    const reported = reports.some(report => id(report.product) === p.productId && id(report.slot) === id(row.slot));
    const free = Math.max(0, row.qty - (reserved.get(`${p.productId}:${id(row.slot)}`) || 0));
    if (free && !reported) p.alternatives.push({ slotId: id(row.slot), slot: row.slot.label, availableQty: free });
  }
  const summary = { ...packingSummary(order, rows), ...packingUnitSummary(order, rows) };
  for (const product of products.values()) {
    const request = help.find(request => id(request.product) === product.productId);
    product.helpRequestedAt = request?.requestedAt || null;
  }
  if (order.status !== "Shipping") summary.needsHelp = false;
  const delivery = resolveOrderDelivery(order);
  const hasInvoice = actor.isAdmin && Boolean(order.invoice || await Invoice.exists({ order: order._id }).session(session));
  return {
    orderId: id(order), orderNumber: order.orderNumber, status: order.status,
    customerName: order.user?.name || "Unknown client",
    label: buildCartonLabel(order.user?.name, order.orderNumber, id(order)),
    version: order.reservationRevision || 0, deliveryRevision: order.deliveryRevision || 0,
    worker: order.packingWorker ? { id: id(order.packingWorker), name: order.packingWorker.name || order.assignedTo, enabled: Boolean(order.packingWorker.isWorker) } : null,
    sentAt: order.packingSentAt || null, handoverAt: order.packingHandoverAt || null,
    packedAt: order.packedAt || null, packedBy: order.packedBy?.name || "",
    itemsRevision: itemEvents.length, itemsChangedAt: itemEvents.at(-1)?.at || null,
    itemsChangedBy: itemEvents.at(-1)?.actorName || "",
    itemsChanges: (itemEvents.at(-1)?.changes || []).map(change => ({ productId: id(change.product), sku: change.sku, fromQty: change.fromQty, toQty: change.toQty, unit: change.unit || 'units' })),
    helpRequestedItems: new Set(help.map(request => id(request.product))).size,
    preparationMode: order.preparationMode || "",
    delivery: order.preparationMode === "prepare_deliver" && delivery.details ? { contactName: delivery.details.contactName, phoneNumber: delivery.details.phoneNumber, secondaryPhoneNumber: delivery.details.secondaryPhoneNumber, address: delivery.details.address, googleMapsUrl: delivery.details.googleMapsUrl, notes: delivery.details.notes } : null,
    deliveryState: deliveryStockLockReason(order) ? (order.deliveryMovement?.returnedAt ? "returned" : order.deliveryMovement?.method === "courier" ? "courier" : "company") : null,
    summary, items: [...products.values()], problems,
    canPack: !problems.length && packingReadyToFinish(order, rows),
    ...(actor.isAdmin ? { reports, reportsVersion: order.packingReportsRevision || 0, stockChecksPending: reports.filter(report => !report.checkedAt).length, activity: history, editItemsLockReason: await orderItemsLockReason(order, session), sendLockReason: deliveryStockLockReason(order) || packingPublicationLockReason(order, hasInvoice), reopenLockReason: deliveryStockLockReason(order) || packingReopenLockReason(hasInvoice), unassignLockReason: packingUnassignLockReason(order, rows, hasInvoice), deliveryDetails: delivery.details || {}, customerLocation: getCustomerLocation(order.user), deliverySavedToOrder: delivery.savedToOrder } : {}),
  };
}

export async function sendToWorker({ orderId, actor, expectedRevision, workerId, preparationMode, deliveryDetails, expectedDeliveryRevision, saveCustomerLocation = false, expectedCustomerLocation }) {
  if (!validId(workerId)) throw new ReservationError("Select a worker account.", 400);
  let mode;
  try { mode = validatePreparationMode(preparationMode); validateDeliveryDetails(deliveryDetails); }
  catch (error) { throw new ReservationError(error.message, 400); }
  if (!Number.isSafeInteger(expectedDeliveryRevision) || expectedDeliveryRevision < 0) throw new ReservationError("Reload the order instructions before sending.", 400);
  return transaction(async session => {
    const current = await lockActor(actor, session);
    if (!current.isAdmin) throw new ReservationError("Only admins can assign orders.", 403);
    const order = await lockOrder(orderId, session, { expectedRevision, allowPacked: true });
    const publicationReason = packingPublicationLockReason(order, Boolean(order.invoice || await Invoice.exists({ order: order._id }).session(session)));
    if (publicationReason) throw new ReservationError(publicationReason);
    if ((order.deliveryRevision || 0) !== expectedDeliveryRevision) throw new ReservationError("Order instructions changed. Reload before sending.");
    const customer = order.deliveryDetails == null || saveCustomerLocation ? await User.findById(order.user).session(session) : null;
    const baseline = order.deliveryDetails == null ? getCustomerDeliveryDefaults(customer) : normalizeDeliveryDetails(order.deliveryDetails);
    // Omitted fields preserve the order's existing instructions, including when
    // an older client sends only address/map/notes. Explicit empty strings clear.
    let details;
    try { details = validateDeliveryDetails({ ...baseline, ...deliveryDetails }); }
    catch (error) { throw new ReservationError(error.message, 400); }
    if (mode === 'prepare_deliver' && !details.address && !details.googleMapsUrl) throw new ReservationError('Add an address or map for Prepare & Deliver.', 400);
    const worker = await User.findOneAndUpdate({ _id: workerId, isWorker: true }, { $inc: { staffRevision: 1 } }, { new: true, session });
    if (!worker) throw new ReservationError("This worker account is no longer enabled.");
    const productIds = [...new Set(order.orderItems.map(item => id(item.product)))];
    await lockStock({ product: { $in: productIds } }, session);
    const stock = await SlotItem.find({ product: { $in: productIds } }).populate("slot", "label store isActive").session(session).lean();
    const rows = await OrderAllocation.find({ order: orderId }).session(session).lean();
    const others = await OrderAllocation.find({ product: { $in: productIds }, order: { $ne: order._id }, ...active }).select("product slot qty status").session(session).lean();
    const plan = buildOrderReservationPlan(order, rows, stock, others);
    const issues = [...plan.issues.map(issue => `${issue.sku || "Order"}: ${issue.message}`)];
    if (plan.changes.length || order.orderItems.some(item => rows.filter(row => isReserved(row) && id(row.product) === id(item.product)).reduce((sum, row) => sum + row.qty, 0) < item.qty)) issues.push("Reserve every ordered quantity before sending to a worker.");
    if (rows.some(row => isReserved(row) && row.qty > (row.pickedQty || 0) && stock.find(s => id(s.product) === id(row.product) && id(s.slot) === id(row.slot))?.slot?.isActive === false)) issues.push("A reserved location is inactive. Review the reservations.");
    if (issues.length) throw new ReservationError(issues.join(" "));
    if (saveCustomerLocation) {
      if (mode !== "prepare_deliver" || !expectedCustomerLocation) throw new ReservationError("Reload the customer's location before updating its default.", 400);
      if (!customer) throw new ReservationError("Customer not found.", 404);
      const old = getCustomerLocation(customer);
      if (old.address !== expectedCustomerLocation.address || old.googleMapsUrl !== expectedCustomerLocation.googleMapsUrl) throw new ReservationError("Customer default location changed. Reload before saving.");
      customer.address = details.address; customer.deliveryGoogleMapsUrl = details.googleMapsUrl;
      await customer.save({ session });
    }
    const reassigned = order.packingSentAt && id(order.packingWorker) !== workerId;
    activity(order, current, !order.packingSentAt ? "SENT" : reassigned ? "REASSIGNED" : "INSTRUCTIONS_SAVED", { note: worker.name });
    if (reassigned) order.packingHandoverAt = new Date();
    order.packingWorker = worker._id; order.assignedTo = worker.name;
    order.packingSentAt ||= new Date(); order.preparationMode = mode;
    order.deliveryDetails = details; order.deliveryRevision = (order.deliveryRevision || 0) + 1;
    order.packingSummary = packingSummary(order, rows);
    await order.save({ session });
    return getPackingView(orderId, current, session);
  });
}

export async function unassignPacking({ orderId, actor, expectedRevision, expectedDeliveryRevision, confirmedPhysicalReturn }) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Number.isSafeInteger(expectedDeliveryRevision) || expectedDeliveryRevision < 0) throw new ReservationError('Reload the worker assignment before removing it.', 400);
  if (confirmedPhysicalReturn !== true) throw new ReservationError('Confirm the worker has stopped and all goods are in their original slots.', 400);
  return transaction(async session => {
    const current = await lockActor(actor, session);
    if (!current.isAdmin) throw new ReservationError('Only admins can remove worker assignments.', 403);
    // Use the same revision lock as picking and reassignment so a competing
    // saved pick must be reviewed before withdrawing the task.
    const order = await lockOrder(orderId, session, { expectedRevision });
    if ((order.deliveryRevision || 0) !== expectedDeliveryRevision) throw new ReservationError('Order instructions changed. Reload before removing the assignment.');
    const rows = await allocationsFor(orderId, session);
    const hasInvoice = Boolean(order.invoice || await Invoice.exists({ order: order._id }).session(session));
    const reason = packingUnassignLockReason(order, rows, hasInvoice);
    if (reason) throw new ReservationError(reason);
    activity(order, current, 'ASSIGNMENT_REMOVED', { note: `${order.assignedTo || 'Worker'} — manual preparation; worker stopped and goods in original slots confirmed.` });
    order.packingWorker = undefined;
    order.packingSentAt = undefined;
    order.packingHandoverAt = undefined;
    order.assignedTo = '';
    order.deliveryRevision = (order.deliveryRevision || 0) + 1;
    order.packingSummary = packingSummary(order, rows);
    resolvePackingHelp(order, rows);
    await order.save({ session });
    return getPackingView(orderId, current, session);
  });
}

export async function changePacking({ orderId, actor, expectedRevision, action, allocationId, pickedQty, note, confirmedReturn, slotId, qty }) {
  if (expectedRevision === undefined) throw new ReservationError("Reload current packing progress before saving.", 400);
  return transaction(async session => {
    const current = await lockActor(actor, session);
    // Check assignment before state/version errors so another worker cannot
    // discover a closed order's details by attempting a write against its id.
    if (!current.isAdmin && !await Order.exists({ _id: orderId, packingWorker: current._id, packingSentAt: { $ne: null } }).session(session)) throw new ReservationError("This packing task is no longer assigned to you.", 403);
    const order = await lockOrder(orderId, session, { expectedRevision, allowPacked: action === "reopen" });
    assertAccess(order, current);
    if (action === "reopen") {
      if (!current.isAdmin) throw new ReservationError("Only an admin can reopen packing.", 403);
      const reopenReason = packingReopenLockReason(Boolean(order.invoice || await Invoice.exists({ order: order._id }).session(session)));
      if (reopenReason) throw new ReservationError(reopenReason);
      order.packedAt = undefined; order.packedBy = undefined;
      activity(order, current, "REOPENED");
    } else if (action === "packed") {
      const rows = await allocationsFor(orderId, session);
      if (!packingReadyToFinish(order, rows)) throw new ReservationError("Collect every ordered quantity and resolve picking shortages before marking Packed.");
      order.packedAt = new Date(); order.packedBy = current._id;
      activity(order, current, "PACKED");
    } else {
      if (!validId(allocationId)) throw new ReservationError("Invalid reservation.", 400);
      const row = await OrderAllocation.findOne({ _id: allocationId, order: orderId, ...active }).session(session);
      if (!row) throw new ReservationError("This reservation changed. Refresh packing progress.");
      await lockStock({ product: row.product, slot: row.slot }, session);
      if (action === "replace") {
        if (!validId(slotId) || !positive(qty) || id(row.slot) === slotId) throw new ReservationError("Select another location and a positive whole-number quantity.", 400);
        if (!row.pickProblem || qty > row.qty - (row.pickedQty || 0)) throw new ReservationError("Save the collected quantity and shortage before replacing its unpicked remainder.");
        const reported = order.packingReports.some(r => id(r.product) === id(row.product) && id(r.slot) === slotId);
        if (reported) throw new ReservationError("This location was also reported short on this order. Ask an admin to review it.");
        await lockStock({ product: row.product, slot: slotId }, session);
        const slot = await Slot.findOne({ _id: slotId, store: "AE1", isActive: { $ne: false } }).session(session);
        const stock = await SlotItem.findOne({ product: row.product, slot: slotId }).session(session);
        if (!slot || !stock) throw new ReservationError("The alternative location is no longer available.");
        const held = await OrderAllocation.find({ product: row.product, slot: slotId, ...active }).select("qty").session(session).lean();
        const available = Math.max(0, stock.qty - held.reduce((sum, a) => sum + a.qty, 0));
        if (qty > available) throw new ReservationError(`Availability changed. Only ${available} units are available at ${slot.label}.`);
        const target = await OrderAllocation.findOneAndUpdate({ order: order._id, product: row.product, slot: slotId }, { $inc: { qty }, $set: { status: "Reserved", by: current._id }, $unset: { expiresAt: "" } }, { new: true, upsert: true, setDefaultsOnInsert: true, session });
        await logInventoryMovement({ type: "RELEASE", product: row.product, slot: row.slot, order: order._id, allocation: row._id, qty, actor: current._id, note: "Packing location replacement" }, session);
        await logInventoryMovement({ type: "RESERVE", product: row.product, slot: slotId, order: order._id, allocation: target._id, qty, actor: current._id, note: "Packing location replacement" }, session);
        activity(order, current, "REPLACED", { product: row.product, slot: row.slot, toSlot: slotId, qty });
        row.qty -= qty;
        if (row.qty === 0) await row.deleteOne({ session });
        else { if (row.qty === (row.pickedQty || 0)) row.pickProblem = false; await row.save({ session }); }
      } else if (action === "help") {
        if (current.isAdmin) throw new ReservationError("Only the assigned worker can request admin help.", 403);
        if (!row.pickProblem || row.qty <= (row.pickedQty || 0)) throw new ReservationError("Save an unresolved shortage before asking for admin help.");
      } else if (["pick", "problem", "correct"].includes(action)) {
        if (action === "pick") {
          if (row.pickProblem) throw new ReservationError("This slot was reported short. Review the shortage and enter the actual picked total.");
          const slot = await Slot.findOne({ _id: row.slot, store: "AE1", isActive: { $ne: false } }).session(session);
          if (!slot) throw new ReservationError("This picking location changed or is inactive. Use Not enough here or ask an admin to review it.");
        }
        const before = row.pickedQty || 0;
        if (!Number.isSafeInteger(pickedQty) || pickedQty < 0 || pickedQty > row.qty) throw new ReservationError("Picked total must be a whole number within this reservation.", 400);
        if (pickedQty < before && (action !== "correct" || confirmedReturn !== true)) throw new ReservationError("Confirm the items are back in their slot, or the earlier count was wrong.");
        if (action === "correct" && (confirmedReturn !== true || pickedQty > before)) throw new ReservationError("Correction requires a returned/never removed quantity confirmation.", 400);
        const cleanNote = noteText(note);
        row.pickedQty = pickedQty; row.pickedBy = current._id; row.pickedAt = new Date();
        if (action === "problem") {
          row.pickProblem = pickedQty < row.qty;
          if (row.pickProblem) {
            const slot = await Slot.findById(row.slot).select("label").session(session);
            const item = order.orderItems.find(item => id(item.product) === id(row.product));
            order.packingReports.push({ allocation: row._id, product: row.product, sku: item?.sku || "", slot: row.slot, slotLabel: slot?.label || "Unknown slot", requestedQty: row.qty, pickedQty, shortQty: row.qty - pickedQty, note: cleanNote, by: current._id, byName: current.name });
            order.packingReportsRevision = (order.packingReportsRevision || 0) + 1;
          }
        }
        if (pickedQty === row.qty) row.pickProblem = false;
        activity(order, current, action === "correct" ? "CORRECTED" : action === "problem" ? "PROBLEM_REPORTED" : "PICKED", { product: row.product, slot: row.slot, previousQty: before, qty: pickedQty, note: cleanNote });
        await row.save({ session });
      } else throw new ReservationError("Unknown packing action.", 400);
    }
    await order.save({ session });
    if (["problem", "replace", "correct", "help"].includes(action) && !current.isAdmin) {
      const view = await getPackingView(orderId, current, session);
      const source = await OrderAllocation.findById(allocationId).session(session).lean();
      // A fully moved source can be deleted; its report still identifies the product.
      const productId = source ? id(source.product) : id(order.packingReports.find(report => id(report.allocation) === allocationId)?.product);
      const product = view.items.find(item => item.productId === productId);
      resolvePackingHelp(order, await allocationsFor(orderId, session));
      if (product?.allocations.some(row => row.problemQty > 0) && (action === "help" || !product.alternatives.length) && !order.packingHelp.some(request => !request.resolvedAt && id(request.product) === productId)) {
        const report = [...order.packingReports].reverse().find(report => id(report.product) === productId);
        order.packingHelp.push({ product: productId, sku: product.sku, requestedBy: current._id, requestedByName: current.name, reason: action === "help" ? "worker_requested" : "no_alternative", note: report?.note || "", notification: { nextAttemptAt: new Date() } });
        activity(order, current, "ADMIN_HELP_REQUESTED", { product: productId });
      }
      await order.save({ session });
    }
    await recomputeAllocationStatus(orderId, session);
    return getPackingView(orderId, current, session);
  });
}

export async function reviewPackingReport({ orderId, reportId, actor, checked, expectedReportsVersion }) {
  if (!validId(reportId) || typeof checked !== 'boolean' || !Number.isSafeInteger(expectedReportsVersion) || expectedReportsVersion < 0) throw new ReservationError('Reload the stock reports before checking this report.', 400);
  return transaction(async session => {
    const current = await lockActor(actor, session);
    if (!current.isAdmin) throw new ReservationError('Only admins can check stock reports.', 403);
    const revisionFilter = expectedReportsVersion === 0 ? { $or: [{ packingReportsRevision: 0 }, { packingReportsRevision: { $exists: false } }] } : { packingReportsRevision: expectedReportsVersion };
    const order = await Order.findOneAndUpdate({ _id: orderId, ...revisionFilter }, { $inc: { packingReportsRevision: 1 } }, { new: true, session }).select('+packingReports +packingReportsRevision +packingActivity');
    if (!order) {
      if (!await Order.exists({ _id: orderId }).session(session)) throw new ReservationError('Order not found.', 404);
      throw new ReservationError('Stock report checks changed. Refresh the latest reports before another change.');
    }
    const report = order.packingReports.id(reportId);
    if (!report) throw new ReservationError('Stock report not found.', 404);
    if (checked) {
      report.checkedAt ||= new Date(); report.checkedBy ||= current._id; report.checkedByName ||= current.name;
    } else {
      report.checkedAt = undefined; report.checkedBy = undefined; report.checkedByName = undefined;
    }
    activity(order, current, checked ? 'STOCK_REPORT_CHECKED' : 'STOCK_REPORT_REOPENED', { product: report.product, slot: report.slot, note: 'Report ' + id(report) });
    await order.save({ session });
    return getPackingView(orderId, current, session);
  });
}
