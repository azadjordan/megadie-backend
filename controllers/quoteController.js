import asyncHandler from "../middleware/asyncHandler.js";
import Quote from "../models/quoteModel.js";
import sendEmail from "../utils/sendEmail.js";
import buildQuoteEmail from "../utils/quoteRequestEmail.js";
import fs from "fs/promises";
import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";

// Required to use __dirname with ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// @desc    Generate PDF version of a quote using Puppeteer and Tailwind template
// @route   GET /api/quotes/:id/pdf
// @access  Private/Admin
export const getQuotePDF = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id)
    .populate("user", "name email")
    .populate("requestedItems.product", "name");

  if (!quote) throw new Error("Quote not found");

  // Safely resolve template path regardless of environment
  const templatePath = path.join(__dirname, "../templates/quote.html");
  const template = await fs.readFile(templatePath, "utf8");

  const itemsHtml = quote.requestedItems
    .map(
      (item) =>
        `<tr>
          <td class="border p-2">${item.product?.name || "Unnamed Item"}</td>
          <td class="border p-2 text-right">${item.qty}</td>
          <td class="border p-2 text-right">${(item.qty * item.unitPrice).toFixed(2)}</td>
        </tr>`
    )
    .join("");

  const filledHtml = template
    .replace("{{quoteDate}}", new Date(quote.createdAt).toLocaleDateString())
    .replace("{{status}}", quote.status)
    .replace("{{userName}}", quote.user?.name || "Client")
    .replace("{{userEmail}}", quote.user?.email || "—")
    .replace("{{deliveryCharge}}", quote.deliveryCharge.toFixed(2))
    .replace("{{extraFee}}", quote.extraFee.toFixed(2))
    .replace("{{totalPrice}}", quote.totalPrice.toFixed(2))
    .replace("{{items}}", itemsHtml);

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Block unnecessary resources
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (["image", "stylesheet", "font"].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  await page.setContent(filledHtml, { waitUntil: "networkidle0" });

  const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
  await browser.close();

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=quote-${quote._id}.pdf`);
  res.end(pdfBuffer);
});


// @desc    Get logged-in user's own quotes
// @route   GET /api/quotes/my
// @access  Private
export const getMyQuotes = asyncHandler(async (req, res) => {
  const quotes = await Quote.find({ user: req.user._id })
    .populate("requestedItems.product", "name code size")
    .sort({ createdAt: -1 });

  const sanitizedQuotes = quotes.map((quote) => {
    const quoteObj = quote.toObject();

    if (quote.status === "Requested") {
      // Remove pricing info
      quoteObj.requestedItems = quoteObj.requestedItems.map((item) => ({
        product: item.product,
        qty: item.qty,
      }));

      quoteObj.deliveryCharge = undefined;
      quoteObj.extraFee = undefined;
      quoteObj.totalPrice = undefined;
    }

    return quoteObj;
  });

  res.json(sanitizedQuotes);
});

// @desc    Create a new quote (Client)
// @route   POST /api/quotes
// @access  Private
export const createQuote = asyncHandler(async (req, res) => {
  const { requestedItems, clientToAdminNote } = req.body;

  if (!requestedItems || requestedItems.length === 0) {
    res.status(400);
    throw new Error("No items in the quote.");
  }

  const quote = await Quote.create({
    user: req.user._id,
    requestedItems,
    clientToAdminNote,
    totalPrice: 0,
  });

  const populatedQuote = await quote.populate("requestedItems.product", "name");

  try {
    await sendEmail({
      to: ["azadkkurdi@gmail.com", "almomani95hu@gmail.com"],
      subject: "New Quote Request Received",
      html: buildQuoteEmail({ user: req.user, quote: populatedQuote }),
    });
  } catch (error) {
    console.error("❌ Failed to send email:", error);
  }

  res.status(201).json(quote);
});


// @desc    Get all quotes (Admin only) sorted from latest to oldest
// @route   GET /api/quotes/admin
// @access  Private/Admin
export const getQuotes = asyncHandler(async (req, res) => {
  const quotes = await Quote.find({})
    .populate("user", "name email")
    .populate("requestedItems.product", "name code size")
    .sort({ createdAt: -1 }); // 👈 Sort by creation date, newest first

  res.json(quotes);
});

// @desc    Get single quote by ID
// @route   GET /api/quotes/:id
// @access  Private/Admin or Owner
export const getQuoteById = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id)
    .populate("user", "name email")
    .populate("requestedItems.product", "name code size");

  if (quote) {
    // ✅ Allow user to access their own quote
    if (req.user.isAdmin || req.user._id.equals(quote.user._id)) {
      res.json(quote);
    } else {
      res.status(403);
      throw new Error("Not authorized to view this quote.");
    }
  } else {
    res.status(404);
    throw new Error("Quote not found.");
  }
});

// @desc    Update quote (Admin)
// @route   PUT /api/quotes/:id
// @access  Private/Admin
export const updateQuote = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id);

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  // Apply updates from request body (including status if admin changes it)
  Object.assign(quote, req.body);

  const updated = await quote.save();
  res.json(updated);
});

// @desc    Delete quote (Admin)
// @route   DELETE /api/quotes/:id
// @access  Private/Admin
export const deleteQuote = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id);

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  await quote.deleteOne();
  res.status(204).end();
});
