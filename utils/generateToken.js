// utils/generateToken.js
import jwt from 'jsonwebtoken';

const generateToken = (res, userId) => {
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });

  const isProd = process.env.NODE_ENV === 'production';

  res.cookie('jwt', token, {
    httpOnly: true,
    secure: isProd,     // ✅ HTTPS only in production
    sameSite: 'lax',    // ✅ works for localhost + typical SPA flows
    path: '/',          // ✅ ensures consistent clearing
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
};

export default generateToken;
