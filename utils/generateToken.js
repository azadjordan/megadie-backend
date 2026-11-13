import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import AdminSession from "../models/adminSessionModel.js";
import { ADMIN_SESSION_SECONDS, ADMIN_IDLE_SECONDS, CUSTOMER_SESSION_SECONDS, sessionCookieOptions, sessionMetadata, isStaff } from "./sessionPolicy.js";

// Always pass the authenticated database user, including for password-reset sign-in.
const generateToken = async (res, user) => {
  const duration = isStaff(user) ? ADMIN_SESSION_SECONDS : CUSTOMER_SESSION_SECONDS;
  const issuedAt = Math.floor(Date.now() / 1000);
  const session = isStaff(user) ? await AdminSession.create({
    _id: crypto.randomBytes(32).toString("hex"), user: user._id,
    startedAt: new Date(issuedAt * 1000), lastActivityAt: new Date(issuedAt * 1000),
    idleExpiresAt: new Date((issuedAt + ADMIN_IDLE_SECONDS) * 1000),
    absoluteExpiresAt: new Date((issuedAt + ADMIN_SESSION_SECONDS) * 1000),
  }) : null;
  const token = jwt.sign({ userId: user._id, iat: issuedAt, ...(session ? { sessionId: session._id } : {}) }, process.env.JWT_SECRET, {
    expiresIn: duration,
  });
  res.cookie("jwt", token, {
    ...sessionCookieOptions(),
    maxAge: duration * 1000,
  });
  res.set?.("Cache-Control", "no-store");
  return sessionMetadata(issuedAt + (session ? ADMIN_IDLE_SECONDS : duration), session);
};

export default generateToken;
