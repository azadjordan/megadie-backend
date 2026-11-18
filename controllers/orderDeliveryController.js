import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Order from "../models/orderModel.js";
import { saveCustomerLocation } from "../utils/customerLocation.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import { deliveryRevisionFilter, resolveOrderDelivery, validateAssignedTo, validateDeliveryDetails, validatePreparationMode, validateLocationChange } from "../utils/orderDelivery.js";
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
  const changesAssignment = Object.hasOwn(req.body || {}, "assignedTo") || Object.hasOwn(req.body || {}, "preparationMode");
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
      if (!changes.deliveryDetails.address && !changes.deliveryDetails.googleMapsUrl) throw new Error("Add an address or map before saving a customer default.");
      const expected = req.body.expectedCustomerLocation;
      if (!expected || typeof expected.address !== "string" || typeof expected.googleMapsUrl !== "string") throw new Error("Reload the customer's default location before saving.");
    }
    // Omission preserves the assignment for older clients and Courier-only edits.
    if (Object.hasOwn(req.body, "assignedTo")) changes.assignedTo = validateAssignedTo(req.body.assignedTo);
  }
  catch (error) { res.status(400); throw error; }
  async function save(session) {
    const previous = await Order.findById(req.params.id).select("deliveryDetails").session(session || null).lean();
    try { validateLocationChange(previous?.deliveryDetails, changes.deliveryDetails, req.body.confirmedMapLocation); }
    catch (error) { res.status(400); throw error; }
    const order = await Order.findOneAndUpdate({
      _id: req.params.id, status: { $in: ["Processing", "Shipping"] },
      ...deliveryRevisionFilter(revision),
      // Destination/contact edits do not change physical custody or stock.
      // Manual assignment edits still require goods in their original slots.
      ...(changesAssignment ? { packingSentAt: null,
        $and: [{ $or: [{ "deliveryMovement.departedAt": null }, { "deliveryMovement.slotsReturnedAt": { $ne: null } }] }],
      } : {}),
    }, {
      $set: changes, $inc: { deliveryRevision: 1, reservationRevision: 1 },
    }, { new: true, runValidators: true, session });
    if (!order) {
      const current = await Order.findById(req.params.id).select("status packingSentAt deliveryMovement").session(session || null).lean();
      if (!current) { res.status(404); throw new Error("Order not found."); }
      res.status(409);
      if (!["Processing", "Shipping"].includes(current.status)) throw new Error(`This order is ${current.status.toLowerCase()}. Its recorded delivery details are read-only.`);
      if (changesAssignment && current.packingSentAt) throw new Error("Use the worker assignment controls to change this order's assignment.");
      if (changesAssignment && current.deliveryMovement?.departedAt && !current.deliveryMovement?.slotsReturnedAt) throw new Error("Confirm the goods are back in their original slots before changing the assignment.");
      throw new Error("Delivery details changed. Reload details and review before saving.");
    }
    if (saveDefault) {
      await saveCustomerLocation({ customerId: order.user, details: changes.deliveryDetails,
        expectedCustomerLocation: req.body.expectedCustomerLocation, confirmedMapLocation: req.body.confirmedMapLocation, session });
    }
    return order;
  }
  // Only the optional customer update needs a transaction; ordinary order edits stay one write.
  const order = saveDefault ? await mongoose.connection.transaction(save) : await save();
  res.json({ success: true, message: "Delivery details saved for this order.", data: {
    _id: order._id, customerId: order.user, preparationMode: order.preparationMode || "", assignedTo: order.assignedTo || "", resolvedDelivery: resolveOrderDelivery(order),
    ...(saveDefault ? { customerLocation: { address: order.deliveryDetails.address, googleMapsUrl: order.deliveryDetails.googleMapsUrl } } : {}),
  } });
});

export const getOrderFulfillmentSheet = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  requireId(req.params.id, res);
  const order = await Order.findById(req.params.id)
    .select("user orderNumber orderItems.product orderItems.sku orderItems.qty status stockFinalizedAt deliveryDetails deliveryRevision assignedTo preparationMode packingSentAt deliveryMovement")
    .populate("user", "name phoneNumber secondaryPhoneNumber address deliveryGoogleMapsUrl deliveryNotes deliveryContactName deliveryPhoneNumber")
    .lean();
  if (!order) { res.status(404); throw new Error("Order not found."); }
  if (["Cancelled", "Delivered"].includes(order.status)) {
    res.status(409); throw new Error("Closed orders cannot be prepared or dispatched.");
  }
  if (order.deliveryMovement?.departedAt && !order.deliveryMovement?.slotsReturnedAt) { res.status(409); throw new Error("Goods have already been prepared for delivery. Confirm they are back in their original slots before preparing again."); }
  if (order.packingSentAt) { res.status(409); throw new Error("This order uses live packing. Share its worker link and review the saved picking progress instead of copying another packing list."); }
  const allocations = await OrderAllocation.find({ order: order._id })
    .select("product slot qty status").populate("slot", "label store").lean();
  res.json({ success: true, data: buildFulfillmentSheet(order, allocations) });
});
