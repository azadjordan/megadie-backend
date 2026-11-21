import asyncHandler from '../middleware/asyncHandler.js';
import { ReservationError } from '../utils/orderReservations.js';
import { listActiveWorkerWork } from '../utils/workerActiveWork.js';

export const list = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await listActiveWorkerWork(req.user, req.query)); }
  catch (error) {
    if (!(error instanceof ReservationError)) throw error;
    res.status(error.statusCode).json({ message: error.message });
  }
});
