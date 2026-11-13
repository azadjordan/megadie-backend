import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import { ReservationError } from "../utils/orderReservations.js";
import { getOrderItemsEditor, previewOrderItems, saveOrderItems, searchOrderItemProducts } from "../utils/orderItemChanges.js";

const handle = work => asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ReservationError("Invalid order id.", 400);
    await work(req, res);
  } catch (error) {
    if (!(error instanceof ReservationError)) throw error;
    res.status(error.statusCode).json({ message: error.message, code: "ORDER_ITEMS_REJECTED", refresh: Boolean(error.refresh || (error.statusCode === 409 && !error.issues)), ...(error.issues ? { issues: error.issues } : {}) });
  }
});
export const readOrderItemsEditor = handle(async (req, res) => res.json({ data: await getOrderItemsEditor(req.params.id) }));
export const previewOrderItemChanges = handle(async (req, res) => res.json({ data: await previewOrderItems({ orderId: req.params.id, expectedRevision: req.body?.expectedRevision, items: req.body?.items }) }));
export const applyOrderItemChanges = handle(async (req, res) => {
  const data = await saveOrderItems({ orderId: req.params.id, actor: req.user, expectedRevision: req.body?.expectedRevision, items: req.body?.items, token: req.body?.token, confirmedPhysicalReturn: req.body?.confirmedPhysicalReturn, cancelOrder: req.body?.cancelOrder });
  res.json({ message: data.cancelled ? "Order cancelled. Reservations released and confirmed returns recorded." : "Order items updated. Reservations and packing instructions refreshed.", data });
});
export const findOrderItemProducts = handle(async (req, res) => res.json({ data: await searchOrderItemProducts(req.query.search) }));
