const express = require("express");
const router = express.Router();
const { Company } = require("../mongo");
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

function normalizeShortagePercent(value) {
  if (value === "" || value === undefined || value === null) return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
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

    const normalizedShortagePercent = normalizeShortagePercent(shortage_percent);
    const company = new Company({
      name,
      address,
      mobile,
      shortage_percent: normalizedShortagePercent,
      opening_balance: Number(opening_balance || 0),
      opening_balance_type: String(opening_balance_type || "dr").toLowerCase() === "cr" ? "cr" : "dr",
    });
    await company.save();
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

    const updated = await Company.findById(req.params.id);

    if (!updated) {
      return res.status(404).json({
        error: "Company not found",
      });
    }

    updated.name = name;
    updated.address = address;
    updated.mobile = mobile;
    updated.shortage_percent = normalizeShortagePercent(shortage_percent);
    updated.opening_balance = Number(opening_balance || 0);
    updated.opening_balance_type = String(opening_balance_type || "dr").toLowerCase() === "cr" ? "cr" : "dr";
    await updated.save();
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
