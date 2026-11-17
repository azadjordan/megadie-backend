import mongoose from 'mongoose';
import Order from '../models/orderModel.js';
import User from '../models/userModel.js';
import { transaction, ReservationError } from './orderReservations.js';
import { reservationId as id } from './orderReservationPlan.js';
import { buildCartonLabel, resolveOrderDelivery } from './orderDelivery.js';
import { deliveryIsOut } from './deliveryMovementState.js';
import { canReadDelivery, deliveryWorkerId, deliveryWorkerFilter } from './deliveryAssignmentState.js';
import { getOrderMovement } from './orderMovement.js';

const reject = (message, code = 409) => { throw new ReservationError(message, code); };
const workerInfo = user => user ? { id: id(user), name: user.name, enabled: Boolean(user.isWorker) } : null;

async function load(orderId, actor, session = null) {
  const order = await Order.findById(orderId).select('+reservationRevision')
    .populate('user', 'name deliveryContactName deliveryPhoneNumber phoneNumber secondaryPhoneNumber address deliveryGoogleMapsUrl deliveryNotes')
    .populate('packingWorker', 'name isWorker').populate('deliveryWorker', 'name isWorker').session(session).lean();
  if (!order || !canReadDelivery(order, actor)) reject('This delivery is no longer available to your account.', actor.isAdmin ? 404 : 403);
  return order;
}

export async function getDeliveryTask(orderId, actor) {
  const order = await load(orderId, actor);
  const driverId = deliveryWorkerId(order);
  const driver = order.deliveryWorker === undefined && driverId ? order.packingWorker : order.deliveryWorker;
  const assigned = driverId === id(actor);
  const canSeeDestination = actor.isAdmin || assigned;
  const out = deliveryIsOut(order), active = order.status === 'Shipping' && !order.stockFinalizedAt;
  const ready = Boolean(order.packedAt || (!order.packingSentAt && order.allocationStatus === 'Allocated'));
  const destination = resolveOrderDelivery(order).details;
  const details = canSeeDestination ? destination : null;
  let readyReason = '';
  if (active && !out) {
    if (!ready) readyReason = 'Waiting for packing.';
    else if (!driver?.isWorker) readyReason = driverId
      ? (actor.isAdmin ? 'Delivery worker access is disabled. Assign another worker.' : 'Delivery worker access is disabled. Ask an admin to assign another worker.')
      : (actor.isAdmin ? 'Assign a delivery worker.' : 'Waiting for delivery assignment.');
    else if (!destination?.address && !destination?.googleMapsUrl) readyReason = 'Delivery location is missing. Ask an admin to add the address or map.';
    else readyReason = (await getOrderMovement(orderId)).readyReason;
  }
  return {
    orderId: id(order), orderNumber: order.orderNumber, customerName: order.user?.name || 'Unknown client',
    label: buildCartonLabel(order.user?.name, order.orderNumber, id(order)), version: order.reservationRevision || 0,
    status: order.status, packedAt: order.packedAt || null, deliveredAt: order.deliveredAt || null,
    deliveryState: order.status === 'Delivered' ? 'delivered' : order.status === 'Cancelled' ? 'cancelled' : out ? 'out' : order.deliveryMovement?.returnedAt && !order.deliveryMovement?.slotsReturnedAt ? 'returned' : ready ? 'ready' : 'waiting',
    worker: workerInfo(driver), delivery: details,
    canAssign: Boolean(actor.isAdmin && active),
    canDepart: active && !out && !readyReason && (actor.isAdmin || assigned),
    canDeliver: active && out && (actor.isAdmin || assigned),
    canReturn: active && out && (actor.isAdmin || assigned),
    canCorrect: Boolean(actor.isAdmin && !order.stockFinalizedAt && (out || order.status === 'Delivered')),
    readyReason: canSeeDestination || !driverId ? readyReason : '',
    manualPreparation: !order.packingSentAt,
    items: canSeeDestination ? order.orderItems.map(item => ({ sku: item.sku, name: item.productName || '', qty: item.qty })) : [],
  };
}

export async function listDeliveryTasks(actor, query = {}) {
  const filter = { status: 'Shipping', ...(actor.isAdmin ? {} : deliveryWorkerFilter(actor._id)) };
  const limit = 12;
  const total = await Order.countDocuments(filter);
  const page = Math.min(Math.max(1, Math.min(10000, parseInt(query.page, 10) || 1)), Math.max(1, Math.ceil(total / limit)));
  const orders = await Order.find(filter).select('_id').sort({ packedAt: -1, createdAt: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean();
  // Use the same readiness and permission rules on cards and details.
  const data = await Promise.all(orders.map(order => getDeliveryTask(id(order), actor).catch(error => {
    if (error instanceof ReservationError && [403, 404].includes(error.statusCode)) return null;
    throw error;
  })));
  return { data: data.filter(Boolean), pagination: { page, total, hasNext: page * limit < total } };
}

export async function deliveryWorkerChoices(orderId, actor) {
  if (!actor?.isAdmin) reject('Only admins can manage delivery assignments.', 403);
  const order = await load(orderId, actor);
  if (order.status !== 'Shipping' || order.stockFinalizedAt) reject('Delivery assignments can be changed only on unfinished orders.');
  return User.find({ isWorker: true }).select('_id name').sort({ name: 1, _id: 1 }).lean();
}

export async function assignDeliveryWorker({ orderId, actor, workerId, expectedRevision, confirmedHandover }) {
  if (!actor?.isAdmin) reject('Only admins can manage delivery assignments.', 403);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) reject('Reload delivery details before assigning.', 400);
  if (workerId !== null && (typeof workerId !== 'string' || !mongoose.isValidObjectId(workerId))) reject('Choose an enabled worker account.', 400);
  await transaction(async session => {
    const current = await User.findOneAndUpdate({ _id: actor._id, isAdmin: true }, { $inc: { staffRevision: 1 } }, { new: true, session });
    if (!current) reject('Only admins can manage delivery assignments. Sign in again.', 403);
    const revision = expectedRevision === 0 ? { $or: [{ reservationRevision: 0 }, { reservationRevision: { $exists: false } }] } : { reservationRevision: expectedRevision };
    const order = await Order.findOneAndUpdate({ _id: orderId, ...revision }, { $inc: { reservationRevision: 1 } }, { new: true, session }).select('+deliveryHistory');
    if (!order) reject('The assignment changed. Reload delivery details before saving.');
    if (order.status !== 'Shipping' || order.stockFinalizedAt) reject('Delivery assignments can be changed only on unfinished orders.');
    const out = deliveryIsOut(order);
    if (out && (confirmedHandover !== true || !workerId)) reject('Confirm delivery responsibility has transferred to the selected worker.', 400);
    const previous = deliveryWorkerId(order);
    const worker = workerId ? await User.findOneAndUpdate({ _id: workerId, isWorker: true }, { $inc: { staffRevision: 1 } }, { new: true, session }) : null;
    if (workerId && !worker) reject('This worker account is no longer enabled.');
    order.deliveryWorker = worker?._id || null;
    // Snapshot legacy defaults once delivery is explicitly assigned.
    if (order.deliveryDetails == null) {
      const customer = await User.findById(order.user).session(session).lean();
      order.deliveryDetails = resolveOrderDelivery({ ...order.toObject(), user: customer }).details;
      order.deliveryRevision = (order.deliveryRevision || 0) + 1;
    }
    if (out) { order.deliveryMovement.worker = worker._id; order.deliveryMovement.handler = worker.name; }
    order.deliveryHistory.push({ action: 'assigned', worker: worker?._id, previousWorker: previous || undefined, handler: worker?.name || '', actor: current._id, actorName: current.name, note: worker ? `Delivery assigned to ${worker.name}.` : 'Delivery assignment removed.' });
    await order.save({ session });
  });
  // The acknowledgement refreshes admin views and the previous driver's access.
  return { orderId, message: 'Delivery assignment saved.' };
}
