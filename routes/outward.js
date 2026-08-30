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
      row?.CompanyAccount ??
      "",

    lorry_no:
      row?.lorry_no ??
      row?.LorryNo ??
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
      row?.InvoiceNo ??
      "",

    buyer_name:
      row?.buyer_name ??
      row?.BuyerName ??
      row?.Buyer ??
      "",

    consignee_name:
      row?.consignee_name ??
      row?.ConsigneeName ??
      row?.Consignee ??
      "",

    self_loading:
      row?.self_loading ??
      row?.SelfLoading ??
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
  const result = [];

  for (
    const doc of docs || []
  ) {
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

    result.push({
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
    });
  }

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
      currentStock:
        0,

      reservedStock:
        0,

      availableStock:
        0,
    };
  }

  const normalizedWarehouse =
    normalizeId(
      warehouse_id
    );

  const normalizedProduct =
    normalizeId(
      product_id
    );

  /*
   * Current stock = remaining_qty from Inward.
   */
  const inwardRows =
    await MongoInward.find({
      warehouse_id:
        normalizedWarehouse,

      product_id:
        normalizedProduct,
    })
      .select({
        remaining_qty:
          1,

        weight:
          1,

        quantity:
          1,

        date:
          1,

        legacy_id:
          1,
      })
      .lean();

  let currentStock =
    0;

  for (
    const row of
      inwardRows
  ) {
    currentStock +=
      safeNumber(
        row?.remaining_qty ??
          row?.weight ??
          row?.quantity
      );
  }

  /*
   * Pending / partial reserved stock.
   */
  const outwardFilter = {
    warehouse_id:
      normalizedWarehouse,

    product_id:
      normalizedProduct,

    status: {
      $in: [
        "Pending",
        "Partial",
      ],
    },
  };

  if (
    outwardId
  ) {
    const existing =
      await findMongoOutward(
        outwardId
      );

    if (
      existing?._id
    ) {
      outwardFilter._id = {
        $ne:
          existing._id,
      };
    }
  }

  const pendingOutwards =
    await MongoOutward.find(
      outwardFilter
    )
      .select({
        _id:
          1,

        legacy_id:
          1,

        quantity:
          1,

        weight:
          1,
      })
      .lean();

  let reservedStock =
    0;

  for (
    const row of
      pendingOutwards
  ) {
    const outwardIdValue =
      row?.legacy_id ??
      row?._id;

    const adjustedQty =
      await getAdjustedQtyForOutward(
        outwardIdValue
      );

    const quantity =
      safeNumber(
        row?.quantity ??
          row?.weight
      );

    reservedStock +=
      Math.max(
        quantity -
          adjustedQty,
        0
      );
  }

  return {
    currentStock,

    reservedStock,

    availableStock:
      Math.max(
        currentStock -
          reservedStock,
        0
      ),
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

module.exports = router;
