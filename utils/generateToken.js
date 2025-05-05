import jwt from 'jsonwebtoken';

const generateToken = (res, userId) => {
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });

  res.cookie('jwt', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // ✅ HTTPS only in production
    sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax', // ✅ Allow cross-site cookies on Render
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
};

export default generateToken;
