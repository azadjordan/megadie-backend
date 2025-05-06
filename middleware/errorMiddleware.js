const notFound = (req, res, next) => {
    const error = new Error(`Not Found - ${req.originalUrl}`);
    res.status(404);
    next(error);
};

const errorHandler = (err, req, res, next) => {
    let statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    let message = err.message;

    // Log the error details to the console for debugging
    console.error({
        message: message,
        errorStack: err.stack,
        method: req.method,
        url: req.originalUrl,
        body: req.body, // Optional: Log request body for context (avoid logging sensitive info)
    });

    // Specific error handling based on error type
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

    // Any other error types you want to handle can be added here

    // Send the error response to the client
    res.status(statusCode).json({
        message,
        stack: process.env.NODE_ENV === "production" ? "PanCake" : err.stack,
    });
};

export { notFound, errorHandler };
