import asyncHandler from "../middleware/asyncHandler.js";
import AdminSession from "../models/adminSessionModel.js";
import { ADMIN_IDLE_SECONDS, getSessionExpiry, sessionMetadata } from "../utils/sessionPolicy.js";

export const reportAdminActivity = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (req.body?.sessionId !== req.adminSession._id) {
    return res.status(409).json({ code: "SESSION_CHANGED", message: "The signed-in session changed. Check the current session." });
  }
  const now = new Date(Date.now());
  const absolute = Math.min(new Date(req.adminSession.absoluteExpiresAt).getTime(), req.jwtPayload.exp * 1000);
  const session = await AdminSession.findOneAndUpdate({
    _id: req.adminSession._id, user: req.user._id, revokedAt: null,
    idleExpiresAt: { $gt: now }, absoluteExpiresAt: { $gt: now },
  }, {
    $max: { lastActivityAt: now, idleExpiresAt: new Date(Math.min(now.getTime() + ADMIN_IDLE_SECONDS * 1000, absolute)) },
  }, { new: true }).lean();
  if (!session) return res.status(401).json({ message: "Session expired. Please sign in again." });
  res.json({ data: sessionMetadata(getSessionExpiry(req.jwtPayload, req.user, Math.floor(now.getTime() / 1000), session), session) });
});
