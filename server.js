require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Needed on Render/Railway/etc. so rate limiting sees each customer's real IP.
app.set("trust proxy", 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.static("public"));

// Fixed catalog: the server decides the price, never the customer.
const PRODUCTS = {
  "MARU HUB KEY": { php: "₱380", usd: "$7.99" },
  "BANANA HUB": { php: "₱380", usd: "$7.99" }
};
const PAYMENT_METHODS = ["GCash", "Maya", "GoTyme", "PayPal"];

const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { ok: false, error: "Too many order attempts. Please try again later." }
});

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      return cb(new Error("INVALID_FILE_TYPE"));
    }
    cb(null, true);
  }
});

// Check the real file signature, not just the type the browser claims.
function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

// Backup log so an order is never lost if Discord is down.
const ORDERS_FILE = path.join(process.env.ORDERS_DIR || __dirname, "orders.log");
function logOrder(entry) {
  try {
    fs.appendFileSync(ORDERS_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("Could not write orders.log:", err.message);
  }
}

// Trim FIRST, then fall back, so whitespace-only input never becomes an empty embed field.
const clean = (value, max = 500) => {
  const text = typeof value === "string" ? value.trim().slice(0, max) : "";
  return text || "Not provided";
};

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/orders", orderLimiter, upload.single("receipt"), async (req, res) => {
  try {
    if (!WEBHOOK_URL || !WEBHOOK_URL.startsWith("https://discord.com/api/webhooks/")) {
      return res.status(500).json({ ok: false, error: "Server webhook is not configured." });
    }

    const { customerName, contact, product, paymentMethod, reference, notes } = req.body;
    if (![customerName, contact, product, paymentMethod].every(v => typeof v === "string" && v.trim())) {
      return res.status(400).json({ ok: false, error: "Please complete the required order fields." });
    }
    if (!Object.prototype.hasOwnProperty.call(PRODUCTS, product)) {
      return res.status(400).json({ ok: false, error: "Please choose a valid product." });
    }
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ ok: false, error: "Please choose a valid payment method." });
    }

    if (req.file && detectImageType(req.file.buffer) !== req.file.mimetype) {
      return res.status(400).json({ ok: false, error: "The receipt must be a real JPG, PNG, or WEBP image." });
    }

    const price = PRODUCTS[product];
    const amount = paymentMethod === "PayPal" ? price.usd : price.php;
    const orderId = "SLIME-" + crypto.randomBytes(3).toString("hex").toUpperCase();

    const entry = {
      orderId,
      time: new Date().toISOString(),
      customer: clean(customerName, 100),
      contact: clean(contact, 100),
      product,
      amount,
      paymentMethod,
      reference: clean(reference, 150),
      notes: clean(notes),
      hasReceipt: Boolean(req.file)
    };
    logOrder(entry);

    const embed = {
      title: `🟢 New SLIME STORE Order — ${orderId}`,
      color: 0x7CFC00,
      fields: [
        { name: "Customer", value: entry.customer, inline: true },
        { name: "Contact", value: entry.contact, inline: true },
        { name: "Product", value: product, inline: false },
        { name: "Amount to verify", value: amount, inline: true },
        { name: "Payment Method", value: paymentMethod, inline: true },
        { name: "Reference", value: entry.reference, inline: false },
        { name: "Notes", value: entry.notes, inline: false },
        { name: "Status", value: "PENDING — verify payment manually before delivering any key.", inline: false }
      ],
      timestamp: entry.time
    };

    const form = new FormData();
    // allowed_mentions: [] stops customers from pinging @everyone / roles through their input.
    form.append("payload_json", JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }));

    if (req.file) {
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[req.file.mimetype];
      const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
      form.append("files[0]", blob, `${orderId}-receipt.${ext}`);
    }

    const response = await fetch(WEBHOOK_URL, { method: "POST", body: form });
    if (!response.ok) {
      console.error("Discord webhook returned", response.status, "for", orderId);
      // The order is saved in orders.log, so tell the customer it was received.
      return res.status(202).json({
        ok: true,
        message: `Order ${orderId} received. Payment is still pending verification. Please message the seller on Discord with this order ID.`
      });
    }

    res.json({
      ok: true,
      message: `Order ${orderId} submitted. Payment is still pending verification. Keep this order ID.`
    });
  } catch (error) {
    console.error("Order error:", error.message);
    res.status(500).json({ ok: false, error: "Something went wrong while submitting the order." });
  }
});

// Always answer upload errors with JSON (the frontend calls response.json()).
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE"
      ? "Receipt image is too large (max 5 MB)."
      : "Invalid receipt upload.";
    return res.status(400).json({ ok: false, error: msg });
  }
  if (err && err.message === "INVALID_FILE_TYPE") {
    return res.status(400).json({ ok: false, error: "Receipt must be a JPG, PNG, or WEBP image." });
  }
  console.error("Unhandled error:", err && err.message);
  res.status(500).json({ ok: false, error: "Something went wrong." });
});

app.listen(PORT, () => {
  console.log(`SLIME STORE server running on port ${PORT}`);
});
