import express from "express";
import { protect, admin, staff } from "../middleware/authMiddleware.js";
import { requireTrustedOrigin } from "../config/trustedOrigins.js";
import { listPackingWorkers, listPackingOrders, readPackingOrder, publishPackingOrder, updatePackingOrder, checkPackingStockReport, removePackingAssignment } from "../controllers/packingController.js";

const router = express.Router();
router.use(protect, staff);
router.get("/workers", admin, listPackingWorkers);
router.get("/orders", listPackingOrders);
router.get("/orders/:id", readPackingOrder);
router.post("/orders/:id/send", requireTrustedOrigin, admin, publishPackingOrder);
router.post('/orders/:id/unassign', requireTrustedOrigin, admin, removePackingAssignment);
router.patch('/orders/:id/reports/:reportId', requireTrustedOrigin, admin, checkPackingStockReport);
router.post("/orders/:id/:action(pick|problem|help|correct|replace|packed|reopen)", requireTrustedOrigin, updatePackingOrder);
export default router;
