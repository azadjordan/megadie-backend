import jwt from "jsonwebtoken";
import { ADMIN_SESSION_SECONDS, CUSTOMER_SESSION_SECONDS, sessionCookieOptions, sessionMetadata } from "./sessionPolicy.js";

// Always pass the authenticated database user, including for password-reset sign-in.
const generateToken = (res, user) => {
  const duration = user.isAdmin ? ADMIN_SESSION_SECONDS : CUSTOMER_SESSION_SECONDS;
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = jwt.sign({ userId: user._id, iat: issuedAt }, process.env.JWT_SECRET, {
    expiresIn: duration,
  });
  res.cookie("jwt", token, {
    ...sessionCookieOptions(),
    maxAge: duration * 1000,
  });
  return sessionMetadata(issuedAt + duration);
};

export default generateToken;
