const express = require("express");
const db = require("../db");
const { isAdminUser } = require("../middleware/auth");

const router = express.Router();

const DEFAULT_ROLES = [
  {
    name: "HO",
    is_admin: 0,
    permissions: [
      "dashboard.view",
      "employees.view",
      "employees.edit.non_admin",
      "companies.manage",
      "companyAccounts.manage",
      "locations.manage",
      "warehouses.manage",
      "products.manage",
      "inward.view",
      "inward.create",
      "inward.edit",
      "inward.delete",
      "outward.view",
      "outward.create",
      "outward.edit",
      "outward.delete",
      "adjustment.manage",
      "settlement.view",
      "expense.entry",
      "expense.view",
      "expense.create",
      "expense.edit",
      "expense.delete",
      "expense.postedInward",
      "expense.palti",
      "expense.selfLoading",
      "expense.localSale",
      "expense.pending",
      "cash.mainBook.view",
      "cash.mainBook.create",
      "cash.mainBook.edit",
      "cash.mainBook.delete",
      "cash.partiesBook.view",
      "cash.partiesBook.create",
      "cash.partiesBook.edit",
      "cash.partiesBook.delete",
      "cash.employeeBook.view",
      "cash.employeeBook.create",
      "cash.employeeBook.edit",
      "cash.employeeBook.delete",
      "warehouse.trading.purchase.view",
      "warehouse.trading.purchase.manage",
      "warehouse.trading.sale.view",
      "warehouse.trading.sale.manage",
      "warehouse.trading.payment.view",
      "warehouse.trading.payment.manage",
      "warehouse.trading.receipt.view",
      "warehouse.trading.receipt.manage",
      "warehouse.trading.journal.view",
      "warehouse.trading.journal.manage",
      "warehouse.trading.report.sale",
      "warehouse.trading.report.purchase",
      "warehouse.trading.report.profitLoss",
      "report.inward",
      "report.erp",
      "report.partyLedger",
      "report.partyStock",
      "report.warehouseRentLedger",
      "report.warehouseRentMonthEnd",
      "report.outwardSettlement",
      "report.expense",
      "report.paltiLorryAdjustment",
      "report.cash",
      "transport.manage",
    ],
  },
  {
    name: "BM",
    is_admin: 0,
    permissions: [
      "dashboard.view",
      "inward.view",
      "inward.create",
      "inward.edit",
      "outward.view",
      "outward.create",
      "outward.edit",
      "adjustment.manage",
      "settlement.view",
      "expense.entry",
      "expense.view",
      "expense.create",
      "expense.edit",
      "expense.postedInward",
      "expense.palti",
      "expense.selfLoading",
      "expense.localSale",
      "expense.pending",
      "cash.mainBook.view",
      "cash.mainBook.create",
      "cash.employeeBook.view",
      "cash.employeeBook.create",
      "report.inward",
      "report.outwardSettlement",
      "report.expense",
      "report.cash",
    ],
  },
];

function normalizePermissions(permissions) {
  const raw = Array.isArray(permissions) ? permissions : [];
  return Array.from(new Set(raw.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)));
}

function ensureDefaultRoles(callback) {
  db.all("SELECT LOWER(name) AS name FROM roles", [], (selectErr, rows) => {
    if (selectErr) {
      callback(selectErr);
      return;
    }

    const existingNames = new Set((rows || []).map((row) => row.name));
    const missingRoles = DEFAULT_ROLES.filter((role) => !existingNames.has(role.name.toLowerCase()));
    if (missingRoles.length === 0) {
      callback(null);
      return;
    }

    const stmt = db.prepare("INSERT INTO roles (name, permissions, is_admin) VALUES (?, ?, ?)");
    missingRoles.forEach((role) => {
      stmt.run([role.name, JSON.stringify(role.permissions), role.is_admin]);
    });
    stmt.finalize(callback);
  });
}

router.get("/", (req, res) => {
  ensureDefaultRoles((seedErr) => {
    if (seedErr) return res.status(500).json({ error: seedErr.message });

    db.all("SELECT * FROM roles ORDER BY LOWER(name) ASC", [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      return res.json(
        (rows || []).map((row) => ({
          ...row,
          permissions: (() => {
            try {
              return JSON.parse(row.permissions || "[]");
            } catch (error) {
              return [];
            }
          })(),
        }))
      );
    });
  });
});

router.post("/", (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Only admin can manage roles" });
  }

  const name = String(req.body?.name || "").trim();
  const permissions = normalizePermissions(req.body?.permissions);
  const is_admin = req.body?.is_admin ? 1 : 0;

  if (!name) {
    return res.status(400).json({ error: "Role name is required" });
  }

  db.run(
    "INSERT INTO roles (name, permissions, is_admin) VALUES (?, ?, ?)",
    [name, JSON.stringify(is_admin ? ["all"] : permissions), is_admin],
    function onInsert(err) {
      if (err) return res.status(500).json({ error: err.message });
      return res.json({ id: this.lastID, name, permissions: is_admin ? ["all"] : permissions, is_admin });
    }
  );
});

router.put("/:id", (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Only admin can manage roles" });
  }

  const name = String(req.body?.name || "").trim();
  const permissions = normalizePermissions(req.body?.permissions);
  const is_admin = req.body?.is_admin ? 1 : 0;

  if (!name) {
    return res.status(400).json({ error: "Role name is required" });
  }

  db.run(
    "UPDATE roles SET name = ?, permissions = ?, is_admin = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [name, JSON.stringify(is_admin ? ["all"] : permissions), is_admin, req.params.id],
    function onUpdate(err) {
      if (err) return res.status(500).json({ error: err.message });
      return res.json({ updated: this.changes });
    }
  );
});

router.delete("/:id", (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Only admin can manage roles" });
  }

  db.run("DELETE FROM roles WHERE id = ?", [req.params.id], function onDelete(err) {
    if (err) return res.status(500).json({ error: err.message });
    return res.json({ deleted: this.changes });
  });
});

module.exports = router;
