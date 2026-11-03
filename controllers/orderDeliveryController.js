import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Order from "../models/orderModel.js";
import User from "../models/userModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import { deliveryRevisionFilter, getCustomerLocation, resolveOrderDelivery, validateAssignedTo, validateDeliveryDetails, validatePreparationMode } from "../utils/orderDelivery.js";
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
  const changes = {};
  const saveDefault = req.body?.saveCustomerLocation === true;
  if (Object.hasOwn(req.body || {}, "saveCustomerLocation") && typeof req.body.saveCustomerLocation !== "boolean") {
    res.status(400); throw new Error("saveCustomerLocation must be a boolean.");
  }
  try {
    changes.deliveryDetails = validateDeliveryDetails(req.body?.deliveryDetails);
    if (Object.hasOwn(req.body, "preparationMode")) {
      changes.preparationMode = validatePreparationMode(req.body.preparationMode);
      changes.assignedTo = validateAssignedTo(req.body.assignedTo);
    }
    if (saveDefault) {
      if (changes.preparationMode !== "prepare_deliver") throw new Error("Choose Prepare & Deliver to save a customer location.");
      if (!changes.deliveryDetails.address && !changes.deliveryDetails.googleMapsUrl) throw new Error("Add an address or map before saving a customer default.");
      const expected = req.body.expectedCustomerLocation;
      if (!expected || typeof expected.address !== "string" || typeof expected.googleMapsUrl !== "string") throw new Error("Reload the customer's default location before saving.");
    }
    // Omission preserves the assignment for older clients and Courier-only edits.
    if (Object.hasOwn(req.body, "assignedTo")) changes.assignedTo = validateAssignedTo(req.body.assignedTo);
  }
  catch (error) { res.status(400); throw error; }
  async function save(session) {
    const order = await Order.findOneAndUpdate({
      _id: req.params.id, status: { $in: ["Processing", "Shipping"] },
      ...deliveryRevisionFilter(revision),
    }, {
      $set: changes, $inc: { deliveryRevision: 1 },
    }, { new: true, runValidators: true, session });
    if (!order) {
      if (!await Order.exists({ _id: req.params.id }).session(session || null)) { res.status(404); throw new Error("Order not found."); }
      res.status(409); throw new Error("Order changed or is closed. Reload and review before saving delivery details.");
    }
    if (saveDefault) {
      const customer = await User.findById(order.user).select("address deliveryGoogleMapsUrl").session(session);
      if (!customer) { res.status(404); throw new Error("Customer not found."); }
      const current = getCustomerLocation(customer);
      const expected = req.body.expectedCustomerLocation;
      if (current.address !== expected.address.trim() || current.googleMapsUrl !== expected.googleMapsUrl.trim()) {
        res.status(409); throw new Error("Customer default location changed. Reload details and review before saving.");
      }
      await User.updateOne({ _id: customer._id }, { $set: {
        address: changes.deliveryDetails.address, deliveryGoogleMapsUrl: changes.deliveryDetails.googleMapsUrl,
      } }, { session, runValidators: true });
    }
    return order;
  }
  // Only the optional customer update needs a transaction; ordinary order edits stay one write.
  const order = saveDefault ? await mongoose.connection.transaction(save) : await save();
  res.json({ success: true, message: "Delivery details saved for this order.", data: {
    _id: order._id, customerId: order.user, preparationMode: order.preparationMode || "", assignedTo: order.assignedTo || "", resolvedDelivery: resolveOrderDelivery(order),
  } });
});

export const getOrderFulfillmentSheet = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  requireId(req.params.id, res);
  const order = await Order.findById(req.params.id)
    .select("user orderNumber orderItems.product orderItems.sku orderItems.qty status stockFinalizedAt deliveryDetails deliveryRevision assignedTo preparationMode")
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
