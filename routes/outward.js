const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const XLSX = require("xlsx");

const router = express.Router();

const {
  userHasPermission,
} = require("../middleware/auth");

const {
  canAccessWarehouse,
} = require("../helpers/access");

const {
  Location: MongoLocation,
  Employee: MongoEmployee,
  Warehouse: MongoWarehouse,
  Product: MongoProduct,
  Company: MongoCompany,
  CompanyAccount: MongoCompanyAccount,
  Inward: MongoInward,
  Outward: MongoOutward,
  StockJournal: MongoStockJournal,
  MirrorRow,
  isMongoMirrorReady,
} = require("../db-mongodb");

const upload = multer({
  storage: multer.memoryStorage(),
});

/*
====================================================
GENERAL HELPERS
====================================================
*/

function mongoReady() {
  return isMongoMirrorReady();
}

function ensureMongo(res) {
  if (!mongoReady()) {
    res.status(503).json({
      error: "MongoDB is not connected",
    });
    return false;
  }

  return true;
}

function safeNumber(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return 0;
  }

  const numberValue = Number(value);

  return Number.isFinite(numberValue)
    ? numberValue
    : 0;
}

function safeText(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  return String(value).trim() || null;
}

function normalizeId(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  if (
    typeof value === "object" &&
    value !== null
  ) {
    if (
      value._id !== undefined &&
      value._id !== null
    ) {
      return String(value._id);
    }

    if (
      value.id !== undefined &&
      value.id !== null
    ) {
      return String(value.id);
    }
  }

  return String(value);
}

/*
 * Mongo schemas in this project use Mixed IDs in several places, so the
 * same logical ID can exist as an ObjectId, string, or legacy numeric value.
 * Build all safe representations for stock queries.
 */
function mixedIdCandidates(value) {
  const normalized = normalizeId(value);

  if (!normalized) {
    return [];
  }

  const candidates = [normalized];

  if (isValidObjectId(normalized)) {
    candidates.push(
      new mongoose.Types.ObjectId(normalized)
    );
  }

  const numeric = Number(normalized);

  if (Number.isFinite(numeric)) {
    candidates.push(numeric);
  }

  const unique = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const key =
      candidate instanceof mongoose.Types.ObjectId
        ? `objectId:${candidate.toHexString()}`
        : `${typeof candidate}:${String(candidate)}`;

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(candidate);
    }
  }

  return unique;
}

function isValidObjectId(value) {
  try {
    return mongoose.Types.ObjectId.isValid(
      String(value ?? "")
    );
  } catch {
    return false;
  }
}

function formatOutwardVoucher(slNo) {
  return `OUT-${String(slNo).padStart(4, "0")}`;
}

function normalizeDate(value) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return null;
  }

  if (
    value instanceof Date &&
    !Number.isNaN(value.getTime())
  ) {
    return value;
  }

  const text = String(value).trim();

  const yyyyMmDd = text.match(
    /^(\d{4})-(\d{2})-(\d{2})$/
  );

  if (yyyyMmDd) {
    const parsed = new Date(
      `${yyyyMmDd[1]}-${yyyyMmDd[2]}-${yyyyMmDd[3]}T00:00:00.000Z`
    );

    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const parsed = new Date(text);

  return Number.isNaN(parsed.getTime())
    ? null
    : parsed;
}

function normalizeSelfLoading(value) {
  return (
    String(value || "No")
      .trim()
      .toLowerCase() === "yes"
      ? "Yes"
      : "No"
  );
}

function isSelfLoadingOutward(row) {
  return (
    normalizeSelfLoading(
      row?.self_loading
    ) === "Yes"
  );
}

function canAccessOutwardRow(user, row) {
  if (!row) {
    return false;
  }

  if (isSelfLoadingOutward(row)) {
    return true;
  }

  return canAccessWarehouse(
    user,
    row.warehouse_id
  );
}

function escapeRegExp(value) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

/*
====================================================
MASTER LOOKUP
====================================================
*/

async function findMasterByIdOrLegacyOrName(
  Model,
  idValue,
  nameValue,
  legacyFields = []
) {
  if (!Model) {
    return null;
  }

  const rawId =
    normalizeId(idValue);

  const rawName =
    safeText(nameValue);

  /*
   * Mongo ObjectId
   */
  if (
    rawId &&
    isValidObjectId(rawId)
  ) {
    try {
      const doc =
        await Model.findById(
          rawId
        ).lean();

      if (doc) {
        return doc;
      }
    } catch {}
  }

  /*
   * Legacy numeric/string ID
   */
  if (rawId) {
    for (
      const field of legacyFields
    ) {
      try {
        const doc =
          await Model.findOne({
            [field]: rawId,
          }).lean();

        if (doc) {
          return doc;
        }
      } catch {}

      const numeric =
        Number(rawId);

      if (
        Number.isFinite(numeric)
      ) {
        try {
          const doc =
            await Model.findOne({
              [field]:
                numeric,
            }).lean();

          if (doc) {
            return doc;
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
      const regex =
        new RegExp(
          `^${escapeRegExp(
            rawName
          )}$`,
          "i"
        );

      const byName =
        await Model.findOne({
          name: regex,
        }).lean();

      if (byName) {
        return byName;
      }

      // Spreadsheet exports frequently vary only in spacing (for example,
      // "NOOR   MAHAMMAD" versus "NOOR MAHAMMAD"). Treat that as the same
      // master name, while preserving an exact match for every actual word.
      const nameParts = rawName.split(/\s+/).filter(Boolean);
      if (nameParts.length > 1) {
        const flexibleWhitespaceRegex = new RegExp(
          `^${nameParts.map(escapeRegExp).join("\\s+")}$`,
          "i"
        );
        const byFlexibleName = await Model.findOne({
          name: flexibleWhitespaceRegex,
        }).lean();

        if (byFlexibleName) {
          return byFlexibleName;
        }
      }
    } catch {}
  }

  /*
   * Company account uses account_name
   */
  if (
    rawName &&
    Model === MongoCompanyAccount
  ) {
    try {
      const regex =
        new RegExp(
          `^${escapeRegExp(
            rawName
          )}$`,
          "i"
        );

      const byAccountName =
        await Model.findOne({
          account_name:
            regex,
        }).lean();

      if (byAccountName) {
        return byAccountName;
      }
    } catch {}
  }

  return null;
}

async function resolveOutwardMasters(
  body
) {
  const [
    employee,
    location,
    warehouse,
    product,
    company,
  ] = await Promise.all([
    findMasterByIdOrLegacyOrName(
      MongoEmployee,
      body?.employee_id,
      body?.employee_name,
      [
        "employee_id",
        "legacy_id",
        "id",
      ]
    ),

    findMasterByIdOrLegacyOrName(
      MongoLocation,
      body?.location_id,
      body?.location_name,
      [
        "legacy_id",
        "id",
      ]
    ),

    findMasterByIdOrLegacyOrName(
      MongoWarehouse,
      body?.warehouse_id,
      body?.warehouse_name,
      [
        "legacy_id",
        "id",
      ]
    ),

    findMasterByIdOrLegacyOrName(
      MongoProduct,
      body?.product_id,
      body?.product_name,
      [
        "legacy_id",
        "id",
      ]
    ),

    findMasterByIdOrLegacyOrName(
      MongoCompany,
      body?.company_id,
      body?.company_name,
      [
        "legacy_id",
        "id",
      ]
    ),
  ]);

  let companyAccount =
    await findMasterByIdOrLegacyOrName(
      MongoCompanyAccount,
      body?.company_account_id,
      body?.company_account_name,
      [
        "legacy_id",
        "id",
      ]
    );

  /*
   * Resolve first company account of the company
   * when account ID is not supplied.
   */
  if (
    !companyAccount &&
    company?._id
  ) {
    try {
      companyAccount =
        await MongoCompanyAccount.findOne({
          company_id:
            company._id,
        })
          .sort({
            _id: 1,
          })
          .lean();
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

function masterNames(masters) {
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
TEMPLATE
====================================================
*/

function buildOutwardTemplateRows() {
  return [
    {
      date: "2026-07-21",
      employee_name:
        "Employee Name",
      location_name:
        "Location Name",
      warehouse_name:
        "Warehouse Name",
      product_name:
        "Product Name",
      company_name:
        "Company Name",
      company_account_name:
        "Company Account Name",
      lorry_no:
        "WB00A0000",
      weight: 0,
      rate: 0,
      inv_no:
        "INV-001",
      buyer_name:
        "Buyer Name",
      consignee_name:
        "Consignee Name",
      self_loading:
        "No",
    },
  ];
}

/*
====================================================
XLSX NORMALIZATION
====================================================
*/

function normalizeOutwardImportRow(
  row
) {
  return {
    date:
      row?.date ??
      row?.Date ??
      "",

    employee_id:
      row?.employee_id ??
      row?.EmployeeID ??
      row?.EmployeeId ??
      "",

    employee_name:
      row?.employee_name ??
      row?.EmployeeName ??
      row?.["Employee Name"] ??
      row?.Employee ??
      "",

    location_id:
      row?.location_id ??
      row?.LocationID ??
      row?.LocationId ??
      "",

    location_name:
      row?.location_name ??
      row?.LocationName ??
      row?.["Location Name"] ??
      row?.Location ??
      "",

    warehouse_id:
      row?.warehouse_id ??
      row?.WarehouseID ??
      row?.WarehouseId ??
      "",

    warehouse_name:
      row?.warehouse_name ??
      row?.WarehouseName ??
      row?.["Warehouse Name"] ??
      row?.Warehouse ??
      "",

    product_id:
      row?.product_id ??
      row?.ProductID ??
      row?.ProductId ??
      "",

    product_name:
      row?.product_name ??
      row?.ProductName ??
      row?.["Product Name"] ??
      row?.Product ??
      "",

    company_id:
      row?.company_id ??
      row?.CompanyID ??
      row?.CompanyId ??
      "",

    company_name:
      row?.company_name ??
      row?.CompanyName ??
      row?.["Company Name"] ??
      row?.Company ??
      "",

    company_account_id:
      row?.company_account_id ??
      row?.CompanyAccountID ??
      row?.CompanyAccountId ??
      "",

    company_account_name:
      row?.company_account_name ??
      row?.CompanyAccountName ??
      row?.["Company Account Name"] ??
      row?.["Company Account"] ??
      row?.CompanyAccount ??
      "",

    lorry_no:
      row?.lorry_no ??
      row?.LorryNo ??
      row?.["Lorry No"] ??
      row?.Lorry ??
      "",

    weight:
      row?.weight ??
      row?.Weight ??
      "",

    quantity:
      row?.quantity ??
      row?.Quantity ??
      "",

    rate:
      row?.rate ??
      row?.Rate ??
      "",

    inv_no:
      row?.inv_no ??
      row?.InvNo ??
      row?.["Invoice No"] ??
      row?.InvoiceNo ??
      "",

    buyer_name:
      row?.buyer_name ??
      row?.BuyerName ??
      row?.["Buyer Name"] ??
      row?.Buyer ??
      "",

    consignee_name:
      row?.consignee_name ??
      row?.ConsigneeName ??
      row?.["Consignee Name"] ??
      row?.Consignee ??
      "",

    self_loading:
      row?.self_loading ??
      row?.SelfLoading ??
      row?.["Self Loading"] ??
      "No",
  };
}

/*
====================================================
NEXT OUTWARD SERIAL
====================================================
*/

async function getNextOutwardSlNo() {
  const last =
    await MongoOutward.findOne({})
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

  const current =
    Number(
      last?.sl_no ??
        last?.legacy_id ??
        0
    ) || 0;

  return current + 1;
}

/*
====================================================
OUTWARD IDENTIFIER
====================================================
*/

async function findMongoOutward(
  id
) {
  if (
    isValidObjectId(id)
  ) {
    const byObjectId =
      await MongoOutward.findById(
        id
      ).lean();

    if (byObjectId) {
      return byObjectId;
    }
  }

  const numeric =
    Number(id);

  if (
    Number.isFinite(numeric)
  ) {
    const byLegacyId =
      await MongoOutward.findOne({
        legacy_id:
          numeric,
      }).lean();

    if (byLegacyId) {
      return byLegacyId;
    }

    const bySlNo =
      await MongoOutward.findOne({
        sl_no:
          numeric,
      }).lean();

    if (bySlNo) {
      return bySlNo;
    }
  }

  const byVoucher =
    await MongoOutward.findOne({
      $or: [
        {
          voucher_no:
            String(id),
        },
        {
          outward_no:
            String(id),
        },
        {
          inv_no:
            String(id),
        },
      ],
    }).lean();

  return byVoucher;
}

/*
====================================================
DISPLAY DECORATION
====================================================
*/

async function decorateOutwardDocs(
  docs
) {
  const result = await Promise.all(
    (docs || []).map(async (doc) => {
    const masters =
      await resolveOutwardMasters({
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
      masterNames(
        masters
      );

    const outwardNo =
      doc?.outward_no ||
      doc?.voucher_no ||
      doc?.inv_no ||
      "";

    return {
      ...doc,

      mongo_id:
        String(
          doc?._id
        ),

      id:
        doc?.legacy_id ??
        doc?.sl_no ??
        String(
          doc?._id
        ),

      legacy_id:
        doc?.legacy_id ??
        null,

      sl_no:
        doc?.sl_no ??
        doc?.legacy_id ??
        null,

      voucher_no:
        outwardNo,

      outward_no:
        doc?.outward_no ||
        outwardNo,

      date:
        normalizeDate(
          doc?.date
        )
          ? normalizeDate(
              doc?.date
            )
              .toISOString()
              .slice(0, 10)
          : safeText(
              doc?.date
            ) || "",

      employee_name:
        names.employee_name ||
        doc?.employee_name ||
        "",

      location_name:
        names.location_name ||
        doc?.location_name ||
        doc?.location ||
        "",

      warehouse_name:
        names.warehouse_name ||
        doc?.warehouse_name ||
        "",

      product_name:
        names.product_name ||
        doc?.product_name ||
        doc?.product ||
        "",

      company_name:
        names.company_name ||
        doc?.company_name ||
        doc?.buyer_name ||
        doc?.buyer ||
        "",

      company_account_name:
        names.company_account_name ||
        doc?.company_account_name ||
        "",

      party_name:
        names.company_account_name ||
        doc?.party_name ||
        doc?.company_account_name ||
        "",

      quantity:
        safeNumber(
          doc?.quantity ??
            doc?.weight
        ),

      weight:
        safeNumber(
          doc?.weight ??
            doc?.quantity
        ),

      rate:
        safeNumber(
          doc?.rate
        ),

      amount:
        safeNumber(
          doc?.amount
        ),
    };
    })
  );

  return result;
}

/*
====================================================
MIRROR ADJUSTMENT HELPERS
====================================================
*/

/*
 * Existing Adjustment mongoose schema does not contain:
 * inward_id / outward_id / qty.
 *
 * Therefore legacy FIFO adjustment rows are kept in
 * MirrorRow with table = "adjustment".
 */

async function getAdjustmentRows() {
  if (
    !MirrorRow ||
    typeof
      MirrorRow.find !==
        "function"
  ) {
    return [];
  }

  const rows =
    await MirrorRow.find({
      table:
        "adjustment",
    })
      .sort({
        row_id: 1,
      })
      .lean();

  return (
    rows || []
  ).map(
    (row) => ({
      id:
        row?.row_id,

      ...(row?.data || {}),
    })
  );
}

async function getAdjustmentsForOutward(
  outwardId
) {
  const rows =
    await getAdjustmentRows();

  const normalized =
    normalizeId(
      outwardId
    );

  return rows.filter(
    (row) =>
      normalizeId(
        row?.outward_id
      ) === normalized
  );
}

async function getAdjustedQtyForOutward(
  outwardId
) {
  const rows =
    await getAdjustmentsForOutward(
      outwardId
    );

  return rows.reduce(
    (sum, row) =>
      sum +
      safeNumber(
        row?.qty
      ),
    0
  );
}

async function getNextAdjustmentMirrorId() {
  const last =
    await MirrorRow.findOne({
      table:
        "adjustment",
    })
      .sort({
        row_id:
          -1,
      })
      .select({
        row_id:
          1,
      })
      .lean();

  return (
    Number(
      last?.row_id ||
        0
    ) + 1
  );
}

async function createAdjustmentMirrorRow(
  payload
) {
  const rowId =
    await getNextAdjustmentMirrorId();

  await MirrorRow.updateOne(
    {
      table:
        "adjustment",

      row_id:
        rowId,
    },
    {
      $set: {
        data:
          payload,

        updated_at:
          new Date(),
      },
    },
    {
      upsert:
        true,
    }
  ).exec();

  return rowId;
}

/*
====================================================
AVAILABLE STOCK
====================================================
*/

async function getAvailableWarehouseStock({
  warehouse_id,
  product_id,
  outwardId = null,
}) {
  if (
    !warehouse_id ||
    !product_id
  ) {
    return {
      currentStock: 0,
      reservedStock: 0,
      availableStock: 0,
    };
  }

  const warehouseCandidates = mixedIdCandidates(warehouse_id);
  const productCandidates = mixedIdCandidates(product_id);

  if (
    warehouseCandidates.length === 0 ||
    productCandidates.length === 0
  ) {
    return {
      currentStock: 0,
      reservedStock: 0,
      availableStock: 0,
    };
  }

  /*
   * IMPORTANT STOCK RULE:
   * Outward entry is only an outward entry/reservation.
   * It must NOT be subtracted from warehouse available stock.
   * Actual warehouse stock is represented by Inward.remaining_qty.
   *
   * Example:
   * Inward 100 | Outward 60 | Adjustment 50
   * Current 100 | Outward Entry 60 | Available 50
   * Pending adjustment = 10
   *
   * Keep the rest of the outward logic unchanged.
   */
  const inwardRows = await MongoInward.find({
    warehouse_id: {
      $in: warehouseCandidates,
    },
    product_id: {
      $in: productCandidates,
    },
  })
    .select({
      remaining_qty: 1,
      weight: 1,
      quantity: 1,
      date: 1,
      legacy_id: 1,
      shortage_percent: 1,
      id: 1,
      sl_no: 1,
    })
    .lean();

  // Match the Stock Report formula used on Dashboard / Party Stock:
  // Available = Inward (Gross) - Shortage - Already Adjusted.
  // Do not use Inward.remaining_qty here because that can already include
  // adjustments and would make the Outward Entry stock disagree with the
  // Stock Report.
  const adjustmentRows = MirrorRow && typeof MirrorRow.find === "function"
    ? await MirrorRow.find({ table: "adjustment" }).select({ row_id: 1, data: 1 }).lean()
    : [];
  const adjustedByInward = new Map();

  for (const mirrorRow of adjustmentRows || []) {
    const data = mirrorRow?.data || {};
    if (String(data?.source_type || "inward").trim().toLowerCase() !== "inward") continue;
    const inwardId = String(data?.inward_id ?? "").trim();
    if (!inwardId) continue;
    const qty = safeNumber(data?.qty ?? data?.quantity);
    if (!qty) continue;
    adjustedByInward.set(
      inwardId,
      (adjustedByInward.get(inwardId) || 0) + qty
    );
  }

  let currentStock = 0;
  let availableStock = 0;

  for (const row of inwardRows) {
    const grossQty = safeNumber(
      row?.weight ?? row?.quantity
    );

    const shortageQty = Math.max(
      0,
      safeNumber(
        calculateShortageQty(
          grossQty,
          1,
          row?.shortage_percent
        )
      )
    );

    const inwardAliases = [
      row?._id,
      row?.legacy_id,
      row?.id,
      row?.sl_no,
    ]
      .filter((value) => value !== undefined && value !== null && String(value).trim() !== "")
      .map(String);

    let adjustedQty = 0;
    for (const alias of inwardAliases) {
      if (adjustedByInward.has(alias)) {
        adjustedQty = safeNumber(adjustedByInward.get(alias));
        break;
      }
    }

    currentStock += grossQty;
    availableStock += Math.max(
      grossQty - shortageQty - adjustedQty,
      0
    );
  }

  return {
    currentStock,
    // Kept for compatibility with the existing API/UI.
    // Outward entries are NOT deducted here.
    reservedStock: 0,
    availableStock: Math.max(availableStock, 0),
  };
}

async function validateOutwardStock({
  warehouse_id,
  product_id,
  qty,
  outwardId = null,
}) {
  const stock =
    await getAvailableWarehouseStock({
      warehouse_id,
      product_id,
      outwardId,
    });

  const requestedQty =
    safeNumber(qty);

  if (
    stock.availableStock <
    requestedQty
  ) {
    return {
      ok:
        false,

      error:
        `Not enough stock in this warehouse. Available stock is ${stock.availableStock.toFixed(
          2
        )}.`,

      stock,
    };
  }

  return {
    ok:
      true,

    stock,
  };
}

/*
====================================================
TEMPLATE ROUTES
====================================================
*/

router.options(
  "/template-xlsx",
  (req, res) =>
    res.sendStatus(204)
);

router.options(
  "/import-xlsx",
  (req, res) =>
    res.sendStatus(204)
);

router.get(
  "/template-xlsx",
  (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "outward.export"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to download outward template",
        });
    }

    const workbook =
      XLSX.utils.book_new();

    const ws =
      XLSX.utils.json_to_sheet(
        buildOutwardTemplateRows()
      );

    XLSX.utils.book_append_sheet(
      workbook,
      ws,
      "Outward Template"
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
      'attachment; filename="outward-template.xlsx"'
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
XLSX IMPORT
====================================================
*/

async function importOutwardRows(
  rows,
  req,
  res
) {
  if (!ensureMongo(res)) {
    return;
  }

  let inserted =
    0;

  let skipped =
    0;

  const errors =
    [];

  let nextSl =
    await getNextOutwardSlNo();

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

    const qty =
      safeNumber(
        row?.quantity ??
          row?.weight
      );

    const rate =
      safeNumber(
        row?.rate
      );

    const amount =
      qty * rate;

    const selfLoading =
      normalizeSelfLoading(
        row?.self_loading
      );

    const missing =
      [];

    if (!date) {
      missing.push(
        "date"
      );
    }

    const masters =
      await resolveOutwardMasters(
        row
      );

    if (
      !masters.product
    ) {
      missing.push(
        "product"
      );
    }

    if (
      !masters.company
    ) {
      missing.push(
        "company"
      );
    }

    if (
      !selfLoading &&
      !masters.warehouse
    ) {
      missing.push(
        "warehouse"
      );
    }

    if (
      missing.length
    ) {
      skipped +=
        1;

      errors.push({
        row:
          index + 2,

        error:
          `Missing or unmatched required field(s): ${missing.join(
            ", "
          )}`,

        // Return the interpreted row values so the upload screen can show
        // exactly which Product/Company/Warehouse value could not be matched.
        sample_row: {
          product: row?.product_name || row?.product_id || "",
          company: row?.company_name || row?.company_id || "",
          warehouse: row?.warehouse_name || row?.warehouse_id || "",
        },
      });

      continue;
    }

    const warehouseId =
      selfLoading ===
      "Yes"
        ? null
        : masters.warehouse
            ?._id;

    if (
      warehouseId &&
      !canAccessWarehouse(
        req.user,
        warehouseId
      )
    ) {
      skipped +=
        1;

      errors.push({
        row:
          index + 2,

        error:
          "You can only import entries for your assigned warehouse",
      });

      continue;
    }

    const nextVoucher =
      formatOutwardVoucher(
        nextSl
      );

    const names =
      masterNames(
        masters
      );

    try {
      await MongoOutward.create({
        legacy_id:
          nextSl,

        sl_no:
          nextSl,

        voucher_no:
          nextVoucher,

        outward_no:
          nextVoucher,

        date,

        employee_id:
          masters.employee?._id ??
          null,

        location_id:
          masters.location?._id ??
          null,

        warehouse_id:
          warehouseId,

        product_id:
          masters.product?._id ??
          null,

        company_id:
          masters.company?._id ??
          null,

        company_account_id:
          masters.companyAccount?._id ??
          null,

        ...names,

        buyer:
          safeText(
            row?.buyer_name
          ) || "",

        buyer_name:
          safeText(
            row?.buyer_name
          ) || "",

        consignee_name:
          safeText(
            row?.consignee_name
          ) || "",

        lorry_no:
          safeText(
            row?.lorry_no
          ) || "",

        transporter:
          safeText(
            row?.lorry_no
          ) || "",

        product:
          names.product_name ||
          "",

        quantity:
          qty,

        weight:
          qty,

        rate,

        amount,

        inv_no:
          safeText(
            row?.inv_no
          ) || "",

        self_loading:
          selfLoading,

        status:
          "Pending",

        narration:
          "",

        created_at:
          new Date(),

        updated_at:
          new Date(),
      });

      inserted +=
        1;

      nextSl +=
        1;
    } catch (error) {
      skipped +=
        1;

      errors.push({
        row:
          index + 2,

        error:
          error.message,
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

router.post(
  "/import-xlsx",
  upload.single("file"),
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "outward.import"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to import outward entries",
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

    let rows =
      [];

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
        normalizeOutwardImportRow
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

    return importOutwardRows(
      normalized,
      req,
      res
    );
  }
);

/*
====================================================
AVAILABLE STOCK
====================================================
*/

router.get(
  "/available-stock",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "outward.view"
      ) &&
      !userHasPermission(
        req.user,
        "outward.create"
      ) &&
      !userHasPermission(
        req.user,
        "outward.edit"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to view outward stock",
        });
    }

    if (!ensureMongo(res)) {
      return;
    }

    let warehouseId =
      req.query
        .warehouse_id;

    let productId =
      req.query
        .product_id;

    const outwardId =
      req.query
        .outward_id ||
      null;

    const masters =
      await resolveOutwardMasters({
        warehouse_id:
          warehouseId,

        product_id:
          productId,
      });

    warehouseId =
      masters.warehouse?._id ||
      warehouseId;

    productId =
      masters.product?._id ||
      productId;

    if (
      !warehouseId ||
      !productId
    ) {
      return res.json({
        currentStock:
          0,

        reservedStock:
          0,

        availableStock:
          0,
      });
    }

    if (
      !canAccessWarehouse(
        req.user,
        warehouseId
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You can only view stock for your assigned warehouse",
        });
    }

    try {
      const stock =
        await getAvailableWarehouseStock({
          warehouse_id:
            warehouseId,

          product_id:
            productId,

          outwardId,
        });

      return res.json(
        stock
      );
    } catch (error) {
      console.error(
        "Mongo outward stock calculation failed:",
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
PENDING OUTWARD
====================================================
*/

router.get(
  "/pending",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "outward.view"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to view outward entries",
        });
    }

    if (!ensureMongo(res)) {
      return;
    }

    try {
      const docs =
        await MongoOutward.find({
          status: {
            $in: [
              "Pending",
              "Partial",
            ],
          },
        })
          .sort({
            created_at:
              -1,

            _id:
              -1,
          })
          .lean();

      const rows =
        await decorateOutwardDocs(
          docs
        );

      const filtered =
        rows.filter(
          (row) =>
            canAccessOutwardRow(
              req.user,
              row
            )
        );

      return res.json(
        filtered
      );
    } catch (error) {
      console.error(
        "Mongo outward pending fetch failed:",
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
STOCK JOURNAL HELPER
====================================================

This is an additive journal only. It does NOT change the existing FIFO,
remaining_qty, validation, or outward status logic.
*/
async function createStockJournalForAllocation({ outward, inward, qty }) {
  const quantity = safeNumber(qty);
  if (!outward || !inward || quantity <= 0) return null;

  const costRate = safeNumber(inward?.rate);
  const saleRate = safeNumber(outward?.rate);
  const costAmount = quantity * costRate;
  const saleAmount = quantity * saleRate;
  const profitLoss = saleAmount - costAmount;

  const outwardId = outward?.legacy_id ?? outward?.sl_no ?? String(outward?._id);
  const inwardId = inward?.legacy_id ?? inward?.sl_no ?? String(inward?._id);

  const fromPartyId = inward?.company_account_id ?? null;
  const fromPartyName =
    safeText(inward?.company_account_name) ||
    safeText(inward?.company_name) ||
    safeText(inward?.party_name) ||
    "";
  const toPartyId = outward?.buyer_id ?? null;
  const toPartyName = safeText(outward?.buyer_name) || safeText(outward?.buyer) || "";

  try {
    return await MongoStockJournal.findOneAndUpdate(
      {
        outward_id: outwardId,
        inward_id: inwardId,
        movement_type: "PARTY_STOCK_TRANSFER",
      },
      {
        $setOnInsert: {
          journal_no: `SJ-${outwardId}-${inwardId}`,
          movement_type: "PARTY_STOCK_TRANSFER",
          date: outward?.date || new Date(),
          outward_id: outwardId,
          outward_voucher_no: outward?.voucher_no || outward?.outward_no || "",
          inward_id: inwardId,
          inward_voucher_no: inward?.inward_no || inward?.voucher_no || "",
          warehouse_id: outward?.warehouse_id ?? inward?.warehouse_id ?? null,
          warehouse_name: outward?.warehouse_name || inward?.warehouse_name || "",
          location_id: outward?.location_id ?? inward?.location_id ?? null,
          location_name: outward?.location_name || inward?.location_name || "",
          product_id: outward?.product_id ?? inward?.product_id ?? null,
          product_name: outward?.product_name || inward?.product_name || outward?.product || inward?.product || "",
          from_party_id: fromPartyId,
          from_party_name: fromPartyName,
          to_party_id: toPartyId,
          to_party_name: toPartyName,
          qty: quantity,
          cost_rate: costRate,
          cost_amount: costAmount,
          sale_rate: saleRate,
          sale_amount: saleAmount,
          profit_loss: profitLoss,
          lorry_no: safeText(outward?.lorry_no) || "",
          employee_id: outward?.employee_id ?? null,
          employee_name: outward?.employee_name || "",
          company_id: outward?.company_id ?? null,
          company_name: outward?.company_name || "",
          buyer_name: outward?.buyer_name || "",
          consignee_name: outward?.consignee_name || "",
          created_at: new Date(),
          updated_at: new Date(),
        },
      },
      { upsert: true, new: true }
    ).lean();
  } catch (error) {
    // A journal failure must never change the existing stock/FIFO outcome.
    console.error("Stock journal create failed:", error);
    return null;
  }
}

/*
====================================================
FIFO COMPLETE
====================================================
*/

router.put(
  "/complete/:id",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "outward.edit"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to complete outward entries",
        });
    }

    if (!ensureMongo(res)) {
      return;
    }

    const outward =
      await findMongoOutward(
        req.params.id
      );

    if (!outward) {
      return res
        .status(404)
        .json({
          error:
            "Outward not found",
        });
    }

    if (
      !canAccessOutwardRow(
        req.user,
        outward
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You can only update entries for your assigned warehouse",
        });
    }

    const requestedQty =
      safeNumber(
        outward?.quantity ??
          outward?.weight
      );

    const currentAdjustedQty =
      await getAdjustedQtyForOutward(
        outward?.legacy_id ??
          outward?._id
      );

    let remaining =
      Math.max(
        requestedQty -
          currentAdjustedQty,
        0
      );

    if (
      remaining <= 0
    ) {
      await MongoOutward.updateOne(
        {
          _id:
            outward._id,
        },
        {
          $set: {
            status:
              "Completed",

            updated_at:
              new Date(),
          },
        }
      );

      return res.json({
        message:
          "FIFO Adjustment Done",

        remaining_qty:
          0,

        status:
          "Completed",

        source:
          "mongodb",
      });
    }

    const warehouseId =
      normalizeId(
        outward.warehouse_id
      );

    const productId =
      normalizeId(
        outward.product_id
      );

    if (
      !warehouseId ||
      !productId
    ) {
      return res
        .status(400)
        .json({
          error:
            "Warehouse or product is missing from outward entry",
        });
    }

    /*
     * FIFO:
     * Oldest inward first.
     */
    const inwardFilter = {
      warehouse_id:
        warehouseId,

      product_id:
        productId,
    };

    const inwardRows =
      await MongoInward.find(
        inwardFilter
      )
        .sort({
          date:
            1,

          sl_no:
            1,

          legacy_id:
            1,

          _id:
            1,
        })
        .lean();

    for (
      const inward of
        inwardRows
    ) {
      if (
        remaining <= 0
      ) {
        break;
      }

      const available =
        safeNumber(
          inward?.remaining_qty ??
            inward?.weight ??
            inward?.quantity
        );

      if (
        available <= 0
      ) {
        continue;
      }

      const useQty =
        Math.min(
          available,
          remaining
        );

      const inwardQuery =
        inward?._id
          ? {
              _id:
                inward._id,
            }
          : {
              legacy_id:
                inward.legacy_id,
            };

      /*
       * Atomic-ish conditional update:
       * only consume if remaining_qty is still enough.
       */
      const updateResult =
        await MongoInward.updateOne(
          inwardQuery,
          {
            $set: {
              updated_at:
                new Date(),
            },

            $inc: {
              remaining_qty:
                -useQty,
            },
          }
        );

      if (
        !updateResult?.matchedCount
      ) {
        continue;
      }

    const adjustmentOutwardId =
  outward?.legacy_id ??
  outward?.sl_no ??
  String(
    outward?._id
  );

const adjustmentInwardId =
  inward?.legacy_id ??
  inward?.sl_no ??
  String(
    inward?._id
  );

      await createAdjustmentMirrorRow({
        outward_id:
          adjustmentOutwardId,

        inward_id:
          adjustmentInwardId,

        qty:
          useQty,

        created_at:
          new Date(),

        date:
          new Date(),
      });

      // Additive journal only. Existing FIFO/stock logic remains unchanged.
      await createStockJournalForAllocation({
        outward,
        inward,
        qty: useQty,
      });

      remaining -=
        useQty;
    }

    const status =
      remaining > 0
        ? "Partial"
        : "Completed";

    await MongoOutward.updateOne(
      {
        _id:
          outward._id,
      },
      {
        $set: {
          status,

          updated_at:
            new Date(),
        },
      }
    );

    return res.json({
      message:
        "FIFO Adjustment Done",

      remaining_qty:
        remaining,

      status,

      source:
        "mongodb",
    });
  }
);

/*
====================================================
OUTWARD LIST
====================================================
*/

router.get(
  "/",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "outward.view"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to view outward entries",
        });
    }

    if (!ensureMongo(res)) {
      return;
    }

    try {
      const docs =
        await MongoOutward.find({})
          .sort({
            created_at:
              -1,

            date:
              -1,

            legacy_id:
              -1,

            _id:
              -1,
          })
          .lean();

      const rows =
        await decorateOutwardDocs(
          docs
        );

      const filtered =
        rows.filter(
          (row) =>
            canAccessOutwardRow(
              req.user,
              row
            )
        );

      return res.json(
        filtered
      );
    } catch (error) {
      console.error(
        "Mongo outward fetch failed:",
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
CREATE OUTWARD
====================================================
*/

router.post(
  "/",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "outward.create"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to create outward entries",
        });
    }

    if (!ensureMongo(res)) {
      return;
    }

    const {
      date,
      employee_id,
      employee_name,
      location_id,
      location_name,
      warehouse_id,
      warehouse_name,
      product_id,
      product_name,
      company_id,
      company_name,
      company_account_id,
      company_account_name,
      buyer_name,
      consignee_name,
      lorry_no,
      weight,
      quantity,
      rate,
      inv_no,
      self_loading,
      narration,
    } = req.body;

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
            "Valid date is required",
        });
    }

    const qty =
      safeNumber(
        quantity ??
          weight
      );

    const rateValue =
      safeNumber(
        rate
      );

    const amount =
      qty *
      rateValue;

    const selfLoading =
      normalizeSelfLoading(
        self_loading
      );

    try {
      const masters =
        await resolveOutwardMasters({
          employee_id,
          employee_name,

          location_id,
          location_name,

          warehouse_id,
          warehouse_name,

          product_id,
          product_name,

          company_id,
          company_name,

          company_account_id,
          company_account_name,
        });

      if (
        !masters.product
      ) {
        return res
          .status(400)
          .json({
            error:
              "Product could not be resolved. Please select a valid product.",
          });
      }

      if (
        !masters.company
      ) {
        return res
          .status(400)
          .json({
            error:
              "Company could not be resolved. Please select a valid company.",
          });
      }

      /*
       * Self-loading does not require a warehouse.
       */
      const normalizedWarehouseId =
        selfLoading === "Yes"
          ? null
          : masters.warehouse?._id ||
            warehouse_id;

      if (
        selfLoading !== "Yes" &&
        !normalizedWarehouseId
      ) {
        return res
          .status(400)
          .json({
            error:
              "Warehouse could not be resolved. Please select a valid warehouse.",
          });
      }

      if (
        normalizedWarehouseId &&
        !canAccessWarehouse(
          req.user,
          normalizedWarehouseId
        )
      ) {
        return res
          .status(403)
          .json({
            error:
              "You can only create entries for your assigned warehouse",
          });
      }

      /*
       * Validate stock only for normal warehouse outward.
       */
      if (
        normalizedWarehouseId
      ) {
        const stockValidation =
          await validateOutwardStock({
            warehouse_id:
              normalizedWarehouseId,

            product_id:
              masters.product?._id ||
              product_id,

            qty,
          });

        if (
          !stockValidation.ok
        ) {
          return res
            .status(400)
            .json({
              error:
                stockValidation.error,

              stock:
                stockValidation.stock,
            });
        }
      }

      const nextSl =
        await getNextOutwardSlNo();

      const voucherNo =
        formatOutwardVoucher(
          nextSl
        );

      const names =
        masterNames(
          masters
        );

      const doc =
        await MongoOutward.create({
          legacy_id:
            nextSl,

          sl_no:
            nextSl,

          voucher_no:
            voucherNo,

          outward_no:
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
            normalizedWarehouseId,

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

          ...names,

          buyer:
            safeText(
              buyer_name
            ) || "",

          buyer_name:
            safeText(
              buyer_name
            ) || "",

          consignee_name:
            safeText(
              consignee_name
            ) || "",

          product:
            names.product_name ||
            "",

          quantity:
            qty,

          weight:
            safeNumber(
              weight
            ) || qty,

          rate:
            rateValue,

          amount,

          lorry_no:
            safeText(
              lorry_no
            ) || "",

          transporter:
            safeText(
              lorry_no
            ) || "",

          inv_no:
            safeText(
              inv_no
            ) || "",

          self_loading:
            selfLoading,

          status:
            "Pending",

          narration:
            safeText(
              narration
            ) || "",

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

        mongo_id:
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
        "Mongo outward create failed:",
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
EDIT OUTWARD
====================================================
*/

router.put(
  "/:id",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "outward.edit"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to edit outward entries",
        });
    }

    if (!ensureMongo(res)) {
      return;
    }

    const existing =
      await findMongoOutward(
        req.params.id
      );

    if (!existing) {
      return res
        .status(404)
        .json({
          error:
            "Outward not found",
        });
    }

    if (
      !canAccessOutwardRow(
        req.user,
        existing
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You can only edit entries for your assigned warehouse",
        });
    }

    const {
      date,
      employee_id,
      employee_name,
      location_id,
      location_name,
      warehouse_id,
      warehouse_name,
      product_id,
      product_name,
      company_id,
      company_name,
      company_account_id,
      company_account_name,
      buyer_name,
      consignee_name,
      lorry_no,
      weight,
      quantity,
      rate,
      inv_no,
      self_loading,
      narration,
    } = req.body;

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
            "Valid date is required",
        });
    }

    const qty =
      safeNumber(
        quantity ??
          weight
      );

    const rateValue =
      safeNumber(
        rate
      );

    const amount =
      qty *
      rateValue;

    const selfLoading =
      normalizeSelfLoading(
        self_loading
      );

    try {
      const masters =
        await resolveOutwardMasters({
          employee_id,
          employee_name,

          location_id,
          location_name,

          warehouse_id,
          warehouse_name,

          product_id,
          product_name,

          company_id,
          company_name,

          company_account_id,
          company_account_name,
        });

      if (
        !masters.product
      ) {
        return res
          .status(400)
          .json({
            error:
              "Product could not be resolved",
          });
      }

      if (
        !masters.company
      ) {
        return res
          .status(400)
          .json({
            error:
              "Company could not be resolved",
          });
      }

      const normalizedWarehouseId =
        selfLoading === "Yes"
          ? null
          : masters.warehouse?._id ||
            warehouse_id;

      if (
        selfLoading !== "Yes" &&
        !normalizedWarehouseId
      ) {
        return res
          .status(400)
          .json({
            error:
              "Warehouse could not be resolved",
          });
      }

      if (
        normalizedWarehouseId &&
        !canAccessWarehouse(
          req.user,
          normalizedWarehouseId
        )
      ) {
        return res
          .status(403)
          .json({
            error:
              "You can only edit entries for your assigned warehouse",
          });
      }

      /*
       * If changing an existing Pending outward,
       * validate the newly requested stock.
       *
       * Completed/Partial outward should not silently
       * rewrite its quantity if FIFO adjustment exists.
       */
      const adjustedQty =
        await getAdjustedQtyForOutward(
          existing?.legacy_id ??
            existing?.sl_no ??
            existing?._id
        );

      if (
        adjustedQty > 0 &&
        qty <
          adjustedQty
      ) {
        return res
          .status(400)
          .json({
            error:
              `Cannot reduce quantity below already adjusted quantity (${adjustedQty}).`,
          });
      }

      if (
        normalizedWarehouseId
      ) {
        const stockValidation =
          await validateOutwardStock({
            warehouse_id:
              normalizedWarehouseId,

            product_id:
              masters.product?._id ||
              product_id,

            qty:
              Math.max(
                qty -
                  adjustedQty,
                0
              ),

            outwardId:
              existing?.legacy_id ??
              existing?._id,
          });

        if (
          !stockValidation.ok
        ) {
          return res
            .status(400)
            .json({
              error:
                stockValidation.error,

              stock:
                stockValidation.stock,
            });
        }
      }

      const names =
        masterNames(
          masters
        );

      const updated =
        await MongoOutward.findByIdAndUpdate(
          existing._id,
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
                normalizedWarehouseId,

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

              ...names,

              buyer:
                safeText(
                  buyer_name
                ) || "",

              buyer_name:
                safeText(
                  buyer_name
                ) || "",

              consignee_name:
                safeText(
                  consignee_name
                ) || "",

              product:
                names.product_name ||
                "",

              quantity:
                qty,

              weight:
                safeNumber(
                  weight
                ) || qty,

              rate:
                rateValue,

              amount,

              lorry_no:
                safeText(
                  lorry_no
                ) || "",

              transporter:
                safeText(
                  lorry_no
                ) || "",

              inv_no:
                safeText(
                  inv_no
                ) || "",

              self_loading:
                selfLoading,

              status:
                "Pending",

              narration:
                safeText(
                  narration
                ) || "",

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
          updated?.legacy_id ??
          String(
            updated?._id
          ),

        source:
          "mongodb",
      });
    } catch (error) {
      console.error(
        "Mongo outward update failed:",
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
DELETE OUTWARD
====================================================
*/

router.delete(
  "/:id",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "outward.delete"
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You do not have permission to delete outward entries",
        });
    }

    if (!ensureMongo(res)) {
      return;
    }

    const existing =
      await findMongoOutward(
        req.params.id
      );

    if (!existing) {
      return res
        .status(404)
        .json({
          error:
            "Outward not found",
        });
    }

    if (
      !canAccessOutwardRow(
        req.user,
        existing
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "You can only delete entries for your assigned warehouse",
        });
    }

    const adjustedQty =
      await getAdjustedQtyForOutward(
        existing?.legacy_id ??
          existing?.sl_no ??
          existing?._id
      );

    if (
      adjustedQty > 0
    ) {
      return res
        .status(400)
        .json({
          error:
            "Cannot delete. Adjustment exists.",
        });
    }

    try {
      const result =
        await MongoOutward.deleteOne({
          _id:
            existing._id,
        });

      return res.json({
        deleted:
          Number(
            result.deletedCount ||
              0
          ),

        deleted_from:
          "mongodb",
      });
    } catch (error) {
      console.error(
        "Mongo outward delete failed:",
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
MANUAL PARTY STOCK JOURNAL ENTRY
====================================================

This is a separate additive flow. Existing normal Outward/FIFO logic is not
changed. A Journal Entry moves actual remaining stock ownership from one
Inward party account to another party account in the same warehouse/product.
*/
router.get("/journal-source-accounts", async (req, res) => {
  if (!userHasPermission(req.user, "outward.view") && !userHasPermission(req.user, "outward.create")) {
    return res.status(403).json({ error: "You do not have permission to view journal source stock" });
  }
  if (!ensureMongo(res)) return;

  try {
    const { warehouse_id, product_id } = req.query;
    if (!warehouse_id || !product_id) return res.json({ rows: [] });

    if (!canAccessWarehouse(req.user, warehouse_id)) {
      return res.status(403).json({ error: "You can only access your assigned warehouse" });
    }

    const rows = await MongoInward.find({
      warehouse_id: { $in: mixedIdCandidates(warehouse_id) },
      product_id: { $in: mixedIdCandidates(product_id) },
      remaining_qty: { $gt: 0 },
      company_account_id: { $exists: true, $ne: null },
    })
      .select({
        company_account_id: 1,
        company_account_name: 1,
        company_id: 1,
        company_name: 1,
        remaining_qty: 1,
      })
      .sort({ company_account_name: 1, _id: 1 })
      .lean();

    const grouped = new Map();
    for (const row of rows) {
      const id = normalizeId(row.company_account_id);
      if (!id) continue;
      const existing = grouped.get(id);
      const qty = safeNumber(row.remaining_qty);
      if (existing) {
        existing.available_qty += qty;
      } else {
        grouped.set(id, {
          id,
          account_name: safeText(row.company_account_name) || `Account ${id}`,
          company_id: row.company_id ?? null,
          company_name: safeText(row.company_name) || "",
          available_qty: qty,
        });
      }
    }

    return res.json({
      rows: Array.from(grouped.values()).map((row) => ({
        ...row,
        available_qty: Number(row.available_qty.toFixed(4)),
      })),
    });
  } catch (error) {
    console.error("Journal source accounts failed:", error);
    return res.status(500).json({ error: error.message });
  }
});

async function createManualJournalEntry({
  date,
  employee_id,
  location_id,
  warehouse_id,
  product_id,
  from_account_id,
  to_account_id,
  quantity,
  rate,
  lorry_no,
  narration,
  session,
  journalNo,
}) {
  const qtyRequested = safeNumber(quantity);
  const toCandidates = mixedIdCandidates(to_account_id);
  const fromCandidates = mixedIdCandidates(from_account_id);
  const warehouseCandidates = mixedIdCandidates(warehouse_id);
  const productCandidates = mixedIdCandidates(product_id);

  const toAccount = await MongoCompanyAccount.findOne({ _id: { $in: toCandidates } }).session(session).lean();
  if (!toAccount) throw new Error("TO Party Account not found");
  const toCompany = toAccount.company_id
    ? await MongoCompany.findById(toAccount.company_id).session(session).lean()
    : null;

  const sourceRows = await MongoInward.find({
    warehouse_id: { $in: warehouseCandidates },
    product_id: { $in: productCandidates },
    company_account_id: { $in: fromCandidates },
    remaining_qty: { $gt: 0 },
  })
    .sort({ date: 1, sl_no: 1, legacy_id: 1, _id: 1 })
    .session(session)
    .lean();

  const totalSourceQty = sourceRows.reduce((sum, row) => sum + safeNumber(row.remaining_qty), 0);
  if (totalSourceQty + 0.000001 < qtyRequested) {
    throw new Error(`Not enough stock for FROM Party. Available stock is ${totalSourceQty.toFixed(2)}.`);
  }

  let remaining = qtyRequested;
  let createdQty = 0;
  let allocationCount = 0;
  const journalDate = date ? new Date(date) : new Date();
  const transferRateInput = safeNumber(rate);

  for (const source of sourceRows) {
    if (remaining <= 0) break;
    const sourceRemaining = safeNumber(source.remaining_qty);
    const useQty = Math.min(remaining, sourceRemaining);
    if (useQty <= 0) continue;

    const sourceId = source._id;
    const updated = await MongoInward.findOneAndUpdate(
      { _id: sourceId, remaining_qty: { $gte: useQty } },
      {
        $inc: { remaining_qty: -useQty, journal_adjusted_qty: useQty },
        $set: { outward_date: journalDate, updated_at: new Date() },
      },
      { new: true, session }
    ).lean();
    if (!updated) throw new Error("Stock changed while saving the journal entry. Please try again.");

    const sourceRate = safeNumber(source.rate);
    const transferRate = transferRateInput > 0 ? transferRateInput : sourceRate;
    const amount = useQty * transferRate;
    const sourceIdText = normalizeId(source._id);
    const destinationVoucher = `${journalNo}-${allocationCount + 1}`;

    const destinationDocs = await MongoInward.create([{
      voucher_no: destinationVoucher,
      inward_no: destinationVoucher,
      date: journalDate,
      employee_id: employee_id || null,
      location_id: location_id || source.location_id || null,
      warehouse_id,
      product_id,
      company_id: toAccount.company_id ?? null,
      company_account_id: toAccount._id,
      employee_name: "",
      location_name: source.location_name || "",
      warehouse_name: source.warehouse_name || "",
      product_name: source.product_name || "",
      company_name: toCompany?.name || "",
      company_account_name: toAccount.account_name || "",
      lorry_no: safeText(lorry_no) || source.lorry_no || "",
      quantity: useQty,
      weight: useQty,
      remaining_qty: useQty,
      rate: transferRate,
      amount,
      shortage_percent: 0,
      narration: `Journal Transfer ${journalNo}${narration ? ` | ${safeText(narration)}` : ""}`,
      created_at: new Date(),
      updated_at: new Date(),
    }], { session });
    const destination = destinationDocs[0];

    await MongoStockJournal.create([{
      journal_no: journalNo,
      movement_type: "MANUAL_PARTY_STOCK_TRANSFER",
      date: journalDate,
      outward_id: journalNo,
      outward_voucher_no: journalNo,
      inward_id: sourceIdText,
      inward_voucher_no: source.voucher_no || source.inward_no || "",
      destination_inward_id: destination._id,
      destination_voucher_no: destinationVoucher,
      warehouse_id,
      warehouse_name: source.warehouse_name || "",
      location_id: location_id || source.location_id || null,
      location_name: source.location_name || "",
      product_id,
      product_name: source.product_name || "",
      from_party_id: source.company_account_id,
      from_party_name: source.company_account_name || "",
      to_party_id: toAccount._id,
      to_party_name: toAccount.account_name || "",
      qty: useQty,
      cost_rate: sourceRate,
      cost_amount: useQty * sourceRate,
      sale_rate: transferRate,
      sale_amount: amount,
      profit_loss: amount - (useQty * sourceRate),
      lorry_no: safeText(lorry_no) || source.lorry_no || "",
      employee_id: employee_id || null,
      employee_name: "",
      company_id: toAccount.company_id ?? null,
      company_name: toCompany?.name || "",
      buyer_name: "",
      consignee_name: "",
      created_at: new Date(),
      updated_at: new Date(),
    }], { session });

    createdQty += useQty;
    allocationCount += 1;
    remaining -= useQty;
  }

  return { quantity: Number(createdQty.toFixed(4)), allocations: allocationCount, journal_no: journalNo };
}

async function reverseManualJournalEntry(journalNo, session) {
  const rows = await MongoStockJournal.find({
    journal_no: journalNo,
    movement_type: "MANUAL_PARTY_STOCK_TRANSFER",
  }).sort({ created_at: 1, _id: 1 }).session(session).lean();
  if (!rows.length) throw new Error("Journal Entry not found");

  const legacyPrefix = String(journalNo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const legacyDestinations = await MongoInward.find({
    voucher_no: { $regex: `^${legacyPrefix}-` },
  }).sort({ created_at: 1, _id: 1 }).session(session).lean();
  let legacyDestinationIndex = 0;

  for (const row of rows) {
    let destination = null;
    if (row.destination_inward_id) {
      destination = await MongoInward.findById(row.destination_inward_id).session(session).lean();
    } else if (row.destination_voucher_no) {
      destination = await MongoInward.findOne({ voucher_no: row.destination_voucher_no }).session(session).lean();
    } else {
      destination = legacyDestinations[legacyDestinationIndex] || null;
      legacyDestinationIndex += 1;
    }

    if (!destination) {
      throw new Error(`Journal ${journalNo} cannot be edited/deleted because its transferred stock record was not found.`);
    }
    if (Math.abs(safeNumber(destination.remaining_qty) - safeNumber(row.qty)) > 0.000001) {
      throw new Error(`Journal ${journalNo} cannot be edited/deleted because transferred stock has already been used in another transaction.`);
    }

    const sourceId = row.inward_id;
    if (sourceId) {
      await MongoInward.updateOne(
        { _id: sourceId },
        {
          $inc: {
            remaining_qty: safeNumber(row.qty),
            journal_adjusted_qty: -safeNumber(row.qty),
          },
          $set: { updated_at: new Date() },
        },
        { session }
      );
    }

    if (destination) {
      await MongoInward.deleteOne({ _id: destination._id }, { session });
    }
  }

  await MongoStockJournal.deleteMany({
    journal_no: journalNo,
    movement_type: "MANUAL_PARTY_STOCK_TRANSFER",
  }, { session });

  // Rebuild the journal date on source rows from any remaining manual journal.
  const affectedSourceIds = [...new Set(rows.map((r) => normalizeId(r.inward_id)).filter(Boolean))];
  for (const sourceId of affectedSourceIds) {
    const remainingManual = await MongoStockJournal.find({
      inward_id: sourceId,
      movement_type: "MANUAL_PARTY_STOCK_TRANSFER",
    }).sort({ date: -1, created_at: -1 }).session(session).lean();
    const totalAdjusted = remainingManual.reduce((sum, r) => sum + safeNumber(r.qty), 0);
    const source = await MongoInward.findById(sourceId).session(session).lean();
    if (source) {
      await MongoInward.updateOne(
        { _id: sourceId },
        {
          $set: {
            journal_adjusted_qty: totalAdjusted,
            outward_date: remainingManual.length ? remainingManual[0].date : null,
            updated_at: new Date(),
          },
        },
        { session }
      );
    }
  }

  return rows;
}

router.post("/journal-entry", async (req, res) => {
  if (!userHasPermission(req.user, "outward.create")) {
    return res.status(403).json({ error: "You do not have permission to create journal entries" });
  }
  if (!ensureMongo(res)) return;

  const { date, employee_id, location_id, warehouse_id, product_id, from_account_id, to_account_id, quantity, rate, lorry_no, narration } = req.body || {};
  const qtyRequested = safeNumber(quantity);
  if (!warehouse_id || !product_id || !from_account_id || !to_account_id || qtyRequested <= 0) {
    return res.status(400).json({ error: "Warehouse, product, FROM party, TO party and quantity are required" });
  }
  if (normalizeId(from_account_id) === normalizeId(to_account_id)) {
    return res.status(400).json({ error: "FROM Party and TO Party must be different" });
  }
  if (!canAccessWarehouse(req.user, warehouse_id)) return res.status(403).json({ error: "You can only create entries for your assigned warehouse" });

  const session = await mongoose.startSession();
  const journalNo = `JE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  try {
    let result;
    await session.withTransaction(async () => {
      result = await createManualJournalEntry({ date, employee_id, location_id, warehouse_id, product_id, from_account_id, to_account_id, quantity, rate, lorry_no, narration, session, journalNo });
    });
    return res.status(201).json({ success: true, ...result, message: "Journal Entry saved and stock transferred FROM party TO party" });
  } catch (error) {
    console.error("Manual party stock journal failed:", error);
    return res.status(400).json({ error: error.message || "Failed to save journal entry" });
  } finally { await session.endSession(); }
});

router.get("/journal-history", async (req, res) => {
  if (!userHasPermission(req.user, "outward.view") && !userHasPermission(req.user, "report.partyStock")) {
    return res.status(403).json({ error: "You do not have permission to view journal history" });
  }
  if (!ensureMongo(res)) return;
  try {
    const query = { movement_type: "MANUAL_PARTY_STOCK_TRANSFER" };
    if (req.query.warehouse_id) query.warehouse_id = req.query.warehouse_id;
    if (req.query.product_id) query.product_id = req.query.product_id;
    const docs = await MongoStockJournal.find(query).sort({ date: -1, created_at: -1, _id: -1 }).limit(5000).lean();
    const grouped = new Map();
    const fromAccountIds = [...new Set(docs.map((row) => normalizeId(row.from_party_id)).filter(Boolean))];
    const accountCandidates = fromAccountIds.flatMap((id) => mixedIdCandidates(id));
    const fromAccounts = accountCandidates.length
      ? await MongoCompanyAccount.find({ _id: { $in: accountCandidates } }).lean()
      : [];
    const fromAccountMap = new Map(fromAccounts.map((account) => [normalizeId(account._id), account]));
    const companyIds = [...new Set(fromAccounts.map((account) => normalizeId(account.company_id)).filter(Boolean))];
    const companyCandidates = companyIds.flatMap((id) => mixedIdCandidates(id));
    const fromCompanies = companyCandidates.length
      ? await MongoCompany.find({ _id: { $in: companyCandidates } }).lean()
      : [];
    const fromCompanyMap = new Map(fromCompanies.map((company) => [normalizeId(company._id), company]));

    for (const row of docs) {
      if (!canAccessWarehouse(req.user, row.warehouse_id)) continue;
      const key = row.journal_no;
      if (!key) continue;
      const existing = grouped.get(key);
      if (existing) {
        existing.qty += safeNumber(row.qty);
        existing.allocations += 1;
      } else {
        const fromAccount = fromAccountMap.get(normalizeId(row.from_party_id));
        const fromCompany = fromAccount ? fromCompanyMap.get(normalizeId(fromAccount.company_id)) : null;
        grouped.set(key, {
          journal_no: row.journal_no,
          date: row.date,
          warehouse_id: row.warehouse_id,
          warehouse_name: row.warehouse_name || "",
          product_id: row.product_id,
          product_name: row.product_name || "",
          from_company_id: fromAccount?.company_id ?? null,
          from_company_name: fromCompany?.name || "",
          from_account_id: row.from_party_id,
          from_account_name: row.from_party_name || fromAccount?.account_name || "",
          to_company_id: row.company_id ?? null,
          to_company_name: row.company_name || "",
          to_account_id: row.to_party_id,
          to_account_name: row.to_party_name || "",
          qty: safeNumber(row.qty),
          rate: safeNumber(row.sale_rate),
          lorry_no: row.lorry_no || "",
          employee_id: row.employee_id || null,
          location_id: row.location_id || null,
          allocations: 1,
        });
      }
    }
    return res.json({ rows: Array.from(grouped.values()), total: grouped.size });
  } catch (error) {
    console.error("Journal history failed:", error);
    return res.status(500).json({ error: error.message });
  }
});

router.put("/journal-entry/:journalNo", async (req, res) => {
  if (!userHasPermission(req.user, "outward.create")) return res.status(403).json({ error: "You do not have permission to edit journal entries" });
  if (!ensureMongo(res)) return;
  const { journalNo } = req.params;
  const { date, employee_id, location_id, warehouse_id, product_id, from_account_id, to_account_id, quantity, rate, lorry_no, narration } = req.body || {};
  if (!journalNo || !warehouse_id || !product_id || !from_account_id || !to_account_id || safeNumber(quantity) <= 0) {
    return res.status(400).json({ error: "Journal No, warehouse, product, FROM party, TO party and quantity are required" });
  }
  if (normalizeId(from_account_id) === normalizeId(to_account_id)) return res.status(400).json({ error: "FROM Party and TO Party must be different" });
  if (!canAccessWarehouse(req.user, warehouse_id)) return res.status(403).json({ error: "You can only edit entries for your assigned warehouse" });

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      await reverseManualJournalEntry(journalNo, session);
      result = await createManualJournalEntry({ date, employee_id, location_id, warehouse_id, product_id, from_account_id, to_account_id, quantity, rate, lorry_no, narration, session, journalNo });
    });
    return res.json({ success: true, ...result, journal_no: journalNo, message: "Journal Entry updated and stock recalculated" });
  } catch (error) {
    console.error("Journal edit failed:", error);
    return res.status(400).json({ error: error.message || "Failed to edit journal entry" });
  } finally { await session.endSession(); }
});

router.delete("/journal-entry/:journalNo", async (req, res) => {
  if (!userHasPermission(req.user, "outward.create")) return res.status(403).json({ error: "You do not have permission to delete journal entries" });
  if (!ensureMongo(res)) return;
  const { journalNo } = req.params;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => { await reverseManualJournalEntry(journalNo, session); });
    return res.json({ success: true, journal_no: journalNo, message: "Journal Entry deleted and stock restored" });
  } catch (error) {
    console.error("Journal delete failed:", error);
    return res.status(400).json({ error: error.message || "Failed to delete journal entry" });
  } finally { await session.endSession(); }
});

/*
====================================================
STOCK JOURNAL REPORT
====================================================
*/
router.get("/stock-journal", async (req, res) => {
  if (!userHasPermission(req.user, "outward.view") && !userHasPermission(req.user, "report.partyStock")) {
    return res.status(403).json({ error: "You do not have permission to view stock journal" });
  }

  if (!ensureMongo(res)) return;

  try {
    const query = {};
    if (req.query.from_date || req.query.to_date) {
      query.date = {};
      if (req.query.from_date) query.date.$gte = new Date(`${req.query.from_date}T00:00:00.000Z`);
      if (req.query.to_date) query.date.$lte = new Date(`${req.query.to_date}T23:59:59.999Z`);
    }
    if (req.query.warehouse_id) query.warehouse_id = req.query.warehouse_id;
    if (req.query.location_id) query.location_id = req.query.location_id;
    if (req.query.product_id) query.product_id = req.query.product_id;
    if (req.query.employee_id) query.employee_id = req.query.employee_id;
    if (req.query.from_party_id) query.from_party_id = req.query.from_party_id;
    if (req.query.to_party_id) query.to_party_id = req.query.to_party_id;

    const docs = await MongoStockJournal.find(query).sort({ date: -1, created_at: -1, _id: -1 }).limit(5000).lean();
    const filtered = docs.filter((row) => !row.warehouse_id || canAccessWarehouse(req.user, row.warehouse_id));

    return res.json({
      rows: filtered,
      total: filtered.length,
      source: "mongodb",
    });
  } catch (error) {
    console.error("Stock journal report failed:", error);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
