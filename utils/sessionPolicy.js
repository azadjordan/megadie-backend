// Admin sessions have an absolute deadline. API activity never renews it.
export const ADMIN_SESSION_SECONDS = 20 * 60;
export const CUSTOMER_SESSION_SECONDS = 30 * 24 * 60 * 60;

export const sessionCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  path: "/",
});

export function getSessionExpiry(payload, user, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!user.isAdmin) return Number.isFinite(payload.exp) ? payload.exp : null;
  // Read the current role from the database, never from a client-supplied role.
  // The cap also applies to pre-release 30-day tokens and newly promoted admins.
  if (!Number.isInteger(payload.iat) || payload.iat <= 0 || payload.iat > nowSeconds) {
    throw new Error("Invalid admin session login time.");
  }
  return Math.min(payload.iat + ADMIN_SESSION_SECONDS, payload.exp ?? Infinity);
}

export const sessionMetadata = (expiresAt) => ({
  sessionExpiresAt: expiresAt == null ? null : expiresAt * 1000,
  sessionServerTime: Date.now(),
});
