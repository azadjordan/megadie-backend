import mongoose from "mongoose";
import OrderAllocation from "../models/orderAllocationModel.js";
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

  // availableNow means physical on-hand stock minus active order reservations.
  // Quotes do not reserve stock; only existing order allocations reduce availability.
  const [stockRows, reservedRows] = await Promise.all([
    SlotItem.aggregate([
      { $match: { product: { $in: ids }, qty: { $gt: 0 } } },
      { $group: { _id: "$product", onHand: { $sum: "$qty" } } },
    ]),
    OrderAllocation.aggregate([
      {
        $match: {
          product: { $in: ids },
          $or: [{ status: "Reserved" }, { status: { $exists: false } }],
        },
      },
      { $group: { _id: "$product", reserved: { $sum: "$qty" } } },
    ]),
  ]);

  const map = new Map();
  const reservedByProduct = new Map(
    reservedRows.map((row) => [String(row._id), Number(row.reserved) || 0])
  );

  for (const row of stockRows) {
    const productId = String(row._id);
    const onHand = Number(row.onHand) || 0;
    const reserved = reservedByProduct.get(productId) || 0;
    map.set(productId, Math.max(0, onHand - reserved));
  }

  return map;
}
