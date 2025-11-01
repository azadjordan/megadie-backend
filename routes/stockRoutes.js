import express from "express";
import { protect, admin } from "../middleware/authMiddleware.js";
import { autosuggestPicks, applyPicks, reversePicks } from "../controllers/stockController.js";

const router = express.Router();

router.get("/:orderId/autosuggest",  protect, admin, autosuggestPicks);
router.post("/:orderId/apply",       protect, admin, applyPicks);
router.post("/:orderId/reverse",     protect, admin, reversePicks);

export default router;
