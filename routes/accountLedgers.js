const express = require("express");
const router = express.Router();
const { mongoose, AccountGroup, AccountLedger, CashEntry } = require("../db-mongodb");
const { userHasPermission } = require("../middleware/auth");

const defaults = [
  ["Direct Expenses", "expense", ["Loading Expense", "Transport Expense"]],
  ["Indirect Expenses", "expense", ["Salary", "Office Expense", "Other Expense", "Bank Charges"]],
  ["Current Assets", "asset", ["Cash", "Bank", "Loan Given"]],
  ["Current Liabilities", "liability", ["Loan Payable", "Salary Payable"]],
  ["Indirect Income", "income", ["Other Income"]],
  ["Capital Account", "equity", []],
];

async function seedDefaults() {
  for (const [name, nature, ledgers] of defaults) {
    const group = await AccountGroup.findOneAndUpdate(
      { name },
      { $setOnInsert: { name, nature, is_system: true } },
      { upsert: true, new: true }
    );
    for (const ledgerName of ledgers) {
      await AccountLedger.updateOne(
        { name: ledgerName, group_id: group._id },
        { $setOnInsert: { name: ledgerName, group_id: group._id, is_system: true } },
        { upsert: true }
      );
    }
  }
}

function canRead(req, res) {
  const allowed = ["cash.view", "cash.create", "cash.edit", "cash.mainBook.view", "cash.mainBook.create", "cash.mainBook.edit", "all"]
    .some((permission) => userHasPermission(req.user, permission));
  if (!allowed) {
    res.status(403).json({ error: "You do not have permission to view accounting ledgers" });
    return false;
  }
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({ error: "MongoDB is not connected." });
    return false;
  }
  return true;
}

router.get("/", async (req, res) => {
  if (!canRead(req, res)) return;
  try {
    await seedDefaults();
    const [groups, ledgers] = await Promise.all([
      AccountGroup.find({}).sort({ nature: 1, name: 1 }).lean(),
      AccountLedger.find({ is_active: true }).populate("group_id", "name nature").sort({ name: 1 }).lean(),
    ]);
    res.json({ groups, ledgers });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load account groups and ledgers" });
  }
});

router.post("/groups", async (req, res) => {
  if (!["cash.edit", "cash.mainBook.edit", "all"].some((permission) => userHasPermission(req.user, permission))) return res.status(403).json({ error: "You do not have permission to manage account groups" });
  const name = String(req.body?.name || "").trim();
  const nature = String(req.body?.nature || "").trim().toLowerCase();
  if (!name || !["asset", "liability", "income", "expense", "equity"].includes(nature)) {
    return res.status(400).json({ error: "Group name and valid nature are required" });
  }
  try {
    const group = await AccountGroup.create({ name, nature });
    res.status(201).json(group);
  } catch (error) {
    res.status(error.code === 11000 ? 409 : 500).json({ error: error.code === 11000 ? "Group already exists" : error.message });
  }
});

router.post("/ledgers", async (req, res) => {
  if (!["cash.edit", "cash.mainBook.edit", "all"].some((permission) => userHasPermission(req.user, permission))) return res.status(403).json({ error: "You do not have permission to manage ledgers" });
  const name = String(req.body?.name || "").trim();
  const groupId = String(req.body?.group_id || "");
  if (!name || !mongoose.Types.ObjectId.isValid(groupId)) return res.status(400).json({ error: "Ledger name and group are required" });
  try {
    const ledger = await AccountLedger.create({
      name,
      group_id: groupId,
      opening_balance: Math.max(Number(req.body?.opening_balance || 0), 0),
      opening_balance_type: req.body?.opening_balance_type === "cr" ? "cr" : "dr",
    });
    res.status(201).json(ledger);
  } catch (error) {
    res.status(error.code === 11000 ? 409 : 500).json({ error: error.code === 11000 ? "Ledger already exists in this group" : error.message });
  }
});

router.get("/report/:ledgerId", async (req, res) => {
  if (!canRead(req, res)) return;
  if (!mongoose.Types.ObjectId.isValid(req.params.ledgerId)) return res.status(400).json({ error: "Invalid ledger" });
  try {
    const ledger = await AccountLedger.findById(req.params.ledgerId).populate("group_id", "name nature").lean();
    if (!ledger) return res.status(404).json({ error: "Ledger not found" });
    const query = { account_ledger_id: String(ledger._id), fund_source: { $in: ["main_cash", "ledger"] }, status: { $nin: ["pending", "cancelled", "deleted"] } };
    const admin = req.user?.role === "admin" || req.user?.permissions?.includes?.("all") || req.user?.permissions?.includes?.("warehouses.manage");
    if (!admin) {
      const warehouseIds = Array.isArray(req.user?.assigned_warehouse_ids) ? req.user.assigned_warehouse_ids.map(String) : [];
      if (!warehouseIds.length) return res.json({ ledger, entries: [], total: 0, count: 0 });
      query.warehouse_id = { $in: warehouseIds };
    }
    if (req.query.from_date || req.query.to_date) {
      query.entry_date = {};
      if (req.query.from_date) query.entry_date.$gte = new Date(`${req.query.from_date}T00:00:00.000Z`);
      if (req.query.to_date) query.entry_date.$lte = new Date(`${req.query.to_date}T23:59:59.999Z`);
    }
    if (req.query.employee_id) query.employee_id = String(req.query.employee_id);
    let openingDebit = 0;
    let openingCredit = 0;
    if (req.query.from_date) {
      const openingQuery = { ...query, entry_date: { $lt: new Date(`${req.query.from_date}T00:00:00.000Z`) } };
      const openingRows = await CashEntry.aggregate([
        { $match: openingQuery },
        { $group: { _id: "$ledger_side", amount: { $sum: "$amount" } } },
      ]);
      openingDebit = Number(openingRows.find((row) => row._id === "debit")?.amount || 0);
      openingCredit = Number(openingRows.find((row) => row._id === "credit")?.amount || 0);
    }
    const entries = await CashEntry.find(query).sort({ entry_date: 1, id: 1 }).lean();
    const debitTotal = entries.reduce((sum, row) => sum + (row.ledger_side === "debit" ? Number(row.amount || 0) : 0), 0);
    const creditTotal = entries.reduce((sum, row) => sum + (row.ledger_side === "credit" ? Number(row.amount || 0) : 0), 0);
    const total = entries.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    return res.json({ ledger, entries, total: Number(total.toFixed(2)), debit_total: Number(debitTotal.toFixed(2)), credit_total: Number(creditTotal.toFixed(2)), opening_debit: Number(openingDebit.toFixed(2)), opening_credit: Number(openingCredit.toFixed(2)), count: entries.length });
  } catch (error) {
    console.error("GET /api/account-ledgers/report/:ledgerId failed:", error);
    if (res.headersSent) return;
    return res.status(500).json({ error: error.message || "Failed to load ledger report" });
  }
});

module.exports = router;
