const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { userHasPermission } = require("../middleware/auth");
const { assignedWarehouseFilter, canAccessWarehouse } = require("../helpers/access");
const { WarehouseRentBooking } = require("../mongo");
const { CashEntry } = require("../db-mongodb");
const XLSX = require("xlsx");

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

const warehouseTradingProfitLossAdjustmentSchema = new mongoose.Schema(
  {
    date: { type: String, required: true },
    warehouse_id: { type: String, required: true },
    warehouse_name: { type: String, default: "" },
    entry_type: { type: String, enum: ["income", "expense"], required: true },
    amount: { type: Number, required: true },
    description: { type: String, default: "" },
    created_by: { type: String, default: "" },
  },
  { timestamps: true, collection: "warehouse_trading_profit_loss_adjustments" }
);

const WarehouseTradingProfitLossAdjustment =
  mongoose.models.WarehouseTradingProfitLossAdjustment ||
  mongoose.model("WarehouseTradingProfitLossAdjustment", warehouseTradingProfitLossAdjustmentSchema);

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

function canViewWarehouseTradingProfitLoss(user) {
  return userHasPermission(user, "warehouse.trading.report.profitLoss");
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function inDateRange(value, fromDate, toDate) {
  const date = normalizeText(value).slice(0, 10);
  return Boolean(date) && (!fromDate || date >= fromDate) && (!toDate || date <= toDate);
}

function getUserLabel(user) {
  return normalizeText(user?.name || user?.employee_name || user?.username || user?.email);
}

router.get("/profit-loss-overheads", async (req, res) => {
  if (!canViewWarehouseTradingProfitLoss(req.user)) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    const fromDate = normalizeText(req.query.from_date);
    const toDate = normalizeText(req.query.to_date);
    const expenseCollection = mongoose.connection.db.collection("expenses");
    const expenseRows = await expenseCollection.find({}).toArray();
    const expenses = expenseRows
      .filter((row) => {
        const warehouseId = normalizeText(row.warehouse_id);
        const date = row.expense_date || row.date;
        return warehouseId && canAccessWarehouse(req.user, warehouseId) && inDateRange(date, fromDate, toDate);
      })
      .map((row) => ({
        id: String(row._id || row.id || row.legacy_id || ""),
        date: normalizeText(row.expense_date || row.date).slice(0, 10),
        warehouse_id: normalizeText(row.warehouse_id),
        employee_name: normalizeText(row.employee_name || row.employee?.name || row.employee_id) || "Staff",
        description: normalizeText(row.work_description || row.narration || row.voucher_no),
        amount: Number(row.total_expense_amount ?? row.grand_total ?? row.amount ?? 0) || 0,
      }))
      .filter((row) => row.amount > 0);

    const allocatedCashRows = await CashEntry.find({
      allocate_warehouse_pl: true,
      entry_type: "expense",
      source_expense_id: { $in: [null, ""] },
      status: { $nin: ["pending", "cancelled", "canceled", "void", "deleted"] },
    }).lean();
    (allocatedCashRows || []).forEach((row) => {
      const warehouseId = normalizeText(row.warehouse_id);
      const date = row.entry_date instanceof Date ? row.entry_date.toISOString().slice(0, 10) : normalizeText(row.entry_date).slice(0, 10);
      const amount = Number(row.amount || 0);
      if (!warehouseId || !canAccessWarehouse(req.user, warehouseId) || !inDateRange(date, fromDate, toDate) || amount <= 0) return;
      expenses.push({
        id: String(row.id || row._id || ""),
        date,
        warehouse_id: warehouseId,
        employee_name: normalizeText(row.employee_name) || "Cash Book Expense",
        description: normalizeText(row.description || row.narration || row.voucher_no) || "Cash Book Expense",
        amount,
        source_type: "cashbook",
      });
    });

    const rentBookings = await WarehouseRentBooking.find({}).populate("warehouse_id", "name").lean();
    const rents = (rentBookings || [])
      .filter((row) => {
        const warehouseId = normalizeText(row.warehouse_id?._id || row.warehouse_id);
        const rentMonth = normalizeText(row.rent_month || row.booking_date).slice(0, 7);
        const fromMonth = fromDate.slice(0, 7);
        const toMonth = toDate.slice(0, 7);
        return row.rent_flow !== "receivable" && warehouseId && canAccessWarehouse(req.user, warehouseId)
          && (!fromMonth || rentMonth >= fromMonth) && (!toMonth || rentMonth <= toMonth);
      })
      .map((row) => ({
        id: String(row._id || ""),
        date: normalizeText(row.rent_month || row.booking_date),
        rent_month: normalizeText(row.rent_month),
        booking_date: normalizeText(row.booking_date),
        remarks: normalizeText(row.remarks),
        warehouse_id: normalizeText(row.warehouse_id?._id || row.warehouse_id),
        warehouse_name: normalizeText(row.warehouse_id?.name),
        description: normalizeText(row.booking_no || row.remarks) || "Warehouse rent",
        amount: Number(row.monthly_rent || 0),
      }))
      .filter((row) => row.amount > 0);

    const adjustmentFilter = {};
    if (fromDate || toDate) {
      adjustmentFilter.date = {};
      if (fromDate) adjustmentFilter.date.$gte = fromDate;
      if (toDate) adjustmentFilter.date.$lte = toDate;
    }
    const adjustmentRows = await WarehouseTradingProfitLossAdjustment.find(adjustmentFilter).sort({ date: -1, createdAt: -1 }).lean();
    const adjustments = (adjustmentRows || [])
      .filter((row) => canAccessWarehouse(req.user, row.warehouse_id))
      .map((row) => ({ ...row, id: String(row._id), warehouse_id: normalizeText(row.warehouse_id) }));

    const payload = { expenses, rents, adjustments };
    if (String(req.query.export || "").trim().toLowerCase() === "xlsx") {
      const type = String(req.query.type || "").trim().toLowerCase();
      const source = type === "expenses" ? expenses : type === "rents" ? rents : type === "adjustments" ? adjustments : null;
      if (!source) return res.status(400).json({ error: "A valid overhead type is required for export" });
      const warehouseId = normalizeText(req.query.warehouse_id);
      const entryType = normalizeText(req.query.entry_type).toLowerCase();
      const filteredSource = source.filter((row) =>
        (!warehouseId || String(row.warehouse_id || "") === warehouseId) &&
        (type !== "adjustments" || !entryType || row.entry_type === entryType)
      );
      const rows = filteredSource.map((row) => ({
        Date: row.date || "",
        Warehouse: row.warehouse_name || "",
        Particulars: row.description || row.employee_name || "",
        ...(type === "adjustments" ? { Type: row.entry_type === "income" ? "Add" : "Less" } : {}),
        Amount: Number(row.amount || 0),
      }));
      rows.push({ Date: "TOTAL", Amount: Number(filteredSource.reduce((sum, row) => sum + Number(row.amount || 0), 0).toFixed(2)) });
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), type);
      const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="profit_loss_${type}_details.xlsx"`);
      return res.end(buffer);
    }
    return res.json(payload);
  } catch (error) {
    console.error("Warehouse trading profit/loss overhead load failed:", error);
    return res.status(500).json({ error: error.message || "Failed to load warehouse expenses" });
  }
});

router.post("/profit-loss-adjustments", async (req, res) => {
  if (!canManageWarehouseTrading(req.user)) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const date = normalizeText(req.body?.date);
  const warehouseId = normalizeText(req.body?.warehouse_id);
  const entryType = normalizeText(req.body?.entry_type).toLowerCase();
  const amount = Number(req.body?.amount);
  const description = normalizeText(req.body?.description);

  if (!date || !warehouseId || !["income", "expense"].includes(entryType) || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Date, warehouse, entry type, and positive amount are required" });
  }
  if (!canAccessWarehouse(req.user, warehouseId)) {
    return res.status(403).json({ error: "You do not have access to this warehouse" });
  }

  try {
    const created = await WarehouseTradingProfitLossAdjustment.create({
      date,
      warehouse_id: warehouseId,
      warehouse_name: normalizeText(req.body?.warehouse_name),
      entry_type: entryType,
      amount,
      description,
      created_by: getUserLabel(req.user),
    });
    return res.status(201).json({ id: String(created._id) });
  } catch (error) {
    console.error("Warehouse trading profit/loss adjustment save failed:", error);
    return res.status(500).json({ error: error.message || "Failed to save manual entry" });
  }
});

router.put("/profit-loss-adjustments/:id", async (req, res) => {
  if (!canManageWarehouseTrading(req.user)) {
    return res.status(403).json({ error: "Permission denied" });
  }
  const date = normalizeText(req.body?.date);
  const warehouseId = normalizeText(req.body?.warehouse_id);
  const entryType = normalizeText(req.body?.entry_type).toLowerCase();
  const amount = Number(req.body?.amount);
  const description = normalizeText(req.body?.description);
  if (!date || !warehouseId || !["income", "expense"].includes(entryType) || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Date, warehouse, entry type, and positive amount are required" });
  }
  if (!canAccessWarehouse(req.user, warehouseId)) {
    return res.status(403).json({ error: "You do not have access to this warehouse" });
  }
  try {
    const entry = await WarehouseTradingProfitLossAdjustment.findById(req.params.id);
    if (!entry) return res.status(404).json({ error: "Manual entry not found" });
    if (!canAccessWarehouse(req.user, entry.warehouse_id)) {
      return res.status(403).json({ error: "You do not have access to this warehouse" });
    }
    entry.date = date;
    entry.warehouse_id = warehouseId;
    entry.warehouse_name = normalizeText(req.body?.warehouse_name);
    entry.entry_type = entryType;
    entry.amount = amount;
    entry.description = description;
    await entry.save();
    return res.json({ id: String(entry._id), success: true });
  } catch (error) {
    console.error("Warehouse trading profit/loss adjustment update failed:", error);
    return res.status(500).json({ error: error.message || "Failed to update manual entry" });
  }
});

router.delete("/profit-loss-adjustments/:id", async (req, res) => {
  if (!canManageWarehouseTrading(req.user)) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    const entry = await WarehouseTradingProfitLossAdjustment.findById(req.params.id);
    if (!entry) return res.status(404).json({ error: "Manual entry not found" });
    if (!canAccessWarehouse(req.user, entry.warehouse_id)) {
      return res.status(403).json({ error: "You do not have access to this warehouse" });
    }
    await entry.deleteOne();
    return res.json({ success: true });
  } catch (error) {
    console.error("Warehouse trading profit/loss adjustment delete failed:", error);
    return res.status(500).json({ error: error.message || "Failed to delete manual entry" });
  }
});

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
