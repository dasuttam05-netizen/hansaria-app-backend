const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

const {
  Outward: MongoOutward,
  Inward: MongoInward,
  Company: MongoCompany,
  CompanyAccount: MongoCompanyAccount,
  Warehouse: MongoWarehouse,
  Location: MongoLocation,
  Product: MongoProduct,
  isMongoMirrorReady,
} = require("../db-mongodb");

const {
  userHasPermission,
} = require("../middleware/auth");

/*
====================================================
MONGO HELPERS
====================================================
*/

function requireMongo(res) {
  if (!isMongoMirrorReady()) {
    res.status(503).json({
      error:
        "MongoDB is not connected. Please try again in a moment.",
    });

    return false;
  }

  return true;
}

function getDb() {
  if (!mongoose.connection.db) {
    throw new Error(
      "MongoDB database handle is not available"
    );
  }

  return mongoose.connection.db;
}

function getCollection(name) {
  return getDb().collection(name);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value) {
  return String(value ?? "").trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (
      value === null ||
      value === undefined
    ) {
      continue;
    }

    const t = String(value).trim();

    if (
      t &&
      t !== "-" &&
      t.toLowerCase() !== "null" &&
      t.toLowerCase() !== "undefined"
    ) {
      return t;
    }
  }

  return null;
}

function normalizeObjectId(value) {
  const raw = text(value);

  if (
    !raw ||
    !mongoose.Types.ObjectId.isValid(raw)
  ) {
    return null;
  }

  return new mongoose.Types.ObjectId(raw);
}

function buildIdFilter(value) {
  const raw = text(value);

  if (!raw) {
    return null;
  }

  const conditions = [];

  if (
    mongoose.Types.ObjectId.isValid(raw)
  ) {
    conditions.push({
      _id: new mongoose.Types.ObjectId(raw),
    });
  }

  const n = Number(raw);

  if (Number.isFinite(n)) {
    conditions.push({
      legacy_id: n,
    });

    conditions.push({
      id: n,
    });

    conditions.push({
      sl_no: n,
    });
  }

  if (!conditions.length) {
    return null;
  }

  if (conditions.length === 1) {
    return conditions[0];
  }

  return {
    $or: conditions,
  };
}

/*
====================================================
COLLECTIONS
====================================================
*/

const settlementCollection =
  () => getCollection("outwardsettlements");

const adjustmentCollection =
  () => getCollection("adjustments");

const buyerAdjustmentCollection =
  () => getCollection("buyeradjustments");

const expenseCollection =
  () => getCollection("expenses");

const expenseItemCollection =
  () => getCollection("expenseitems");

const paltiCollection =
  () => getCollection("paltilorryentries");

/*
====================================================
DETAIL HELPERS
====================================================
*/

function safeJsonParse(
  value,
  fallback = []
) {
  if (Array.isArray(value)) {
    return value;
  }

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return fallback;
  }

  if (
    typeof value === "object"
  ) {
    return fallback;
  }

  try {
    const parsed =
      JSON.parse(value);

    return Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

function normalizeDetailRows(
  value,
  fallbackAmount = 0,
  fallbackLabel = ""
) {
  const rows =
    safeJsonParse(value, []);

  if (rows.length > 0) {
    return rows.map(
      (item, index) => ({
        id:
          item?.id ??
          `${Date.now()}-${index}`,

        description:
          String(
            item?.description ??
              item?.particular ??
              item?.name ??
              fallbackLabel ??
              ""
          ).trim(),

        amount:
          num(item?.amount),
      })
    );
  }

  const amount =
    num(fallbackAmount);

  if (amount > 0) {
    return [
      {
        id:
          `${Date.now()}-0`,

        description:
          fallbackLabel || "",

        amount,
      },
    ];
  }

  return [
    {
      id:
        `${Date.now()}-0`,

      description:
        fallbackLabel || "",

      amount: 0,
    },
  ];
}

function stripEmptyDetailRows(
  rows
) {
  return (
    Array.isArray(rows)
      ? rows
      : []
  ).filter(
    (row) =>
      String(
        row?.description || ""
      ).trim() ||
      num(row?.amount) !== 0
  );
}

function sumDetailRows(
  rows
) {
  return (
    Array.isArray(rows)
      ? rows
      : []
  ).reduce(
    (sum, row) =>
      sum + num(row?.amount),
    0
  );
}

const ROW_ADJUSTMENT_FIELDS = [
  "short_amt",
  "s_amount",
  "c_deduction",
  "freight",
  "labour_chgs",
  "other_chgs",
];

const hasOwn = (
  obj,
  key
) =>
  Object.prototype.hasOwnProperty.call(
    obj || {},
    key
  );

function normalizeRowAdjustments(
  value
) {
  const rows = Array.isArray(value)
    ? value
    : safeJsonParse(value, []);

  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((item) => {
      const adjustment_id =
        item?.adjustment_id ??
        item?.id ??
        null;

      if (
        adjustment_id === null ||
        adjustment_id === ""
      ) {
        return null;
      }

      const out = {
        adjustment_id,
      };

      ROW_ADJUSTMENT_FIELDS.forEach(
        (field) => {
          if (
            !hasOwn(
              item,
              field
            )
          ) {
            return;
          }

          if (
            item[field] ===
              null ||
            item[field] ===
              undefined
          ) {
            return;
          }

          out[field] =
            num(item[field]);
        }
      );

      return Object.keys(out).length >
        1
        ? out
        : null;
    })
    .filter(Boolean);
}

/*
====================================================
OUTWARD LOOKUP
====================================================
*/

async function findOutward(
  outwardId
) {
  const filter =
    buildIdFilter(
      outwardId
    );

  if (!filter) {
    return null;
  }

  return MongoOutward.findOne(
    filter
  ).lean();
}

function buildOutwardIdCandidates(outward) {
  const candidates = [
    outward?.legacy_id,
    outward?.id,
    outward?.sl_no,
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  return Array.from(new Set(candidates));
}

async function findSettlementForOutward(outward) {
  const candidates = buildOutwardIdCandidates(outward);
  if (!candidates.length) return null;
  return settlementCollection().findOne({
    outward_id: { $in: candidates },
  });
}

/*
====================================================
MASTER NAME LOOKUPS
====================================================
*/

async function lookupMaster(
  Model,
  value,
  nameField = "name"
) {
  const filter =
    buildIdFilter(value);

  if (!filter) {
    return null;
  }

  return Model.findOne(
    filter
  )
    .select({
      [nameField]: 1,
      account_name: 1,
      location_id: 1,
    })
    .lean();
}

async function getOutwardMasterMeta(
  outward
) {
  if (!outward) {
    return null;
  }

  const [
    company,
    account,
    warehouse,
    location,
    product,
  ] = await Promise.all([
    lookupMaster(
      MongoCompany,
      outward.company_id,
      "name"
    ),

    lookupMaster(
      MongoCompanyAccount,
      outward.company_account_id,
      "account_name"
    ),

    lookupMaster(
      MongoWarehouse,
      outward.warehouse_id,
      "name"
    ),

    lookupMaster(
      MongoLocation,
      outward.location_id,
      "name"
    ),

    lookupMaster(
      MongoProduct,
      outward.product_id,
      "name"
    ),
  ]);

  let locationName =
    location?.name || "";

  if (
    !locationName &&
    warehouse?.location_id
  ) {
    const warehouseLocation =
      await lookupMaster(
        MongoLocation,
        warehouse.location_id,
        "name"
      );

    locationName =
      warehouseLocation?.name ||
      "";
  }

  return {
    company_name:
      company?.name || "",

    account_name:
      account?.account_name ||
      "",

    warehouse_name:
      warehouse?.name || "",

    location_name:
      locationName,

    product_name:
      product?.name || "",
  };
}

/*
====================================================
ADJUSTMENT DETAILS
====================================================
*/

async function buildBatchModelMap(Model, values, fields = []) {
  const rawValues = (Array.isArray(values) ? values : [])
    .filter((value) => value !== null && value !== undefined && text(value) !== "");

  if (!rawValues.length) return new Map();

  const numericValues = Array.from(
    new Set(
      rawValues
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
    )
  );

  const objectIds = Array.from(
    new Set(
      rawValues
        .map((value) => text(value))
        .filter((value) => mongoose.Types.ObjectId.isValid(value))
        .map((value) => new mongoose.Types.ObjectId(value).toString())
    )
  ).map((value) => new mongoose.Types.ObjectId(value));

  const conditions = [];
  if (objectIds.length) conditions.push({ _id: { $in: objectIds } });
  if (numericValues.length) {
    conditions.push({ legacy_id: { $in: numericValues } });
    conditions.push({ id: { $in: numericValues } });
    conditions.push({ sl_no: { $in: numericValues } });
  }

  if (!conditions.length) return new Map();

  const projection = { _id: 1 };
  for (const field of fields) projection[field] = 1;
  // These identifiers are needed to safely match legacy numeric records.
  projection.legacy_id = 1;
  projection.id = 1;
  projection.sl_no = 1;

  const rows = await Model.find({ $or: conditions }).select(projection).lean();
  const map = new Map();

  const add = (key, row) => {
    if (key === null || key === undefined || key === "") return;
    map.set(String(key), row);
    const n = Number(key);
    if (Number.isFinite(n)) map.set(String(n), row);
  };

  for (const row of rows || []) {
    add(row?._id, row);
    add(row?.legacy_id, row);
    add(row?.id, row);
    add(row?.sl_no, row);
  }

  return map;
}

function getMapValue(map, value) {
  if (!map || value === null || value === undefined || value === "") return null;
  return map.get(String(value)) || map.get(String(Number(value))) || null;
}

async function getAdjustmentDetails(outward, outwardId) {
  const numericOutwardId = Number(
    outward?.legacy_id ?? outward?.id ?? outward?.sl_no ?? outwardId
  );

  if (!Number.isFinite(numericOutwardId)) return [];

  const rows = await adjustmentCollection()
    .find({ outward_id: numericOutwardId })
    .sort({ created_at: 1, _id: 1 })
    .project({
      _id: 1,
      id: 1,
      inward_id: 1,
      palti_lorry_id: 1,
      source_type: 1,
      qty: 1,
      settlement_weight: 1,
      company_rate: 1,
      adjustment_company_rate: 1,
      whatsapp_sent_at: 1,
    })
    .toArray();

  if (!rows.length) return [];

  const inwardIds = rows.map((row) => row.inward_id).filter((value) => value !== null && value !== undefined && text(value) !== "");
  const paltiIds = rows.map((row) => row.palti_lorry_id).filter((value) => value !== null && value !== undefined && text(value) !== "");

  const inwardMap = await buildBatchModelMap(MongoInward, inwardIds, [
    "voucher_no", "lorry_no", "date", "expense_date",
    "company_id", "company_account_id", "warehouse_id", "location_id", "product_id",
  ]);

  const paltiObjectIds = paltiIds
    .map((value) => text(value))
    .filter((value) => mongoose.Types.ObjectId.isValid(value))
    .map((value) => new mongoose.Types.ObjectId(value));
  const paltiNumericIds = paltiIds.map(Number).filter(Number.isFinite);
  const paltiConditions = [];
  if (paltiObjectIds.length) paltiConditions.push({ _id: { $in: paltiObjectIds } });
  if (paltiNumericIds.length) {
    paltiConditions.push({ legacy_id: { $in: paltiNumericIds } });
    paltiConditions.push({ id: { $in: paltiNumericIds } });
    paltiConditions.push({ sl_no: { $in: paltiNumericIds } });
  }

  const paltiRows = paltiConditions.length
    ? await paltiCollection()
        .find({ $or: paltiConditions })
        .project({ _id: 1, id: 1, legacy_id: 1, sl_no: 1, voucher_no: 1, new_lorry_no: 1, reg_lorry_no: 1, expense_date: 1, company_id: 1, company_account_id: 1, warehouse_id: 1, location_id: 1, product_id: 1 })
        .toArray()
    : [];

  const actualPaltiMap = new Map();
  for (const row of paltiRows || []) {
    for (const key of [row?._id, row?.legacy_id, row?.id, row?.sl_no]) {
      if (key !== null && key !== undefined && key !== "") {
        actualPaltiMap.set(String(key), row);
        const n = Number(key);
        if (Number.isFinite(n)) actualPaltiMap.set(String(n), row);
      }
    }
  }

  const sources = rows.map((row) => getMapValue(inwardMap, row.inward_id) || getMapValue(actualPaltiMap, row.palti_lorry_id)).filter(Boolean);
  const masterValues = (field) => sources.map((source) => source?.[field]).filter((value) => value !== null && value !== undefined && text(value) !== "");

  const [companyMap, accountMap, warehouseMap, locationMap, productMap] = await Promise.all([
    buildBatchModelMap(MongoCompany, masterValues("company_id"), ["name"]),
    buildBatchModelMap(MongoCompanyAccount, masterValues("company_account_id"), ["account_name"]),
    buildBatchModelMap(MongoWarehouse, masterValues("warehouse_id"), ["name", "location_id"]),
    buildBatchModelMap(MongoLocation, masterValues("location_id"), ["name"]),
    buildBatchModelMap(MongoProduct, masterValues("product_id"), ["name"]),
  ]);

  // A warehouse may carry the location reference even when the source row does not.
  const warehouseRows = Array.from(warehouseMap.values());
  const warehouseLocationIds = warehouseRows.map((warehouse) => warehouse?.location_id).filter((value) => value !== null && value !== undefined && text(value) !== "");
  const missingWarehouseLocations = await buildBatchModelMap(MongoLocation, warehouseLocationIds, ["name"]);

  return rows.map((row) => {
    const inward = getMapValue(inwardMap, row.inward_id);
    const palti = getMapValue(actualPaltiMap, row.palti_lorry_id);
    const source = inward || palti || {};

    const company = getMapValue(companyMap, source.company_id);
    const account = getMapValue(accountMap, source.company_account_id);
    const warehouse = getMapValue(warehouseMap, source.warehouse_id);
    const location = getMapValue(locationMap, source.location_id) || getMapValue(missingWarehouseLocations, warehouse?.location_id);
    const product = getMapValue(productMap, source.product_id);

    return {
      id: row._id ? String(row._id) : row.id,
      outward_id: numericOutwardId,
      source_type: row.source_type || "inward",
      settlement_weight: num(row.qty ?? row.settlement_weight),
      adjustment_company_rate: num(row.company_rate ?? row.adjustment_company_rate),
      whatsapp_sent_at: row.whatsapp_sent_at || null,
      inward_voucher_no: inward?.voucher_no ?? palti?.voucher_no ?? null,
      lorry_no: inward?.lorry_no || palti?.new_lorry_no || palti?.reg_lorry_no || null,
      inward_date: inward?.date ?? palti?.expense_date ?? null,
      company_name: company?.name || "",
      company_account_name: account?.account_name || "",
      warehouse_name: warehouse?.name || "",
      location_name: location?.name || "",
      product_name: product?.name || "",
    };
  });
}

/*
====================================================
UNLOADING DETAILS
====================================================
*/

async function getUnloadingDetails(outward, outwardId) {
  const numericOutwardId = Number(
    outward?.legacy_id ?? outward?.id ?? outward?.sl_no ?? outwardId
  );

  if (!Number.isFinite(numericOutwardId)) return [];

  return buyerAdjustmentCollection()
    .find({
      outward_id: numericOutwardId,
      consignee_name: { $exists: true, $nin: [null, ""] },
      rate: { $gt: 0 },
    })
    .sort({ created_at: -1, _id: -1 })
    .project({
      _id: 1, outward_id: 1, consignee_name: 1, qty: 1, weight: 1,
      rate: 1, claim: 1, other_deduction: 1, shortage: 1, shortage_amount: 1,
      unloading_date: 1, status: 1, created_at: 1, updated_at: 1,
    })
    .toArray();
}

/*
====================================================
LABOUR EXPENSE
====================================================
*/

async function getApprovedLabourExpense(outward, outwardId) {
  const numericOutwardId = Number(
    outward?.legacy_id ?? outward?.id ?? outward?.sl_no ?? outwardId
  );

  if (!Number.isFinite(numericOutwardId)) {
    return { amount: 0, count: 0, vouchers: [], entries: [] };
  }

  let expenses = await expenseCollection()
    .find({ outward_id: numericOutwardId })
    .sort({ id: 1, _id: 1 })
    .project({
      _id: 1, id: 1, legacy_id: 1, voucher_no: 1, status: 1,
      total_expense_amount: 1, grand_total: 1, expense_date: 1, date: 1,
      reg_lorry_no: 1, new_lorry_no: 1,
    })
    .toArray();

  const loadEntries = async (rows) => {
    if (!rows.length) return [];

    const expenseIds = rows
      .map((expense) => Number(expense.id ?? expense.legacy_id ?? 0))
      .filter((value) => Number.isFinite(value) && value > 0);

    const itemRows = expenseIds.length
      ? await expenseItemCollection()
          .find({ expense_id: { $in: expenseIds } })
          .project({ expense_id: 1, particular_name: 1, name: 1, amount: 1 })
          .toArray()
      : [];

    const labourByExpense = new Map();
    for (const item of itemRows || []) {
      const particular = String(item.particular_name || item.name || "").toLowerCase();
      if (!particular.includes("labour") && !particular.includes("labor")) continue;
      const id = Number(item.expense_id);
      labourByExpense.set(id, (labourByExpense.get(id) || 0) + num(item.amount));
    }

    return rows.flatMap((expense) => {
      const expenseId = Number(expense.id ?? expense.legacy_id ?? 0);
      const labourAmount = labourByExpense.get(expenseId) || 0;
      const fallback = num(expense.total_expense_amount) || num(expense.grand_total);
      const amount = labourAmount > 0 ? labourAmount : fallback;

      if (amount <= 0) return [];
      return [{
        id: expense.id ?? expense.legacy_id ?? String(expense._id),
        voucher_no: expense.voucher_no || null,
        amount,
        status: expense.status || null,
      }];
    });
  };

  let entries = await loadEntries(expenses);

  // Legacy fallback by lorry/date, also batched for expense items.
  if (!entries.length && outward) {
    const outwardLorry = text(outward.lorry_no);
    const outwardDate = outward.date ? new Date(outward.date) : null;

    expenses = await expenseCollection()
      .find({ $or: [{ reg_lorry_no: outwardLorry }, { new_lorry_no: outwardLorry }] })
      .project({
        _id: 1, id: 1, legacy_id: 1, voucher_no: 1, status: 1,
        total_expense_amount: 1, grand_total: 1, expense_date: 1, date: 1,
      })
      .toArray();

    if (outwardDate) {
      const targetDate = outwardDate.toISOString().slice(0, 10);
      expenses = expenses.filter((expense) => {
        const expenseDate = new Date(expense.expense_date || expense.date);
        return !Number.isNaN(expenseDate.getTime()) && expenseDate.toISOString().slice(0, 10) === targetDate;
      });
    }

    entries = await loadEntries(expenses);
  }

  return {
    amount: entries.reduce((sum, item) => sum + num(item.amount), 0),
    count: entries.length,
    vouchers: entries.map((item) => item.voucher_no || `EXP-${item.id}`).filter(Boolean),
    entries,
  };
}

/*
====================================================
SETTLEMENT CALCULATION
====================================================
*/

function calculateSettlement(
  data
) {
  const dispatch_qty =
    num(
      data.dispatch_qty
    );

  const unloading_qty =
    num(
      data.unloading_qty
    );

  const settlement_weight =
    num(
      data.settlement_weight ||
        unloading_qty
    );

  const sale_rate =
    num(
      data.sale_rate
    );

  const company_rate =
    num(
      data.company_rate
    );

  const adjustment_details =
    Array.isArray(
      data.adjustment_details
    )
      ? data.adjustment_details
      : [];

  const freight =
    num(
      data.freight
    );

  const outward_labour_charges =
    num(
      data.outward_labour_charges
    );

  const other_charges =
    num(
      data.other_charges
    );

  const unloading_date =
    data.unloading_date ||
    "";

  const claim_details =
    Array.isArray(
      data.claim_details
    )
      ? data.claim_details
      : [];

  const other_deduction_details =
    Array.isArray(
      data.other_deduction_details
    )
      ? data.other_deduction_details
      : [];

  const row_adjustments =
    Array.isArray(
      data.row_adjustments
    )
      ? data.row_adjustments
      : [];

  const claim_amount =
    num(
      data.claim_amount
    ) ||
    sumDetailRows(
      claim_details
    );

  const other_deduction =
    num(
      data.other_deduction
    ) ||
    sumDetailRows(
      other_deduction_details
    );

  const charge_bearer =
    data.charge_bearer ===
    "company"
      ? "company"
      : "self";

  const shortage_qty =
    Math.max(
      num(
        data.shortage_qty
      ) ||
        Math.max(
          dispatch_qty -
            unloading_qty,
          0
        ),
      0
    );

  const sale_amount =
    dispatch_qty *
    sale_rate;

  const average_rate =
    settlement_weight >
    0
      ? adjustment_details.reduce(
          (sum, item) => {
            const weight =
              num(
                item.settlement_weight
              );

            const rowRate =
              num(
                item.company_rate
              ) ||
              company_rate;

            return (
              sum +
              weight *
                rowRate
            );
          },
          0
        ) /
        settlement_weight
      : company_rate;

  const average_amount =
    settlement_weight *
    average_rate;

  const company_amount =
    adjustment_details.length
      ? adjustment_details.reduce(
          (sum, item) => {
            const rowRate =
              num(
                item.company_rate
              ) ||
              company_rate;

            return (
              sum +
              num(
                item.settlement_weight
              ) *
                rowRate
            );
          },
          0
        )
      : settlement_weight *
        company_rate;

  const gross_amount =
    Math.max(
      dispatch_qty *
        sale_rate -
        freight -
        outward_labour_charges -
        other_charges,
      0
    );

  const shortage_amount =
    adjustment_details.length
      ? adjustment_details.reduce(
          (sum, item) => {
            const rowRate =
              num(
                item.company_rate
              ) ||
              company_rate;

            const shortQty =
              dispatch_qty >
              0
                ? (num(
                    item.settlement_weight
                  ) /
                    dispatch_qty) *
                  shortage_qty
                : 0;

            return (
              sum +
              shortQty *
                rowRate
            );
          },
          0
        )
      : shortage_qty *
        company_rate;

  const perMtCharges =
    dispatch_qty >
    0
      ? (freight +
          outward_labour_charges +
          other_charges) /
        dispatch_qty
      : 0;

  const company_payable =
    adjustment_details.length
      ? adjustment_details.reduce(
          (sum, item) => {
            const weight =
              num(
                item.settlement_weight
              );

            const rowRate =
              num(
                item.company_rate
              ) ||
              company_rate;

            const shortQty =
              dispatch_qty >
              0
                ? (weight /
                    dispatch_qty) *
                  shortage_qty
                : 0;

            return (
              sum +
              weight *
                rowRate -
              weight *
                perMtCharges -
              shortQty *
                rowRate
            );
          },
          0
        )
      : company_amount -
        settlement_weight *
          perMtCharges -
        shortage_amount;

  const receivable_amount =
    gross_amount -
    company_payable -
    claim_amount -
    other_deduction;

  return {
    dispatch_qty,
    unloading_qty,
    billable_qty:
      shortage_qty,
    settlement_weight,
    sale_rate,
    company_rate,
    average_rate,
    average_amount,
    sale_amount,
    company_amount,
    gross_amount,
    receivable_amount,
    unloading_date,
    freight,
    outward_labour_charges,
    other_charges,
    claim_amount,
    other_deduction,
    claim_details,
    other_deduction_details,
    shortage_qty,
    charge_bearer,
    gross_profit:
      gross_amount,
    net_profit:
      receivable_amount,
    company_payable,
    row_adjustments,
  };
}

/*
====================================================
GET SETTLEMENT
====================================================
*/

router.get(
  "/:outward_id",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "settlement.view"
      ) &&
      !userHasPermission(
        req.user,
        "outward.view"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to view settlement",
      });
    }

    try {
      if (!requireMongo(res)) {
        return;
      }

      const outward =
        await findOutward(
          req.params.outward_id
        );

      if (!outward) {
        return res.status(404).json({
          error:
            "Outward not found",
        });
      }

      const numericOutwardId =
        Number(
          outward.legacy_id ??
            outward.id ??
            outward.sl_no
        );

      const settlement =
        await findSettlementForOutward(
          outward
        );

      const [
        adjustment_details,
        unloadingDetails,
        labourExpense,
        meta,
        bilti,
      ] =
        await Promise.all([
          getAdjustmentDetails(
            outward,
            numericOutwardId
          ),

          getUnloadingDetails(
            outward,
            numericOutwardId
          ),

          getApprovedLabourExpense(
            outward,
            numericOutwardId
          ),

          getOutwardMasterMeta(
            outward
          ),

          getCollection("transportbilti")
            .findOne(
              { outward_id: numericOutwardId },
              { projection: { net_amount: 1, payable_amount: 1 } }
            )
            .catch(() => null),
        ]);

      const totalSettlementWeight =
        adjustment_details.reduce(
          (sum, item) =>
            sum +
            num(
              item.settlement_weight
            ),
          0
        );

      const claimDetails =
        normalizeDetailRows(
          settlement?.claim_details,
          settlement?.claim_amount,
          "Claim"
        );

      const otherDeductionDetails =
        normalizeDetailRows(
          settlement?.other_deduction_details,
          settlement?.other_deduction,
          "Deduction"
        );

      const rowAdjustments =
        normalizeRowAdjustments(
          settlement?.row_adjustments
        );

      const defaultDispatch =
        num(
          outward.quantity ??
            outward.weight
        );

      return res.json({
        outward_id:
          numericOutwardId,

        outward_date:
          outward.date,

        voucher_no:
          outward.outward_no ||
          outward.voucher_no ||
          outward.inv_no ||
          null,

        lorry_no:
          outward.lorry_no ||
          null,

        buyer_name:
          outward.buyer_name ||
          outward.buyer ||
          null,

        consignee_name:
          outward.consignee_name ||
          null,

        company_name:
          meta?.company_name ||
          outward.company_name ||
          "",

        account_name:
          meta?.account_name ||
          outward.company_account_name ||
          null,

        company_account_name:
          meta?.account_name ||
          outward.company_account_name ||
          null,

        accountName:
          meta?.account_name ||
          outward.company_account_name ||
          null,

        warehouse_name:
          meta?.warehouse_name ||
          outward.warehouse_name ||
          null,

        outward_warehouse_name:
          meta?.warehouse_name ||
          outward.warehouse_name ||
          null,

        warehouseName:
          meta?.warehouse_name ||
          outward.warehouse_name ||
          null,

        location_id:
          outward.location_id ||
          null,

        location_name:
          meta?.location_name ||
          outward.location_name ||
          null,

        outward_location_name:
          meta?.location_name ||
          outward.location_name ||
          null,

        locationName:
          meta?.location_name ||
          outward.location_name ||
          null,

        product_name:
          meta?.product_name ||
          outward.product_name ||
          outward.product ||
          null,

        outward_product_name:
          meta?.product_name ||
          outward.product_name ||
          outward.product ||
          null,

        productName:
          meta?.product_name ||
          outward.product_name ||
          outward.product ||
          null,

        outward_quantity:
          defaultDispatch,

        labour_expense:
          labourExpense,

        transport_bilti:
          bilti
            ? {
                net_amount: num(bilti.net_amount),
                payable_amount: num(bilti.payable_amount),
              }
            : null,

        unloading_details:
          unloadingDetails,

        adjustment_details:
          adjustment_details.map(
            (item) => ({
              ...item,

              company_rate:
                num(
                  item.adjustment_company_rate
                ) ||
                num(
                  settlement?.company_rate
                ),

              amount:
                num(
                  item.settlement_weight
                ) *
                (
                  num(
                    item.adjustment_company_rate
                  ) ||
                  num(
                    settlement?.company_rate
                  )
                ),
            })
          ),

        settlement: {
          id:
            settlement?._id
              ? String(
                  settlement._id
                )
              : null,

          dispatch_qty:
            settlement?.dispatch_qty ??
            defaultDispatch,

          unloading_qty:
            settlement?.unloading_qty ??
            totalSettlementWeight,

          settlement_weight:
            totalSettlementWeight,

          billable_qty:
            settlement?.billable_qty ??
            (
              unloadingDetails.reduce(
                (sum, item) =>
                  sum +
                  num(
                    item.shortage
                  ),
                0
              ) || 0
            ),

          sale_rate:
            settlement?.sale_rate ??
            num(
              outward.rate
            ),

          company_rate:
            settlement?.company_rate ??
            0,

          average_rate:
            settlement?.average_rate ??
            0,

          average_amount:
            settlement?.average_amount ??
            0,

          sale_amount:
            settlement?.sale_amount ??
            0,

          company_amount:
            settlement?.company_amount ??
            0,

          gross_amount:
            settlement?.gross_amount ??
            settlement?.gross_profit ??
            0,

          receivable_amount:
            settlement?.receivable_amount ??
            settlement?.net_profit ??
            0,

          unloading_date:
            settlement?.unloading_date ||
            "",

          freight:
            settlement?.freight ??
            (num(bilti?.net_amount) > 0 ? num(bilti.net_amount) : 0),

          outward_labour_charges:
            settlement?.outward_labour_charges ??
            null,

          other_charges:
            settlement?.other_charges ??
            0,

          claim_amount:
            settlement?.claim_amount ??
            0,

          other_deduction:
            settlement?.other_deduction ??
            0,

          claim_details:
            claimDetails,

          other_deduction_details:
            otherDeductionDetails,

          row_adjustments:
            rowAdjustments,

          charge_bearer:
            settlement?.charge_bearer ||
            "self",

          gross_profit:
            settlement?.gross_profit ??
            0,

          net_profit:
            settlement?.net_profit ??
            0,

          company_payable:
            settlement?.company_payable ??
            0,

          narration:
            settlement?.narration ||
            "",
        },
      });
    } catch (err) {
      console.error(
        "Outward settlement fetch failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

/*
====================================================
SAVE SETTLEMENT
====================================================
*/

router.post(
  "/save",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "settlement.view"
      ) &&
      !userHasPermission(
        req.user,
        "outward.edit"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to save settlement",
      });
    }

    try {
      if (!requireMongo(res)) {
        return;
      }

      const {
        outward_id,
        dispatch_qty,
        unloading_qty,
        sale_rate,
        company_rate,
        adjustment_rates,
        freight,
        outward_labour_charges,
        other_charges,
        claim_amount,
        other_deduction,
        claim_details,
        other_deduction_details,
        shortage_qty,
        row_adjustments,
        unloading_date,
        charge_bearer,
        narration,
      } = req.body;

      if (!outward_id) {
        return res.status(400).json({
          error:
            "outward_id required",
        });
      }

      const outward =
        await findOutward(
          outward_id
        );

      if (!outward) {
        return res.status(404).json({
          error:
            "Outward not found",
        });
      }

      const numericOutwardId =
        Number(
          outward.legacy_id ??
            outward.id ??
            outward.sl_no
        );

      if (
        !Number.isFinite(
          numericOutwardId
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid outward legacy id",
        });
      }

      const existingSettlement =
        await findSettlementForOutward(
          outward
        );

      const canEditCompanyRate =
        userHasPermission(
          req.user,
          "settlement.companyRate"
        );

      const existingCompanyRate =
        num(
          existingSettlement?.company_rate
        );

      const requestedCompanyRate =
        num(
          company_rate
        );

      if (
        !canEditCompanyRate &&
        requestedCompanyRate !==
          existingCompanyRate
      ) {
        return res.status(403).json({
          error:
            "Company rate edit access required",
        });
      }

      const adjustment_details =
        await getAdjustmentDetails(
          numericOutwardId
        );

      const unloadingDetails =
        await getUnloadingDetails(
          numericOutwardId
        );

      const unloadingShortageQty =
        unloadingDetails.reduce(
          (sum, item) =>
            sum +
            num(
              item.shortage
            ),
          0
        );

      const adjustmentRateMap =
        new Map(
          (
            Array.isArray(
              adjustment_rates
            )
              ? adjustment_rates
              : []
          )
            .map(
              (item) => [
                String(
                  item.adjustment_id ||
                    item.id ||
                    ""
                ),

                num(
                  item.company_rate
                ),
              ]
            )
            .filter(
              ([id]) =>
                Boolean(id)
            )
        );

      const adjustmentDetailsWithRates =
        adjustment_details.map(
          (item) => ({
            ...item,

            company_rate:
              adjustmentRateMap.has(
                String(
                  item.id
                )
              )
                ? adjustmentRateMap.get(
                    String(
                      item.id
                    )
                  )
                : num(
                    item.adjustment_company_rate
                  ) ||
                  (
                    canEditCompanyRate
                      ? requestedCompanyRate
                      : existingCompanyRate
                  ),
          })
        );

      if (
        !canEditCompanyRate
      ) {
        const changed =
          adjustmentDetailsWithRates.some(
            (item) =>
              num(
                item.company_rate
              ) !==
              (
                num(
                  item.adjustment_company_rate
                ) ||
                existingCompanyRate
              )
          );

        if (changed) {
          return res.status(403).json({
            error:
              "Company rate edit access required",
          });
        }
      }

      const settlementWeight =
        adjustmentDetailsWithRates.reduce(
          (sum, item) =>
            sum +
            num(
              item.settlement_weight
            ),
          0
        );

      const normalizedClaimDetails =
        stripEmptyDetailRows(
          normalizeDetailRows(
            claim_details,
            claim_amount,
            "Claim"
          )
        );

      const normalizedOtherDeductionDetails =
        stripEmptyDetailRows(
          normalizeDetailRows(
            other_deduction_details,
            other_deduction,
            "Deduction"
          )
        );

      const normalizedRowAdjustments =
        normalizeRowAdjustments(
          row_adjustments
        );

      const settlement =
        calculateSettlement({
          dispatch_qty:
            dispatch_qty ??
            num(
              outward.quantity ??
                outward.weight
            ),

          unloading_qty,

          shortage_qty:
            unloadingShortageQty,

          settlement_weight:
            settlementWeight,

          sale_rate,

          company_rate:
            canEditCompanyRate
              ? company_rate
              : existingCompanyRate,

          adjustment_details:
            adjustmentDetailsWithRates,

          freight,

          outward_labour_charges,

          other_charges,

          unloading_date,

          claim_amount,

          other_deduction,

          claim_details:
            normalizedClaimDetails,

          other_deduction_details:
            normalizedOtherDeductionDetails,

          row_adjustments:
            normalizedRowAdjustments,

          charge_bearer,
        });

      const settlementDoc = {
        outward_id:
          numericOutwardId,

        dispatch_qty:
          settlement.dispatch_qty,

        unloading_qty:
          settlement.unloading_qty,

        billable_qty:
          settlement.billable_qty,

        sale_rate:
          settlement.sale_rate,

        company_rate:
          settlement.company_rate,

        average_rate:
          settlement.average_rate,

        average_amount:
          settlement.average_amount,

        sale_amount:
          settlement.sale_amount,

        company_amount:
          settlement.company_amount,

        gross_amount:
          settlement.gross_amount,

        receivable_amount:
          settlement.receivable_amount,

        unloading_date:
          settlement.unloading_date,

        freight:
          settlement.freight,

        outward_labour_charges:
          settlement.outward_labour_charges,

        other_charges:
          settlement.other_charges,

        claim_amount:
          settlement.claim_amount,

        other_deduction:
          settlement.other_deduction,

        claim_details:
          settlement.claim_details,

        other_deduction_details:
          settlement.other_deduction_details,

        row_adjustments:
          settlement.row_adjustments,

        charge_bearer:
          settlement.charge_bearer,

        gross_profit:
          settlement.gross_profit,

        net_profit:
          settlement.net_profit,

        company_payable:
          settlement.company_payable,

        narration:
          narration || "",

        updated_at:
          new Date(),
      };

      if (
        existingSettlement
      ) {
        await settlementCollection().updateOne(
          {
            _id:
              existingSettlement._id,
          },
          {
            $set:
              settlementDoc,

            $setOnInsert: {
              created_at:
                new Date(),
            },
          },
          {
            upsert:
              false,
          }
        );
      } else {
        await settlementCollection().insertOne({
          ...settlementDoc,

          created_at:
            new Date(),
        });
      }

      /*
       * Save company rate against
       * adjustment rows when allowed.
       */
      if (
        canEditCompanyRate &&
        adjustmentDetailsWithRates.length
      ) {
        for (
          const item of
            adjustmentDetailsWithRates
        ) {
          const adjustmentObjectId =
            normalizeObjectId(
              item.id
            );

          if (
            adjustmentObjectId
          ) {
            await adjustmentCollection().updateOne(
              {
                _id:
                  adjustmentObjectId,

                outward_id:
                  numericOutwardId,
              },
              {
                $set: {
                  company_rate:
                    num(
                      item.company_rate
                    ),

                  updated_at:
                    new Date(),
                },
              }
            );
          }
        }
      }

      return res.json({
        message:
          existingSettlement
            ? "Settlement updated successfully"
            : "Settlement saved successfully",

        outward_id:
          numericOutwardId,

        settlement:
          settlementDoc,

        source:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Settlement save failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

/*
====================================================
WHATSAPP SENT
====================================================
*/

router.post(
  "/adjustment/:id/whatsapp-sent",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "settlement.view"
      ) &&
      !userHasPermission(
        req.user,
        "adjustment.manage"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission",
      });
    }

    try {
      if (!requireMongo(res)) {
        return;
      }

      const adjustmentId =
        normalizeObjectId(
          req.params.id
        );

      if (!adjustmentId) {
        return res.status(400).json({
          error:
            "Invalid adjustment id",
        });
      }

      const sentAt =
        new Date();

      const result =
        await adjustmentCollection().updateOne(
          {
            _id:
              adjustmentId,
          },
          {
            $set: {
              whatsapp_sent_at:
                sentAt,

              updated_at:
                sentAt,
            },
          }
        );

      if (
        !result.matchedCount
      ) {
        return res.status(404).json({
          error:
            "Adjustment not found",
        });
      }

      return res.json({
        whatsapp_sent_at:
          sentAt,
      });
    } catch (err) {
      console.error(
        "WhatsApp sent update failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

/*
====================================================
SETTLEMENT REPORT LIST
====================================================
*/

router.get(
  "/report/list",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "settlement.view"
      ) &&
      !userHasPermission(
        req.user,
        "report.outwardSettlement"
      ) &&
      !userHasPermission(
        req.user,
        "outward.view"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to view outward settlement report",
      });
    }

    try {
      if (!requireMongo(res)) {
        return;
      }

      const {
        from_date,
        to_date,
        company_id,
        warehouse_id,
      } = req.query;

      const filter = {};

      if (
        from_date ||
        to_date
      ) {
        filter.date = {};

        if (from_date) {
          const from =
            new Date(
              `${from_date}T00:00:00`
            );

          if (
            !Number.isNaN(
              from.getTime()
            )
          ) {
            filter.date.$gte =
              from;
          }
        }

        if (to_date) {
          const to =
            new Date(
              `${to_date}T23:59:59.999`
            );

          if (
            !Number.isNaN(
              to.getTime()
            )
          ) {
            filter.date.$lte =
              to;
          }
        }

        if (
          !Object.keys(
            filter.date
          ).length
        ) {
          delete filter.date;
        }
      }

      if (
        company_id
      ) {
        const conditions =
          [];

        const n =
          Number(
            company_id
          );

        if (
          Number.isFinite(
            n
          )
        ) {
          conditions.push({
            company_id:
              n,
          });
        }

        if (
          mongoose.Types.ObjectId.isValid(
            String(
              company_id
            )
          )
        ) {
          conditions.push({
            company_id:
              String(
                company_id
              ),
          });
        }

        if (
          conditions.length
        ) {
          filter.$or =
            conditions;
        }
      }

      if (
        warehouse_id
      ) {
        const n =
          Number(
            warehouse_id
          );

        if (
          Number.isFinite(
            n
          )
        ) {
          filter.warehouse_id =
            n;
        } else {
          filter.warehouse_id =
            String(
              warehouse_id
            );
        }
      }

      const outwardRows =
        await MongoOutward.find(
          filter
        )
          .sort({
            date: -1,
            legacy_id: -1,
            _id: -1,
          })
          .lean();

      const result =
        [];

      for (
        const outward of
          outwardRows
      ) {
        const outwardId =
          Number(
            outward.legacy_id ??
              outward.id ??
              outward.sl_no
          );

        if (
          !Number.isFinite(
            outwardId
          )
        ) {
          continue;
        }

        const settlement =
          await findSettlementForOutward(
            outward
          );

        if (
          !settlement
        ) {
          continue;
        }

        const meta =
          await getOutwardMasterMeta(
            outward
          );

        const adjustmentDetails =
          await getAdjustmentDetails(
            outwardId
          );

        const unloadingDetails =
          await getUnloadingDetails(
            outwardId
          );

        const dispatchQty =
          num(
            settlement.dispatch_qty
          );

        const settlementWeight =
          adjustmentDetails.reduce(
            (sum, item) =>
              sum +
              num(
                item.settlement_weight
              ),
            0
          );

        const unloadingShortageQty =
          unloadingDetails.reduce(
            (sum, item) =>
              sum +
              num(
                item.shortage
              ),
            0
          );

        const shortage_qty =
          unloadingShortageQty ||
          num(
            settlement.billable_qty
          ) ||
          Math.max(
            dispatchQty -
              num(
                settlement.unloading_qty
              ),
            0
          );

        const claim_amount =
          num(
            settlement.claim_amount
          ) ||
          unloadingDetails.reduce(
            (sum, item) =>
              sum +
              num(
                item.claim
              ),
            0
          );

        const other_deduction =
          num(
            settlement.other_deduction
          ) ||
          unloadingDetails.reduce(
            (sum, item) =>
              sum +
              num(
                item.other_deduction
              ),
            0
          );

        const claim_details =
          normalizeDetailRows(
            settlement.claim_details,
            claim_amount,
            "Claim"
          );

        const other_deduction_details =
          normalizeDetailRows(
            settlement.other_deduction_details,
            other_deduction,
            "Deduction"
          );

        const rowAdjustments =
          normalizeRowAdjustments(
            settlement.row_adjustments
          );

        const rowAdjById =
          rowAdjustments.reduce(
            (acc, item) => {
              acc[
                String(
                  item.adjustment_id
                )
              ] = item;

              return acc;
            },
            {}
          );

        const mappedAdjustmentDetails =
          adjustmentDetails.map(
            (item, index) => {
              const rowCompanyRate =
                num(
                  item.adjustment_company_rate
                ) ||
                num(
                  settlement.company_rate
                );

              const weight =
                num(
                  item.settlement_weight
                );

              const amount =
                weight *
                rowCompanyRate;

              const perMtFreight =
                dispatchQty >
                0
                  ? num(
                      settlement.freight
                    ) /
                    dispatchQty
                  : 0;

              const perMtLabour =
                dispatchQty >
                0
                  ? num(
                      settlement.outward_labour_charges
                    ) /
                    dispatchQty
                  : 0;

              const perMtOther =
                dispatchQty >
                0
                  ? num(
                      settlement.other_charges
                    ) /
                    dispatchQty
                  : 0;

              const shortQtyPerLine =
                dispatchQty >
                0
                  ? (weight /
                      dispatchQty) *
                    shortage_qty
                  : 0;

              const autoShortAmount =
                shortQtyPerLine *
                rowCompanyRate;

              const autoClaim =
                dispatchQty >
                0
                  ? (weight /
                      dispatchQty) *
                    claim_amount
                  : 0;

              const autoFreight =
                weight *
                perMtFreight;

              const autoLabour =
                weight *
                perMtLabour;

              const autoOther =
                weight *
                perMtOther;

              const manual =
                rowAdjById[
                  String(
                    item.id
                  )
                ] || {};

              const short_amount =
                hasOwn(
                  manual,
                  "short_amt"
                )
                  ? num(
                      manual.short_amt
                    )
                  : autoShortAmount;

              const claim_per_line =
                hasOwn(
                  manual,
                  "s_amount"
                )
                  ? num(
                      manual.s_amount
                    )
                  : autoClaim;

              const deduction_per_line =
                hasOwn(
                  manual,
                  "c_deduction"
                )
                  ? num(
                      manual.c_deduction
                    )
                  : 0;

              const freight =
                hasOwn(
                  manual,
                  "freight"
                )
                  ? num(
                      manual.freight
                    )
                  : autoFreight;

              const labour_charges =
                hasOwn(
                  manual,
                  "labour_chgs"
                )
                  ? num(
                      manual.labour_chgs
                    )
                  : autoLabour;

              const other_charges =
                hasOwn(
                  manual,
                  "other_chgs"
                )
                  ? num(
                      manual.other_chgs
                    )
                  : autoOther;

              const net_payable =
                amount -
                short_amount -
                claim_per_line -
                deduction_per_line -
                freight -
                labour_charges -
                other_charges;

              return {
                ...item,

                sr_no:
                  index + 1,

                company_rate:
                  rowCompanyRate,

                shortQtyPerLine,

                shortAmount:
                  short_amount,

                short_amount,

                claim_per_line,

                deduction_per_line,

                freight,

                labour_charges,

                other_charges,

                amount,

                net_payable,
              };
            }
          );

        const company_payable =
          mappedAdjustmentDetails.reduce(
            (sum, item) =>
              sum +
              num(
                item.net_payable
              ),
            0
          );

        const saleAmount =
          num(
            settlement.sale_amount
          ) ||
          dispatchQty *
            num(
              settlement.sale_rate
            );

        const saleShortageAmount =
          mappedAdjustmentDetails.reduce(
            (sum, item) =>
              sum +
              num(
                item.shortQtyPerLine
              ) *
                num(
                  settlement.sale_rate
                ),
            0
          );

        const net_sale =
          saleAmount -
          saleShortageAmount -
          claim_amount -
          num(
            settlement.outward_labour_charges
          ) -
          num(
            settlement.freight
          ) -
          other_deduction -
          num(
            settlement.other_charges
          );

        const purchase_amount =
          mappedAdjustmentDetails.reduce(
            (sum, item) =>
              sum +
              num(
                item.amount
              ),
            0
          );

        const receivable_amount =
          net_sale -
          company_payable;

        const firstAdj =
          mappedAdjustmentDetails[0] ||
          {};

        const firstUnload =
          unloadingDetails[0] ||
          {};

        const accountName =
          firstNonEmpty(
            meta?.account_name,
            firstAdj.company_account_name,
            settlement.account_name,
            outward.company_account_name
          );

        const warehouseName =
          firstNonEmpty(
            meta?.warehouse_name,
            firstAdj.warehouse_name,
            outward.warehouse_name
          );

        const locationName =
          firstNonEmpty(
            meta?.location_name,
            firstAdj.location_name,
            outward.location_name
          );

        const productName =
          firstNonEmpty(
            meta?.product_name,
            firstAdj.product_name,
            firstUnload.product_name,
            outward.product_name,
            outward.product
          );

        result.push({
          ...outward,

          id:
            outwardId,

          mongo_id:
            outward._id
              ? String(
                  outward._id
                )
              : null,

          settlement_id:
            settlement._id
              ? String(
                  settlement._id
                )
              : null,

          account_name:
            accountName,

          company_account_name:
            accountName,

          accountName:
            accountName,

          warehouse_name:
            warehouseName,

          warehouseName:
            warehouseName,

          outward_warehouse_name:
            warehouseName,

          location_name:
            locationName,

          locationName:
            locationName,

          outward_location_name:
            locationName,

          product_name:
            productName,

          productName:
            productName,

          outward_product_name:
            productName,

          shortage_qty,

          settlement_weight:

            settlementWeight,

          sale_amount:
            saleAmount,

          company_amount:
            purchase_amount ||
            num(
              settlement.company_amount
            ),

          gross_amount:
            net_sale,

          company_payable,

          receivable_amount,

          average_rate:
            num(
              settlement.average_rate
            ),

          average_amount:
            num(
              settlement.average_amount
            ),

          claim_amount,

          other_deduction,

          unloading_date:
            settlement.unloading_date ||
            "",

          claim_details,

          other_deduction_details,

          row_adjustments:
            rowAdjustments,

          adjustment_details:
            mappedAdjustmentDetails,
        });
      }

      return res.json(
        result
      );
    } catch (err) {
      console.error(
        "Outward settlement report failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

module.exports = router;
