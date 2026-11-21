import asyncHandler from '../middleware/asyncHandler.js';
import { listWorkerWork } from '../utils/workerWork.js';
import { ReservationError } from '../utils/orderReservations.js';

export const list = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await listWorkerWork(req.user, req.query)); }
  catch (error) {
    if (error instanceof ReservationError) return res.status(error.statusCode).json({ message: error.message });
    throw error;
  }
});
