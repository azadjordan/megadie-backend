import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";

// ✅ Use import.meta.url to get the directory in ES modules
const __dirname = path.dirname(new URL(import.meta.url).pathname);

// ✅ Load correct .env file based on NODE_ENV
const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : ".env.development";
dotenv.config();
dotenv.config({ path: envFile, override: true });

// ✅ Import routes and middlewares
import connectDB from "./config/db.js";
import productRoutes from "./routes/productRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import categoryRoutes from "./routes/categoryRoutes.js";
import quoteRoutes from "./routes/quoteRoutes.js";
import invoiceRoutes from "./routes/invoiceRoutes.js";
import contactRoutes from "./routes/contactRoutes.js";
import filterConfigRoutes from "./routes/filterConfigRoutes.js";
import slotRoutes from "./routes/slotRoutes.js";
import slotItemRoutes from "./routes/slotItemRoutes.js";
import inventoryRoutes from "./routes/inventoryRoutes.js";
import userPriceRoutes from "./routes/userPriceRoutes.js";
import priceRuleRoutes from "./routes/priceRuleRoutes.js";
import { notFound, errorHandler } from "./middleware/errorMiddleware.js";

// ✅ Initialize and connect to DB
connectDB();

const app = express();
const port = process.env.PORT || 5000;

// ✅ Fix CORS to allow cookies
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5174",
  "https://megadie-frontend.onrender.com",
  "https://megadie-frontend-v2.onrender.com",
  "https://www.megadie.com", // if you’re using the custom domain
  "https://megadie.com",
  "https://api.megadie.com",
];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true, // Allow cookies
  })
);

// ✅ Middleware for JSON, form data & cookies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ✅ Log requests only in development
// ✅ Log requests only in development (full URL)
if (process.env.NODE_ENV !== "production") {
  app.use((req, res, next) => {
    const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    console.log(`URL: [${fullUrl}]      METHOD: [${req.method}]`);
    next();
  });
}


// ✅ Root endpoint
app.get("/", (req, res) => {
  res.send("API is running...");
});

// ✅ API Routes
app.use("/api/products", productRoutes);
app.use("/api/users", userRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/quotes", quoteRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/filter-configs", filterConfigRoutes);
app.use("/api/slots", slotRoutes);
app.use("/api/slot-items", slotItemRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/user-prices", userPriceRoutes);
app.use("/api/price-rules", priceRuleRoutes);

// ✅ Error Handling
app.use(notFound);
app.use(errorHandler);

// ✅ Start server
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
