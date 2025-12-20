//megadie-backend/middleware/errorMiddleware.js
const notFound = (req, res, next) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
};

const errorHandler = (err, req, res, next) => {
  // If a handler set a status already, use it; otherwise default to 500
  let statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  let message = err.message || "Server error";

  // Log (avoid sensitive info in production)
  const logPayload = {
    message,
    name: err.name,
    code: err.code,
    method: req.method,
    url: req.originalUrl,
  };
  if (process.env.NODE_ENV !== "production") {
    logPayload.errorStack = err.stack;
    logPayload.body = req.body;
  }
  console.error(logPayload);

  // ----- Mongoose / MongoDB standard cases -----

  // Duplicate key
  if (err && err.code === 11000) {
    statusCode = 409; // Conflict
    const fields = Object.keys(err.keyValue || {});
    message = fields.length
      ? `Duplicate value for: ${fields.join(", ")}`
      : "Duplicate key error";
    return res.status(statusCode).json({
      message,
      keyValue: err.keyValue,
      stack: process.env.NODE_ENV === "production" ? "PanCake" : err.stack,
    });
  }

  // CastError: invalid ObjectId / cast failure
  if (err?.name === "CastError") {
    statusCode = 400; // invalid input
    message = `Invalid ${err.path}`;
    return res.status(statusCode).json({
      message,
      value: err.value,
      stack: process.env.NODE_ENV === "production" ? "PanCake" : err.stack,
    });
  }

  // ValidationError: schema/hook invalidation
  if (err?.name === "ValidationError") {
    statusCode = 400;
    const errors = Object.values(err.errors || {}).map((e) => e.message);
    return res.status(statusCode).json({
      message: "Validation failed",
      errors,
      stack: process.env.NODE_ENV === "production" ? "PanCake" : err.stack,
    });
  }

  // JWT
  if (err?.name === "JsonWebTokenError") {
    statusCode = 401;
    message = "Invalid token";
  }
  if (err?.name === "TokenExpiredError") {
    statusCode = 401;
    message = "Token has expired";
  }

  // Fallback
  res.status(statusCode).json({
    message,
    stack: process.env.NODE_ENV === "production" ? "PanCake" : err.stack,
  });
};

export { notFound, errorHandler };
