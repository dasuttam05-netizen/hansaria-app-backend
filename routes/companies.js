const express = require("express");
const router = express.Router();
const db = require("../db");

const { Company } = require("../mongo");
const { resolveMongoMasterId } = require("../helpers/sqliteMasterResolver");

const {
  userHasPermission,
  isAdminUser,
} = require("../middleware/auth");

function canReadCompanies(user) {
  return [
    "companies.view",
    "companies.manage",
    "inward.view",
    "inward.create",
    "outward.view",
    "outward.create",
    "adjustment.manage",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
    "cash.view",
    "settlement.view",
    "report.inward",
    "report.erp",
    "report.partyLedger",
    "report.partyStock",
    "report.warehouseRentLedger",
    "report.warehouseRentMonthEnd",
    "report.outwardSettlement",
    "report.expense",
  ].some((permission) =>
    userHasPermission(user, permission)
  );
}

function dbGetAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function dbRunAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({
        lastID: Number(this?.lastID),
        changes: Number(this?.changes || 0),
      });
    });
  });
}

function normalizeShortagePercent(value) {
  if (value === "" || value === undefined || value === null) return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

async function syncCompanyToSqlite(companyDoc) {
  const doc = companyDoc && typeof companyDoc.toObject === "function"
    ? companyDoc.toObject()
    : (companyDoc || {});

  const mongoCompanyId = doc._id || doc.id;
  if (!mongoCompanyId) return;

  const sqliteCompanyId = await resolveMongoMasterId(db, mongoCompanyId, Company, "companies");
  if (!sqliteCompanyId) return;

  const normalizedShortagePercent = normalizeShortagePercent(doc.shortage_percent);

  const openingBalance = Number(doc.opening_balance ?? 0);
  const openingBalanceType = String(doc.opening_balance_type || "dr").toLowerCase() === "cr" ? "cr" : "dr";

  const existing = await dbGetAsync("SELECT id FROM companies WHERE id = ?", [sqliteCompanyId]);

  if (existing) {
    await dbRunAsync(
      `UPDATE companies
       SET name = ?, address = ?, mobile = ?, shortage_percent = ?, opening_balance = ?, opening_balance_type = ?
       WHERE id = ?`,
      [
        doc.name || "",
        doc.address || "",
        doc.mobile || "",
        normalizedShortagePercent,
        openingBalance,
        openingBalanceType,
        sqliteCompanyId,
      ]
    );
    return;
  }

  await dbRunAsync(
    `INSERT INTO companies (id, name, address, mobile, shortage_percent, opening_balance, opening_balance_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      sqliteCompanyId,
      doc.name || "",
      doc.address || "",
      doc.mobile || "",
      normalizedShortagePercent,
      openingBalance,
      openingBalanceType,
    ]
  );
}

router.get("/", async (req, res) => {
  try {

    if (!canReadCompanies(req.user)) {
      return res.status(403).json({
        error:
          "You do not have permission to view companies",
      });
    }

    const rows = await Company.find().sort({
      created_at: -1,
    });

    const enrichedRows = rows.map(row => ({
      ...row.toObject(),
      shortage_percent: row.shortage_percent ?? null,
      opening_balance: row.opening_balance ?? 0,
      opening_balance_type: row.opening_balance_type || "dr",
    }));

    res.json(enrichedRows);

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });
  }
});

router.post("/", async (req, res) => {
  try {

    if (!userHasPermission(req.user, "companies.create")) {
      return res.status(403).json({
        error:
          "You do not have permission to create companies",
      });
    }

    const {
      name,
      address,
      mobile,
      shortage_percent,
      opening_balance,
      opening_balance_type,
    } = req.body;

    if (!name || !mobile) {
      return res.status(400).json({
        error:
          "Company Name and Mobile No. are required",
      });
    }

    const company = await Company.create({
      name,
      address,
      mobile,
      shortage_percent: normalizeShortagePercent(shortage_percent),
      opening_balance: Number(
        opening_balance || 0
      ),
      opening_balance_type:
        String(
          opening_balance_type || "dr"
        ).toLowerCase() === "cr"
          ? "cr"
          : "dr",
    });

    await syncCompanyToSqlite(company);

    const freshCompany = await Company.findById(company._id).lean();
    res.json({
      ...(freshCompany || company.toObject()),
      shortage_percent: normalizeShortagePercent(freshCompany?.shortage_percent ?? company.shortage_percent),
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });
  }
});

router.put("/:id", async (req, res) => {
  try {

    if (!userHasPermission(req.user, "companies.edit")) {
      return res.status(403).json({
        error:
          "You do not have permission to edit companies",
      });
    }

    const {
      name,
      address,
      mobile,
      shortage_percent,
      opening_balance,
      opening_balance_type,
    } = req.body;

    const updated =
      await Company.findByIdAndUpdate(
        req.params.id,
        {
          name,
          address,
          mobile,
          shortage_percent: normalizeShortagePercent(shortage_percent),
          opening_balance: Number(
            opening_balance || 0
          ),
          opening_balance_type:
            String(
              opening_balance_type || "dr"
            ).toLowerCase() === "cr"
              ? "cr"
              : "dr",
        },
        {
          new: true,
        }
      );

    if (!updated) {
      return res.status(404).json({
        error: "Company not found",
      });
    }

    await syncCompanyToSqlite(updated);

    const freshUpdated = await Company.findById(updated._id).lean();
    res.json({
      ...(freshUpdated || updated.toObject()),
      shortage_percent: normalizeShortagePercent(freshUpdated?.shortage_percent ?? updated.shortage_percent),
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });
  }
});

router.delete("/:id", async (req, res) => {
  try {

    if (!userHasPermission(req.user, "companies.delete")) {
      return res.status(403).json({
        error:
          "You do not have permission to delete companies",
      });
    }

    const deleted =
      await Company.findByIdAndDelete(
        req.params.id
      );

    if (!deleted) {
      return res.status(404).json({
        error: "Company not found",
      });
    }

    res.json({
      message: "Company deleted",
      id: req.params.id,
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });
  }
});

module.exports = router;
