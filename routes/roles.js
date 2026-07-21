const express = require("express");
const db = require("../db");
const dbMongo = require("../db-mongodb");
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
      "inward.import",
      "inward.export",
      "outward.view",
      "outward.create",
      "outward.edit",
      "outward.delete",
      "outward.import",
      "outward.export",
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
      "warehouse.trading.purchase.create",
      "warehouse.trading.purchase.edit",
      "warehouse.trading.purchase.delete",
      "warehouse.trading.sale.view",
      "warehouse.trading.sale.create",
      "warehouse.trading.sale.edit",
      "warehouse.trading.sale.delete",
      "warehouse.trading.payment.view",
      "warehouse.trading.payment.create",
      "warehouse.trading.payment.edit",
      "warehouse.trading.payment.delete",
      "warehouse.trading.receipt.view",
      "warehouse.trading.receipt.create",
      "warehouse.trading.receipt.edit",
      "warehouse.trading.receipt.delete",
      "warehouse.trading.journal.view",
      "warehouse.trading.journal.create",
      "warehouse.trading.journal.edit",
      "warehouse.trading.journal.delete",
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
      "inward.import",
      "inward.export",
      "outward.view",
      "outward.create",
      "outward.edit",
      "outward.import",
      "outward.export",
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

function formatRoleRow(row) {
  return {
    id: row.id || row._id,
    name: row.name,
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    is_admin: Number(row.is_admin) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getDefaultRoleRows() {
  return DEFAULT_ROLES.map((role, index) => ({
    id: `default-${index + 1}`,
    name: role.name,
    permissions: Array.isArray(role.permissions) ? role.permissions : [],
    is_admin: Number(role.is_admin) || 0,
    created_at: null,
    updated_at: null,
  }));
}

function normalizePermissions(permissions) {
  const raw = Array.isArray(permissions) ? permissions : [];
  return Array.from(new Set(raw.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)));
}

async function ensureDefaultRoles() {
  if (dbMongo.mongoose.connection.readyState !== 1) {
    return;
  }

  if (!db.isSqliteEnabled) {
    const docs = await dbMongo.Role.find({
      name: { $in: DEFAULT_ROLES.map((role) => role.name) },
    })
      .lean()
      .exec();

    const existingNames = new Set((docs || []).map((doc) => String(doc.name || "").toLowerCase()));
    const missingRoles = DEFAULT_ROLES.filter((role) => !existingNames.has(role.name.toLowerCase()));

    if (missingRoles.length > 0) {
      await dbMongo.Role.insertMany(
        missingRoles.map((role) => ({
          name: role.name,
          permissions: normalizePermissions(role.permissions),
          is_admin: role.is_admin,
        }))
      );
    }

    return;
  }

  const rows = await new Promise((resolve, reject) => {
    db.all("SELECT LOWER(name) AS name FROM roles", [], (selectErr, resultRows) => {
      if (selectErr) {
        reject(selectErr);
        return;
      }
      resolve(resultRows || []);
    });
  });

  const existingNames = new Set((rows || []).map((row) => row.name));
  const missingRoles = DEFAULT_ROLES.filter((role) => !existingNames.has(role.name.toLowerCase()));

  if (!missingRoles.length) {
    return;
  }

  const stmt = db.prepare("INSERT INTO roles (name, permissions, is_admin) VALUES (?, ?, ?)");
  try {
    missingRoles.forEach((role) => {
      stmt.run([role.name, JSON.stringify(role.permissions), role.is_admin]);
    });
  } finally {
    await new Promise((resolve, reject) => {
      stmt.finalize((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

router.get("/", async (req, res) => {
  if (dbMongo.mongoose.connection.readyState !== 1 && !db.isSqliteEnabled) {
    return res.json(getDefaultRoleRows());
  }

  try {
    await ensureDefaultRoles();

    if (!db.isSqliteEnabled) {
      const docs = await dbMongo.Role.find({})
        .sort({ name: 1 })
        .lean()
        .exec();
      return res.json((docs || []).map(formatRoleRow));
    }

    db.all("SELECT * FROM roles ORDER BY LOWER(name) ASC", [], (err, rows) => {
      if (err) {
        console.error("Failed to load roles from SQLite:", err.message);
        return res.json(getDefaultRoleRows());
      }
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
  } catch (err) {
    console.error("Role endpoint failed:", err.message);
    return res.json(getDefaultRoleRows());
  }
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
