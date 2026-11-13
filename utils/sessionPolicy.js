export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
export const ADMIN_IDLE_SECONDS = 30 * 60;
export const CUSTOMER_SESSION_SECONDS = 30 * 24 * 60 * 60;
export const isStaff = (user) => Boolean(user?.isAdmin || user?.isWorker);

export const sessionCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  path: "/",
});

export class SessionExpiredError extends Error {}

export function getSessionExpiry(payload, user, nowSeconds = Math.floor(Date.now() / 1000), session = null) {
  if (!isStaff(user) && !payload.sessionId) return Number.isFinite(payload.exp) ? payload.exp : null;
  if (!isStaff(user) || !session || session.revokedAt || typeof payload.sessionId !== "string" || payload.sessionId !== session._id || String(session.user) !== String(user._id)) {
    throw new SessionExpiredError("Staff session is missing or revoked. Please sign in again.");
  }
  if (!Number.isInteger(payload.iat) || payload.iat <= 0 || payload.iat > nowSeconds) {
    throw new SessionExpiredError("Invalid admin session login time.");
  }
  const idle = new Date(session.idleExpiresAt).getTime() / 1000;
  const absolute = new Date(session.absoluteExpiresAt).getTime() / 1000;
  if (![idle, absolute, payload.exp].every(Number.isFinite) || new Date(session.startedAt).getTime() !== payload.iat * 1000) {
    throw new SessionExpiredError("Invalid admin session deadlines.");
  }
  return Math.floor(Math.min(idle, absolute, payload.iat + ADMIN_SESSION_SECONDS, payload.exp));
}

export const sessionMetadata = (expiresAt, session = null) => ({
  sessionExpiresAt: expiresAt == null ? null : expiresAt * 1000,
  sessionServerTime: Date.now(),
  ...(session ? { sessionId: session._id, sessionAbsoluteExpiresAt: new Date(session.absoluteExpiresAt).getTime() } : {}),
});
