import mongoose from 'mongoose';
import asyncHandler from '../middleware/asyncHandler.js';
import { ReservationError } from '../utils/orderReservations.js';
import { getDeliveryTask, listDeliveryTasks, deliveryWorkerChoices, assignDeliveryWorker } from '../utils/workerDelivery.js';
import { updateOrderMovement } from '../utils/orderMovement.js';

const handle = work => asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.params.id && !mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid order id.' });
  try { res.json(await work(req)); }
  catch (error) {
    if (error instanceof ReservationError) return res.status(error.statusCode).json({ message: error.message });
    throw error;
  }
});
export const list = handle(req => listDeliveryTasks(req.user, req.query));
export const read = handle(async req => ({ data: await getDeliveryTask(req.params.id, req.user) }));
export const choices = handle(async req => ({ data: await deliveryWorkerChoices(req.params.id, req.user) }));
export const assign = handle(async req => ({ data: await assignDeliveryWorker({ ...req.body, orderId: req.params.id, actor: req.user }) }));
export const move = handle(async req => {
  await updateOrderMovement({ orderId: req.params.id, actor: req.user, body: req.body || {} });
  return { data: await getDeliveryTask(req.params.id, req.user) };
});
