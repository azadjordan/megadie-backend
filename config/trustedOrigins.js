export const trustedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "https://megadie-frontend.onrender.com",
  "https://megadie-frontend-v2.onrender.com",
  "https://www.megadie.com",
  "https://megadie.com",
  "https://api.megadie.com",
];

export function requireTrustedOrigin(req, res, next) {
  if (!trustedOrigins.includes(req.get("Origin"))) {
    return res.status(403).json({ message: "This session action must come from the website." });
  }
  next();
}
