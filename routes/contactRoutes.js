import express from "express";
import { handleContact } from "../controllers/contactController.js";

const router = express.Router();

// ✅ Public contact form submission
router.post("/", handleContact);

export default router;
