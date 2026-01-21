//megadie-backend/middleware/asyncHandler.js
const asyncHandler = fn => (reg, res, next) => {
    Promise.resolve(fn(reg, res, next)).catch(next)
    }
    export default asyncHandler 