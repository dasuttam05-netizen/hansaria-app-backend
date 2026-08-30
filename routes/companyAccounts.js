const express = require("express");
const router = express.Router();

const multer = require("multer");
const XLSX = require("xlsx");
const mongoose = require("mongoose");

const {
  Company,
  CompanyAccount,
  isMongoMirrorReady,
} = require("../db-mongodb");

const {
  userHasPermission,
  isAdminUser,
} = require("../middleware/auth");

const upload = multer({
  storage: multer.memoryStorage(),
});

/*
====================================================
HELPERS
====================================================
*/

function requireMongo(req, res) {
  if (!isMongoMirrorReady()) {
    return res.status(503).json({
      error: "MongoDB is not connected",
    });
  }

  return true;
}

function canReadCompanyAccounts(user) {
  return [
    "companyAccounts.view",
    "companyAccounts.manage",
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
  if (
    value === "" ||
    value === undefined ||
    value === null
  ) {
    return null;
  }

  const numericValue = Number(value);

  return Number.isFinite(numericValue)
    ? numericValue
    : null;
}

function normalizeObjectId(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const text = String(value).trim();

  if (
    !mongoose.Types.ObjectId.isValid(text)
  ) {
    return null;
  }

  return text;
}

async function resolveCompany(companyId, companyName) {
  const rawCompanyId =
    companyId !== undefined &&
    companyId !== null
      ? String(companyId).trim()
      : "";

  const rawCompanyName =
    companyName !== undefined &&
    companyName !== null
      ? String(companyName).trim()
      : "";

  /*
   * 1. Try ObjectId.
   */
  if (
    rawCompanyId &&
    mongoose.Types.ObjectId.isValid(
      rawCompanyId
    )
  ) {
    const byId =
      await Company.findById(
        rawCompanyId
      ).lean();

    if (byId) {
      return byId;
    }
  }

  /*
   * 2. Try exact company name.
   */
  if (rawCompanyName) {
    const escapedName =
      rawCompanyName.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

    const byName =
      await Company.findOne({
        name: {
          $regex:
            `^${escapedName}$`,
          $options: "i",
        },
      }).lean();

    if (byName) {
      return byName;
    }
  }

  return null;
}

/*
====================================================
LIST
====================================================
*/

router.get("/", async (req, res) => {
  try {
    if (!canReadCompanyAccounts(req.user)) {
      return res.status(403).json({
        error:
          "You do not have permission to view company accounts",
      });
    }

    if (!requireMongo(req, res)) {
      return;
    }

    const rows =
      await CompanyAccount.find({})
        .sort({
          created_at: -1,
          _id: -1,
        })
        .lean();

    const companyIds = Array.from(
      new Set(
        rows
          .map((row) =>
            row?.company_id
              ? String(row.company_id)
              : null
          )
          .filter((id) =>
            id &&
            mongoose.Types.ObjectId.isValid(
              id
            )
          )
      )
    );

    const companies =
      companyIds.length
        ? await Company.find({
            _id: {
              $in: companyIds,
            },
          }).lean()
        : [];

    const companyMap =
      new Map(
        companies.map((company) => [
          String(company._id),
          company.name || "",
        ])
      );

    const formatted =
      rows.map((row) => ({
        ...row,

        id:
          row?._id
            ? String(row._id)
            : row?.id,

        company_name:
          companyMap.get(
            String(row.company_id)
          ) || "",

        shortage_percent:
          row.shortage_percent ??
          null,

        created_at:
          row.created_at ||
          null,

        updated_at:
          row.updated_at ||
          null,
      }));

    return res.json(
      formatted
    );
  } catch (err) {
    console.error(
      "Error fetching company accounts:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

/*
====================================================
CREATE
====================================================
*/

router.post("/", async (req, res) => {
  try {
    if (
      !userHasPermission(
        req.user,
        "companyAccounts.create"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to create company accounts",
      });
    }

    if (!requireMongo(req, res)) {
      return;
    }

    const {
      account_name,
      address,
      company_id,
      company_name,
      pan_no,
      mobile,
      shortage_percent,
    } = req.body;

    if (
      !account_name ||
      (!company_id && !company_name) ||
      !pan_no ||
      !mobile
    ) {
      return res.status(400).json({
        error:
          "Required fields missing",
      });
    }

    const company =
      await resolveCompany(
        company_id,
        company_name
      );

    if (!company) {
      return res.status(400).json({
        error:
          "Company not found. Please select a valid company.",
      });
    }

    const duplicate =
      await CompanyAccount.findOne({
        company_id:
          company._id,

        account_name: {
          $regex:
            `^${String(
              account_name
            ).trim().replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&"
            )}$`,

          $options: "i",
        },
      }).lean();

    if (duplicate) {
      return res.status(409).json({
        error:
          "This company account already exists",
      });
    }

    const account =
      await CompanyAccount.create({
        account_name:
          String(
            account_name
          ).trim(),

        address:
          address || null,

        company_id:
          company._id,

        pan_no:
          String(
            pan_no
          ).trim(),

        mobile:
          String(
            mobile
          ).trim(),

        shortage_percent:
          normalizeShortagePercent(
            shortage_percent
          ),

        created_at:
          new Date(),

        updated_at:
          new Date(),
      });

    const fresh =
      await CompanyAccount.findById(
        account._id
      ).lean();

    return res.json({
      ...(fresh || account.toObject()),

      id:
        String(
          account._id
        ),

      company_name:
        company.name || "",

      shortage_percent:
        normalizeShortagePercent(
          fresh?.shortage_percent ??
            account.shortage_percent
        ),
    });
  } catch (err) {
    console.error(
      "Error creating company account:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

/*
====================================================
IMPORT CORE
====================================================
*/

async function importCompanyAccountsRows(
  rows,
  res
) {
  try {
    if (!requireMongo(
      null,
      res
    )) {
      return;
    }

    const companies =
      await Company.find({})
        .select({
          name: 1,
        })
        .lean();

    const companyMap =
      new Map();

    for (const company of companies) {
      const key =
        String(
          company?.name || ""
        )
          .trim()
          .toLowerCase();

      if (
        key &&
        !companyMap.has(key)
      ) {
        companyMap.set(
          key,
          company
        );
      }
    }

    let inserted = 0;
    let skipped = 0;

    const errors = [];

    for (
      let index = 0;
      index < rows.length;
      index += 1
    ) {
      const row =
        rows[index] || {};

      const accountName =
        String(
          row.account_name || ""
        ).trim();

      const address =
        String(
          row.address || ""
        ).trim();

      const panNo =
        String(
          row.pan_no || ""
        ).trim();

      const mobile =
        String(
          row.mobile || ""
        ).trim();

      const shortagePercent =
        normalizeShortagePercent(
          row.shortage_percent
        );

      const companyName =
        String(
          row.company_name || ""
        )
          .trim()
          .toLowerCase();

      let company =
        companyMap.get(
          companyName
        ) || null;

      if (
        !company &&
        row.company_id
      ) {
        company =
          await resolveCompany(
            row.company_id,
            row.company_name
          );
      }

      if (
        !accountName ||
        !company ||
        !panNo ||
        !mobile
      ) {
        skipped += 1;

        errors.push({
          row:
            index + 2,

          error:
            "Missing or unmatched required fields",

          account_name:
            accountName,

          company_name:
            row.company_name ||
            "",

          company_id:
            row.company_id ||
            "",
        });

        continue;
      }

      const duplicate =
        await CompanyAccount.findOne({
          company_id:
            company._id,

          account_name: {
            $regex:
              `^${accountName.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&"
              )}$`,

            $options: "i",
          },
        }).lean();

      if (duplicate) {
        skipped += 1;

        continue;
      }

      try {
        await CompanyAccount.create({
          account_name:
            accountName,

          address:
            address || null,

          company_id:
            company._id,

          pan_no:
            panNo,

          mobile:
            mobile,

          shortage_percent:
            shortagePercent,

          created_at:
            new Date(),

          updated_at:
            new Date(),
        });

        inserted += 1;
      } catch (insertErr) {
        skipped += 1;

        errors.push({
          row:
            index + 2,

          error:
            insertErr.message,
        });
      }
    }

    return res.json({
      total:
        rows.length,

      inserted,

      skipped,

      errors,
    });
  } catch (err) {
    console.error(
      "Company account import failed:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
}

/*
====================================================
IMPORT JSON
====================================================
*/

router.post(
  "/import",
  async (req, res) => {
    if (
      !isAdminUser(
        req.user
      )
    ) {
      return res.status(403).json({
        error:
          "Only admin can import company account master",
      });
    }

    const rows =
      Array.isArray(
        req.body?.rows
      )
        ? req.body.rows
        : [];

    if (
      rows.length === 0
    ) {
      return res.status(400).json({
        error:
          "No rows found for import",
      });
    }

    return importCompanyAccountsRows(
      rows,
      res
    );
  }
);

/*
====================================================
IMPORT XLSX
====================================================
*/

router.post(
  "/import-xlsx",
  upload.single("file"),
  async (req, res) => {
    if (
      !isAdminUser(
        req.user
      )
    ) {
      return res.status(403).json({
        error:
          "Only admin can import company account master",
      });
    }

    if (
      !req.file?.buffer
    ) {
      return res.status(400).json({
        error:
          "XLSX file is required",
      });
    }

    let rows = [];

    try {
      const workbook =
        XLSX.read(
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

      rows =
        XLSX.utils.sheet_to_json(
          workbook.Sheets[
            firstSheet
          ],
          {
            defval: "",
          }
        );
    } catch (err) {
      return res.status(400).json({
        error:
          "Invalid XLSX file",
      });
    }

    if (
      !Array.isArray(rows) ||
      rows.length === 0
    ) {
      return res.status(400).json({
        error:
          "No rows found in XLSX",
      });
    }

    const normalized =
      rows.map((row) => ({
        company_name:
          row.company_name ??
          row.CompanyName ??
          row.Company ??
          row.company ??
          "",

        company_id:
          row.company_id ??
          row.CompanyId ??
          row.companyId ??
          "",

        account_name:
          row.account_name ??
          row.AccountName ??
          row.Account ??
          row.account ??
          "",

        address:
          row.address ??
          row.Address ??
          "",

        pan_no:
          row.pan_no ??
          row.PAN ??
          row.PanNo ??
          "",

        mobile:
          row.mobile ??
          row.Mobile ??
          row.Phone ??
          "",

        shortage_percent:
          row.shortage_percent ??
          row.ShortagePercent ??
          row["Shortage Percent"] ??
          "",
      }));

    return importCompanyAccountsRows(
      normalized,
      res
    );
  }
);

/*
====================================================
UPDATE
====================================================
*/

router.put(
  "/:id",
  async (req, res) => {
    try {
      if (
        !userHasPermission(
          req.user,
          "companyAccounts.edit"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to edit company accounts",
        });
      }

      if (!requireMongo(req, res)) {
        return;
      }

      const {
        account_name,
        address,
        company_id,
        company_name,
        pan_no,
        mobile,
        shortage_percent,
      } = req.body;

      if (
        !mongoose.Types.ObjectId.isValid(
          String(
            req.params.id
          )
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid company account ID",
        });
      }

      if (
        !account_name ||
        (!company_id && !company_name) ||
        !pan_no ||
        !mobile
      ) {
        return res.status(400).json({
          error:
            "Required fields missing",
        });
      }

      const company =
        await resolveCompany(
          company_id,
          company_name
        );

      if (!company) {
        return res.status(400).json({
          error:
            "Company not found",
        });
      }

      const duplicate =
        await CompanyAccount.findOne({
          _id: {
            $ne:
              req.params.id,
          },

          company_id:
            company._id,

          account_name: {
            $regex:
              `^${String(
                account_name
              ).trim().replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&"
              )}$`,

            $options: "i",
          },
        }).lean();

      if (duplicate) {
        return res.status(409).json({
          error:
            "Another account with the same name already exists for this company",
        });
      }

      const updated =
        await CompanyAccount.findByIdAndUpdate(
          req.params.id,
          {
            $set: {
              account_name:
                String(
                  account_name
                ).trim(),

              address:
                address || null,

              company_id:
                company._id,

              pan_no:
                String(
                  pan_no
                ).trim(),

              mobile:
                String(
                  mobile
                ).trim(),

              shortage_percent:
                normalizeShortagePercent(
                  shortage_percent
                ),

              updated_at:
                new Date(),
            },
          },
          {
            new: true,
          }
        ).lean();

      if (!updated) {
        return res.status(404).json({
          error:
            "Account not found",
        });
      }

      return res.json({
        ...updated,

        id:
          String(
            updated._id
          ),

        company_name:
          company.name || "",
      });
    } catch (err) {
      console.error(
        "Error updating company account:",
        err
      );

      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

/*
====================================================
DELETE
====================================================
*/

router.delete(
  "/:id",
  async (req, res) => {
    try {
      if (
        !userHasPermission(
          req.user,
          "companyAccounts.delete"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to delete company accounts",
        });
      }

      if (!requireMongo(req, res)) {
        return;
      }

      if (
        !mongoose.Types.ObjectId.isValid(
          String(
            req.params.id
          )
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid company account ID",
        });
      }

      const deleted =
        await CompanyAccount.findByIdAndDelete(
          req.params.id
        ).lean();

      if (!deleted) {
        return res.status(404).json({
          error:
            "Account not found",
        });
      }

      return res.json({
        message:
          "Account deleted",

        id:
          req.params.id,

        deleted:
          1,

        source:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Error deleting company account:",
        err
      );

      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

module.exports = router;
