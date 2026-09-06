const express = require("express");
const router = express.Router();
const { userHasPermission } = require("../middleware/auth");
const { assignedWarehouseFilter, canAccessWarehouse } = require("../helpers/access");
const PDFDocument = require('pdfkit');
const multer = require("multer");
const XLSX = require("xlsx");
const tradingFilterCache = new Map();
const TRADING_FILTER_CACHE_MS = 15 * 60 * 1000;
const purchaseSearchCache = new Map();
const PURCHASE_SEARCH_CACHE_MS = 5 * 60 * 1000;

// Fast payment-edit/outstanding indexes. These are MongoDB indexes and
// prevent full-collection scans when filtering by farmer + account + warehouse.
function ensurePaymentMongoIndexes() {
  if (!mongoReady()) return;

  Promise.allSettled([
    PaymentVoucherNative
      ? PaymentVoucherNative.collection.createIndex(
          { farmer_id: 1, company_account_id: 1, warehouse_id: 1, date: -1 },
          { name: "payment_farmer_account_warehouse_date" }
        )
      : Promise.resolve(),
    PurchaseVoucher
      ? PurchaseVoucher.collection.createIndex(
          { farmer_id: 1, company_account_id: 1, warehouse_id: 1, date: -1 },
          { name: "purchase_farmer_account_warehouse_date" }
        )
      : Promise.resolve(),
    PaymentAdjustmentNative
      ? PaymentAdjustmentNative.collection.createIndex(
          { purchase_id: 1, payment_id: 1 },
          { name: "payment_adjustments_purchase_payment" }
        )
      : Promise.resolve(),
  ]).catch(() => {});
}
setImmediate(ensurePaymentMongoIndexes);

const {
  mongoose,
  PurchaseVoucher,
  SaleVoucher,
  Warehouse,
  Farmer,
  Product,
  Company,
  CompanyAccount,
  Consignee,
  Employee,
  Location,
} = require("../mongo");
const {
  MirrorRow,
  PaymentVoucher: MongoPaymentVoucher,
  PaymentAdjustment: MongoPaymentAdjustment,
  PaymentVoucherNative,
  PaymentAdjustmentNative,
  ReceiptVoucher: MongoReceiptVoucher,
  ReceiptAdjustment: MongoReceiptAdjustment,
  JournalVoucher: MongoJournalVoucher,
} = require("../db-mongodb");

const upload = multer({ storage: multer.memoryStorage() });

// STEP 9: Buyer/Consignee are dedicated MongoDB collections. Some older
// versions of ../mongo do not export these models, so never call .find() on
// an undefined model. Resolve the registered model first, then fall back to
// the dedicated collection names.
function getDedicatedPartyModel(kind) {
  const candidates = kind === "buyer"
    ? ["BuyerName", "BuyerNames", "buyernames", "buyer_names"]
    : ["ConsigneeName", "ConsigneeNames", "consigneenames", "consignee_names"];
  for (const name of candidates) {
    if (mongoose.models?.[name]) return mongoose.models[name];
  }
  return null;
}

async function findDedicatedPartyDocs(kind, query, projection) {
  const model = getDedicatedPartyModel(kind);
  if (model && typeof model.find === "function") {
    return model.find(query).select(projection || "").lean();
  }
  const conn = mongoose.connection;
  if (!conn?.db) return [];
  const names = kind === "buyer" ? ["buyernames", "buyer_names"] : ["consigneenames", "consignee_names"];
  for (const collectionName of names) {
    try {
      const exists = await conn.db.listCollections({ name: collectionName }).hasNext();
      if (!exists) continue;
      return conn.db.collection(collectionName).find(query, { projection: projection ? Object.fromEntries(String(projection).split(/\s+/).filter(Boolean).map((x) => [x.replace(/^-/, ""), !x.startsWith("-")])) : undefined }).toArray();
    } catch (err) {
      console.warn(`Dedicated ${kind} lookup skipped:`, err.message);
    }
  }
  return [];
}

// Trading report indexes. Build in the background so the first HTTP request is
// not blocked by index creation. These cover the common filter + newest-first
// pagination path used by Purchase/Sale reports.
let tradingIndexesStarted = false;
function ensureTradingIndexes() {
  if (tradingIndexesStarted || !mongoReady()) return;
  tradingIndexesStarted = true;
  Promise.allSettled([
    PurchaseVoucher.collection.createIndex({ date: -1, createdAt: -1, _id: -1 }, { name: "trading_purchase_date_desc" }),
    PurchaseVoucher.collection.createIndex({ warehouse_id: 1, company_account_id: 1, farmer_id: 1, date: -1, createdAt: -1 }, { name: "trading_purchase_filters_date" }),
    SaleVoucher.collection.createIndex({ date: -1, createdAt: -1, _id: -1 }, { name: "trading_sale_date_desc" }),
    SaleVoucher.collection.createIndex({ warehouse_id: 1, company_account_id: 1, farmer_id: 1, date: -1, createdAt: -1 }, { name: "trading_sale_filters_date" }),
  ]).catch(() => {});
}

function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function fmtNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

function toDateOnly(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function addDaysToDate(value, days) {
  const base = toDateOnly(value);
  const offset = Number(days);
  if (!base || !Number.isFinite(offset)) return "";
  const parsed = new Date(`${base}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + offset);
  return parsed.toISOString().slice(0, 10);
}

function calculateDaysDiff(startDate, endDate) {
  const start = toDateOnly(startDate);
  const end = toDateOnly(endDate);
  if (!start || !end) return 0;
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.max(0, Math.floor((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / msPerDay));
}

function resolveSaleDueFields(body, fallback = {}) {
  const explicitDueDate = toDateOnly(body?.due_date);
  const baseDate =
    toDateOnly(body?.unloading_date) ||
    toDateOnly(body?.deduction_details?.unloading_date) ||
    toDateOnly(body?.date) ||
    toDateOnly(fallback?.unloading_date) ||
    toDateOnly(fallback?.date);
  const fallbackDueDays = Number(fallback?.due_days || 0);
  const dueDaysInput = body?.due_days;
  const hasDueDays = dueDaysInput !== undefined && dueDaysInput !== null && String(dueDaysInput).trim() !== "";
  let dueDays = hasDueDays ? Number(dueDaysInput) : fallbackDueDays;
  if (!Number.isFinite(dueDays)) dueDays = 0;

  let dueDate = explicitDueDate;
  if (!dueDate && baseDate && (hasDueDays || fallbackDueDays > 0)) {
    dueDate = addDaysToDate(baseDate, dueDays);
  }
  if (!dueDate) {
    dueDate = toDateOnly(fallback?.due_date) || "";
  }
  if (explicitDueDate && !hasDueDays && baseDate) {
    dueDays = calculateDaysDiff(baseDate, explicitDueDate);
  }
  if (!dueDays && dueDate && baseDate) {
    dueDays = calculateDaysDiff(baseDate, dueDate);
  }

  return {
    due_date: dueDate,
    due_days: Number.isFinite(dueDays) ? dueDays : 0,
  };
}

function getFollowupStatusLabel(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "payment_done") return "Payment Done";
  if (normalized === "unloading_pending") return "Unloading Pending";
  if (normalized === "overdue") return "Overdue";
  return "Payment Pending";
}

function resolveSaleDueDate(body, fallback = {}) {
  return resolveSaleDueFields(body, fallback).due_date;
}

function calculateSaleFollowupMeta(row) {
  const unloadingDate = toDateOnly(row?.unloading_date);
  const outstanding = Number(row?.outstanding ?? row?.net_amount_payable ?? row?.net_receivable_amount ?? row?.amount ?? 0);
  const today = toDateOnly(new Date().toISOString().slice(0, 10));
  const dueDaysRaw = row?.due_days;
  let dueDays = Number.isFinite(Number(dueDaysRaw)) ? Number(dueDaysRaw) : 0;
  const rawDueDate = toDateOnly(row?.due_date);
  const normalizedDueDate =
    unloadingDate && dueDays > 0
      ? addDaysToDate(unloadingDate, dueDays)
      : rawDueDate;
  const dueDate = normalizedDueDate || (unloadingDate && dueDays > 0 ? addDaysToDate(unloadingDate, dueDays) : "");
  if (!dueDays && dueDate && unloadingDate) {
    dueDays = calculateDaysDiff(unloadingDate, dueDate);
  }
  const daysOverdue = dueDate ? calculateDaysDiff(dueDate, today) : 0;

  let followupStatus = "pending";
  let followupPriority = 1000;
  if (!unloadingDate) {
    followupStatus = "unloading_pending";
    followupPriority = 2000;
  } else if (outstanding <= 0) {
    followupStatus = "payment_done";
    followupPriority = 0;
  } else if (daysOverdue > 0) {
    followupStatus = "overdue";
    followupPriority = 3000 + daysOverdue;
  }

  return {
    due_date: dueDate,
    due_days: Number.isFinite(dueDays) ? dueDays : 0,
    days_overdue: followupStatus === "overdue" ? daysOverdue : 0,
    followup_status: followupStatus,
    followup_priority: followupPriority,
    balance: outstanding,
  };
}

function parseVoucherListOptions(req) {
  const rawPage = Number.parseInt(req.query.page, 10);
  const rawLimit = Number.parseInt(req.query.limit || req.query.page_size, 10);
  const all = String(req.query.all || "") === "1";
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = all ? Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 5000, 1), 5000) : Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 15, 1), 100);
  const order = String(req.query.order || "desc").toLowerCase() === "asc" ? 1 : -1;
  const search = String(req.query.search || "").trim();
  const warehouseId = String(req.query.warehouse_id || "").trim();
  const farmerId = String(req.query.farmer_id || "").trim();
  const buyerId = String(req.query.buyer_id || "").trim();
  const companyAccountId = String(req.query.company_account_id || "").trim();
  const productId = String(req.query.product_id || "").trim();
  const fromDate = toDateOnly(req.query.from_date);
  const toDate = toDateOnly(req.query.to_date);
  return {
    page,
    limit,
    skip: all ? 0 : (page - 1) * limit,
    all,
    order,
    search,
    warehouseId,
    farmerId,
    buyerId,
    companyAccountId,
    productId,
    fromDate,
    toDate,
  };
}

function applyVoucherListFilters(query, options, type) {
  const scope = mongoPurchaseScope(query.user);
  const filter = { ...scope };

  if (options.warehouseId) filter.warehouse_id = options.warehouseId;
  if (options.companyAccountId) filter.company_account_id = options.companyAccountId;
  if (options.productId) filter.product_id = options.productId;
  if (type === "purchase" && options.farmerId) filter.farmer_id = options.farmerId;
  if (type === "sale" && options.buyerId) filter.buyer_id = options.buyerId;

  if (options.fromDate || options.toDate) {
    filter.date = {};
    if (options.fromDate) filter.date.$gte = options.fromDate;
    if (options.toDate) filter.date.$lte = options.toDate;
  }

  if (options.search && type !== "purchase") {
    const safe = options.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(safe, "i");
    const fields = type === "purchase"
      ? ["voucher_no", "farmer_name", "product_name", "warehouse_name", "company_account_name", "description"]
      : ["voucher_no", "bill_no", "buyer_name", "company_name", "product_name", "warehouse_name", "company_account_name", "consignee_name", "lorry_no", "po_no", "description"];
    filter.$or = fields.map((field) => ({ [field]: rx }));
  }

  return filter;
}

function addMixedIdFilter(filter, field, value) {
  const text = String(value || "").trim();
  if (!text) return;

  const values = [text];
  if (/^\d+$/.test(text)) values.push(Number(text));
  if (mongoose.Types.ObjectId.isValid(text)) values.push(text);

  filter.$and = [
    ...(filter.$and || []),
    { $or: values.map((item) => ({ [field]: item })) },
  ];
}

function addVoucherSearchFilter(filter, search, fields) {
  const text = String(search || "").trim();
  if (!text) return;
  const safe = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(safe, "i");
  filter.$and = [
    ...(filter.$and || []),
    { $or: fields.map((field) => ({ [field]: rx })) },
  ];
}

async function addPurchaseSearchFilter(filter, search) {
  const text = String(search || "").trim();
  if (!text) return;

  const cacheKey = text.toLowerCase();
  const cached = purchaseSearchCache.get(cacheKey);
  let idClauses;
  if (cached && Date.now() - cached.time < PURCHASE_SEARCH_CACHE_MS) {
    idClauses = cached.idClauses;
  } else {
    const safe = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(safe, "i");
    const [farmers, products, warehouses, accounts] = await Promise.all([
      Farmer.find({ name: rx }).select("_id id legacy_id").lean(),
      Product.find({ name: rx }).select("_id id legacy_id").lean(),
      Warehouse.find({ name: rx }).select("_id id legacy_id").lean(),
      CompanyAccount.find({ $or: [{ account_name: rx }, { name: rx }] }).select("_id id legacy_id").lean(),
    ]);

    const clausesFor = (field, rows) => rows.flatMap((row) => {
      const ids = [row?._id, row?.id, row?.legacy_id]
        .filter((value) => value !== undefined && value !== null && String(value) !== "")
        .map(String);
      return ids.flatMap((id) => [
        { [field]: id },
        ...(Number.isFinite(Number(id)) ? [{ [field]: Number(id) }] : []),
      ]);
    });

    idClauses = [
      ...clausesFor("farmer_id", farmers),
      ...clausesFor("product_id", products),
      ...clausesFor("warehouse_id", warehouses),
      ...clausesFor("company_account_id", accounts),
    ];
    purchaseSearchCache.set(cacheKey, { time: Date.now(), idClauses });
  }

  const safe = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(safe, "i");

  filter.$and = [
    ...(filter.$and || []),
    {
      $or: [
        { voucher_no: rx },
        { farmer_name: rx },
        { product_name: rx },
        { warehouse_name: rx },
        { company_account_name: rx },
        { description: rx },
        ...idClauses,
      ],
    },
  ];
}

function voucherListResponse(rows, total, options) {
  const pageCount = Math.max(1, Math.ceil(total / options.limit));
  return {
    data: rows || [],
    pagination: {
      page: options.page,
      pageSize: options.limit,
      total,
      totalPages: pageCount,
      hasMore: options.page < pageCount,
    },
  };
}

async function getPurchaseVoucherPage(req) {
  const options = parseVoucherListOptions(req);
  const filter = applyVoucherListFilters({ user: req.user }, options, "purchase");
  await addPurchaseSearchFilter(filter, options.search);
  const [total, docs] = await Promise.all([
    PurchaseVoucher.countDocuments(filter),
    PurchaseVoucher.find(filter)
      .sort({ date: options.order, _id: options.order })
      .skip(options.skip)
      .limit(options.limit)
      .lean(),
  ]);
  const rows = await decoratePurchaseRows(docs);
  if (options.all) return rows;
  return voucherListResponse(rows, total, options);
}

async function getSaleVoucherPage(req) {
  const options = parseVoucherListOptions(req);
  const filter = applyVoucherListFilters({ user: req.user }, options, "sale");
  const [total, docs] = await Promise.all([
    SaleVoucher.countDocuments(filter),
    SaleVoucher.find(filter)
      .sort({ date: options.order, _id: options.order })
      .skip(options.skip)
      .limit(options.limit)
      .lean(),
  ]);
  let rows;
  try {
    rows = await decorateSaleRows(docs);
  } catch (decorateErr) {
    console.error("Sale list decoration skipped:", decorateErr);
    rows = (docs || []).map((row) => ({
      ...(row || {}),
      id: String(row?._id || row?.id || ""),
      _id: String(row?._id || row?.id || ""),
      buyer_id: String(row?.buyer_id || row?.company_id || ""),
      total_quantity: Number(row?.quantity || row?.total_quantity || 0),
      total_amount: Number(row?.amount || row?.total_amount || 0),
      ...calculateSaleFollowupMeta(row || {}),
    }));
  }
  // Do not make the fast MongoDB Sale list wait for the legacy bilti
  // table. Bilti is an auxiliary field and is loaded lazily by the relevant
  // action. This removes an unnecessary cross-database query from every page.
  return voucherListResponse(
    rows.map((row) => ({ ...row, bilti_id: row.bilti_id || null, ...calculateSaleFollowupMeta(row) })),
    total,
    options
  );
}

function getSaleVoucherRows(req, res) {
  if (!mongoReady()) {
    return res.status(503).json({ error: "MongoDB is required for Warehouse Trading voucher lists" });
  }
  getSaleVoucherPage(req)
    .then((payload) => res.json(payload))
    .catch((err) => {
      console.error("Mongo sale voucher page query failed:", err);
      res.status(500).json({ error: err.message || "Failed to load sale vouchers" });
    });
}

const mongoReady = () => mongoose.connection.readyState === 1;

const numberFields = [
  "quantity",
  "rate",
  "amount",
  "packet",
  "gross_weight",
  "tare_weight",
  "dhalta",
  "less_bags_weight",
  "moisture",
  "dunki",
  "fungus",
  "discolour",
  "others",
  "transport_charge",
  "net_weight",
  "bags_claim",
  "labour",
  "claim_amount",
  "other_deduction",
  "cd_percent",
  "cd_amount",
  "adjustment_amount",
  "tds_amount",
  "total_deduct_amount",
  "total_qty",
  "total_deduction",
  "round_off",
  "net_amount_payable",
];

function buildPurchasePayload(body, voucherNo) {
  const payload = {
    voucher_no: voucherNo || body.voucher_no,
    date: body.date,
    warehouse_id: body.warehouse_id ? String(body.warehouse_id) : "",
    farmer_id: body.farmer_id ? String(body.farmer_id) : "",
    company_account_id: body.company_account_id ? String(body.company_account_id) : "",
    product_id: body.product_id ? String(body.product_id) : "",
    employee_id: body.employee_id ? String(body.employee_id) : "",
    location_id: body.location_id ? String(body.location_id) : "",
    description: body.description || "",
  };

  numberFields.forEach((field) => {
    const value = Number(body[field]);
    payload[field] = Number.isFinite(value) ? value : 0;
  });

  return payload;
}


function buildPurchaseDeductionDetails(body = {}) {
  const n = (key) => {
    const value = Number(body?.[key]);
    return Number.isFinite(value) ? value : 0;
  };
  const claim = n("claim_amount") || n("bags_claim");
  const rows = [
    { key: "tds", label: "TDS", amount: n("tds_amount"), account_label: "TDS" },
    { key: "cd", label: `CD${n("cd_percent") > 0 ? ` ${n("cd_percent")} %` : ""}`, amount: n("cd_amount"), account_label: "Cash Discount" },
    { key: "claim", label: "Claim", amount: claim, account_label: "Claim" },
    { key: "labour", label: "EXP", amount: n("labour"), account_label: "Labour" },
    { key: "transport", label: "Freight", amount: n("transport_charge"), account_label: "Freight" },
    { key: "other", label: "Other Deduction", amount: n("other_deduction"), account_label: "Other Deduction" },
    { key: "adjustment", label: "Adjustment", amount: n("adjustment_amount"), account_label: "Adjustment" },
  ];
  return rows
    .filter((row) => row.amount > 0)
    .map((row) => ({
      key: row.key,
      label: row.label,
      account_label: row.account_label,
      amount: Number(row.amount.toFixed(2)),
    }));
}

function purchaseDeductionTotalFromRow(row = {}) {
  const n = (key) => Number(row?.[key]) || 0;
  const claim = n("claim_amount") || n("bags_claim");
  return Number((
    claim + n("labour") + n("transport_charge") + n("cd_amount") + n("tds_amount") + n("other_deduction") + n("adjustment_amount")
  ).toFixed(2));
}

function purchaseGrossAmountFromRow(row = {}) {
  const qty = Number(row.total_qty || row.net_weight || row.quantity || 0) || 0;
  const rate = Number(row.rate || 0) || 0;
  const calculated = qty * rate;
  return Number((calculated || row.gross_amount || row.amount || 0).toFixed(2));
}

function buildSalePayload(body, voucherNo) {
  const purchaseLinks = Array.isArray(body.against_purchase_links)
    ? body.against_purchase_links
        .map((item) => {
          const quantity = Number(item.quantity || item.adjusted_qty || 0);
          const rate = Number(item.rate || 0);
          const amount = Number(item.amount || quantity * rate || 0);
          return {
            purchase_id: item.purchase_id ? String(item.purchase_id) : "",
            voucher_no: item.voucher_no || item.purchase_voucher_no || "",
            farmer_id: item.farmer_id ? String(item.farmer_id) : "",
            quantity: Number.isFinite(quantity) ? quantity : 0,
            rate: Number.isFinite(rate) ? rate : 0,
            amount: Number.isFinite(amount) ? amount : 0,
          };
        })
        .filter((item) => item.purchase_id && item.quantity > 0)
    : [];

  const payload = {
    voucher_no: voucherNo || body.voucher_no,
    date: body.date,
    unloading_date: body.unloading_date || body?.deduction_details?.unloading_date || "",
    sale_type: body.sale_type === "direct" ? "direct" : "warehouse",
    warehouse_id: body.warehouse_id ? String(body.warehouse_id) : "",
    buyer_id: body.buyer_id || body.company_id ? String(body.buyer_id || body.company_id) : "",
    company_id: body.company_id || body.buyer_id ? String(body.company_id || body.buyer_id) : "",
    farmer_id: body.farmer_id || body.against_purchase_farmer_id ? String(body.farmer_id || body.against_purchase_farmer_id) : "",
    company_account_id: body.company_account_id ? String(body.company_account_id) : "",
    consignee_id: body.consignee_id ? String(body.consignee_id) : "",
    po_no: body.po_no || "",
    direct_purchase_rate: Number(body.direct_purchase_rate) || 0,
    direct_purchase_amount: Number(body.direct_purchase_amount) || 0,
    against_purchase_enabled: Boolean(body.against_purchase_enabled && purchaseLinks.length),
    against_purchase_farmer_id: body.against_purchase_farmer_id ? String(body.against_purchase_farmer_id) : "",
    against_purchase_links: purchaseLinks,
    lorry_no: body.lorry_no || body.reference_id || "",
    journey_token: body.journey_token || "",
    product_id: body.product_id ? String(body.product_id) : "",
    employee_id: body.employee_id ? String(body.employee_id) : "",
    location_id: body.location_id ? String(body.location_id) : "",
    description: body.description || "",
    reject_qty: Number(body.reject_qty) || 0,
  };

  const saleFields = [
    "quantity",
    "shortage_quantity",
    "rate",
    "amount",
    "packet",
    "gross_weight",
    "tare_weight",
    "net_weight",
    "unloading_qty",
    "reject_qty",
    "moisture",
    "dunki",
    "fungus",
    "discolour",
    "others",
    "total_deduction",
    "bags_claim",
    "other_deduction",
    "transport_charge",
    "claim_amount",
    "cd_percent",
    "cd_amount",
    "adjustment_amount",
    "tds_amount",
    "net_amount",
    "net_receivable_amount",
    "fifo_rate",
    "fifo_amount",
    "outstanding",
    "round_off",
    "net_amount_payable",
  ];

  saleFields.forEach((field) => {
    const value = Number(body[field]);
    payload[field] = Number.isFinite(value) ? value : 0;
  });

  const dueFields = resolveSaleDueFields(body);
  payload.due_date = dueFields.due_date;
  payload.due_days = dueFields.due_days;

  const grossAmount = payload.amount;
  const netAmount =
    grossAmount -
    payload.claim_amount -
    payload.other_deduction -
    payload.transport_charge -
    payload.cd_amount -
    payload.adjustment_amount -
    payload.tds_amount +
    payload.round_off;
  const qtyForFifo = payload.unloading_qty || payload.quantity;
  payload.net_amount = netAmount;
  payload.net_amount_payable = netAmount;
  payload.net_receivable_amount = netAmount;
  payload.outstanding = netAmount;
  payload.fifo_amount = grossAmount;
  payload.fifo_rate = qtyForFifo > 0 ? grossAmount / qtyForFifo : 0;
  if (payload.sale_type === "direct") {
    payload.warehouse_id = "";
    payload.direct_purchase_amount = Number((qtyForFifo * payload.direct_purchase_rate).toFixed(2));
  }

  return payload;
}

async function createDirectSalePurchaseVoucher(salePayload) {
  if (salePayload.sale_type !== "direct") return null;
  const farmerId = String(salePayload.farmer_id || salePayload.against_purchase_farmer_id || "").trim();
  if (!farmerId) throw new Error("Farmer is required for direct sale purchase entry");
  if (!salePayload.location_id) throw new Error("Location is required for direct sale");
  if (!salePayload.direct_purchase_rate || salePayload.direct_purchase_rate <= 0) {
    throw new Error("Purchase rate is required for direct sale");
  }

  const purchaseVoucherNo = await nextMongoVoucherNo("purchase");
  const qty = Number(salePayload.unloading_qty || salePayload.quantity || 0);
  const amount = Number((qty * Number(salePayload.direct_purchase_rate || 0)).toFixed(2));
  const doc = await PurchaseVoucher.create({
    voucher_no: purchaseVoucherNo,
    date: salePayload.date,
    warehouse_id: "",
    farmer_id: farmerId,
    company_account_id: salePayload.company_account_id || "",
    product_id: salePayload.product_id || "",
    employee_id: salePayload.employee_id || "",
    location_id: salePayload.location_id || "",
    quantity: qty,
    rate: Number(salePayload.direct_purchase_rate || 0),
    amount,
    net_weight: qty,
    total_qty: qty,
    net_amount_payable: amount,
    description: `Auto direct sale purchase against ${salePayload.voucher_no || "sale"}`,
  });

  return {
    purchase_id: String(doc._id),
    voucher_no: doc.voucher_no,
    farmer_id: farmerId,
    quantity: qty,
    rate: Number(salePayload.direct_purchase_rate || 0),
    amount,
  };
}

async function getAvailableSaleStock({ warehouseId, productId, excludeSaleId = null }) {
  const wId = String(warehouseId || "").trim();
  const pId = String(productId || "").trim();
  if (!wId || !pId) return 0;

  if (mongoReady()) {
    const purchaseFilter = { warehouse_id: wId, product_id: pId };
    const saleFilter = { warehouse_id: wId, product_id: pId };
    if (excludeSaleId && mongoose.Types.ObjectId.isValid(String(excludeSaleId))) {
      saleFilter._id = { $ne: String(excludeSaleId) };
    }
    const [purchaseRows, saleRows] = await Promise.all([
      PurchaseVoucher.find(purchaseFilter).lean(),
      SaleVoucher.find(saleFilter).lean(),
    ]);
    const purchaseQty = (purchaseRows || []).reduce(
      (sum, row) => sum + Number(row.total_qty || row.net_weight || row.quantity || 0),
      0
    );
    const saleQty = (saleRows || []).reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    return Number((purchaseQty - saleQty).toFixed(4));
  }

  const purchaseFilter = { warehouse_id: wId, product_id: pId };
  const saleFilter = { warehouse_id: wId, product_id: pId };
  if (excludeSaleId) {
    const exclude = String(excludeSaleId);
    if (mongoose.Types.ObjectId.isValid(exclude)) {
      saleFilter._id = { $ne: exclude };
    }
    const numericExclude = Number(exclude);
    if (Number.isFinite(numericExclude)) {
      saleFilter.id = { $ne: numericExclude };
    }
  }

  const [purchaseRows, saleRows] = await Promise.all([
    PurchaseVoucher.aggregate([
      { $match: purchaseFilter },
      {
        $group: {
          _id: null,
          purchase_qty: {
            $sum: {
              $ifNull: [
                "$total_qty",
                { $ifNull: ["$net_weight", { $ifNull: ["$quantity", 0] }] },
              ],
            },
          },
        },
      },
    ]),
    SaleVoucher.aggregate([
      { $match: saleFilter },
      {
        $group: {
          _id: null,
          sale_qty: { $sum: { $ifNull: ["$quantity", 0] } },
        },
      },
    ]),
  ]);

  const purchaseQty = Number(purchaseRows?.[0]?.purchase_qty || 0);
  const saleQty = Number(saleRows?.[0]?.sale_qty || 0);
  return Number((purchaseQty - saleQty).toFixed(4));
}

router.get("/available-sale-stock", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.sale.view") && !userHasPermission(req.user, "warehouse.trading.sale.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { warehouse_id, product_id, exclude_sale_id } = req.query;
  if (!warehouse_id || !product_id) {
    return res.json({ stock_qty: null });
  }
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  try {
    const stockQty = await getAvailableSaleStock({
      warehouseId: warehouse_id,
      productId: product_id,
      excludeSaleId: exclude_sale_id || null,
    });
    res.json({ stock_qty: stockQty });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getTransportBiltiMatch({ saleId, voucherNo = "", lorryNo = "" }) {
  const saleIdText = String(saleId || "").trim();
  const voucherNoText = String(voucherNo || "").trim();
  const lorryNoText = String(lorryNo || "").trim();

  if (mongoose.connection?.db && MirrorRow) {
    const mongoFilters = [];
    if (saleIdText) {
      mongoFilters.push({ "data.sale_id": saleIdText }, { "data.sale_id": Number(saleIdText) });
    }
    if (voucherNoText) {
      mongoFilters.push({ "data.voucher_no": voucherNoText });
    }
    if (lorryNoText) {
      mongoFilters.push({ "data.lorry_no": lorryNoText });
    }

    for (const filter of mongoFilters) {
      const doc = await MirrorRow.findOne({ table: "transport_bilti", ...filter })
        .sort({ updated_at: -1, row_id: -1 })
        .lean();
      if (doc?.data) {
        const data = doc.data || {};
        const matchedField = Object.keys(filter).find((key) => key.startsWith("data."))?.replace("data.", "") || "sale_id";
        return {
          ...data,
          id: doc.row_id,
          _id: doc._id,
          transport_amount: Number(data.payable_amount || data.net_amount || data.gross_freight || 0),
          source: `mongo-mirror:${matchedField}`,
        };
      }
    }
  }

  return null;
}

function createVoucherNoPromise(type, voucherNo = "") {
  return new Promise((resolve, reject) => {
    createVoucherNoIfMissing(type, voucherNo, (err, generatedVoucherNo) => {
      if (err) return reject(err);
      resolve(generatedVoucherNo);
    });
  });
}

async function recreateSaleDeductionJournals({ sale, body, shortageAmount, deductionAmount, cdAmount, tdsAmount }) {
  const saleVoucherNo = String(sale?.voucher_no || body?.voucher_no || "").trim();
  if (!saleVoucherNo) return [];

  if (MongoJournalVoucher) {
    await MongoJournalVoucher.deleteMany({
      description: {
        $regex: `^Auto sale deduction:${saleVoucherNo}:`,
      },
    });
  }

  const journalBase = {
    date: body.unloading_date || body.date || sale.date,
    warehouse_id: body.warehouse_id || sale.warehouse_id,
    company_account_id: body.company_account_id || sale.company_account_id,
    employee_id: body.employee_id || sale.employee_id || null,
    location_id: body.location_id || sale.location_id || null,
  };

  const rows = [
    { key: "shortage", label: "Shortage", amount: Number(shortageAmount || 0) },
    { key: "claim", label: "Claim", amount: Number(deductionAmount || 0) },
    { key: "cash_discount", label: "Cash Discount", amount: Number(cdAmount || 0) },
    { key: "tds", label: "TDS", amount: Number(tdsAmount || 0) },
  ].filter((row) => Number.isFinite(row.amount) && row.amount > 0);

  const created = [];
  for (const row of rows) {
    const voucherNo = await createVoucherNoPromise("journal");
    const description = `Auto sale deduction:${saleVoucherNo}:${row.key}`;
    if (!MongoJournalVoucher) continue;
    const journal = await MongoJournalVoucher.create({
      voucher_no: voucherNo,
      date: journalBase.date,
      warehouse_id: journalBase.warehouse_id,
      company_account_id: journalBase.company_account_id,
      debit_account: "Sale Party",
      credit_account: row.label,
      amount: row.amount,
      employee_id: journalBase.employee_id,
      location_id: journalBase.location_id,
      description,
    });
    created.push({ id: journal._id, voucher_no: voucherNo, type: row.key, amount: row.amount });
  }

  return created;
}

function assignedWarehouseIdsForMongo(user) {
  return Array.from(
    new Set(
      (Array.isArray(user?.assigned_warehouse_ids) ? user.assigned_warehouse_ids : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )
  );
}

function mongoPurchaseScope(user) {
  if (!user || user.role === "admin" || userHasPermission(user, "warehouses.manage")) {
    return {};
  }

  const ids = assignedWarehouseIdsForMongo(user);
  if (ids.length === 0) return { _id: null };
  return { warehouse_id: { $in: ids } };
}

function mongoSaleScope(user) {
  if (!user || user.role === "admin" || userHasPermission(user, "warehouses.manage")) {
    return {};
  }
  const ids = assignedWarehouseIdsForMongo(user);
  if (ids.length === 0) return { _id: null };
  return { warehouse_id: { $in: ids } };
}

async function nextMongoVoucherNo(type) {
  const shortPrefix = getVoucherPrefix(type);
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `${shortPrefix}-${datePart}-`;

  if (!mongoose.connection?.db) {
    throw new Error("MongoDB connection is not available");
  }

  let collectionName;

  switch (String(type || "").toLowerCase()) {
    case "purchase":
      collectionName = "purchasevouchers";
      break;
    case "sale":
      collectionName = "salevouchers";
      break;
    case "payment":
      collectionName = "paymentvouchers_native";
      break;
    case "receipt":
      collectionName = "receiptvouchers";
      break;
    case "journal":
      collectionName = "wh_journal_vouchers";
      break;
    default:
      throw new Error(`Unsupported voucher type: ${type}`);
  }

  const rows = await mongoose.connection.db
    .collection(collectionName)
    .find(
      {
        $or: [
          { voucher_no: { $regex: `^${shortPrefix}-` } },
          { "data.voucher_no": { $regex: `^${shortPrefix}-` } },
        ],
      },
      {
        projection: {
          voucher_no: 1,
          "data.voucher_no": 1,
        },
      }
    )
    .sort({ _id: -1 })
    .limit(500)
    .toArray();

  let next = 1;

  for (const row of rows || []) {
    const voucher =
      row?.voucher_no ||
      row?.data?.voucher_no ||
      "";

    const parts = String(voucher).split("-");
    const last = Number(parts[parts.length - 1]);

    if (Number.isFinite(last) && last >= next) {
      next = last + 1;
    }
  }

  return `${prefix}${String(next).padStart(4, "0")}`;
}

function mongoIdFilter(id) {
  const value = String(id || "");
  return mongoose.Types.ObjectId.isValid(value) ? { _id: value } : null;
}

async function decoratePurchaseRows(rows) {
  const warehouseIds = [...new Set(rows.map((r) => r.warehouse_id).filter(mongoose.Types.ObjectId.isValid))];
  const farmerIds = [...new Set(rows.map((r) => r.farmer_id).filter(mongoose.Types.ObjectId.isValid))];
  const productIds = [...new Set(rows.map((r) => r.product_id).filter(mongoose.Types.ObjectId.isValid))];
  const accountIds = [...new Set(rows.map((r) => r.company_account_id).filter(mongoose.Types.ObjectId.isValid))];

  const [warehouses, farmers, products, accounts] = await Promise.all([
    warehouseIds.length ? Warehouse.find({ _id: { $in: warehouseIds } }).lean() : [],
    farmerIds.length ? Farmer.find({ _id: { $in: farmerIds } }).lean() : [],
    productIds.length ? Product.find({ _id: { $in: productIds } }).lean() : [],
    accountIds.length ? CompanyAccount.find({ _id: { $in: accountIds } }).lean() : [],
  ]);

  const byId = (items) => new Map(items.map((item) => [String(item._id), item]));
  const warehouseMap = byId(warehouses);
  const farmerMap = byId(farmers);
  const productMap = byId(products);
  const accountMap = byId(accounts);

  return rows.map((row) => {
    const plain = row.toObject ? row.toObject() : row;
    const warehouse = warehouseMap.get(String(plain.warehouse_id));
    const farmer = farmerMap.get(String(plain.farmer_id));
    const product = productMap.get(String(plain.product_id));
    const account = accountMap.get(String(plain.company_account_id));
    return {
      ...plain,
      id: String(plain._id),
      _id: String(plain._id),
      warehouse_name: warehouse?.name || plain.warehouse_name,
      warehouse_address: warehouse?.address || plain.warehouse_address,
      warehouse_location: warehouse?.location || plain.warehouse_location,
      warehouse_city: warehouse?.city || plain.warehouse_city,
      warehouse_district: warehouse?.district || plain.warehouse_district,
      warehouse_state: warehouse?.state || plain.warehouse_state,
      warehouse_pincode: warehouse?.pincode || plain.warehouse_pincode,
      farmer_name: farmer?.name || plain.farmer_name,
      farmer_mobile: farmer?.mobile || plain.farmer_mobile,
      farmer_address: farmer?.address || plain.farmer_address,
      farmer_village: farmer?.village || plain.farmer_village,
      farmer_city: farmer?.city || plain.farmer_city,
      farmer_district: farmer?.district || plain.farmer_district,
      farmer_state: farmer?.state || plain.farmer_state,
      farmer_pincode: farmer?.pincode || plain.farmer_pincode,
      farmer_gst: farmer?.gst_no || farmer?.gst || plain.farmer_gst,
      farmer_pan: farmer?.pan_no || farmer?.pan || plain.farmer_pan,
      product_name: product?.name || plain.product_name,
      company_account_name: account?.account_name || plain.company_account_name,
      company_account_address: account?.address || plain.company_account_address,
      company_account_mobile: account?.mobile || plain.company_account_mobile,
      company_account_email: account?.email || plain.company_account_email,
      company_account_city: account?.city || plain.company_account_city,
      company_account_district: account?.district || plain.company_account_district,
      company_account_state: account?.state || plain.company_account_state,
      company_account_pincode: account?.pincode || plain.company_account_pincode,
      company_account_gst: account?.gst_no || account?.gst || plain.company_account_gst,
      company_account_pan: account?.pan_no || account?.pan || plain.company_account_pan,
      total_quantity: plain.total_qty || plain.net_weight || plain.quantity || 0,
      total_amount: plain.net_amount_payable || plain.amount || 0,
      gross_amount: (plain.total_qty || plain.net_weight || plain.quantity || 0) * (plain.rate || 0),
    };
  });
}

async function decorateSaleRows(rows) {
  const plainRows = (Array.isArray(rows) ? rows : []).map((row) => (row?.toObject ? row.toObject() : row));
  if (!plainRows.length) return [];

  const warehouseIds = [...new Set(plainRows.map((r) => String(r?.warehouse_id || "")).filter(Boolean))];
  const productIds = [...new Set(plainRows.map((r) => String(r?.product_id || "")).filter(Boolean))];
  const accountIds = [...new Set(plainRows.map((r) => String(r?.company_account_id || "")).filter(Boolean))];
  const buyerIds = [...new Set(plainRows.map((r) => String(r?.buyer_id || r?.company_id || "")).filter(Boolean))];
  const consigneeIds = [...new Set(plainRows.map((r) => String(r?.consignee_id || "")).filter(Boolean))];

  const safeObjectIds = (ids) => ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
  const mongoWarehouseIds = safeObjectIds(warehouseIds);
  const mongoProductIds = safeObjectIds(productIds);
  const mongoAccountIds = safeObjectIds(accountIds);

  const legacyIds = (ids) => ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
  const buyerLegacyIds = legacyIds(buyerIds);
  const consigneeLegacyIds = legacyIds(consigneeIds);
  const buyerObjectIds = safeObjectIds(buyerIds);
  const consigneeObjectIds = safeObjectIds(consigneeIds);

  // Buyer and Consignee are now dedicated MongoDB collections. Do not read
  // them from mirror rows or legacy storage. Support both legacy numeric IDs and
  // Mongo ObjectIds so old vouchers continue to display their names.
  const buyerQuery = buyerIds.length ? {
    $or: [
      ...(buyerLegacyIds.length ? [{ legacy_id: { $in: buyerLegacyIds } }] : []),
      ...(buyerObjectIds.length ? [{ _id: { $in: buyerObjectIds } }] : []),
    ],
  } : null;
  const consigneeQuery = consigneeIds.length ? {
    $or: [
      ...(consigneeLegacyIds.length ? [{ legacy_id: { $in: consigneeLegacyIds } }] : []),
      ...(consigneeObjectIds.length ? [{ _id: { $in: consigneeObjectIds } }] : []),
    ],
  } : null;

  const results = await Promise.allSettled([
    mongoWarehouseIds.length ? Warehouse.find({ _id: { $in: mongoWarehouseIds } }).lean() : Promise.resolve([]),
    mongoProductIds.length ? Product.find({ _id: { $in: mongoProductIds } }).lean() : Promise.resolve([]),
    mongoAccountIds.length ? CompanyAccount.find({ _id: { $in: mongoAccountIds } }).lean() : Promise.resolve([]),
    buyerQuery ? findDedicatedPartyDocs("buyer", buyerQuery) : Promise.resolve([]),
    consigneeQuery ? findDedicatedPartyDocs("consignee", consigneeQuery) : Promise.resolve([]),
  ]);

  const valueAt = (index) => results[index].status === "fulfilled" && Array.isArray(results[index].value) ? results[index].value : [];
  results.forEach((result, index) => {
    if (result.status === "rejected") console.warn(`Sale row lookup ${index} skipped:`, result.reason?.message || result.reason);
  });

  const byMongoId = (items) => new Map(items.map((item) => [String(item?._id), item]));
  const byLegacyOrMongoId = (items) => {
    const map = new Map();
    for (const item of items) {
      if (item?._id) map.set(String(item._id), item);
      if (item?.legacy_id !== undefined && item?.legacy_id !== null) map.set(String(item.legacy_id), item);
    }
    return map;
  };
  const mongoWarehouseMap = byMongoId(valueAt(0));
  const mongoProductMap = byMongoId(valueAt(1));
  const mongoAccountMap = byMongoId(valueAt(2));
  const buyerMap = byLegacyOrMongoId(valueAt(3));
  const consigneeMap = byLegacyOrMongoId(valueAt(4));

  return plainRows.map((plain) => {
    const buyerId = String(plain?.buyer_id || plain?.company_id || "");
    const warehouse = mongoWarehouseMap.get(String(plain?.warehouse_id || ""));
    const product = mongoProductMap.get(String(plain?.product_id || ""));
    const account = mongoAccountMap.get(String(plain?.company_account_id || ""));
    const buyer = buyerMap.get(buyerId) || {};
    const consignee = consigneeMap.get(String(plain?.consignee_id || ""));
    const totalQuantity = Number(plain?.quantity ?? plain?.total_quantity ?? Math.max(Number(plain?.gross_weight || 0) - Number(plain?.tare_weight || 0), 0));
    const totalAmount = Number(plain?.amount ?? plain?.total_amount ?? plain?.net_receivable_amount ?? 0);
    return {
      ...plain,
      id: String(plain?._id || plain?.id || ""),
      _id: String(plain?._id || plain?.id || ""),
      buyer_id: buyerId,
      warehouse_name: warehouse?.name || plain?.warehouse_name || "-",
      product_name: product?.name || plain?.product_name || "-",
      company_account_name: account?.account_name || account?.name || plain?.company_account_name || "-",
      buyer_name: buyer?.name || buyer?.company_name || plain?.buyer_name || plain?.party_name || plain?.company_name || "-",
      buyer_email: buyer?.email || plain?.buyer_email || "",
      buyer_mobile: buyer?.mobile || plain?.buyer_mobile || "",
      consignee_name: consignee?.name || plain?.consignee_name || "-",
      consignee_email: consignee?.email || plain?.consignee_email || "",
      consignee_mobile: consignee?.mobile || plain?.consignee_mobile || "",
      total_quantity: Number.isFinite(totalQuantity) ? totalQuantity : 0,
      total_amount: Number.isFinite(totalAmount) ? totalAmount : 0,
      ...calculateSaleFollowupMeta(plain || {}),
    };
  });
}

function getPurchaseVoucherRows(req, res) {
  if (!mongoReady()) {
    return res.status(503).json({ error: "MongoDB is required for Warehouse Trading voucher lists" });
  }
  getPurchaseVoucherPage(req)
    .then((payload) => res.json(payload))
    .catch((err) => {
      console.error("Mongo purchase voucher page query failed:", err);
      res.status(500).json({ error: err.message || "Failed to load purchase vouchers" });
    });
}

async function resolveUserAccessibleLocationIds(user) {
  const rawLocationIds = [
    user?.location_id,
    ...(Array.isArray(user?.location_ids) ? user.location_ids : []),
  ].filter(Boolean);

  const resolvedIds = [];
  for (const rawLocationId of rawLocationIds) {
    const value = String(rawLocationId || "").trim();
    if (!value) continue;
    if (Number.isFinite(Number(value)) && Number(value) > 0) {
      resolvedIds.push(Number(value));
      continue;
    }

    const doc = await Location.findById(value).lean().catch(() => null);
    if (!doc) continue;
    if (Number.isFinite(Number(doc.id))) {
      resolvedIds.push(Number(doc.id));
      continue;
    }
    if (doc._id && Number.isFinite(Number(doc._id))) {
      resolvedIds.push(Number(doc._id));
    }
  }

  return Array.from(new Set(resolvedIds));
}

async function canAccessLocation(user, locationId) {
  const normalizedLocationId = Number(locationId);
  if (!Number.isFinite(normalizedLocationId) || normalizedLocationId <= 0) {
    return false;
  }

  const allowed = await resolveUserAccessibleLocationIds(user).catch(() => []);
  if (allowed.length === 0) {
    return true;
  }
  return allowed.includes(normalizedLocationId);
}

function ensureWarehouseAccess(req, res, warehouseId, locationId = null) {
  if (warehouseId) {
    if (!canAccessWarehouse(req.user, warehouseId)) {
      res.status(403).json({ error: "You do not have access to this warehouse" });
      return false;
    }
    return true;
  }

  if (locationId) {
    return canAccessLocation(req.user, locationId)
      .then((allowed) => {
        if (!allowed) {
          res.status(403).json({ error: "You do not have access to this location" });
          return false;
        }
        return true;
      })
      .catch((err) => {
        res.status(500).json({ error: err?.message || "Failed to check location access" });
        return false;
      });
  }

  res.status(400).json({ error: "Warehouse or location is required" });
  return false;
}

function ensureWarehouseAccessAsync(req, res, warehouseId, locationId = null) {
  try {
    return Promise.resolve(ensureWarehouseAccess(req, res, warehouseId, locationId));
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to check warehouse access" });
    return Promise.resolve(false);
  }
}

async function getMongoPurchaseVoucherForPdf(id) {
  const filter = mongoIdFilter(id);
  if (!filter || !mongoReady()) return null;

  const row = await PurchaseVoucher.findOne(filter).lean();
  if (!row) return null;

  const [warehouse, farmer, product, account] = await Promise.all([
    row.warehouse_id && mongoose.Types.ObjectId.isValid(row.warehouse_id)
      ? Warehouse.findById(row.warehouse_id).lean()
      : null,
    row.farmer_id && mongoose.Types.ObjectId.isValid(row.farmer_id)
      ? Farmer.findById(row.farmer_id).lean()
      : null,
    row.product_id && mongoose.Types.ObjectId.isValid(row.product_id)
      ? Product.findById(row.product_id).lean()
      : null,
    row.company_account_id && mongoose.Types.ObjectId.isValid(row.company_account_id)
      ? CompanyAccount.findById(row.company_account_id).lean()
      : null,
  ]);

  return {
    ...row,
    id: String(row._id),
    warehouse_name: warehouse?.name || row.warehouse_name,
    warehouse_address: warehouse?.address || row.warehouse_address,
    warehouse_location: warehouse?.location || row.warehouse_location,
    warehouse_pincode: warehouse?.pincode || row.warehouse_pincode,
    warehouse_state: warehouse?.state || row.warehouse_state,
    warehouse_city: warehouse?.city || row.warehouse_city,
    warehouse_district: warehouse?.district || row.warehouse_district,
    farmer_name: farmer?.name || row.farmer_name,
    farmer_mobile: farmer?.mobile || row.farmer_mobile,
    farmer_address: farmer?.address || row.farmer_address,
    farmer_village: farmer?.village || row.farmer_village,
    farmer_gst: farmer?.gst_no || row.farmer_gst,
    farmer_pan: farmer?.pan_no || row.farmer_pan,
    farmer_state: farmer?.state || row.farmer_state,
    farmer_bank_name: farmer?.bank_name || row.farmer_bank_name,
    farmer_bank_account_no: farmer?.bank_account_no || row.farmer_bank_account_no,
    farmer_ifsc_code: farmer?.ifsc_code || row.farmer_ifsc_code,
    farmer_branch_name: farmer?.branch_name || row.farmer_branch_name,
    farmer_account_holder_name: farmer?.account_holder_name || row.farmer_account_holder_name,
    product_name: product?.name || row.product_name,
    company_account_name: account?.account_name || row.company_account_name,
    company_account_mobile: account?.mobile || row.company_account_mobile,
    company_account_pan: account?.pan_no || row.company_account_pan,
    company_account_address: account?.address || row.company_account_address,
  };
}

async function enrichPurchaseVoucherPdfRow(row) {
  if (!row || !mongoReady()) return row;
  const farmerId = String(row.farmer_id || "");
  const farmerName = String(row.farmer_name || "").trim();
  const farmerMobile = String(row.farmer_mobile || "").trim();

  let farmer = null;
  if (mongoose.Types.ObjectId.isValid(farmerId)) {
    farmer = await Farmer.findById(farmerId).lean();
  }
  if (!farmer && farmerName) {
    const nameFilter = { name: farmerName };
    if (farmerMobile) {
      farmer = await Farmer.findOne({ ...nameFilter, mobile: farmerMobile }).lean();
    }
    if (!farmer) {
      farmer = await Farmer.findOne(nameFilter).lean();
    }
  }
  if (!farmer && farmerMobile) {
    farmer = await Farmer.findOne({ mobile: farmerMobile }).lean();
  }
  if (!farmer) return row;

  return {
    ...row,
    farmer_name: row.farmer_name || farmer.name,
    farmer_mobile: row.farmer_mobile || farmer.mobile,
    farmer_address: row.farmer_address || farmer.address,
    farmer_village: row.farmer_village || farmer.village,
    farmer_gst: row.farmer_gst || farmer.gst_no,
    farmer_pan: row.farmer_pan || farmer.pan_no,
    farmer_state: row.farmer_state || farmer.state,
    farmer_district: row.farmer_district || farmer.district || farmer.city || farmer.location,
    farmer_pincode: row.farmer_pincode || farmer.pincode,
    farmer_bank_name: row.farmer_bank_name || farmer.bank_name,
    farmer_bank_account_no: row.farmer_bank_account_no || farmer.bank_account_no,
    farmer_ifsc_code: row.farmer_ifsc_code || farmer.ifsc_code,
    farmer_branch_name: row.farmer_branch_name || farmer.branch_name,
    farmer_account_holder_name: row.farmer_account_holder_name || farmer.account_holder_name,
  };
}

function sendPurchaseVoucherPdf(res, row, id) {
  const doc = new PDFDocument({ size: "A4", margin: 20 });
  res.setHeader("Content-Type", "application/pdf");
  const safeName = String(row.voucher_no || id).replace(/[/\\?%*:|"<>]/g, "-");
  res.setHeader("Content-Disposition", `attachment; filename="purchase_${safeName}.pdf"`);
  doc.pipe(res);

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const x = 20;
  const y0 = 18;
  const contentW = pageW - 40;
  const navy = "#0f2747";
  const green = "#4f8f2f";
  const greenLight = "#e8f4df";
  const navyLight = "#edf2fb";
  const border = "#d1d5db";
  const text = "#111827";
  const muted = "#4b5563";
  const soft = "#f8fafc";
  let y = y0;
  const accountName = row.company_account_name || "SHIVANSH";
  const warehouseNameLine = row.warehouse_name || "-";
  const warehouseAddressLine = row.warehouse_address || "-";
  const warehouseCityDistrictLine = [row.warehouse_location, row.warehouse_city, row.warehouse_district]
    .filter(Boolean)
    .join(", ");
  const netQty = row.total_qty || row.net_weight || row.quantity || 0;
  const grossAmount = Number(netQty || 0) * Number(row.rate || 0);
  const netPayable = row.net_amount_payable || row.amount || 0;
  const fmt4 = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(4) : "0.0000";
  };
  const fmt2 = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(2) : "0.00";
  };

  const box = (bx, by, bw, bh, fill = "#fff", stroke = border) => {
    doc.roundedRect(bx, by, bw, bh, 6).fillAndStroke(fill, stroke);
  };
  const labelValue = (label, value, tx, ty, width = 120) => {
    doc.fillColor(text).fontSize(8.0).text(label, tx, ty, { width: width * 0.46 });
    doc.fillColor(muted).text(":", tx + width * 0.46, ty);
    doc.fillColor(text).text(value || "-", tx + width * 0.54, ty, { width: width * 0.46 });
  };

  doc.rect(10, 10, pageW - 20, pageH - 20).lineWidth(0.8).strokeColor(border).stroke();

  // Header area
  const leftHeaderW = 165;
  const titleW = 235;
  const midHeaderW = contentW - leftHeaderW - titleW - 12;

  doc.roundedRect(x, y, leftHeaderW, 58, 8).fillAndStroke("#fff", border);
  doc.fillColor(navy).fontSize(18).text(accountName, x + 14, y + 14, { width: leftHeaderW - 28 });
  doc.moveTo(x + 14, y + 42).lineTo(x + leftHeaderW - 18, y + 42).stroke(green);

  doc.roundedRect(x + leftHeaderW + 6, y, midHeaderW, 58, 8).fillAndStroke("#fff", border);
  doc.fillColor(navy).fontSize(7.6).text("Phone", x + leftHeaderW + 18, y + 17);
  doc.fillColor(text).fontSize(7.6).text(row.company_account_mobile || "9064348416", x + leftHeaderW + 46, y + 17);
  doc.fillColor(navy).fontSize(7.6).text("Mobile", x + leftHeaderW + 18, y + 33);
  doc.fillColor(text).fontSize(7.6).text(row.farmer_mobile || "9088370854", x + leftHeaderW + 60, y + 33);

  doc.roundedRect(x + contentW - titleW, y, titleW, 58, 8).fillAndStroke(navy, navy);
  doc.fillColor("#fff").fontSize(15).text("PURCHASE MEMO", x + contentW - titleW + 20, y + 20, {
    width: titleW - 40,
    align: "center",
  });
  doc.moveTo(x + contentW - 48, y + 10).lineTo(x + contentW - 20, y + 48).stroke(green);
  doc.moveTo(x + contentW - 62, y + 10).lineTo(x + contentW - 34, y + 48).stroke("#c7d2fe");

  y += 68;
  doc.roundedRect(x, y, contentW, 24, 6).fillAndStroke("#fff", border);
  doc.fillColor(navy).fontSize(7.8).text("Location:", x + 12, y + 8);
  doc.fillColor(text).fontSize(7.8).text(
    [warehouseNameLine, warehouseAddressLine, warehouseCityDistrictLine].filter(Boolean).join(" | "),
    x + 58,
    y + 8,
    { width: contentW - 70 }
  );
  y += 32;
  doc.roundedRect(x, y, contentW, 22, 6).fillAndStroke("#fff", border);
  doc.fontSize(7.8).fillColor(text).text("Serial No.", x + 12, y + 7);
  doc.fillColor(navy).fontSize(9.4).text(row.voucher_no || id, x + 72, y + 5);
  doc.fillColor(text).fontSize(7.8).text("Date", x + contentW - 138, y + 7);
  doc.fillColor(navy).fontSize(9.4).text(fmtDate(row.date), x + contentW - 90, y + 5);
  y += 30;

  const leftW = (contentW - 10) / 2;
  const rightX = x + leftW + 10;
  box(x, y, leftW, 102, "#fff");
  box(rightX, y, leftW, 102, "#fff");
  doc.roundedRect(x, y, leftW, 20, 6).fillAndStroke(navy, navy);
  doc.roundedRect(rightX, y, leftW, 20, 6).fillAndStroke(green, green);
  doc.fillColor("#fff").fontSize(9).text("PARTY INFORMATION", x + 12, y + 6);
  doc.fillColor("#fff").text("DOCUMENT INFORMATION", rightX + 12, y + 6);

  const pStart = y + 23;
  labelValue("Name of Party", row.farmer_name, x + 10, pStart, leftW - 20);
  labelValue("PAN", row.farmer_pan, x + 10, pStart + 13, leftW - 20);
  labelValue("GSTIN", row.farmer_gst, x + 10, pStart + 26, leftW - 20);
  labelValue("Phone", row.farmer_mobile, x + 10, pStart + 39, leftW - 20);
  labelValue("State", row.farmer_state, x + 10, pStart + 52, leftW - 20);
  labelValue("PIN No.", row.farmer_pincode, x + 10, pStart + 65, leftW - 20);

  labelValue("R.S.T. No.", row.reference_id || "-", rightX + 10, pStart + 3, leftW - 20);
  labelValue("Transport No.", "-", rightX + 10, pStart + 16, leftW - 20);
  labelValue("Warehouse", row.warehouse_name || row.warehouse_id, rightX + 10, pStart + 29, leftW - 20);
  labelValue("Remarks", row.description || "-", rightX + 10, pStart + 42, leftW - 20);
  labelValue("Location", warehouseNameLine, rightX + 10, pStart + 55, leftW - 20);

  y += 110;

  const particulars = [
    ["1", "Packet", fmt4(row.packet)],
    ["2", "Gross Weight", fmt4(row.gross_weight)],
    ["3", "Tare Weight", fmt4(row.tare_weight)],
    ["4", "New Weight", fmt4(Math.max(Number(row.gross_weight || 0) - Number(row.tare_weight || 0), 0))],
    ["5", "Dhalta", fmt4(row.dhalta)],
    ["6", "Less Bags Weight", fmt4(row.less_bags_weight)],
    ["7", "Moisture", fmt4(row.moisture)],
    ["8", "Dunki / Fungus", fmt4(Number(row.dunki || 0) + Number(row.fungus || 0))],
    ["9", "Discolour / Others", fmt4(Number(row.discolour || 0) + Number(row.others || 0))],
    ["10", "Bags Claim", fmt4(row.bags_claim)],
    ["11", "Round Off", fmt4(row.round_off)],
  ].filter(([_, label]) => {
    if (label === "Bags Claim") return Number(row.bags_claim || 0) !== 0;
    return true;
  });

  const particularsHeight = 17 + particulars.length * 9.5;
  const tableHeight = Math.max(112, particularsHeight + 16);

  box(x, y, contentW, tableHeight, "#fff");
  doc.roundedRect(x, y, contentW, 18, 6).fillAndStroke(navy, navy);
  doc.fillColor("#fff").fontSize(9).text("PARTICULARS", x + 12, y + 5);
  doc.fillColor("#fff").text("AMOUNT (Rs.)", x + contentW - 92, y + 5, { width: 80, align: "right" });
  const headY = y + 18;
  const col1 = 42;
  const col2 = contentW - col1 - 92;
  let rowY = headY;

  particulars.forEach((ln, index) => {
    const fill = index % 2 === 0 ? "#fbfdff" : "#f8fafc";
    doc.rect(x + 1, rowY, contentW - 2, 10).fill(fill);
    doc.moveTo(x, rowY + 10).lineTo(x + contentW, rowY + 10).stroke(border);
    doc.fillColor(text).fontSize(6.5).text(ln[0], x + 10, rowY + 0.8);
    doc.text(ln[1], x + col1 + 10, rowY + 0.8);
    doc.text(ln[2], x + col1 + col2 + 10, rowY + 0.8, { width: 80, align: "right" });
    rowY += 9.5;
  });

  const summaryY = y + tableHeight + 8;
  const summaryW = 260;
  const statsPanelW = 220;
  const statsPanelX = x + contentW - statsPanelW;
  const boxW = summaryW / 5;
  [
    ["PURCHASED KG.", fmt4(row.gross_weight)],
    ["MAKKA QTY.", fmt4(netQty)],
    ["BORA QTY.", fmt4(row.packet)],
    ["LABOUR CHARGES", fmt4(row.labour)],
    ["TOTAL", fmt2(grossAmount || netPayable)],
  ].forEach((item, index) => {
    const bx = x + index * boxW;
    const fill = index === 4 ? greenLight : soft;
    const stroke = index === 4 ? green : border;
    doc.roundedRect(bx, summaryY, boxW - 2, 34, 4).fillAndStroke(fill, stroke);
    doc.fillColor(index === 4 ? green : navy).fontSize(6.1).text(item[0], bx + 2, summaryY + 4, { width: boxW - 6, align: "center" });
    doc.fillColor(text).fontSize(8.0).text(item[1], bx + 2, summaryY + 17, { width: boxW - 6, align: "center" });
  });

  doc.roundedRect(statsPanelX, summaryY, statsPanelW, 34, 4).fillAndStroke("#fff", border);
  labelValue("Total Qty.", fmt4(netQty), statsPanelX + 8, summaryY + 3, statsPanelW - 16);
  labelValue("Total Deductions", fmt2(row.total_deduction || row.total_deduct_amount), statsPanelX + 8, summaryY + 14, statsPanelW - 16);
  doc.roundedRect(statsPanelX, summaryY + 24, statsPanelW, 10, 4).fillAndStroke(navy, navy);
  doc.fillColor("#fff").fontSize(6.8).text("Net Amount Payable", statsPanelX + 8, summaryY + 27);
  doc.fillColor("#fff").fontSize(7.2).text(fmt2(netPayable), statsPanelX + 82, summaryY + 27, { width: statsPanelW - 90, align: "right" });

  y = summaryY + 44;
  doc.roundedRect(x, y, contentW, 54, 6).fillAndStroke("#fff", border);
  doc.roundedRect(x + 10, y - 8, 160, 16, 5).fillAndStroke(green, green);
  doc.fillColor("#fff").fontSize(8.6).text("ADDITIONAL DETAILS", x + 27, y - 4);
  labelValue("Bank", row.farmer_bank_name || "-", x + 12, y + 15, 180);
  labelValue("IFSC Code", row.farmer_ifsc_code || "-", x + 12, y + 28, 180);
  labelValue("Name of Party", row.farmer_account_holder_name || row.farmer_name, x + 240, y + 15, 180);
  labelValue("Branch", row.farmer_branch_name || "-", x + 240, y + 28, 180);
  labelValue("Account Number", row.farmer_bank_account_no || "-", x + 450, y + 15, 160);
  labelValue("Transport No.", "-", x + 450, y + 28, 160);

  y += 62;
  doc.roundedRect(x + 150, y, contentW - 300, 18, 6).fillAndStroke(greenLight, green);
  doc.fillColor(green).fontSize(6.8).text("NOTE", x + 160, y + 5);
  doc.fillColor(text).fontSize(6.8).text("Buyer and Seller disputes will be resolved at village level.", x + 186, y + 5, { width: contentW - 372, align: "center" });
  y += 28;
  doc.fillColor(text).fontSize(7.2).text("Customer Signature", x + 48, y);
  doc.moveTo(x + 42, y + 15).lineTo(x + 160, y + 15).stroke(border);
  doc.text("Authorised Signature", x + contentW - 170, y);
  doc.moveTo(x + contentW - 182, y + 15).lineTo(x + contentW - 54, y + 15).stroke(border);
  doc.moveTo(x, pageH - 14).lineTo(x + contentW, pageH - 14).stroke(navy);
  doc.moveTo(x + contentW - 28, pageH - 14).lineTo(x + contentW, pageH - 42).stroke(green);

  doc.end();
}

function sendMinimalPurchaseVoucherPdf(res, row, id) {
  const doc = new PDFDocument({ size: "A4", margin: 30 });
  res.setHeader("Content-Type", "application/pdf");
  const safeName = String(row.voucher_no || id).replace(/[/\\?%*:|"<>]/g, "-");
  res.setHeader("Content-Disposition", `attachment; filename="purchase_${safeName}.pdf"`);
  doc.pipe(res);
  const fmt4 = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(4) : "0.0000";
  };
  doc.fontSize(18).fillColor("#0f766e").text("PURCHASE MEMO", { align: "center" });
  doc.moveDown(1);
  doc.fontSize(11).fillColor("#111827").text(`Voucher No: ${row.voucher_no || id}`);
  doc.text(`Date: ${fmtDate(row.date)}`);
  doc.text(`Party: ${row.farmer_name || "-"}`);
  doc.text(`Warehouse: ${row.warehouse_name || "-"}`);
  doc.text(`Amount: ${fmt4(row.net_amount_payable || row.amount || 0)}`);
  doc.moveDown(1);
  doc.fontSize(9).text("Full memo layout could not be rendered, so this compact version was generated instead.");
  doc.end();
}

function getVoucherPrefix(type) {
  const prefixMap = {
    purchase: "PUR",
    sale: "SAL",
    payment: "PAY",
    receipt: "REC",
    journal: "JRN",
  };
  return prefixMap[type] || String(type || "").toUpperCase().slice(0, 3);
}

function getVoucherTable(type) {
  const tableMap = {
    purchase: "wh_purchase_vouchers",
    sale: "wh_sale_vouchers",
    payment: "wh_payment_vouchers",
    receipt: "wh_receipt_vouchers",
    journal: "wh_journal_vouchers",
  };
  return tableMap[type];
}

function createSequentialVoucherNo(type, callback) {
  nextMongoVoucherNo(type)
    .then((voucherNo) => callback(null, voucherNo))
    .catch((err) => callback(err));
}

function computeOutstandingForFarmer(farmerId, callback, companyAccountId = null) {
  const farmerKey = String(farmerId || "").trim();
  const accountKey = String(companyAccountId || "").trim();

  if (!farmerKey) {
    return callback(null, {
      total_purchase: 0,
      total_payment: 0,
      outstanding: 0,
    });
  }

  if (mongoReady() && mongoose.connection?.db) {
    const purchaseFilter = {
      farmer_id: farmerKey,
    };

    if (accountKey) {
      purchaseFilter.company_account_id = accountKey;
    }

    const paymentFilter = {
      $or: [
        { farmer_id: farmerKey },
        { "data.farmer_id": farmerKey },
      ],
    };

    if (accountKey) {
      paymentFilter.$and = [
        {
          $or: [
            { company_account_id: accountKey },
            { "data.company_account_id": accountKey },
          ],
        },
      ];
    }

    Promise.all([
      PurchaseVoucher.aggregate([
        { $match: purchaseFilter },
        {
          $group: {
            _id: null,
            total_purchase: {
              $sum: {
                $ifNull: [
                  "$net_amount_payable",
                  {
                    $ifNull: [
                      "$amount",
                      0,
                    ],
                  },
                ],
              },
            },
          },
        },
      ]),

      mongoose.connection.db
        .collection("paymentvouchers_native")
        .find(paymentFilter)
        .toArray(),
    ])
      .then(([purchaseRows, paymentRows]) => {
        const totalPurchase =
          Number(purchaseRows?.[0]?.total_purchase || 0);

        const totalPayment =
          (paymentRows || []).reduce((sum, doc) => {
            const data =
              doc?.data &&
              typeof doc.data === "object"
                ? doc.data
                : doc;

            return (
              sum +
              Number(data?.amount || 0)
            );
          }, 0);

        return callback(null, {
          total_purchase: Number(totalPurchase.toFixed(2)),
          total_payment: Number(totalPayment.toFixed(2)),
          outstanding: Number(
            (totalPurchase - totalPayment).toFixed(2)
          ),
        });
      })
      .catch(callback);

    return;
  }

  Promise.all([
    PurchaseVoucher.find({
      farmer_id: farmerKey,
      ...(accountKey ? { company_account_id: accountKey } : {}),
    }).lean(),
    PaymentVoucherNative
      ? PaymentVoucherNative.find({
          farmer_id: farmerKey,
          ...(accountKey ? { company_account_id: accountKey } : {}),
        }).lean()
      : Promise.resolve([]),
  ])
    .then(([purchaseRows, paymentRows]) => {
      const totalPurchase = (purchaseRows || []).reduce(
        (sum, row) =>
          sum +
          Number(
            row?.net_amount_payable ??
            row?.amount ??
            0
          ),
        0
      );
      const totalPayment = (paymentRows || []).reduce(
        (sum, row) =>
          sum + Number(row?.amount || 0),
        0
      );
      return callback(null, {
        total_purchase: Number(totalPurchase.toFixed(2)),
        total_payment: Number(totalPayment.toFixed(2)),
        outstanding: Number((totalPurchase - totalPayment).toFixed(2)),
      });
    })
    .catch((err) => callback(err));
}

function computeOutstandingForCompany(companyId, callback, companyAccountId = null) {
  const companyKey = String(companyId || "").trim();
  const accountKey = String(companyAccountId || "").trim();

  if (!companyKey) {
    return callback(null, {
      total_sale: 0,
      total_receipt: 0,
      outstanding: 0,
    });
  }

  if (mongoReady() && mongoose.connection?.db) {
    Promise.all([
      SaleVoucher.find({
        $or: [
          { buyer_id: companyKey },
          { company_id: companyKey },
        ],
        ...(accountKey
          ? { company_account_id: accountKey }
          : {}),
      }).lean(),

      mongoose.connection.db
        .collection("receiptvouchers")
        .find({})
        .toArray(),
    ])
      .then(([saleRows, receiptRows]) => {
        const totalSale = (saleRows || []).reduce(
          (sum, row) =>
            sum +
            Number(
              row?.net_receivable_amount ??
              row?.amount ??
              0
            ),
          0
        );

        const totalReceipt = (receiptRows || [])
          .map((doc) => {
            const data =
              doc?.data &&
              typeof doc.data === "object"
                ? doc.data
                : doc;

            return data;
          })
          .filter((row) => {
            const rowCompany = String(
              row?.company_id ?? ""
            );

            if (rowCompany !== companyKey) {
              return false;
            }

            if (accountKey) {
              return (
                String(
                  row?.company_account_id ?? ""
                ) === accountKey
              );
            }

            return true;
          })
          .reduce(
            (sum, row) =>
              sum + Number(row?.amount || 0),
            0
          );

        return callback(null, {
          total_sale: Number(totalSale.toFixed(2)),
          total_receipt: Number(totalReceipt.toFixed(2)),
          outstanding: Number(
            (totalSale - totalReceipt).toFixed(2)
          ),
        });
      })
      .catch((err) => callback(err));

    return;
  }

  Promise.all([
    SaleVoucher.find({
      $or: [{ buyer_id: companyKey }, { company_id: companyKey }],
      ...(accountKey ? { company_account_id: accountKey } : {}),
    }).lean(),
    MongoReceiptVoucher
      ? MongoReceiptVoucher.find({
          company_id: companyKey,
          ...(accountKey ? { company_account_id: accountKey } : {}),
        }).lean()
      : Promise.resolve([]),
  ])
    .then(([saleRows, receiptRows]) => {
      const totalSale = (saleRows || []).reduce(
        (sum, row) =>
          sum +
          Number(
            row?.net_receivable_amount ??
            row?.amount ??
            0
          ),
        0
      );
      const totalReceipt = (receiptRows || []).reduce(
        (sum, row) =>
          sum + Number(row?.amount || 0),
        0
      );
      return callback(null, {
        total_sale: Number(totalSale.toFixed(2)),
        total_receipt: Number(totalReceipt.toFixed(2)),
        outstanding: Number((totalSale - totalReceipt).toFixed(2)),
      });
    })
    .catch((err) => callback(err));
}

function createVoucherNoIfMissing(type, voucherNo, callback) {
  if (voucherNo && String(voucherNo).trim()) {
    return callback(null, voucherNo);
  }

  const mongoTypes = [
    "purchase",
    "sale",
    "payment",
    "receipt",
    "journal",
  ];

  if (
    mongoReady() &&
    mongoTypes.includes(String(type || "").toLowerCase())
  ) {
    nextMongoVoucherNo(type)
      .then((nextNo) => callback(null, nextNo))
      .catch((err) => callback(err));
    return;
  }

  createSequentialVoucherNo(type, callback);
}

const normalizeImportKey = (value) => String(value || "").trim().toLowerCase();

function firstValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") {
      return row[key];
    }
  }
  return "";
}

function excelDateToIso(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
    }
  }
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;
  const dmy = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (dmy) {
    const yyyy = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${yyyy}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function importNumber(value) {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveByNameOrId(map, value) {
  const key = normalizeImportKey(value);
  return key ? map.get(key) : null;
}

function buildImportMap(rows, nameFields = ["name"]) {
  const map = new Map();
  rows.forEach((row) => {
    if (row?._id) map.set(normalizeImportKey(row._id), row);
    if (row?.id) map.set(normalizeImportKey(row.id), row);
    nameFields.forEach((field) => {
      if (row?.[field]) map.set(normalizeImportKey(row[field]), row);
    });
  });
  return map;
}

function purchaseImportRowsFromSheet(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
}

function paymentImportRowsFromSheet(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
}

function purchaseImportTemplateBuffer() {
  const headers = [
    "Date",
    "Voucher No",
    "Warehouse",
    "Account",
    "Farmer",
    "Product",
    "Employee",
    "Location",
    "Packet",
    "Gross Wt",
    "Tare Wt",
    "Dhalta",
    "Less Bags Weight",
    "Moistur",
    "Dunki",
    "Fungas",
    "Disclour",
    "Others",
    "Rate",
    "Bags Claim",
    "Labour",
    "Round Off",
    "Narration",
  ];
  const sample = [
    new Date().toISOString().slice(0, 10),
    "",
    "Hemtobat Warehouse",
    "Agri Rise Pvt Ltd",
    "Manikul Islam",
    "Maize",
    "Subrajyoti Mondal",
    "Hemtobat Hub",
    30,
    1.8,
    0,
    0.18,
    0.0069,
    0,
    0,
    0,
    0,
    0,
    19900,
    245,
    180,
    -0.69,
    "",
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
  ws["!cols"] = headers.map(() => ({ wch: 18 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Purchase Import");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function paymentImportTemplateBuffer() {
  const headers = [
    "Date",
    "Voucher No",
    "Warehouse",
    "Farmer No",
    "Farmer",
    "Account",
    "Amount",
    "Reference Type",
    "Reference ID",
    "Employee",
    "Location",
    "Narration",
  ];
  const sample = [
    new Date().toISOString().slice(0, 10),
    "",
    "Hemtobat Warehouse",
    "FARMER001",
    "Manikul Islam",
    "Agri Rise Pvt Ltd",
    5000,
    "purchase",
    "",
    "Subrajyoti Mondal",
    "Hemtobat Hub",
    "",
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
  ws["!cols"] = headers.map(() => ({ wch: 18 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Payment Import");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function receiptImportTemplateBuffer() {
  const headers = [
    "Date",
    "Voucher No",
    "Warehouse",
    "Company",
    "Account",
    "Consignee",
    "Amount",
    "Reference Type",
    "Reference ID",
    "Employee",
    "Location",
    "Narration",
  ];
  const sample = [
    new Date().toISOString().slice(0, 10),
    "",
    "Hemtobat Warehouse",
    "Hemtobat Pvt Ltd",
    "Agri Rise Pvt Ltd",
    "",
    4000,
    "sale",
    "",
    "Subrajyoti Mondal",
    "Hemtobat Hub",
    "",
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
  ws["!cols"] = headers.map(() => ({ wch: 18 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Receipt Import");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// Idempotency helpers: prevent duplicate resource creation when client retries
const IDEMPOTENCY_COLLECTION = "idempotency_keys";

function getIdempotency(key, route, cb) {
  if (!key) return cb(null, null);
  if (!mongoReady() || !mongoose.connection?.db) {
    return cb(new Error("MongoDB is not connected"));
  }

  mongoose.connection.db
    .collection(IDEMPOTENCY_COLLECTION)
    .findOne({ key, route })
    .then((row) => cb(null, row ? row.response_id : null))
    .catch((err) => cb(err));
}

function saveIdempotency(key, route, responseId, cb) {
  if (!key) return cb && cb();
  if (!mongoReady() || !mongoose.connection?.db) {
    return cb && cb(new Error("MongoDB is not connected"));
  }

  mongoose.connection.db
    .collection(IDEMPOTENCY_COLLECTION)
    .updateOne(
      { key, route },
      {
        $set: {
          response_id: responseId,
          created_at: new Date(),
        },
      },
      { upsert: true }
    )
    .then(() => cb && cb())
    .catch((err) => cb && cb(err));
}

function getPaymentAdjustmentsByPurchase(callback, excludePaymentId = null) {
  if (!mongoReady()) return callback(null, new Map());

  (async () => {
    try {
      const query = {};
      if (excludePaymentId !== null && excludePaymentId !== undefined && excludePaymentId !== "") {
        query.payment_id = { $ne: Number(excludePaymentId) };
      }

      const rows = PaymentAdjustmentNative
        ? await PaymentAdjustmentNative.aggregate([
            { $match: query },
            {
              $group: {
                _id: "$purchase_id",
                adjusted_amount: { $sum: "$adjusted_amount" },
              },
            },
          ])
        : [];

      const map = new Map();
      (rows || []).forEach((row) => {
        map.set(String(row._id), Number(row.adjusted_amount || 0));
      });
      callback(null, map);
    } catch (err) {
      callback(err);
    }
  })();
}

function getReceiptAdjustmentsBySale(callback, excludeReceiptId = null) {
  if (!mongoReady()) return callback(new Error("MongoDB is not connected"));
  (async () => {
    try {
      const excludedId = excludeReceiptId === null || excludeReceiptId === undefined || excludeReceiptId === "" ? null : String(excludeReceiptId);
      const docs = MongoReceiptAdjustment
        ? await MongoReceiptAdjustment.find({}).lean()
        : [];
      const map = new Map();
      for (const doc of docs || []) {
        const receiptId = String(doc?.receipt_id ?? "");
        if (excludedId !== null && receiptId === excludedId) continue;
        const saleId = String(doc?.sale_id ?? "");
        if (!saleId) continue;
        const amount = Number(doc?.adjusted_amount ?? 0);
        if (!Number.isFinite(amount)) continue;
        map.set(saleId, Number(((map.get(saleId) || 0) + amount).toFixed(2)));
      }
      callback(null, map);
    } catch (err) {
      callback(err);
    }
  })();
}

function normalizePaymentMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["advance", "advance_payment"].includes(normalized)) return "advance";
  if (["new_reference", "new reference", "newref", "new-ref", "reference"].includes(normalized)) return "new_reference";
  if (["against", "against_purchase", "purchase", "bill", "billwise"].includes(normalized)) return "against";
  if (["on_account", "on-account", "account"].includes(normalized)) return "on_account";
  return "on_account";
}

function normalizePaymentAdjustments(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => ({
      purchase_id: String(item?.purchase_id || item?.id || "").trim(),
      adjusted_amount: Number(item?.adjusted_amount),
      voucher_no: item?.voucher_no || item?.purchase_voucher_no || "",
    }))
    .filter((item) => item.purchase_id && Number.isFinite(item.adjusted_amount) && item.adjusted_amount > 0);
}

function validatePaymentAdjustments({ farmerId, warehouseId, amount, adjustments, paymentMode = "on_account", excludePaymentId = null }, callback) {
  const cleanAdjustments = normalizePaymentAdjustments(adjustments);
  const normalizedPaymentMode = normalizePaymentMode(paymentMode);
  const paymentAmount = Number(amount || 0);
  const adjustedTotal = cleanAdjustments.reduce((sum, item) => sum + item.adjusted_amount, 0);

  if (paymentAmount <= 0) return callback(new Error("Payment amount is required"));
  if (normalizedPaymentMode === "against") {
    if (!cleanAdjustments.length) return callback(new Error("Please adjust this payment against purchase bills"));
    if (Math.abs(adjustedTotal - paymentAmount) > 0.0001) {
      return callback(new Error("Payment amount and adjustment amount must be equal"));
    }
  }
  if (!cleanAdjustments.length) return callback(null, []);
  if (normalizedPaymentMode !== "against" && Math.abs(adjustedTotal - paymentAmount) > 0.0001) {
    return callback(new Error("Payment amount and adjustment amount must be equal"));
  }

  getPaymentAdjustmentsByPurchase((err, adjustedMap) => {
    if (err) return callback(err);

    const resolveWithMongo = async () => {
      const resolved = [];
      for (const item of cleanAdjustments) {
        const rawId = String(item.purchase_id || "").trim();
        const voucher = String(item.voucher_no || "").trim();
        const ors = [];
        if (mongoose.Types.ObjectId.isValid(rawId)) ors.push({ _id: rawId });
        if (Number.isFinite(Number(rawId))) ors.push({ id: Number(rawId) });
        if (rawId) ors.push({ voucher_no: rawId });
        if (voucher) ors.push({ voucher_no: voucher });

        let purchase = null;
        if (ors.length) {
          purchase = await PurchaseVoucher.findOne({ $or: ors })
            .select("_id id voucher_no farmer_id warehouse_id net_amount_payable amount")
            .lean();
        }

        if (purchase) {
          const mongoId = String(purchase._id);
          const purchaseFarmer = String(purchase.farmer_id || "");
          const purchaseWarehouse = String(purchase.warehouse_id || "");
          if (purchaseFarmer && purchaseFarmer !== String(farmerId || "")) {
            throw new Error(`Purchase bill ${purchase.voucher_no || mongoId} belongs to a different farmer`);
          }
          if (warehouseId && purchaseWarehouse && purchaseWarehouse !== String(warehouseId)) {
            throw new Error(`Purchase bill ${purchase.voucher_no || mongoId} belongs to a different warehouse`);
          }
          const billAmount = Number(purchase.net_amount_payable || purchase.amount || 0);
          const alreadyAdjusted = Number(adjustedMap.get(mongoId) || 0);
          const pending = Math.max(0, billAmount - alreadyAdjusted);
          if (item.adjusted_amount - pending > 0.0001) {
            throw new Error(`Adjustment cannot exceed pending amount for ${purchase.voucher_no || mongoId}`);
          }
          resolved.push({ purchase_id: mongoId, voucher_no: purchase.voucher_no || voucher, adjusted_amount: item.adjusted_amount });
          continue;
        }

        throw new Error(`Invalid purchase adjustment target: ${rawId || voucher}`);
      }
      return resolved;
    };

    if (mongoReady()) {
      resolveWithMongo().then((resolved) => callback(null, resolved)).catch(callback);
      return;
    }

    callback(new Error("MongoDB is not connected"));
  }, excludePaymentId);
}

function insertPaymentAdjustments(paymentId, adjustments, callback) {
  if (!adjustments.length) return callback();
  if (!mongoReady() || !PaymentAdjustmentNative) {
    return callback(new Error("MongoDB is not connected"));
  }

  (async () => {
    try {
      const lastAdjustment = await PaymentAdjustmentNative.findOne({}).sort({ id: -1 }).select("id").lean();
      let nextId = Number(lastAdjustment?.id || 0) + 1;
      await PaymentAdjustmentNative.insertMany(
        adjustments.map((item) => ({
          id: nextId++,
          payment_id: Number(paymentId),
          purchase_id: String(item.purchase_id || ""),
          adjusted_amount: Number(item.adjusted_amount || 0),
          voucher_no: String(item.voucher_no || ""),
          created_at: new Date(),
          updated_at: new Date(),
        }))
      );
      callback();
    } catch (err) {
      callback(err);
    }
  })();
}

function buildPaymentReferenceId(adjustments, purchaseRows = []) {
  const purchaseMap = new Map((purchaseRows || []).map((row) => [String(row.id || row._id), row]));
  return normalizePaymentAdjustments(adjustments)
    .map((item) => item.voucher_no || purchaseMap.get(String(item.purchase_id))?.voucher_no || item.purchase_id)
    .filter(Boolean)
    .join(", ");
}

function normalizeReceiptAdjustments(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => ({
      sale_id: String(item?.sale_id || item?.id || "").trim(),
      adjusted_amount: Number(item?.adjusted_amount),
      voucher_no: item?.voucher_no || item?.sale_voucher_no || "",
    }))
    .filter((item) => item.sale_id && Number.isFinite(item.adjusted_amount) && item.adjusted_amount > 0);
}

function validateReceiptAdjustments({ companyId, amount, adjustments, excludeReceiptId = null }, callback) {
  const cleanAdjustments = normalizeReceiptAdjustments(adjustments);
  const receiptAmount = Number(amount || 0);
  const adjustedTotal = cleanAdjustments.reduce((sum, item) => sum + item.adjusted_amount, 0);
  if (receiptAmount <= 0) return callback(new Error("Receipt amount is required"));
  if (!cleanAdjustments.length) return callback(new Error("Please adjust this receipt against sale bills"));
  if (Math.abs(adjustedTotal - receiptAmount) > 0.0001) return callback(new Error("Receipt amount and adjustment amount must be equal"));

  getReceiptAdjustmentsBySale((err, adjustedMap) => {
    if (err) return callback(err);

    if (mongoReady()) {
      const filter = { $or: [{ buyer_id: String(companyId) }, { company_id: String(companyId) }] };
      return SaleVoucher.find(filter).select("_id voucher_no amount net_receivable_amount").lean().then(async (rows) => {
        const saleMap = new Map();
        (rows || []).forEach((row) => saleMap.set(String(row._id), row));
        const byVoucher = new Map((rows || []).filter((row) => row.voucher_no).map((row) => [String(row.voucher_no), row]));
        const resolved = [];
        for (const item of cleanAdjustments) {
          const rawId = String(item.sale_id || "").trim();
          const sale = saleMap.get(rawId) || byVoucher.get(String(item.voucher_no || "").trim());
          if (!sale) throw new Error(`Invalid sale adjustment target: ${rawId || item.voucher_no || ""}`);
          const saleId = String(sale._id);
          const billAmount = Number(sale.net_receivable_amount || sale.amount || 0);
          const pending = Math.max(0, billAmount - Number(adjustedMap.get(saleId) || 0));
          if (item.adjusted_amount - pending > 0.0001) throw new Error(`Adjustment cannot exceed pending amount for ${sale.voucher_no || saleId}`);
          resolved.push({ sale_id: saleId, voucher_no: sale.voucher_no || item.voucher_no || "", adjusted_amount: item.adjusted_amount });
        }
        callback(null, resolved);
      }).catch(callback);
    }

    callback(new Error("MongoDB is not connected"));
  }, excludeReceiptId);
}

function insertReceiptAdjustments(receiptId, adjustments, callback) {
  if (!adjustments.length) return callback();
  if (!mongoReady() || !MongoReceiptAdjustment) return callback(new Error("MongoDB receipt adjustments are unavailable"));
  const docs = adjustments.map((item) => ({
    receipt_id: String(receiptId),
    sale_id: String(item.sale_id),
    adjusted_amount: Number(item.adjusted_amount || 0),
    voucher_no: item.voucher_no || "",
  }));
  MongoReceiptAdjustment.insertMany(docs)
    .then(() => callback())
    .catch(callback);
}

function buildReceiptReferenceId(adjustments, saleRows = []) {
  const saleMap = new Map((saleRows || []).map((row) => [String(row.id), row]));
  return normalizeReceiptAdjustments(adjustments)
    .map((item) => item.voucher_no || saleMap.get(String(item.sale_id))?.voucher_no || item.sale_id)
    .filter(Boolean)
    .join(", ");
}

async function getVoucherDisplayMaps() {
  const [
    warehouses,
    accounts,
    farmers,
    companies,
  ] = await Promise.all([
    Warehouse.find({}).lean(),
    CompanyAccount.find({}).lean(),
    Farmer.find({}).lean(),
    Company.find({}).lean(),
  ]);

  const buildMap = (rows, fields = ["name"]) => {
    const map = new Map();

    const addKey = (key, row) => {
      if (key === undefined || key === null || String(key).trim() === "") return;
      const text = String(key).trim();
      map.set(text, row);
      if (/^\d+$/.test(text)) map.set(String(Number(text)), row);
    };

    for (const row of rows || []) {
      const keys = [
        row?._id,
        row?.id,
        row?.legacy_id,
      ];

      for (const key of keys) {
        addKey(key, row);
      }

      for (const field of fields) {
        if (
          row?.[field] !== undefined &&
          row?.[field] !== null &&
          String(row[field]).trim()
        ) {
          map.set(String(row[field]).trim().toLowerCase(), row);
        }
      }
    }

    return map;
  };

  const resolveMapRow = (map, value) => {
    const text = String(value ?? "").trim();
    return map.get(text) || map.get(text.toLowerCase()) || ( /^\d+$/.test(text) ? map.get(String(Number(text))) : null) || {};
  };

  return {
    warehouseMap: buildMap(warehouses),
    accountMap: buildMap(accounts, ["account_name", "name"]),
    farmerMap: buildMap(farmers),
    companyMap: buildMap(companies),
    resolveMapRow,
  };
}

function normalizeMongoMirrorVoucher(doc) {
  const data =
    doc?.data &&
    typeof doc.data === "object"
      ? doc.data
      : doc;

  const id =
    data?.id ??
    doc?.legacy_id ??
    String(doc?._id ?? "");

  return {
    ...data,
    id: String(id),
    _id: String(doc?._id ?? id),
    legacy_id:
      doc?.legacy_id ??
      data?.id,
  };
}
async function getMongoPaymentRowsForUser(req) {
  if (!mongoReady()) return [];

  const scopeIds = assignedWarehouseIdsForMongo(req.user);

  const isAdmin =
    req.user?.role === "admin" ||
    userHasPermission(req.user, "warehouses.manage");

  const [legacyRows, nativeRows] = await Promise.all([
    mongoose.connection.db
      .collection("paymentvouchers")
      .find({})
      .sort({
        "data.date": -1,
        legacy_id: -1,
        _id: -1,
      })
      .toArray(),
    mongoose.connection.db
      .collection("paymentvouchers_native")
      .find({})
      .sort({
        date: -1,
        id: -1,
        _id: -1,
      })
      .toArray()
      .catch(() => []),
  ]);

  // Legacy and Native collections contain the same payment records.
  // Read both during migration, but expose each payment only once.
  const rawRows = [];
  const seenPaymentIds = new Set();

  for (const doc of [...(legacyRows || []), ...(nativeRows || [])]) {
    const paymentId = String(
      doc?.id ??
      doc?.legacy_id ??
      doc?.data?.id ??
      doc?._id ??
      ''
    ).trim();

    if (!paymentId || seenPaymentIds.has(paymentId)) continue;

    seenPaymentIds.add(paymentId);
    rawRows.push(doc);
  }

  const {
    warehouseMap,
    accountMap,
    farmerMap,
    resolveMapRow,
  } = await getVoucherDisplayMaps();

  const rows = rawRows
    .map((doc) => {
      if (doc?.data && typeof doc.data === "object") {
        return normalizeMongoMirrorVoucher(doc);
      }

      return {
        ...doc,
        id: String(
          doc?.id ??
            doc?.legacy_id ??
            doc?._id ??
            ""
        ),
        _id: String(
          doc?._id ??
            doc?.id ??
            doc?.legacy_id ??
            ""
        ),
      };
    })
    .filter((row) => {
      if (isAdmin) return true;

      if (!scopeIds.length) return false;

      return scopeIds
        .map(String)
        .includes(String(row.warehouse_id ?? ""));
    })
    .map((row) => {
      const warehouse = resolveMapRow(warehouseMap, row.warehouse_id);

      const account = resolveMapRow(accountMap, row.company_account_id);

      const farmer = resolveMapRow(farmerMap, row.farmer_id);

      return {
        ...row,

        warehouse_name:
          row.warehouse_name ||
          warehouse.name ||
          "",

        company_account_name:
          row.company_account_name ||
          account.account_name ||
          account.name ||
          "",

        account_name:
          row.account_name ||
          account.account_name ||
          account.name ||
          "",

        farmer_name:
          row.farmer_name ||
          farmer.name ||
          "",

        party_name:
          row.party_name ||
          account.account_name ||
          account.name ||
          farmer.name ||
          "-",
      };
    });

  const paymentIds = rows
    .map((row) => Number(row.id))
    .filter((id) => Number.isFinite(id));

  const adjustmentRows =
    paymentIds.length && MongoPaymentAdjustment
      ? await MongoPaymentAdjustment.find({
          payment_id: { $in: paymentIds },
        })
          .sort({ id: 1 })
          .lean()
      : [];

  const purchaseIds = [
    ...new Set(
      (adjustmentRows || [])
        .map((row) =>
          String(row.purchase_id || "").trim()
        )
        .filter(Boolean)
    ),
  ];

  const purchaseMap = new Map();

  if (purchaseIds.length) {
    const validObjectIds =
      purchaseIds.filter((id) =>
        mongoose.Types.ObjectId.isValid(id)
      );

    if (validObjectIds.length) {
      const purchaseRows =
        await PurchaseVoucher.find({
          _id: { $in: validObjectIds },
        })
          .select("_id voucher_no")
          .lean();

      for (const purchase of purchaseRows || []) {
        purchaseMap.set(
          String(purchase._id),
          purchase.voucher_no || ""
        );
      }
    }

    const legacyIds =
      purchaseIds
        .map(Number)
        .filter(Number.isFinite);

    if (
      legacyIds.length &&
      mongoose.connection?.db
    ) {
      const legacyRows =
        await mongoose.connection.db
          .collection("purchasevouchers")
          .find(
            {
              legacy_id: {
                $in: legacyIds,
              },
            },
            {
              projection: {
                legacy_id: 1,
                voucher_no: 1,
                "data.voucher_no": 1,
              },
            }
          )
          .toArray();

      for (const purchase of legacyRows || []) {
        purchaseMap.set(
          String(purchase.legacy_id),
          purchase.voucher_no ||
            purchase.data?.voucher_no ||
            ""
        );
      }
    }
  }

  const byPayment = new Map();

  for (const row of adjustmentRows || []) {
    const key = String(row.payment_id);

    if (!byPayment.has(key)) {
      byPayment.set(key, []);
    }

    const voucher =
      purchaseMap.get(
        String(row.purchase_id)
      ) ||
      String(row.purchase_id || "");

    byPayment.get(key).push({
      ...row,
      voucher_no: voucher,
      purchase_voucher_no: voucher,
      adjusted_amount:
        Number(row.adjusted_amount || 0),
    });
  }

  return rows.map((row) => {
    const adjustments =
      byPayment.get(String(row.id)) || [];

    const adjustmentDetails =
      adjustments
        .filter(
          (item) =>
            item.voucher_no &&
            item.adjusted_amount
        )
        .map(
          (item) =>
            `${item.voucher_no}: ${fmtNum(
              item.adjusted_amount
            )}`
        )
        .join(", ");

    return {
      ...row,

      adjustments,

      reference_type:
        row.reference_type ||
        (adjustments.length
          ? "purchase"
          : "on_account"),

      reference_id:
        row.reference_id ||
        adjustmentDetails ||
        adjustments
          .map(
            (item) =>
              item.voucher_no
          )
          .filter(Boolean)
          .join(", "),
    };
  });
}

router.get("/next-voucher-no", (req, res) => {
  const { type } = req.query;
  if (!type) return res.status(400).json({ error: "type query param is required" });
  if (type === "purchase" && mongoReady()) {
    nextMongoVoucherNo(type)
      .then((voucher_no) => res.json({ voucher_no }))
      .catch((err) => res.status(500).json({ error: err.message }));
    return;
  }
  createSequentialVoucherNo(type, (err, voucher_no) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ voucher_no });
  });
});

// ===========================
// PURCHASE VOUCHERS
// ===========================
router.get("/purchase", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }
  getPurchaseVoucherRows(req, res);
});

router.get("/purchase/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  if (!mongoReady()) {
    return res.status(503).json({ error: "MongoDB is not connected" });
  }

  (async () => {
    try {
      let row = null;
      if (mongoose.Types.ObjectId.isValid(String(id))) {
        const purchase = await PurchaseVoucher.findById(id).lean();
        if (purchase) {
          const [decorated] = await decoratePurchaseRows([purchase]);
          row = decorated || null;
        }
      }

      if (!row) {
        return res.status(404).json({ error: "Purchase voucher not found" });
      }

      if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;
      return res.json({
        ...row,
        id: String(row.id || row._id),
        _id: String(row._id || row.id || id),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  })();
});

router.get("/purchase/import-template", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }
  const buffer = purchaseImportTemplateBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="purchase_voucher_import_format.xlsx"');
  res.send(buffer);
});

router.get("/payment/import-template", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }
  const buffer = paymentImportTemplateBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="payment_voucher_import_format.xlsx"');
  res.send(buffer);
});

router.post("/payment/import-xlsx", upload.single("file"), async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.create")) {
    return res.status(403).json({ error: "Permission denied" });
  }
  if (!req.file?.buffer) {
    return res.status(400).json({ error: "Please upload an Excel file" });
  }

  try {
    const rows = paymentImportRowsFromSheet(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: "No rows found in Excel file" });

    const [warehouses, farmers, accounts, employees, locations] = await Promise.all([
      Warehouse.find({}).lean(),
      Farmer.find({}).lean(),
      CompanyAccount.find({}).lean(),
      Employee.find({}).lean(),
      Location.find({}).lean(),
    ]);

    const warehouseMap = buildImportMap(warehouses, ["name"]);
    const farmerMap = buildImportMap(farmers, ["name", "mobile", "phone", "farmer_no", "farmer_number"]);
    const accountMap = buildImportMap(accounts, ["account_name", "name"]);
    const employeeMap = buildImportMap(employees, ["name", "mobile", "phone"]);
    const locationMap = buildImportMap(locations, ["name"]);
    const imported = [];
    const errors = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNo = index + 2;
      const date = excelDateToIso(firstValue(row, ["Date", "date"]));
      const warehouse = resolveByNameOrId(warehouseMap, firstValue(row, ["Warehouse", "Warehouse Name", "warehouse", "warehouse_id"]));
      const farmer = resolveByNameOrId(farmerMap, firstValue(row, ["Farmer", "Farmer No", "Party", "Name", "farmer", "farmer_id", "farmer_no", "farmer_number"]));
      const account = resolveByNameOrId(accountMap, firstValue(row, ["Account", "Account Name", "company_account", "company_account_id"]));
      const employee = resolveByNameOrId(employeeMap, firstValue(row, ["Employee", "Employee Name", "employee", "employee_id"]));
      const location = resolveByNameOrId(locationMap, firstValue(row, ["Location", "location", "location_id"]));
      const amount = importNumber(firstValue(row, ["Amount", "amount"]));
      const rawReferenceType = String(firstValue(row, ["Reference Type", "reference_type"]) || "").trim();
      const referenceType = rawReferenceType.toLowerCase();
      const referenceId = String(firstValue(row, ["Reference ID", "reference_id"]) || "").trim();
      const narration = String(firstValue(row, ["Narration", "Description", "description"]) || "").trim();
      const requestedVoucherNo = String(firstValue(row, ["Voucher No", "voucher_no"]) || "").trim();

      const hasReference = Boolean(referenceId);
      const normalizedReferenceType = hasReference
        ? (
          referenceType === "purchase" ||
          referenceType === "purchase bill" ||
          referenceType === "purchase_bill" ||
          referenceType === "bill" ||
          referenceType === "purchase invoice" ||
          referenceType === "purchase_invoice" ||
          referenceType === ""
        )
          ? "purchase"
          : referenceType
        : "";
      const finalReferenceType = hasReference ? normalizedReferenceType : "on_account";

      const missing = [];
      if (!date) missing.push("Date");
      if (!warehouse) missing.push("Warehouse");
      if (!farmer) missing.push("Farmer");
      if (!account) missing.push("Account");
      if (amount <= 0) missing.push("Amount");
      if (referenceId && !normalizedReferenceType) missing.push("Reference Type");
      if (missing.length) {
        errors.push({ row: rowNo, error: `Missing/invalid: ${missing.join(", ")}` });
        continue;
      }
      if (!canAccessWarehouse(req.user, warehouse._id)) {
        errors.push({ row: rowNo, error: `No access to warehouse: ${warehouse.name || warehouse._id}` });
        continue;
      }

      let purchase = null;
      let adjustments = [];
      if (hasReference) {
        if (normalizedReferenceType === "purchase") {
          const purchaseFilter = { $or: [{ voucher_no: referenceId }] };
          if (mongoose.Types.ObjectId.isValid(referenceId)) {
            purchaseFilter.$or.push({ _id: referenceId });
          }
          if (farmer?._id) purchaseFilter.farmer_id = String(farmer._id);
          try {
            purchase = await PurchaseVoucher.findOne(purchaseFilter).lean();
          } catch (findErr) {
            errors.push({ row: rowNo, error: `Unable to lookup purchase reference: ${findErr.message}` });
            continue;
          }
          if (!purchase) {
            errors.push({ row: rowNo, error: `Invalid purchase reference: ${referenceId}` });
            continue;
          }
        } else {
          errors.push({ row: rowNo, error: `Unsupported reference type: ${rawReferenceType || referenceType}` });
          continue;
        }

        adjustments = [{
          purchase_id: String(purchase._id || purchase.id || purchase.id),
          adjusted_amount: amount,
          voucher_no: purchase.voucher_no || String(purchase._id || purchase.id),
        }];
      }

      try {
        const cleanAdjustments = await new Promise((resolve, reject) => {
          validatePaymentAdjustments({ farmerId: farmer._id || farmer.id, warehouseId: warehouse._id || warehouse.id, amount, adjustments }, (validationErr, value) => (validationErr ? reject(validationErr) : resolve(value)));
        });

        const voucherNo = await new Promise((resolve, reject) => {
          createVoucherNoIfMissing("payment", requestedVoucherNo, (err, value) => (err ? reject(err) : resolve(value)));
        });

        const insertData = {
          voucher_no: voucherNo,
          date,
          warehouse_id: String(warehouse._id || warehouse.id),
          farmer_id: String(farmer._id || farmer.id),
          company_account_id: String(account._id || account.id),
          amount,
          reference_type: finalReferenceType,
          reference_id: referenceId,
          employee_id: employee ? String(employee._id || employee.id) : String(warehouse.employee_id || ""),
          location_id: location ? String(location._id || location.id) : String(warehouse.location_id || ""),
          description: narration,
        };

        const lastPayment =
  await PaymentVoucherNative.findOne({})
    .sort({ id: -1 })
    .select("id")
    .lean();

const paymentId =
  Number(lastPayment?.id || 0) + 1;

const finalPaymentMode =
  normalizePaymentMode(
    cleanAdjustments.length
      ? "against"
      : "on_account"
  );

const paymentDoc = {
  id: paymentId,
  voucher_no: String(voucherNo || ""),
  date: String(insertData.date || ""),
  warehouse_id: String(insertData.warehouse_id || ""),
  farmer_id: String(insertData.farmer_id || ""),
  company_account_id: String(insertData.company_account_id || ""),
  amount: Number(insertData.amount || 0),
  reference_type: String(
    insertData.reference_type ||
    (cleanAdjustments.length ? "purchase" : "on_account")
  ),
  reference_id: String(insertData.reference_id || ""),
  payment_mode: finalPaymentMode,
  employee_id: String(insertData.employee_id || ""),
  location_id: String(insertData.location_id || ""),
  description: String(insertData.description || ""),
  outstanding_after: 0,
  created_at: new Date(),
  updated_at: new Date(),
};

const duplicatePayment =
  await PaymentVoucherNative.findOne({
    $or: [
      { id: paymentId },
      { voucher_no: paymentDoc.voucher_no },
    ],
  }).lean();

if (duplicatePayment) {
  throw new Error(
    `Duplicate Mongo payment voucher: ${paymentDoc.voucher_no || paymentId}`
  );
}

await PaymentVoucherNative.create(paymentDoc);

if (
  PaymentAdjustmentNative &&
  cleanAdjustments.length > 0
) {
  const lastAdjustment =
    await PaymentAdjustmentNative.findOne({})
      .sort({ id: -1 })
      .select("id")
      .lean();

  let nextAdjustmentId =
    Number(lastAdjustment?.id || 0) + 1;

  const adjustmentDocs =
    cleanAdjustments.map((item) => ({
      id: nextAdjustmentId++,
      payment_id: paymentId,
      purchase_id: String(item.purchase_id || ""),
      adjusted_amount: Number(item.adjusted_amount || 0),
      voucher_no:
        item.voucher_no ||
        item.purchase_voucher_no ||
        "",
      created_at: new Date(),
      updated_at: new Date(),
    }));

  await PaymentAdjustmentNative.insertMany(
    adjustmentDocs
  );
}

const stats = await new Promise(
  (resolve, reject) => {
    computeOutstandingForFarmer(
      String(insertData.farmer_id || ""),
      (err2, statsData) =>
        err2
          ? reject(err2)
          : resolve(statsData),
      String(insertData.company_account_id || "")
    );
  }
);

await PaymentVoucherNative.updateOne(
  { id: paymentId },
  {
    $set: {
      outstanding_after: Number(
        stats?.outstanding || 0
      ),
      updated_at: new Date(),
    },
  }
);

imported.push({
  row: rowNo,
  id: paymentId,
  voucher_no: voucherNo,
});
      } catch (err) {
        const message = err?.message || "Payment import failed";
        errors.push({ row: rowNo, error: message });
      }
    }

    res.json({ imported: imported.length, failed: errors.length, rows: imported, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/receipt/import-template", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }
  const buffer = receiptImportTemplateBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="receipt_voucher_import_format.xlsx"');
  res.send(buffer);
});

router.post("/purchase/import-xlsx", upload.single("file"), async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.create")) {
    return res.status(403).json({ error: "Permission denied" });
  }
  if (!mongoReady()) {
    return res.status(503).json({ error: "MongoDB is not connected. Purchase import saves data in MongoDB." });
  }
  if (!req.file?.buffer) {
    return res.status(400).json({ error: "Please upload an Excel file" });
  }

  try {
    const rows = purchaseImportRowsFromSheet(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: "No rows found in Excel file" });

    const [warehouses, farmers, products, accounts, employees, locations] = await Promise.all([
      Warehouse.find({}).lean(),
      Farmer.find({}).lean(),
      Product.find({}).lean(),
      CompanyAccount.find({}).lean(),
      Employee.find({}).lean(),
      Location.find({}).lean(),
    ]);

    const warehouseMap = buildImportMap(warehouses, ["name"]);
    const farmerMap = buildImportMap(farmers, ["name", "mobile", "phone"]);
    const productMap = buildImportMap(products, ["name"]);
    const accountMap = buildImportMap(accounts, ["account_name", "name"]);
    const employeeMap = buildImportMap(employees, ["name", "mobile", "phone"]);
    const locationMap = buildImportMap(locations, ["name"]);
    const imported = [];
    const errors = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNo = index + 2;
      const date = excelDateToIso(firstValue(row, ["Date", "date"]));
      const warehouse = resolveByNameOrId(warehouseMap, firstValue(row, ["Warehouse", "Warehouse Name", "warehouse", "warehouse_id"]));
      const farmer = resolveByNameOrId(farmerMap, firstValue(row, ["Farmer", "Party", "Name", "farmer", "farmer_id"]));
      const product = resolveByNameOrId(productMap, firstValue(row, ["Product", "Product Name", "product", "product_id"]));
      const account = resolveByNameOrId(accountMap, firstValue(row, ["Account", "Account Name", "company_account", "company_account_id"]));
      const employee = resolveByNameOrId(employeeMap, firstValue(row, ["Employee", "Employee Name", "employee", "employee_id"]));
      const location = resolveByNameOrId(locationMap, firstValue(row, ["Location", "location", "location_id"]));

      const missing = [];
      if (!date) missing.push("Date");
      if (!warehouse) missing.push("Warehouse");
      if (!farmer) missing.push("Farmer");
      if (!product) missing.push("Product");
      if (!account) missing.push("Account");
      if (missing.length) {
        errors.push({ row: rowNo, error: `Missing/invalid: ${missing.join(", ")}` });
        continue;
      }
      if (!canAccessWarehouse(req.user, warehouse._id)) {
        errors.push({ row: rowNo, error: `No access to warehouse: ${warehouse.name || warehouse._id}` });
        continue;
      }

      const packet = importNumber(firstValue(row, ["Packet", "packet"]));
      const grossWeight = importNumber(firstValue(row, ["Gross Wt", "Gross Weight", "gross_weight"]));
      const tareWeight = importNumber(firstValue(row, ["Tare Wt", "Tare Weight", "Tear Weight", "tare_weight"]));
      const dhalta = importNumber(firstValue(row, ["Dhalta", "dhalta"]));
      const lessBagsWeight = importNumber(firstValue(row, ["Less Bags Weight", "less_bags_weight"]));
      const moisture = importNumber(firstValue(row, ["Moistur", "Moisture", "moisture"]));
      const dunki = importNumber(firstValue(row, ["Dunki", "dunki"]));
      const fungus = importNumber(firstValue(row, ["Fungas", "Fungus", "fungus"]));
      const discolour = importNumber(firstValue(row, ["Disclour", "Discolour", "discolour"]));
      const others = importNumber(firstValue(row, ["Others", "others"]));
      const rate = importNumber(firstValue(row, ["Rate", "rate"]));
      const bagsClaim = importNumber(firstValue(row, ["Bags Claim", "bags_claim"]));
      const labour = importNumber(firstValue(row, ["Labour", "labour"]));
      const roundOff = importNumber(firstValue(row, ["Round Off", "round_off"]));
      const newWeight = Math.max(grossWeight - tareWeight, 0);
      const netWeight = Math.max(newWeight - dhalta - lessBagsWeight - moisture - dunki - fungus - discolour - others, 0);
      const grossAmount = netWeight * rate;
      const totalDeduction = bagsClaim + labour;
      const netPayable = Math.max(grossAmount - totalDeduction + roundOff, 0);

      try {
        const requestedVoucherNo = String(firstValue(row, ["Voucher No", "voucher_no"])).trim();
        const voucherNo = await new Promise((resolve, reject) => {
          createVoucherNoIfMissing("purchase", requestedVoucherNo, (err, value) => (err ? reject(err) : resolve(value)));
        });
        const doc = await PurchaseVoucher.create({
          voucher_no: voucherNo,
          date,
          warehouse_id: String(warehouse._id),
          farmer_id: String(farmer._id),
          company_account_id: String(account._id),
          product_id: String(product._id),
          employee_id: employee ? String(employee._id) : String(warehouse.employee_id || ""),
          location_id: location ? String(location._id) : String(warehouse.location_id || ""),
          quantity: netWeight,
          rate,
          amount: netPayable,
          packet,
          gross_weight: grossWeight,
          tare_weight: tareWeight,
          dhalta,
          less_bags_weight: lessBagsWeight,
          moisture,
          dunki,
          fungus,
          discolour,
          others,
          net_weight: netWeight,
          bags_claim: bagsClaim,
          labour,
          total_deduct_amount: 0,
          total_qty: netWeight,
          total_deduction: totalDeduction,
          round_off: roundOff,
          net_amount_payable: netPayable,
          description: String(firstValue(row, ["Narration", "Description", "description"])).trim(),
        });
        imported.push({ row: rowNo, id: String(doc._id), voucher_no: doc.voucher_no });
      } catch (err) {
        const message = err?.code === 11000 ? "Voucher number already exists" : err.message;
        errors.push({ row: rowNo, error: message });
      }
    }

    res.json({
      imported: imported.length,
      failed: errors.length,
      rows: imported,
      errors,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/purchase", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.create")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const {
    voucher_no,
    date,
    warehouse_id,
    farmer_id,
    company_account_id,
    product_id,
    quantity,
    rate,
    amount,
    packet,
    gross_weight,
    tare_weight,
    dhalta,
    less_bags_weight,
    moisture,
    dunki,
    fungus,
    discolour,
    others,
    net_weight,
    bags_claim,
    labour,
    total_deduct_amount,
    total_qty,
    total_deduction,
    round_off,
    net_amount_payable,
    employee_id,
    location_id,
    description,
  } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  if (!mongoReady()) {
    return res.status(503).json({ error: "MongoDB is not connected. Purchase data must be saved in MongoDB." });
  }

  if (mongoReady()) {
    return createVoucherNoIfMissing("purchase", voucher_no, async (err, generatedVoucherNo) => {
      if (err) return res.status(500).json({ error: err.message });
      try {
        const payload = buildPurchasePayload(req.body, generatedVoucherNo);
        const doc = await PurchaseVoucher.create(payload);
        const deductionDetails = buildPurchaseDeductionDetails(req.body);
        await PurchaseVoucher.collection.updateOne(
          { _id: doc._id },
          { $set: { claim_amount: Number(req.body.claim_amount || req.body.bags_claim || 0), other_deduction: Number(req.body.other_deduction || 0), cd_percent: Number(req.body.cd_percent || 0), cd_amount: Number(req.body.cd_amount || 0), adjustment_amount: Number(req.body.adjustment_amount || 0), tds_amount: Number(req.body.tds_amount || 0), deduction_details: deductionDetails, total_deduction: Number(req.body.total_deduction || 0) } }
        );
        return res.json({ id: String(doc._id), _id: String(doc._id), voucher_no: doc.voucher_no, saved_to: "mongodb" });
      } catch (mongoErr) {
        if (mongoErr?.code === 11000) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: mongoErr.message });
      }
    });
  }

  const idemKey = req.get("Idempotency-Key") || req.headers["idempotency-key"];
  if (idemKey) {
    return getIdempotency(idemKey, "purchase", (err, existingId) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existingId) {
        return PurchaseVoucher.findOne({ id: Number(existingId) })
          .lean()
          .then((existingRow) => {
            if (!existingRow) return res.status(404).json({ error: "Voucher not found" });
            return res.json({ id: existingRow.id || existingRow._id, voucher_no: existingRow.voucher_no, existing: existingRow });
          })
          .catch((e2) => res.status(500).json({ error: e2.message }));
      }

      createVoucherNoIfMissing("purchase", voucher_no, (err, generatedVoucherNo) => {
        if (err) return res.status(500).json({ error: err.message });

        const doc = {
          voucher_no: generatedVoucherNo,
          date,
          warehouse_id,
          farmer_id,
          company_account_id,
          product_id,
          quantity,
          rate,
          amount,
          packet,
          gross_weight,
          tare_weight,
          dhalta,
          less_bags_weight,
          moisture,
          dunki,
          fungus,
          discolour,
          others,
          net_weight,
          bags_claim,
          labour,
          total_deduct_amount,
          total_qty,
          total_deduction,
          round_off,
          net_amount_payable,
          employee_id,
          location_id,
          description,
        };
        PurchaseVoucher.create(doc)
          .then((saved) => {
            saveIdempotency(idemKey, "purchase", saved.id || saved._id, () => {});
            res.json({ id: saved.id || saved._id, voucher_no: generatedVoucherNo });
          })
          .catch((err) => {
            if (String(err.message || "").includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          });
      });
    });
  }

  // no idempotency key, proceed normally
  createVoucherNoIfMissing("purchase", voucher_no, (err, generatedVoucherNo) => {
    if (err) return res.status(500).json({ error: err.message });

    PurchaseVoucher.create({
      voucher_no: generatedVoucherNo,
      date,
      warehouse_id,
      farmer_id,
      company_account_id,
      product_id,
      quantity,
      rate,
      amount,
      packet,
      gross_weight,
      tare_weight,
      dhalta,
      less_bags_weight,
      moisture,
      dunki,
      fungus,
      discolour,
      others,
      net_weight,
      bags_claim,
      labour,
      total_deduct_amount,
      total_qty,
      total_deduction,
      round_off,
      net_amount_payable,
      employee_id,
      location_id,
      description,
    })
      .then((saved) => res.json({ id: saved.id || saved._id, voucher_no: generatedVoucherNo }))
      .catch((err) => {
        if (String(err.message || "").includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: err.message });
      });
  });
});

router.get("/outstanding", (req, res) => {
  const startedAt = Date.now();
  const { party_type, id, warehouse_id, location_id, exclude_payment_id, company_account_id } = req.query;
  if (!party_type || !id) return res.status(400).json({ error: "party_type and id are required" });

  const filters = ["1=1"];
  const params = [id];
  let detailsQuery;
  let paymentsQuery;

  if (party_type === "farmer") {
    if (warehouse_id) {
      filters.push("warehouse_id = ?");
      params.push(warehouse_id);
    }
    if (location_id) {
      filters.push("location_id = ?");
      params.push(location_id);
    }
    if (company_account_id) {
      filters.push("company_account_id = ?");
      params.push(company_account_id);
    }
    const paymentFilters = filters.slice(1);
    const paymentParams = [...params];
    if (exclude_payment_id) {
      paymentFilters.push("CAST(id AS TEXT) <> CAST(? AS TEXT)");
      paymentParams.push(exclude_payment_id);
    }
    // The scoped stats below are authoritative for this account/warehouse.
    // Avoid the older global farmer aggregation here; it was both slower and
    // could produce a different balance during payment edit.
    getPaymentAdjustmentsByPurchase((adjustErr, adjustedMap) => {
        if (adjustErr) return res.status(500).json({ error: adjustErr.message });

        const send = (purchaseRows) => {
          const purchases = (purchaseRows || []).map((row) => {
            const purchaseId = String(row.id || row._id);
            const amount = Number(row.amount || row.net_amount_payable || row.total_amount || 0);
            const adjusted_amount = adjustedMap.get(purchaseId) || 0;
            return {
              ...row,
              id: purchaseId,
              amount,
              adjusted_amount,
              pending_amount: Number(Math.max(0, amount - adjusted_amount).toFixed(2)),
            };
          });

          getMongoPaymentRowsForUser(req)
            .then((rows) => {
              const payments = (rows || []).filter((row) => {
                if (String(row.farmer_id || "") !== String(id || "")) return false;
                if (warehouse_id && String(row.warehouse_id || "") !== String(warehouse_id)) return false;
                if (company_account_id && String(row.company_account_id || "") !== String(company_account_id)) return false;
                if (exclude_payment_id && String(row.id || "") === String(exclude_payment_id)) return false;
                return true;
              });
              const totalPurchase = purchases.reduce((sum, row) => sum + Number(row.amount || 0), 0);
              const totalDeduction = purchases.reduce((sum, row) => {
                const value =
                  row.total_deduction ??
                  row.total_deduct_amount ??
                  (Number(row.bags_claim || 0) + Number(row.labour || 0) + Number(row.transport_charge || 0));
                return sum + (Number.isFinite(Number(value)) ? Number(value) : 0);
              }, 0);
              const totalPayment = (payments || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
              const scopedStats = {
                total_bill: Number(totalPurchase.toFixed(2)),
                total_purchase: Number(totalPurchase.toFixed(2)),
                total_deduction: Number(totalDeduction.toFixed(2)),
                total_payment: Number(totalPayment.toFixed(2)),
                outstanding: Number((totalPurchase - totalPayment).toFixed(2)),
              };
              res.set("Server-Timing", `outstanding;dur=${Date.now() - startedAt}`);
              res.json({ party_type: "farmer", id, party_id: String(id), farmer_id: String(id), warehouse_id: warehouse_id ? String(warehouse_id) : "", company_account_id: company_account_id ? String(company_account_id) : "", exclude_payment_id: exclude_payment_id ? String(exclude_payment_id) : "", stats: scopedStats, purchases, payments });
            })
            .catch((err3) => res.status(500).json({ error: err3.message }));
        };

        if (mongoReady()) {
          const filter = { farmer_id: String(id || "") };
          if (warehouse_id) filter.warehouse_id = String(warehouse_id);
          if (company_account_id) filter.company_account_id = String(company_account_id);
          PurchaseVoucher.find(filter)
            .sort({ date: 1, createdAt: 1, _id: 1 })
            .lean()
            .then((rows) => decoratePurchaseRows(rows || []))
            .then((rows) => send(rows.map((row) => ({
              ...row,
              amount: Number(row.total_amount || row.net_amount_payable || row.amount || 0),
            }))))
            .catch((mongoErr) => res.status(500).json({ error: mongoErr.message }));
          return;
        }

        PurchaseVoucher.find({
          farmer_id: String(id || ""),
          ...(warehouse_id ? { warehouse_id: String(warehouse_id) } : {}),
          ...(company_account_id ? { company_account_id: String(company_account_id) } : {}),
        })
          .sort({ date: 1, createdAt: 1, _id: 1 })
          .lean()
          .then((rows) => send((rows || []).map((row) => ({
            ...row,
            id: String(row._id),
            amount: Number(row.total_amount || row.net_amount_payable || row.amount || 0),
          }))))
          .catch((err2) => res.status(500).json({ error: err2.message }));
      }, exclude_payment_id);
    return;
  }

  if (party_type === "company") {
    if (warehouse_id) {
      filters.push("warehouse_id = ?");
      params.push(warehouse_id);
    }
    if (location_id) {
      filters.push("location_id = ?");
      params.push(location_id);
    }
    if (company_account_id) {
      filters.push("CAST(company_account_id AS TEXT) = CAST(? AS TEXT)");
      params.push(company_account_id);
    }

    const getSaleRows = (callback) => {
      if (!mongoReady()) return callback(new Error("MongoDB is not connected"));
      const filter = {
        $or: [
          { buyer_id: String(id || "") },
          { company_id: String(id || "") },
        ],
      };
      if (warehouse_id) filter.warehouse_id = String(warehouse_id);
      if (company_account_id) filter.company_account_id = String(company_account_id);
      return SaleVoucher.find(filter)
        .sort({ date: 1, createdAt: 1, _id: 1 })
        .lean()
        .then((rows) => callback(null, (rows || []).map((row) => ({
          ...row,
          id: String(row._id),
          amount: Number(row.net_receivable_amount || row.amount || 0),
        }))))
        .catch(callback);
    };

    computeOutstandingForCompany(id, (err, stats) => {
      if (err) return res.status(500).json({ error: err.message });
      getReceiptAdjustmentsBySale((adjustErr, adjustedMap) => {
        if (adjustErr) return res.status(500).json({ error: adjustErr.message });

        getSaleRows((err2, sales) => {
          if (err2) return res.status(500).json({ error: err2.message });

          getMongoReceiptRowsForUser(req)
            .then((receipts) => {
              const scopedReceipts = (receipts || []).filter((row) => {
                if (String(row.company_id || "") !== String(id || "")) return false;
                if (warehouse_id && String(row.warehouse_id || "") !== String(warehouse_id)) return false;
                if (company_account_id && String(row.company_account_id || "") !== String(company_account_id)) return false;
                if (exclude_payment_id && String(row.id || "") === String(exclude_payment_id)) return false;
                return true;
              });

              const decoratedSales = (sales || []).map((row) => {
                const saleId = String(row.id || row._id);
                const amount = Number(row.amount || 0);
                const adjusted_amount = adjustedMap.get(saleId) || 0;
                return {
                  ...row,
                  id: saleId,
                  amount,
                  adjusted_amount,
                  pending_amount: Number(Math.max(0, amount - adjusted_amount).toFixed(2)),
                };
              });

              res.json({ party_type: "company", id, stats, sales: decoratedSales, receipts: scopedReceipts });
            })
            .catch((receiptErr) => res.status(500).json({ error: receiptErr.message }));
        });
      }, exclude_payment_id);
    });
    return;
  }

  res.status(400).json({ error: "Unsupported party_type" });
});

// ===========================
// FARMERS BY ACCOUNT WITH OUTSTANDING
// ===========================
// Fast payment farmer lookup cache. The previous implementation loaded every
// purchase row and then ran an outstanding calculation once per farmer (N+1).
// That made account/warehouse changes take several seconds.
const paymentFarmerCache = new Map();
const PAYMENT_FARMER_CACHE_MS = 60 * 1000;
const paymentFarmerInFlight = new Map();

async function getFastPaymentFarmers(req, accountId, warehouseId = "", excludePaymentId = "") {
  const accountKey = String(accountId || "").trim();
  const warehouseKey = String(warehouseId || "").trim();
  const excludePaymentKey = String(excludePaymentId || "").trim();
  const assigned = req.user && Array.isArray(req.user.assigned_warehouses)
    ? req.user.assigned_warehouses.map((id) => String(id))
    : [];
  const key = JSON.stringify([String(req.user?.id || req.user?._id || ""), accountKey, warehouseKey, excludePaymentKey, assigned.join(",")]);
  const cached = paymentFarmerCache.get(key);
  if (cached && Date.now() - cached.time < PAYMENT_FARMER_CACHE_MS) return cached.data;
  if (paymentFarmerInFlight.has(key)) return paymentFarmerInFlight.get(key);

  const promise = (async () => {
    const purchaseFilter = { company_account_id: accountKey };
    if (warehouseKey) {
      if (assigned.length && !assigned.includes(warehouseKey)) return [];
      purchaseFilter.warehouse_id = warehouseKey;
    } else if (assigned.length) {
      purchaseFilter.warehouse_id = { $in: assigned };
    }

    const grouped = await PurchaseVoucher.aggregate([
      { $match: purchaseFilter },
      { $match: { farmer_id: { $nin: [null, ""] } } },
      { $group: {
          _id: "$farmer_id",
          total_purchase: { $sum: { $ifNull: ["$net_amount_payable", { $ifNull: ["$amount", 0] }] } },
          warehouse_ids: { $addToSet: "$warehouse_id" },
        }
      },
    ]).allowDiskUse(true);

    const farmerIds = grouped.map((r) => String(r._id || "")).filter(Boolean);
    if (!farmerIds.length) return [];

    const farmers = await Farmer.find({ _id: { $in: farmerIds } })
      .select("_id name mobile address village")
      .lean();

    const paymentFilter = { company_account_id: accountKey };
    if (warehouseKey) paymentFilter.warehouse_id = warehouseKey;
    if (excludePaymentKey) paymentFilter.id = { $ne: Number(excludePaymentKey) };
    const paymentRows = await PaymentVoucherNative.find(paymentFilter).lean();
    const paymentMap = new Map(paymentRows.map((r) => [String(r.farmer_id), Number(r.total_payment || 0)]));
    const purchaseMap = new Map(grouped.map((r) => [String(r._id), Number(r.total_purchase || 0)]));

    const data = (farmers || []).map((f) => {
      const id = String(f._id);
      const totalPurchase = purchaseMap.get(id) || 0;
      const totalPayment = paymentMap.get(id) || 0;
      return {
        id, name: f.name, mobile: f.mobile, address: f.address, village: f.village,
        total_purchase: Number(totalPurchase.toFixed(2)),
        total_adjusted: Number(totalPayment.toFixed(2)),
        outstanding: Number((totalPurchase - totalPayment).toFixed(2)),
        warehouse_ids: (grouped.find((g) => String(g._id) === id)?.warehouse_ids || []).map(String),
      };
    }).filter((f) => f.outstanding > 0);

    paymentFarmerCache.set(key, { time: Date.now(), data });
    return data;
  })().finally(() => paymentFarmerInFlight.delete(key));

  paymentFarmerInFlight.set(key, promise);
  return promise;
}

router.get("/farmers-by-account/:accountId", async (req, res) => {
  const { accountId } = req.params;
  const { warehouse_id, exclude_payment_id } = req.query;
  if (!accountId) return res.status(400).json({ error: "Account ID is required" });
  if (mongoReady()) {
    try {
      const started = Date.now();
      const result = await getFastPaymentFarmers(req, accountId, warehouse_id, exclude_payment_id);
      res.set("Server-Timing", `payment-farmers;dur=${Date.now() - started}`);
      res.set("Cache-Control", "private, max-age=60, stale-while-revalidate=30");
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const filter = assignedWarehouseFilter(req.user, "pv.warehouse_id");
  const filters = ["1=1"];
  const params = [];
  
  if (warehouse_id) {
    filters.push("pv.warehouse_id = ?");
    params.push(warehouse_id);
  }

  const purchaseMatch = { company_account_id: String(accountId) };
  if (warehouse_id) purchaseMatch.warehouse_id = String(warehouse_id);
  const [farmers, purchases, payments] = await Promise.all([
    Farmer.find({}).lean(),
    PurchaseVoucher.find(purchaseMatch).lean(),
    PaymentVoucherNative ? PaymentVoucherNative.find(purchaseMatch).lean() : Promise.resolve([]),
  ]);
  const farmerIds = new Set((purchases || []).map((row) => String(row.farmer_id || "")));
  const result = (farmers || [])
    .filter((f) => farmerIds.has(String(f._id || f.id)))
    .map((f) => {
      const id = String(f._id || f.id);
      const totalPurchase = (purchases || []).filter((row) => String(row.farmer_id || "") === id).reduce((sum, row) => sum + Number(row.net_amount_payable || row.amount || 0), 0);
      const totalAdjusted = (payments || []).filter((row) => String(row.farmer_id || "") === id).reduce((sum, row) => sum + Number(row.amount || 0), 0);
      const outstanding = Math.max(0, totalPurchase - totalAdjusted);
      return {
        ...f,
        total_purchase: Number(totalPurchase.toFixed(2)),
        total_adjusted: Number(totalAdjusted.toFixed(2)),
        outstanding: Number(outstanding.toFixed(2)),
      };
    });
  res.json(result.filter((f) => f.outstanding > 0));
});

router.get("/receipt-pending-buyers", async (req, res) => {
  const accountId = String(req.query.company_account_id || "").trim();
  const warehouseId = String(req.query.warehouse_id || "").trim();
  const excludeReceiptId = String(req.query.exclude_receipt_id || "").trim();

  if (!accountId) return res.status(400).json({ error: "company_account_id is required" });

  try {
    let saleRows = [];

    if (!mongoReady()) return res.status(503).json({ error: "MongoDB is not connected" });
    const saleFilter = { ...mongoSaleScope(req.user), company_account_id: accountId };
    if (warehouseId) saleFilter.warehouse_id = warehouseId;
    saleRows = await SaleVoucher.aggregate([
      { $match: saleFilter },
      {
        $group: {
          _id: { $ifNull: ["$buyer_id", "$company_id"] },
          total_sale: { $sum: { $ifNull: ["$net_receivable_amount", { $ifNull: ["$amount", 0] }] } },
          warehouse_ids: { $addToSet: "$warehouse_id" },
        },
      },
    ]).allowDiskUse(true);

    const buyerIds = saleRows.map((row) => String(row._id || "")).filter(Boolean);
    if (!buyerIds.length) return res.json([]);

    const receiptFilter = { company_account_id: accountId, company_id: { $in: buyerIds } };
    if (warehouseId) receiptFilter.warehouse_id = warehouseId;
    if (excludeReceiptId && mongoose.Types.ObjectId.isValid(excludeReceiptId)) receiptFilter._id = { $ne: excludeReceiptId };
    const receiptRows = MongoReceiptVoucher ? await MongoReceiptVoucher.find(receiptFilter).lean() : [];
    const receiptMap = new Map();
    receiptRows.forEach((row) => {
      const key = String(row.company_id || row.buyer_id || "");
      receiptMap.set(key, (receiptMap.get(key) || 0) + Number(row.amount || 0));
    });
    const buyerModel = getDedicatedPartyModel("buyer");
    const buyerRows = buyerModel ? await buyerModel.find({ $or: [{ legacy_id: { $in: buyerIds.map(Number).filter(Number.isFinite) } }, { _id: { $in: buyerIds.filter((id) => mongoose.Types.ObjectId.isValid(id)) } }] }).lean() : [];
    const buyerNameMap = new Map(buyerRows.map((row) => [String(row.legacy_id || row._id), row.name]));

    const result = saleRows
      .map((row) => {
        const buyerId = String(row._id || "");
        const totalSale = Number(row.total_sale || 0);
        const totalReceipt = receiptMap.get(buyerId) || 0;
        const outstanding = Number((totalSale - totalReceipt).toFixed(2));
        return {
          id: buyerId,
          buyer_id: buyerId,
          company_id: buyerId,
          buyer_name: buyerNameMap.get(buyerId) || "",
          company_name: buyerNameMap.get(buyerId) || "",
          total_sale: Number(totalSale.toFixed(2)),
          total_receipt: Number(totalReceipt.toFixed(2)),
          outstanding,
          warehouse_ids: (row.warehouse_ids || []).map(String),
        };
      })
      .filter((row) => row.outstanding > 0)
      .sort((a, b) => String(a.buyer_name || a.buyer_id).localeCompare(String(b.buyer_name || b.buyer_id)));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================
// SALE VOUCHERS
// ===========================
router.get("/sale", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.sale.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  getSaleVoucherRows(req, res);
});

router.post("/sale", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.sale.create")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  if (!mongoReady()) {
    return res.status(503).json({ error: "MongoDB is not connected. Sale data must be saved in MongoDB." });
  }

  const { voucher_no } = req.body;
  const isDirectSale = req.body?.sale_type === "direct";
  if (!isDirectSale && !req.body?.warehouse_id) return res.status(400).json({ error: "Warehouse is required for sale voucher" });
  if (isDirectSale && !req.body?.location_id) return res.status(400).json({ error: "Location is required for direct sale" });
  if (isDirectSale && !(req.body?.farmer_id || req.body?.against_purchase_farmer_id)) return res.status(400).json({ error: "Farmer is required for direct sale" });
  if (!req.body?.company_account_id) return res.status(400).json({ error: "Account is required for sale voucher" });
  if (!req.body?.product_id) return res.status(400).json({ error: "Product is required for sale voucher" });
  if (!isDirectSale && !ensureWarehouseAccess(req, res, req.body.warehouse_id)) return;

  if (mongoReady()) {
    return createVoucherNoIfMissing("sale", voucher_no, async (err, generatedVoucherNo) => {
      if (err) return res.status(500).json({ error: err.message });
      try {
        const payload = buildSalePayload(req.body, generatedVoucherNo);
        const saleQty = Number(payload.unloading_qty || payload.quantity || 0);
        if (!isDirectSale) {
          const availableQty = await getAvailableSaleStock({
            warehouseId: payload.warehouse_id,
            productId: payload.product_id,
          });
          if (saleQty > availableQty + 0.0001) {
            return res.status(400).json({ error: `Negative stock not allowed. Available stock: ${availableQty.toFixed(4)}` });
          }
        } else if (req.body?.create_against_purchase === true) {
          const directPurchase = await createDirectSalePurchaseVoucher(payload);
          payload.against_purchase_enabled = Boolean(directPurchase);
          payload.against_purchase_farmer_id = directPurchase?.farmer_id || payload.against_purchase_farmer_id || "";
          payload.against_purchase_links = directPurchase ? [directPurchase] : [];
        } else {
          payload.against_purchase_enabled = false;
          payload.against_purchase_farmer_id = "";
          payload.against_purchase_links = [];
        }
        const doc = await SaleVoucher.create(payload);
        return res.json({ id: String(doc._id), _id: String(doc._id), voucher_no: doc.voucher_no, saved_to: "mongodb" });
      } catch (mongoErr) {
        if (mongoErr?.code === 11000) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: mongoErr.message });
      }
    });
  }
});

router.put("/sale/:id", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.sale.edit")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  const deductionOnly = Boolean(req.body?.deduction_only);
  const isDirectSale = req.body?.sale_type === "direct";
  if (!isDirectSale && !req.body?.warehouse_id) return res.status(400).json({ error: "Warehouse is required for sale voucher" });
  if (isDirectSale && !req.body?.location_id) return res.status(400).json({ error: "Location is required for direct sale" });
  if (!isDirectSale && !ensureWarehouseAccess(req, res, req.body.warehouse_id)) return;

  if (mongoReady() && mongoose.Types.ObjectId.isValid(id)) {
    return (async () => {
      try {
        if (deductionOnly) {
          const existing = await SaleVoucher.findById(id);
          if (!existing) return res.status(404).json({ error: "Sale voucher not found" });
          const dueFields = resolveSaleDueFields(req.body, existing);
          const manualClaimValue = Number(req.body.claim_amount !== undefined ? req.body.claim_amount : existing.claim_amount) || 0;
          const adjustmentValue = Number(req.body.adjustment_amount !== undefined ? req.body.adjustment_amount : existing.adjustment_amount) || 0;
          const tdsValue = Number(req.body.tds_amount !== undefined ? req.body.tds_amount : existing.tds_amount) || 0;
          const roundOffValue = Number(req.body.round_off !== undefined ? req.body.round_off : existing.round_off) || 0;
          const transportChargeValue = Number(req.body.transport_charge !== undefined ? req.body.transport_charge : existing.transport_charge) || 0;
          const rateValue = Number(req.body.rate !== undefined ? req.body.rate : existing.rate) || 0;
          const saleQty = Number(existing.quantity || 0);
          const grossAmount = Number(existing.amount || 0);
          const unloadingQtyValue = Number(req.body.unloading_qty !== undefined ? req.body.unloading_qty : existing.unloading_qty || req.body.quantity || existing.quantity) || 0;

          const shortageQty = Math.max(0, saleQty - unloadingQtyValue);
          const shortageAmount = Number(((Number(req.body.shortage_amount) || shortageQty * rateValue) || 0).toFixed(2));

          const claimValue = req.body.claim_amount !== undefined ? manualClaimValue : shortageAmount;
          const otherDeductionValue = Number(req.body.other_deduction !== undefined ? req.body.other_deduction : existing.other_deduction) || 0;
          const cdPercentValue = Number(req.body.cd_percent !== undefined ? req.body.cd_percent : existing.cd_percent) || 0;
          const cdAmountValue = Number(req.body.cd_amount !== undefined ? req.body.cd_amount : existing.cd_amount) || 0;

          const netAmount = grossAmount - claimValue - otherDeductionValue - transportChargeValue - cdAmountValue - adjustmentValue - tdsValue + roundOffValue;

          existing.unloading_date = req.body.unloading_date !== undefined ? req.body.unloading_date : existing.unloading_date;
          existing.due_date = dueFields.due_date || existing.due_date || "";
          existing.due_days = dueFields.due_days;
          existing.unloading_qty = unloadingQtyValue;
          existing.shortage_quantity = shortageQty;
          existing.shortage_amount = shortageAmount;
          existing.moisture = Number(req.body.moisture !== undefined ? req.body.moisture : existing.moisture) || 0;
          existing.dunki = Number(req.body.dunki !== undefined ? req.body.dunki : existing.dunki) || 0;
          existing.fungus = Number(req.body.fungus !== undefined ? req.body.fungus : existing.fungus) || 0;
          existing.discolour = Number(req.body.discolour !== undefined ? req.body.discolour : existing.discolour) || 0;
          existing.others = Number(req.body.others !== undefined ? req.body.others : existing.others) || 0;
          const calculatedTotalDeduction = claimValue + otherDeductionValue + transportChargeValue + cdAmountValue + adjustmentValue + tdsValue;
          existing.total_deduction = Number(req.body.total_deduction !== undefined ? req.body.total_deduction : calculatedTotalDeduction) || calculatedTotalDeduction;
          existing.transport_charge = transportChargeValue;
          existing.claim_amount = claimValue;
          existing.other_deduction = otherDeductionValue;
          existing.cd_percent = cdPercentValue;
          existing.cd_amount = cdAmountValue;
          existing.adjustment_amount = adjustmentValue;
          existing.tds_amount = tdsValue;
          existing.round_off = roundOffValue;
          existing.net_amount = netAmount;
          existing.net_receivable_amount = netAmount;
          existing.net_amount_payable = netAmount;
          existing.outstanding = netAmount;
          const saved = await existing.save();
          const journals = await recreateSaleDeductionJournals({
            sale: saved,
            body: req.body,
            shortageAmount,
            deductionAmount: otherDeductionValue + adjustmentValue,
            cdAmount: cdAmountValue,
            tdsAmount: tdsValue,
          });
          return res.json({ id: String(saved._id), updated: 1, voucher_no: saved.voucher_no, deduction_only: true, saved_to: "mongodb", shortage_qty: existing.shortage_quantity, shortage_amount: shortageAmount, journals });
        }
        if (!req.body?.company_account_id) return res.status(400).json({ error: "Account is required for sale voucher" });
        if (!req.body?.product_id) return res.status(400).json({ error: "Product is required for sale voucher" });
        const payload = buildSalePayload(req.body);
        const saleQty = Number(payload.unloading_qty || payload.quantity || 0);
        if (payload.sale_type !== "direct") {
          const availableQty = await getAvailableSaleStock({
            warehouseId: payload.warehouse_id,
            productId: payload.product_id,
            excludeSaleId: id,
          });
          if (saleQty > availableQty + 0.0001) {
            return res.status(400).json({ error: `Negative stock not allowed. Available stock: ${availableQty.toFixed(4)}` });
          }
        }
        const doc = await SaleVoucher.findByIdAndUpdate(id, payload, { new: true });
        if (!doc) return res.status(404).json({ error: "Sale voucher not found" });
        return res.json({ id: String(doc._id), updated: 1, voucher_no: doc.voucher_no, saved_to: "mongodb" });
      } catch (mongoErr) {
        return res.status(500).json({ error: mongoErr.message });
      }
    })();
  }

  const { voucher_no, date, unloading_date, warehouse_id, buyer_id, company_id, company_account_id, consignee_id, po_no, due_date, against_purchase_enabled, against_purchase_farmer_id, against_purchase_links, lorry_no, product_id, quantity, shortage_quantity, unloading_qty, rate, amount, claim_amount, other_deduction, cd_percent, cd_amount, adjustment_amount, tds_amount, round_off, employee_id, location_id, description } = req.body;
  if (!deductionOnly && !company_account_id) return res.status(400).json({ error: "Account is required for sale voucher" });
  if (!deductionOnly && !product_id) return res.status(400).json({ error: "Product is required for sale voucher" });

  if (deductionOnly) {
    const adjustmentValue = Number(req.body.adjustment_amount) || 0;
    const tdsValue = Number(req.body.tds_amount) || 0;
    const roundOffValue = Number(req.body.round_off) || 0;
    if (!mongoReady()) {
      return res.status(503).json({ error: "MongoDB is not connected. Sale vouchers are MongoDB-primary." });
    }

    const mongoSale = await (mongoose.Types.ObjectId.isValid(id)
      ? SaleVoucher.findById(id).lean()
      : SaleVoucher.findOne({ id: Number(id) }).lean());

    if (!mongoSale) return res.status(404).json({ error: "Sale voucher not found" });

    const rateValue = Number(req.body.rate !== undefined ? req.body.rate : mongoSale.rate) || 0;
    const saleQty = Number(mongoSale.quantity || 0);
    const grossAmount = Number(mongoSale.amount || 0);
    const unloadingQtyValue = Number(req.body.unloading_qty !== undefined ? req.body.unloading_qty : mongoSale.unloading_qty || req.body.quantity || mongoSale.quantity) || 0;
    const shortageQty = Math.max(0, saleQty - unloadingQtyValue);
    const shortageAmount = Number(((Number(req.body.shortage_amount) || shortageQty * rateValue) || 0).toFixed(2));
    const claimValue = req.body.claim_amount !== undefined ? Number(req.body.claim_amount) || 0 : shortageAmount;
    const otherDeductionValue = Number(req.body.other_deduction !== undefined ? req.body.other_deduction : mongoSale.other_deduction) || 0;
    const cdPercentValue = Number(req.body.cd_percent !== undefined ? req.body.cd_percent : mongoSale.cd_percent) || 0;
    const cdAmountValue = Number(req.body.cd_amount !== undefined ? req.body.cd_amount : mongoSale.cd_amount) || 0;
    const totalDeductionValue = Number(req.body.total_deduction) || 0;
    const netAmount = grossAmount - claimValue - otherDeductionValue - cdAmountValue - adjustmentValue - tdsValue + roundOffValue;
    const updateDoc = {
      unloading_date: req.body.unloading_date !== undefined ? req.body.unloading_date : mongoSale.unloading_date,
      shortage_quantity: shortageQty,
      unloading_qty: unloadingQtyValue,
      moisture: Number(req.body.moisture) || 0,
      dunki: Number(req.body.dunki) || 0,
      fungus: Number(req.body.fungus) || 0,
      discolour: Number(req.body.discolour) || 0,
      others: Number(req.body.others) || 0,
      total_deduction: totalDeductionValue,
      claim_amount: claimValue,
      other_deduction: otherDeductionValue,
      cd_percent: cdPercentValue,
      cd_amount: cdAmountValue,
      adjustment_amount: adjustmentValue,
      tds_amount: tdsValue,
      round_off: roundOffValue,
      net_amount: netAmount,
      net_receivable_amount: netAmount,
      net_amount_payable: netAmount,
      outstanding: netAmount,
      updated_at: new Date(),
    };

    try {
      const updated = await SaleVoucher.findOneAndUpdate(
        mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { id: Number(id) },
        { $set: updateDoc },
        { new: true }
      ).lean();
      const journals = await recreateSaleDeductionJournals({
        sale: mongoSale,
        body: req.body,
        shortageAmount,
        deductionAmount: otherDeductionValue + adjustmentValue,
        cdAmount: cdAmountValue,
        tdsAmount: tdsValue,
      });
      return res.json({ id, updated: 1, voucher_no: updated?.voucher_no || mongoSale.voucher_no, deduction_only: true, net_amount: netAmount, net_receivable_amount: netAmount, outstanding: netAmount, shortage_quantity: shortageQty, shortage_amount: shortageAmount, journals });
    } catch (updateErr) {
      return res.status(500).json({ error: updateErr.message });
    }
  }

  const amountValue = Number(amount) || 0;
  const claimValue = Number(claim_amount) || 0;
  const otherDeductionValue = Number(other_deduction) || 0;
  const transportChargeValue = Number(transport_charge) || 0;
  const cdPercentValue = Number(cd_percent) || 0;
  const cdAmountValue = Number(cd_amount) || 0;
  const adjustmentValue = Number(adjustment_amount) || 0;
  const tdsValue = Number(tds_amount) || 0;
  const roundOffValue = Number(round_off) || 0;
  const netAmount = amountValue - claimValue - otherDeductionValue - transportChargeValue - cdAmountValue - adjustmentValue - tdsValue + roundOffValue;
  const netReceivableValue = netAmount;

  if (!deductionOnly) {
    if (!mongoReady()) {
      return res.status(503).json({ error: "MongoDB is not connected. Sale vouchers are MongoDB-primary." });
    }

    const saleQtyValue = Number(unloading_qty) || Number(quantity) || 0;
    try {
      const current = mongoose.Types.ObjectId.isValid(id)
        ? await SaleVoucher.findById(id).lean()
        : await SaleVoucher.findOne({ id: Number(id) }).lean();
      if (!current) return res.status(404).json({ error: "Sale voucher not found" });
      const availableQty = await getAvailableSaleStock({
        warehouseId: warehouse_id,
        productId: product_id,
        excludeSaleId: id,
      });
      if (saleQtyValue > availableQty + 0.0001) {
        return res.status(400).json({ error: `Negative stock not allowed. Available stock: ${availableQty.toFixed(4)}` });
      }

      const updateDoc = {
        voucher_no,
        date,
        unloading_date,
        warehouse_id,
        buyer_id: buyer_id || company_id,
        company_id: company_id || buyer_id,
        company_account_id,
        consignee_id,
        po_no: po_no || "",
        due_date: due_date || "",
        against_purchase_enabled: against_purchase_enabled ? 1 : 0,
        against_purchase_farmer_id: against_purchase_farmer_id || "",
        against_purchase_links: JSON.stringify(Array.isArray(against_purchase_links) ? against_purchase_links : []),
        lorry_no: lorry_no || req.body.reference_id || "",
        product_id,
        quantity,
        shortage_quantity,
        unloading_qty,
        rate,
        amount: amountValue,
        claim_amount: claimValue,
        other_deduction: otherDeductionValue,
        transport_charge: transportChargeValue,
        cd_percent: cdPercentValue,
        cd_amount: cdAmountValue,
        adjustment_amount: adjustmentValue,
        tds_amount: tdsValue,
        round_off: roundOffValue,
        net_amount: netAmount,
        net_receivable_amount: netReceivableValue,
        net_amount_payable: netAmount,
        fifo_rate: fifoRateValue,
        fifo_amount: fifoAmountValue,
        outstanding: netAmount,
        employee_id,
        location_id,
        description,
        updated_at: new Date(),
      };

      const doc = await SaleVoucher.findOneAndUpdate(
        mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { id: Number(id) },
        { $set: updateDoc },
        { new: true }
      ).lean();
      if (!doc) return res.status(404).json({ error: "Sale voucher not found" });
      return res.json({ id, updated: 1, net_amount: netAmount, net_receivable_amount: netReceivableValue, outstanding: netAmount });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

});

router.delete("/sale/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.sale.delete")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;

  if (!mongoReady()) {
    return res.status(503).json({ error: "MongoDB is not connected. Sale vouchers are MongoDB-primary." });
  }

  return (async () => {
    try {
      const doc = mongoose.Types.ObjectId.isValid(id)
        ? await SaleVoucher.findById(id).lean()
        : await SaleVoucher.findOne({ id: Number(id) }).lean();
      if (!doc) return res.status(404).json({ error: "Sale voucher not found" });
      if (!ensureWarehouseAccess(req, res, doc.warehouse_id)) return;
      await SaleVoucher.deleteOne(mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { id: Number(id) });
      return res.json({ deleted: 1, deleted_from: "mongodb" });
    } catch (mongoErr) {
      return res.status(500).json({ error: mongoErr.message });
    }
  })();
});

// ===========================
// PAYMENT VOUCHERS
// ===========================
router.get("/payment", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  if (!mongoReady() || !MongoPaymentVoucher) {
    return res.status(503).json({
      error: "MongoDB is not connected. Payment vouchers are MongoDB-primary.",
    });
  }

  try {
    const rows = await getMongoPaymentRowsForUser(req);
    return res.json(rows);
  } catch (err) {
    console.error("Mongo payment list error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/payment/:id", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  if (!mongoReady() || (!MongoPaymentVoucher && !PaymentVoucherNative)) {
    return res.status(503).json({
      error: "MongoDB is not connected. Payment vouchers are MongoDB-primary.",
    });
  }

  try {
    const numericId = Number(id);
    if (!Number.isFinite(numericId)) {
      return res.status(400).json({ error: "Invalid payment voucher ID" });
    }

    const legacyRow = MongoPaymentVoucher
      ? await MongoPaymentVoucher.findOne({ id: numericId }).lean()
      : null;
    const nativeRow = !legacyRow && PaymentVoucherNative
      ? await PaymentVoucherNative.findOne({ id: numericId }).lean()
      : null;
    const mongoRow = legacyRow || nativeRow;
    if (!mongoRow) {
      return res.status(404).json({ error: "Payment voucher not found" });
    }

    if (!ensureWarehouseAccess(req, res, mongoRow.warehouse_id)) return;

    const adjustmentModel = legacyRow ? MongoPaymentAdjustment : PaymentAdjustmentNative;
    const adjustments = adjustmentModel
      ? await adjustmentModel.find({ payment_id: numericId }).sort({ id: 1 }).lean()
      : [];

    const purchaseIds = [
      ...new Set((adjustments || []).map((row) => String(row.purchase_id || "")).filter(Boolean)),
    ];

    const purchaseMap = new Map();
    if (purchaseIds.length && PurchaseVoucher) {
      const mongoRows = await PurchaseVoucher.find({
        $or: [
          { _id: { $in: purchaseIds.filter((value) => mongoose.Types.ObjectId.isValid(value)) } },
          { id: { $in: purchaseIds.map((value) => Number(value)).filter(Number.isFinite) } },
        ],
      }).select("_id id voucher_no").lean();
      (mongoRows || []).forEach((purchase) => {
        purchaseMap.set(String(purchase._id || purchase.id), purchase.voucher_no || "");
        if (purchase.id !== undefined && purchase.id !== null) {
          purchaseMap.set(String(purchase.id), purchase.voucher_no || "");
        }
      });
    }

    const normalizedAdjustments = (adjustments || []).map((item) => ({
      purchase_id: String(item.purchase_id || ""),
      voucher_no: item.voucher_no || purchaseMap.get(String(item.purchase_id || "")) || "",
      adjusted_amount: Number(item.adjusted_amount || 0),
    }));

    return res.json({
      ...mongoRow,
      id: String(mongoRow.id),
      _id: String(mongoRow.id),
      adjustments: normalizedAdjustments,
    });
  } catch (mongoErr) {
    console.error("Mongo payment detail error:", mongoErr.message);
    return res.status(500).json({ error: mongoErr.message });
  }
});

router.post("/payment", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.create")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  if (!mongoReady() || !PaymentVoucherNative) {
    return res.status(503).json({
      error: "MongoDB is not connected. Payment vouchers must be saved in MongoDB.",
    });
  }

  const {
    voucher_no,
    date,
    warehouse_id,
    farmer_id,
    company_account_id,
    amount,
    reference_type,
    reference_id,
    payment_mode,
    employee_id,
    location_id,
    description,
    adjustments,
  } = req.body;

  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  if (!farmer_id) {
    return res.status(400).json({
      error: "Farmer is required for payment vouchers",
    });
  }

  try {
    const finalPaymentMode = normalizePaymentMode(
      payment_mode ||
        (Array.isArray(adjustments) && adjustments.length > 0
          ? "against"
          : "on_account")
    );

    const cleanAdjustments = await new Promise((resolve, reject) => {
      validatePaymentAdjustments(
        {
          farmerId: farmer_id,
          warehouseId: warehouse_id,
          amount,
          adjustments,
          paymentMode: finalPaymentMode,
        },
        (err, value) => {
          if (err) return reject(err);
          resolve(value || []);
        }
      );
    });

    const generatedVoucherNo = await new Promise((resolve, reject) => {
      createVoucherNoIfMissing(
        "payment",
        voucher_no,
        (err, value) => {
          if (err) return reject(err);
          resolve(value);
        }
      );
    });

    const duplicateVoucher =
      await PaymentVoucherNative.findOne({
        voucher_no: generatedVoucherNo,
      }).lean();

    if (duplicateVoucher) {
      return res.status(400).json({
        error: "Voucher number already exists",
      });
    }

    const lastPayment =
      await PaymentVoucherNative.findOne({})
        .sort({ id: -1 })
        .select("id")
        .lean();

    const paymentId =
      Number(lastPayment?.id || 0) + 1;

    const finalReferenceType =
      reference_type ||
      (cleanAdjustments.length
        ? "purchase"
        : "on_account");

    const finalReferenceId =
      reference_id ||
      buildPaymentReferenceId(cleanAdjustments);

    const paymentDoc = {
      id: paymentId,
      voucher_no: generatedVoucherNo,
      date:
        date ||
        new Date().toISOString().slice(0, 10),
      warehouse_id: String(warehouse_id || ""),
      farmer_id: String(farmer_id || ""),
      company_account_id: String(
        company_account_id || ""
      ),
      amount: Number(amount || 0),
      reference_type: finalReferenceType,
      reference_id: finalReferenceId,
      payment_mode: finalPaymentMode,
      employee_id: String(employee_id || ""),
      location_id: String(location_id || ""),
      description: String(description || ""),
      outstanding_after: 0,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const payment =
      await PaymentVoucherNative.create(paymentDoc);

    let createdAdjustments = [];

    if (
      PaymentAdjustmentNative &&
      cleanAdjustments.length > 0
    ) {
      const lastAdjustment =
        await PaymentAdjustmentNative.findOne({})
          .sort({ id: -1 })
          .select("id")
          .lean();

      let nextAdjustmentId =
        Number(lastAdjustment?.id || 0) + 1;

      const adjustmentDocs =
        cleanAdjustments.map((item) => ({
          id: nextAdjustmentId++,
          payment_id: paymentId,
          purchase_id: String(
            item.purchase_id || ""
          ),
          adjusted_amount: Number(
            item.adjusted_amount || 0
          ),
          voucher_no:
            item.voucher_no ||
            item.purchase_voucher_no ||
            "",
          created_at: new Date(),
          updated_at: new Date(),
        }));

      if (adjustmentDocs.length > 0) {
        createdAdjustments =
          await PaymentAdjustmentNative.insertMany(
            adjustmentDocs
          );
      }
    }

    let stats = {
      total_purchase: 0,
      total_payment: 0,
      outstanding: 0,
    };

    try {
      stats = await new Promise((resolve, reject) => {
        computeOutstandingForFarmer(
          farmer_id,
          (err, value) => {
            if (err) return reject(err);
            resolve(value || stats);
          },
          company_account_id || null
        );
      });
    } catch (outstandingErr) {
      console.error(
        "Payment outstanding calculation warning:",
        outstandingErr.message
      );
    }

    await PaymentVoucherNative.updateOne(
      { id: paymentId },
      {
        $set: {
          outstanding_after: Number(
            stats?.outstanding || 0
          ),
          updated_at: new Date(),
        },
      }
    );

    return res.json({
      id: String(paymentId),
      voucher_no: generatedVoucherNo,
      stats,
      adjustments: createdAdjustments.map((row) => ({
        id: String(row.id),
        payment_id: String(row.payment_id),
        purchase_id: String(row.purchase_id || ""),
        adjusted_amount: Number(
          row.adjusted_amount || 0
        ),
        voucher_no: row.voucher_no || "",
      })),
      saved_to: "mongodb_native",
      message: "Payment voucher created successfully",
    });
  } catch (err) {
    console.error(
      "Mongo native payment create error:",
      err
    );

    if (err?.code === 11000) {
      return res.status(400).json({
        error:
          "Voucher number or payment ID already exists",
      });
    }

    return res.status(500).json({
      error: err.message,
    });
  }
});
router.put("/payment/:id", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.edit")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  if (!mongoReady()) {
    return res.status(503).json({
      error: "MongoDB is not connected. Payment vouchers are MongoDB-primary.",
    });
  }

  const id = String(req.params.id || "").trim();
  const numericId = Number(id);

  if (!Number.isFinite(numericId)) {
    return res.status(400).json({ error: "Invalid payment voucher ID" });
  }

  const {
    voucher_no,
    date,
    warehouse_id,
    farmer_id,
    company_account_id,
    amount,
    reference_type,
    reference_id,
    payment_mode,
    employee_id,
    location_id,
    description,
    adjustments,
  } = req.body;

  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  if (!farmer_id) {
    return res.status(400).json({
      error: "Farmer is required for payment vouchers",
    });
  }

  try {
    const legacyExisting = MongoPaymentVoucher
      ? await MongoPaymentVoucher.findOne({ id: numericId }).lean()
      : null;
    const nativeExisting = PaymentVoucherNative
      ? await PaymentVoucherNative.findOne({ id: numericId }).lean()
      : null;
    const existing = legacyExisting || nativeExisting;

    if (!existing) {
      return res.status(404).json({
        error: "Payment voucher not found",
      });
    }

    if (!ensureWarehouseAccess(req, res, existing.warehouse_id)) {
      return;
    }

    const finalPaymentMode = normalizePaymentMode(
      payment_mode ||
        (Array.isArray(adjustments) && adjustments.length
          ? "against"
          : "on_account")
    );

    const cleanAdjustments = normalizePaymentAdjustments(adjustments);

    const paymentAmount = Number(amount || 0);
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({
        error: "Payment amount is required",
      });
    }

    const adjustedTotal = cleanAdjustments.reduce(
      (sum, item) => sum + Number(item.adjusted_amount || 0),
      0
    );

    if (finalPaymentMode === "against") {
      if (!cleanAdjustments.length) {
        return res.status(400).json({
          error: "Please adjust this payment against purchase bills",
        });
      }

      if (Math.abs(adjustedTotal - paymentAmount) > 0.0001) {
        return res.status(400).json({
          error: "Payment amount and adjustment amount must be equal",
        });
      }
    }

    const finalReferenceType =
      reference_type ||
      (cleanAdjustments.length ? "purchase" : "on_account");

    const finalReferenceId =
      reference_id ||
      buildPaymentReferenceId(cleanAdjustments);

    const updateDoc = {
      voucher_no: String(voucher_no || ""),
      date:
        String(date || "").trim() ||
        new Date().toISOString().slice(0, 10),
      warehouse_id: String(warehouse_id || ""),
      farmer_id: String(farmer_id || ""),
      company_account_id: String(company_account_id || ""),
      amount: paymentAmount,
      reference_type: finalReferenceType,
      reference_id: finalReferenceId,
      payment_mode: finalPaymentMode,
      employee_id: String(employee_id || ""),
      location_id: String(location_id || ""),
      description: String(description || ""),
      updated_at: new Date(),
    };

    if (updateDoc.voucher_no) {
      const duplicateLegacy = MongoPaymentVoucher
        ? await MongoPaymentVoucher.findOne({
            voucher_no: updateDoc.voucher_no,
            id: { $ne: numericId },
          }).lean()
        : null;

      const duplicateNative = PaymentVoucherNative
        ? await PaymentVoucherNative.findOne({
            voucher_no: updateDoc.voucher_no,
            id: { $ne: numericId },
          }).lean()
        : null;

      if (duplicateLegacy || duplicateNative) {
        return res.status(400).json({
          error: "Voucher number already exists",
        });
      }
    }

    let saved;
    let savedTo = "mongodb";

    if (legacyExisting && MongoPaymentVoucher) {
      saved = await MongoPaymentVoucher.findOneAndUpdate(
        { id: numericId },
        { $set: updateDoc },
        { new: true, runValidators: true }
      ).lean();

      if (MongoPaymentAdjustment) {
        await MongoPaymentAdjustment.deleteMany({
          payment_id: numericId,
        });

        if (cleanAdjustments.length) {
          const last = await MongoPaymentAdjustment
            .findOne({})
            .sort({ id: -1 })
            .select("id")
            .lean();

          let nextId = Number(last?.id || 0) + 1;

          await MongoPaymentAdjustment.insertMany(
            cleanAdjustments.map((item) => ({
              id: nextId++,
              payment_id: numericId,
              purchase_id: String(item.purchase_id || ""),
              adjusted_amount: Number(item.adjusted_amount || 0),
              voucher_no:
                item.voucher_no ||
                item.purchase_voucher_no ||
                "",
              created_at: new Date(),
              updated_at: new Date(),
            }))
          );
        }
      }
    } else if (nativeExisting && PaymentVoucherNative) {
      saved = await PaymentVoucherNative.findOneAndUpdate(
        { id: numericId },
        { $set: updateDoc },
        { new: true, runValidators: true }
      ).lean();

      savedTo = "mongodb_native";

      if (PaymentAdjustmentNative) {
        await PaymentAdjustmentNative.deleteMany({
          payment_id: numericId,
        });

        if (cleanAdjustments.length) {
          const last = await PaymentAdjustmentNative
            .findOne({})
            .sort({ id: -1 })
            .select("id")
            .lean();

          let nextId = Number(last?.id || 0) + 1;

          await PaymentAdjustmentNative.insertMany(
            cleanAdjustments.map((item) => ({
              id: nextId++,
              payment_id: numericId,
              purchase_id: String(item.purchase_id || ""),
              adjusted_amount: Number(item.adjusted_amount || 0),
              voucher_no:
                item.voucher_no ||
                item.purchase_voucher_no ||
                "",
              created_at: new Date(),
              updated_at: new Date(),
            }))
          );
        }
      }
    }

    if (!saved) {
      return res.status(404).json({
        error: "Payment voucher not found",
      });
    }

    return res.json({
      id: String(numericId),
      updated: 1,
      voucher_no: saved.voucher_no,
      stats: null,
      adjustments: cleanAdjustments,
      reference_id: finalReferenceId,
      saved_to: savedTo,
    });
  } catch (err) {
    console.error("Mongo payment edit error:", err);

    if (err?.code === 11000) {
      return res.status(400).json({
        error: "Voucher number already exists",
      });
    }

    return res.status(500).json({
      error: err.message,
    });
  }
});

router.delete("/payment/:id", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.delete")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  if (!mongoReady()) {
    return res.status(503).json({
      error: "MongoDB is not connected. Payment vouchers are MongoDB-primary.",
    });
  }

  const id = String(req.params.id || "").trim();
  const numericId = Number(id);

  if (!Number.isFinite(numericId)) {
    return res.status(400).json({ error: "Invalid payment voucher ID" });
  }

  try {
    const legacyExisting = MongoPaymentVoucher
      ? await MongoPaymentVoucher.findOne({ id: numericId }).lean()
      : null;

    const nativeExisting = PaymentVoucherNative
      ? await PaymentVoucherNative.findOne({ id: numericId }).lean()
      : null;

    const existing = legacyExisting || nativeExisting;

    if (!existing) {
      return res.status(404).json({ error: "Payment voucher not found" });
    }

    if (!ensureWarehouseAccess(req, res, existing.warehouse_id)) return;

    if (legacyExisting && MongoPaymentVoucher) {
      if (MongoPaymentAdjustment) {
        await MongoPaymentAdjustment.deleteMany({
          payment_id: numericId,
        });
      }

      await MongoPaymentVoucher.deleteOne({
        id: numericId,
      });
    } else if (nativeExisting && PaymentVoucherNative) {
      if (PaymentAdjustmentNative) {
        await PaymentAdjustmentNative.deleteMany({
          payment_id: numericId,
        });
      }

      await PaymentVoucherNative.deleteOne({
        id: numericId,
      });
    }

    const stats = await new Promise((resolve, reject) => {
      computeOutstandingForFarmer(
        existing.farmer_id,
        (err, value) => {
          if (err) return reject(err);
          resolve(value || {
            total_purchase: 0,
            total_payment: 0,
            outstanding: 0,
          });
        },
        existing.company_account_id || null
      );
    });

    return res.json({
      deleted: 1,
      id: String(numericId),
      stats,
      saved_to: legacyExisting ? "mongodb" : "mongodb_native",
    });
  } catch (err) {
    console.error("Mongo payment delete error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ===========================
// RECEIPT VOUCHERS
// ===========================
async function getMongoReceiptRowsForUser(req) {
  if (!mongoReady()) return [];

  const scopeIds =
    assignedWarehouseIdsForMongo(req.user);

  const isAdmin =
    req.user?.role === "admin" ||
    userHasPermission(
      req.user,
      "warehouses.manage"
    );

  const rawRows =
    await mongoose.connection.db
      .collection("receiptvouchers")
      .find({})
      .sort({
        "data.date": -1,
        legacy_id: -1,
        _id: -1,
      })
      .toArray();

  const {
    warehouseMap,
    accountMap,
    companyMap,
  } = await getVoucherDisplayMaps();

  const rows = rawRows
    .map(normalizeMongoMirrorVoucher)
    .filter((row) => {
      if (isAdmin) return true;

      if (!scopeIds.length) return false;

      return scopeIds
        .map(String)
        .includes(
          String(row.warehouse_id ?? "")
        );
    })
    .map((row) => {
      const warehouse =
        warehouseMap.get(
          String(row.warehouse_id)
        ) || {};

      const account =
        accountMap.get(
          String(row.company_account_id)
        ) || {};

      const company =
        companyMap.get(
          String(row.company_id)
        ) || {};

      return {
        ...row,

        warehouse_name:
          row.warehouse_name ||
          warehouse.name ||
          "",

        company_account_name:
          row.company_account_name ||
          account.account_name ||
          account.name ||
          "",

        account_name:
          row.account_name ||
          account.account_name ||
          account.name ||
          "",

        company_name:
          row.company_name ||
          company.name ||
          "",
      };
    });

  const receiptIds = rows
    .map((row) => Number(row.id))
    .filter(Number.isFinite);

  const adjustmentRows =
    receiptIds.length &&
    MongoReceiptAdjustment
      ? await MongoReceiptAdjustment.find({
          receipt_id: {
            $in: receiptIds,
          },
        })
          .sort({ id: 1 })
          .lean()
      : [];

  const byReceipt = new Map();

  for (const row of adjustmentRows || []) {
    const key =
      String(row.receipt_id);

    if (!byReceipt.has(key)) {
      byReceipt.set(key, []);
    }

    byReceipt.get(key).push({
      ...row,
      adjusted_amount:
        Number(row.adjusted_amount || 0),
    });
  }

  return rows.map((row) => ({
    ...row,
    adjustments:
      byReceipt.get(
        String(row.id)
      ) || [],
  }));
}

router.get("/receipt", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  if (!mongoReady()) {
    return res.status(503).json({
      error: "MongoDB is not connected. Receipt vouchers are MongoDB-primary.",
    });
  }

  try {
    const rows = await getMongoReceiptRowsForUser(req);
    return res.json(rows);
  } catch (err) {
    console.error("Mongo receipt list error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/receipt/:id", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  if (!mongoReady() || !MongoReceiptVoucher) {
    return res.status(503).json({
      error: "MongoDB is not connected. Receipt vouchers are MongoDB-primary.",
    });
  }

  const numericId = Number(req.params.id);

  if (!Number.isFinite(numericId) || numericId <= 0) {
    return res.status(400).json({
      error: "Invalid receipt voucher ID",
    });
  }

  try {
    const row = await findMongoReceiptById(numericId);

    if (!row) {
      return res.status(404).json({
        error: "Receipt voucher not found",
      });
    }

    if (!ensureWarehouseAccess(req, res, row.warehouse_id)) {
      return;
    }

    const adjustments = await getMongoReceiptAdjustments(numericId);

    return res.json({
      ...row,
      id: String(row.id ?? numericId),
      _id: String(row._id ?? row.id ?? numericId),
      adjustments: Array.isArray(adjustments) ? adjustments : [],
    });
  } catch (err) {
    console.error("Mongo receipt detail error:", err.message);

    return res.status(500).json({
      error: err.message,
    });
  }
});

router.post("/receipt", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.create")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  if (!mongoReady() || !MongoReceiptVoucher || !MongoReceiptAdjustment) {
    return res.status(503).json({
      error: "MongoDB is not connected. Receipt vouchers must be saved in MongoDB.",
    });
  }

  const {
    voucher_no,
    date,
    warehouse_id,
    company_id,
    company_account_id,
    consignee_id,
    amount,
    reference_type,
    reference_id,
    employee_id,
    location_id,
    description,
    adjustments,
  } = req.body;

  try {
    const accessOk = await ensureWarehouseAccessAsync(
      req,
      res,
      warehouse_id,
      location_id
    );

    if (!accessOk) return;

    if (!company_id) {
      return res.status(400).json({
        error: "Company is required for receipt vouchers",
      });
    }

    const cleanAdjustments = await new Promise(
      (resolve, reject) => {
        validateReceiptAdjustments(
          {
            companyId: company_id,
            amount,
            adjustments,
          },
          (err, value) =>
            err ? reject(err) : resolve(value || [])
        );
      }
    );

    const idemKey =
      req.get("Idempotency-Key") ||
      req.headers["idempotency-key"];

    if (idemKey) {
      const existingId =
        await getMongoReceiptIdempotency(idemKey);

      if (existingId !== null) {
        const existing =
          await findMongoReceiptById(existingId);

        if (existing) {
          const existingAdjustments =
            await getMongoReceiptAdjustments(existingId);

          return res.json({
            id: String(existing.id),
            voucher_no: existing.voucher_no,
            existing: {
              ...existing,
              id: String(existing.id),
              _id: String(existing.id),
              adjustments: existingAdjustments,
            },
          });
        }
      }
    }

    const generatedVoucherNo =
      await new Promise((resolve, reject) => {
        createVoucherNoIfMissing(
          "receipt",
          voucher_no,
          (err, value) =>
            err ? reject(err) : resolve(value)
        );
      });

    const duplicate =
      await mongoose.connection.db
        .collection("receiptvouchers")
        .findOne({
          $or: [
            { voucher_no: generatedVoucherNo },
            { "data.voucher_no": generatedVoucherNo },
          ],
        });

    if (duplicate) {
      return res.status(400).json({
        error: "Voucher number already exists",
      });
    }

    const receiptId =
      await getNextMongoReceiptId();

    const finalReferenceType =
      reference_type || "sale";

    const finalReferenceId =
      reference_id ||
      buildReceiptReferenceId(
        cleanAdjustments
      );

    const receiptDoc = await MongoReceiptVoucher.create({
      id: receiptId,
      voucher_no: generatedVoucherNo,
      date: date || "",
      warehouse_id:
        warehouse_id == null
          ? ""
          : String(warehouse_id),
      company_id:
        company_id == null
          ? ""
          : String(company_id),
      company_account_id:
        company_account_id == null
          ? ""
          : String(company_account_id),
      consignee_id:
        consignee_id == null
          ? ""
          : String(consignee_id),
      amount: Number(amount || 0),
      reference_type: finalReferenceType,
      reference_id: finalReferenceId,
      employee_id:
        employee_id == null
          ? ""
          : String(employee_id),
      location_id:
        location_id == null
          ? ""
          : String(location_id),
      description:
        String(description || ""),
      created_at: new Date(),
      updated_at: new Date(),
    });

    const createdAdjustments =
      await saveMongoReceiptAdjustments(
        receiptId,
        cleanAdjustments
      );

    const stats =
      await new Promise((resolve, reject) => {
        computeOutstandingForCompany(
          company_id,
          (err, value) =>
            err ? reject(err) : resolve(value),
          company_account_id || null
        );
      });

    await MongoReceiptVoucher.updateOne(
      { id: receiptId },
      {
        $set: {
          outstanding_after: Number(
            stats?.outstanding || 0
          ),
          updated_at: new Date(),
        },
      }
    );

    if (idemKey) {
      await saveMongoReceiptIdempotency(
        idemKey,
        receiptId
      );
    }

    return res.json({
      id: String(receiptId),
      voucher_no: generatedVoucherNo,
      stats,
      adjustments: createdAdjustments,
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(400).json({
        error: "Voucher number or receipt ID already exists",
      });
    }

    console.error(
      "Mongo receipt create error:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

router.put("/receipt/:id", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.edit")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  if (!mongoReady() || !MongoReceiptVoucher || !MongoReceiptAdjustment) {
    return res.status(503).json({
      error: "MongoDB is not connected. Receipt vouchers must be saved in MongoDB.",
    });
  }

  const id = Number(req.params.id);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({
      error: "Invalid receipt voucher ID",
    });
  }

  const {
    voucher_no,
    date,
    warehouse_id,
    company_id,
    company_account_id,
    consignee_id,
    amount,
    reference_type,
    reference_id,
    employee_id,
    location_id,
    description,
    adjustments,
  } = req.body;

  try {
    const oldRow =
      await findMongoReceiptById(id);

    if (!oldRow) {
      return res.status(404).json({
        error: "Receipt voucher not found",
      });
    }

    const newAccessOk =
      await ensureWarehouseAccessAsync(
        req,
        res,
        warehouse_id,
        location_id
      );

    if (!newAccessOk) return;

    const oldAccessOk =
      await ensureWarehouseAccessAsync(
        req,
        res,
        oldRow.warehouse_id,
        oldRow.location_id
      );

    if (!oldAccessOk) return;

    if (!company_id) {
      return res.status(400).json({
        error: "Company is required for receipt vouchers",
      });
    }

    const cleanAdjustments =
      await new Promise((resolve, reject) => {
        validateReceiptAdjustments(
          {
            companyId: company_id,
            amount,
            adjustments,
            excludeReceiptId: id,
          },
          (err, value) =>
            err ? reject(err) : resolve(value || [])
        );
      });

    const finalReferenceType =
      reference_type || "sale";

    const finalReferenceId =
      reference_id ||
      buildReceiptReferenceId(
        cleanAdjustments
      );

    if (voucher_no) {
      const duplicate =
        await mongoose.connection.db
          .collection("receiptvouchers")
          .findOne({
            $or: [
              {
                voucher_no: voucher_no,
                id: { $ne: id },
              },
              {
                "data.voucher_no": voucher_no,
                "data.id": { $ne: id },
              },
            ],
          });

      if (duplicate) {
        return res.status(400).json({
          error: "Voucher number already exists",
        });
      }
    }

    const saved =
      await MongoReceiptVoucher.findOneAndUpdate(
        { id },
        {
          $set: {
            voucher_no:
              voucher_no || oldRow.voucher_no || "",
            date: date || "",
            warehouse_id:
              warehouse_id == null
                ? ""
                : String(warehouse_id),
            company_id:
              company_id == null
                ? ""
                : String(company_id),
            company_account_id:
              company_account_id == null
                ? ""
                : String(company_account_id),
            consignee_id:
              consignee_id == null
                ? ""
                : String(consignee_id),
            amount: Number(amount || 0),
            reference_type: finalReferenceType,
            reference_id: finalReferenceId,
            employee_id:
              employee_id == null
                ? ""
                : String(employee_id),
            location_id:
              location_id == null
                ? ""
                : String(location_id),
            description:
              String(description || ""),
            updated_at: new Date(),
          },
        },
        {
          new: true,
          runValidators: true,
        }
      ).lean();

    if (!saved) {
      return res.status(404).json({
        error: "Receipt voucher not found",
      });
    }

    await saveMongoReceiptAdjustments(
      id,
      cleanAdjustments
    );

    const stats =
      await new Promise((resolve, reject) => {
        computeOutstandingForCompany(
          company_id,
          (err, value) =>
            err ? reject(err) : resolve(value),
          company_account_id || null
        );
      });

    await MongoReceiptVoucher.updateOne(
      { id },
      {
        $set: {
          outstanding_after: Number(
            stats?.outstanding || 0
          ),
          updated_at: new Date(),
        },
      }
    );

    return res.json({
      id: String(id),
      updated: 1,
      voucher_no:
        voucher_no || saved.voucher_no,
      stats,
      adjustments: cleanAdjustments,
      reference_id: finalReferenceId,
      saved_to: "mongodb",
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(400).json({
        error: "Voucher number already exists",
      });
    }

    console.error(
      "Mongo receipt edit error:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

router.delete("/receipt/:id", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.delete")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  if (!mongoReady() || !MongoReceiptVoucher || !MongoReceiptAdjustment) {
    return res.status(503).json({
      error: "MongoDB is not connected. Receipt vouchers must be saved in MongoDB.",
    });
  }

  const id = Number(req.params.id);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({
      error: "Invalid receipt voucher ID",
    });
  }

  try {
    const row =
      await findMongoReceiptById(id);

    if (!row) {
      return res.status(404).json({
        error: "Receipt voucher not found",
      });
    }

    const accessOk =
      await ensureWarehouseAccessAsync(
        req,
        res,
        row.warehouse_id,
        row.location_id
      );

    if (!accessOk) return;

    await mongoose.connection.db
      .collection("receiptadjustments")
      .deleteMany({
        $or: [
          { receipt_id: id },
          { "data.receipt_id": id },
        ],
      });

    const result =
      await MongoReceiptVoucher.deleteOne({
        id,
      });

    if (!result.deletedCount) {
      return res.status(404).json({
        error: "Receipt voucher not found",
      });
    }

    const stats =
      await new Promise((resolve, reject) => {
        computeOutstandingForCompany(
          row.company_id,
          (err, value) =>
            err ? reject(err) : resolve(value),
          row.company_account_id || null
        );
      });

    return res.json({
      deleted: 1,
      id: String(id),
      stats,
      deleted_from: "mongodb",
    });
  } catch (err) {
    console.error(
      "Mongo receipt delete error:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

// ===========================
// JOURNAL VOUCHERS
// ===========================
router.get("/journal", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.journal.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  if (!mongoReady()) {
    return res.status(503).json({
      error: "MongoDB is not connected. Journal vouchers are MongoDB-primary.",
    });
  }

  try {
    const isAdmin =
      req.user?.role === "admin" ||
      userHasPermission(req.user, "warehouses.manage");

    const scopeIds = assignedWarehouseIdsForMongo(req.user);

    const rawRows = await mongoose.connection.db
      .collection("wh_journal_vouchers")
      .find({})
      .sort({ "data.date": -1, legacy_id: -1, _id: -1 })
      .toArray();

    const rows = rawRows
      .filter((doc) => {
        const data =
          doc?.data && typeof doc.data === "object"
            ? doc.data
            : doc;

        if (isAdmin) return true;

        if (!scopeIds.length) return false;

        return scopeIds.map(String).includes(
          String(data?.warehouse_id ?? "")
        );
      })
      .map((doc) => {
        const data =
          doc?.data && typeof doc.data === "object"
            ? doc.data
            : doc;

        const id =
          data?.id ??
          doc?.legacy_id ??
          String(doc?._id ?? "");

        return {
          ...data,
          id: String(id),
          _id: String(doc?._id ?? id),
          legacy_id: doc?.legacy_id ?? data?.id,
        };
      });

    return res.json(rows);
  } catch (err) {
    console.error("Mongo journal list error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/journal", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.journal.create")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  if (!mongoReady() || !MongoJournalVoucher) {
    return res.status(503).json({
      error: "MongoDB is not connected. Journal vouchers must be saved in MongoDB.",
    });
  }

  const {
    voucher_no,
    date,
    warehouse_id,
    company_account_id,
    debit_account,
    credit_account,
    amount,
    employee_id,
    location_id,
    description,
  } = req.body;

  try {
    const accessOk = await ensureWarehouseAccessAsync(
      req,
      res,
      warehouse_id,
      location_id
    );

    if (!accessOk) return;

    const idemKey =
      req.get("Idempotency-Key") ||
      req.headers["idempotency-key"];

    if (idemKey) {
      const existing =
        await mongoose.connection.db
          .collection("voucheridempotency")
          .findOne({
            key: String(idemKey),
            route: "journal",
          });

      if (existing?.response_id != null) {
        const existingJournal =
          await MongoJournalVoucher
            .findOne({ id: Number(existing.response_id) })
            .lean()
            .catch(() => null);

        if (existingJournal) {
          return res.json({
            ...existingJournal,
            id: String(existingJournal.id),
            _id: String(existingJournal.id),
            existing: true,
          });
        }
      }
    }

    const generatedVoucherNo =
      await new Promise((resolve, reject) => {
        createVoucherNoIfMissing(
          "journal",
          voucher_no,
          (err, value) =>
            err ? reject(err) : resolve(value)
        );
      });

    const duplicate =
      await mongoose.connection.db
        .collection("wh_journal_vouchers")
        .findOne({
          $or: [
            {
              voucher_no: generatedVoucherNo,
            },
            {
              "data.voucher_no": generatedVoucherNo,
            },
          ],
        });

    if (duplicate) {
      return res.status(400).json({
        error: "Voucher number already exists",
      });
    }

    const last =
      await MongoJournalVoucher
        .findOne({})
        .sort({ id: -1 })
        .select("id")
        .lean();

    const journalId =
      Number(last?.id || 0) + 1;

    const journalDoc =
      await MongoJournalVoucher.create({
        id: journalId,
        voucher_no: generatedVoucherNo,
        date: date || "",
        warehouse_id:
          warehouse_id == null
            ? ""
            : String(warehouse_id),
        company_account_id:
          company_account_id == null
            ? ""
            : String(company_account_id),
        debit_account:
          String(debit_account || ""),
        credit_account:
          String(credit_account || ""),
        amount: Number(amount || 0),
        employee_id:
          employee_id == null
            ? ""
            : String(employee_id),
        location_id:
          location_id == null
            ? ""
            : String(location_id),
        description:
          String(description || ""),
        created_at: new Date(),
        updated_at: new Date(),
      });

    if (idemKey) {
      await mongoose.connection.db
        .collection("voucheridempotency")
        .updateOne(
          {
            key: String(idemKey),
            route: "journal",
          },
          {
            $set: {
              key: String(idemKey),
              route: "journal",
              response_id: journalId,
              updated_at: new Date(),
            },
            $setOnInsert: {
              created_at: new Date(),
            },
          },
          { upsert: true }
        );
    }

    return res.json({
      id: String(journalId),
      voucher_no: generatedVoucherNo,
      saved_to: "mongodb",
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(400).json({
        error: "Voucher number or journal ID already exists",
      });
    }

    console.error(
      "Mongo journal create error:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

async function getPurchaseReportRowsForUser(user, options = {}) {
  if (mongoReady()) {
    const filter = { ...mongoPurchaseScope(user) };
    addMixedIdFilter(filter, "farmer_id", options.farmerId);
    addMixedIdFilter(filter, "warehouse_id", options.warehouseId);
    addMixedIdFilter(filter, "company_account_id", options.companyAccountId);
    addMixedIdFilter(filter, "product_id", options.productId);
    addVoucherSearchFilter(filter, options.search, [
      "voucher_no",
      "farmer_name",
      "product_name",
      "warehouse_name",
      "company_account_name",
      "description",
    ]);
    if (options.fromDate || options.toDate) {
      filter.date = {};
      if (options.fromDate) filter.date.$gte = String(options.fromDate);
      if (options.toDate) filter.date.$lte = String(options.toDate);
    }
    const query = PurchaseVoucher.find(filter).sort({ date: -1, createdAt: -1, _id: -1 }).lean();
    if (Number.isFinite(Number(options.limit))) {
      query.skip(Number(options.offset) || 0).limit(Number(options.limit));
    }
    const rows = await query;
    return decoratePurchaseRows(rows);
  }
  throw new Error("MongoDB is required for purchase reports");
}

async function getSaleReportRowsForUser(user, options = {}) {
  if (mongoReady()) {
    const filter = {};
    const scope = mongoSaleScope(user);
    Object.assign(filter, scope);
    if (options.buyerId) {
      filter.$or = [
        { buyer_id: String(options.buyerId) },
        { company_id: String(options.buyerId) },
      ];
    }
    if (options.farmerId) filter.farmer_id = String(options.farmerId);
    if (options.warehouseId) filter.warehouse_id = String(options.warehouseId);
    if (options.companyAccountId) filter.company_account_id = String(options.companyAccountId);
    if (options.productId) filter.product_id = String(options.productId);
    if (options.fromDate || options.toDate) {
      filter.date = {};
      if (options.fromDate) filter.date.$gte = String(options.fromDate);
      if (options.toDate) filter.date.$lte = String(options.toDate);
    }
    if (options.journeyToken) filter.journey_token = String(options.journeyToken);
    if (options.lorryNo) filter.lorry_no = String(options.lorryNo);
    if (options.billNo) filter.$or = [...(filter.$or || []), { voucher_no: String(options.billNo) }, { bill_no: String(options.billNo) }];
    const query = SaleVoucher.find(filter).sort({ date: -1, createdAt: -1, _id: -1 }).lean();
    if (Number.isFinite(Number(options.limit))) {
      query.skip(Number(options.offset) || 0).limit(Number(options.limit));
    }
    const rows = await query;
    try {
      return await decorateSaleRows(rows);
    } catch (decorateErr) {
      console.error("Sale report decoration failed; returning raw Mongo rows:", decorateErr);
      return (rows || []).map((row) => ({
        ...(row || {}),
        id: String(row?._id || row?.id || ""),
        _id: String(row?._id || row?.id || ""),
        buyer_id: String(row?.buyer_id || row?.company_id || ""),
        total_quantity: Number(row?.quantity || row?.total_quantity || 0),
        total_amount: Number(row?.amount || row?.total_amount || 0),
        ...calculateSaleFollowupMeta(row || {}),
      }));
    }
  }
  throw new Error("MongoDB is required for sale reports");
}

async function enrichLedgerRowsWithPartyDetails(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!mongoReady() || !list.length) return list;

  const farmerIds = [...new Set(list.map((row) => String(row?.farmer_id || "")).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  const accountIds = [...new Set(list.map((row) => String(row?.company_account_id || "")).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  const [farmers, accounts] = await Promise.all([
    farmerIds.length ? Farmer.find({ _id: { $in: farmerIds } }).lean() : [],
    accountIds.length ? CompanyAccount.find({ _id: { $in: accountIds } }).lean() : [],
  ]);
  const farmerMap = new Map(farmers.map((item) => [String(item._id), item]));
  const accountMap = new Map(accounts.map((item) => [String(item._id), item]));

  return list.map((row) => {
    const farmer = farmerMap.get(String(row?.farmer_id || ""));
    const account = accountMap.get(String(row?.company_account_id || ""));
    return {
      ...row,
      farmer_name: row?.farmer_name || farmer?.name,
      farmer_mobile: row?.farmer_mobile || farmer?.mobile,
      farmer_address: row?.farmer_address || farmer?.address,
      farmer_village: row?.farmer_village || farmer?.village,
      farmer_city: row?.farmer_city || farmer?.city,
      farmer_district: row?.farmer_district || farmer?.district,
      farmer_state: row?.farmer_state || farmer?.state,
      farmer_pincode: row?.farmer_pincode || farmer?.pincode,
      farmer_gst: row?.farmer_gst || farmer?.gst_no || farmer?.gst,
      farmer_pan: row?.farmer_pan || farmer?.pan_no || farmer?.pan,
      company_account_name: row?.company_account_name || account?.account_name,
      company_account_address: row?.company_account_address || account?.address,
      company_account_mobile: row?.company_account_mobile || account?.mobile,
      company_account_email: row?.company_account_email || account?.email,
      company_account_city: row?.company_account_city || account?.city,
      company_account_district: row?.company_account_district || account?.district,
      company_account_state: row?.company_account_state || account?.state,
      company_account_pincode: row?.company_account_pincode || account?.pincode,
      company_account_gst: row?.company_account_gst || account?.gst_no || account?.gst,
      company_account_pan: row?.company_account_pan || account?.pan_no || account?.pan,
    };
  });
}

function buildLedgerRows(rows, getPartyId, getPartyName) {
  const balances = new Map();
  return rows
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
    .map((row) => {
      const key = getPartyId(row) || "unknown";
      const previous = balances.get(key) || 0;
      const debit = Number(row.debit || 0);
      const credit = Number(row.credit || 0);
      const balance = previous + debit - credit;
      balances.set(key, balance);
      return {
        ...row,
        party_id: key,
        party_name: getPartyName(row),
        debit,
        credit,
        balance: Number(balance.toFixed(2)),
      };
    })
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

function groupStock(purchases, sales) {
  const groups = new Map();
  const keyOf = (row) => `${row.warehouse_id || ""}::${row.company_account_id || ""}::${row.product_id || ""}`;
  const ensure = (row) => {
    const key = keyOf(row);
    if (!groups.has(key)) {
      groups.set(key, {
        warehouse_id: row.warehouse_id,
        warehouse_name: row.warehouse_name || "",
        company_account_id: row.company_account_id || "",
        company_account_name: row.company_account_name || "",
        product_id: row.product_id,
        product_name: row.product_name || "",
        purchase_qty: 0,
        sale_qty: 0,
        purchase_amount: 0,
        sale_amount: 0,
        purchase_details: [],
        sale_details: [],
      });
    }
    const item = groups.get(key);
    item.warehouse_name = item.warehouse_name || row.warehouse_name || "";
    item.company_account_name = item.company_account_name || row.company_account_name || "";
    item.product_name = item.product_name || row.product_name || "";
    return item;
  };

  purchases.forEach((row) => {
    const item = ensure(row);
    const grossLessTare = Number(row.gross_weight || 0) - Number(row.tare_weight || 0);
    const fallbackQty = Number(row.total_quantity || row.total_qty || row.net_weight || row.quantity || 0);
    const qty = grossLessTare > 0 ? grossLessTare : fallbackQty;
    const amount = Number(row.total_amount || row.net_amount_payable || row.amount || 0);
    item.purchase_qty += qty;
    item.purchase_amount += amount;
    item.purchase_details.push({
      date: row.date || "",
      voucher_no: row.voucher_no || "",
      party_name: row.farmer_name || row.party_name || "",
      qty: Number(qty.toFixed(4)),
      rate: Number(row.rate || 0),
      amount,
    });
  });

  sales.forEach((row) => {
    const item = ensure(row);
    const qty = Number(row.quantity || row.total_quantity || 0);
    const amount = Number(row.amount || row.total_amount || 0);
    item.sale_qty += qty;
    item.sale_amount += amount;
    item.sale_details.push({
      date: row.date || "",
      voucher_no: row.voucher_no || "",
      party_name: row.company_name || row.consignee_name || row.party_name || "",
      qty: Number(qty.toFixed(4)),
      rate: Number(row.rate || 0),
      amount,
    });
  });

  return Array.from(groups.values()).map((item) => {
    const stockQty = item.purchase_qty - item.sale_qty;
    const avgRate = item.purchase_qty > 0 ? item.purchase_amount / item.purchase_qty : 0;
    return {
      ...item,
      purchase_qty: Number(item.purchase_qty.toFixed(4)),
      sale_qty: Number(item.sale_qty.toFixed(4)),
      stock_qty: Number(stockQty.toFixed(4)),
      avg_rate: Number(avgRate.toFixed(2)),
      stock_amount: Number((stockQty * avgRate).toFixed(2)),
      purchase_amount: Number(item.purchase_amount.toFixed(2)),
      sale_amount: Number(item.sale_amount.toFixed(2)),
      purchase_details: item.purchase_details.sort((a, b) => String(a.date || "").localeCompare(String(b.date || ""))),
      sale_details: item.sale_details.sort((a, b) => String(a.date || "").localeCompare(String(b.date || ""))),
    };
  });
}

function buildFifoStock(purchases, sales) {
  const lotsByKey = new Map();
  const keyOf = (row) => `${row.warehouse_id || ""}::${row.product_id || ""}`;

  purchases
    .slice()
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
    .forEach((row) => {
      const key = keyOf(row);
      const netQty = Number(row.total_quantity || row.total_qty || row.net_weight || row.quantity || 0);
      const grossQty = Number(row.gross_weight || 0);
      const qty = grossQty > 0 ? grossQty : netQty;
      const amount = Number(row.total_amount || row.net_amount_payable || row.amount || 0);
      if (!lotsByKey.has(key)) lotsByKey.set(key, []);
      lotsByKey.get(key).push({
        ...row,
        purchase_qty: qty,
        remaining_qty: qty,
        fifo_rate: qty > 0 ? amount / qty : Number(row.rate || 0),
      });
    });

  sales
    .slice()
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
    .forEach((row) => {
      const lots = lotsByKey.get(keyOf(row)) || [];
      let saleQty = Number(row.quantity || row.total_quantity || 0);
      for (const lot of lots) {
        if (saleQty <= 0) break;
        const used = Math.min(lot.remaining_qty, saleQty);
        lot.remaining_qty -= used;
        saleQty -= used;
      }
    });

  return Array.from(lotsByKey.values())
    .flat()
    .filter((lot) => lot.remaining_qty > 0.0001)
    .map((lot) => ({
      date: lot.date,
      voucher_no: lot.voucher_no,
      warehouse_id: lot.warehouse_id,
      warehouse_name: lot.warehouse_name,
      product_id: lot.product_id,
      product_name: lot.product_name,
      purchase_qty: Number(lot.purchase_qty.toFixed(4)),
      remaining_qty: Number(lot.remaining_qty.toFixed(4)),
      rate: Number(lot.fifo_rate.toFixed(4)),
      amount: Number((lot.remaining_qty * lot.fifo_rate).toFixed(4)),
      gross_weight: Number((Number(lot.gross_weight || lot.purchase_qty || 0)).toFixed(4)),
    }));
}

// ===========================
// REPORTS
// ===========================
router.get("/report/payment", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  if (!mongoReady() || !MongoPaymentVoucher) {
    return res.status(503).json({
      error: "MongoDB is not connected. Payment report is MongoDB-primary.",
    });
  }

  getMongoPaymentRowsForUser(req)
    .then((rows) => res.json(rows))
    .catch((err) => {
      console.error("Mongo payment report error:", err.message);
      res.status(500).json({ error: err.message });
    });
});

router.get("/report/filter-options", async (req, res) => {
  const filterStartedAt = Date.now();
  ensureTradingIndexes();
  const type = String(req.query.type || "purchase").trim().toLowerCase();
  if (!mongoReady()) return res.status(503).json({ error: "MongoDB is required for Trading report filters" });

  const isSale = type === "sale" || type === "sale-party-ledger" || type === "sale-followup" || type === "sale-journey";
  const isPurchase = type === "purchase" || type === "purchase-party-ledger" || type === "fifo-stock";
  if (!isSale && !isPurchase) return res.status(400).json({ error: "Unsupported report type" });

  const accountId = String(req.query.company_account_id || "").trim();
  const warehouseId = String(req.query.warehouse_id || "").trim();
  const farmerId = String(req.query.farmer_id || "").trim();
  const buyerId = String(req.query.buyer_id || "").trim();
  const cacheKey = JSON.stringify([
    req.user?.id || req.user?._id || "", type, accountId, warehouseId, farmerId, buyerId,
  ]);
  const cached = tradingFilterCache.get(cacheKey);
  if (cached && Date.now() - cached.time < TRADING_FILTER_CACHE_MS) {
    return res.json(cached.data);
  }

  try {
    const base = isPurchase ? { ...mongoPurchaseScope(req.user) } : { ...mongoSaleScope(req.user) };
    if (accountId) base.company_account_id = accountId;
    if (warehouseId) base.warehouse_id = warehouseId;
    if (farmerId) base.farmer_id = farmerId;

    let accountIds = [];
    let warehouseIds = [];
    let farmerIds = [];
    let buyerIds = [];

    if (isPurchase) {
      [accountIds, warehouseIds, farmerIds] = await Promise.all([
        PurchaseVoucher.distinct("company_account_id", { ...mongoPurchaseScope(req.user), ...(warehouseId ? { warehouse_id: warehouseId } : {}), ...(farmerId ? { farmer_id: farmerId } : {}) }),
        PurchaseVoucher.distinct("warehouse_id", { ...mongoPurchaseScope(req.user), ...(accountId ? { company_account_id: accountId } : {}), ...(farmerId ? { farmer_id: farmerId } : {}) }),
        PurchaseVoucher.distinct("farmer_id", { ...mongoPurchaseScope(req.user), ...(accountId ? { company_account_id: accountId } : {}), ...(warehouseId ? { warehouse_id: warehouseId } : {}) }),
      ]);
    } else {
      const saleScope = { ...mongoSaleScope(req.user) };
      const buyerFilter = buyerId ? { $or: [{ buyer_id: buyerId }, { company_id: buyerId }] } : {};
      [accountIds, warehouseIds, farmerIds, buyerIds] = await Promise.all([
        SaleVoucher.distinct("company_account_id", { ...saleScope, ...(warehouseId ? { warehouse_id: warehouseId } : {}), ...(farmerId ? { farmer_id: farmerId } : {}), ...buyerFilter }),
        SaleVoucher.distinct("warehouse_id", { ...saleScope, ...(accountId ? { company_account_id: accountId } : {}), ...(farmerId ? { farmer_id: farmerId } : {}), ...buyerFilter }),
        SaleVoucher.distinct("farmer_id", { ...saleScope, ...(accountId ? { company_account_id: accountId } : {}), ...(warehouseId ? { warehouse_id: warehouseId } : {}), ...buyerFilter }),
        SaleVoucher.distinct("buyer_id", { ...saleScope, ...(accountId ? { company_account_id: accountId } : {}), ...(warehouseId ? { warehouse_id: warehouseId } : {}), ...(farmerId ? { farmer_id: farmerId } : {}) }),
      ]);
    }

    const clean = (values) => [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
    const validIds = (values) => clean(values).filter((value) => mongoose.Types.ObjectId.isValid(value));

    const cleanAccountIds = validIds(accountIds);
    const cleanWarehouseIds = validIds(warehouseIds);
    const cleanFarmerIds = validIds(farmerIds);
    const cleanBuyerIds = validIds(buyerIds);
    const cleanBuyerLegacyIds = clean(buyerIds).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
    const buyerFilterQuery = cleanBuyerIds.length || cleanBuyerLegacyIds.length ? {
      $or: [
        ...(cleanBuyerIds.length ? [{ _id: { $in: cleanBuyerIds } }] : []),
        ...(cleanBuyerLegacyIds.length ? [{ legacy_id: { $in: cleanBuyerLegacyIds } }] : []),
      ],
    } : null;

    // Return labels together with IDs so Reports do not need to load the
    // entire nine-table master bundle just to populate filter dropdowns.
    const [accountDocs, warehouseDocs, farmerDocs, buyerDocs] = await Promise.all([
      cleanAccountIds.length ? CompanyAccount.find({ _id: { $in: cleanAccountIds } }).select("_id account_name name").lean() : [],
      cleanWarehouseIds.length ? Warehouse.find({ _id: { $in: cleanWarehouseIds } }).select("_id name").lean() : [],
      cleanFarmerIds.length ? Farmer.find({ _id: { $in: cleanFarmerIds } }).select("_id name").lean() : [],
      buyerFilterQuery ? findDedicatedPartyDocs("buyer", buyerFilterQuery, "_id legacy_id name") : [],
    ]);

    const cleanNamed = (docs, type) => {
      if (type === "buyer") {
        return (docs || []).map((doc) => ({
          id: String(doc?.legacy_id ?? doc?._id ?? ""),
          name: String(doc?.name || "").trim(),
        })).filter((item) => item.id && item.name);
      }
      return (docs || []).map((doc) => ({
        id: String(doc._id),
        name: String(doc.account_name || doc.name || "").trim(),
      })).filter((item) => item.id && item.name);
    };

    const data = {
      account_ids: clean(accountIds),
      warehouse_ids: clean(warehouseIds),
      farmer_ids: clean(farmerIds),
      buyer_ids: clean(buyerIds),
      accounts: cleanNamed(accountDocs),
      warehouses: cleanNamed(warehouseDocs),
      farmers: cleanNamed(farmerDocs),
      buyers: cleanNamed(buyerDocs, "buyer"),
    };
    tradingFilterCache.set(cacheKey, { time: Date.now(), data });
    res.set("Cache-Control", "private, max-age=900, stale-while-revalidate=120");
    res.set("Server-Timing", `trading-filter;dur=${Date.now() - filterStartedAt}`);
    res.json(data);
  } catch (err) {
    console.error("Trading report filter options failed:", err);
    res.status(500).json({ error: err.message || "Failed to load report filters" });
  }
});

router.get("/report/sale-summary", async (req, res) => {
  ensureTradingIndexes();
  if (!userHasPermission(req.user, "warehouse.trading.report.sale")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.page_size, 10) || 15, 1), 100);
  const usePaging = req.query.page !== undefined || req.query.page_size !== undefined;
  const options = {
    buyerId: String(req.query.buyer_id || "").trim(),
    farmerId: String(req.query.farmer_id || "").trim(),
    warehouseId: String(req.query.warehouse_id || "").trim(),
    companyAccountId: String(req.query.company_account_id || "").trim(),
    productId: String(req.query.product_id || "").trim(),
    search: String(req.query.search || "").trim(),
  };

  try {
    if (mongoReady()) {
      const filter = { ...mongoSaleScope(req.user) };
      if (options.buyerId) filter.$or = [{ buyer_id: options.buyerId }, { company_id: options.buyerId }];
      if (options.farmerId) filter.farmer_id = options.farmerId;
      if (options.warehouseId) filter.warehouse_id = options.warehouseId;
      if (options.companyAccountId) filter.company_account_id = options.companyAccountId;
      if (options.productId) filter.product_id = options.productId;
      if (options.search) {
        const safe = options.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const rx = new RegExp(safe, "i");
        filter.$and = [
          ...(filter.$and || []),
          { $or: [
            { voucher_no: rx },
            { bill_no: rx },
            { po_no: rx },
            { buyer_name: rx },
            { company_name: rx },
            { product_name: rx },
            { warehouse_name: rx },
            { company_account_name: rx },
            { consignee_name: rx },
            { lorry_no: rx },
            { description: rx },
          ] },
        ];
      }
      const query = SaleVoucher.find(filter).sort({ date: -1, createdAt: -1, _id: -1 }).lean();
      const countPromise = usePaging ? SaleVoucher.countDocuments(filter).exec() : Promise.resolve(0);
      if (usePaging) query.skip((page - 1) * pageSize).limit(pageSize);
      const [rows, total] = await Promise.all([query.exec(), countPromise]);
      let decorated;
      try {
        decorated = await decorateSaleRows(rows || []);
      } catch (decorateErr) {
        // Reporting must not fail because an optional master/mirror record is
        // missing. MongoDB voucher data is still valid and should be returned.
        console.error("Sale report decoration skipped:", decorateErr);
        decorated = (rows || []).map((row) => ({
          ...(row?.toObject ? row.toObject() : row),
          id: String(row?._id || row?.id || ""),
          _id: String(row?._id || row?.id || ""),
          total_quantity: Number(row?.quantity || row?.total_quantity || 0),
          total_amount: Number(row?.amount || row?.total_amount || 0),
          ...calculateSaleFollowupMeta(row || {}),
        }));
      }
      const data = decorated.map((row) => ({
        ...row,
        total_quantity: Number(Number(row.quantity || row.total_quantity || 0).toFixed(4)),
        total_amount: Number(Number(row.amount || row.total_amount || 0).toFixed(2)),
      }));
      return res.json(usePaging ? { data, pagination: { page, pageSize, total: Number(total || 0), totalPages: Math.max(1, Math.ceil(Number(total || 0) / pageSize)), hasMore: page * pageSize < Number(total || 0) } } : data);
    }

    const rows = await getSaleReportRowsForUser(req.user, options);
    const data = usePaging ? rows.slice((page - 1) * pageSize, page * pageSize) : rows;
    return res.json(usePaging ? { data, pagination: { page, pageSize, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / pageSize)), hasMore: page * pageSize < rows.length } } : data);
  } catch (err) {
    console.error("Mongo sale report query failed:", err);
    res.status(500).json({ error: err.message || "Failed to load sale report" });
  }
});

router.get("/report/purchase-summary", async (req, res) => {
  ensureTradingIndexes();
  if (!userHasPermission(req.user, "warehouse.trading.report.purchase")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.page_size, 10) || 25, 1), 200);
  const usePaging = req.query.page !== undefined || req.query.page_size !== undefined;
  const farmerId = String(req.query.farmer_id || "").trim();
  const warehouseId = String(req.query.warehouse_id || "").trim();
  const companyAccountId = String(req.query.company_account_id || "").trim();
  const search = String(req.query.search || "").trim();

  if (mongoReady()) {
    const filter = { ...mongoPurchaseScope(req.user) };
    addMixedIdFilter(filter, "farmer_id", farmerId);
    addMixedIdFilter(filter, "warehouse_id", warehouseId);
    addMixedIdFilter(filter, "company_account_id", companyAccountId);
    await addPurchaseSearchFilter(filter, search);
    const query = PurchaseVoucher.find(filter).sort({ date: -1, createdAt: -1, _id: -1 });
    const countPromise = usePaging ? PurchaseVoucher.countDocuments(filter).exec() : Promise.resolve(null);
    if (usePaging) query.skip((page - 1) * pageSize).limit(pageSize);
    const rowsPromise = query.lean().exec();

    return Promise.all([rowsPromise, countPromise])
      .then(async ([rows, totalCount]) => {
        const decoratedRows = await decoratePurchaseRows(rows || []);
        const total = usePaging ? Number(totalCount || 0) : decoratedRows.length;
        return res.json(
          usePaging
            ? {
                data: decoratedRows || [],
                pagination: {
                  page,
                  pageSize,
                  total,
                  hasMore: page * pageSize < total,
                },
              }
            : (decoratedRows || [])
        );
      })
      .catch((err) => {
        console.error("Mongo purchase report query failed:", err.message);
        res.status(500).json({ error: err.message });
      });
  }
  return res.status(503).json({ error: "MongoDB is required for purchase summary" });
});

router.get("/report/profit-loss", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.profitLoss")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    const [purchases, sales] = await Promise.all([
      getPurchaseReportRowsForUser(req.user),
      getSaleReportRowsForUser(req.user),
    ]);
    const rows = new Map();
    const ensure = (row) => {
      const key = String(row.warehouse_id || "");
      if (!rows.has(key)) {
        rows.set(key, {
          id: row.warehouse_id,
          warehouse_id: row.warehouse_id,
          warehouse_name: row.warehouse_name || "",
          sale_amount: 0,
          purchase_amount: 0,
          profit_loss: 0,
        });
      }
      const item = rows.get(key);
      item.warehouse_name = item.warehouse_name || row.warehouse_name || "";
      return item;
    };

    purchases.forEach((row) => {
      const item = ensure(row);
      item.purchase_amount += Number(row.total_amount || row.net_amount_payable || row.amount || 0);
    });
    sales.forEach((row) => {
      const item = ensure(row);
      item.sale_amount += Number(row.amount || row.total_amount || 0);
    });

    res.json(
      Array.from(rows.values()).map((row) => ({
        ...row,
        sale_amount: Number(row.sale_amount.toFixed(2)),
        purchase_amount: Number(row.purchase_amount.toFixed(2)),
        profit_loss: Number((row.sale_amount - row.purchase_amount).toFixed(2)),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/report/purchase-party-ledger", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.purchase")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    const farmerId = String(req.query.farmer_id || "").trim();
    const warehouseId = String(req.query.warehouse_id || "").trim();
    const companyAccountId = String(req.query.company_account_id || "").trim();
    const detailsOfDeduction = ["1", "true", "yes", "details"].includes(String(req.query.details_of_deduction || "").trim().toLowerCase());
    const purchasePromise = getPurchaseReportRowsForUser(req.user, { farmerId, warehouseId, companyAccountId });

    const filter = assignedWarehouseFilter(req.user, "p.warehouse_id");
    const paymentParams = [...filter.params];
    let farmerClause = "";
    let warehouseClause = "";
    let accountClause = "";
    if (farmerId) {
      farmerClause = " AND CAST(p.farmer_id AS TEXT) = CAST(? AS TEXT)";
      paymentParams.push(farmerId);
    }
    if (warehouseId) {
      warehouseClause = " AND CAST(p.warehouse_id AS TEXT) = CAST(? AS TEXT)";
      paymentParams.push(warehouseId);
    }
    if (companyAccountId) {
      accountClause = " AND CAST(p.company_account_id AS TEXT) = CAST(? AS TEXT)";
      paymentParams.push(companyAccountId);
    }

    const [purchases, allPayments] = await Promise.all([
      purchasePromise,
      getMongoPaymentRowsForUser(req),
    ]);
    const payments = (allPayments || []).filter((row) => {
      if (farmerId && String(row.farmer_id || "") !== farmerId) return false;
      if (warehouseId && String(row.warehouse_id || "") !== warehouseId) return false;
      if (companyAccountId && String(row.company_account_id || "") !== companyAccountId) return false;
      return true;
    });
    const paymentIds = payments.map((row) => row.id);
    const mongoAdjustments = paymentIds.length && MongoPaymentAdjustment
      ? await MongoPaymentAdjustment.find({ payment_id: { $in: paymentIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)) } })
          .sort({ id: 1 })
          .lean()
      : [];

    const purchaseMap = new Map(purchases.map((row) => [String(row.id || row._id), row]));
    const paymentMap = new Map(payments.map((row) => [String(row.id), row]));
    const adjustmentsByPayment = new Map();
    const adjustmentsByPurchase = new Map();

    mongoAdjustments.forEach((item) => {
      const paymentId = String(item.payment_id);
      const purchaseId = String(item.purchase_id);
      const purchase = purchaseMap.get(purchaseId);
      const payment = paymentMap.get(paymentId);
      const voucherNo = item.purchase_voucher_no || purchase?.voucher_no || item.purchase_id;
      const detail = {
        ...item,
        purchase_voucher_no: voucherNo,
        payment_date: payment?.date || "",
        payment_voucher_no: payment?.voucher_no || "",
        payment_amount: Number(payment?.amount || 0),
      };
      if (!adjustmentsByPayment.has(paymentId)) adjustmentsByPayment.set(paymentId, []);
      adjustmentsByPayment.get(paymentId).push(detail);
      if (!adjustmentsByPurchase.has(purchaseId)) adjustmentsByPurchase.set(purchaseId, []);
      adjustmentsByPurchase.get(purchaseId).push(detail);
    });

    const rows = [
      ...purchases.flatMap((row) => {
        const purchaseId = String(row.id || row._id);
        const paymentDetails = adjustmentsByPurchase.get(purchaseId) || [];
        const netPurchaseAmount = Number(row.total_amount || row.net_amount_payable || row.amount || 0);
        const grossPurchaseAmount = purchaseGrossAmountFromRow(row);
        // Round-off belongs to the purchase credit itself. A positive round-off
        // increases the credited purchase amount; a negative round-off reduces it.
        // In Details of Deduction mode the gross amount is therefore adjusted by
        // round-off before the deduction rows are applied.
        const roundOffAmount = Number(row.round_off || 0);
        const purchaseCreditAmount = grossPurchaseAmount + roundOffAmount;
        const purchaseAmount = detailsOfDeduction ? purchaseCreditAmount : netPurchaseAmount;
        const paymentAmount = paymentDetails.reduce((sum, item) => sum + Number(item.adjusted_amount || 0), 0);
        const base = {
          date: row.date,
          voucher_no: row.voucher_no,
          voucher_type: "Purchase",
          particulars: `Purchase Bill ${row.voucher_no || ""}`.trim(),
          adjustment_details: paymentDetails
            .map((item) => `${item.payment_date || "-"} ${item.payment_voucher_no || "-"}: Rs.${fmtNum(item.adjusted_amount)}`)
            .join("; "),
          payment_details: paymentDetails,
          purchase_id: purchaseId,
          purchase_amount: Number(purchaseAmount.toFixed(2)),
          gross_purchase_amount: Number(grossPurchaseAmount.toFixed(2)),
          round_off_amount: Number(roundOffAmount.toFixed(2)),
          purchase_credit_amount: Number(purchaseCreditAmount.toFixed(2)),
          net_purchase_amount: Number(netPurchaseAmount.toFixed(2)),
          payment_amount: Number(paymentAmount.toFixed(2)),
          journal_amount: 0,
          receipt_amount: 0,
          bill_balance: Number((purchaseAmount - paymentAmount).toFixed(2)),
          warehouse_id: row.warehouse_id,
          warehouse_name: row.warehouse_name,
          farmer_id: row.farmer_id,
          farmer_name: row.farmer_name,
          company_account_id: row.company_account_id,
          company_account_name: row.company_account_name,
          debit: 0,
          credit: purchaseAmount,
        };
        if (!detailsOfDeduction) return [base];
        const deductions = Array.isArray(row.deduction_details) && row.deduction_details.length
          ? row.deduction_details
          : buildPurchaseDeductionDetails(row);
        const deductionRows = deductions.map((detail) => {
          const amount = Number(detail.amount || 0);
          const label = String(detail.label || detail.account_label || detail.key || "Deduction");
          const particular = detail.key === "labour"
            ? `EXP - Labour - ${fmtNum(amount)}`
            : `${label} - ${fmtNum(amount)}`;
          return {
            ...base,
            id: `${purchaseId}-deduction-${detail.key}`,
            row_type: "deduction",
            voucher_type: "Deduction",
            particulars: particular,
            adjustment_details: detail.account_label || label,
            deduction_type: detail.key,
            deduction_label: label,
            deduction_amount: Number(amount.toFixed(2)),
            debit: Number(amount.toFixed(2)),
            credit: 0,
            payment_details: [],
            purchase_amount: 0,
            bill_balance: 0,
          };
        });
        return [base, ...deductionRows];
      }),
      ...payments.map((row) => {
        const paymentAdjustments = adjustmentsByPayment.get(String(row.id)) || [];
        const adjustmentDetails = paymentAdjustments
          .map((item) => `${item.purchase_voucher_no}: Rs.${fmtNum(item.adjusted_amount)}`)
          .join("; ");
        const isOnAccount = !paymentAdjustments.length && !String(row.reference_id || "").trim();
        return {
          date: row.date,
          voucher_no: row.voucher_no,
          voucher_type: "Payment",
          particulars: isOnAccount
            ? "Unadjusted on account"
            : `Payment adjusted against ${paymentAdjustments.map((item) => item.purchase_voucher_no).filter(Boolean).join(", ") || row.reference_id || "purchase bill"}`,
          adjustment_details: adjustmentDetails,
          reference_id: row.reference_id || paymentAdjustments.map((item) => item.purchase_voucher_no).filter(Boolean).join(", ") || (isOnAccount ? "On account" : ""),
          warehouse_id: row.warehouse_id,
          warehouse_name: row.warehouse_name,
          farmer_id: row.farmer_id,
          farmer_name: row.farmer_name,
          company_account_id: row.company_account_id,
          company_account_name: row.company_account_name,
          debit: Number(row.amount || 0),
          credit: 0,
        };
      }),
    ];

    const enrichedRows = await enrichLedgerRowsWithPartyDetails(rows);
    return res.json(buildLedgerRows(
      enrichedRows,
      (row) => `${row.farmer_id || "unknown"}::${row.company_account_id || "no-account"}`,
      (row) => row.farmer_name || row.company_account_name || "Unknown Farmer"
    ));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/report/sale-party-ledger", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.sale")) {
    return res.status(403).json({ error: "Permission denied" });
  }
  try {
    const buyerId = String(req.query.buyer_id || "").trim();
    const farmerId = String(req.query.farmer_id || "").trim();
    const warehouseId = String(req.query.warehouse_id || "").trim();
    const companyAccountId = String(req.query.company_account_id || "").trim();
    const sales = await getSaleReportRowsForUser(req.user, { buyerId, farmerId, warehouseId, companyAccountId });

    const allReceipts = await getMongoReceiptRowsForUser(req);
    const receipts = (allReceipts || []).filter((row) => {
      if (buyerId && String(row.company_id || "") !== buyerId) return false;
      if (warehouseId && String(row.warehouse_id || "") !== warehouseId) return false;
      if (companyAccountId && String(row.company_account_id || "") !== companyAccountId) return false;
      return true;
    });
    const receiptIds = receipts.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
    const adjustmentRows = receiptIds.length && MongoReceiptAdjustment
      ? await MongoReceiptAdjustment.find({ receipt_id: { $in: receiptIds } }).sort({ id: 1 }).lean()
      : [];

    const saleMap = new Map((sales || []).map((row) => [String(row.id || row._id), row]));
    const receiptMap = new Map((receipts || []).map((row) => [String(row.id), row]));
    const bySale = new Map();
    const byReceipt = new Map();
    (adjustmentRows || []).forEach((item) => {
      const saleId = String(item.sale_id || "");
      const receiptId = String(item.receipt_id || "");
      const sale = saleMap.get(saleId);
      const receipt = receiptMap.get(receiptId);
      const detail = {
        ...item,
        sale_date: sale?.date || sale?.unloading_date || item.sale_date || "",
        sale_voucher_no: sale?.voucher_no || item.sale_voucher_no || item.sale_id,
        sale_amount: Number(sale?.amount || sale?.total_amount || item.sale_amount || 0),
        receipt_date: receipt?.date || "",
        receipt_voucher_no: receipt?.voucher_no || item.receipt_voucher_no || "",
        receipt_amount: Number(receipt?.amount || 0),
      };
      if (!bySale.has(saleId)) bySale.set(saleId, []);
      bySale.get(saleId).push(detail);
      if (!byReceipt.has(receiptId)) byReceipt.set(receiptId, []);
      byReceipt.get(receiptId).push(detail);
    });

    const ledgerRows = [];

    (sales || []).forEach((row) => {
      const saleId = String(row.id || row._id);
      const details = bySale.get(saleId) || [];
      const grossSale = Number(row.amount || row.total_amount || 0);

      // claim_amount is the effective shortage/claim deduction used by the
      // sale net calculation. shortage_amount is kept as supporting detail,
      // so it is never subtracted twice.
      const claim = Number(row.claim_amount || 0);
      const shortageQty = Number(row.shortage_quantity || 0);
      const shortageAmount = Number(row.shortage_amount || 0);
      const otherDeduction = Number(row.other_deduction || 0);
      const cdAmount = Number(row.cd_amount || 0);
      const freight = Number(row.transport_charge || 0);
      const adjustment = Number(row.adjustment_amount || 0);
      const tds = Number(row.tds_amount || 0);
      const roundOff = Number(row.round_off || 0);

      // Keep the existing accounting amount unchanged. Claim/shortage are
      // displayed as one effective deduction so the same amount is never
      // credited twice when shortage_amount is the supporting claim value.
      const claimLabel = claim > 0
        ? (shortageAmount > 0 && Math.abs(claim - shortageAmount) < 0.000001 ? "Shortage" : "Claim")
        : (shortageAmount > 0 ? "Shortage" : "Claim");

      const deductionParts = [
        ...(claim > 0 || shortageAmount > 0 ? [{ key: claimLabel.toLowerCase(), label: claimLabel, amount: claim > 0 ? claim : shortageAmount }] : []),
        { key: "other", label: "Other", amount: otherDeduction },
        { key: "cd", label: "CD", amount: cdAmount },
        { key: "freight", label: "Freight", amount: freight },
        { key: "adjustment", label: "Adjustment", amount: adjustment },
        { key: "tds", label: "TDS", amount: tds },
      ].filter((item) => Number.isFinite(item.amount) && Math.abs(item.amount) > 0.000001);

      const deductionTotal = deductionParts.reduce((sum, item) => sum + item.amount, 0);
      const receiptAmount = details.reduce((sum, item) => sum + Number(item.adjusted_amount || 0), 0);
      const netReceivable = grossSale - deductionTotal + roundOff;

      ledgerRows.push({
        ...row,
        date: row.date,
        voucher_no: row.voucher_no,
        voucher_type: "Sale",
        particulars: `Sale Bill ${row.voucher_no || ""}`.trim(),
        adjustment_details: details.map((item) => `${item.receipt_date || "-"} ${item.receipt_voucher_no || "-"}: Rs.${fmtNum(item.adjusted_amount)}`).join("; "),
        receipt_details: details,
        sale_id: saleId,
        sale_amount: Number(grossSale.toFixed(2)),
        receipt_amount: Number(receiptAmount.toFixed(2)),
        journal_amount: Number(deductionTotal.toFixed(2)),
        bill_balance: Number((netReceivable - receiptAmount).toFixed(2)),
        debit: Number(grossSale.toFixed(2)),
        credit: 0,
        party_id: String(row.buyer_id || row.company_id || ""),
        party_name: row.buyer_name || row.company_name || "-",
      });

      // Every F2 deduction is a separate Credit in the same Sale Party Ledger.
      deductionParts.forEach((part) => {
        const shortageInfo = part.label === "Shortage" && (shortageQty || shortageAmount)
          ? ` Shortage Qty ${fmtNum(shortageQty)}, Shortage Amount Rs.${fmtNum(shortageAmount)}`
          : "";

        ledgerRows.push({
          ...row,
          id: `${saleId}-deduction-${part.key}`,
          _id: `${saleId}-deduction-${part.key}`,
          date: row.unloading_date || row.date,
          voucher_no: row.voucher_no,
          voucher_type: `Sale - ${part.label}`,
          particulars: `${part.label} against ${row.voucher_no || "Sale"}${shortageInfo}`,
          adjustment_details: "",
          receipt_details: [],
          sale_id: saleId,
          sale_amount: 0,
          receipt_amount: 0,
          journal_amount: Number(part.amount.toFixed(2)),
          bill_balance: Number((netReceivable - receiptAmount).toFixed(2)),
          debit: 0,
          credit: Number(part.amount.toFixed(2)),
          party_id: String(row.buyer_id || row.company_id || ""),
          party_name: row.buyer_name || row.company_name || "-",
          ledger_component: part.key,
        });
      });

      if (Math.abs(roundOff) > 0.000001) {
        ledgerRows.push({
          ...row,
          id: `${saleId}-roundoff`,
          _id: `${saleId}-roundoff`,
          date: row.unloading_date || row.date,
          voucher_no: row.voucher_no,
          voucher_type: "Sale - Round Off",
          particulars: `Round Off against ${row.voucher_no || "Sale"}`,
          adjustment_details: "",
          receipt_details: [],
          sale_id: saleId,
          sale_amount: 0,
          receipt_amount: 0,
          journal_amount: Number(Math.abs(roundOff).toFixed(2)),
          bill_balance: Number((netReceivable - receiptAmount).toFixed(2)),
          debit: roundOff > 0 ? Number(roundOff.toFixed(2)) : 0,
          credit: roundOff < 0 ? Number(Math.abs(roundOff).toFixed(2)) : 0,
          party_id: String(row.buyer_id || row.company_id || ""),
          party_name: row.buyer_name || row.company_name || "-",
          ledger_component: "round_off",
        });
      }
    });

    (receipts || []).forEach((row) => {
      const details = byReceipt.get(String(row.id)) || [];
      const isOnAccount = !details.length && !String(row.reference_id || "").trim();
      ledgerRows.push({
        ...row,
        date: row.date,
        voucher_no: row.voucher_no,
        voucher_type: "Receipt",
        particulars: isOnAccount ? "Unadjusted on account" : `Receipt adjusted against ${details.map((item) => item.sale_voucher_no).filter(Boolean).join(", ") || row.reference_id || "sale bill"}`,
        adjustment_details: details.map((item) => `${item.sale_date || "-"} | ${item.sale_voucher_no || "-"} | Rs.${fmtNum(item.adjusted_amount)}`).join("; "),
        reference_id: row.reference_id || details.map((item) => item.sale_voucher_no).filter(Boolean).join(", ") || (isOnAccount ? "On account" : ""),
        receipt_details: details,
        debit: 0,
        credit: Number(row.amount || 0),
        party_id: String(row.company_id || ""),
        party_name: row.buyer_name || row.party_name || row.company_name || row.company_account_name || "-",
        buyer_name: row.buyer_name || "-",
      });
    });

    return res.json(buildLedgerRows(
      ledgerRows,
      (row) => `${row.party_id || "unknown"}::${row.company_account_id || "no-account"}`,
      (row) => row.party_name || row.company_account_name || "Unknown Party"
    ));
  } catch (err) {
    console.error("Sale party ledger failed:", err);
    res.status(500).json({ error: err.message || "Failed to load sale party ledger" });
  }
});

router.get("/report/sale-followup", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.sale")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    const companyAccountId = String(req.query.company_account_id || "").trim();
    const buyerId = String(req.query.company_id || req.query.buyer_id || "").trim();
    const statusFilter = String(req.query.status || "").trim().toLowerCase();

    const rows = (await getSaleReportRowsForUser(req.user))
      .filter((row) => {
        if (companyAccountId && String(row.company_account_id || "") !== companyAccountId) return false;
        if (buyerId && String(row.buyer_id || row.company_id || "") !== buyerId) return false;
        if (statusFilter && String(row.followup_status || "").toLowerCase() !== statusFilter) return false;
        return true;
      })
      .map((row) => ({
        ...row,
        buyer_email: row.buyer_email || row.consignee_email || "",
        buyer_mobile: row.buyer_mobile || row.consignee_mobile || "",
        party_name: row.party_name || row.buyer_name || row.company_name || "-",
        balance: Number(row.balance || row.bill_balance || row.outstanding || row.sale_amount || 0),
        due_days: Number.isFinite(Number(row.due_days)) ? Number(row.due_days) : calculateDaysDiff(row.unloading_date || row.date, row.due_date),
        days_overdue: Number.isFinite(Number(row.days_overdue)) ? Number(row.days_overdue) : calculateDaysDiff(row.due_date, new Date().toISOString().slice(0, 10)),
        contact_email: row.buyer_email || row.consignee_email || "",
        contact_mobile: row.buyer_mobile || row.consignee_mobile || "",
        followup_status_label: getFollowupStatusLabel(row.followup_status),
      }))
      .sort((a, b) => {
        if (a.followup_priority !== b.followup_priority) return a.followup_priority - b.followup_priority;
        const dateA = new Date(a.due_date || a.date || 0).getTime();
        const dateB = new Date(b.due_date || b.date || 0).getTime();
        if (dateA !== dateB) return dateA - dateB;
        return String(a.voucher_no || "").localeCompare(String(b.voucher_no || ""), undefined, {
          numeric: true,
          sensitivity: "base",
        });
      });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/report/sale-journey", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.sale")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    const journeyToken = String(req.query.journey_token || "").trim();
    const lorryNo = String(req.query.lorry_no || "").trim().toLowerCase();
    const billNo = String(req.query.bill_no || req.query.voucher_no || "").trim().toLowerCase();

    let rows = await getSaleReportRowsForUser(req.user);
    rows = rows.filter((row) => {
      const rowJourney = String(row.journey_token || row.journey_id || row.journey_group_no || "").trim();
      const rowLorry = String(row.lorry_no || row.reference_id || "").trim().toLowerCase();
      const rowBill = String(row.voucher_no || row.bill_no || "").trim().toLowerCase();
      if (journeyToken) return rowJourney === journeyToken;
      if (lorryNo) return rowLorry === lorryNo;
      if (billNo) return rowBill === billNo;
      return false;
    });

    rows = rows
      .sort((a, b) => {
        const dateSort = String(a.date || "").localeCompare(String(b.date || ""));
        if (dateSort) return dateSort;
        return Number(a.id || 0) - Number(b.id || 0);
      })
      .map((row, index, arr) => {
        const dispatchQty = Number(row.dispatch_qty || row.quantity || row.total_quantity || row.unloading_qty || 0);
        const unloadQty = Number(row.unloading_qty || 0);
        const remainAfter = Math.max(dispatchQty - unloadQty, 0);
        return {
          ...row,
          journey_leg: index + 1,
          journey_running_total: arr.slice(0, index + 1).reduce((sum, item) => sum + Number(item.dispatch_qty || item.quantity || item.total_quantity || item.unloading_qty || 0), 0),
          journey_running_unloaded: arr.slice(0, index + 1).reduce((sum, item) => sum + Number(item.unloading_qty || 0), 0),
          journey_remain_after_leg: remainAfter,
        };
      });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/report/warehouse-stock", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.purchase") && !userHasPermission(req.user, "warehouse.trading.report.sale")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    const view = String(req.query.view || "").toLowerCase();
    if (view === "details") {
      const [purchases, sales] = await Promise.all([
        getPurchaseReportRowsForUser(req.user),
        getSaleReportRowsForUser(req.user),
      ]);
      return res.json(groupStock(purchases, sales));
    }

    const [purchases, sales] = await Promise.all([
      getPurchaseReportRowsForUser(req.user),
      getSaleReportRowsForUser(req.user),
    ]);
    return res.json(groupStock(purchases, sales));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/report/fifo-stock", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.purchase") && !userHasPermission(req.user, "warehouse.trading.report.sale")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    const [purchases, sales] = await Promise.all([
      getPurchaseReportRowsForUser(req.user),
      getSaleReportRowsForUser(req.user),
    ]);
    res.json(buildFifoStock(purchases, sales));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PDF download for purchase voucher - available to authenticated users
router.get("/purchase/:id/pdf", (req, res) => {
  const id = req.params.id;
  (async () => {
    try {
      let row = null;
      if (mongoReady() && mongoose.Types.ObjectId.isValid(String(id))) {
        row = await getMongoPurchaseVoucherForPdf(id);
      }
      if (!row) return res.status(404).json({ error: "Not found" });
      if (!req.user) return res.status(403).json({ error: "Authentication required" });
      if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;
      try {
        row = await enrichPurchaseVoucherPdfRow(row);
      } catch (enrichErr) {
        console.error("Purchase PDF enrichment failed:", enrichErr.message);
      }
      try {
        sendPurchaseVoucherPdf(res, row, id);
      } catch (pdfErr) {
        console.error("Purchase PDF render failed:", pdfErr.stack || pdfErr.message || pdfErr);
        return sendMinimalPurchaseVoucherPdf(res, row, id);
      }
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  })();
});

router.get("/sale/:id/pdf", async (req, res) => {
  const id = req.params.id;
  try {
    if (!req.user) return res.status(403).json({ error: "Authentication required" });

    let row = null;
    if (mongoReady() && mongoose.Types.ObjectId.isValid(String(id))) {
      const doc = await SaleVoucher.findById(id).lean();
      if (doc) {
        const decorated = await decorateSaleRows([doc]);
        row = decorated[0] || null;
      }
    }

    if (!row) return res.status(404).json({ error: "Not found" });

    if (!row) return res.status(404).json({ error: "Not found" });
    if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;

    const purchaseLinks = Array.isArray(row.against_purchase_links)
      ? row.against_purchase_links
      : (() => {
          try {
            return row.against_purchase_links ? JSON.parse(row.against_purchase_links) : [];
          } catch {
            return [];
          }
        })();
    const totalDeduction = Number(row.total_deduction || 0) || Number(row.claim_amount || 0) + Number(row.other_deduction || 0) + Number(row.transport_charge || 0) + Number(row.cd_amount || 0) + Number(row.adjustment_amount || 0) + Number(row.tds_amount || 0);
    const directPurchaseAmount = Number(row.direct_purchase_amount || purchaseLinks.reduce((sum, item) => sum + Number(item.amount || 0), 0));
    const netAmount = Number(row.net_receivable_amount || row.net_amount_payable || row.outstanding || row.amount || 0);
    const profitLoss = netAmount - directPurchaseAmount;

    const doc = new PDFDocument({ size: "A4", margin: 36 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="sale_${row.voucher_no || id}.pdf"`);
    doc.pipe(res);

    doc.fontSize(18).text("DIRECT SALE BILL", { align: "center" });
    doc.moveDown(0.4);
    doc.fontSize(10).text(`Voucher No: ${row.voucher_no || "-"}`);
    doc.text(`Sale Date: ${fmtDate(row.date)}    Unloading Date: ${fmtDate(row.unloading_date)}`);
    doc.text(`Location: ${row.location_name || row.location_id || "-"}    Warehouse: ${row.warehouse_name || row.warehouse_id || "-"}`);
    doc.text(`Farmer: ${row.farmer_name || row.farmer_id || "-"}    Buyer: ${row.buyer_name || row.company_name || "-"}`);
    doc.text(`Product: ${row.product_name || "-"}    Lorry No: ${row.lorry_no || row.reference_id || "-"}`);

    doc.moveDown(0.5);
    doc.fontSize(12).text("Sale Details", { underline: true });
    doc.fontSize(10);
    doc.text(`Quantity: ${fmtNum(row.quantity || row.unloading_qty || 0)}`);
    doc.text(`Rate: ${fmtNum(row.rate)}`);
    doc.text(`Gross Amount: ${fmtNum(row.amount)}`);
    doc.text(`Net Receivable: ${fmtNum(netAmount)}`);

    doc.moveDown(0.4);
    doc.fontSize(12).text("Deduction / Journal", { underline: true });
    doc.fontSize(10);
    doc.text(`Claim: ${fmtNum(row.claim_amount)}`);
    doc.text(`Shortage: ${fmtNum(row.shortage_amount || row.claim_amount)}`);
    doc.text(`Cash Discount: ${fmtNum(row.cd_amount)}`);
    doc.text(`Other Deduction: ${fmtNum(row.other_deduction)}`);
    doc.text(`Adjustment: ${fmtNum(row.adjustment_amount)}`);
    doc.text(`TDS: ${fmtNum(row.tds_amount)}`);
    doc.text(`Round Off: ${fmtNum(row.round_off)}`);
    doc.text(`Total Deduction: ${fmtNum(totalDeduction)}`);

    doc.moveDown(0.4);
    doc.fontSize(12).text("Auto Purchase Entry", { underline: true });
    doc.fontSize(10);
    doc.text(`Purchase Qty: ${fmtNum(row.total_qty || row.quantity || 0)}`);
    doc.text(`Purchase Rate: ${fmtNum(row.direct_purchase_rate || row.rate)}`);
    doc.text(`Purchase Amount: ${fmtNum(directPurchaseAmount)}`);
    doc.text(`Linked Purchase Rows: ${fmtNum(purchaseLinks.length)}`);

    doc.moveDown(0.4);
    doc.fontSize(12).text("Payment / Receipt / Profit", { underline: true });
    doc.fontSize(10);
    doc.text(`Receipt Adjusted: ${fmtNum((Array.isArray(row.payment_details) ? row.payment_details : []).reduce((sum, item) => sum + Number(item.adjusted_amount || 0), 0))}`);
    doc.text(`Journal Count: ${fmtNum((Array.isArray(row.journal_details) ? row.journal_details : []).length)}`);
    doc.text(`Net Profit / Loss: ${fmtNum(profitLoss)}`);
    doc.text(`Follow-up Status: ${getFollowupStatusLabel(row.followup_status)}`);

    if (row.description) {
      doc.moveDown(0.4);
      doc.text(`Remarks: ${row.description}`);
    }

    doc.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/sale/:id/summary", async (req, res) => {
  const id = req.params.id;
  try {
    if (!req.user) return res.status(403).json({ error: "Authentication required" });

    let row = null;
    if (mongoReady() && mongoose.Types.ObjectId.isValid(String(id))) {
      const doc = await SaleVoucher.findById(id).lean();
      if (doc) {
        const decorated = await decorateSaleRows([doc]);
        row = decorated[0] || null;
      }
    }

    if (!row) return res.status(404).json({ error: "Not found" });
    if (!(await ensureWarehouseAccess(req, res, row.warehouse_id, row.location_id))) return;

    const purchaseLinks = Array.isArray(row.against_purchase_links)
      ? row.against_purchase_links
      : (() => {
          try {
            return row.against_purchase_links ? JSON.parse(row.against_purchase_links) : [];
          } catch {
            return [];
          }
        })();
    const paymentDetails = Array.isArray(row.payment_details) ? row.payment_details : [];
    const journalDetails = Array.isArray(row.journal_details) ? row.journal_details : [];
    const resolvedTransportRow = await getTransportBiltiMatch({
      saleId: row._id || row.id,
      voucherNo: row.voucher_no || row.bill_no || "",
      lorryNo: row.lorry_no || "",
    });
    const totalDeduction = Number(row.total_deduction || 0) || Number(row.claim_amount || 0) + Number(row.other_deduction || 0) + Number(row.transport_charge || 0) + Number(row.cd_amount || 0) + Number(row.adjustment_amount || 0) + Number(row.tds_amount || 0);
    const directPurchaseAmount = Number(row.direct_purchase_amount || purchaseLinks.reduce((sum, item) => sum + Number(item.amount || 0), 0));
    const netAmount = Number(row.net_receivable_amount || row.net_amount_payable || row.outstanding || row.amount || 0);

    res.json({
      sale: row,
      purchase_links: purchaseLinks,
      payment_details: paymentDetails,
      journal_details: journalDetails,
      transport_charge: Number(resolvedTransportRow?.transport_amount || resolvedTransportRow?.payable_amount || resolvedTransportRow?.net_amount || resolvedTransportRow?.gross_freight || 0),
      transport_bilti_no: resolvedTransportRow?.bilti_no || "",
      transport_bilti_id: resolvedTransportRow?.id ? String(resolvedTransportRow.id) : "",
      transport_debug: {
        sale_id: String(row.id || row._id || ""),
        matched_source: resolvedTransportRow?.source || "none",
        matched_sale_id: String(resolvedTransportRow?.sale_id || ""),
        matched_bilti_id: resolvedTransportRow?.id ? String(resolvedTransportRow.id) : "",
        matched_bilti_no: resolvedTransportRow?.bilti_no || "",
        matched_payable_amount: Number(resolvedTransportRow?.transport_amount || resolvedTransportRow?.payable_amount || resolvedTransportRow?.net_amount || resolvedTransportRow?.gross_freight || 0),
        matched_voucher_no: resolvedTransportRow?.voucher_no || "",
        matched_lorry_no: resolvedTransportRow?.lorry_no || "",
      },
      summary: {
        gross_amount: Number(row.amount || 0),
        total_deduction: totalDeduction,
        net_payable: netAmount,
        net_receivable: Number(row.net_receivable_amount || netAmount),
        direct_purchase_amount: directPurchaseAmount,
        profit_loss: netAmount - directPurchaseAmount,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update purchase voucher
router.put("/purchase/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.edit")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  const {
    voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
    packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
    discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
    total_deduction, round_off, net_amount_payable, employee_id, location_id, description
  } = req.body;

  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  if (mongoReady() && mongoose.Types.ObjectId.isValid(String(id))) {
    const payload = buildPurchasePayload(req.body, voucher_no);
    return PurchaseVoucher.findByIdAndUpdate(id, payload, { new: true })
      .then(async (doc) => {
        if (!doc) return res.status(404).json({ error: "Voucher not found" });
        const deductionDetails = buildPurchaseDeductionDetails(req.body);
        await PurchaseVoucher.collection.updateOne(
          { _id: doc._id },
          { $set: { claim_amount: Number(req.body.claim_amount || req.body.bags_claim || 0), other_deduction: Number(req.body.other_deduction || 0), cd_percent: Number(req.body.cd_percent || 0), cd_amount: Number(req.body.cd_amount || 0), adjustment_amount: Number(req.body.adjustment_amount || 0), tds_amount: Number(req.body.tds_amount || 0), deduction_details: deductionDetails, total_deduction: Number(req.body.total_deduction || 0) } }
        );
        res.json({ id: String(doc._id), _id: String(doc._id), message: "Voucher updated successfully", saved_to: "mongodb" });
      })
      .catch((err) => {
        if (err?.code === 11000) return res.status(400).json({ error: "Voucher number already exists" });
        res.status(500).json({ error: err.message });
      });
  }

  PurchaseVoucher.findOneAndUpdate(
    { id: Number(id) },
    {
      $set: {
        voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
        packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
        discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
        total_deduction, round_off, net_amount_payable, employee_id, location_id, description,
      },
    }
  )
    .then(() => res.json({ id, message: "Voucher updated successfully" }))
    .catch((err) => {
      if (String(err.message || "").includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
      return res.status(500).json({ error: err.message });
    });
});

// Delete purchase voucher
router.delete("/purchase/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.delete")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  if (mongoReady() && mongoose.Types.ObjectId.isValid(String(id))) {
    return PurchaseVoucher.findById(id)
      .then((doc) => {
        if (!doc) return res.status(404).json({ error: "Voucher not found" });
        if (!ensureWarehouseAccess(req, res, doc.warehouse_id)) return null;
        return PurchaseVoucher.deleteOne({ _id: id }).then(() => res.json({ message: "Voucher deleted successfully" }));
      })
      .catch((err) => res.status(500).json({ error: err.message }));
  }

  PurchaseVoucher.findOneAndDelete({ id: Number(id) })
    .then((deleted) => {
      if (!deleted) return res.status(404).json({ error: "Voucher not found" });
      res.json({ message: "Voucher deleted successfully" });
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

module.exports = router;

























