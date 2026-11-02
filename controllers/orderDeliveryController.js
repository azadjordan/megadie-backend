import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Order from "../models/orderModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import { deliveryRevisionFilter, resolveOrderDelivery, validateDeliveryDetails } from "../utils/orderDelivery.js";
import { buildFulfillmentSheet } from "../utils/orderFulfillment.js";

const requireId = (id, res) => {
  if (!mongoose.isValidObjectId(id)) { res.status(400); throw new Error("Invalid order id."); }
};

export const updateOrderDelivery = asyncHandler(async (req, res) => {
  requireId(req.params.id, res);
  const revision = req.body?.expectedRevision;
  if (!Number.isInteger(revision) || revision < 0) {
    res.status(400); throw new Error("A valid expectedRevision is required.");
  }
  let details;
  try { details = validateDeliveryDetails(req.body?.deliveryDetails); }
  catch (error) { res.status(400); throw error; }
  const order = await Order.findOneAndUpdate({
    _id: req.params.id, status: { $in: ["Processing", "Shipping"] },
    ...deliveryRevisionFilter(revision),
  }, {
    $set: { deliveryDetails: details }, $inc: { deliveryRevision: 1 },
  }, { new: true, runValidators: true });
  if (!order) {
    if (!await Order.exists({ _id: req.params.id })) { res.status(404); throw new Error("Order not found."); }
    res.status(409); throw new Error("Order changed or is closed. Reload and review before saving delivery details.");
  }
  res.json({ success: true, message: "Delivery details saved for this order.", data: {
    _id: order._id, resolvedDelivery: resolveOrderDelivery(order),
  } });
});

export const getOrderFulfillmentSheet = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  requireId(req.params.id, res);
  const order = await Order.findById(req.params.id)
    .select("user orderNumber orderItems.product orderItems.sku orderItems.qty status stockFinalizedAt deliveryDetails deliveryRevision")
    .populate("user", "name phoneNumber secondaryPhoneNumber address deliveryGoogleMapsUrl deliveryNotes deliveryContactName deliveryPhoneNumber")
    .lean();
  if (!order) { res.status(404); throw new Error("Order not found."); }
  if (["Cancelled", "Delivered"].includes(order.status)) {
    res.status(409); throw new Error("Closed orders cannot be prepared or dispatched.");
  }
  const allocations = await OrderAllocation.find({ order: order._id })
    .select("product slot qty status").populate("slot", "label store").lean();
  res.json({ success: true, data: buildFulfillmentSheet(order, allocations) });
});
