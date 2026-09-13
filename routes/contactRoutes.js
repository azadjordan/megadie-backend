import express from "express";
import { handleContact } from "../controllers/contactController.js";
import {
  blockHoneypotSubmission,
  rateLimit,
} from "../middleware/abuseProtectionMiddleware.js";

const router = express.Router();

// ✅ Public contact form submission
router.post(
  "/",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyPrefix: "contact" }),
  blockHoneypotSubmission(["companyWebsite", "website"]),
  handleContact
);

export default router;
