const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { userHasPermission } = require("../middleware/auth");
const { assignedWarehouseFilter, canAccessWarehouse } = require("../helpers/access");

const warehouseTradingEntrySchema = new mongoose.Schema(
  {
    date: String,
    warehouse_id: mongoose.Schema.Types.Mixed,
    farmer_id: mongoose.Schema.Types.Mixed,
    product_id: mongoose.Schema.Types.Mixed,
    transaction_type: String,
    quantity: Number,
    amount: Number,
    description: String,
  },
  {
    timestamps: true,
    collection: "warehouse_trading_entries",
  }
);

const WarehouseTradingEntry =
  mongoose.models.WarehouseTradingEntry ||
  mongoose.model("WarehouseTradingEntry", warehouseTradingEntrySchema);

function getVoucherPrefix(type) {
  return {
    purchase: "PUR",
    sale: "SAL",
    payment: "PAY",
    receipt: "REC",
    journal: "JRN",
  }[String(type || "").toLowerCase()];
}

async function nextMongoVoucherNo(type) {
  const normalizedType = String(type || "").toLowerCase();
  const shortPrefix = getVoucherPrefix(normalizedType);
  const collectionName = {
    purchase: "purchasevouchers",
    sale: "salevouchers",
    payment: "paymentvouchers_native",
    receipt: "receiptvouchers",
    journal: "wh_journal_vouchers",
  }[normalizedType];

  if (!shortPrefix || !collectionName) {
    throw new Error(`Unsupported voucher type: ${type}`);
  }
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    throw new Error("MongoDB connection is not available");
  }

  const rows = await mongoose.connection.db
    .collection(collectionName)
    .find(
      {
        $or: [
          { voucher_no: { $regex: `^${shortPrefix}-` } },
          { "data.voucher_no": { $regex: `^${shortPrefix}-` } },
        ],
      },
      { projection: { voucher_no: 1, "data.voucher_no": 1 } }
    )
    .toArray();

  let next = 1;
  for (const row of rows) {
    const voucher = row?.voucher_no || row?.data?.voucher_no || "";
    const number = Number(String(voucher).split("-").pop());
    if (Number.isFinite(number) && number >= next) next = number + 1;
  }

  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${shortPrefix}-${datePart}-${String(next).padStart(4, "0")}`;
}

function canManageWarehouseTrading(user) {
  return userHasPermission(user, "warehouse.trading.manage");
}

function canViewWarehouseTrading(user) {
  return (
    userHasPermission(user, "warehouse.trading.view") ||
    canManageWarehouseTrading(user) ||
    userHasPermission(user, "warehouse.trading.purchase.view") ||
    userHasPermission(user, "warehouse.trading.purchase.create") ||
    userHasPermission(user, "warehouse.trading.purchase.edit") ||
    userHasPermission(user, "warehouse.trading.purchase.delete") ||
    userHasPermission(user, "warehouse.trading.sale.view") ||
    userHasPermission(user, "warehouse.trading.sale.create") ||
    userHasPermission(user, "warehouse.trading.sale.edit") ||
    userHasPermission(user, "warehouse.trading.sale.delete") ||
    userHasPermission(user, "warehouse.trading.payment.view") ||
    userHasPermission(user, "warehouse.trading.payment.create") ||
    userHasPermission(user, "warehouse.trading.payment.edit") ||
    userHasPermission(user, "warehouse.trading.payment.delete") ||
    userHasPermission(user, "warehouse.trading.receipt.view") ||
    userHasPermission(user, "warehouse.trading.receipt.create") ||
    userHasPermission(user, "warehouse.trading.receipt.edit") ||
    userHasPermission(user, "warehouse.trading.receipt.delete") ||
    userHasPermission(user, "warehouse.trading.journal.view") ||
    userHasPermission(user, "warehouse.trading.journal.create") ||
    userHasPermission(user, "warehouse.trading.journal.edit") ||
    userHasPermission(user, "warehouse.trading.journal.delete") ||
    userHasPermission(user, "warehouse.trading.report.sale") ||
    userHasPermission(user, "warehouse.trading.report.purchase") ||
    userHasPermission(user, "warehouse.trading.report.profitLoss")
  );
}

router.get("/next-voucher-no", async (req, res) => {
  if (!req.query.type) {
    return res.status(400).json({ error: "type query param is required" });
  }

  try {
    const voucher_no = await nextMongoVoucherNo(req.query.type);
    return res.json({ voucher_no });
  } catch (err) {
    console.error("Warehouse trading voucher number failed:", err);
    return res.status(err.message.startsWith("Unsupported") ? 400 : 503).json({
      error: err.message,
    });
  }
});

router.get("/", (req, res) => {
  if (!canViewWarehouseTrading(req.user)) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const filter = assignedWarehouseFilter(req.user, "warehouse_id");
  WarehouseTradingEntry.find({})
    .sort({ createdAt: -1 })
    .lean()
    .then((rows) => {
      const filtered = rows.filter((row) => {
        if (!filter.params.length) return true;
        return true;
      });
      res.json(filtered || []);
    })
    .catch((err) => {
      console.error(err);
      return res.status(500).json({ error: err.message });
    });
});

router.post("/", (req, res) => {
  if (!canManageWarehouseTrading(req.user)) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const {
    date,
    warehouse_id,
    farmer_id,
    product_id,
    transaction_type,
    quantity,
    amount,
    description,
  } = req.body;

  if (!date || !transaction_type || !warehouse_id) {
    return res.status(400).json({ error: "Date, Warehouse, and Transaction Type are required" });
  }

  if (!canAccessWarehouse(req.user, warehouse_id)) {
    return res.status(403).json({ error: "You do not have access to this warehouse" });
  }

  WarehouseTradingEntry.create({
    date,
    warehouse_id: warehouse_id || null,
    farmer_id: farmer_id || null,
    product_id: product_id || null,
    transaction_type,
    quantity: quantity || 0,
    amount: amount || 0,
    description: description || null,
  })
    .then((doc) => {
      res.json({ id: doc._id });
    })
    .catch((err) => {
      console.error(err);
      return res.status(500).json({ error: err.message });
    });
});

module.exports = router;
