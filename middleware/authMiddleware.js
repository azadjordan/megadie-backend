import jwt from "jsonwebtoken";
import asyncHandler from "./asyncHandler.js";
import User from "../models/userModel.js";
import AdminSession from "../models/adminSessionModel.js";
import { getSessionExpiry, SessionExpiredError } from "../utils/sessionPolicy.js";

//////////////////// Protect Middleware:
// Protect routes (Only logged-in users can access)
const protect = asyncHandler(async (req, res, next) => {
    const token = req.cookies.jwt;
    if (!token) return res.status(401).json({ message: "Not authorized, no token found" });
    let decoded;
    try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
    catch { return res.status(401).json({ message: "Session expired or invalid. Please sign in again." }); }
    const user = await User.findById(decoded.userId).select("-password");
    if (!user) return res.status(401).json({ message: "Not authorized, user not found" });
    // A stale response must never clear a newer login's browser cookie.
    // Database/network failures propagate as server errors, not false logouts.
    const session = typeof decoded.sessionId === "string" && /^[a-f0-9]{64}$/.test(decoded.sessionId)
        ? await AdminSession.findOne({ _id: decoded.sessionId, user: user._id }).lean() : null;
    let expiresAt;
    try { expiresAt = getSessionExpiry(decoded, user, undefined, session); }
    catch (error) {
        if (!(error instanceof SessionExpiredError)) throw error;
        return res.status(401).json({ message: error.message });
    }
    if (expiresAt != null && expiresAt <= Math.floor(Date.now() / 1000)) return res.status(401).json({ message: "Session expired. Please sign in again." });
    req.user = user;
    req.jwtPayload = decoded;
    req.adminSession = session;
    req.sessionExpiresAt = expiresAt;
    next();
});

///////////////// Admin Middleware:
// Restricts access to admin-only routes
const admin = (req, res, next) => {
    if (req.user && req.user.isAdmin) {
        next();
    } else {
        res.status(403); // ✅ Use 403 Forbidden instead of 401
        throw new Error("Not authorized as admin");
    }
};

const requireApproved = (req, res, next) => {
    if (!req.user) {
        res.status(401);
        throw new Error("Not authorized");
    }

    if (req.user.isAdmin) return next();
    if (req.user.isWorker) {
        res.status(403);
        throw new Error("Worker accounts can access their assigned work only.");
    }

    const status = req.user.approvalStatus;
    if (!status || status === "Approved") return next();

    res.status(403);
    if (status === "Rejected") {
        throw new Error("Account rejected.");
    }
    throw new Error("Account pending approval.");
};

const staff = (req, res, next) => {
    if (req.user?.isAdmin || req.user?.isWorker) return next();
    res.status(403);
    throw new Error("Worker access is required.");
};

export { protect, admin, staff, requireApproved };
