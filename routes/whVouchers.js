const express = require("express");
const router = express.Router();
const db = require("../db");
const { userHasPermission } = require("../middleware/auth");
const { assignedWarehouseFilter, canAccessWarehouse } = require("../helpers/access");
const PDFDocument = require('pdfkit');
const multer = require("multer");
const XLSX = require("xlsx");
const {
  mongoose,
  PurchaseVoucher,
  SaleVoucher,
  Warehouse,
  Farmer,
  Product,
  CompanyAccount,
  Employee,
  Location,
} = require("../mongo");

const upload = multer({ storage: multer.memoryStorage() });

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
  if (!dueDate && baseDate) {
    dueDate = addDaysToDate(baseDate, dueDays);
  }
  if (!dueDate) {
    dueDate = toDateOnly(fallback?.due_date) || "";
  }
  if (explicitDueDate && !hasDueDays && baseDate) {
    dueDays = calculateDaysDiff(baseDate, explicitDueDate);
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
  const dueDate = toDateOnly(row?.due_date);
  const outstanding = Number(row?.outstanding ?? row?.net_amount_payable ?? row?.net_receivable_amount ?? row?.amount ?? 0);
  const unloadingDate = toDateOnly(row?.unloading_date);
  const today = toDateOnly(new Date().toISOString().slice(0, 10));
  const dueDays = Number(row?.due_days || 0);
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

function getSqliteSaleRowsForUser(user) {
  const filter = assignedWarehouseFilter(user, "v.warehouse_id");
  return dbAll(
    `
      SELECT
        v.*,
        COALESCE(v.buyer_id, v.company_id) AS buyer_id,
        b.name AS buyer_name,
        b.email AS buyer_email,
        co.name AS consignee_name,
        co.email AS consignee_email,
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
    `,
    filter.params
  );
}

async function getAllSaleVoucherRowsForUser(user) {
  const sqliteRows = await getSqliteSaleRowsForUser(user);
  if (!mongoReady()) return sqliteRows;
  const mongoRows = await SaleVoucher.find(mongoPurchaseScope(user)).lean();
  const mergedRows = mergeSaleRows(await decorateSaleRows(mongoRows), sqliteRows);
  const withBilti = await attachSaleBiltiIds(mergedRows);
  return withBilti.map((row) => ({
    ...row,
    ...calculateSaleFollowupMeta(row),
  }));
}

function getSaleVoucherRows(req, res) {
  if (mongoReady()) {
    getAllSaleVoucherRowsForUser(req.user)
      .then((rows) => res.json(rows || []))
      .catch((err) => {
        console.error("Mongo sale voucher query failed, falling back to SQLite:", err.message);
        getSaleVoucherRowsSqlite(req, res);
      });
    return;
  }

  getSaleVoucherRowsSqlite(req, res);
}

function getSaleVoucherRowsSqlite(req, res) {
  const filter = assignedWarehouseFilter(req.user, "v.warehouse_id");
  const query = `
    SELECT
      v.*,
      COALESCE(v.buyer_id, v.company_id) AS buyer_id,
      b.name AS buyer_name,
      b.email AS buyer_email,
      co.name AS consignee_name,
      co.email AS consignee_email,
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
  "net_weight",
  "bags_claim",
  "labour",
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
    product_id: body.product_id ? String(body.product_id) : "",
    employee_id: body.employee_id ? String(body.employee_id) : "",
    location_id: body.location_id ? String(body.location_id) : "",
    description: body.description || "",
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
    "moisture",
    "dunki",
    "fungus",
    "discolour",
    "others",
    "total_deduction",
    "bags_claim",
    "other_deduction",
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
      farmer_name: farmer?.name || plain.farmer_name,
      product_name: product?.name || plain.product_name,
      company_account_name: account?.account_name || plain.company_account_name,
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
  const plainRows = rows.map((row) => (row.toObject ? row.toObject() : row));
  const warehouseIds = [...new Set(plainRows.map((r) => r.warehouse_id).filter(Boolean))];
  const productIds = [...new Set(plainRows.map((r) => r.product_id).filter(Boolean))];
  const accountIds = [...new Set(plainRows.map((r) => r.company_account_id).filter(Boolean))];
  const buyerIds = [...new Set(plainRows.map((r) => r.buyer_id || r.company_id).filter(Boolean))];
  const consigneeIds = [...new Set(plainRows.map((r) => r.consignee_id).filter(Boolean))];

  const mongoWarehouseIds = warehouseIds.filter(mongoose.Types.ObjectId.isValid);
  const mongoProductIds = productIds.filter(mongoose.Types.ObjectId.isValid);
  const mongoAccountIds = accountIds.filter(mongoose.Types.ObjectId.isValid);

  const [
    mongoWarehouses,
    mongoProducts,
    mongoAccounts,
    sqliteWarehouses,
    sqliteProducts,
    sqliteAccounts,
    sqliteBuyers,
    sqliteConsignees,
  ] = await Promise.all([
    mongoWarehouseIds.length ? Warehouse.find({ _id: { $in: mongoWarehouseIds } }).lean() : [],
    mongoProductIds.length ? Product.find({ _id: { $in: mongoProductIds } }).lean() : [],
    mongoAccountIds.length ? CompanyAccount.find({ _id: { $in: mongoAccountIds } }).lean() : [],
    sqliteRowsByIds("warehouses", warehouseIds),
    sqliteRowsByIds("products", productIds),
    sqliteRowsByIds("company_accounts", accountIds),
    sqliteRowsByIds("buyer_names", buyerIds),
    sqliteRowsByIds("consignee_names", consigneeIds),
  ]);

  const byMongoId = (items) => new Map(items.map((item) => [String(item._id), item]));
  const mongoWarehouseMap = byMongoId(mongoWarehouses);
  const mongoProductMap = byMongoId(mongoProducts);
  const mongoAccountMap = byMongoId(mongoAccounts);

  return plainRows.map((plain) => {
    const buyerId = plain.buyer_id || plain.company_id || "";
    const warehouse = mongoWarehouseMap.get(String(plain.warehouse_id)) || sqliteWarehouses.get(String(plain.warehouse_id));
    const product = mongoProductMap.get(String(plain.product_id)) || sqliteProducts.get(String(plain.product_id));
    const account = mongoAccountMap.get(String(plain.company_account_id)) || sqliteAccounts.get(String(plain.company_account_id));
    const buyer = sqliteBuyers.get(String(buyerId));
    const consignee = sqliteConsignees.get(String(plain.consignee_id));
    const totalQuantity = plain.quantity || Math.max(Number(plain.gross_weight || 0) - Number(plain.tare_weight || 0), 0);
    const totalAmount = plain.amount || 0;
    return {
      ...plain,
      id: String(plain._id || plain.id),
      _id: String(plain._id || plain.id),
      buyer_id: buyerId,
      warehouse_name: warehouse?.name || plain.warehouse_name,
      product_name: product?.name || plain.product_name,
      company_account_name: account?.account_name || account?.name || plain.company_account_name,
      buyer_name: buyer?.name || plain.buyer_name || plain.company_name,
      buyer_email: buyer?.email || plain.buyer_email || "",
      consignee_name: consignee?.name || plain.consignee_name,
      consignee_email: consignee?.email || plain.consignee_email || "",
      total_quantity: totalQuantity,
      total_amount: totalAmount,
      ...calculateSaleFollowupMeta(plain),
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

async function getAllPurchaseVoucherRows(req) {
  const mongoRows = await PurchaseVoucher.find(mongoPurchaseScope(req.user)).lean();
  const sqliteRows = await getSqlitePurchaseRows(req);
  return mergePurchaseRows(
    await decoratePurchaseRows(mongoRows),
    sqliteRows
  );
}

function getPurchaseVoucherRows(req, res) {
  if (mongoReady()) {
    getAllPurchaseVoucherRows(req)
      .then((rows) => res.json(rows || []))
      .catch((err) => {
        console.error("Mongo purchase voucher query failed, falling back to SQLite:", err.message);
        getPurchaseVoucherRowsSqlite(req, res);
      });
    return;
  }

  getPurchaseVoucherRowsSqlite(req, res);
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

function ensureWarehouseAccess(req, res, warehouseId) {
  if (!warehouseId) {
    res.status(400).json({ error: "Warehouse is required" });
    return false;
  }

  if (!canAccessWarehouse(req.user, warehouseId)) {
    res.status(403).json({ error: "You do not have access to this warehouse" });
    return false;
  }

  return true;
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
  if (!mongoose.Types.ObjectId.isValid(farmerId)) return row;

  const farmer = await Farmer.findById(farmerId).lean();
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
    farmer_bank_name: row.farmer_bank_name || farmer.bank_name,
    farmer_bank_account_no: row.farmer_bank_account_no || farmer.bank_account_no,
    farmer_ifsc_code: row.farmer_ifsc_code || farmer.ifsc_code,
    farmer_branch_name: row.farmer_branch_name || farmer.branch_name,
    farmer_account_holder_name: row.farmer_account_holder_name || farmer.account_holder_name,
  };
}

function sendPurchaseVoucherPdf(res, row, id) {
  const doc = new PDFDocument({ size: "A4", margin: 28 });
  res.setHeader("Content-Type", "application/pdf");
  const safeName = String(row.voucher_no || id).replace(/[/\\?%*:|"<>]/g, "-");
  res.setHeader("Content-Disposition", `attachment; filename="purchase_${safeName}.pdf"`);
  doc.pipe(res);

  const pageW = doc.page.width;
  const contentW = pageW - 56;
  const primary = "#0f2f63";
  const accent = "#ea580c";
  const muted = "#64748b";
  const border = "#cbd5e1";
  const light = "#f8fafc";
  const x = 28;
  let y = 28;
  const accountName = row.company_account_name || "SHIVANSH";
  const accountAddress = row.company_account_address || row.warehouse_address || "-";
  const warehouseLine = [row.warehouse_name, row.warehouse_location].filter(Boolean).join(" - ");
  const netQty = row.total_qty || row.net_weight || row.quantity || 0;
  const grossAmount = Number(netQty || 0) * Number(row.rate || 0);
  const netPayable = row.net_amount_payable || row.amount || 0;
  const fmt4 = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(4) : "0.0000";
  };

  const labelValue = (label, value, tx, ty, width = 120) => {
    doc.fillColor("#111827").fontSize(8.4).text(label, tx, ty, { width: width * 0.45 });
    doc.fillColor(muted).text(":", tx + width * 0.45, ty);
    doc.fillColor("#111827").text(value || "-", tx + width * 0.52, ty, { width: width * 0.48 });
  };

  doc.rect(x - 10, y - 10, contentW + 20, 760).lineWidth(2).stroke(primary);

  doc.circle(x + 28, y + 28, 24).lineWidth(2).stroke(accent);
  doc.fillColor(primary).fontSize(25).text(accountName, x + 66, y + 13, { width: 285 });
  doc.fillColor(accent).fontSize(7.8).text("GRAIN MERCHANT & COMMISSION AGENT", x + 70, y + 50);
  doc.fillColor(primary).fontSize(8.5).text("Phone", x + 340, y + 15);
  doc.fillColor("#111827").text(row.company_account_mobile || "9064348416 / 9304251749", x + 370, y + 15);
  doc.fillColor(primary).text("Mobile", x + 448, y + 15);
  doc.fillColor("#111827").text(row.farmer_mobile || "7004862400", x + 485, y + 15);
  doc.polygon([x + 382, y + 46], [x + contentW, y + 46], [x + contentW, y + 86], [x + 348, y + 86]).fill(primary);
  doc.fillColor("#fff").fontSize(14).text("PURCHASE MEMO", x + 388, y + 58, { width: 178, align: "center" });
  doc.fillColor("#111827").fontSize(9).text(`Location: ${warehouseLine || "-"}`, x, y + 94, { width: contentW });
  doc.moveTo(x, y + 116).lineTo(x + contentW, y + 116).stroke(border);
  y += 132;

  doc.fillColor("#111827").fontSize(10).text("Serial No.", x + 10, y);
  doc.fillColor(accent).fontSize(12).text(row.voucher_no || id, x + 85, y - 1);
  doc.fillColor("#111827").fontSize(10).text("Date", x + contentW - 130, y);
  doc.fillColor(accent).fontSize(11).text(fmtDate(row.date), x + contentW - 82, y);
  y += 30;

  const leftW = (contentW - 14) / 2;
  const rightX = x + leftW + 14;
  doc.roundedRect(x, y + 14, leftW, 96, 4).stroke(border);
  doc.roundedRect(rightX, y + 14, leftW, 96, 4).stroke(border);
  doc.rect(x, y, 210, 28).fill(primary);
  doc.polygon([x + 210, y], [x + 236, y], [x + 216, y + 28], [x + 210, y + 28]).fill(primary);
  doc.rect(rightX, y, 220, 28).fill(accent);
  doc.polygon([rightX + 220, y], [rightX + 246, y], [rightX + 226, y + 28], [rightX + 220, y + 28]).fill(accent);
  doc.fillColor("#fff").fontSize(10).text("PARTY INFORMATION", x + 55, y + 9);
  doc.text("DOCUMENT INFORMATION", rightX + 65, y + 9);

  const pStart = y + 38;
  labelValue("Name of Party", row.farmer_name, x + 10, pStart, leftW - 20);
  labelValue("PAN", row.farmer_pan, x + 10, pStart + 18, leftW - 20);
  labelValue("GSTIN", row.farmer_gst, x + 10, pStart + 36, leftW - 20);
  labelValue("Phone", row.farmer_mobile, x + 10, pStart + 54, leftW - 20);
  labelValue("Village", row.farmer_village || row.farmer_address, x + 10, pStart + 72, leftW - 20);

  labelValue("R.S.T. No.", row.reference_id || "-", rightX + 10, pStart + 8, leftW - 20);
  labelValue("Transport No.", "-", rightX + 10, pStart + 34, leftW - 20);
  labelValue("Warehouse", row.warehouse_name || row.warehouse_id, rightX + 10, pStart + 60, leftW - 20);
  y += 130;

  const remarksW = 150;
  const tableX = x + remarksW + 10;
  const tableW = contentW - remarksW - 10;
  const col1 = 42;
  const col2 = tableW - 180 - col1;
  const tableY = y;
  doc.roundedRect(x, tableY, remarksW, 244, 4).stroke(border);
  doc.rect(x, tableY, remarksW, 24).fill(primary);
  doc.fillColor("#fff").fontSize(10).text("REMARKS", x, tableY + 7, { width: remarksW, align: "center" });
  doc.fillColor("#111827").fontSize(9).text(row.description || "", x + 10, tableY + 36, { width: remarksW - 20, height: 190 });

  doc.roundedRect(tableX, tableY, tableW, 244, 4).stroke(border);
  doc.rect(tableX, tableY, tableW, 24).fill(primary);
  doc.fillColor("#fff").fontSize(10).text("", tableX + 10, tableY + 7);
  doc.text("PARTICULARS", tableX + col1 + 10, tableY + 7);
  doc.text("AMOUNT (Rs.)", tableX + col1 + col2 + 10, tableY + 7, { width: 160, align: "right" });
  y = tableY + 24;

  [
    ["1", "Product", row.product_name || row.product_id || "-"],
    ["2", "Packet", fmt4(row.packet)],
    ["3", "Gross Weight", fmt4(row.gross_weight)],
    ["4", "Tare Weight", fmt4(row.tare_weight)],
    ["5", "New Weight", fmt4(Math.max(Number(row.gross_weight || 0) - Number(row.tare_weight || 0), 0))],
    ["6", "Dhalta", fmt4(row.dhalta)],
    ["7", "Less Bags Weight", fmt4(row.less_bags_weight)],
    ["8", "Moisture", fmt4(row.moisture)],
    ["9", "Dunki / Fungus", fmt4(Number(row.dunki || 0) + Number(row.fungus || 0))],
    ["10", "Discolour / Others", fmt4(Number(row.discolour || 0) + Number(row.others || 0))],
    ["11", "Bags Claim", fmt4(row.bags_claim)],
    ["12", "Labour", fmt4(row.labour)],
    ["13", "Round Off", fmt4(row.round_off)],
  ].forEach((ln) => {
    doc.rect(tableX, y, tableW, 18).stroke(border);
    doc.fillColor("#111827").fontSize(8.8).text(ln[0], tableX + 14, y + 5);
    doc.text(ln[1], tableX + col1 + 10, y + 5);
    doc.text(ln[2], tableX + col1 + col2 + 10, y + 5, { width: 160, align: "right" });
    y += 18;
  });

  y = tableY + 258;
  const summaryW = 330;
  const totalX = x + summaryW + 10;
  const boxW = summaryW / 5;
  [
    ["PURCHASED KG.", fmt4(row.gross_weight)],
    ["MAKKA QTY.", fmt4(netQty)],
    ["BORA QTY.", fmt4(row.packet)],
    ["LABOUR CHARGES", fmt4(row.labour)],
    ["TOTAL", fmt4(grossAmount || netPayable)],
  ].forEach((item, index) => {
    const bx = x + index * boxW;
    doc.rect(bx, y, boxW, 52).stroke(border);
    doc.fillColor(primary).fontSize(7.2).text(item[0], bx + 4, y + 10, { width: boxW - 8, align: "center" });
    doc.fillColor(accent).fontSize(10).text(item[1], bx + 4, y + 32, { width: boxW - 8, align: "center" });
  });

  doc.roundedRect(totalX, y, contentW - summaryW - 10, 52, 4).stroke(border);
  labelValue("Total Qty.", fmt4(netQty), totalX + 12, y + 8, contentW - summaryW - 34);
  labelValue("Total Deductions", fmt4(row.total_deduction || row.total_deduct_amount), totalX + 12, y + 25, contentW - summaryW - 34);
  doc.rect(totalX, y + 36, contentW - summaryW - 10, 16).fill(primary);
  doc.fillColor("#fff").fontSize(8.5).text("Net Amount Payable", totalX + 12, y + 41);
  doc.fillColor("#fff").fontSize(8.5).text(fmt4(netPayable), totalX + 100, y + 41, { width: contentW - summaryW - 124, align: "right" });

  y += 68;
  doc.roundedRect(x, y, contentW, 76, 4).stroke(border);
  doc.rect(x + 58, y, 190, 22).fill(primary);
  doc.polygon([x + 248, y], [x + 270, y], [x + 252, y + 22], [x + 248, y + 22]).fill(primary);
  doc.fillColor("#fff").fontSize(10).text("ADDITIONAL DETAILS", x + 80, y + 7);
  labelValue("Bank", row.farmer_bank_name || "-", x + 12, y + 38, 160);
  labelValue("IFSC Code", row.farmer_ifsc_code || "-", x + 12, y + 58, 160);
  labelValue("Name of Party", row.farmer_account_holder_name || row.farmer_name, x + 205, y + 38, 160);
  labelValue("Branch", row.farmer_branch_name || "-", x + 205, y + 58, 160);
  labelValue("Account Number", row.farmer_bank_account_no || "-", x + 395, y + 38, 150);
  labelValue("Transport No.", "-", x + 395, y + 58, 150);

  y += 94;
  doc.roundedRect(x + 110, y, contentW - 220, 34, 3).stroke(accent);
  doc.fillColor(accent).fontSize(8).text("NOTE", x + 255, y - 6);
  doc.fillColor("#111827").fontSize(8.5).text("Buyer and Seller disputes will be resolved at village level.", x + 130, y + 11, { width: contentW - 260, align: "center" });
  y += 58;
  doc.fillColor("#111827").fontSize(9).text("Customer Signature", x + 48, y);
  doc.moveTo(x + 35, y + 22).lineTo(x + 170, y + 22).stroke(border);
  doc.text("Authorised Signature", x + contentW - 180, y);
  doc.moveTo(x + contentW - 190, y + 22).lineTo(x + contentW - 45, y + 22).stroke(border);

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
  const purchaseSql = mongoReady()
    ? null
    : `SELECT COALESCE(SUM(COALESCE(NULLIF(net_amount_payable, 0), amount)), 0) AS total_purchase FROM wh_purchase_vouchers WHERE farmer_id = ?${companyAccountId ? " AND company_account_id = ?" : ""}`;
  const paymentSql = `SELECT COALESCE(SUM(amount), 0) AS total_payment FROM wh_payment_vouchers WHERE farmer_id = ?${companyAccountId ? " AND company_account_id = ?" : ""}`;
  const finish = (totalPurchase) => {
    const paymentParams = [farmerId];
    if (companyAccountId) paymentParams.push(companyAccountId);
    db.get(paymentSql, paymentParams, (err2, payment) => {
      if (err2) return callback(err2);
      const totalPayment = payment?.total_payment || 0;
      callback(null, {
        total_purchase: totalPurchase,
        total_payment: totalPayment,
        outstanding: Number((totalPurchase - totalPayment).toFixed(2)),
      });
    });
  };

  if (mongoReady()) {
    const filter = { farmer_id: String(farmerId || "") };
    if (companyAccountId) filter.company_account_id = String(companyAccountId);
    PurchaseVoucher.find(filter)
      .lean()
      .then((rows) => {
        const totalPurchase = (rows || []).reduce(
          (sum, row) => sum + Number(row.net_amount_payable || row.amount || 0),
          0
        );
        finish(totalPurchase);
      })
      .catch(callback);
    return;
  }

  const purchaseParams = [farmerId];
  if (companyAccountId) purchaseParams.push(companyAccountId);
  db.get(purchaseSql, purchaseParams, (err, purchase) => {
    if (err) return callback(err);
    finish(purchase?.total_purchase || 0);
  });
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

function validatePaymentAdjustments({ farmerId, warehouseId, amount, adjustments, excludePaymentId = null }, callback) {
  const cleanAdjustments = normalizePaymentAdjustments(adjustments);
  const paymentAmount = Number(amount || 0);
  const adjustedTotal = cleanAdjustments.reduce((sum, item) => sum + item.adjusted_amount, 0);

  if (paymentAmount <= 0) {
    return callback(new Error("Payment amount is required"));
  }

  if (!cleanAdjustments.length) {
    return callback(new Error("Please adjust this payment against purchase bills"));
  }

  if (Math.abs(adjustedTotal - paymentAmount) > 0.0001) {
    return callback(new Error("Payment amount and adjustment amount must be equal"));
  }

  getPaymentAdjustmentsByPurchase((err, adjustedMap) => {
    if (err) return callback(err);

    const finish = (purchaseRows) => {
      const purchaseMap = new Map((purchaseRows || []).map((row) => [String(row.id || row._id), row]));
      for (const item of cleanAdjustments) {
        const purchase = purchaseMap.get(String(item.purchase_id));
        if (!purchase) {
          return callback(new Error("Invalid purchase adjustment target"));
        }

        const billAmount = Number(purchase.amount || purchase.net_amount_payable || purchase.total_amount || 0);
        const alreadyAdjusted = adjustedMap.get(String(item.purchase_id)) || 0;
        const pending = Math.max(0, billAmount - alreadyAdjusted);
        if (item.adjusted_amount - pending > 0.0001) {
          return callback(new Error(`Adjustment cannot exceed pending amount for ${purchase.voucher_no || item.purchase_id}`));
        }
      }

      callback(null, cleanAdjustments);
    };

    if (mongoReady()) {
      const filter = { farmer_id: String(farmerId || "") };
      if (warehouseId) filter.warehouse_id = String(warehouseId);
      PurchaseVoucher.find(filter)
        .lean()
        .then((rows) => finish((rows || []).map((row) => ({
          ...row,
          id: String(row._id),
          amount: Number(row.net_amount_payable || row.amount || 0),
        }))))
        .catch(callback);
      return;
    }

    const params = [farmerId];
    let warehouseClause = "";
    if (warehouseId) {
      warehouseClause = " AND CAST(warehouse_id AS TEXT) = CAST(? AS TEXT)";
      params.push(warehouseId);
    }
    db.all(
      `
        SELECT id, voucher_no, COALESCE(NULLIF(net_amount_payable, 0), amount) AS amount
        FROM wh_purchase_vouchers
        WHERE CAST(farmer_id AS TEXT) = CAST(? AS TEXT) ${warehouseClause}
      `,
      params,
      (rowsErr, rows) => (rowsErr ? callback(rowsErr) : finish(rows || []))
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

  if (receiptAmount <= 0) {
    return callback(new Error("Receipt amount is required"));
  }

  if (!cleanAdjustments.length) {
    return callback(new Error("Please adjust this receipt against sale bills"));
  }

  if (Math.abs(adjustedTotal - receiptAmount) > 0.0001) {
    return callback(new Error("Receipt amount and adjustment amount must be equal"));
  }

  getReceiptAdjustmentsBySale((err, adjustedMap) => {
    if (err) return callback(err);

    const finish = (sales) => {
      const saleMap = new Map((sales || []).map((row) => [String(row.id), row]));
      for (const item of cleanAdjustments) {
        const sale = saleMap.get(String(item.sale_id));
        if (!sale) {
          return callback(new Error("Invalid sale adjustment target"));
        }

        const billAmount = Number(sale.amount || sale.net_receivable_amount || 0);
        const alreadyAdjusted = adjustedMap.get(String(item.sale_id)) || 0;
        const pending = Math.max(0, billAmount - alreadyAdjusted);
        if (item.adjusted_amount - pending > 0.0001) {
          return callback(new Error(`Adjustment cannot exceed pending amount for ${sale.voucher_no || item.sale_id}`));
        }
      }

      callback(null, cleanAdjustments);
    };

    if (mongoReady()) {
      const filter = {
        $or: [
          { buyer_id: String(companyId) },
          { company_id: String(companyId) },
        ],
      };
      return SaleVoucher.find(filter)
        .lean()
        .then((rows) => finish((rows || []).map((row) => ({
          ...row,
          id: String(row._id),
          amount: Number(row.net_receivable_amount || row.amount || 0),
        })) ))
        .catch((mongoErr) => callback(mongoErr));
    }

    const params = [companyId];
    db.all(
      `
        SELECT id, voucher_no, COALESCE(NULLIF(net_receivable_amount, 0), amount) AS amount
        FROM wh_sale_vouchers
        WHERE CAST(COALESCE(buyer_id, company_id) AS TEXT) = CAST(? AS TEXT)
      `,
      params,
      (rowsErr, sales) => {
        if (rowsErr) return callback(rowsErr);
        finish(sales || []);
      }
    );
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

router.get("/purchase/import-template", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }
  const buffer = purchaseImportTemplateBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="purchase_voucher_import_format.xlsx"');
  res.send(buffer);
});

router.post("/purchase/import-xlsx", upload.single("file"), async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.manage")) {
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
  if (!userHasPermission(req.user, "warehouse.trading.purchase.manage")) {
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
    computeOutstandingForFarmer(id, (err, stats) => {
      if (err) return res.status(500).json({ error: err.message });
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
            const totalPayment = (payments || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
            const scopedStats = {
              total_purchase: Number(totalPurchase.toFixed(2)),
              total_payment: Number(totalPayment.toFixed(2)),
              outstanding: Number((totalPurchase - totalPayment).toFixed(2)),
            };
            res.json({ party_type: "farmer", id, stats: scopedStats, purchases, payments });
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
    }, company_account_id);
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
router.get("/farmers-by-account/:accountId", (req, res) => {
  const { accountId } = req.params;
  const { warehouse_id } = req.query;
  if (!accountId) return res.status(400).json({ error: "Account ID is required" });

  if (mongoReady()) {
    const filter = { company_account_id: String(accountId) };
    const selectedWarehouseId = String(warehouse_id || "").trim();
    const assignedWarehouses = req.user && Array.isArray(req.user.assigned_warehouses)
      ? req.user.assigned_warehouses.map((id) => String(id))
      : [];
    if (selectedWarehouseId) {
      if (assignedWarehouses.length) {
        if (!assignedWarehouses.includes(selectedWarehouseId)) return res.json([]);
      }
      filter.warehouse_id = selectedWarehouseId;
    } else if (assignedWarehouses.length) {
      filter.warehouse_id = { $in: assignedWarehouses };
    }

    return PurchaseVoucher.find(filter)
      .lean()
      .then(async (rows) => {
        const farmerIds = [...new Set((rows || []).map((r) => String(r.farmer_id || "")).filter(Boolean))];
        if (!farmerIds.length) return res.json([]);

        const farmers = await Farmer.find({ _id: { $in: farmerIds } })
          .select("_id name mobile address village")
          .lean();

        const result = await Promise.all(
          (farmers || []).map(
            (f) =>
              new Promise((resolve) => {
                computeOutstandingForFarmer(String(f._id), (_err, stats = {}) => {
                  const outstanding = Number(stats.outstanding || 0);
                  resolve({
                    id: String(f._id),
                    name: f.name,
                    mobile: f.mobile,
                    address: f.address,
                    village: f.village,
                    total_purchase: Number(stats.total_purchase || 0),
                    total_adjusted: Number(stats.total_payment || 0),
                    outstanding: Number(outstanding.toFixed(2)),
                  });
                }, accountId);
              })
          )
        );

        return res.json(result.filter((f) => f.outstanding > 0));
      })
      .catch((err) => res.status(500).json({ error: err.message }));
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
  if (!userHasPermission(req.user, "warehouse.trading.sale.manage")) {
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
        } else {
          const directPurchase = await createDirectSalePurchaseVoucher(payload);
          payload.against_purchase_enabled = Boolean(directPurchase);
          payload.against_purchase_farmer_id = directPurchase?.farmer_id || payload.against_purchase_farmer_id || "";
          payload.against_purchase_links = directPurchase ? [directPurchase] : [];
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
  if (!userHasPermission(req.user, "warehouse.trading.sale.manage")) {
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
          const manualClaimValue = Number(req.body.claim_amount !== undefined ? req.body.claim_amount : existing.claim_amount) || 0;
          const adjustmentValue = Number(req.body.adjustment_amount !== undefined ? req.body.adjustment_amount : existing.adjustment_amount) || 0;
          const tdsValue = Number(req.body.tds_amount !== undefined ? req.body.tds_amount : existing.tds_amount) || 0;
          const roundOffValue = Number(req.body.round_off !== undefined ? req.body.round_off : existing.round_off) || 0;
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

          const netAmount = grossAmount - claimValue - otherDeductionValue - cdAmountValue - adjustmentValue - tdsValue + roundOffValue;

          existing.unloading_date = req.body.unloading_date !== undefined ? req.body.unloading_date : existing.unloading_date;
          existing.unloading_qty = unloadingQtyValue;
          existing.shortage_quantity = shortageQty;
          existing.moisture = Number(req.body.moisture !== undefined ? req.body.moisture : existing.moisture) || 0;
          existing.dunki = Number(req.body.dunki !== undefined ? req.body.dunki : existing.dunki) || 0;
          existing.fungus = Number(req.body.fungus !== undefined ? req.body.fungus : existing.fungus) || 0;
          existing.discolour = Number(req.body.discolour !== undefined ? req.body.discolour : existing.discolour) || 0;
          existing.others = Number(req.body.others !== undefined ? req.body.others : existing.others) || 0;
          existing.total_deduction = Number(req.body.total_deduction !== undefined ? req.body.total_deduction : existing.total_deduction) || 0;
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
  const cdPercentValue = Number(cd_percent) || 0;
  const cdAmountValue = Number(cd_amount) || 0;
  const adjustmentValue = Number(adjustment_amount) || 0;
  const tdsValue = Number(tds_amount) || 0;
  const roundOffValue = Number(round_off) || 0;
  const netAmount = amountValue - claimValue - otherDeductionValue - cdAmountValue - adjustmentValue - tdsValue + roundOffValue;
  const unloadingQtyValue = Number(unloading_qty) || Number(quantity) || 0;
  const fifoAmountValue = amountValue;
  const fifoRateValue = unloadingQtyValue > 0 ? amountValue / unloadingQtyValue : 0;
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
            quantity=?, shortage_quantity=?, unloading_qty=?, rate=?, amount=?, claim_amount=?, other_deduction=?, cd_percent=?, cd_amount=?,
            adjustment_amount=?, tds_amount=?, round_off=?, net_amount=?, net_receivable_amount=?, net_amount_payable=?, fifo_rate=?, fifo_amount=?,
            outstanding=?, employee_id=?, location_id=?, description=?
          WHERE id = ?
        `;

        return db.run(query, [
          voucher_no, date, unloading_date, warehouse_id, buyer_id || company_id, company_id || buyer_id, company_account_id, consignee_id,
          po_no || "", due_date || "", against_purchase_enabled ? 1 : 0, against_purchase_farmer_id || "", JSON.stringify(Array.isArray(against_purchase_links) ? against_purchase_links : []), lorry_no || req.body.reference_id || "", product_id,
          quantity, shortage_quantity, unloadingQtyValue, rate, amountValue, claimValue, otherDeductionValue, cdPercentValue, cdAmountValue,
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
  if (!userHasPermission(req.user, "warehouse.trading.sale.manage")) {
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

router.post("/payment", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, employee_id, location_id, description, adjustments } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;
  if (!farmer_id) return res.status(400).json({ error: "Farmer is required for payment vouchers" });

  validatePaymentAdjustments({ farmerId: farmer_id, warehouseId: warehouse_id, amount, adjustments }, (validationErr, cleanAdjustments) => {
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
          INSERT INTO wh_payment_vouchers (voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, employee_id, location_id, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const finalReferenceType = reference_type || "purchase";
        const finalReferenceId = reference_id || buildPaymentReferenceId(cleanAdjustments);
        db.run(query, [generatedVoucherNo, date, warehouse_id, farmer_id, company_account_id, amount, finalReferenceType, finalReferenceId, employee_id, location_id, description], function (err) {
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
        INSERT INTO wh_payment_vouchers (voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, employee_id, location_id, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const finalReferenceType = reference_type || "purchase";
      const finalReferenceId = reference_id || buildPaymentReferenceId(cleanAdjustments);
      db.run(query, [generatedVoucherNo, date, warehouse_id, farmer_id, company_account_id, amount, finalReferenceType, finalReferenceId, employee_id, location_id, description], function (err) {
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
  if (!userHasPermission(req.user, "warehouse.trading.payment.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  const { voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, employee_id, location_id, description, adjustments } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;
  if (!farmer_id) return res.status(400).json({ error: "Farmer is required for payment vouchers" });

  db.get("SELECT * FROM wh_payment_vouchers WHERE id = ?", [id], (findErr, oldRow) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!oldRow) return res.status(404).json({ error: "Payment voucher not found" });
    if (!ensureWarehouseAccess(req, res, oldRow.warehouse_id)) return;

    validatePaymentAdjustments({ farmerId: farmer_id, warehouseId: warehouse_id, amount, adjustments, excludePaymentId: id }, (validationErr, cleanAdjustments) => {
      if (validationErr) return res.status(400).json({ error: validationErr.message });

      const finalReferenceType = reference_type || "purchase";
      const finalReferenceId = reference_id || buildPaymentReferenceId(cleanAdjustments);
      const query = `
        UPDATE wh_payment_vouchers SET
          voucher_no=?, date=?, warehouse_id=?, farmer_id=?, company_account_id=?, amount=?,
          reference_type=?, reference_id=?, employee_id=?, location_id=?, description=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `;

      db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run(query, [voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, finalReferenceType, finalReferenceId, employee_id, location_id, description, id], function (err) {
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
              computeOutstandingForFarmer(farmer_id, (statsErr, stats) => {
                if (statsErr) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: statsErr.message });
                }
                db.run("UPDATE wh_payment_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, id], (outErr) => {
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

router.delete("/payment/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.manage")) {
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
    if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;

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

router.post("/receipt", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { voucher_no, date, warehouse_id, company_id, company_account_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description, adjustments } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;
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

router.put("/receipt/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.manage")) {
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
  if (!userHasPermission(req.user, "warehouse.trading.receipt.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  db.get("SELECT * FROM wh_receipt_vouchers WHERE id = ?", [id], (findErr, row) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!row) return res.status(404).json({ error: "Receipt voucher not found" });
    if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;

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
  if (!userHasPermission(req.user, "warehouse.trading.journal.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { voucher_no, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

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

function dbAll(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function getPurchaseReportRowsForUser(user) {
  if (mongoReady()) {
    const rows = await PurchaseVoucher.find(mongoPurchaseScope(user))
      .sort({ date: -1, createdAt: -1, _id: -1 })
      .lean();
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

async function getSaleReportRowsForUser(user) {
  return getAllSaleVoucherRowsForUser(user);
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
router.get("/report/sale-summary", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.sale")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  getSaleReportRowsForUser(req.user)
    .then((rows) =>
      res.json(
        (rows || []).map((row) => ({
          ...row,
          total_quantity: Number(Number(row.quantity || row.total_quantity || 0).toFixed(4)),
          total_amount: Number(Number(row.amount || row.total_amount || 0).toFixed(2)),
        }))
      )
    )
    .catch((err) => res.status(500).json({ error: err.message }));
});

router.get("/report/purchase-summary", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.purchase")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  if (mongoReady()) {
    return PurchaseVoucher.find(mongoPurchaseScope(req.user))
      .sort({ date: -1, createdAt: -1, _id: -1 })
      .lean()
      .then((rows) => decoratePurchaseRows(rows))
      .then((rows) => res.json(rows || []))
      .catch((err) => {
        console.error("Mongo purchase report query failed, falling back to SQLite:", err.message);
        res.status(500).json({ error: err.message });
      });
  }

  const filter = assignedWarehouseFilter(req.user, "v.warehouse_id");
  const legacyFilter = assignedWarehouseFilter(req.user, "t.warehouse_id");
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
    WHERE 1 = 1 ${filter.clause}
    ORDER BY v.date DESC, v.id DESC
  `;
  db.all(query, filter.params, (err, rows) => {
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
        WHERE LOWER(COALESCE(t.transaction_type, '')) = 'purchase' ${legacyFilter.clause}
        ORDER BY t.date DESC, t.id DESC
      `;

      db.all(legacyQuery, legacyFilter.params, (legacyErr, legacyRows) => {
        if (legacyErr) {
          console.error("Legacy purchase report query failed:", legacyErr.message);
          return res.json(purchaseRows || []);
        }
        res.json([...(purchaseRows || []), ...(legacyRows || [])]);
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
        WHERE 1 = 1 ${filter.clause}
        ORDER BY v.date DESC, v.id DESC
      `;
      return db.all(fallbackQuery, filter.params, (fallbackErr, fallbackRows) => {
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
    const companyAccountId = String(req.query.company_account_id || "").trim();
    const allPurchases = await getPurchaseReportRowsForUser(req.user);
    const purchases = allPurchases.filter((row) => {
      if (farmerId && String(row.farmer_id || "") !== farmerId) return false;
      if (companyAccountId && String(row.company_account_id || "") !== companyAccountId) return false;
      return true;
    });
    const filter = assignedWarehouseFilter(req.user, "p.warehouse_id");
    const paymentParams = [...filter.params];
    let farmerClause = "";
    let accountClause = "";
    if (farmerId) {
      farmerClause = " AND CAST(p.farmer_id AS TEXT) = CAST(? AS TEXT)";
      paymentParams.push(farmerId);
    }
    if (companyAccountId) {
      accountClause = " AND CAST(p.company_account_id AS TEXT) = CAST(? AS TEXT)";
      paymentParams.push(companyAccountId);
    }
    const payments = await dbAll(
      `
        SELECT p.*, w.name AS warehouse_name, f.name AS farmer_name, ca.account_name AS company_account_name
        FROM wh_payment_vouchers p
        LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(p.warehouse_id AS TEXT)
        LEFT JOIN farmers f ON CAST(f.id AS TEXT) = CAST(p.farmer_id AS TEXT)
        LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(p.company_account_id AS TEXT)
        WHERE 1 = 1 ${filter.clause} ${farmerClause} ${accountClause}
      `,
      paymentParams
    );

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
      const purchase = purchaseMap.get(String(item.purchase_id));
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

    const sales = await getSaleReportRowsForUser(req.user);
    const saleByVoucherNo = new Map((sales || []).map((row) => [String(row.voucher_no || ""), row]).filter(([voucherNo]) => voucherNo));
    const saleVoucherNos = new Set(saleByVoucherNo.keys());
    const rows = [
      ...purchases.map((row) => {
        const purchaseId = String(row.id || row._id);
        const paymentDetails = adjustmentsByPurchase.get(purchaseId) || [];
        const purchaseAmount = Number(row.total_amount || row.net_amount_payable || row.amount || 0);
        const paymentAmount = paymentDetails.reduce((sum, item) => sum + Number(item.adjusted_amount || 0), 0);
        return {
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
      }),
      ...payments.map((row) => {
        const paymentAdjustments = adjustmentsByPayment.get(String(row.id)) || [];
        const adjustmentDetails = paymentAdjustments
          .map((item) => `${item.purchase_voucher_no}: Rs.${fmtNum(item.adjusted_amount)}`)
          .join("; ");
        return {
          date: row.date,
          voucher_no: row.voucher_no,
          voucher_type: "Payment",
          particulars: `Payment adjusted against ${paymentAdjustments.map((item) => item.purchase_voucher_no).filter(Boolean).join(", ") || row.reference_id || "purchase bill"}`,
          adjustment_details: adjustmentDetails,
          reference_id: row.reference_id || paymentAdjustments.map((item) => item.purchase_voucher_no).filter(Boolean).join(", "),
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

    res.json(buildLedgerRows(rows, (row) => row.farmer_id, (row) => row.farmer_name || "Unknown Farmer"));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/report/sale-party-ledger", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.sale")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    const companyAccountId = String(req.query.company_account_id || "").trim();
    const buyerId = String(req.query.company_id || req.query.buyer_id || "").trim();
    const sales = (await getSaleReportRowsForUser(req.user)).filter((row) => {
      if (companyAccountId && String(row.company_account_id || "") !== companyAccountId) return false;
      if (buyerId && String(row.buyer_id || row.company_id || "") !== buyerId) return false;
      return true;
    });
    const saleByVoucherNo = new Map((sales || []).map((row) => [String(row.voucher_no || ""), row]).filter(([voucherNo]) => voucherNo));
    const saleVoucherNos = new Set(saleByVoucherNo.keys());
    const filter = assignedWarehouseFilter(req.user, "r.warehouse_id");
    const receiptParams = [...filter.params];
    let accountClause = "";
    let buyerClause = "";
    if (companyAccountId) {
      accountClause = " AND CAST(r.company_account_id AS TEXT) = CAST(? AS TEXT)";
      receiptParams.push(companyAccountId);
    }
    if (buyerId) {
      buyerClause = " AND CAST(r.company_id AS TEXT) = CAST(? AS TEXT)";
      receiptParams.push(buyerId);
    }
    const receipts = await dbAll(
      `
        SELECT r.*, w.name AS warehouse_name, b.name AS buyer_name, ca.account_name AS company_account_name
        FROM wh_receipt_vouchers r
        LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(r.warehouse_id AS TEXT)
        LEFT JOIN buyer_names b ON CAST(b.id AS TEXT) = CAST(r.company_id AS TEXT)
        LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(r.company_account_id AS TEXT)
        WHERE 1 = 1 ${filter.clause}${accountClause}${buyerClause}
      `,
      receiptParams
    );

    const journalParams = [...filter.params];
    let journalAccountClause = "";
    if (companyAccountId) {
      journalAccountClause = " AND CAST(j.company_account_id AS TEXT) = CAST(? AS TEXT)";
      journalParams.push(companyAccountId);
    }
    const journals = await dbAll(
      `
        SELECT j.*, w.name AS warehouse_name, ca.account_name AS company_account_name
        FROM wh_journal_vouchers j
        LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(j.warehouse_id AS TEXT)
        LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(j.company_account_id AS TEXT)
        WHERE j.description LIKE 'Auto sale deduction:%' ${filter.clause.replace(/r\./g, "j.")}${journalAccountClause}
      `,
      journalParams
    );

    const getSaleVoucherNoFromJournal = (row) => {
      const parts = String(row.description || "").split(":");
      return String(parts[1] || "").trim();
    };
    const journalsBySaleVoucherNo = new Map();
    (journals || []).forEach((row) => {
      const sourceVoucher = getSaleVoucherNoFromJournal(row);
      if (!sourceVoucher || !saleVoucherNos.has(sourceVoucher)) return;
      if (!journalsBySaleVoucherNo.has(sourceVoucher)) journalsBySaleVoucherNo.set(sourceVoucher, []);
      journalsBySaleVoucherNo.get(sourceVoucher).push(row);
    });

    const receiptIds = (receipts || []).map((row) => row.id);
    const receiptAdjustments = receiptIds.length
      ? await dbAll(
          `
            SELECT a.*, sv.voucher_no AS sale_voucher_no
            FROM wh_receipt_adjustments a
            LEFT JOIN wh_sale_vouchers sv ON CAST(sv.id AS TEXT) = CAST(a.sale_id AS TEXT)
            WHERE a.receipt_id IN (${receiptIds.map(() => "?").join(",")})
            ORDER BY a.id ASC
          `,
          receiptIds
        )
      : [];

    const saleMap = new Map((sales || []).map((row) => [String(row.id || row._id), row]));
    const receiptMap = new Map((receipts || []).map((row) => [String(row.id), row]));
    const adjustmentsByReceipt = new Map();
    const adjustmentsBySale = new Map();
    (receiptAdjustments || []).forEach((item) => {
      const receiptId = String(item.receipt_id);
      const saleId = String(item.sale_id);
      const sale = saleMap.get(saleId);
      const receipt = receiptMap.get(receiptId);
      const detail = {
        ...item,
        sale_voucher_no: item.sale_voucher_no || sale?.voucher_no || item.sale_id,
        receipt_voucher_no: receipt?.voucher_no || "",
        receipt_date: receipt?.date || "",
      };
      if (!adjustmentsByReceipt.has(receiptId)) adjustmentsByReceipt.set(receiptId, []);
      adjustmentsByReceipt.get(receiptId).push(detail);
      if (!adjustmentsBySale.has(saleId)) adjustmentsBySale.set(saleId, []);
      adjustmentsBySale.get(saleId).push(detail);
    });

    const adjustedBySale = new Map();
    (receiptAdjustments || []).forEach((item) => {
      const saleId = String(item.sale_id);
      adjustedBySale.set(saleId, (adjustedBySale.get(saleId) || 0) + Number(item.adjusted_amount || 0));
    });

    (receipts || [])
      .filter((receipt) => !(adjustmentsByReceipt.get(String(receipt.id)) || []).length)
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
      .forEach((receipt) => {
        let remaining = Number(receipt.amount || 0);
        if (remaining <= 0) return;

        const reference = String(receipt.reference_id || "").trim().toLowerCase();
        const matchingSales = (sales || [])
          .filter((sale) => {
            const sameBuyer = String(sale.buyer_id || sale.company_id || "") === String(receipt.company_id || "");
            const sameAccount = String(sale.company_account_id || "") === String(receipt.company_account_id || "");
            return sameBuyer && sameAccount;
          })
          .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));

        const referencedSales = reference
          ? matchingSales.filter((sale) => {
              const saleId = String(sale.id || sale._id || "").toLowerCase();
              const voucherNo = String(sale.voucher_no || "").toLowerCase();
              return reference === saleId || reference === voucherNo || reference.includes(voucherNo);
            })
          : [];
        const saleCandidates = referencedSales.length ? referencedSales : matchingSales;

        saleCandidates.forEach((sale) => {
          if (remaining <= 0) return;
          const saleId = String(sale.id || sale._id);
          const saleAmount = Number(sale.total_amount || sale.net_receivable_amount || sale.amount || 0);
          const alreadyAdjusted = adjustedBySale.get(saleId) || 0;
          const pending = Math.max(0, saleAmount - alreadyAdjusted);
          const adjustedAmount = Math.min(remaining, pending);
          if (adjustedAmount <= 0) return;

          const detail = {
            receipt_id: receipt.id,
            sale_id: saleId,
            adjusted_amount: Number(adjustedAmount.toFixed(2)),
            sale_voucher_no: sale.voucher_no || saleId,
            receipt_voucher_no: receipt.voucher_no || "",
            receipt_date: receipt.date || "",
            inferred_adjustment: true,
          };
          if (!adjustmentsByReceipt.has(String(receipt.id))) adjustmentsByReceipt.set(String(receipt.id), []);
          adjustmentsByReceipt.get(String(receipt.id)).push(detail);
          if (!adjustmentsBySale.has(saleId)) adjustmentsBySale.set(saleId, []);
          adjustmentsBySale.get(saleId).push(detail);
          adjustedBySale.set(saleId, alreadyAdjusted + adjustedAmount);
          remaining -= adjustedAmount;
        });
      });

    const rows = [
      ...sales.map((row) => {
        const saleId = String(row.id || row._id);
        const receiptDetails = adjustmentsBySale.get(saleId) || [];
        const saleAmount = Number(row.amount || row.total_amount || row.net_receivable_amount || 0);
        const receiptAmount = receiptDetails.reduce((sum, item) => sum + Number(item.adjusted_amount || 0), 0);
        const journalDetails = journalsBySaleVoucherNo.get(String(row.voucher_no || "")) || [];
        const journalAmount = journalDetails.reduce((sum, item) => sum + Number(item.amount || 0), 0);
        return {
          date: row.date,
          voucher_no: row.voucher_no,
          voucher_type: "Sale",
          warehouse_id: row.warehouse_id,
          warehouse_name: row.warehouse_name,
          company_id: row.buyer_id || row.company_id,
          company_name: row.buyer_name || row.company_name,
          company_account_id: row.company_account_id,
          company_account_name: row.company_account_name,
          buyer_id: row.buyer_id,
          buyer_name: row.buyer_name,
          buyer_email: row.buyer_email || "",
          sale_id: saleId,
          sale_amount: Number(saleAmount.toFixed(2)),
          receipt_amount: Number(receiptAmount.toFixed(2)),
          journal_amount: Number(journalAmount.toFixed(2)),
          payment_details: receiptDetails,
          journal_details: journalDetails.map((item) => ({
            date: item.date,
            voucher_no: item.voucher_no,
            type: item.credit_account || "Deduction",
            amount: Number(item.amount || 0),
            description: item.description || "",
          })),
          bill_balance: Number((saleAmount - receiptAmount - journalAmount).toFixed(2)),
          debit: saleAmount,
          credit: 0,
          unloading_date: row.unloading_date || "",
          due_date: row.due_date || "",
          due_days: Number(row.due_days || 0),
          days_overdue: Number(row.days_overdue || 0),
          followup_status: row.followup_status || "pending",
          followup_status_label: getFollowupStatusLabel(row.followup_status),
        };
      }),
      ...receipts.map((row) => {
        const receiptItems = adjustmentsByReceipt.get(String(row.id)) || [];
        return {
          date: row.date,
          voucher_no: row.voucher_no,
          voucher_type: "Receipt",
          warehouse_id: row.warehouse_id,
          warehouse_name: row.warehouse_name,
          company_id: row.company_id,
          company_name: row.buyer_name || row.company_name,
          company_account_id: row.company_account_id,
          company_account_name: row.company_account_name,
          buyer_id: row.company_id,
          buyer_name: row.buyer_name || row.company_name,
          debit: 0,
          credit: Number(row.amount || 0),
          particulars: `Receipt adjusted against ${receiptItems.map((item) => item.sale_voucher_no).filter(Boolean).join(", ") || "sale bill"}`,
          adjustment_details: receiptItems.map((item) => `${item.sale_voucher_no}: Rs.${fmtNum(item.adjusted_amount)}`).join("; "),
        };
      }),
      ...journals.map((row) => {
        const sourceVoucher = getSaleVoucherNoFromJournal(row);
        const sourceSale = saleByVoucherNo.get(sourceVoucher);
        if (!sourceSale) return null;
        return {
          date: row.date,
          voucher_no: row.voucher_no,
          voucher_type: row.credit_account || "Journal",
          warehouse_id: row.warehouse_id,
          warehouse_name: row.warehouse_name || sourceSale?.warehouse_name,
          company_id: sourceSale?.buyer_id || sourceSale?.company_id,
          company_name: sourceSale?.buyer_name || sourceSale?.company_name,
          company_account_id: row.company_account_id || sourceSale?.company_account_id,
          company_account_name: row.company_account_name || sourceSale?.company_account_name,
          buyer_id: sourceSale?.buyer_id || sourceSale?.company_id || `account-${row.company_account_id || "unknown"}`,
          buyer_name: sourceSale?.buyer_name || sourceSale?.company_name || row.company_account_name || "Sale Deduction",
          debit: 0,
          credit: Number(row.amount || 0),
          particulars: `${row.credit_account || "Deduction"} against ${sourceVoucher || "sale bill"}`,
          adjustment_details: row.description || "",
        };
      }).filter(Boolean),
    ];

res.json(buildLedgerRows(
      rows,
      (row) => `${row.buyer_id || row.company_id || "unknown"}::${row.company_account_id || "no-account"}`,
      (row) => row.buyer_name || row.company_name || "Unknown Buyer"
    ));
  } catch (err) {
    res.status(500).json({ error: err.message });
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
        contact_email: row.buyer_email || row.consignee_email || "",
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

router.get("/report/warehouse-stock", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.purchase") && !userHasPermission(req.user, "warehouse.trading.report.sale")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    const [purchases, sales] = await Promise.all([
      getPurchaseReportRowsForUser(req.user),
      getSaleReportRowsForUser(req.user),
    ]);
    res.json(groupStock(purchases, sales));
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

    sendPurchaseVoucherPdf(res, row, id);
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
          w.name AS warehouse_name,
          c.name AS company_name,
          b.name AS buyer_name,
          co.name AS consignee_name,
          p.name AS product_name
        FROM wh_sale_vouchers s
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

    const doc = new PDFDocument({ size: "A4", margin: 36 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="sale_${row.voucher_no || id}.pdf"`);
    doc.pipe(res);

    doc.fontSize(18).text("SALE VOUCHER", { align: "center" });
    doc.moveDown(0.6);
    doc.fontSize(11).text(`Voucher No: ${row.voucher_no || "-"}`);
    doc.text(`Sale Date: ${fmtDate(row.date)}`);
    doc.text(`Unloading Date: ${fmtDate(row.unloading_date)}`);
    doc.text(`Due Date: ${fmtDate(row.due_date)}`);
    doc.text(`Due Days: ${fmtNum(row.due_days)}`);
    doc.text(`Lorry No: ${row.lorry_no || row.reference_id || "-"}`);
    doc.text(`Warehouse: ${row.warehouse_name || row.warehouse_id || "-"}`);
    doc.text(`Buyer: ${row.buyer_name || row.company_name || "-"}`);
    doc.text(`Consignee: ${row.consignee_name || "-"}`);
    doc.text(`Product: ${row.product_name || "-"}`);
    doc.moveDown(0.4);
    doc.text(`Dispatch Qty: ${fmtNum(row.quantity)}`);
    doc.text(`Unloading Qty: ${fmtNum(row.unloading_qty || row.quantity)}`);
    doc.text(`Shortage Qty: ${fmtNum(row.shortage_quantity)}`);
    doc.text(`Rate: ${fmtNum(row.rate)}`);
    doc.text(`Amount: ${fmtNum(row.amount)}`);
    doc.text(`Shortage Amount: ${fmtNum(row.claim_amount)}`);
    doc.text(`Total Deduction: ${fmtNum((Number(row.claim_amount) || 0) + (Number(row.other_deduction) || 0) + (Number(row.adjustment_amount) || 0) + (Number(row.tds_amount) || 0))}`);
    doc.text(`Net Receivable: ${fmtNum(row.net_receivable_amount || row.net_amount || row.amount)}`);
    doc.text(`Outstanding: ${fmtNum(row.outstanding)}`);
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

// Update purchase voucher
router.put("/purchase/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.manage")) {
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
      .then((doc) => {
        if (!doc) return res.status(404).json({ error: "Voucher not found" });
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
  if (!userHasPermission(req.user, "warehouse.trading.purchase.manage")) {
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
