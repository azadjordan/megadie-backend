import mongoose from 'mongoose';
import asyncHandler from '../middleware/asyncHandler.js';
import { getOrderMovement, updateOrderMovement } from '../utils/orderMovement.js';
import { ReservationError } from '../utils/orderReservations.js';

const handle = work => asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid order id.' });
  res.set('Cache-Control', 'no-store');
  try { res.json({ success: true, data: await work(req) }); }
  catch (error) {
    if (error instanceof ReservationError) return res.status(error.statusCode).json({ message: error.message });
    throw error;
  }
});
export const readOrderMovement = handle(req => getOrderMovement(req.params.id));
export const saveOrderMovement = handle(req => updateOrderMovement({ orderId: req.params.id, actor: req.user, body: req.body || {} }));
export const deliverOrder = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid order id.' });
  try {
    const { order, quoteDeleted } = await updateOrderMovement({ orderId: req.params.id, actor: req.user, body: req.body || {}, legacy: true });
    const data = order.toObject(); delete data.deliveryHistory; delete data.reservationRevision;
    res.json({ success: true, message: quoteDeleted ? 'Order delivered and quote deleted.' : 'Order delivered.', quoteDeleted, data });
  } catch (error) {
    if (error instanceof ReservationError) return res.status(error.statusCode).json({ message: error.message });
    throw error;
  }
});
