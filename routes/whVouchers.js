const express = require("express");
const router = express.Router();
const db = require("../db");
const { userHasPermission } = require("../middleware/auth");
const { assignedWarehouseFilter, canAccessWarehouse } = require("../helpers/access");
const PDFDocument = require('pdfkit');
const multer = require("multer");
const XLSX = require("xlsx");
const tradingFilterCache = new Map();
const TRADING_FILTER_CACHE_MS = 15 * 60 * 1000;

// Fast payment-edit/outstanding indexes. These are cheap SQLite indexes and
// prevent full-table scans when filtering by farmer + account + warehouse.
function ensurePaymentSqliteIndexes() {
  const statements = [
    `CREATE INDEX IF NOT EXISTS idx_wh_payment_farmer_account_warehouse ON wh_payment_vouchers(farmer_id, company_account_id, warehouse_id, date)`,
    `CREATE INDEX IF NOT EXISTS idx_wh_purchase_farmer_account_warehouse ON wh_purchase_vouchers(farmer_id, company_account_id, warehouse_id, date)`,
    `CREATE INDEX IF NOT EXISTS idx_wh_payment_adjustments_purchase_payment ON wh_payment_adjustments(purchase_id, payment_id)`,
  ];
  statements.forEach((sql) => db.run(sql, () => {}));
}
setImmediate(ensurePaymentSqliteIndexes);

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
  SqliteMirrorRow,
} = require("../mongo");

const upload = multer({ storage: multer.memoryStorage() });

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

function getWarehouseScopedRows(req, res, tableName, orderBy = "date DESC") {
  const filter = assignedWarehouseFilter(req.user, "v.warehouse_id");
  const query = `
    SELECT v.*, ca.account_name AS company_account_name
    FROM ${tableName} v
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
    WHERE 1 = 1 ${filter.clause}
    ORDER BY v.${orderBy}
  `;
  db.all(query, filter.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
}

function getSqliteSaleRowsForUser(user, options = {}) {
  const filter = assignedWarehouseFilter(user, "v.warehouse_id");
  const hasLimit = Number.isFinite(Number(options.limit));
  const queryParams = [...filter.params];
  if (hasLimit) {
    queryParams.push(Number(options.limit), Number(options.offset) || 0);
  }
  return dbAll(
    `
      SELECT
        v.*,
        COALESCE(v.buyer_id, v.company_id) AS buyer_id,
        b.name AS buyer_name,
        b.email AS buyer_email,
        b.mobile AS buyer_mobile,
        co.name AS consignee_name,
        co.email AS consignee_email,
        co.mobile AS consignee_mobile,
        ca.account_name AS company_account_name,
        w.name AS warehouse_name,
        p.name AS product_name,
        v.quantity AS total_quantity,
        v.amount AS total_amount
      FROM wh_sale_vouchers v
      LEFT JOIN buyer_names b ON CAST(b.id AS TEXT) = CAST(COALESCE(v.buyer_id, v.company_id) AS TEXT)
      LEFT JOIN consignee_names co ON CAST(co.id AS TEXT) = CAST(v.consignee_id AS TEXT)
      LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
      LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(v.warehouse_id AS TEXT)
      LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(v.product_id AS TEXT)
      WHERE 1 = 1 ${filter.clause}
      ORDER BY v.date DESC, v.id DESC
      ${hasLimit ? "LIMIT ? OFFSET ?" : ""}
    `,
    queryParams
  );
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

  if (options.search) {
    const safe = options.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(safe, "i");
    const fields = type === "purchase"
      ? ["voucher_no", "farmer_name", "product_name", "warehouse_name", "company_account_name", "description"]
      : ["voucher_no", "bill_no", "buyer_name", "company_name", "product_name", "warehouse_name", "company_account_name", "consignee_name", "lorry_no", "po_no", "description"];
    filter.$or = fields.map((field) => ({ [field]: rx }));
  }

  return filter;
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
  // Do not make the fast MongoDB Sale list wait for the legacy SQLite Bilti
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

function getSaleVoucherRowsSqlite(req, res) {
  const filter = assignedWarehouseFilter(req.user, "v.warehouse_id");
  const query = `
    SELECT
      v.*,
      COALESCE(v.buyer_id, v.company_id) AS buyer_id,
        b.name AS buyer_name,
        b.email AS buyer_email,
        b.mobile AS buyer_mobile,
        co.name AS consignee_name,
        co.email AS consignee_email,
        co.mobile AS consignee_mobile,
        ca.account_name AS company_account_name,
      w.name AS warehouse_name,
      p.name AS product_name,
      v.quantity AS total_quantity,
      v.amount AS total_amount,
      tb.bilti_id
    FROM wh_sale_vouchers v
    LEFT JOIN buyer_names b ON CAST(b.id AS TEXT) = CAST(COALESCE(v.buyer_id, v.company_id) AS TEXT)
    LEFT JOIN consignee_names co ON CAST(co.id AS TEXT) = CAST(v.consignee_id AS TEXT)
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
    LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(v.warehouse_id AS TEXT)
    LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(v.product_id AS TEXT)
    LEFT JOIN (
      SELECT sale_id, MAX(id) AS bilti_id
      FROM transport_bilti
      WHERE sale_id IS NOT NULL
      GROUP BY sale_id
    ) tb ON CAST(tb.sale_id AS TEXT) = CAST(v.id AS TEXT)
    WHERE 1 = 1 ${filter.clause}
    ORDER BY v.date DESC, v.id DESC
  `;
  db.all(query, filter.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json((rows || []).map((row) => ({
      ...row,
      ...calculateSaleFollowupMeta(row),
      id: String(row.id),
      _id: String(row.id),
    })));
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

  const purchaseQuery = `
    SELECT COALESCE(SUM(COALESCE(NULLIF(total_qty, 0), NULLIF(net_weight, 0), quantity, 0)), 0) AS purchase_qty
    FROM wh_purchase_vouchers
    WHERE CAST(warehouse_id AS TEXT) = CAST(? AS TEXT) AND CAST(product_id AS TEXT) = CAST(? AS TEXT)
  `;
  const saleQuery = `
    SELECT COALESCE(SUM(COALESCE(quantity, 0)), 0) AS sale_qty
    FROM wh_sale_vouchers
    WHERE CAST(warehouse_id AS TEXT) = CAST(? AS TEXT) AND CAST(product_id AS TEXT) = CAST(? AS TEXT)
    ${excludeSaleId ? "AND CAST(id AS TEXT) <> CAST(? AS TEXT)" : ""}
  `;
  const purchaseRow = await dbGet(purchaseQuery, [wId, pId]);
  const saleParams = excludeSaleId ? [wId, pId, String(excludeSaleId)] : [wId, pId];
  const saleRow = await dbGet(saleQuery, saleParams);
  const purchaseQty = Number(purchaseRow?.purchase_qty || 0);
  const saleQty = Number(saleRow?.sale_qty || 0);
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

function dbGet(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

async function getTransportBiltiMatch({ saleId, voucherNo = "", lorryNo = "" }) {
  const saleIdText = String(saleId || "").trim();
  const voucherNoText = String(voucherNo || "").trim();
  const lorryNoText = String(lorryNo || "").trim();

  if (mongoose.connection?.db && SqliteMirrorRow) {
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
      const doc = await SqliteMirrorRow.findOne({ table: "transport_bilti", ...filter })
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

  if (saleIdText) {
    const row = await dbGet(
      `
        SELECT tb.*, COALESCE(tb.payable_amount, tb.net_amount, tb.gross_freight, tb.transport_rate * tb.outward_qty, 0) AS transport_amount
        FROM transport_bilti tb
        WHERE CAST(tb.sale_id AS TEXT) = CAST(? AS TEXT)
        ORDER BY tb.id DESC
        LIMIT 1
      `,
      [saleIdText]
    );
    if (row) return { ...row, source: "sqlite-sale-id" };
  }

  if (voucherNoText || lorryNoText) {
    const row = await dbGet(
      `
        SELECT tb.*, COALESCE(tb.payable_amount, tb.net_amount, tb.gross_freight, tb.transport_rate * tb.outward_qty, 0) AS transport_amount
        FROM transport_bilti tb
        WHERE (
          CAST(tb.voucher_no AS TEXT) = CAST(? AS TEXT)
          OR CAST(tb.lorry_no AS TEXT) = CAST(? AS TEXT)
        )
        ORDER BY tb.id DESC
        LIMIT 1
      `,
      [voucherNoText, lorryNoText]
    );
    if (row) return { ...row, source: "sqlite-fallback" };
  }

  return null;
}

function dbRunPromise(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
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

  await dbRunPromise("DELETE FROM wh_journal_vouchers WHERE description LIKE ?", [`Auto sale deduction:${saleVoucherNo}:%`]);

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
    const result = await dbRunPromise(
      `
        INSERT INTO wh_journal_vouchers
          (voucher_no, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        voucherNo,
        journalBase.date,
        journalBase.warehouse_id,
        journalBase.company_account_id,
        "Sale Party",
        row.label,
        row.amount,
        journalBase.employee_id,
        journalBase.location_id,
        description,
      ]
    );
    created.push({ id: result.lastID, voucher_no: voucherNo, type: row.key, amount: row.amount });
  }

  return created;
}

function assignedWarehouseIdsForMongo(user) {
  const ids = user?.assigned_warehouse_ids || user?.assigned_sqlite_warehouse_ids || [];
  return ids.map((id) => String(id));
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
  const latest = await PurchaseVoucher.findOne({ voucher_no: new RegExp(`^${shortPrefix}-`) })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  let next = 1;
  if (latest?.voucher_no) {
    const pieces = String(latest.voucher_no).split("-");
    const last = Number(pieces[pieces.length - 1]);
    if (Number.isFinite(last) && last >= 1) next = last + 1;
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

async function sqliteRowsByIds(tableName, ids) {
  const cleanIds = [...new Set((ids || []).map((id) => String(id || "")).filter(Boolean))];
  if (!cleanIds.length) return new Map();
  const placeholders = cleanIds.map(() => "?").join(",");
  const rows = await dbAll(`SELECT * FROM ${tableName} WHERE CAST(id AS TEXT) IN (${placeholders})`, cleanIds);
  return new Map((rows || []).map((row) => [String(row.id), row]));
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

  const mirrorFilters = (table, ids) => ({
    table,
    row_id: { $in: ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0) },
  });

  // Reporting must never fail because one optional master/mirror collection is
  // unavailable. Every lookup is independent and has an empty fallback.
  const results = await Promise.allSettled([
    mongoWarehouseIds.length ? Warehouse.find({ _id: { $in: mongoWarehouseIds } }).lean() : Promise.resolve([]),
    mongoProductIds.length ? Product.find({ _id: { $in: mongoProductIds } }).lean() : Promise.resolve([]),
    mongoAccountIds.length ? CompanyAccount.find({ _id: { $in: mongoAccountIds } }).lean() : Promise.resolve([]),
    buyerIds.length ? SqliteMirrorRow.find(mirrorFilters("buyer_names", buyerIds)).lean() : Promise.resolve([]),
    consigneeIds.length ? SqliteMirrorRow.find(mirrorFilters("consignee_names", consigneeIds)).lean() : Promise.resolve([]),
    // Some Sale vouchers still contain the legacy SQLite buyer id directly.
    // Read buyer_names by TEXT id as a reliable fallback so the Sale Party
    // Ledger never shows a blank party merely because the mirror row is stale.
    buyerIds.length
      ? dbAll(`SELECT * FROM buyer_names WHERE CAST(id AS TEXT) IN (${buyerIds.map(() => "?").join(",")})`, buyerIds)
      : Promise.resolve([]),
  ]);

  const valueAt = (index) => results[index].status === "fulfilled" && Array.isArray(results[index].value) ? results[index].value : [];
  results.forEach((result, index) => {
    if (result.status === "rejected") console.warn(`Sale row lookup ${index} skipped:`, result.reason?.message || result.reason);
  });

  const byMongoId = (items) => new Map(items.map((item) => [String(item?._id), item]));
  const byMirrorId = (items) => new Map(items.map((item) => [String(item?.row_id), item?.data || {}]));
  const mongoWarehouseMap = byMongoId(valueAt(0));
  const mongoProductMap = byMongoId(valueAt(1));
  const mongoAccountMap = byMongoId(valueAt(2));
  const buyerMap = byMirrorId(valueAt(3));
  const consigneeMap = byMirrorId(valueAt(4));
  const sqliteBuyerMap = new Map(
    valueAt(5).map((item) => [String(item?.id || ""), item]).filter(([id]) => id)
  );

  return plainRows.map((plain) => {
    const buyerId = String(plain?.buyer_id || plain?.company_id || "");
    const warehouse = mongoWarehouseMap.get(String(plain?.warehouse_id || ""));
    const product = mongoProductMap.get(String(plain?.product_id || ""));
    const account = mongoAccountMap.get(String(plain?.company_account_id || ""));
    const buyer = buyerMap.get(buyerId) || sqliteBuyerMap.get(buyerId) || {};
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

function mergeSaleRows(mongoRows, sqliteRows) {
  const mongoByVoucherNo = new Map();
  const merged = [];

  for (const row of mongoRows) {
    const key = String(row.voucher_no || row._id || "");
    if (key) mongoByVoucherNo.set(key, row);
    merged.push(row);
  }

  for (const row of sqliteRows) {
    const key = String(row.voucher_no || row.id || "");
    if (!key || !mongoByVoucherNo.has(key)) {
      merged.push(row);
    }
  }

  return merged.sort((a, b) => {
    const dateA = new Date(a.date || a.created_at || 0).getTime();
    const dateB = new Date(b.date || b.created_at || 0).getTime();
    if (dateA !== dateB) return dateB - dateA;
    return String(b.voucher_no || b.id || b._id || "").localeCompare(String(a.voucher_no || a.id || a._id || ""), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

async function attachSaleBiltiIds(rows) {
  const saleIds = [...new Set((rows || []).map((row) => String(row.id || row._id).trim()).filter(Boolean))];
  if (!saleIds.length) return rows;

  try {
    const placeholders = saleIds.map(() => "?").join(",");
    const biltiRows = await dbAll(
      `SELECT sale_id, MAX(id) AS bilti_id FROM transport_bilti WHERE sale_id IS NOT NULL AND CAST(sale_id AS TEXT) IN (${placeholders}) GROUP BY sale_id`,
      saleIds
    );

    const biltiMap = new Map((biltiRows || []).map((row) => [String(row.sale_id), row.bilti_id]));
    return rows.map((row) => ({
      ...row,
      bilti_id: biltiMap.get(String(row.id || row._id)) || null,
    }));
  } catch (err) {
    console.warn("Optional sale Bilti lookup skipped:", err?.message || err);
    return rows;
  }
}

function getSqlitePurchaseRows(req) {
  const filter = assignedWarehouseFilter(req.user, "v.warehouse_id");
  const fallbackFilter = assignedWarehouseFilter(req.user, "warehouse_id");
  const query = `
    SELECT
      v.*,
      (SELECT name FROM products WHERE CAST(id AS TEXT) = CAST(v.product_id AS TEXT) LIMIT 1) AS product_name,
      (SELECT name FROM warehouses WHERE CAST(id AS TEXT) = CAST(v.warehouse_id AS TEXT) LIMIT 1) AS warehouse_name,
      (SELECT name FROM farmers WHERE CAST(id AS TEXT) = CAST(v.farmer_id AS TEXT) LIMIT 1) AS farmer_name,
      ca.account_name AS company_account_name
    FROM wh_purchase_vouchers v
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
    WHERE 1 = 1 ${filter.clause}
    ORDER BY v.date DESC, v.id DESC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, filter.params, (err, rows) => {
      if (!err) {
        resolve(rows || []);
        return;
      }

      console.error("Purchase voucher mapped query failed, falling back to base rows:", err.message);
      const fallbackQuery = `
        SELECT *
        FROM wh_purchase_vouchers
        WHERE 1 = 1 ${fallbackFilter.clause}
        ORDER BY date DESC, id DESC
      `;
      db.all(fallbackQuery, fallbackFilter.params, (fallbackErr, fallbackRows) => {
        if (fallbackErr) {
          reject(fallbackErr);
          return;
        }
        resolve(fallbackRows || []);
      });
    });
  });
}

function mergePurchaseRows(mongoRows, sqliteRows) {
  const mongoByVoucherNo = new Map();
  const merged = [];

  for (const row of mongoRows) {
    const key = String(row.voucher_no || row._id || "");
    if (key) mongoByVoucherNo.set(key, row);
    merged.push(row);
  }

  for (const row of sqliteRows) {
    const key = String(row.voucher_no || row.id || "");
    if (!key || !mongoByVoucherNo.has(key)) {
      merged.push(row);
    }
  }

  return merged.sort((a, b) => {
    const dateA = new Date(a.date || a.created_at || 0).getTime();
    const dateB = new Date(b.date || b.created_at || 0).getTime();
    if (dateA !== dateB) return dateB - dateA;
    const voucherA = String(a.voucher_no || a.id || a._id || "");
    const voucherB = String(b.voucher_no || b.id || b._id || "");
    return voucherB.localeCompare(voucherA, undefined, { numeric: true, sensitivity: "base" });
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

function getPurchaseVoucherRowsSqlite(req, res) {
  const filter = assignedWarehouseFilter(req.user, "v.warehouse_id");
  const fallbackFilter = assignedWarehouseFilter(req.user, "warehouse_id");
  const query = `
    SELECT
      v.*,
      (SELECT name FROM products WHERE CAST(id AS TEXT) = CAST(v.product_id AS TEXT) LIMIT 1) AS product_name,
      (SELECT name FROM warehouses WHERE CAST(id AS TEXT) = CAST(v.warehouse_id AS TEXT) LIMIT 1) AS warehouse_name,
      (SELECT name FROM farmers WHERE CAST(id AS TEXT) = CAST(v.farmer_id AS TEXT) LIMIT 1) AS farmer_name,
      ca.account_name AS company_account_name
    FROM wh_purchase_vouchers v
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
    WHERE 1 = 1 ${filter.clause}
    ORDER BY v.date DESC, v.id DESC
  `;

  db.all(query, filter.params, (err, rows) => {
    if (!err) {
      return res.json(rows || []);
    }

    console.error("Purchase voucher mapped query failed, falling back to base rows:", err.message);
    const fallbackQuery = `
      SELECT *
      FROM wh_purchase_vouchers
      WHERE 1 = 1 ${fallbackFilter.clause}
      ORDER BY date DESC, id DESC
    `;
    db.all(fallbackQuery, fallbackFilter.params, (fallbackErr, fallbackRows) => {
      if (fallbackErr) return res.status(500).json({ error: fallbackErr.message });
      res.json(fallbackRows || []);
    });
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
  const table = getVoucherTable(type);
  if (!table) return callback(new Error("Invalid voucher type"));
  const shortPrefix = getVoucherPrefix(type);
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `${shortPrefix}-${datePart}-`;
  const query = `SELECT voucher_no FROM ${table} WHERE voucher_no LIKE ? ORDER BY id DESC LIMIT 1`;
  db.get(query, [`${shortPrefix}-%`], (err, row) => {
    if (err) return callback(err);
    let next = 1;
    if (row && row.voucher_no) {
      const pieces = String(row.voucher_no).split("-");
      const last = Number(pieces[pieces.length - 1]);
      if (Number.isFinite(last) && last >= 1) next = last + 1;
    }
    callback(null, `${prefix}${String(next).padStart(4, "0")}`);
  });
}

function computeOutstandingForFarmer(farmerId, callback, companyAccountId = null) {
  const farmerKey = String(farmerId || "").trim();
  const accountKey = String(companyAccountId || "").trim();
  if (!farmerKey) return callback(null, { total_purchase: 0, total_payment: 0, outstanding: 0 });

  const paymentParams = [farmerKey];
  const paymentWhere = ["CAST(farmer_id AS TEXT) = CAST(? AS TEXT)"];
  if (accountKey) {
    paymentWhere.push("CAST(company_account_id AS TEXT) = CAST(? AS TEXT)");
    paymentParams.push(accountKey);
  }

  const finish = (totalPurchase) => {
    db.get(
      `SELECT COALESCE(SUM(amount), 0) AS total_payment FROM wh_payment_vouchers WHERE ${paymentWhere.join(" AND ")}`,
      paymentParams,
      (err2, payment) => {
        if (err2) return callback(err2);
        const totalPayment = Number(payment?.total_payment || 0);
        callback(null, {
          total_purchase: Number(totalPurchase || 0),
          total_payment: totalPayment,
          outstanding: Number((Number(totalPurchase || 0) - totalPayment).toFixed(2)),
        });
      }
    );
  };

  if (mongoReady()) {
    const filter = { farmer_id: farmerKey };
    if (accountKey) filter.company_account_id = accountKey;
    PurchaseVoucher.aggregate([
      { $match: filter },
      { $group: { _id: null, total_purchase: { $sum: { $ifNull: ["$net_amount_payable", { $ifNull: ["$amount", 0] }] } } } },
    ])
      .then((rows) => finish(Number(rows?.[0]?.total_purchase || 0)))
      .catch(callback);
    return;
  }

  const purchaseParams = [farmerKey];
  const purchaseWhere = ["CAST(farmer_id AS TEXT) = CAST(? AS TEXT)"];
  if (accountKey) {
    purchaseWhere.push("CAST(company_account_id AS TEXT) = CAST(? AS TEXT)");
    purchaseParams.push(accountKey);
  }
  db.get(
    `SELECT COALESCE(SUM(COALESCE(NULLIF(net_amount_payable, 0), amount)), 0) AS total_purchase FROM wh_purchase_vouchers WHERE ${purchaseWhere.join(" AND ")}`,
    purchaseParams,
    (err, purchase) => {
      if (err) return callback(err);
      finish(Number(purchase?.total_purchase || 0));
    }
  );
}

function computeOutstandingForCompany(companyId, callback, companyAccountId = null) {
  const receiptSql = `SELECT COALESCE(SUM(amount), 0) AS total_receipt FROM wh_receipt_vouchers WHERE company_id = ?${companyAccountId ? " AND CAST(company_account_id AS TEXT) = CAST(? AS TEXT)" : ""}`;
  const receiptParams = [companyId];
  if (companyAccountId) {
    receiptParams.push(companyAccountId);
  }

  const finish = (totalSale) => {
    db.get(receiptSql, receiptParams, (err2, receipt) => {
      if (err2) return callback(err2);
      const totalReceipt = receipt?.total_receipt || 0;
      callback(null, {
        total_sale: totalSale,
        total_receipt: totalReceipt,
        outstanding: Number((totalSale - totalReceipt).toFixed(2)),
      });
    });
  };

  if (mongoReady()) {
    const filter = {
      $or: [
        { buyer_id: String(companyId) },
        { company_id: String(companyId) },
      ],
    };
    if (companyAccountId) filter.company_account_id = String(companyAccountId);
    return SaleVoucher.find(filter)
      .lean()
      .then((rows) => {
        const totalSale = (rows || []).reduce(
          (sum, row) => sum + Number(row.net_receivable_amount || row.amount || 0),
          0
        );
        finish(totalSale);
      })
      .catch(callback);
  }

  const saleSql = `SELECT COALESCE(SUM(COALESCE(NULLIF(net_receivable_amount, 0), amount)), 0) AS total_sale FROM wh_sale_vouchers WHERE CAST(COALESCE(buyer_id, company_id) AS TEXT) = CAST(? AS TEXT)${companyAccountId ? " AND CAST(company_account_id AS TEXT) = CAST(? AS TEXT)" : ""}`;
  const saleParams = [companyId];
  if (companyAccountId) {
    saleParams.push(companyAccountId);
  }
  db.get(saleSql, saleParams, (err, sale) => {
    if (err) return callback(err);
    finish(sale?.total_sale || 0);
  });
}

function createVoucherNoIfMissing(type, voucherNo, callback) {
  if (voucherNo && String(voucherNo).trim()) return callback(null, voucherNo);
  if (type === "purchase" && mongoReady()) {
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
function getIdempotency(key, route, cb) {
  if (!key) return cb(null, null);
  db.get(`SELECT response_id FROM idempotency_keys WHERE key = ? AND route = ?`, [key, route], (err, row) => {
    if (err) return cb(err);
    cb(null, row ? row.response_id : null);
  });
}

function saveIdempotency(key, route, responseId, cb) {
  if (!key) return cb && cb();
  db.run(
    `INSERT OR REPLACE INTO idempotency_keys (key, route, response_id, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
    [key, route, responseId],
    (err) => cb && cb(err)
  );
}

function getPaymentAdjustmentsByPurchase(callback, excludePaymentId = null) {
  const params = [];
  let excludeClause = "";
  if (excludePaymentId) {
    excludeClause = "WHERE CAST(payment_id AS TEXT) <> CAST(? AS TEXT)";
    params.push(excludePaymentId);
  }
  db.all(
    `
      SELECT purchase_id, COALESCE(SUM(adjusted_amount), 0) AS adjusted_amount
      FROM wh_payment_adjustments
      ${excludeClause}
      GROUP BY purchase_id
    `,
    params,
    (err, rows) => {
      if (err) return callback(err);
      const map = new Map();
      (rows || []).forEach((row) => {
        map.set(String(row.purchase_id), Number(row.adjusted_amount || 0));
      });
      callback(null, map);
    }
  );
}

function getReceiptAdjustmentsBySale(callback, excludeReceiptId = null) {
  const params = [];
  let excludeClause = "";
  if (excludeReceiptId) {
    excludeClause = "WHERE CAST(receipt_id AS TEXT) <> CAST(? AS TEXT)";
    params.push(excludeReceiptId);
  }
  db.all(
    `
      SELECT sale_id, COALESCE(SUM(adjusted_amount), 0) AS adjusted_amount
      FROM wh_receipt_adjustments
      ${excludeClause}
      GROUP BY sale_id
    `,
    params,
    (err, rows) => {
      if (err) return callback(err);
      const map = new Map();
      (rows || []).forEach((row) => {
        map.set(String(row.sale_id), Number(row.adjusted_amount || 0));
      });
      callback(null, map);
    }
  );
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
        if (rawId) ors.push({ voucher_no: rawId });
        if (voucher) ors.push({ voucher_no: voucher });

        let purchase = null;
        if (ors.length) {
          purchase = await PurchaseVoucher.findOne({ $or: ors })
            .select("_id voucher_no farmer_id warehouse_id net_amount_payable amount")
            .lean();
        }

        let legacyPurchase = null;
        if (!purchase) {
          legacyPurchase = await dbGet(
            `SELECT id, voucher_no, farmer_id, warehouse_id, COALESCE(NULLIF(net_amount_payable, 0), amount) AS amount
             FROM wh_purchase_vouchers
             WHERE CAST(id AS TEXT) = CAST(? AS TEXT) OR CAST(voucher_no AS TEXT) = CAST(? AS TEXT)
             LIMIT 1`,
            [rawId, voucher]
          );
          if (legacyPurchase && legacyPurchase.voucher_no) {
            purchase = await PurchaseVoucher.findOne({ voucher_no: String(legacyPurchase.voucher_no).trim() })
              .select("_id voucher_no farmer_id warehouse_id net_amount_payable amount")
              .lean();
          }
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
          const legacyId = legacyPurchase?.id ? String(legacyPurchase.id) : "";
          const billAmount = Number(purchase.net_amount_payable || purchase.amount || 0);
          const alreadyAdjusted = Number(adjustedMap.get(mongoId) || 0) + (legacyId && legacyId !== mongoId ? Number(adjustedMap.get(legacyId) || 0) : 0);
          const pending = Math.max(0, billAmount - alreadyAdjusted);
          if (item.adjusted_amount - pending > 0.0001) {
            throw new Error(`Adjustment cannot exceed pending amount for ${purchase.voucher_no || mongoId}`);
          }
          resolved.push({ purchase_id: mongoId, voucher_no: purchase.voucher_no || voucher, adjusted_amount: item.adjusted_amount });
          continue;
        }

        if (legacyPurchase) {
          const purchaseId = String(legacyPurchase.id);
          if (legacyPurchase.farmer_id && String(legacyPurchase.farmer_id) !== String(farmerId || "")) {
            throw new Error(`Purchase bill ${legacyPurchase.voucher_no || purchaseId} belongs to a different farmer`);
          }
          if (warehouseId && legacyPurchase.warehouse_id && String(legacyPurchase.warehouse_id) !== String(warehouseId)) {
            throw new Error(`Purchase bill ${legacyPurchase.voucher_no || purchaseId} belongs to a different warehouse`);
          }
          const billAmount = Number(legacyPurchase.amount || 0);
          const alreadyAdjusted = Number(adjustedMap.get(purchaseId) || 0);
          const pending = Math.max(0, billAmount - alreadyAdjusted);
          if (item.adjusted_amount - pending > 0.0001) {
            throw new Error(`Adjustment cannot exceed pending amount for ${legacyPurchase.voucher_no || purchaseId}`);
          }
          resolved.push({ purchase_id: purchaseId, voucher_no: legacyPurchase.voucher_no || voucher, adjusted_amount: item.adjusted_amount });
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

    const params = [farmerId];
    let warehouseClause = "";
    if (warehouseId) {
      warehouseClause = " AND CAST(warehouse_id AS TEXT) = CAST(? AS TEXT)";
      params.push(warehouseId);
    }
    db.all(
      `SELECT id, voucher_no, COALESCE(NULLIF(net_amount_payable, 0), amount) AS amount
       FROM wh_purchase_vouchers
       WHERE CAST(farmer_id AS TEXT) = CAST(? AS TEXT) ${warehouseClause}`,
      params,
      (rowsErr, rows) => {
        if (rowsErr) return callback(rowsErr);
        const purchaseMap = new Map();
        (rows || []).forEach((row) => {
          purchaseMap.set(`id:${String(row.id)}`, row);
          if (row.voucher_no) purchaseMap.set(`voucher:${String(row.voucher_no)}`, row);
        });
        const resolved = [];
        for (const item of cleanAdjustments) {
          const rawId = String(item.purchase_id || "").trim();
          const voucher = String(item.voucher_no || "").trim();
          const purchase = purchaseMap.get(`id:${rawId}`) || (voucher ? purchaseMap.get(`voucher:${voucher}`) : null);
          if (!purchase) return callback(new Error(`Invalid purchase adjustment target: ${rawId || voucher}`));
          const purchaseId = String(purchase.id);
          const billAmount = Number(purchase.amount || 0);
          const alreadyAdjusted = Number(adjustedMap.get(purchaseId) || 0);
          const pending = Math.max(0, billAmount - alreadyAdjusted);
          if (item.adjusted_amount - pending > 0.0001) return callback(new Error(`Adjustment cannot exceed pending amount for ${purchase.voucher_no || purchaseId}`));
          resolved.push({ purchase_id: purchaseId, voucher_no: purchase.voucher_no || voucher, adjusted_amount: item.adjusted_amount });
        }
        callback(null, resolved);
      }
    );
  }, excludePaymentId);
}

function insertPaymentAdjustments(paymentId, adjustments, callback) {
  if (!adjustments.length) return callback();
  const stmt = "INSERT INTO wh_payment_adjustments (payment_id, purchase_id, adjusted_amount) VALUES (?, ?, ?)";
  let index = 0;
  const next = () => {
    if (index >= adjustments.length) return callback();
    const item = adjustments[index];
    index += 1;
    db.run(stmt, [paymentId, item.purchase_id, item.adjusted_amount], (err) => (err ? callback(err) : next()));
  };
  next();
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
          if (!sale) {
            const legacy = await dbGet(`SELECT id, voucher_no, COALESCE(NULLIF(net_receivable_amount, 0), amount) AS amount FROM wh_sale_vouchers WHERE CAST(id AS TEXT)=CAST(? AS TEXT) OR CAST(voucher_no AS TEXT)=CAST(? AS TEXT) LIMIT 1`, [rawId, String(item.voucher_no || "")]);
            if (!legacy) throw new Error(`Invalid sale adjustment target: ${rawId || item.voucher_no || ""}`);
            const legacyPending = Math.max(0, Number(legacy.amount || 0) - Number(adjustedMap.get(String(legacy.id)) || 0));
            if (item.adjusted_amount - legacyPending > 0.0001) throw new Error(`Adjustment cannot exceed pending amount for ${legacy.voucher_no || legacy.id}`);
            resolved.push({ sale_id: String(legacy.id), voucher_no: legacy.voucher_no || item.voucher_no || "", adjusted_amount: item.adjusted_amount });
            continue;
          }
          const saleId = String(sale._id);
          const billAmount = Number(sale.net_receivable_amount || sale.amount || 0);
          const pending = Math.max(0, billAmount - Number(adjustedMap.get(saleId) || 0));
          if (item.adjusted_amount - pending > 0.0001) throw new Error(`Adjustment cannot exceed pending amount for ${sale.voucher_no || saleId}`);
          resolved.push({ sale_id: saleId, voucher_no: sale.voucher_no || item.voucher_no || "", adjusted_amount: item.adjusted_amount });
        }
        callback(null, resolved);
      }).catch(callback);
    }

    const params = [companyId];
    db.all(`SELECT id, voucher_no, COALESCE(NULLIF(net_receivable_amount, 0), amount) AS amount FROM wh_sale_vouchers WHERE CAST(COALESCE(buyer_id, company_id) AS TEXT)=CAST(? AS TEXT)`, params, (rowsErr, sales) => {
      if (rowsErr) return callback(rowsErr);
      const saleMap = new Map((sales || []).map((row) => [String(row.id), row]));
      (sales || []).forEach((row) => row.voucher_no && saleMap.set(`voucher:${row.voucher_no}`, row));
      const resolved = [];
      for (const item of cleanAdjustments) {
        const sale = saleMap.get(String(item.sale_id)) || saleMap.get(`voucher:${item.voucher_no || ""}`);
        if (!sale) return callback(new Error(`Invalid sale adjustment target: ${item.sale_id || item.voucher_no || ""}`));
        const pending = Math.max(0, Number(sale.amount || 0) - Number(adjustedMap.get(String(sale.id)) || 0));
        if (item.adjusted_amount - pending > 0.0001) return callback(new Error(`Adjustment cannot exceed pending amount for ${sale.voucher_no || sale.id}`));
        resolved.push({ sale_id: String(sale.id), voucher_no: sale.voucher_no || item.voucher_no || "", adjusted_amount: item.adjusted_amount });
      }
      callback(null, resolved);
    });
  }, excludeReceiptId);
}

function insertReceiptAdjustments(receiptId, adjustments, callback) {
  if (!adjustments.length) return callback();
  const stmt = "INSERT INTO wh_receipt_adjustments (receipt_id, sale_id, adjusted_amount) VALUES (?, ?, ?)";
  let index = 0;
  const next = () => {
    if (index >= adjustments.length) return callback();
    const item = adjustments[index];
    index += 1;
    db.run(stmt, [receiptId, item.sale_id, item.adjusted_amount], (err) => (err ? callback(err) : next()));
  };
  next();
}

function buildReceiptReferenceId(adjustments, saleRows = []) {
  const saleMap = new Map((saleRows || []).map((row) => [String(row.id), row]));
  return normalizeReceiptAdjustments(adjustments)
    .map((item) => item.voucher_no || saleMap.get(String(item.sale_id))?.voucher_no || item.sale_id)
    .filter(Boolean)
    .join(", ");
}

function getPaymentRowsForUser(req, res) {
  const filter = assignedWarehouseFilter(req.user, "p.warehouse_id");
  const query = `
    SELECT p.*, ca.account_name AS company_account_name, f.name AS farmer_name
    FROM wh_payment_vouchers p
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(p.company_account_id AS TEXT)
    LEFT JOIN farmers f ON CAST(f.id AS TEXT) = CAST(p.farmer_id AS TEXT)
    WHERE 1 = 1 ${filter.clause}
    ORDER BY p.date DESC, p.id DESC
  `;
  db.all(query, filter.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const paymentRows = rows || [];
    if (!paymentRows.length) return res.json([]);
    const ids = paymentRows.map((row) => row.id);
    db.all(
      `
        SELECT a.*, pv.voucher_no AS purchase_voucher_no
        FROM wh_payment_adjustments a
        LEFT JOIN wh_purchase_vouchers pv ON CAST(pv.id AS TEXT) = CAST(a.purchase_id AS TEXT)
        WHERE a.payment_id IN (${ids.map(() => "?").join(",")})
        ORDER BY a.id ASC
      `,
      ids,
      async (adjErr, adjustmentRows) => {
        if (adjErr) return res.status(500).json({ error: adjErr.message });
        let mongoPurchaseMap = new Map();
        if (mongoReady()) {
          const mongoPurchaseIds = [...new Set((adjustmentRows || [])
            .map((row) => String(row.purchase_id || ""))
            .filter((id) => mongoose.Types.ObjectId.isValid(id)))];
          if (mongoPurchaseIds.length) {
            try {
              const mongoPurchases = await PurchaseVoucher.find({ _id: { $in: mongoPurchaseIds } }).lean();
              mongoPurchaseMap = new Map((mongoPurchases || []).map((row) => [String(row._id), row]));
            } catch (mongoErr) {
              console.error("Payment adjustment purchase lookup failed:", mongoErr.message);
            }
          }
        }
        const byPayment = new Map();
        (adjustmentRows || []).forEach((row) => {
          const paymentId = String(row.payment_id);
          const mongoPurchase = mongoPurchaseMap.get(String(row.purchase_id));
          if (!byPayment.has(paymentId)) byPayment.set(paymentId, []);
          byPayment.get(paymentId).push({
            ...row,
            voucher_no: row.purchase_voucher_no || mongoPurchase?.voucher_no || row.purchase_id,
            purchase_voucher_no: row.purchase_voucher_no || mongoPurchase?.voucher_no || row.purchase_id,
          });
        });
        res.json(paymentRows.map((row) => {
          const adjustments = byPayment.get(String(row.id)) || [];
          const adjustmentDetails = adjustments
            .filter((item) => item.purchase_voucher_no && item.adjusted_amount)
            .map((item) => `${item.purchase_voucher_no}: ${fmtNum(item.adjusted_amount)}`)
            .join(", ");
          return {
            ...row,
            party_name: row.company_account_name || row.farmer_name || "-",
            adjustments,
            reference_type: row.reference_type || "purchase",
            reference_id: row.reference_id || adjustmentDetails || adjustments.map((item) => item.purchase_voucher_no).filter(Boolean).join(", "),
          };
        }));
      }
    );
  });
}

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
  const query = `
    SELECT
      v.*,
      (SELECT name FROM products WHERE CAST(id AS TEXT) = CAST(v.product_id AS TEXT) LIMIT 1) AS product_name,
      (SELECT name FROM warehouses WHERE CAST(id AS TEXT) = CAST(v.warehouse_id AS TEXT) LIMIT 1) AS warehouse_name,
      (SELECT name FROM farmers WHERE CAST(id AS TEXT) = CAST(v.farmer_id AS TEXT) LIMIT 1) AS farmer_name,
      ca.account_name AS company_account_name
    FROM wh_purchase_vouchers v
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
    WHERE CAST(v.id AS TEXT) = ?
    LIMIT 1
  `;

  db.get(query, [id], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) {
      if (mongoReady() && mongoose.Types.ObjectId.isValid(String(id))) {
        try {
          const purchase = await PurchaseVoucher.findById(id).lean();
          if (purchase) {
            const [decorated] = await decoratePurchaseRows([purchase]);
            row = decorated || null;
          }
        } catch (mongoErr) {
          console.error("Mongo purchase lookup failed:", mongoErr.message);
        }
      }
    }

    if (!row) {
      const legacyQuery = `
        SELECT
          t.*, 
          w.name AS warehouse_name,
          f.name AS farmer_name,
          p.name AS product_name,
          t.quantity AS total_quantity,
          t.amount AS total_amount,
          t.amount AS net_amount_payable,
          1 AS legacy_purchase_entry
        FROM warehouse_trading_entries t
        LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(t.warehouse_id AS TEXT)
        LEFT JOIN farmers f ON CAST(f.id AS TEXT) = CAST(t.farmer_id AS TEXT)
        LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(t.product_id AS TEXT)
        WHERE LOWER(COALESCE(t.transaction_type, '')) = 'purchase' AND CAST(t.id AS TEXT) = ?
        LIMIT 1
      `;

      return db.get(legacyQuery, [id], (legacyErr, legacyRow) => {
        if (legacyErr) return res.status(500).json({ error: legacyErr.message });
        if (!legacyRow) return res.status(404).json({ error: "Purchase voucher not found" });
        if (!ensureWarehouseAccess(req, res, legacyRow.warehouse_id)) return;

        return res.json({
          ...legacyRow,
          id: String(legacyRow.id || legacyRow._id || id),
          _id: String(legacyRow._id || legacyRow.id || id),
        });
      });
    }

    if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;

    return res.json({
      ...row,
      id: String(row.id || row._id),
      _id: String(row._id || row.id || id),
    });
  });
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

        const paymentId = await new Promise((resolve, reject) => {
          db.run(
            `INSERT INTO wh_payment_vouchers (voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, employee_id, location_id, description)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [insertData.voucher_no, insertData.date, insertData.warehouse_id, insertData.farmer_id, insertData.company_account_id, insertData.amount, insertData.reference_type, insertData.reference_id, insertData.employee_id, insertData.location_id, insertData.description],
            function (err) {
              if (err) return reject(err);
              resolve(this.lastID);
            }
          );
        });

        await new Promise((resolve, reject) => {
          insertPaymentAdjustments(paymentId, cleanAdjustments, (adjErr) => (adjErr ? reject(adjErr) : resolve()));
        });

        const stats = await new Promise((resolve, reject) => {
          computeOutstandingForFarmer(String(farmer._id || farmer.id), (err2, statsData) => (err2 ? reject(err2) : resolve(statsData)));
        });

        await new Promise((resolve, reject) => {
          db.run("UPDATE wh_payment_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, paymentId], (updateErr) => (updateErr ? reject(updateErr) : resolve()));
        });

        imported.push({ row: rowNo, id: paymentId, voucher_no: voucherNo });
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

  const query = `
    INSERT INTO wh_purchase_vouchers (
      voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
      packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
      discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
      total_deduction, round_off, net_amount_payable, employee_id, location_id, description
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const idemKey = req.get("Idempotency-Key") || req.headers["idempotency-key"];
  if (idemKey) {
    return getIdempotency(idemKey, "purchase", (err, existingId) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existingId) {
        return db.get(`SELECT * FROM wh_purchase_vouchers WHERE id = ?`, [existingId], (e2, existingRow) => {
          if (e2) return res.status(500).json({ error: e2.message });
          return res.json({ id: existingRow.id, voucher_no: existingRow.voucher_no, existing: existingRow });
        });
      }

      createVoucherNoIfMissing("purchase", voucher_no, (err, generatedVoucherNo) => {
        if (err) return res.status(500).json({ error: err.message });

        const query = `
          INSERT INTO wh_purchase_vouchers (
            voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
            packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
            discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
            total_deduction, round_off, net_amount_payable, employee_id, location_id, description
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [
          generatedVoucherNo,
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
        ], function (err) {
          if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }
          saveIdempotency(idemKey, "purchase", this.lastID, () => {});
          res.json({ id: this.lastID, voucher_no: generatedVoucherNo });
        });
      });
    });
  }

  // no idempotency key, proceed normally
  createVoucherNoIfMissing("purchase", voucher_no, (err, generatedVoucherNo) => {
    if (err) return res.status(500).json({ error: err.message });

    const query = `
      INSERT INTO wh_purchase_vouchers (
        voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
        packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
        discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
        total_deduction, round_off, net_amount_payable, employee_id, location_id, description
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [
      generatedVoucherNo,
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
    ], function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, voucher_no: generatedVoucherNo });
    });
  });
});

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
    paymentsQuery = `SELECT id, voucher_no, date, warehouse_id, location_id, amount FROM wh_payment_vouchers WHERE farmer_id = ? ${paymentFilters.length ? `AND ${paymentFilters.join(" AND ")}` : ""} ORDER BY date ASC`;
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

          db.all(paymentsQuery, paymentParams, (err3, payments) => {
            if (err3) return res.status(500).json({ error: err3.message });
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
          });
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

        detailsQuery = `SELECT id, voucher_no, date, warehouse_id, location_id, COALESCE(NULLIF(net_amount_payable, 0), amount) AS amount FROM wh_purchase_vouchers WHERE farmer_id = ? ${filters.slice(1).length ? `AND ${filters.slice(1).join(" AND ")}` : ""} ORDER BY date ASC`;
        db.all(detailsQuery, params, (err2, purchases) => {
          if (err2) return res.status(500).json({ error: err2.message });
          send(purchases || []);
        });
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
      if (mongoReady()) {
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
          })))).catch(callback);
      }

      detailsQuery = `SELECT id, voucher_no, date, warehouse_id, location_id, COALESCE(NULLIF(net_receivable_amount, 0), amount) AS amount FROM wh_sale_vouchers WHERE CAST(COALESCE(buyer_id, company_id) AS TEXT) = CAST(? AS TEXT) ${filters.slice(1).length ? `AND ${filters.slice(1).join(" AND ")}` : ""} ORDER BY date ASC`;
      db.all(detailsQuery, params, (err2, sales) => (err2 ? callback(err2) : callback(null, sales || [])));
    };

    paymentsQuery = `SELECT id, voucher_no, date, warehouse_id, location_id, amount FROM wh_receipt_vouchers WHERE company_id = ? ${filters.slice(1).length ? `AND ${filters.slice(1).join(" AND ")}` : ""} ORDER BY date ASC`;
    computeOutstandingForCompany(id, (err, stats) => {
      if (err) return res.status(500).json({ error: err.message });
      getReceiptAdjustmentsBySale((adjustErr, adjustedMap) => {
        if (adjustErr) return res.status(500).json({ error: adjustErr.message });

        getSaleRows((err2, sales) => {
          if (err2) return res.status(500).json({ error: err2.message });

          const receiptsFilter = filters.slice(1).length ? `AND ${filters.slice(1).join(" AND ")}` : "";
          const receiptExcludeClause = exclude_payment_id ? `AND CAST(id AS TEXT) <> CAST(? AS TEXT)` : "";
          const receiptParams = [...params];
          if (exclude_payment_id) receiptParams.push(exclude_payment_id);
          const receiptsQuery = `${paymentsQuery} ${receiptExcludeClause}`.trim();

          db.all(receiptsQuery, receiptParams, (err3, receipts) => {
            if (err3) return res.status(500).json({ error: err3.message });

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

            res.json({ party_type: "company", id, stats, sales: decoratedSales, receipts });
          });
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

    // One SQL GROUP BY replaces one payment query per farmer.
    const placeholders = farmerIds.map(() => "?").join(",");
    const paymentParams = [...farmerIds, accountKey];
    const paymentWhere = [
      `CAST(farmer_id AS TEXT) IN (${placeholders})`,
      `CAST(company_account_id AS TEXT) = CAST(? AS TEXT)`,
    ];
    if (warehouseKey) {
      paymentWhere.push(`CAST(warehouse_id AS TEXT) = CAST(? AS TEXT)`);
      paymentParams.push(warehouseKey);
    }
    if (excludePaymentKey) {
      paymentWhere.push(`CAST(id AS TEXT) <> CAST(? AS TEXT)`);
      paymentParams.push(excludePaymentKey);
    }
    const paymentRows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT CAST(farmer_id AS TEXT) AS farmer_id, COALESCE(SUM(amount),0) AS total_payment
         FROM wh_payment_vouchers
         WHERE ${paymentWhere.join(" AND ")}
         GROUP BY CAST(farmer_id AS TEXT)`,
        paymentParams,
        (err, rows) => err ? reject(err) : resolve(rows || [])
      );
    });
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

  const query = `
    SELECT DISTINCT f.id, f.name, f.mobile, f.address, f.village
    FROM wh_purchase_vouchers pv
    INNER JOIN farmers f ON CAST(f.id AS TEXT) = CAST(pv.farmer_id AS TEXT)
    WHERE CAST(pv.company_account_id AS TEXT) = CAST(? AS TEXT) ${filter.clause} ${filters.slice(1).length ? `AND ${filters.slice(1).join(" AND ")}` : ""}
    ORDER BY f.name ASC
  `;

  db.all(query, [accountId, ...filter.params, ...params], (err, farmers) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (!farmers || !farmers.length) return res.json([]);

    const farmerIds = farmers.map((f) => f.id);
    const adjustSql = `
      SELECT pv.farmer_id, SUM(COALESCE(pa.adjusted_amount, 0)) as total_adjusted
      FROM wh_payment_adjustments pa
      INNER JOIN wh_payment_vouchers pv ON pa.payment_id = pv.id
      WHERE CAST(pv.company_account_id AS TEXT) = CAST(? AS TEXT) AND pv.farmer_id IN (${farmerIds.map(() => "?").join(",")})
      GROUP BY pv.farmer_id
    `;

    const purchaseSql = `
      SELECT farmer_id, SUM(COALESCE(NULLIF(net_amount_payable, 0), amount, 0)) as total_purchase
      FROM wh_purchase_vouchers
      WHERE CAST(company_account_id AS TEXT) = CAST(? AS TEXT) AND farmer_id IN (${farmerIds.map(() => "?").join(",")})
      GROUP BY farmer_id
    `;

    db.all(adjustSql, [accountId, ...farmerIds], (adjErr, adjRows) => {
      if (adjErr) console.error("Adjustment query error:", adjErr);
      db.all(purchaseSql, [accountId, ...farmerIds], (purErr, purRows) => {
        if (purErr) console.error("Purchase query error:", purErr);
        
        const adjustMap = new Map((adjRows || []).map((r) => [String(r.farmer_id), Number(r.total_adjusted || 0)]));
        const purchaseMap = new Map((purRows || []).map((r) => [String(r.farmer_id), Number(r.total_purchase || 0)]));
        
        const result = farmers.map((f) => {
          const totalPurchase = purchaseMap.get(String(f.id)) || 0;
          const totalAdjusted = adjustMap.get(String(f.id)) || 0;
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
    });
  });
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

router.put("/sale/:id", (req, res) => {
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
          existing.moisture = Number(req.body.moisture !== undefined ? req.body.moisture : existing.moisture) || 0;
          existing.dunki = Number(req.body.dunki !== undefined ? req.body.dunki : existing.dunki) || 0;
          existing.fungus = Number(req.body.fungus !== undefined ? req.body.fungus : existing.fungus) || 0;
          existing.discolour = Number(req.body.discolour !== undefined ? req.body.discolour : existing.discolour) || 0;
          existing.others = Number(req.body.others !== undefined ? req.body.others : existing.others) || 0;
          existing.total_deduction = Number(req.body.total_deduction !== undefined ? req.body.total_deduction : existing.total_deduction) || 0;
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
    return db.get("SELECT * FROM wh_sale_vouchers WHERE id = ?", [id], async (findErr, existing) => {
      if (findErr) return res.status(500).json({ error: findErr.message });
      if (!existing) return res.status(404).json({ error: "Sale voucher not found" });
      const rateValue = Number(req.body.rate !== undefined ? req.body.rate : existing.rate) || 0;
      const saleQty = Number(existing.quantity || 0);
      const grossAmount = Number(existing.amount || 0);
      const unloadingQtyValue = Number(req.body.unloading_qty !== undefined ? req.body.unloading_qty : existing.unloading_qty || req.body.quantity || existing.quantity) || 0;
      const shortageQty = Math.max(0, saleQty - unloadingQtyValue);
      const shortageAmount = Number(((Number(req.body.shortage_amount) || shortageQty * rateValue) || 0).toFixed(2));
      const claimValue = req.body.claim_amount !== undefined ? Number(req.body.claim_amount) || 0 : shortageAmount;
      const otherDeductionValue = Number(req.body.other_deduction !== undefined ? req.body.other_deduction : existing.other_deduction) || 0;
      const cdPercentValue = Number(req.body.cd_percent !== undefined ? req.body.cd_percent : existing.cd_percent) || 0;
      const cdAmountValue = Number(req.body.cd_amount !== undefined ? req.body.cd_amount : existing.cd_amount) || 0;
      const totalDeductionValue = Number(req.body.total_deduction) || 0;
      const netAmount = grossAmount - claimValue - otherDeductionValue - cdAmountValue - adjustmentValue - tdsValue + roundOffValue;
      const deductionQuery = `
        UPDATE wh_sale_vouchers SET
          unloading_date=?, shortage_quantity=?, unloading_qty=?, moisture=?, dunki=?, fungus=?, discolour=?, others=?, total_deduction=?,
          claim_amount=?, other_deduction=?, cd_percent=?, cd_amount=?, adjustment_amount=?, tds_amount=?, round_off=?,
          net_amount=?, net_receivable_amount=?, net_amount_payable=?, outstanding=?
        WHERE id = ?
      `;
      try {
        await dbRunPromise(deductionQuery, [
          req.body.unloading_date !== undefined ? req.body.unloading_date : existing.unloading_date,
          shortageQty,
          unloadingQtyValue,
          Number(req.body.moisture) || 0,
          Number(req.body.dunki) || 0,
          Number(req.body.fungus) || 0,
          Number(req.body.discolour) || 0,
          Number(req.body.others) || 0,
          totalDeductionValue,
          claimValue,
          otherDeductionValue,
          cdPercentValue,
          cdAmountValue,
          adjustmentValue,
          tdsValue,
          roundOffValue,
          netAmount,
          netAmount,
          netAmount,
          netAmount,
          id,
        ]);
        const journals = await recreateSaleDeductionJournals({
          sale: existing,
          body: req.body,
          shortageAmount,
          deductionAmount: otherDeductionValue + adjustmentValue,
          cdAmount: cdAmountValue,
          tdsAmount: tdsValue,
        });
        return res.json({ id, updated: 1, voucher_no: existing.voucher_no, deduction_only: true, net_amount: netAmount, net_receivable_amount: netAmount, outstanding: netAmount, shortage_quantity: shortageQty, shortage_amount: shortageAmount, journals });
      } catch (updateErr) {
        return res.status(500).json({ error: updateErr.message });
      }
    });
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
    const saleQtyValue = Number(unloading_qty) || Number(quantity) || 0;
    return getAvailableSaleStock({
      warehouseId: warehouse_id,
      productId: product_id,
      excludeSaleId: id,
    })
      .then((availableQty) => {
        if (saleQtyValue > availableQty + 0.0001) {
          return res.status(400).json({ error: `Negative stock not allowed. Available stock: ${availableQty.toFixed(4)}` });
        }
        const query = `
          UPDATE wh_sale_vouchers SET
            voucher_no=?, date=?, unloading_date=?, warehouse_id=?, buyer_id=?, company_id=?, company_account_id=?, consignee_id=?,
            po_no=?, due_date=?, against_purchase_enabled=?, against_purchase_farmer_id=?, against_purchase_links=?, lorry_no=?, product_id=?,
            quantity=?, shortage_quantity=?, unloading_qty=?, rate=?, amount=?, claim_amount=?, other_deduction=?, transport_charge=?, cd_percent=?, cd_amount=?,
            adjustment_amount=?, tds_amount=?, round_off=?, net_amount=?, net_receivable_amount=?, net_amount_payable=?, fifo_rate=?, fifo_amount=?,
            outstanding=?, employee_id=?, location_id=?, description=?
          WHERE id = ?
        `;

        return db.run(query, [
          voucher_no, date, unloading_date, warehouse_id, buyer_id || company_id, company_id || buyer_id, company_account_id, consignee_id,
          po_no || "", due_date || "", against_purchase_enabled ? 1 : 0, against_purchase_farmer_id || "", JSON.stringify(Array.isArray(against_purchase_links) ? against_purchase_links : []), lorry_no || req.body.reference_id || "", product_id,
          quantity, shortage_quantity, unloading_qty, rate, amountValue, claimValue, otherDeductionValue, transportChargeValue, cdPercentValue, cdAmountValue,
          adjustmentValue, tdsValue, roundOffValue, netAmount, netReceivableValue, netAmount, fifoRateValue, fifoAmountValue,
          netAmount, employee_id, location_id, description, id
        ], function (err) {
          if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }
          res.json({ id, updated: 1, net_amount: netAmount, net_receivable_amount: netReceivableValue, outstanding: netAmount });
        });
      })
      .catch((e) => res.status(500).json({ error: e.message }));
  }

});

router.delete("/sale/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.sale.delete")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;

  if (mongoReady() && mongoose.Types.ObjectId.isValid(id)) {
    return (async () => {
      try {
        const doc = await SaleVoucher.findByIdAndDelete(id);
        if (!doc) return res.status(404).json({ error: "Sale voucher not found" });
        return res.json({ deleted: 1, deleted_from: "mongodb" });
      } catch (mongoErr) {
        return res.status(500).json({ error: mongoErr.message });
      }
    })();
  }

  db.get("SELECT warehouse_id FROM wh_sale_vouchers WHERE id = ?", [id], (findErr, row) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!row) return res.status(404).json({ error: "Voucher not found" });
    if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;

    db.run("DELETE FROM wh_sale_vouchers WHERE id = ?", [id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ deleted: 1 });
    });
  });
});

// ===========================
// PAYMENT VOUCHERS
// ===========================
router.get("/payment", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  getPaymentRowsForUser(req, res);
});

router.get("/payment/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  const query = `
    SELECT p.*, ca.account_name AS company_account_name, f.name AS farmer_name
    FROM wh_payment_vouchers p
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(p.company_account_id AS TEXT)
    LEFT JOIN farmers f ON CAST(f.id AS TEXT) = CAST(p.farmer_id AS TEXT)
    WHERE CAST(p.id AS TEXT) = ?
    LIMIT 1
  `;

  db.get(query, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Payment voucher not found" });
    if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;

    db.all(
      `
        SELECT a.*, pv.voucher_no AS purchase_voucher_no
        FROM wh_payment_adjustments a
        LEFT JOIN wh_purchase_vouchers pv ON CAST(pv.id AS TEXT) = CAST(a.purchase_id AS TEXT)
        WHERE a.payment_id = ?
        ORDER BY a.id ASC
      `,
      [id],
      async (adjErr, adjustmentRows) => {
        if (adjErr) return res.status(500).json({ error: adjErr.message });
        const rawAdjustments = (adjustmentRows || []).map((item) => ({
          purchase_id: String(item.purchase_id || ""),
          voucher_no: item.purchase_voucher_no || "",
          adjusted_amount: Number(item.adjusted_amount || 0),
        }));
        const missingVoucherIds = rawAdjustments.filter((item) => !item.voucher_no).map((item) => item.purchase_id).filter(Boolean);
        const mongoVoucherMap = new Map();
        if (mongoReady() && missingVoucherIds.length) {
          try {
            const mongoRows = await PurchaseVoucher.find({
              _id: { $in: missingVoucherIds.filter((value) => mongoose.Types.ObjectId.isValid(value)) },
            }).select("_id voucher_no").lean();
            (mongoRows || []).forEach((purchase) => mongoVoucherMap.set(String(purchase._id), purchase.voucher_no || ""));
          } catch (mongoErr) {
            console.error("Payment edit adjustment Mongo lookup failed:", mongoErr.message);
          }
        }
        const adjustments = rawAdjustments.map((item) => ({
          ...item,
          voucher_no: item.voucher_no || mongoVoucherMap.get(String(item.purchase_id)) || item.purchase_id || "",
        }));
        return res.json({
          ...row,
          id: String(row.id || row._id),
          _id: String(row.id || row._id),
          adjustments,
        });
      }
    );
  });
});

router.post("/payment", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.create")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, payment_mode, employee_id, location_id, description, adjustments } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;
  if (!farmer_id) return res.status(400).json({ error: "Farmer is required for payment vouchers" });

  const finalPaymentMode = normalizePaymentMode(payment_mode || (adjustments && adjustments.length ? "against" : "on_account"));
  validatePaymentAdjustments({ farmerId: farmer_id, warehouseId: warehouse_id, amount, adjustments, paymentMode: finalPaymentMode }, (validationErr, cleanAdjustments) => {
    if (validationErr) return res.status(400).json({ error: validationErr.message });

    const idemKey = req.get("Idempotency-Key") || req.headers["idempotency-key"];
    if (idemKey) {
      return getIdempotency(idemKey, "payment", (err, existingId) => {
        if (err) return res.status(500).json({ error: err.message });
      if (existingId) {
        return db.get(`SELECT * FROM wh_payment_vouchers WHERE id = ?`, [existingId], (e2, existingRow) => {
          if (e2) return res.status(500).json({ error: e2.message });
          return res.json({ id: existingRow.id, voucher_no: existingRow.voucher_no, existing: existingRow });
        });
      }

      createVoucherNoIfMissing("payment", voucher_no, (err, generatedVoucherNo) => {
        if (err) return res.status(500).json({ error: err.message });

        const query = `
          INSERT INTO wh_payment_vouchers (voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, payment_mode, employee_id, location_id, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const finalReferenceType = reference_type || (cleanAdjustments.length ? "purchase" : "on_account");
        const finalReferenceId = reference_id || buildPaymentReferenceId(cleanAdjustments);
        db.run(query, [generatedVoucherNo, date, warehouse_id, farmer_id, company_account_id, amount, finalReferenceType, finalReferenceId, finalPaymentMode, employee_id, location_id, description], function (err) {
          if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }

            const paymentId = this.lastID;
            insertPaymentAdjustments(paymentId, cleanAdjustments, (adjErr) => {
              if (adjErr) return res.status(500).json({ error: adjErr.message });
              saveIdempotency(idemKey, "payment", paymentId, () => {});
              computeOutstandingForFarmer(farmer_id, (err2, stats) => {
                if (err2) return res.status(500).json({ error: err2.message });
                db.run("UPDATE wh_payment_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, paymentId], () => {
                  res.json({ id: paymentId, voucher_no: generatedVoucherNo, stats, adjustments: cleanAdjustments });
                });
              });
            });
        });
      });
    });
    }

    createVoucherNoIfMissing("payment", voucher_no, (err, generatedVoucherNo) => {
      if (err) return res.status(500).json({ error: err.message });

      const query = `
        INSERT INTO wh_payment_vouchers (voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, payment_mode, employee_id, location_id, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const finalReferenceType = reference_type || (cleanAdjustments.length ? "purchase" : "on_account");
      const finalReferenceId = reference_id || buildPaymentReferenceId(cleanAdjustments);
      db.run(query, [generatedVoucherNo, date, warehouse_id, farmer_id, company_account_id, amount, finalReferenceType, finalReferenceId, finalPaymentMode, employee_id, location_id, description], function (err) {
        if (err) {
          if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
          return res.status(500).json({ error: err.message });
        }

        const paymentId = this.lastID;
        insertPaymentAdjustments(paymentId, cleanAdjustments, (adjErr) => {
          if (adjErr) return res.status(500).json({ error: adjErr.message });
          computeOutstandingForFarmer(farmer_id, (err2, stats) => {
            if (err2) return res.status(500).json({ error: err2.message });
            db.run("UPDATE wh_payment_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, paymentId], () => {
              res.json({ id: paymentId, voucher_no: generatedVoucherNo, stats, adjustments: cleanAdjustments });
            });
          });
        });
      });
    });
  });
});

router.put("/payment/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.edit")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = String(req.params.id || "").trim();
  const { voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, payment_mode, employee_id, location_id, description, adjustments } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;
  if (!farmer_id) return res.status(400).json({ error: "Farmer is required for payment vouchers" });

  db.get("SELECT * FROM wh_payment_vouchers WHERE CAST(id AS TEXT) = CAST(? AS TEXT)", [id], (findErr, oldRow) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!oldRow) return res.status(404).json({ error: "Payment voucher not found" });
    if (!ensureWarehouseAccess(req, res, oldRow.warehouse_id)) return;

    const finalPaymentMode = normalizePaymentMode(payment_mode || (adjustments && adjustments.length ? "against" : "on_account"));
    validatePaymentAdjustments({ farmerId: farmer_id, warehouseId: warehouse_id, amount, adjustments, paymentMode: finalPaymentMode, excludePaymentId: id }, (validationErr, cleanAdjustments) => {
      if (validationErr) return res.status(400).json({ error: validationErr.message });

      const finalReferenceType = reference_type || (cleanAdjustments.length ? "purchase" : "on_account");
      const finalReferenceId = reference_id || buildPaymentReferenceId(cleanAdjustments);
      const query = `
        UPDATE wh_payment_vouchers SET
          voucher_no=?, date=?, warehouse_id=?, farmer_id=?, company_account_id=?, amount=?,
          reference_type=?, reference_id=?, payment_mode=?, employee_id=?, location_id=?, description=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `;

      db.serialize(() => {
        db.run("BEGIN TRANSACTION", (beginErr) => {
          if (beginErr) return res.status(500).json({ error: beginErr.message });
          db.run(query, [voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, finalReferenceType, finalReferenceId, finalPaymentMode, employee_id, location_id, description, id], function (err) {
            if (err) {
              db.run("ROLLBACK");
              if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
              return res.status(500).json({ error: err.message });
            }

            db.run("DELETE FROM wh_payment_adjustments WHERE payment_id = ?", [id], (deleteErr) => {
              if (deleteErr) {
                db.run("ROLLBACK");
                return res.status(500).json({ error: deleteErr.message });
              }

              insertPaymentAdjustments(id, cleanAdjustments, (adjErr) => {
                if (adjErr) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: adjErr.message });
                }

                db.run("COMMIT", (commitErr) => {
                  if (commitErr) return res.status(500).json({ error: commitErr.message });

                  // The voucher is already committed. Do not run the old global
                  // farmer aggregation here; it was slower and could fail/return a
                  // balance from another warehouse/account during edit. The UI will
                  // refresh the scoped outstanding endpoint after save.
                  return res.json({
                    id,
                    updated: 1,
                    voucher_no,
                    stats: null,
                    adjustments: cleanAdjustments,
                    reference_id: finalReferenceId,
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});

router.delete("/payment/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.delete")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  db.get("SELECT * FROM wh_payment_vouchers WHERE id = ?", [id], (findErr, row) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!row) return res.status(404).json({ error: "Payment voucher not found" });
    if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;

    db.serialize(() => {
      db.run("BEGIN TRANSACTION");
      db.run("DELETE FROM wh_payment_adjustments WHERE payment_id = ?", [id], (adjErr) => {
        if (adjErr) {
          db.run("ROLLBACK");
          return res.status(500).json({ error: adjErr.message });
        }
        db.run("DELETE FROM wh_payment_vouchers WHERE id = ?", [id], function (deleteErr) {
          if (deleteErr) {
            db.run("ROLLBACK");
            return res.status(500).json({ error: deleteErr.message });
          }
          computeOutstandingForFarmer(row.farmer_id, (statsErr, stats) => {
            if (statsErr) {
              db.run("ROLLBACK");
              return res.status(500).json({ error: statsErr.message });
            }
            db.run("COMMIT", (commitErr) => {
              if (commitErr) return res.status(500).json({ error: commitErr.message });
              res.json({ deleted: 1, stats });
            });
          });
        });
      });
    });
  });
});

// ===========================
// RECEIPT VOUCHERS
// ===========================
router.get("/receipt", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  getWarehouseScopedRows(req, res, "wh_receipt_vouchers");
});

router.get("/receipt/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  db.get("SELECT * FROM wh_receipt_vouchers WHERE id = ?", [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Receipt voucher not found" });
    ensureWarehouseAccess(req, res, row.warehouse_id, row.location_id).then((ok) => {
      if (!ok) return;

    // Join with wh_sale_vouchers to fetch voucher_no for each adjusted sale
    db.all(
      `SELECT r.sale_id, sv.voucher_no, r.adjusted_amount
       FROM wh_receipt_adjustments r
       LEFT JOIN wh_sale_vouchers sv ON CAST(sv.id AS TEXT) = CAST(r.sale_id AS TEXT)
       WHERE r.receipt_id = ?`,
      [id],
      (adjErr, adjustments) => {
        if (adjErr) return res.status(500).json({ error: adjErr.message });
        res.json({ ...row, adjustments: adjustments || [] });
      }
    );
    });
  });
});

router.post("/receipt", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.create")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { voucher_no, date, warehouse_id, company_id, company_account_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description, adjustments } = req.body;
  ensureWarehouseAccess(req, res, warehouse_id, location_id).then((ok) => {
  if (!ok) return;
  if (!company_id) return res.status(400).json({ error: "Company is required for receipt vouchers" });

  validateReceiptAdjustments({ companyId: company_id, amount, adjustments }, (validationErr, cleanAdjustments) => {
    if (validationErr) return res.status(400).json({ error: validationErr.message });

    const idemKey = req.get("Idempotency-Key") || req.headers["idempotency-key"];
    if (idemKey) {
      return getIdempotency(idemKey, "receipt", (err, existingId) => {
        if (err) return res.status(500).json({ error: err.message });
        if (existingId) {
          return db.get(`SELECT * FROM wh_receipt_vouchers WHERE id = ?`, [existingId], (e2, existingRow) => {
            if (e2) return res.status(500).json({ error: e2.message });
            return res.json({ id: existingRow.id, voucher_no: existingRow.voucher_no, existing: existingRow });
          });
        }

        createVoucherNoIfMissing("receipt", voucher_no, (err, generatedVoucherNo) => {
          if (err) return res.status(500).json({ error: err.message });

          const query = `
            INSERT INTO wh_receipt_vouchers (voucher_no, date, warehouse_id, company_id, company_account_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `;

          const finalReferenceType = reference_type || "sale";
          const finalReferenceId = reference_id || buildReceiptReferenceId(cleanAdjustments);
          db.run(query, [generatedVoucherNo, date, warehouse_id, company_id, company_account_id, consignee_id, amount, finalReferenceType, finalReferenceId, employee_id, location_id, description], function (err) {
            if (err) {
              if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
              return res.status(500).json({ error: err.message });
            }

            const receiptId = this.lastID;
            insertReceiptAdjustments(receiptId, cleanAdjustments, (adjErr) => {
              if (adjErr) return res.status(500).json({ error: adjErr.message });
              saveIdempotency(idemKey, "receipt", receiptId, () => {});
              computeOutstandingForCompany(company_id, (err2, stats) => {
                if (err2) return res.status(500).json({ error: err2.message });
                db.run("UPDATE wh_receipt_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, receiptId], () => {
                  res.json({ id: receiptId, voucher_no: generatedVoucherNo, stats, adjustments: cleanAdjustments });
                });
              });
            });
          });
        });
      });
    }

    createVoucherNoIfMissing("receipt", voucher_no, (err, generatedVoucherNo) => {
      if (err) return res.status(500).json({ error: err.message });

      const query = `
        INSERT INTO wh_receipt_vouchers (voucher_no, date, warehouse_id, company_id, company_account_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const finalReferenceType = reference_type || "sale";
      const finalReferenceId = reference_id || buildReceiptReferenceId(cleanAdjustments);
      db.run(query, [generatedVoucherNo, date, warehouse_id, company_id, company_account_id, consignee_id, amount, finalReferenceType, finalReferenceId, employee_id, location_id, description], function (err) {
        if (err) {
          if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
          return res.status(500).json({ error: err.message });
        }

        const receiptId = this.lastID;
        insertReceiptAdjustments(receiptId, cleanAdjustments, (adjErr) => {
          if (adjErr) return res.status(500).json({ error: adjErr.message });
          computeOutstandingForCompany(company_id, (err2, stats) => {
            if (err2) return res.status(500).json({ error: err2.message });
            db.run("UPDATE wh_receipt_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, receiptId], () => {
              res.json({ id: receiptId, voucher_no: generatedVoucherNo, stats, adjustments: cleanAdjustments });
            });
          });
        });
      });
    });
  });
  });
});

router.put("/receipt/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.edit")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  const { voucher_no, date, warehouse_id, company_id, company_account_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description, adjustments } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;
  if (!company_id) return res.status(400).json({ error: "Company is required for receipt vouchers" });

  db.get("SELECT * FROM wh_receipt_vouchers WHERE id = ?", [id], (findErr, oldRow) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!oldRow) return res.status(404).json({ error: "Receipt voucher not found" });
    if (!ensureWarehouseAccess(req, res, oldRow.warehouse_id)) return;

    validateReceiptAdjustments({ companyId: company_id, amount, adjustments }, (validationErr, cleanAdjustments) => {
      if (validationErr) return res.status(400).json({ error: validationErr.message });

      const finalReferenceType = reference_type || "sale";
      const finalReferenceId = reference_id || buildReceiptReferenceId(cleanAdjustments);
      const query = `
        UPDATE wh_receipt_vouchers SET
          voucher_no=?, date=?, warehouse_id=?, company_id=?, company_account_id=?, consignee_id=?, amount=?,
          reference_type=?, reference_id=?, employee_id=?, location_id=?, description=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `;

      db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run(query, [voucher_no, date, warehouse_id, company_id, company_account_id, consignee_id, amount, finalReferenceType, finalReferenceId, employee_id, location_id, description, id], function (err) {
          if (err) {
            db.run("ROLLBACK");
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }

          db.run("DELETE FROM wh_receipt_adjustments WHERE receipt_id = ?", [id], (deleteErr) => {
            if (deleteErr) {
              db.run("ROLLBACK");
              return res.status(500).json({ error: deleteErr.message });
            }

            insertReceiptAdjustments(id, cleanAdjustments, (adjErr) => {
              if (adjErr) {
                db.run("ROLLBACK");
                return res.status(500).json({ error: adjErr.message });
              }
              computeOutstandingForCompany(company_id, (statsErr, stats) => {
                if (statsErr) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: statsErr.message });
                }
                db.run("UPDATE wh_receipt_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, id], (outErr) => {
                  if (outErr) {
                    db.run("ROLLBACK");
                    return res.status(500).json({ error: outErr.message });
                  }
                  db.run("COMMIT", (commitErr) => {
                    if (commitErr) return res.status(500).json({ error: commitErr.message });
                    res.json({ id, updated: 1, voucher_no, stats, adjustments: cleanAdjustments, reference_id: finalReferenceId });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});

router.delete("/receipt/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.delete")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  db.get("SELECT * FROM wh_receipt_vouchers WHERE id = ?", [id], (findErr, row) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!row) return res.status(404).json({ error: "Receipt voucher not found" });
    ensureWarehouseAccess(req, res, row.warehouse_id, row.location_id).then((ok) => {
      if (!ok) return;

    db.serialize(() => {
      db.run("BEGIN TRANSACTION");
      db.run("DELETE FROM wh_receipt_adjustments WHERE receipt_id = ?", [id], (adjErr) => {
        if (adjErr) {
          db.run("ROLLBACK");
          return res.status(500).json({ error: adjErr.message });
        }
        db.run("DELETE FROM wh_receipt_vouchers WHERE id = ?", [id], function (deleteErr) {
          if (deleteErr) {
            db.run("ROLLBACK");
            return res.status(500).json({ error: deleteErr.message });
          }
          computeOutstandingForCompany(row.company_id, (statsErr, stats) => {
            if (statsErr) {
              db.run("ROLLBACK");
              return res.status(500).json({ error: statsErr.message });
            }
            db.run("COMMIT", (commitErr) => {
              if (commitErr) return res.status(500).json({ error: commitErr.message });
              res.json({ deleted: 1, stats });
            });
          });
        });
      });
    });
    });
  });
});

// ===========================
// JOURNAL VOUCHERS
// ===========================
router.get("/journal", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.journal.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  getWarehouseScopedRows(req, res, "wh_journal_vouchers");
});

router.post("/journal", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.journal.create")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { voucher_no, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description } = req.body;
  ensureWarehouseAccess(req, res, warehouse_id, location_id).then((ok) => {
  if (!ok) return;

  const idemKey = req.get("Idempotency-Key") || req.headers["idempotency-key"];
  if (idemKey) {
    return getIdempotency(idemKey, "journal", (err, existingId) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existingId) {
        return db.get(`SELECT * FROM wh_journal_vouchers WHERE id = ?`, [existingId], (e2, existingRow) => {
          if (e2) return res.status(500).json({ error: e2.message });
          return res.json({ id: existingRow.id, voucher_no: existingRow.voucher_no, existing: existingRow });
        });
      }

      createVoucherNoIfMissing("journal", voucher_no, (err, generatedVoucherNo) => {
        if (err) return res.status(500).json({ error: err.message });

        const query = `
          INSERT INTO wh_journal_vouchers (voucher_no, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [generatedVoucherNo, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description], function (err) {
          if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }
          saveIdempotency(idemKey, "journal", this.lastID, () => {});
          res.json({ id: this.lastID, voucher_no: generatedVoucherNo });
        });
      });
    });
  }

  createVoucherNoIfMissing("journal", voucher_no, (err, generatedVoucherNo) => {
    if (err) return res.status(500).json({ error: err.message });

    const query = `
      INSERT INTO wh_journal_vouchers (voucher_no, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [generatedVoucherNo, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description], function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, voucher_no: generatedVoucherNo });
    });
  });
  });
});

function dbAll(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function getPurchaseReportRowsForUser(user, options = {}) {
  if (mongoReady()) {
    const filter = { ...mongoPurchaseScope(user) };
    if (options.farmerId) filter.farmer_id = String(options.farmerId);
    if (options.warehouseId) filter.warehouse_id = String(options.warehouseId);
    if (options.companyAccountId) filter.company_account_id = String(options.companyAccountId);
    if (options.productId) filter.product_id = String(options.productId);
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

  const filter = assignedWarehouseFilter(user, "v.warehouse_id");
  return dbAll(
    `
      SELECT
        v.*,
        w.name AS warehouse_name,
        ca.account_name AS company_account_name,
        f.name AS farmer_name,
        p.name AS product_name,
        (COALESCE(NULLIF(v.total_qty, 0), NULLIF(v.net_weight, 0), v.quantity) * COALESCE(v.rate, 0)) AS gross_amount,
        COALESCE(NULLIF(v.total_qty, 0), NULLIF(v.net_weight, 0), v.quantity) AS total_quantity,
        COALESCE(NULLIF(v.net_amount_payable, 0), v.amount) AS total_amount
      FROM wh_purchase_vouchers v
      LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(v.warehouse_id AS TEXT)
      LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
      LEFT JOIN farmers f ON CAST(f.id AS TEXT) = CAST(v.farmer_id AS TEXT)
      LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(v.product_id AS TEXT)
      WHERE 1 = 1 ${filter.clause}
      ORDER BY v.date DESC, v.id DESC
    `,
    filter.params
  );
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
  return getSqliteSaleRowsForUser(user, options);
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

  getPaymentRowsForUser(req, res);
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

    // Return labels together with IDs so Reports do not need to load the
    // entire nine-table master bundle just to populate filter dropdowns.
    const [accountDocs, warehouseDocs, farmerDocs, buyerDocs] = await Promise.all([
      cleanAccountIds.length ? CompanyAccount.find({ _id: { $in: cleanAccountIds } }).select("_id account_name name").lean() : [],
      cleanWarehouseIds.length ? Warehouse.find({ _id: { $in: cleanWarehouseIds } }).select("_id name").lean() : [],
      cleanFarmerIds.length ? Farmer.find({ _id: { $in: cleanFarmerIds } }).select("_id name").lean() : [],
      cleanBuyerIds.length ? SqliteMirrorRow.find({
        table: "buyer_names",
        row_id: { $in: cleanBuyerIds.map((value) => Number(value)).filter(Number.isFinite) },
      }).select("row_id data").lean() : [],
    ]);

    const cleanNamed = (docs, type) => {
      if (type === "buyer") {
        return (docs || []).map((doc) => ({
          id: String(doc.row_id),
          name: String(doc?.data?.name || doc?.data?.company_name || "").trim(),
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

router.get("/report/purchase-summary", (req, res) => {
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

  if (mongoReady()) {
    const query = PurchaseVoucher.find(mongoPurchaseScope(req.user)).sort({ date: -1, createdAt: -1, _id: -1 });
    if (farmerId) query.where("farmer_id").equals(farmerId);
    if (warehouseId) query.where("warehouse_id").equals(warehouseId);
    if (companyAccountId) query.where("company_account_id").equals(companyAccountId);
    const countPromise = usePaging ? PurchaseVoucher.countDocuments(query.getQuery()).exec() : Promise.resolve(null);
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
        console.error("Mongo purchase report query failed, falling back to SQLite:", err.message);
        res.status(500).json({ error: err.message });
      });
  }

  const filter = assignedWarehouseFilter(req.user, "v.warehouse_id");
  const legacyFilter = assignedWarehouseFilter(req.user, "t.warehouse_id");
  const purchaseFilterParams = [...filter.params];
  const legacyPurchaseFilterParams = [...legacyFilter.params];
  let purchaseFilterClause = "";
  let legacyPurchaseFilterClause = "";
  if (farmerId) {
    purchaseFilterClause += " AND CAST(v.farmer_id AS TEXT) = CAST(? AS TEXT)";
    legacyPurchaseFilterClause += " AND CAST(t.farmer_id AS TEXT) = CAST(? AS TEXT)";
    purchaseFilterParams.push(farmerId);
    legacyPurchaseFilterParams.push(farmerId);
  }
  if (warehouseId) {
    purchaseFilterClause += " AND CAST(v.warehouse_id AS TEXT) = CAST(? AS TEXT)";
    legacyPurchaseFilterClause += " AND CAST(t.warehouse_id AS TEXT) = CAST(? AS TEXT)";
    purchaseFilterParams.push(warehouseId);
    legacyPurchaseFilterParams.push(warehouseId);
  }
  if (companyAccountId) {
    purchaseFilterClause += " AND CAST(v.company_account_id AS TEXT) = CAST(? AS TEXT)";
    legacyPurchaseFilterClause += " AND CAST(t.company_account_id AS TEXT) = CAST(? AS TEXT)";
    purchaseFilterParams.push(companyAccountId);
    legacyPurchaseFilterParams.push(companyAccountId);
  }
  const query = `
    SELECT
      v.*,
      w.name AS warehouse_name,
      ca.account_name AS company_account_name,
      f.name AS farmer_name,
      p.name AS product_name,
      (COALESCE(NULLIF(v.total_qty, 0), NULLIF(v.net_weight, 0), v.quantity) * COALESCE(v.rate, 0)) AS gross_amount,
      COALESCE(NULLIF(v.total_qty, 0), NULLIF(v.net_weight, 0), v.quantity) AS total_quantity,
      COALESCE(NULLIF(v.net_amount_payable, 0), v.amount) AS total_amount
    FROM wh_purchase_vouchers v
    LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(v.warehouse_id AS TEXT)
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
    LEFT JOIN farmers f ON CAST(f.id AS TEXT) = CAST(v.farmer_id AS TEXT)
    LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(v.product_id AS TEXT)
    WHERE 1 = 1 ${filter.clause}${purchaseFilterClause}
    ORDER BY v.date DESC, v.id DESC
  `;
  const queryParams = usePaging ? [...purchaseFilterParams, pageSize, (page - 1) * pageSize] : purchaseFilterParams;
  const pagedQuery = usePaging ? `${query}\nLIMIT ? OFFSET ?` : query;
  db.all(pagedQuery, queryParams, (err, rows) => {
    const sendRowsWithLegacy = (purchaseRows) => {
      const legacyQuery = `
        SELECT
          t.id,
          t.date,
          t.warehouse_id,
          t.farmer_id,
          t.product_id,
          t.quantity,
          t.amount,
          t.description,
          t.created_at,
          w.name AS warehouse_name,
          f.name AS farmer_name,
          p.name AS product_name,
          t.quantity AS total_quantity,
          t.amount AS total_amount,
          t.amount AS net_amount_payable,
          1 AS legacy_purchase_entry
        FROM warehouse_trading_entries t
        LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(t.warehouse_id AS TEXT)
        LEFT JOIN farmers f ON CAST(f.id AS TEXT) = CAST(t.farmer_id AS TEXT)
        LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(t.product_id AS TEXT)
        WHERE LOWER(COALESCE(t.transaction_type, '')) = 'purchase' ${legacyFilter.clause}${legacyPurchaseFilterClause}
        ORDER BY t.date DESC, t.id DESC
      `;

      db.all(legacyQuery, legacyPurchaseFilterParams, (legacyErr, legacyRows) => {
        if (legacyErr) {
          console.error("Legacy purchase report query failed:", legacyErr.message);
          return res.json(purchaseRows || []);
        }
        const merged = [...(purchaseRows || []), ...(legacyRows || [])];
        return res.json(usePaging ? { data: merged, pagination: { page, pageSize, hasMore: merged.length === pageSize } } : merged);
      });
    };

    if (err) {
      console.error("Purchase report mapped query failed, falling back to base rows:", err.message);
      const fallbackQuery = `
        SELECT
          v.*,
          (SELECT name FROM warehouses WHERE CAST(id AS TEXT) = CAST(v.warehouse_id AS TEXT) LIMIT 1) AS warehouse_name,
          (SELECT name FROM farmers WHERE CAST(id AS TEXT) = CAST(v.farmer_id AS TEXT) LIMIT 1) AS farmer_name,
          (SELECT name FROM products WHERE CAST(id AS TEXT) = CAST(v.product_id AS TEXT) LIMIT 1) AS product_name,
          (COALESCE(NULLIF(v.total_qty, 0), NULLIF(v.net_weight, 0), v.quantity) * COALESCE(v.rate, 0)) AS gross_amount,
          COALESCE(NULLIF(v.total_qty, 0), NULLIF(v.net_weight, 0), v.quantity) AS total_quantity,
          COALESCE(NULLIF(v.net_amount_payable, 0), v.amount) AS total_amount
        FROM wh_purchase_vouchers v
        WHERE 1 = 1 ${filter.clause}${purchaseFilterClause}
        ORDER BY v.date DESC, v.id DESC
      `;
      return db.all(fallbackQuery, purchaseFilterParams, (fallbackErr, fallbackRows) => {
        if (fallbackErr) return res.status(500).json({ error: fallbackErr.message });
        sendRowsWithLegacy(fallbackRows || []);
      });
    }
    sendRowsWithLegacy(rows || []);
  });
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

    const paymentsPromise = dbAll(
      `
        SELECT p.*, w.name AS warehouse_name, f.name AS farmer_name, ca.account_name AS company_account_name
        FROM wh_payment_vouchers p
        LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(p.warehouse_id AS TEXT)
        LEFT JOIN farmers f ON CAST(f.id AS TEXT) = CAST(p.farmer_id AS TEXT)
        LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(p.company_account_id AS TEXT)
        WHERE 1 = 1 ${filter.clause} ${farmerClause} ${warehouseClause} ${accountClause}
      `,
      paymentParams
    );

    const [purchases, payments] = await Promise.all([purchasePromise, paymentsPromise]);
    const paymentIds = payments.map((row) => row.id);
    const sqliteAdjustments = paymentIds.length
      ? await dbAll(
          `
            SELECT a.*, pv.voucher_no AS purchase_voucher_no
            FROM wh_payment_adjustments a
            LEFT JOIN wh_purchase_vouchers pv ON CAST(pv.id AS TEXT) = CAST(a.purchase_id AS TEXT)
            WHERE a.payment_id IN (${paymentIds.map(() => "?").join(",")})
            ORDER BY a.id ASC
          `,
          paymentIds
        )
      : [];

    const purchaseMap = new Map(purchases.map((row) => [String(row.id || row._id), row]));
    const paymentMap = new Map(payments.map((row) => [String(row.id), row]));
    const adjustmentsByPayment = new Map();
    const adjustmentsByPurchase = new Map();

    sqliteAdjustments.forEach((item) => {
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

    // Sale rows are read from the active reporting source (MongoDB when
    // enabled, SQLite otherwise). Receipt/adjustment history may still be in
    // SQLite, so never assume that a Mongo _id === SQLite sale_id.
    const sales = await getSaleReportRowsForUser(req.user, {
      buyerId,
      farmerId,
      warehouseId,
      companyAccountId,
    });

    let receipts = [];
    let adjustmentRows = [];
    const filter = assignedWarehouseFilter(req.user, "r.warehouse_id");
    const receiptParams = [...filter.params];
    const clauses = [];

    if (buyerId) {
      clauses.push(" AND CAST(r.company_id AS TEXT) = CAST(? AS TEXT)");
      receiptParams.push(buyerId);
    }
    if (warehouseId) {
      clauses.push(" AND CAST(r.warehouse_id AS TEXT) = CAST(? AS TEXT)");
      receiptParams.push(warehouseId);
    }
    if (companyAccountId) {
      clauses.push(" AND CAST(r.company_account_id AS TEXT) = CAST(? AS TEXT)");
      receiptParams.push(companyAccountId);
    }

    try {
      receipts = await dbAll(`
        SELECT
          r.*,
          ca.account_name AS company_account_name,
          b.name AS buyer_name
        FROM wh_receipt_vouchers r
        LEFT JOIN company_accounts ca
          ON CAST(ca.id AS TEXT) = CAST(r.company_account_id AS TEXT)
        LEFT JOIN buyer_names b
          ON CAST(b.id AS TEXT) = CAST(COALESCE(r.company_id, r.buyer_id) AS TEXT)
        WHERE 1=1 ${filter.clause} ${clauses.join(" ")}
        ORDER BY r.date DESC, r.id DESC
      `, receiptParams);

      const receiptIds = receipts.map((row) => row.id).filter((id) => id !== null && id !== undefined);
      adjustmentRows = receiptIds.length
        ? await dbAll(`
            SELECT
              a.*,
              rv.voucher_no AS receipt_voucher_no,
              rv.date AS adjustment_receipt_date,
              rv.amount AS adjustment_receipt_amount
            FROM wh_receipt_adjustments a
            LEFT JOIN wh_receipt_vouchers rv
              ON CAST(rv.id AS TEXT) = CAST(a.receipt_id AS TEXT)
            WHERE a.receipt_id IN (${receiptIds.map(() => "?").join(",")})
            ORDER BY a.id ASC
          `, receiptIds)
        : [];
    } catch (receiptErr) {
      console.warn("Sale Party Ledger receipt details unavailable:", receiptErr.message);
      receipts = [];
      adjustmentRows = [];
    }

    const saleList = Array.isArray(sales) ? sales : [];
    const receiptList = Array.isArray(receipts) ? receipts : [];
    const adjustments = Array.isArray(adjustmentRows) ? adjustmentRows : [];

    const normalizeKey = (value) => String(value ?? "").trim().toLowerCase();
    const firstNonEmpty = (...values) => values.find((value) => {
      return value !== undefined && value !== null && String(value).trim() !== "";
    });

    // Multiple ID systems can coexist:
    //   Mongo sale _id / id
    //   legacy SQLite wh_sale_vouchers.id
    //   bill_no / voucher_no / reference_id
    // Build all keys so old receipts can still be attached to the current
    // Mongo sale row.
    const saleByKey = new Map();
    const addSaleKey = (key, sale) => {
      const normalized = normalizeKey(key);
      if (normalized) saleByKey.set(normalized, sale);
    };

    saleList.forEach((sale) => {
      addSaleKey(sale.id, sale);
      addSaleKey(sale._id, sale);
      addSaleKey(sale.voucher_no, sale);
      addSaleKey(sale.bill_no, sale);
      addSaleKey(sale.sale_id, sale);
    });

    // Legacy SQLite sale IDs are resolved to their voucher/bill numbers.
    const legacySaleIds = [...new Set(
      adjustments
        .map((item) => String(item.sale_id ?? "").trim())
        .filter(Boolean)
    )];

    if (legacySaleIds.length) {
      try {
        const legacyRows = await dbAll(`
          SELECT id, voucher_no, bill_no
          FROM wh_sale_vouchers
          WHERE id IN (${legacySaleIds.map(() => "?").join(",")})
        `, legacySaleIds);

        legacyRows.forEach((legacy) => {
          const sale = saleByKey.get(normalizeKey(legacy.voucher_no))
            || saleByKey.get(normalizeKey(legacy.bill_no));
          if (sale) {
            addSaleKey(legacy.id, sale);
          }
        });
      } catch (legacyErr) {
        console.warn("Legacy sale-id mapping unavailable:", legacyErr.message);
      }
    }

    const receiptMap = new Map(
      receiptList.map((row) => [normalizeKey(row.id), row])
    );

    const bySale = new Map();
    const byReceipt = new Map();

    const pushDetail = (sale, receipt, item, inferred = false) => {
      if (!sale || !receipt) return;

      const adjustedAmount = Number(
        firstNonEmpty(
          item?.adjusted_amount,
          item?.amount,
          item?.adjustment_amount,
          0
        )
      ) || 0;

      const detail = {
        ...(item || {}),
        sale_id: String(sale.id || sale._id || ""),
        sale_voucher_no: firstNonEmpty(
          sale.voucher_no,
          sale.bill_no,
          item?.sale_voucher_no,
          item?.bill_no,
          item?.sale_id,
          ""
        ),
        receipt_id: String(receipt.id || ""),
        receipt_date: firstNonEmpty(receipt.date, item?.adjustment_receipt_date, ""),
        receipt_voucher_no: firstNonEmpty(
          receipt.voucher_no,
          item?.receipt_voucher_no,
          ""
        ),
        receipt_amount: Number(firstNonEmpty(receipt.amount, item?.adjustment_receipt_amount, 0)) || 0,
        adjusted_amount: Number(adjustedAmount.toFixed(2)),
        inferred_adjustment: Boolean(inferred),
      };

      const saleKey = normalizeKey(sale.id || sale._id || sale.voucher_no || sale.bill_no);
      const receiptKey = normalizeKey(receipt.id);

      if (!bySale.has(saleKey)) bySale.set(saleKey, []);
      bySale.get(saleKey).push(detail);

      if (!byReceipt.has(receiptKey)) byReceipt.set(receiptKey, []);
      byReceipt.get(receiptKey).push(detail);
    };

    // 1) Normal adjustment rows.
    adjustments.forEach((item) => {
      const receipt = receiptMap.get(normalizeKey(item.receipt_id));
      const sale = saleByKey.get(normalizeKey(item.sale_id))
        || saleByKey.get(normalizeKey(item.sale_voucher_no))
        || saleByKey.get(normalizeKey(item.bill_no))
        || saleByKey.get(normalizeKey(receipt?.reference_id));

      pushDetail(sale, receipt, item, false);
    });

    // 2) Older receipt records sometimes contain reference_id but have no
    // wh_receipt_adjustments row. Infer the bill link instead of dropping it.
    receiptList.forEach((receipt) => {
      const receiptKey = normalizeKey(receipt.id);
      const existing = byReceipt.get(receiptKey) || [];
      if (existing.length) return;

      const referenceTokens = String(receipt.reference_id || "")
        .split(/[,\s;|]+/)
        .map((value) => value.trim())
        .filter(Boolean);

      const candidates = [
        ...referenceTokens,
        receipt.bill_no,
        receipt.voucher_reference,
      ].filter(Boolean);

      for (const token of candidates) {
        const sale = saleByKey.get(normalizeKey(token));
        if (sale) {
          pushDetail(
            sale,
            receipt,
            {
              sale_voucher_no: sale.voucher_no || sale.bill_no || token,
              adjusted_amount: Number(receipt.amount || 0),
            },
            true
          );
          break;
        }
      }
    });

    const rows = [
      ...saleList.map((row) => {
        const saleKey = normalizeKey(row.id || row._id || row.voucher_no || row.bill_no);
        const details = bySale.get(saleKey) || [];

        const quantity = Number(firstNonEmpty(
          row.quantity,
          row.total_quantity,
          row.dispatch_qty,
          0
        )) || 0;

        const rate = Number(firstNonEmpty(row.rate, 0)) || 0;
        const grossAmount = Number(firstNonEmpty(
          row.gross_amount,
          row.sale_gross_amount,
          row.quantity && row.rate ? Number(row.quantity) * Number(row.rate) : undefined,
          row.amount,
          row.total_amount,
          row.net_receivable_amount,
          0
        )) || 0;

        const saleAmount = Number(firstNonEmpty(
          row.total_amount,
          row.net_receivable_amount,
          row.amount,
          row.gross_amount,
          grossAmount,
          0
        )) || 0;

        const receiptAmount = details.reduce(
          (sum, item) => sum + (Number(item.adjusted_amount) || 0),
          0
        );

        const normalizedParty = firstNonEmpty(
          row.party_name,
          row.buyer_name,
          row.company_name,
          row.consignee_name,
          "-"
        );

        return {
          ...row,
          row_type: "entry",
          date: row.date || row.bill_date || "",
          voucher_no: firstNonEmpty(row.voucher_no, row.bill_no, "-"),
          bill_no: firstNonEmpty(row.bill_no, row.voucher_no, "-"),
          voucher_type: "Sale",
          particulars: `Sale Bill ${firstNonEmpty(row.voucher_no, row.bill_no, "")}`.trim(),
          party_id: String(firstNonEmpty(row.buyer_id, row.company_id, "") || ""),
          party_name: normalizedParty,
          buyer_name: firstNonEmpty(row.buyer_name, normalizedParty, "-"),
          company_account_name: firstNonEmpty(row.company_account_name, row.account_name, "-"),
          product_name: firstNonEmpty(row.product_name, row.product, "-"),
          quantity: Number(quantity.toFixed(4)),
          total_quantity: Number(quantity.toFixed(4)),
          rate: Number(rate.toFixed(2)),
          gross_amount: Number(grossAmount.toFixed(2)),
          sale_amount: Number(saleAmount.toFixed(2)),
          receipt_amount: Number(receiptAmount.toFixed(2)),
          receipt_details: details,
          payment_details: details,
          adjustment: Number(receiptAmount.toFixed(2)),
          journal_amount: 0,
          bill_balance: Number((saleAmount - receiptAmount).toFixed(2)),
          debit: Number(saleAmount.toFixed(2)),
          credit: 0,
          closing_balance: Number((saleAmount - receiptAmount).toFixed(2)),
          adjustment_details: details.map((item) =>
            `${item.receipt_date || "-"} ${item.receipt_voucher_no || "-"}: Rs.${fmtNum(item.adjusted_amount)}`
          ).join("; "),
        };
      }),

      ...receiptList.map((row) => {
        const details = byReceipt.get(normalizeKey(row.id)) || [];
        const partyName = firstNonEmpty(
          row.party_name,
          row.buyer_name,
          row.company_name,
          row.company_account_name,
          "-"
        );

        return {
          ...row,
          row_type: "entry",
          date: row.date || "",
          voucher_no: firstNonEmpty(row.voucher_no, row.receipt_no, "-"),
          bill_no: firstNonEmpty(row.reference_id, ""),
          voucher_type: "Receipt",
          particulars: details.length
            ? `Receipt adjusted against ${details.map((item) => item.sale_voucher_no).filter(Boolean).join(", ")}`
            : "Unadjusted on account",
          party_id: String(firstNonEmpty(row.company_id, row.buyer_id, "") || ""),
          party_name: partyName,
          buyer_name: firstNonEmpty(row.buyer_name, partyName, "-"),
          company_account_name: firstNonEmpty(row.company_account_name, row.account_name, "-"),
          product_name: "-",
          quantity: 0,
          total_quantity: 0,
          rate: 0,
          gross_amount: 0,
          sale_amount: 0,
          receipt_amount: Number(row.amount || 0),
          receipt_details: details,
          payment_details: details,
          adjustment: Number(row.amount || 0),
          journal_amount: 0,
          bill_balance: 0,
          debit: 0,
          credit: Number(row.amount || 0),
          closing_balance: 0,
          reference_id: firstNonEmpty(
            row.reference_id,
            details.map((item) => item.sale_voucher_no).filter(Boolean).join(", "),
            "On account"
          ),
          adjustment_details: details.map((item) =>
            `${item.sale_voucher_no || "-"}: Rs.${fmtNum(item.adjusted_amount)}`
          ).join("; "),
        };
      }),
    ];

    const finalRows = buildLedgerRows(
      rows,
      (row) => `${row.party_id || "unknown"}::${row.company_account_id || "no-account"}`,
      (row) => row.party_name || row.company_account_name || "Unknown Party"
    ).map((row) => ({
      ...row,
      closing_balance: Number(row.balance || 0),
    }));

    return res.json(finalRows);
  } catch (err) {
    console.error("Sale party ledger failed:", err);
    return res.status(500).json({
      error: err.message || "Failed to load sale party ledger",
    });
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

    const currentDate = new Date().toISOString().slice(0, 10);
    const sql = `
      WITH adjusted AS (
        SELECT inward_id, SUM(qty) AS adjusted_qty
        FROM adjustment
        GROUP BY inward_id
      )
      SELECT
        COALESCE(w.name, 'Unknown') AS warehouse,
        COALESCE(c.name, ca.account_name, 'Unknown') AS party,
        COALESCE(l.name, '') AS location,
        COUNT(i.id) AS rows_count,
        SUM(COALESCE(i.weight, 0)) AS gross_qty,
        SUM(COALESCE(adj.adjusted_qty, 0)) AS already_adjusted_qty,
        SUM(
          CASE
            WHEN COALESCE(i.shortage_percent, c.shortage_percent, ca.shortage_percent) IS NULL THEN
              COALESCE(i.weight, 0) * (
                0.02 * (
                  CASE
                    WHEN CAST((julianday(?) - julianday(i.date)) AS INTEGER) <= 0 THEN 1
                    ELSE CAST((CAST((julianday(?) - julianday(i.date)) AS INTEGER) - 1) / 30 AS INTEGER) + 1
                  END
                )
              )
            ELSE
              COALESCE(i.weight, 0) * (COALESCE(i.shortage_percent, c.shortage_percent, ca.shortage_percent) / 100.0)
          END
        ) AS shortage_qty,
        SUM(
          COALESCE(i.weight, 0)
          - (
            CASE
              WHEN COALESCE(i.shortage_percent, c.shortage_percent, ca.shortage_percent) IS NULL THEN
                COALESCE(i.weight, 0) * (
                  0.02 * (
                    CASE
                      WHEN CAST((julianday(?) - julianday(i.date)) AS INTEGER) <= 0 THEN 1
                      ELSE CAST((CAST((julianday(?) - julianday(i.date)) AS INTEGER) - 1) / 30 AS INTEGER) + 1
                    END
                  )
                )
              ELSE
                COALESCE(i.weight, 0) * (COALESCE(i.shortage_percent, c.shortage_percent, ca.shortage_percent) / 100.0)
            END
          )
          - COALESCE(adj.adjusted_qty, 0)
        ) AS available_balance_qty
      FROM inward i
      LEFT JOIN companies c ON CAST(c.id AS TEXT) = CAST(i.company_id AS TEXT)
      LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(i.company_account_id AS TEXT)
      LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(i.warehouse_id AS TEXT)
      LEFT JOIN locations l ON CAST(l.id AS TEXT) = CAST(w.location_id AS TEXT)
      LEFT JOIN adjusted adj ON CAST(adj.inward_id AS TEXT) = CAST(i.id AS TEXT)
      GROUP BY COALESCE(w.name, 'Unknown'), COALESCE(c.name, ca.account_name, 'Unknown'), COALESCE(l.name, '')
      ORDER BY warehouse ASC, party ASC, location ASC
    `;

    const rows = await dbAll(sql, [currentDate, currentDate, currentDate, currentDate]);
    return res.json(
      (rows || []).map((row) => ({
        warehouse: row.warehouse,
        party: row.party,
        location: row.location,
        stock: Number(Number(row.available_balance_qty || 0).toFixed(4)),
        rows_count: Number(row.rows_count || 0),
        gross_qty: Number(Number(row.gross_qty || 0).toFixed(4)),
        already_adjusted_qty: Number(Number(row.already_adjusted_qty || 0).toFixed(4)),
        shortage_qty: Number(Number(row.shortage_qty || 0).toFixed(4)),
      }))
    );
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
  const q = `
    SELECT
      p.*,
      w.name AS warehouse_name,
      w.address AS warehouse_address,
      l.name AS warehouse_location,
      ca.account_name AS company_account_name,
      ca.mobile AS company_account_mobile,
      ca.pan_no AS company_account_pan,
      ca.address AS company_account_address,
      f.name AS farmer_name,
      f.mobile AS farmer_mobile,
      f.address AS farmer_address,
      f.village AS farmer_village,
      f.gst_no AS farmer_gst,
      f.pan_no AS farmer_pan,
      f.state AS farmer_state,
      f.location AS farmer_district,
      NULL AS farmer_pincode,
      NULL AS farmer_bank_name,
      NULL AS farmer_bank_account_no,
      NULL AS farmer_ifsc_code,
      NULL AS farmer_branch_name,
      NULL AS farmer_account_holder_name,
      pr.name AS product_name
    FROM wh_purchase_vouchers p
    LEFT JOIN warehouses w ON w.id = p.warehouse_id
    LEFT JOIN locations l ON l.id = w.location_id
    LEFT JOIN company_accounts ca ON ca.id = p.company_account_id
    LEFT JOIN farmers f ON f.id = p.farmer_id
    LEFT JOIN products pr ON pr.id = p.product_id
    WHERE p.id = ?
  `;
  db.get(q, [id], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) {
      try {
        row = await getMongoPurchaseVoucherForPdf(id);
      } catch (mongoErr) {
        console.error("Mongo purchase PDF lookup failed:", mongoErr.message);
        return res.status(500).json({ error: mongoErr.message });
      }
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
      try {
        return sendMinimalPurchaseVoucherPdf(res, row, id);
      } catch (fallbackErr) {
        console.error("Purchase PDF fallback failed:", fallbackErr.stack || fallbackErr.message || fallbackErr);
        return res.status(500).json({ error: "Failed to render purchase PDF" });
      }
    }
  });
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

    if (!row) {
      const q = `
      SELECT
          s.*,
          COALESCE(s.buyer_id, s.company_id) AS buyer_id,
          tb.bilti_id AS bilti_id,
          w.name AS warehouse_name,
          c.name AS company_name,
          b.name AS buyer_name,
          co.name AS consignee_name,
          p.name AS product_name
        FROM wh_sale_vouchers s
        LEFT JOIN (
          SELECT sale_id, MAX(id) AS bilti_id
          FROM transport_bilti
          WHERE sale_id IS NOT NULL
          GROUP BY sale_id
        ) tb ON CAST(tb.sale_id AS TEXT) = CAST(s.id AS TEXT)
        LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(s.warehouse_id AS TEXT)
        LEFT JOIN companies c ON CAST(c.id AS TEXT) = CAST(s.company_id AS TEXT)
        LEFT JOIN buyer_names b ON CAST(b.id AS TEXT) = CAST(COALESCE(s.buyer_id, s.company_id) AS TEXT)
        LEFT JOIN consignee_names co ON CAST(co.id AS TEXT) = CAST(s.consignee_id AS TEXT)
        LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(s.product_id AS TEXT)
        WHERE CAST(s.id AS TEXT) = CAST(? AS TEXT)
      `;
      row = await dbGet(q, [id]);
    }

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
    const totalDeduction = Number(row.total_deduction || 0) || Number(row.claim_amount || 0) + Number(row.other_deduction || 0) + Number(row.cd_amount || 0) + Number(row.adjustment_amount || 0) + Number(row.tds_amount || 0);
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

    if (!row) {
      const q = `
      SELECT
          s.*,
          COALESCE(s.buyer_id, s.company_id) AS buyer_id,
          tb.bilti_id AS bilti_id,
          w.name AS warehouse_name,
          c.name AS company_name,
          b.name AS buyer_name,
          co.name AS consignee_name,
          p.name AS product_name
        FROM wh_sale_vouchers s
        LEFT JOIN (
          SELECT sale_id, MAX(id) AS bilti_id
          FROM transport_bilti
          WHERE sale_id IS NOT NULL
          GROUP BY sale_id
        ) tb ON CAST(tb.sale_id AS TEXT) = CAST(s.id AS TEXT)
        LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(s.warehouse_id AS TEXT)
        LEFT JOIN companies c ON CAST(c.id AS TEXT) = CAST(s.company_id AS TEXT)
        LEFT JOIN buyer_names b ON CAST(b.id AS TEXT) = CAST(COALESCE(s.buyer_id, s.company_id) AS TEXT)
        LEFT JOIN consignee_names co ON CAST(co.id AS TEXT) = CAST(s.consignee_id AS TEXT)
        LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(s.product_id AS TEXT)
        WHERE CAST(s.id AS TEXT) = CAST(? AS TEXT)
      `;
      row = await dbGet(q, [id]);
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
    const totalDeduction = Number(row.total_deduction || 0) || Number(row.claim_amount || 0) + Number(row.other_deduction || 0) + Number(row.cd_amount || 0) + Number(row.adjustment_amount || 0) + Number(row.tds_amount || 0);
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

  const query = `
    UPDATE wh_purchase_vouchers SET
      voucher_no=?, date=?, warehouse_id=?, farmer_id=?, company_account_id=?, product_id=?, quantity=?, rate=?, amount=?,
      packet=?, gross_weight=?, tare_weight=?, dhalta=?, less_bags_weight=?, moisture=?, dunki=?, fungus=?,
      discolour=?, others=?, net_weight=?, bags_claim=?, labour=?, total_deduct_amount=?, total_qty=?,
      total_deduction=?, round_off=?, net_amount_payable=?, employee_id=?, location_id=?, description=?
    WHERE id = ?
  `;

  db.run(query, [
    voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
    packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
    discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
    total_deduction, round_off, net_amount_payable, employee_id, location_id, description, id
  ], function(err) {
    if (err) {
      if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
      return res.status(500).json({ error: err.message });
    }
    res.json({ id, message: "Voucher updated successfully" });
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

  const query = "DELETE FROM wh_purchase_vouchers WHERE id = ?";

  db.run(query, [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "Voucher not found" });
    res.json({ message: "Voucher deleted successfully" });
  });
});

module.exports = router;
