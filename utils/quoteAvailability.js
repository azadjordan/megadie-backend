import mongoose from "mongoose";
import SlotItem from "../models/slotItemModel.js";

export function getAvailabilityStatus(requestedQty, availableNow) {
  const requested = Math.max(0, Number(requestedQty) || 0);
  const available = Math.max(0, Number(availableNow) || 0);
  if (available <= 0) return "NOT_AVAILABLE";
  if (available >= requested) return "AVAILABLE";
  return "SHORTAGE";
}

export async function getAvailabilityTotalsByProduct(productIds) {
  const ids = productIds
    .filter(Boolean)
    .map((id) => (typeof id === "string" ? id : String(id)))
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (ids.length === 0) return new Map();

  const rows = await SlotItem.aggregate([
    { $match: { product: { $in: ids }, qty: { $gt: 0 } } },
    { $group: { _id: "$product", availableNow: { $sum: "$qty" } } },
  ]);

  const map = new Map();
  for (const r of rows) map.set(String(r._id), Number(r.availableNow) || 0);
  return map;
}
