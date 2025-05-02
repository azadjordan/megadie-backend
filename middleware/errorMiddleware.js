const notFound = (req, res, next) => {
    const error = new Error(`Not Found - ${req.originalUrl}`)
    res.status(404)
    next(error)
  }
  
  const errorHandler = (err, req, res, next) => {
    let statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    let message = err.message;
  
    if (err.name === 'CastError') {
        message = `Resource not found with id of ${err.value}`;
        statusCode = 404;
    }
  
    if (err.code === 11000) {
        message = 'Duplicate field value entered';
        statusCode = 400;
    }
  
    if (err.name === 'ValidationError') {
        message = 'Validation failed';
        const errors = Object.values(err.errors).map(e => e.message);
        return res.status(statusCode).json({ message, errors });
    }
  
    if (err.name === 'JsonWebTokenError') {
        message = 'Invalid token';
        statusCode = 401;
    }
  
    if (err.name === 'TokenExpiredError') {
        message = 'Token has expired';
        statusCode = 401;
    }
  
    // ... any other error types you want to handle
  
    res.status(statusCode).json({
        message,
        stack: process.env.NODE_ENV === "production" ? "PanCake" : err.stack,
    });
  }
  
  
  
  export { notFound, errorHandler }
  