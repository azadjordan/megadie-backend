import jwt from 'jsonwebtoken';

const generateToken = (res, userId) => {
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });

  res.cookie('jwt', token, {
    httpOnly: true,
    secure: true,            // ✅ Must be HTTPS
    sameSite: 'Strict',      // ✅ Or 'Lax' if you want login to work from external links
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
};

export default generateToken;
