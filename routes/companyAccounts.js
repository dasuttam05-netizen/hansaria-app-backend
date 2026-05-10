const express = require("express");
const router = express.Router();

const multer = require("multer");
const XLSX = require("xlsx");

const {
  Company,
  CompanyAccount,
} = require("../mongo");

const {
  userHasPermission,
  isAdminUser,
} = require("../middleware/auth");

const upload = multer({
  storage: multer.memoryStorage(),
});

function canReadCompanyAccounts(user) {
  return [
    "companyAccounts.manage",
    "inward.view",
    "inward.create",
    "outward.view",
    "outward.create",
    "adjustment.manage",
    "expense.entry",
    "expense.view",
    "expense.create",
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

router.get("/", async (req, res) => {
  try {

    if (!canReadCompanyAccounts(req.user)) {
      return res.status(403).json({
        error:
          "You do not have permission to view company accounts",
      });
    }

    const rows = await CompanyAccount.find()
      .sort({ created_at: -1 })
      .lean();

    const companyIds = Array.from(
      new Set(
        rows
          .map((row) => row.company_id)
          .filter(Boolean)
          .map((id) => String(id))
      )
    );

    const companies = await Company.find({
      _id: { $in: companyIds },
    }).lean();

    const companyMap = new Map(
      companies.map((c) => [String(c._id), c.name])
    );

    const formatted = rows.map((row) => ({
      ...row,
      company_name:
        companyMap.get(String(row.company_id)) || "",
    }));

    res.json(formatted);

  } catch (err) {

    console.error(
      "Error fetching accounts:",
      err.message
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

router.post("/", async (req, res) => {
  try {

    if (!isAdminUser(req.user)) {
      return res.status(403).json({
        error:
          "Only admin can edit company account master",
      });
    }

    const {
      account_name,
      address,
      company_id,
      pan_no,
      mobile,
    } = req.body;

    if (
      !account_name ||
      !company_id ||
      !pan_no ||
      !mobile
    ) {
      return res.status(400).json({
        error: "Required fields missing",
      });
    }

    // Validate company_id is a valid ObjectId
    if (!require("mongoose").Types.ObjectId.isValid(company_id)) {
      return res.status(400).json({
        error: "Invalid company ID format",
      });
    }

    const account =
      await CompanyAccount.create({
        account_name,
        address,
        company_id,
        pan_no,
        mobile,
      });

    res.json(account);

  } catch (err) {

    console.error(
      "Error inserting account:",
      err.message
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

async function importCompanyAccountsRows(
  rows,
  res
) {
  try {

    const companies = await Company.find();

    const companyMap = new Map();

    (companies || []).forEach((c) => {
      companyMap.set(
        String(c.name || "")
          .trim()
          .toLowerCase(),
        c._id.toString()
      );
    });

    let inserted = 0;
    let skipped = 0;

    const errors = [];

    for (let index = 0; index < rows.length; index++) {

      const r = rows[index] || {};

      const accountName = String(
        r.account_name || ""
      ).trim();

      const address = String(
        r.address || ""
      ).trim();

      const panNo = String(
        r.pan_no || ""
      ).trim();

      const mobile = String(
        r.mobile || ""
      ).trim();

      const companyName = String(
        r.company_name || ""
      )
        .trim()
        .toLowerCase();

      const companyIdFromName =
        companyMap.get(companyName);

      const companyId =
        companyIdFromName ||
        r.company_id ||
        null;

      if (
        !accountName ||
        !companyId ||
        !panNo ||
        !mobile
      ) {
        skipped += 1;

        errors.push({
          row: index + 2,
          error:
            "Missing required fields",
        });

        continue;
      }

      const existing =
        await CompanyAccount.findOne({
          company_id: companyId,
          account_name: {
            $regex: new RegExp(
              `^${accountName}$`,
              "i"
            ),
          },
        });

      if (existing) {
        skipped += 1;
        continue;
      }

      try {

        await CompanyAccount.create({
          account_name: accountName,
          address,
          company_id: companyId,
          pan_no: panNo,
          mobile,
        });

        inserted += 1;

      } catch (insertErr) {

        skipped += 1;

        errors.push({
          row: index + 2,
          error: insertErr.message,
        });
      }
    }

    return res.json({
      total: rows.length,
      inserted,
      skipped,
      errors,
    });

  } catch (err) {

    return res.status(500).json({
      error: err.message,
    });
  }
}

router.post("/import", async (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({
      error:
        "Only admin can import company account master",
    });
  }

  const rows = Array.isArray(req.body?.rows)
    ? req.body.rows
    : [];

  if (rows.length === 0) {
    return res.status(400).json({
      error: "No rows found for import",
    });
  }

  return importCompanyAccountsRows(
    rows,
    res
  );
});

router.post(
  "/import-xlsx",
  upload.single("file"),
  async (req, res) => {

    if (!isAdminUser(req.user)) {
      return res.status(403).json({
        error:
          "Only admin can import company account master",
      });
    }

    if (!req.file?.buffer) {
      return res.status(400).json({
        error: "XLSX file is required",
      });
    }

    let rows = [];

    try {

      const workbook = XLSX.read(
        req.file.buffer,
        {
          type: "buffer",
        }
      );

      const firstSheet =
        workbook.SheetNames?.[0];

      if (!firstSheet) {
        return res.status(400).json({
          error:
            "No sheet found in file",
        });
      }

      rows = XLSX.utils.sheet_to_json(
        workbook.Sheets[firstSheet],
        {
          defval: "",
        }
      );

    } catch (err) {

      return res.status(400).json({
        error: "Invalid XLSX file",
      });
    }

    if (
      !Array.isArray(rows) ||
      rows.length === 0
    ) {
      return res.status(400).json({
        error: "No rows found in XLSX",
      });
    }

    const normalized = rows.map((r) => ({
      company_name:
        r.company_name ??
        r.CompanyName ??
        r.Company ??
        r.company ??
        "",

      company_id:
        r.company_id ??
        r.CompanyId ??
        r.companyId ??
        "",

      account_name:
        r.account_name ??
        r.AccountName ??
        r.Account ??
        r.account ??
        "",

      address:
        r.address ??
        r.Address ??
        "",

      pan_no:
        r.pan_no ??
        r.PAN ??
        r.PanNo ??
        "",

      mobile:
        r.mobile ??
        r.Mobile ??
        r.Phone ??
        "",
    }));

    return importCompanyAccountsRows(
      normalized,
      res
    );
  }
);

router.put("/:id", async (req, res) => {
  try {

    if (!isAdminUser(req.user)) {
      return res.status(403).json({
        error:
          "Only admin can edit company account master",
      });
    }

    const {
      account_name,
      address,
      company_id,
      pan_no,
      mobile,
    } = req.body;

    // Validate company_id is a valid ObjectId
    if (company_id && !require("mongoose").Types.ObjectId.isValid(company_id)) {
      return res.status(400).json({
        error: "Invalid company ID format",
      });
    }

    const updated =
      await CompanyAccount.findByIdAndUpdate(
        req.params.id,
        {
          account_name,
          address,
          company_id,
          pan_no,
          mobile,
        },
        {
          new: true,
        }
      );

    if (!updated) {
      return res.status(404).json({
        error: "Account not found",
      });
    }

    res.json(updated);

  } catch (err) {

    console.error(
      "Error updating account:",
      err.message
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

router.delete("/:id", async (req, res) => {
  try {

    if (!isAdminUser(req.user)) {
      return res.status(403).json({
        error:
          "Only admin can edit company account master",
      });
    }

    const deleted =
      await CompanyAccount.findByIdAndDelete(
        req.params.id
      );

    if (!deleted) {
      return res.status(404).json({
        error: "Account not found",
      });
    }

    res.json({
      message: "Account deleted",
    });

  } catch (err) {

    console.error(
      "Error deleting account:",
      err.message
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

module.exports = router;
