function getClientKey(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function rateLimit({ windowMs, max, keyPrefix = "default" }) {
  const hits = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = `${keyPrefix}:${getClientKey(req)}`;
    const record = hits.get(key);

    if (!record || record.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    record.count += 1;
    if (record.count > max) {
      res.status(429);
      throw new Error("Too many requests. Please try again later.");
    }

    return next();
  };
}

export function blockHoneypotSubmission(fields = []) {
  return (req, res, next) => {
    const body = req.body || {};
    const hasFilledTrap = fields.some((field) =>
      String(body[field] || "").trim()
    );

    if (hasFilledTrap) {
      res.status(400);
      throw new Error("Invalid submission.");
    }

    next();
  };
}
