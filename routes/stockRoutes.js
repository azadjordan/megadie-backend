// routes/stockRoutes.js
import express from "express";
import {
  getOrderPicklist,
  applyDeliveryPicks,
  reverseDeliveryToSlots,
} from "../controllers/stockController.js";

const router = express.Router();

router.get("/orders/:orderId/picklist", getOrderPicklist);
router.post("/orders/:orderId/deliver-apply", applyDeliveryPicks);
router.post("/orders/:orderId/deliver-reverse", reverseDeliveryToSlots);

export default router;
