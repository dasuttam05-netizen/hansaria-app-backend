const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");

const {
  userHasPermission,
} = require("../middleware/auth");

const {
  canAccessWarehouse,
} = require("../helpers/access");

const {
  mongoose,
  Inward: MongoInward,
  isMongoMirrorReady,
  Employee,
  Location,
  Warehouse,
  Product,
  Company,
  CompanyAccount,
} = require("../db-mongodb");

const upload = multer({
  storage: multer.memoryStorage(),
});

/*
====================================================
MONGODB CONNECTION CHECK
====================================================
*/

function ensureMongo(res) {
  if (!isMongoMirrorReady()) {
    res.status(503).json({
      error: "MongoDB is not connected",
    });
    return false;
  }

  return true;
}

/*
====================================================
XLSX OPTIONS
====================================================
*/

router.options(
  "/template-xlsx",
  (req, res) => res.sendStatus(204)
);

router.options(
  "/import-xlsx",
  (req, res) => {
    console.log(
      "[inward.import] preflight",
      {
        origin:
          req.headers.origin || "",
        method: req.method,
        contentType:
          req.headers["content-type"] || "",
      }
    );

    return res.sendStatus(204);
  }
);

/*
====================================================
TEMPLATE
====================================================
*/

function buildInwardTemplateRows() {
  return [
    {
      date: "2026-07-21",
      employee_name: "Employee Name",
      location_name: "Location Name",
      warehouse_name: "Warehouse Name",
      product_name: "Product Name",
      company_name: "Company Name",
      company_account_name:
        "Company Account Name",
      lorry_no: "WB00A0000",
      weight: 0,
    },
  ];
}

/*
====================================================
IMPORT NORMALIZATION
====================================================
*/

function normalizeInwardImportRow(row) {
  const pick = (...keys) => {
    for (const key of keys) {
      if (
        row?.[key] !==
          undefined &&
        row?.[key] !== null &&
        String(
          row[key]
        ).trim() !== ""
      ) {
        return row[key];
      }
    }

    return "";
  };

  return {
    date: pick(
      "date",
      "Date",
      "DATE"
    ),

    employee_id: pick(
      "employee_id",
      "EmployeeID",
      "EmployeeId",
      "Employee ID"
    ),

    employee_name: pick(
      "employee_name",
      "EmployeeName",
      "Employee Name",
      "Employee"
    ),

    location_id: pick(
      "location_id",
      "LocationID",
      "LocationId",
      "Location ID"
    ),

    location_name: pick(
      "location_name",
      "LocationName",
      "Location Name",
      "Location"
    ),

    warehouse_id: pick(
      "warehouse_id",
      "WarehouseID",
      "WarehouseId",
      "Warehouse ID"
    ),

    warehouse_name: pick(
      "warehouse_name",
      "WarehouseName",
      "Warehouse Name",
      "Warehouse"
    ),

    product_id: pick(
      "product_id",
      "ProductID",
      "ProductId",
      "Product ID"
    ),

    product_name: pick(
      "product_name",
      "ProductName",
      "Product Name",
      "Product"
    ),

    company_id: pick(
      "company_id",
      "CompanyID",
      "CompanyId",
      "Company ID"
    ),

    company_name: pick(
      "company_name",
      "CompanyName",
      "Company Name",
      "Company"
    ),

    company_account_id: pick(
      "company_account_id",
      "CompanyAccountID",
      "CompanyAccountId",
      "Company Account ID"
    ),

    company_account_name: pick(
      "company_account_name",
      "CompanyAccountName",
      "Company Account Name",
      "CompanyAccount",
      "Company Account",
      "Account Name",
      "Account"
    ),

    lorry_no: pick(
      "lorry_no",
      "LorryNo",
      "Lorry No"
    ),

    weight: pick(
      "weight",
      "Weight"
    ),
  };
}

/*
====================================================
GENERAL HELPERS
====================================================
*/

function normalizeDate(value) {
  if (
    value ===
      undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return null;
  }

  if (
    value instanceof Date &&
    !Number.isNaN(
      value.getTime()
    )
  ) {
    return value;
  }

  const text =
    String(value).trim();

  const yyyyMmDd =
    text.match(
      /^(\d{4})-(\d{2})-(\d{2})$/
    );

  if (yyyyMmDd) {
    const date =
      new Date(
        `${yyyyMmDd[1]}-${yyyyMmDd[2]}-${yyyyMmDd[3]}T00:00:00.000Z`
      );

    if (
      !Number.isNaN(
        date.getTime()
      )
    ) {
      return date;
    }
  }

  const parsed =
    new Date(text);

  if (
    Number.isNaN(
      parsed.getTime()
    )
  ) {
    return null;
  }

  return parsed;
}

function normalizeShortagePercent(
  value
) {
  if (
    value === "" ||
    value ===
      undefined ||
    value === null
  ) {
    return null;
  }

  const numericValue =
    Number(value);

  return Number.isFinite(
    numericValue
  )
    ? numericValue
    : null;
}

function formatVoucher(slNo) {
  return `INV${String(
    slNo
  ).padStart(3, "0")}`;
}

function stringValue(value) {
  return String(
    value ?? ""
  ).trim();
}

function lowerValue(value) {
  return stringValue(
    value
  ).toLowerCase();
}

function isValidObjectId(
  value
) {
  return mongoose.Types.ObjectId.isValid(
    String(value ?? "")
  );
}

/*
====================================================
MODEL FINDER
====================================================
*/

async function findMongoMasterByIdOrName(
  Model,
  idValue,
  nameValue,
  legacyFields = []
) {
  if (!Model) {
    return null;
  }

  const rawId =
    stringValue(idValue);

  const rawName =
    stringValue(nameValue);

  /*
   * ObjectId lookup
   */
  if (
    rawId &&
    isValidObjectId(rawId)
  ) {
    try {
      const byObjectId =
        await Model.findById(
          rawId
        ).lean();

      if (byObjectId) {
        return byObjectId;
      }
    } catch (error) {
      console.warn(
        "[Mongo master ObjectId lookup skipped]:",
        error.message
      );
    }
  }

  /*
   * Legacy ID lookup
   */
  if (rawId) {
    for (
      const field of legacyFields
    ) {
      try {
        const byStringLegacy =
          await Model.findOne({
            [field]:
              rawId,
          }).lean();

        if (
          byStringLegacy
        ) {
          return byStringLegacy;
        }
      } catch {}

      const numeric =
        Number(rawId);

      if (
        Number.isFinite(
          numeric
        )
      ) {
        try {
          const byNumericLegacy =
            await Model.findOne({
              [field]:
                numeric,
            }).lean();

          if (
            byNumericLegacy
          ) {
            return byNumericLegacy;
          }
        } catch {}
      }
    }
  }

  /*
   * Name lookup
   */
  if (rawName) {
    try {
      const byName =
        await Model.findOne({
          name: new RegExp(
            `^${escapeRegExp(
              rawName
            )}$`,
            "i"
          ),
        }).lean();

      if (byName) {
        return byName;
      }
    } catch {}
  }

  return null;
}

function escapeRegExp(value) {
  return String(
    value
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

/*
====================================================
MASTER RESOLUTION
====================================================
*/

async function resolveInwardMasters(
  row
) {
  const [
    employee,
    location,
    warehouse,
    product,
    company,
  ] = await Promise.all([
    findMongoMasterByIdOrName(
      Employee,
      row?.employee_id,
      row?.employee_name,
      [
        "employee_id",
        "legacy_id",
        "id",
      ]
    ),

    findMongoMasterByIdOrName(
      Location,
      row?.location_id,
      row?.location_name,
      [
        "legacy_id",
        "id",
      ]
    ),

    findMongoMasterByIdOrName(
      Warehouse,
      row?.warehouse_id,
      row?.warehouse_name,
      [
        "legacy_id",
        "id",
      ]
    ),

    findMongoMasterByIdOrName(
      Product,
      row?.product_id,
      row?.product_name,
      [
        "legacy_id",
        "id",
      ]
    ),

    findMongoMasterByIdOrName(
      Company,
      row?.company_id,
      row?.company_name,
      [
        "legacy_id",
        "id",
      ]
    ),
  ]);

  /*
   * Company account
   */
  let companyAccount =
    await findMongoMasterByIdOrName(
      CompanyAccount,
      row?.company_account_id,
      row?.company_account_name,
      [
        "legacy_id",
        "id",
      ]
    );

  /*
   * Resolve account by company
   */
  if (
    !companyAccount &&
    company?._id
  ) {
    try {
      companyAccount =
        await CompanyAccount.findOne({
          company_id:
            company._id,
        })
          .sort({
            _id: 1,
          })
          .lean();
    } catch {}
  }

  /*
   * Additional name matching
   */
  if (
    !companyAccount &&
    row?.company_account_name
  ) {
    try {
      const accountName =
        stringValue(
          row.company_account_name
        );

      companyAccount =
        await CompanyAccount.findOne({
          account_name:
            new RegExp(
              `^${escapeRegExp(
                accountName
              )}$`,
              "i"
            ),
        }).lean();
    } catch {}
  }

  return {
    employee,
    location,
    warehouse,
    product,
    company,
    companyAccount,
  };
}

/*
====================================================
MASTER NAMES
====================================================
*/

function buildMasterNames(
  masters
) {
  return {
    employee_name:
      masters.employee?.name ||
      "",

    location_name:
      masters.location?.name ||
      "",

    warehouse_name:
      masters.warehouse?.name ||
      "",

    product_name:
      masters.product?.name ||
      "",

    company_name:
      masters.company?.name ||
      "",

    company_account_name:
      masters.companyAccount
        ?.account_name ||
      "",
  };
}

/*
====================================================
SAMPLE ROW
====================================================
*/

function buildSampleRow(
  row
) {
  return {
    date: stringValue(
      row?.date
    ),

    employee_name:
      stringValue(
        row?.employee_name
      ),

    location_name:
      stringValue(
        row?.location_name
      ),

    warehouse_name:
      stringValue(
        row?.warehouse_name
      ),

    product_name:
      stringValue(
        row?.product_name
      ),

    company_name:
      stringValue(
        row?.company_name
      ),

    company_account_name:
      stringValue(
        row?.company_account_name
      ),

    lorry_no:
      stringValue(
        row?.lorry_no
      ),

    weight:
      stringValue(
        row?.weight
      ),
  };
}

/*
====================================================
NEXT SL NUMBER
====================================================
*/

async function getNextInwardSlNo() {
  const last =
    await MongoInward.findOne({})
      .sort({
        sl_no: -1,
        legacy_id: -1,
        _id: -1,
      })
      .select({
        sl_no: 1,
        legacy_id: 1,
      })
      .lean();

  const lastSl =
    Number(
      last?.sl_no ??
        last?.legacy_id ??
        0
    ) || 0;

  return lastSl + 1;
}

/*
====================================================
DECORATE MONGO INWARD
====================================================
*/

async function decorateMongoInwardDocs(
  docs
) {
  const result = [];

  for (
    const doc of docs || []
  ) {
    const masters =
      await resolveInwardMasters({
        employee_id:
          doc?.employee_id,

        employee_name:
          doc?.employee_name,

        location_id:
          doc?.location_id,

        location_name:
          doc?.location_name,

        warehouse_id:
          doc?.warehouse_id,

        warehouse_name:
          doc?.warehouse_name,

        product_id:
          doc?.product_id,

        product_name:
          doc?.product_name,

        company_id:
          doc?.company_id,

        company_name:
          doc?.company_name,

        company_account_id:
          doc?.company_account_id,

        company_account_name:
          doc?.company_account_name,
      });

    const names =
      buildMasterNames(
        masters
      );

    const legacyId =
      doc?.legacy_id ??
      doc?.sl_no ??
      String(
        doc?._id
      );

    const date =
      doc?.date instanceof Date
        ? doc.date
            .toISOString()
            .slice(0, 10)
        : normalizeDate(
              doc?.date
            )
          ? normalizeDate(
              doc?.date
            )
              .toISOString()
              .slice(0, 10)
          : stringValue(
              doc?.date
            ).slice(0, 10);

    result.push({
      ...doc,

      id:
        legacyId,

      legacy_id:
        doc?.legacy_id ??
        null,

      sl_no:
        doc?.sl_no ??
        doc?.legacy_id ??
        null,

      voucher_no:
        doc?.voucher_no ||
        doc?.inward_no ||
        (
          doc?.sl_no
            ? formatVoucher(
                doc.sl_no
              )
            : ""
        ),

      date,

      employee_id:
        doc?.employee_id ??
        null,

      location_id:
        doc?.location_id ??
        null,

      warehouse_id:
        doc?.warehouse_id ??
        null,

      product_id:
        doc?.product_id ??
        null,

      company_id:
        doc?.company_id ??
        null,

      company_account_id:
        doc?.company_account_id ??
        null,

      employee_name:
        names.employee_name ||
        doc?.employee_name ||
        "",

      location_name:
        names.location_name ||
        doc?.location_name ||
        "",

      warehouse_name:
        names.warehouse_name ||
        doc?.warehouse_name ||
        "",

      product_name:
        names.product_name ||
        doc?.product_name ||
        "",

      company_name:
        names.company_name ||
        doc?.company_name ||
        "",

      company_account_name:
        names.company_account_name ||
        doc?.company_account_name ||
        "",

      lorry_no:
        doc?.lorry_no ||
        "",

      weight:
        Number(
          doc?.weight ??
            doc?.quantity ??
            0
        ) || 0,

      remaining_qty:
        Number(
          doc?.remaining_qty ??
            doc?.weight ??
            doc?.quantity ??
            0
        ) || 0,
    });
  }

  return result;
}

/*
====================================================
IMPORT XLSX ROWS
====================================================
*/

async function importInwardRows(
  rows,
  res,
  req
) {
  if (!ensureMongo(res)) {
    return;
  }

  let inserted = 0;
  let skipped = 0;

  const errors = [];

  let nextSl =
    await getNextInwardSlNo();

  for (
    let index = 0;
    index < rows.length;
    index += 1
  ) {
    const row =
      rows[index] || {};

    const date =
      normalizeDate(
        row?.date
      );

    const weight =
      Number(
        row?.weight || 0
      ) || 0;

    const lorryNo =
      stringValue(
        row?.lorry_no
      ) || null;

    const missing = [];

    if (!date) {
      missing.push(
        "date"
      );
    }

    const masters =
      await resolveInwardMasters(
        row
      );

    if (!masters.warehouse) {
      missing.push(
        "warehouse"
      );
    }

    if (!masters.product) {
      missing.push(
        "product"
      );
    }

    if (!masters.company) {
      missing.push(
        "company"
      );
    }

    if (
      missing.length > 0
    ) {
      skipped += 1;

      errors.push({
        row:
          index + 2,

        error:
          `Missing or unmatched required field(s): ${missing.join(
            ", "
          )}`,

        sample_row:
          buildSampleRow(
            row
          ),
      });

      continue;
    }

    /*
     * Warehouse permission
     */
    const warehouseId =
      masters.warehouse?._id;

    if (
      !canAccessWarehouse(
        req.user,
        warehouseId
      )
    ) {
      skipped += 1;

      errors.push({
        row:
          index + 2,

        error:
          "You can only import entries for your assigned warehouse",

        sample_row:
          buildSampleRow(
            row
          ),
      });

      continue;
    }

    /*
     * Company account is optional.
     */
    const masterNames =
      buildMasterNames(
        masters
      );

    const voucherNo =
      formatVoucher(
        nextSl
      );

    try {
      await MongoInward.create({
        legacy_id:
          nextSl,

        sl_no:
          nextSl,

        voucher_no:
          voucherNo,

        date,

        employee_id:
          masters.employee?._id ??
          null,

        location_id:
          masters.location?._id ??
          null,

        warehouse_id:
          masters.warehouse?._id ??
          null,

        product_id:
          masters.product?._id ??
          null,

        company_id:
          masters.company?._id ??
          null,

        company_account_id:
          masters.companyAccount?._id ??
          null,

        ...masterNames,

        lorry_no:
          lorryNo,

        weight,

        quantity:
          weight,

        remaining_qty:
          weight,

        shortage_percent:
          normalizeShortagePercent(
            row?.shortage_percent
          ),

        created_at:
          new Date(),

        updated_at:
          new Date(),
      });

      inserted += 1;
      nextSl += 1;
    } catch (error) {
      skipped += 1;

      errors.push({
        row:
          index + 2,

        error:
          error.message,

        sample_row:
          buildSampleRow(
            row
          ),
      });
    }
  }

  return res.json({
    total:
      rows.length,

    inserted,

    skipped,

    errors,

    source:
      "mongodb",
  });
}

/*
====================================================
TEMPLATE XLSX
====================================================
*/

router.get(
  "/template-xlsx",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "inward.export"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to download inward template",
        });
    }

    const workbook =
      XLSX.utils.book_new();

    const ws =
      XLSX.utils.json_to_sheet(
        buildInwardTemplateRows()
      );

    XLSX.utils.book_append_sheet(
      workbook,
      ws,
      "Inward Template"
    );

    const buffer =
      XLSX.write(
        workbook,
        {
          bookType:
            "xlsx",
          type:
            "buffer",
        }
      );

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="inward-template.xlsx"'
    );

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    return res.send(
      buffer
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
    console.log(
      "[inward.import] request",
      {
        origin:
          req.headers.origin ||
          "",

        method:
          req.method,

        contentType:
          req.headers[
            "content-type"
          ] || "",

        hasFile:
          !!req.file?.buffer,

        fileName:
          req.file
            ?.originalname ||
          "",

        fileSize:
          req.file?.size ||
          0,
      }
    );

    if (
      !userHasPermission(
        req.user,
        "inward.import"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to import inward entries",
        });
    }

    if (
      !req.file?.buffer
    ) {
      return res
        .status(400)
        .json({
          error:
            "XLSX file is required",
        });
    }

    if (!ensureMongo(res)) {
      return;
    }

    let rows = [];

    try {
      const workbook =
        XLSX.read(
          req.file.buffer,
          {
            type:
              "buffer",
            cellDates:
              true,
          }
        );

      const firstSheet =
        workbook
          .SheetNames?.[0];

      if (!firstSheet) {
        return res
          .status(400)
          .json({
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
            defval:
              "",
          }
        );
    } catch (error) {
      return res
        .status(400)
        .json({
          error:
            "Invalid XLSX file",
        });
    }

    const normalized =
      (
        Array.isArray(
          rows
        )
          ? rows
          : []
      ).map(
        normalizeInwardImportRow
      );

    if (
      normalized.length ===
      0
    ) {
      return res
        .status(400)
        .json({
          error:
            "No rows found in XLSX",
        });
    }

    return importInwardRows(
      normalized,
      res,
      req
    );
  }
);

/*
====================================================
GET INWARD LIST
====================================================
*/

router.get(
  "/",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "inward.view"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to view inward entries",
        });
    }

    if (!ensureMongo(res)) {
      return;
    }

    try {
      const docs =
        await MongoInward.find({})
          .sort({
            legacy_id:
              -1,

            sl_no:
              -1,

            date:
              -1,

            _id:
              -1,
          })
          .lean();

      const rows =
        await decorateMongoInwardDocs(
          docs
        );

      const filtered =
        rows.filter(
          (row) =>
            !row.warehouse_id ||
            canAccessWarehouse(
              req.user,
              row.warehouse_id
            )
        );

      return res.json(
        filtered
      );
    } catch (error) {
      console.error(
        "Mongo inward list failed:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }
  }
);

/*
====================================================
CREATE INWARD
====================================================
*/

router.post(
  "/",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "inward.create"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to create inward entries",
        });
    }

    if (!ensureMongo(res)) {
      return;
    }

    const {
      date,
      employee_id,
      location_id,
      warehouse_id,
      product_id,
      company_id,
      company_account_id,
      lorry_no,
      weight,
      shortage_percent,
    } = req.body;

    if (!date) {
      return res
        .status(400)
        .json({
          error:
            "Date is required",
        });
    }

    if (
      !warehouse_id
    ) {
      return res
        .status(400)
        .json({
          error:
            "Warehouse is required",
        });
    }

    const normalizedDate =
      normalizeDate(
        date
      );

    if (
      !normalizedDate
    ) {
      return res
        .status(400)
        .json({
          error:
            "Invalid date",
        });
    }

    const weightNumber =
      Number(
        weight
      ) || 0;

    try {
      if (
        !canAccessWarehouse(
          req.user,
          warehouse_id
        )
      ) {
        return res
          .status(403)
          .json({
            error:
              "You can only create entries for your assigned warehouse",
          });
      }

      const masters =
        await resolveInwardMasters({
          employee_id,
          location_id,
          warehouse_id,
          product_id,
          company_id,
          company_account_id,
        });

      if (
        !masters.warehouse
      ) {
        return res
          .status(400)
          .json({
            error:
              "Warehouse not found",
          });
      }

      if (
        !masters.product
      ) {
        return res
          .status(400)
          .json({
            error:
              "Product not found",
          });
      }

      if (
        !masters.company
      ) {
        return res
          .status(400)
          .json({
            error:
              "Company not found",
          });
      }

      const nextSl =
        await getNextInwardSlNo();

      const voucherNo =
        formatVoucher(
          nextSl
        );

      const masterNames =
        buildMasterNames(
          masters
        );

      const doc =
        await MongoInward.create({
          legacy_id:
            nextSl,

          sl_no:
            nextSl,

          voucher_no:
            voucherNo,

          date:
            normalizedDate,

          employee_id:
            masters.employee?._id ??
            null,

          location_id:
            masters.location?._id ??
            null,

          warehouse_id:
            masters.warehouse?._id ??
            warehouse_id,

          product_id:
            masters.product?._id ??
            product_id ??
            null,

          company_id:
            masters.company?._id ??
            company_id ??
            null,

          company_account_id:
            masters.companyAccount?._id ??
            null,

          ...masterNames,

          lorry_no:
            stringValue(
              lorry_no
            ) || null,

          weight:
            weightNumber,

          quantity:
            weightNumber,

          remaining_qty:
            weightNumber,

          shortage_percent:
            normalizeShortagePercent(
              shortage_percent
            ),

          created_at:
            new Date(),

          updated_at:
            new Date(),
        });

      return res.json({
        id:
          doc.legacy_id ??
          String(
            doc._id
          ),

        sl_no:
          doc.sl_no,

        voucher_no:
          doc.voucher_no,

        source:
          "mongodb",
      });
    } catch (error) {
      console.error(
        "Mongo inward create failed:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }
  }
);

/*
====================================================
UPDATE INWARD
====================================================
*/

router.put(
  "/:id",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "inward.edit"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to edit inward entries",
        });
    }

    if (!ensureMongo(res)) {
      return;
    }

    const {
      id,
    } = req.params;

    const {
      date,
      employee_id,
      location_id,
      warehouse_id,
      product_id,
      company_id,
      company_account_id,
      lorry_no,
      weight,
      shortage_percent,
    } = req.body;

    if (!date) {
      return res
        .status(400)
        .json({
          error:
            "Date is required",
        });
    }

    const normalizedDate =
      normalizeDate(
        date
      );

    if (
      !normalizedDate
    ) {
      return res
        .status(400)
        .json({
          error:
            "Invalid date",
        });
    }

    if (
      !warehouse_id
    ) {
      return res
        .status(400)
        .json({
          error:
            "Warehouse is required",
        });
    }

    const weightNumber =
      Number(
        weight
      ) || 0;

    try {
      const query =
        isValidObjectId(
          id
        )
          ? {
              _id: id,
            }
          : {
              legacy_id:
                Number(id),
            };

      const existing =
        await MongoInward.findOne(
          query
        ).lean();

      if (!existing) {
        return res
          .status(404)
          .json({
            error:
              "Inward not found",
          });
      }

      if (
        !canAccessWarehouse(
          req.user,
          existing.warehouse_id
        )
      ) {
        return res
          .status(403)
          .json({
            error:
              "You can only edit entries for your assigned warehouse",
          });
      }

      if (
        !canAccessWarehouse(
          req.user,
          warehouse_id
        )
      ) {
        return res
          .status(403)
          .json({
            error:
              "You can only edit entries for your assigned warehouse",
          });
      }

      const masters =
        await resolveInwardMasters({
          employee_id,
          location_id,
          warehouse_id,
          product_id,
          company_id,
          company_account_id,
        });

      if (
        !masters.warehouse
      ) {
        return res
          .status(400)
          .json({
            error:
              "Warehouse not found",
          });
      }

      if (
        !masters.product
      ) {
        return res
          .status(400)
          .json({
            error:
              "Product not found",
          });
      }

      if (
        !masters.company
      ) {
        return res
          .status(400)
          .json({
            error:
              "Company not found",
          });
      }

      const masterNames =
        buildMasterNames(
          masters
        );

      const updated =
        await MongoInward.findOneAndUpdate(
          query,
          {
            $set: {
              date:
                normalizedDate,

              employee_id:
                masters.employee?._id ??
                null,

              location_id:
                masters.location?._id ??
                null,

              warehouse_id:
                masters.warehouse?._id ??
                warehouse_id,

              product_id:
                masters.product?._id ??
                product_id ??
                null,

              company_id:
                masters.company?._id ??
                company_id ??
                null,

              company_account_id:
                masters.companyAccount?._id ??
                null,

              ...masterNames,

              lorry_no:
                stringValue(
                  lorry_no
                ) || null,

              weight:
                weightNumber,

              quantity:
                weightNumber,

              remaining_qty:
                weightNumber,

              shortage_percent:
                normalizeShortagePercent(
                  shortage_percent
                ),

              updated_at:
                new Date(),
            },
          },
          {
            new:
              true,
          }
        ).lean();

      return res.json({
        updated:
          1,

        id:
          updated?.legacy_id !=
          null
            ? updated.legacy_id
            : String(
                updated?._id
              ),

        source:
          "mongodb",
      });
    } catch (error) {
      console.error(
        "Mongo inward update failed:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }
  }
);

/*
====================================================
DELETE INWARD
====================================================
*/

router.delete(
  "/:id",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "inward.delete"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to delete inward entries",
        });
    }

    if (!ensureMongo(res)) {
      return;
    }

    const {
      id,
    } = req.params;

    try {
      const query =
        isValidObjectId(
          id
        )
          ? {
              _id: id,
            }
          : {
              legacy_id:
                Number(id),
            };

      const existing =
        await MongoInward.findOne(
          query
        ).lean();

      if (!existing) {
        return res
          .status(404)
          .json({
            error:
              "Inward not found",
          });
      }

      if (
        !canAccessWarehouse(
          req.user,
          existing.warehouse_id
        )
      ) {
        return res
          .status(403)
          .json({
            error:
              "You can only delete entries for your assigned warehouse",
          });
      }

      const result =
        await MongoInward.deleteOne(
          query
        );

      return res.json({
        deleted:
          Number(
            result.deletedCount ||
              0
          ),

        source:
          "mongodb",
      });
    } catch (error) {
      console.error(
        "Mongo inward delete failed:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }
  }
);

/*
====================================================
INWARD REPORT
====================================================
*/

router.get(
  "/report",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "reports.view"
      ) &&
      !userHasPermission(
        req.user,
        "inward.view"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to view this report",
        });
    }

    if (!ensureMongo(res)) {
      return;
    }

    const {
      company_id,
      warehouse_id,
      from_date,
      to_date,
    } = req.query;

    try {
      const filter = {};

      /*
       * Company
       */
      if (
        company_id
      ) {
        if (
          isValidObjectId(
            company_id
          )
        ) {
          filter.company_id =
            company_id;
        } else {
          const company =
            await findMongoMasterByIdOrName(
              Company,
              company_id,
              company_id,
              [
                "legacy_id",
                "id",
              ]
            );

          if (company?._id) {
            filter.company_id =
              company._id;
          } else {
            return res.json(
              []
            );
          }
        }
      }

      /*
       * Warehouse
       */
      if (
        warehouse_id
      ) {
        if (
          !canAccessWarehouse(
            req.user,
            warehouse_id
          )
        ) {
          return res
            .status(403)
            .json({
              error:
                "You can only view your assigned warehouse data",
            });
        }

        if (
          isValidObjectId(
            warehouse_id
          )
        ) {
          filter.warehouse_id =
            warehouse_id;
        } else {
          const warehouse =
            await findMongoMasterByIdOrName(
              Warehouse,
              warehouse_id,
              warehouse_id,
              [
                "legacy_id",
                "id",
              ]
            );

          if (
            warehouse?._id
          ) {
            filter.warehouse_id =
              warehouse._id;
          } else {
            return res.json(
              []
            );
          }
        }
      }

      /*
       * Date range
       */
      if (
        from_date ||
        to_date
      ) {
        filter.date = {};
      }

      if (
        from_date
      ) {
        const from =
          normalizeDate(
            from_date
          );

        if (from) {
          filter.date.$gte =
            from;
        }
      }

      if (
        to_date
      ) {
        const to =
          normalizeDate(
            to_date
          );

        if (to) {
          /*
           * Include whole end day.
           */
          to.setUTCHours(
            23,
            59,
            59,
            999
          );

          filter.date.$lte =
            to;
        }
      }

      const docs =
        await MongoInward.find(
          filter
        )
          .sort({
            date: -1,
            legacy_id: -1,
            _id: -1,
          })
          .lean();

      const rows =
        await decorateMongoInwardDocs(
          docs
        );

      const filtered =
        rows.filter(
          (row) =>
            !row.warehouse_id ||
            canAccessWarehouse(
              req.user,
              row.warehouse_id
            )
        );

      return res.json(
        filtered
      );
    } catch (error) {
      console.error(
        "Mongo inward report failed:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }
  }
);

module.exports = router;
