import jwt from "jsonwebtoken";
import asyncHandler from "./asyncHandler.js";
import User from "../models/userModel.js";
import { getSessionExpiry, sessionCookieOptions } from "../utils/sessionPolicy.js";

//////////////////// Protect Middleware:
// Protect routes (Only logged-in users can access)
const protect = asyncHandler(async (req, res, next) => {
    let token = req.cookies.jwt;

    if (token) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const user = await User.findById(decoded.userId).select("-password");
            if (!user) {
                res.status(401);
                throw new Error("Not authorized, user not found");
            }
            const expiresAt = getSessionExpiry(decoded, user);
            if (expiresAt != null && expiresAt <= Math.floor(Date.now() / 1000)) {
                throw new Error("Session expired. Please sign in again.");
            }
            req.user = user;
            req.sessionExpiresAt = expiresAt;
            next();
        } catch (error) {
            console.error("JWT Verification Failed:", error.message); // ✅ Log token errors
            res.clearCookie("jwt", sessionCookieOptions());
            res.status(401);
            throw new Error("Session expired or invalid. Please sign in again.");
        }
    } else {
        res.status(401);
        throw new Error("Not authorized, no token found");
    }
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

    const status = req.user.approvalStatus;
    if (!status || status === "Approved") return next();

    res.status(403);
    if (status === "Rejected") {
        throw new Error("Account rejected.");
    }
    throw new Error("Account pending approval.");
};

export { protect, admin, requireApproved };
