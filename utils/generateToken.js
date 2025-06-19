import jwt from 'jsonwebtoken';

const generateToken = (res, userId) => {
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });

  const isLocalhost = process.env.NODE_ENV !== 'production';

  res.cookie('jwt', token, {
    httpOnly: true,
    secure: !isLocalhost, // only true on live (HTTPS)
    sameSite: isLocalhost ? 'Lax' : 'None', // avoid iOS issues
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
};

export default generateToken;
