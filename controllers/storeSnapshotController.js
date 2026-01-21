// controllers/storeSnapshotController.js
import asyncHandler from "../middleware/asyncHandler.js";
import Slot from "../models/slotModel.js";
import SlotItem from "../models/slotItemModel.js";
import StoreSnapshot from "../models/storeSnapshotModel.js";

/* =========================
   GET /api/inventory/stores/:store/snapshot
   Private/Admin
   ========================= */
export const getStoreSnapshot = asyncHandler(async (req, res) => {
  const storeCode = String(req.params.store || "").trim();
  if (!storeCode) {
    res.status(400);
    throw new Error("Store code is required in the route parameter.");
  }

  const snapshot = await StoreSnapshot.findOne({ store: storeCode }).lean();

  res.status(200).json({
    success: true,
    message: snapshot
      ? "Store snapshot retrieved successfully."
      : "No snapshot found for this store.",
    data: snapshot || {},
  });
});

/* =========================
   POST /api/inventory/stores/:store/snapshot/rebuild
   Private/Admin
   Notes:
     - Derives occupiedCbm from SlotItem (sum per slot).
     - Uses Slot.cbm as capacity.
     - Aggregates to unit & store totals.
   ========================= */
export const rebuildStoreSnapshot = asyncHandler(async (req, res) => {
  const storeCode = String(req.params.store || "").trim();
  if (!storeCode) {
    res.status(400);
    throw new Error("Store code is required in the route parameter.");
  }

  // 1) Load all slots for this store
  const slots = await Slot.find({ store: storeCode })
    .select("_id unit position label cbm")
    .lean();

  if (!slots.length) {
    // Ensure we clear any old snapshot if store has no slots
    const cleared = await StoreSnapshot.findOneAndUpdate(
      { store: storeCode },
      {
        store: storeCode,
        units: {},
        totals: {
          capacityCbm: 0,
          occupiedCbm: 0,
          freeCbm: 0,
          nUnits: 0,
          nSlots: 0,
          nSlotItems: 0,
        },
        generatedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    return res.status(200).json({
      success: true,
      message: "Snapshot rebuilt (store has no slots).",
      data: cleared,
    });
  }

  // 2) Occupied per slot = sum of SlotItem.cbm
  const slotIds = slots.map((s) => s._id);
  const occRows = await SlotItem.aggregate([
    { $match: { slot: { $in: slotIds } } },
    { $group: { _id: "$slot", occupiedCbm: { $sum: "$cbm" }, nItems: { $sum: 1 } } },
  ]);

  const occBySlot = new Map(occRows.map((r) => [String(r._id), r.occupiedCbm || 0]));
  const nItemsTotal = occRows.reduce((a, r) => a + (r.nItems || 0), 0);

  // 3) Build per-unit summaries
  const unitsMap = new Map(); // unit -> { capacityCbm, occupiedCbm, freeCbm, slotsByLabel, slotsOrdered }

  for (const s of slots) {
    const unitKey = s.unit;
    if (!unitsMap.has(unitKey)) {
      unitsMap.set(unitKey, {
        capacityCbm: 0,
        occupiedCbm: 0,
        freeCbm: 0,
        slotsByLabel: new Map(),
        slotsOrdered: [],
      });
    }

    const occupied = occBySlot.get(String(s._id)) || 0;
    const capacity = Number(s.cbm || 0);
    const free = Math.max(capacity - occupied, 0);

    const slotSummary = {
      slotId: s._id,
      label: s.label,
      capacityCbm: capacity,
      occupiedCbm: occupied,
      freeCbm: free,
    };

    const u = unitsMap.get(unitKey);
    u.capacityCbm += capacity;
    u.occupiedCbm += occupied;
    u.freeCbm += free;
    u.slotsByLabel.set(s.label, slotSummary);
    u.slotsOrdered.push(slotSummary);
  }

  // 4) Totals & sort slots within each unit
  const totals = {
    capacityCbm: 0,
    occupiedCbm: 0,
    freeCbm: 0,
    nUnits: unitsMap.size,
    nSlots: slots.length,
    nSlotItems: nItemsTotal,
  };

  for (const u of unitsMap.values()) {
    totals.capacityCbm += u.capacityCbm;
    totals.occupiedCbm += u.occupiedCbm;
    totals.freeCbm += u.freeCbm;

    u.slotsOrdered.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true })
    );
  }

  // 5) Convert Maps -> plain objects for Mongo
  const unitsPlain = {};
  for (const [unitKey, u] of unitsMap.entries()) {
    const slotsByLabelPlain = {};
    for (const [lbl, sv] of u.slotsByLabel.entries()) slotsByLabelPlain[lbl] = sv;

    unitsPlain[unitKey] = {
      capacityCbm: u.capacityCbm,
      occupiedCbm: u.occupiedCbm,
      freeCbm: u.freeCbm,
      slotsByLabel: slotsByLabelPlain,
      slotsOrdered: u.slotsOrdered,
    };
  }

  // 6) Upsert snapshot (single document per store)
  const snapshot = await StoreSnapshot.findOneAndUpdate(
    { store: storeCode },
    { store: storeCode, units: unitsPlain, totals, generatedAt: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  res.status(200).json({
    success: true,
    message: "Store snapshot rebuilt successfully.",
    data: snapshot,
  });
});
