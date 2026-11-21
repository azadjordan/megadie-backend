import Order from '../models/orderModel.js';
import OrderAllocation from '../models/orderAllocationModel.js';
import SlotItem from '../models/slotItemModel.js';
import Quote from '../models/quoteModel.js';
import User from '../models/userModel.js';
import { deliveryWorkerId } from './deliveryAssignmentState.js';
import { resolveOrderDelivery } from './orderDelivery.js';
import { transaction, lockStock, ReservationError } from './orderReservations.js';
import { reservationId as id, isReserved, buildOrderReservationPlan } from './orderReservationPlan.js';
import { canMarkPacked, packingSummary } from './packingState.js';
import { deliveryHoldsGoods, deliveryIsOut } from './deliveryMovementState.js';
import { recordWorkerWork, voidWorkerWork } from './workerWork.js';

const reject = (message, code = 409) => { throw new ReservationError(message, code); };
const selection = '+reservationRevision +deliveryHistory +packingActivity';
const deliveryOwners = new Map([['azad', 'Azad'], ['momani', 'Momani']]);

export async function movementReadyReason(order, rows, session = null, snapshot = null) {
  if (order.status !== 'Shipping') return 'Delivery updates require an order in preparation.';
  if (order.stockFinalizedAt || rows.some(r => r.status === 'Deducted')) return 'Stock has already been finalized. Review the order.';
  if (order.packingSentAt && (!order.packedAt || !canMarkPacked(order, rows))) return 'The worker must finish and mark this order Packed before delivery.';
  const ordered = new Map(), reserved = new Map();
  for (const item of order.orderItems) ordered.set(id(item.product), (ordered.get(id(item.product)) || 0) + item.qty);
  for (const row of rows.filter(isReserved)) {
    if (!Number.isSafeInteger(row.qty) || row.qty <= 0 || !Number.isSafeInteger(row.pickedQty || 0) || (row.pickedQty || 0) < 0 || (row.pickedQty || 0) > row.qty || row.pickProblem) return 'Review reservation quantities and unresolved picking problems first.';
    reserved.set(id(row.product), (reserved.get(id(row.product)) || 0) + row.qty);
  }
  if (!ordered.size || ordered.size !== reserved.size || [...ordered].some(([p, q]) => reserved.get(p) !== q)) return 'Reserve all items before updating delivery.';
  const products = [...ordered.keys()];
  const stocks = snapshot?.stock || await SlotItem.find({ product: { $in: products } }).populate('slot', 'label store isActive').session(session).lean();
  const others = snapshot?.others || await OrderAllocation.find({ product: { $in: products }, order: { $ne: order._id }, $or: [{ status: 'Reserved' }, { status: { $exists: false } }] }).session(session).lean();
  const plan = buildOrderReservationPlan(order, rows, stocks, others);
  if (plan.issues.length) return plan.issues.map(i => i.message).join(' ');
  if (rows.filter(isReserved).some(r => !stocks.some(s => id(s.product) === id(r.product) && id(s.slot) === id(r.slot) && (s.slot?.isActive !== false || r.pickedQty === r.qty)))) return 'Review the reserved stock locations before updating delivery.';
  return '';
}
async function deliveryWorkerView(order, session) {
  const workerId = deliveryWorkerId(order);
  const worker = workerId ? await User.findById(workerId).select('name isWorker').session(session).lean() : null;
  return worker ? { id: workerId, name: worker.name, enabled: Boolean(worker.isWorker) } : null;
}
async function view(order, session = null) {
  const rows = await OrderAllocation.find({ order: order._id }).session(session).lean();
  return { orderId: id(order), orderNumber: order.orderNumber, status: order.status,
    version: order.reservationRevision || 0, movement: order.deliveryMovement || null,
    deliveryWorker: await deliveryWorkerView(order, session),
    deliveredAt: order.deliveredAt || null, deliveredBy: order.deliveredBy || '',
    manualPreparation: !order.packingSentAt, isOut: deliveryIsOut(order), holdsGoods: deliveryHoldsGoods(order),
    readyReason: await movementReadyReason(order, rows, session), history: order.deliveryHistory || [] };
}
export async function getOrderMovement(orderId) {
  const order = await Order.findById(orderId).select(selection);
  if (!order) reject('Order not found.', 404);
  return view(order);
}

export async function updateOrderMovement({ orderId, actor, body, legacy = false }) {
  const action = legacy ? 'delivered' : body.action;
  const { expectedRevision } = body;
  if (!['departed', 'delivered', 'collected', 'returned', 'reshelved', 'corrected'].includes(action)) reject('Choose a valid delivery update.', 400);
  if ((!legacy || expectedRevision !== undefined) && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) reject('Reload delivery details before saving.', 400);
  const note = body.note ?? '';
  if (typeof note !== 'string' || note.trim().length > 500) reject('Keep the note within 500 characters.', 400);
  return transaction(async session => {
    const currentActor = await User.findOneAndUpdate({ _id: actor._id, $or: [{ isAdmin: true }, { isWorker: true }] }, { $inc: { staffRevision: 1 } }, { new: true, session });
    if (!currentActor) reject('Your worker access changed. Sign in again.', 403);
    actor = currentActor;
    const filter = { _id: orderId };
    if (expectedRevision === 0) filter.$or = [{ reservationRevision: 0 }, { reservationRevision: { $exists: false } }];
    else if (expectedRevision !== undefined) filter.reservationRevision = expectedRevision;
    const order = await Order.findOneAndUpdate(filter, { $inc: { reservationRevision: 1 } }, { new: true, session }).select(selection);
    if (!order) {
      if (!await Order.exists({ _id: orderId }).session(session)) reject('Order not found.', 404);
      reject('Order changed. Reload delivery details and review before saving.');
    }
    if (!actor.isAdmin) {
      if (!actor.isWorker || deliveryWorkerId(order) !== id(actor)) reject('This delivery is no longer assigned to you.', 403);
      if (legacy || !['departed', 'delivered', 'returned'].includes(action)) reject('Only admins can make this delivery change.', 403);
      if (['method', 'handler', 'deliveryCharge', 'extraFee', 'deliveredBy', 'adminToAdminNote', 'adminToClientNote'].some(key => Object.hasOwn(body, key))) reject('Workers can record delivery events only.', 400);
      if (action === 'delivered' && !deliveryIsOut(order)) reject('Record Out for delivery before confirming customer receipt.');
      if (['delivered', 'returned'].includes(action) && deliveryIsOut(order) && order.deliveryMovement?.method !== 'company') reject('This delivery is being handled outside the worker delivery flow. Ask an admin to update it.');
      if (action === 'departed' && order.deliveryDetails == null) {
        const customer = await User.findById(order.user).session(session).lean();
        order.deliveryDetails = resolveOrderDelivery({ ...order.toObject(), user: customer }).details;
        order.deliveryRevision = (order.deliveryRevision || 0) + 1;
      }
      const destination = order.deliveryDetails;
      if (action === 'departed' && destination != null && !destination.address && !destination.googleMapsUrl) reject('Delivery location is missing. Ask an admin to add the address or map.');
    }
    if ((order.status !== 'Shipping' && !(actor.isAdmin && action === 'corrected' && order.status === 'Delivered')) || order.stockFinalizedAt) reject('Only unfinished deliveries can be updated.');
    const now = new Date();
    let quoteDeleted = false;
    const current = order.deliveryMovement;
    const out = deliveryIsOut(order), held = deliveryHoldsGoods(order);
    const driverId = deliveryWorkerId(order);
    const driver = driverId ? (action === 'departed'
      ? await User.findOneAndUpdate({ _id: driverId, isWorker: true }, { $inc: { staffRevision: 1 } }, { new: true, session }).select('name isWorker')
      : await User.findById(driverId).select('name isWorker').session(session)) : null;
    let method = body.method;
    const suppliedHandler = legacy ? body.deliveredBy : body.handler;
    if (suppliedHandler != null && (typeof suppliedHandler !== 'string' || suppliedHandler.trim().length > 120)) reject('Keep Handed to within 120 characters.', 400);
    let handler = suppliedHandler?.trim() || '';
    if (method !== undefined && !['courier', 'company', 'collection'].includes(method)) reject('Invalid delivery method.', 400);
    if (['returned', 'reshelved', 'corrected'].includes(action) || (action === 'delivered' && out)) {
      method = current?.method || (driverId ? 'company' : undefined);
      handler = current?.handler || (method === 'company' ? driver?.name || '' : '');
      if (action === 'delivered' && ((body.method && body.method !== method) || (suppliedHandler?.trim() && suppliedHandler.trim() !== handler))) reject('Delivery responsibility changed. Review the assigned delivery person before confirming.');
    } else {
      if (action === 'collected' || (legacy && handler === 'Pick Up By Client')) method = 'collection';
      if (driverId) {
        if (method && method !== 'company') reject('Remove or change the delivery worker assignment before choosing another delivery method.');
        if (!driver || (action === 'departed' && !driver.isWorker)) reject('Assign an enabled delivery worker before departure.');
        if (handler && handler !== driver.name) reject('The typed delivery name conflicts with the assigned worker. Change the delivery assignment first.');
        method = 'company'; handler = driver.name;
      } else {
        // Legacy clients use deliveredBy; new owner deliveries still require an
        // explicit known owner. Existing departures are handled above unchanged.
        if (!method && legacy) {
          if (!handler) reject('Select a delivery worker or provide the delivery method and recipient.', 400);
          method = 'company';
        }
        if (!method) reject('Choose a delivery method or assign a delivery worker.', 400);
        if (method === 'company') {
          const owner = deliveryOwners.get(handler.toLowerCase());
          if (!owner) reject('Choose Azad or Momani, or use Assign delivery worker. Refresh the page if these choices are missing.', 400);
          handler = owner;
        }
      }
      if (method === 'collection') handler = 'Customer collection';
      if (method === 'courier' && !handler) reject('Enter the courier name.', 400);
    }
    const rows = await OrderAllocation.find({ order: orderId }).session(session).lean();
    await lockStock({ product: { $in: order.orderItems.map(i => i.product) } }, session);
    if (action === 'corrected') {
      if (!actor.isAdmin || body.confirmedCorrection !== true || !note.trim()) reject('Confirm this was recorded by mistake and give a reason.', 400);
      if (rows.some(row => row.status === 'Deducted')) reject('Stock has been finalized. This delivery cannot be corrected here.');
      if (order.status === 'Delivered') {
        await voidWorkerWork(order, 'delivered', 'delivery_corrected', session);
        order.status = 'Shipping'; order.deliveredAt = undefined; order.deliveredBy = undefined;
      } else if (out) {
        // The confirmation means departure never happened. Preserve the pick
        // ledger (goods are still packed), and keep the mistaken event in history.
        order.deliveryMovement = undefined;
      } else reject('There is no delivery event to correct.');
    } else if (action === 'returned') {
      if (!out) reject('This order has no active delivery departure to return.');
      if (body.confirmedReturn !== true) reject('Confirm all goods are physically back in the store.', 400);
      order.deliveryMovement.returnedAt = now;
    } else if (action === 'reshelved') {
      if (!held || out || !current?.returnedAt) reject('Record the return to the store before returning goods to slots.');
      if (body.confirmedReturn !== true) reject('Confirm every unit is physically back in its original slot.', 400);
      if (rows.some(r => r.status === 'Deducted')) reject('Finalized stock cannot be returned through this action.');
      await OrderAllocation.updateMany({ order: orderId, $or: [{ status: 'Reserved' }, { status: { $exists: false } }] }, { $set: { pickedQty: 0, pickProblem: false, pickedAt: now, pickedBy: actor._id } }, { session });
      order.deliveryMovement.slotsReturnedAt = now;
      await voidWorkerWork(order, 'packed', 'reshelved', session);
      order.packedAt = undefined; order.packedBy = undefined;
      order.packingSummary = packingSummary(order, rows.map(r => ({ ...r, pickedQty: 0, pickProblem: false })));
    } else {
      if (action === 'departed' && (out || method === 'collection')) reject('Record customer collection as completed, or return the active delivery first.');
      if (action === 'collected' && (method !== 'collection' || out)) reject('Customer collection requires the goods to be in the store.');
      const reason = await movementReadyReason(order, rows, session);
      if (reason) reject(reason);
      if (!legacy && !order.packingSentAt && body.confirmedReady !== true) reject('Confirm the order is prepared from the reserved slots.', 400);
      if (!legacy && (action === 'delivered' || action === 'collected') && body.confirmedReceived !== true) reject('Confirm the customer has received the complete order.', 400);
      // Manual preparation has no worker pick ledger. Record the confirmed sources
      // so shelf counts cannot treat dispatched cartons as stock still on shelves.
      if (!order.packingSentAt) await OrderAllocation.updateMany({ order: orderId, $or: [{ status: 'Reserved' }, { status: { $exists: false } }] }, [{ $set: { pickedQty: '$qty', pickedAt: now, pickedBy: actor._id, pickProblem: false } }], { session });
      if (action === 'departed') order.deliveryMovement = { method, handler, worker: deliveryWorkerId(order) || undefined, departedAt: now };
      else {
        if (!out) order.deliveryMovement = { method, handler };
        order.status = 'Delivered'; order.deliveredAt = now; order.deliveredBy = handler;
        if (order.quote) { const removed = await Quote.deleteOne({ _id: order.quote }).session(session); quoteDeleted = removed.deletedCount > 0; order.quote = null; }
        // Preserve supported fee/note edits for callers of the original endpoint.
        for (const key of ['deliveryCharge', 'extraFee']) if (Object.hasOwn(body, key)) {
          if (order.invoice) reject('Cannot change delivery fees after invoicing.', 400);
          const amount = Number(body[key]); if (!Number.isFinite(amount) || amount < 0) reject(`${key} must be non-negative.`, 400);
          order[key] = amount;
        }
        for (const key of ['adminToAdminNote', 'adminToClientNote']) if (Object.hasOwn(body, key)) order[key] = String(body[key] ?? '');
      }
    }
    const eventAction = method === 'collection' && action === 'delivered' ? 'collected' : action;
    order.deliveryHistory.push({ action: eventAction, method, handler, worker: deliveryWorkerId(order) || undefined, actor: actor._id, actorName: actor.name, note: note.trim(), at: now });
    if (eventAction === 'delivered' && method === 'company') {
      await recordWorkerWork({ order, type: 'delivered', worker: deliveryWorkerId(order), actor, event: order.deliveryHistory.at(-1), session });
    }
    await order.save({ session });
    return legacy ? { order, quoteDeleted } : view(order, session);
  });
}
