const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const crypto = require("crypto");
const { mongoose, isMongoMirrorReady } = require("../db-mongodb");
const { SaleVoucher, PurchaseVoucher } = require("../mongo");
const { userHasPermission } = require("../middleware/auth");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || "").toLowerCase();
    if (/\.(xlsx|xls|csv)$/.test(name)) return cb(null, true);
    return cb(new Error("Please upload an Excel file (.xls, .xlsx) or CSV file."));
  },
});

const NATURES = ["asset", "liability", "equity", "income", "expense", "other"];
const PLACEMENTS = ["balance_sheet", "profit_loss", "exclude"];

function collectionModel(modelName, collectionName, schemaDefinition, indexes = []) {
  if (mongoose.models[modelName]) return mongoose.models[modelName];
  const schema = new mongoose.Schema(schemaDefinition, {
    strict: false,
    timestamps: true,
    collection: collectionName,
  });
  indexes.forEach((index) => schema.index(index.fields, index.options || {}));
  return mongoose.model(modelName, schema, collectionName);
}

const Group = collectionModel("BankFinancialGroup", "bankfinancialgroups", {
  company_id: { type: String, default: "default" },
  name: { type: String, required: true },
  normalized_name: { type: String, required: true },
  nature: { type: String, enum: NATURES, required: true },
  report_placement: { type: String, enum: PLACEMENTS, required: true },
  source_type: { type: String, enum: ["bank_statement", "warehouse_sale", "warehouse_purchase"], default: "bank_statement" },
  sort_order: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, [{ fields: { company_id: 1, normalized_name: 1 }, options: { unique: true } }]);

const SubGroup = collectionModel("BankFinancialSubGroup", "bankfinancialsubgroups", {
  company_id: { type: String, default: "default" },
  group_id: { type: String, required: true },
  group_name: { type: String, required: true },
  name: { type: String, required: true },
  normalized_name: { type: String, required: true },
  sort_order: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, [{ fields: { company_id: 1, group_id: 1, normalized_name: 1 }, options: { unique: true } }]);

const LedgerMapping = collectionModel("BankFinancialLedgerMapping", "bankfinancialledgermappings", {
  company_id: { type: String, default: "default" },
  particulars_name: { type: String, required: true },
  // User-defined ledger display name; raw bank Particulars remains unchanged for reconciliation.
  ledger_name: { type: String, default: "" },
  normalized_name: { type: String, required: true },
  group_id: { type: String, required: true },
  group_name: { type: String, required: true },
  subgroup_id: { type: String, default: "" },
  subgroup_name: { type: String, default: "" },
  // Separate reporting dimension for Group Company / business-unit reporting.
  group_company: { type: String, default: "" },
  nature: { type: String, enum: NATURES, required: true },
  report_placement: { type: String, enum: PLACEMENTS, required: true },
  opening_balance: { type: Number, default: 0 },
  opening_balance_type: { type: String, enum: ["dr", "cr"], default: "dr" },
  active: { type: Boolean, default: true },
}, [{ fields: { company_id: 1, normalized_name: 1 }, options: { unique: true } }]);

const Transaction = collectionModel("BankFinancialTransaction", "bankfinancialtransactions", {
  company_id: { type: String, default: "default" },
  source_key: { type: String, required: true },
  bank_date: { type: Date, required: true },
  bank_time: String,
  bank_name: String,
  bank_remarks: String,
  instrument_type: String,
  instrument_no: String,
  bank_debit: { type: Number, default: 0 },
  bank_credit: { type: Number, default: 0 },
  bank_balance: { type: Number, default: 0 },
  transaction_id: String,
  bank_status: String,
  tally_date: Date,
  particulars_name: String,
  normalized_particulars: String,
  // Optional per-transaction aliases supplied in appended Excel columns Q/R.
  // These override the saved Particulars mapping for display and Group Company reporting only.
  ledger_name_override: String,
  group_company_override: String,
  voucher_type: String,
  voucher_number: String,
  receipt_amount: { type: Number, default: 0 },
  payment_amount: { type: Number, default: 0 },
  // Optional split accounting allocations; the original bank statement row and its bank amount remain single.
  allocations: { type: [mongoose.Schema.Types.Mixed], default: [] },
  import_file_name: String,
  import_batch_id: String,
  imported_by: String,
  // A matched inter-bank transfer links the two original statement rows without
  // creating a second bank movement or changing either imported amount.
  contra_match_id: String,
  contra_match_status: String,
  contra_counter_bank: String,
}, [{ fields: { company_id: 1, source_key: 1 }, options: { unique: true } }]);

const ImportBatch = collectionModel("BankFinancialImportBatch", "bankfinancialimportbatches", {
  company_id: { type: String, default: "default" },
  batch_id: String,
  file_name: String,
  total_rows: Number,
  imported_rows: Number,
  duplicate_rows: Number,
  invalid_rows: Number,
  total_receipts: Number,
  total_payments: Number,
  imported_by: String,
  date_from: Date,
  date_to: Date,
});

// One manually maintained opening balance per bank account.
const BankOpeningBalance = collectionModel("BankFinancialOpeningBalance", "bankfinancialopeningbalances", {
  company_id: { type: String, default: "default" },
  bank_name: { type: String, required: true },
  normalized_bank_name: { type: String, required: true },
  effective_date: { type: Date, required: true },
  opening_balance: { type: Number, default: 0 },
  opening_balance_type: { type: String, enum: ["dr", "cr"], default: "dr" },
  notes: { type: String, default: "" },
  active: { type: Boolean, default: true },
}, [{ fields: { company_id: 1, normalized_bank_name: 1 }, options: { unique: true } }]);

// One match represents a single inter-bank contra transfer linking exactly two
// already-imported rows: one Payment from the source bank and one Receipt at the
// destination bank. No duplicate statement transaction is created.
const ContraMatch = collectionModel("BankFinancialContraMatch", "bankfinancialcontramatches", {
  company_id: { type: String, default: "default" },
  transfer_id: { type: String, required: true },
  payment_transaction_id: { type: String, required: true },
  receipt_transaction_id: { type: String, required: true },
  payment_bank: { type: String, required: true },
  receipt_bank: { type: String, required: true },
  amount: { type: Number, required: true },
  payment_date: Date,
  receipt_date: Date,
  payment_reference: String,
  receipt_reference: String,
  match_method: { type: String, enum: ["strict_reference", "utr", "amount_date", "manual"], default: "manual" },
  status: { type: String, enum: ["matched", "cancelled"], default: "matched" },
  matched_by: String,
}, [
  { fields: { company_id: 1, transfer_id: 1 }, options: { unique: true } },
  { fields: { company_id: 1, payment_transaction_id: 1 }, options: { unique: true } },
  { fields: { company_id: 1, receipt_transaction_id: 1 }, options: { unique: true } },
]);

function mongoReady(res) {
  if (!isMongoMirrorReady() || !mongoose.connection?.db) {
    res.status(503).json({ error: "MongoDB is not connected" });
    return false;
  }
  return true;
}

function companyIdFrom(req) {
  const value = req.body?.company_id ?? req.query?.company_id ?? "default";
  return String(value || "default").trim() || "default";
}

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim().replace(/\s+/g, " ");
}

function keyText(value) {
  return text(value).toLowerCase();
}

function requestedGroupCompany(query) {
  return keyText(query?.group_company);
}

function matchesGroupCompany(mapping, requested) {
  const required = keyText(requested);
  if (!required) return true;
  const actual = keyText(mapping?.group_company);
  if (required === "__unassigned__") return !actual;
  return actual === required;
}

function matchesAllocationFilters(allocation, query = {}) {
  if (text(query.group_id) && String(allocation?.group_id || "") !== text(query.group_id)) return false;
  if (text(query.subgroup_id) && String(allocation?.subgroup_id || "") !== text(query.subgroup_id)) return false;
  return true;
}

function reportPeriodLabel(value, periodType) {
  const mode = String(periodType || "range").toLowerCase();
  if (mode !== "daily" && mode !== "monthly") return "Selected Period";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown Date";
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return mode === "monthly" ? `${year}-${month}` : `${year}-${month}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function signedBankOpening(record) {
  const amount = Math.abs(numberValue(record?.opening_balance));
  return String(record?.opening_balance_type || "dr").toLowerCase() === "cr" ? -amount : amount;
}

function transactionBankReceipt(tx) { return numberValue(tx?.bank_credit) || numberValue(tx?.receipt_amount); }
function transactionBankPayment(tx) { return numberValue(tx?.bank_debit) || numberValue(tx?.payment_amount); }

function transactionLedgerName(tx, mapping) {
  return text(tx?.ledger_name_override) || text(mapping?.ledger_name) || text(mapping?.particulars_name) || text(tx?.particulars_name) || "Unmapped Ledger";
}

function transactionGroupCompany(tx, mapping) {
  return text(tx?.group_company_override) || text(mapping?.group_company) || "";
}

function matchesTransactionGroupCompany(tx, mapping, requested) {
  const required = keyText(requested);
  if (!required) return true;
  const actual = keyText(transactionGroupCompany(tx, mapping));
  if (required === "__unassigned__") return !actual;
  return actual === required;
}

function optionalHeaderIndex(headers, acceptedNames) {
  const accepted = new Set(acceptedNames);
  return headers.findIndex((header) => accepted.has(keyText(header).replace(/[^a-z0-9]/g, "")));
}

function canonicalBankTimeIdentity(value) {
  const raw = text(value);
  if (!raw) return "";
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0 && numeric < 1) return String(Math.round(numeric * 86400));
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (match) {
    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3] || 0);
    const meridiem = (match[4] || "").toUpperCase();
    if (minutes <= 59 && seconds <= 59 && hours <= 24) {
      if (meridiem) {
        if (hours < 1 || hours > 12) return keyText(raw);
        if (meridiem === "AM") hours = hours === 12 ? 0 : hours;
        else hours = hours === 12 ? 12 : hours + 12;
      }
      return String(hours * 3600 + minutes * 60 + seconds);
    }
  }
  return keyText(raw);
}

function amountIdentity(value) {
  return numberValue(value).toFixed(2);
}

// A transaction ID is not always unique within a Bank + Date in exported
// statements. Include the stable voucher, instrument, particulars, time and
// debit/credit amounts as well, so distinct rows are not silently discarded.
function buildTransactionSourceKey(companyId, row) {
  const bankDate = row.bank_date instanceof Date ? row.bank_date : excelDate(row.bank_date);
  const dateKey = bankDate ? bankDate.toISOString().slice(0, 10) : "";
  const keySource = [
    companyId,
    keyText(row.bank_name),
    dateKey,
    canonicalBankTimeIdentity(row.bank_time),
    keyText(row.transaction_id),
    keyText(row.instrument_no),
    keyText(row.particulars_name),
    keyText(row.voucher_type),
    keyText(row.voucher_number),
    amountIdentity(row.receipt_amount),
    amountIdentity(row.payment_amount),
    amountIdentity(row.bank_debit),
    amountIdentity(row.bank_credit),
  ].join("|");
  return crypto.createHash("sha256").update(keySource).digest("hex");
}

function importDuplicateView(record, reason, existing = null) {
  return {
    excel_row: record.excel_row_number || null,
    bank_date: record.bank_date || null,
    bank_name: text(record.bank_name),
    particulars_name: text(record.particulars_name),
    voucher_type: text(record.voucher_type),
    voucher_number: text(record.voucher_number),
    transaction_id: text(record.transaction_id),
    instrument_no: text(record.instrument_no),
    receipt_amount: numberValue(record.receipt_amount),
    payment_amount: numberValue(record.payment_amount),
    reason,
    existing_file_name: text(existing?.import_file_name),
    existing_batch_id: text(existing?.import_batch_id),
  };
}

async function refreshImportBatch(companyId, batchId) {
  if (!batchId) return;
  const [summary] = await Transaction.aggregate([
    { $match: { company_id: companyId, import_batch_id: batchId } },
    { $group: {
      _id: "$import_batch_id",
      total_rows: { $sum: 1 },
      total_receipts: { $sum: "$receipt_amount" },
      total_payments: { $sum: "$payment_amount" },
      date_from: { $min: "$bank_date" },
      date_to: { $max: "$bank_date" },
    } },
  ]);
  if (summary) {
    await ImportBatch.updateOne(
      { company_id: companyId, batch_id: batchId },
      { $set: {
        total_rows: summary.total_rows,
        imported_rows: summary.total_rows,
        total_receipts: summary.total_receipts,
        total_payments: summary.total_payments,
        date_from: summary.date_from,
        date_to: summary.date_to,
      } }
    );
  }
}

function numberValue(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value).replace(/[,₹\s]/g, "").replace(/(dr|cr)$/i, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function excelDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const parts = XLSX.SSF.parse_date_code(value);
    if (parts && parts.y && parts.m && parts.d) {
      return new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
    }
  }
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  }
  const match = raw.match(/^(\d{1,2})[-/]([A-Za-z]{3})[-/](\d{2,4})$/);
  if (match) {
    const monthMap = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
    return new Date(Date.UTC(year, monthMap[match[2].toLowerCase()], Number(match[1])));
  }
  return null;
}

function dateFilter(query) {
  const filter = {};
  const from = text(query.from_date);
  const to = text(query.to_date);
  if (from || to) {
    filter.bank_date = {};
    if (from) filter.bank_date.$gte = new Date(`${from}T00:00:00.000Z`);
    if (to) filter.bank_date.$lt = new Date(`${to}T00:00:00.000Z`);
    if (to) filter.bank_date.$lt.setUTCDate(filter.bank_date.$lt.getUTCDate() + 1);
  }
  if (text(query.bank_name)) filter.bank_name = text(query.bank_name);
  if (text(query.voucher_type)) filter.voucher_type = new RegExp(`^${text(query.voucher_type)}$`, "i");
  if (text(query.import_batch_id)) filter.import_batch_id = text(query.import_batch_id);
  return filter;
}

function signedOpening(mapping, normalSide) {
  const amount = Math.abs(numberValue(mapping?.opening_balance));
  const side = String(mapping?.opening_balance_type || "dr").toLowerCase();
  return side === normalSide ? amount : -amount;
}

function assignedWarehouseMongoFilter(user) {
  if (!user || user.role === "admin" || userHasPermission(user, "all") || userHasPermission(user, "warehouses.manage")) return {};
  const ids = Array.isArray(user.assigned_warehouse_ids) ? user.assigned_warehouse_ids.map((id) => String(id)).filter(Boolean) : [];
  return ids.length ? { warehouse_id: { $in: ids } } : { _id: null };
}

function voucherDateFilter(query) {
  const filter = {};
  const from = text(query.from_date);
  const to = text(query.to_date);
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = from;
    if (to) filter.date.$lte = to;
  }
  return filter;
}

function voucherAmount(row, kind) {
  const candidates = kind === "sale"
    ? [row?.taxable_amount, row?.amount, row?.total_amount, row?.net_receivable_amount, row?.grand_total]
    : [row?.taxable_amount, row?.amount, row?.total_amount, row?.net_amount_payable, row?.grand_total];
  for (const value of candidates) {
    const amount = numberValue(value);
    if (amount > 0) return amount;
  }
  return 0;
}

async function loadReportContext(companyId, query) {
  const txFilter = { company_id: companyId, ...dateFilter(query) };
  const [transactions, groups, subgroups, mappings] = await Promise.all([
    Transaction.find(txFilter).sort({ bank_date: 1, _id: 1 }).limit(10000).lean(),
    Group.find({ company_id: companyId, active: true }).lean(),
    SubGroup.find({ company_id: companyId, active: true }).lean(),
    LedgerMapping.find({ company_id: companyId, active: true }).lean(),
  ]);
  const groupById = new Map(groups.map((row) => [String(row._id), row]));
  const subgroupById = new Map(subgroups.map((row) => [String(row._id), row]));
  const mappingByName = new Map(mappings.map((row) => [row.normalized_name, row]));
  return { transactions, groups, subgroups, mappings, groupById, subgroupById, mappingByName };
}

function transactionEntrySide(row = {}) {
  if (numberValue(row.receipt_amount) > 0) return "receipt";
  if (numberValue(row.payment_amount) > 0) return "payment";
  if (numberValue(row.bank_credit) > 0) return "receipt";
  if (numberValue(row.bank_debit) > 0) return "payment";
  return "receipt";
}

function transactionEntryAmount(row = {}) {
  const side = transactionEntrySide(row);
  const explicitAmount = side === "receipt" ? numberValue(row.receipt_amount) : numberValue(row.payment_amount);
  if (explicitAmount > 0) return explicitAmount;
  return side === "receipt" ? numberValue(row.bank_credit) : numberValue(row.bank_debit);
}

function normalizeContraField(value) {
  const raw = text(value).toUpperCase();
  if (["", "NA", "N/A", "-", "0", "NONE", "NULL", "NOT AVAILABLE", "NOT PROVIDED"].includes(raw) || /^0+(?:\.0+)?$/.test(raw)) return "";
  return raw.replace(/[^A-Z0-9]/g, "");
}

function normalizedBankReference(row = {}) {
  // Strict matching uses the actual Transaction ID only. Instrument Number is
  // validated separately and must also match; it is never used as a fallback.
  return normalizeContraField(row.transaction_id);
}

function strictContraPairChecks(payment = {}, receipt = {}) {
  const paymentAmountCents = Math.round(transactionEntryAmount(payment) * 100);
  const receiptAmountCents = Math.round(transactionEntryAmount(receipt) * 100);
  const paymentTransactionId = normalizeContraField(payment.transaction_id);
  const receiptTransactionId = normalizeContraField(receipt.transaction_id);
  const paymentRemarks = normalizeContraField(payment.bank_remarks);
  const receiptRemarks = normalizeContraField(receipt.bank_remarks);
  const paymentInstrument = normalizeContraField(payment.instrument_no);
  const receiptInstrument = normalizeContraField(receipt.instrument_no);
  const paymentVoucherType = normalizeContraField(payment.voucher_type);
  const receiptVoucherType = normalizeContraField(receipt.voucher_type);

  // Required Contra matching keys: Voucher Type, Amount, Transaction ID and
  // Instrument Number. Bank Remarks are retained for display/audit only and
  // intentionally do not block an otherwise valid match.
  const checks = {
    voucher_type: paymentVoucherType === "CONTRA" && receiptVoucherType === "CONTRA",
    amount: paymentAmountCents > 0 && paymentAmountCents === receiptAmountCents,
    transaction_id: Boolean(paymentTransactionId && receiptTransactionId && paymentTransactionId === receiptTransactionId),
    instrument_no: Boolean(paymentInstrument && receiptInstrument && paymentInstrument === receiptInstrument),
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([key]) => key);
  return {
    valid: failed.length === 0,
    checks: { ...checks, bank_remarks_match: Boolean(paymentRemarks && receiptRemarks && paymentRemarks === receiptRemarks) },
    failed,
    payment_reference: paymentTransactionId,
    receipt_reference: receiptTransactionId,
  };
}

function bankTimeSortMinutes(value) {
  const raw = text(value);
  if (!raw) return Number.POSITIVE_INFINITY;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0 && numeric < 1) return Math.round(numeric * 1440);
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return Number.POSITIVE_INFINITY;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59 || hours > 24 || (hours === 24 && (minutes !== 0 || Number(match[3] || 0) !== 0))) return Number.POSITIVE_INFINITY;
  const meridiem = (match[4] || "").toUpperCase();
  if (meridiem) {
    if (hours < 1 || hours > 12) return Number.POSITIVE_INFINITY;
    if (meridiem === "AM") hours = hours === 12 ? 0 : hours;
    else hours = hours === 12 ? 12 : hours + 12;
  }
  return hours * 60 + minutes;
}

function contraTransactionView(row = {}, mappingByName = null) {
  const mapping = mappingByName?.get(row?.normalized_particulars) || null;
  return {
    id: String(row._id),
    bank_name: text(row.bank_name),
    bank_date: row.bank_date || null,
    bank_time: text(row.bank_time),
    side: transactionEntrySide(row),
    amount: transactionEntryAmount(row),
    particulars_name: text(row.particulars_name),
    ledger_name: text(row.ledger_name_override) || transactionLedgerName(row, mapping),
    group_company: transactionGroupCompany(row, mapping) || "",
    transaction_id: text(row.transaction_id),
    bank_remarks: text(row.bank_remarks),
    instrument_no: text(row.instrument_no),
    voucher_type: text(row.voucher_type),
    voucher_number: text(row.voucher_number),
    import_file_name: text(row.import_file_name),
    import_batch_id: text(row.import_batch_id),
    contra_match_id: text(row.contra_match_id),
  };
}

function buildContraSuggestions(rows, mappingByName = new Map()) {
  // Build review candidates only for opposite-side rows with matching amount,
  // Contra voucher types, different Banks and a nearby date. Only candidates
  // passing every identifying-field check can be auto-linked or confirmed.
  // This keeps ordinary customer receipts (e.g. FARMART) out of Contra.
  const payments = rows.filter((row) => transactionEntrySide(row) === "payment"
    && transactionEntryAmount(row) > 0 && text(row.bank_name)
    && normalizeContraField(row.voucher_type) === "CONTRA");
  const receipts = rows.filter((row) => transactionEntrySide(row) === "receipt"
    && transactionEntryAmount(row) > 0 && text(row.bank_name)
    && normalizeContraField(row.voucher_type) === "CONTRA");
  const byPayment = new Map();
  const byReceipt = new Map();
  const candidates = [];

  payments.forEach((payment) => {
    receipts.forEach((receipt) => {
      if (keyText(payment.bank_name) === keyText(receipt.bank_name)) return;
      const paymentAmountCents = Math.round(transactionEntryAmount(payment) * 100);
      const receiptAmountCents = Math.round(transactionEntryAmount(receipt) * 100);
      if (!paymentAmountCents || paymentAmountCents !== receiptAmountCents) return;
      const checks = strictContraPairChecks(payment, receipt);

      const paymentCompany = keyText(transactionGroupCompany(payment, mappingByName.get(payment.normalized_particulars)));
      const receiptCompany = keyText(transactionGroupCompany(receipt, mappingByName.get(receipt.normalized_particulars)));
      if (paymentCompany && receiptCompany && paymentCompany !== receiptCompany) return;
      const sameGroupCompany = Boolean(paymentCompany && receiptCompany && paymentCompany === receiptCompany);
      const noGroupCompanyLabels = !paymentCompany && !receiptCompany;
      const paymentDate = new Date(payment.bank_date).getTime();
      const receiptDate = new Date(receipt.bank_date).getTime();
      const rawDayGap = Math.abs(paymentDate - receiptDate) / 86400000;
      // Bank Date is shown as context and used for ordering only; the four
      // identifiers below are the actual match criteria.
      const dayGap = Number.isFinite(rawDayGap) ? Number(rawDayGap.toFixed(2)) : null;

      const amount = transactionEntryAmount(payment);
      const pair = {
        payment_transaction_id: String(payment._id),
        receipt_transaction_id: String(receipt._id),
        payment: contraTransactionView(payment, mappingByName),
        receipt: contraTransactionView(receipt, mappingByName),
        amount,
        amount_difference: 0,
        day_gap: dayGap,
        remarks_match: Boolean(checks.checks.bank_remarks_match),
        reference_match: checks.checks.transaction_id,
        reference_conflict: checks.failed.includes("transaction_id"),
        strict_valid: checks.valid,
        strict_checks: checks.checks,
        failed_checks: checks.failed,
        match_reason: checks.valid
          ? "Voucher Type, Amount, Transaction ID and Instrument Number match; Bank Remarks may differ"
          : `Not eligible for Contra: ${checks.failed.map((key) => ({ voucher_type: "Voucher Type", amount: "Amount", transaction_id: "Transaction ID", instrument_no: "Instrument Number" }[key] || key)).join(", ")} do not all match`,
        match_method: checks.valid ? "strict_reference" : "review_required",
        same_group_company: sameGroupCompany,
        no_group_company_labels: noGroupCompanyLabels,
      };
      candidates.push(pair);
      if (!byPayment.has(pair.payment_transaction_id)) byPayment.set(pair.payment_transaction_id, []);
      if (!byReceipt.has(pair.receipt_transaction_id)) byReceipt.set(pair.receipt_transaction_id, []);
      byPayment.get(pair.payment_transaction_id).push(pair);
      byReceipt.get(pair.receipt_transaction_id).push(pair);
    });
  });

  return candidates.map((pair) => {
    const paymentCount = byPayment.get(pair.payment_transaction_id)?.length || 0;
    const receiptCount = byReceipt.get(pair.receipt_transaction_id)?.length || 0;
    return {
      ...pair,
      ambiguous: paymentCount > 1 || receiptCount > 1,
      auto_safe: pair.strict_valid && paymentCount === 1 && receiptCount === 1
        && (pair.same_group_company || pair.no_group_company_labels),
    };
  }).sort((a, b) => Number(b.same_group_company) - Number(a.same_group_company)
    || Number(a.day_gap ?? Number.POSITIVE_INFINITY) - Number(b.day_gap ?? Number.POSITIVE_INFINITY)
    || new Date(a.payment.bank_date).getTime() - new Date(b.payment.bank_date).getTime());
}

async function revalidateExistingContraMatches(companyId) {
  const existingMatches = await ContraMatch.find({ company_id: companyId, status: "matched" }).limit(10000).lean();
  if (!existingMatches.length) return 0;
  const transactionIds = [...new Set(existingMatches.flatMap((row) => [row.payment_transaction_id, row.receipt_transaction_id]).filter(Boolean).map(String))];
  const [transactions, mappings] = await Promise.all([
    transactionIds.length ? Transaction.find({ company_id: companyId, _id: { $in: transactionIds } }).lean() : [],
    LedgerMapping.find({ company_id: companyId, active: true }).lean(),
  ]);
  const byId = new Map(transactions.map((row) => [String(row._id), row]));
  const mappingByName = new Map(mappings.map((row) => [row.normalized_name, row]));
  const invalidMatchIds = [];
  for (const match of existingMatches) {
    const payment = byId.get(String(match.payment_transaction_id));
    const receipt = byId.get(String(match.receipt_transaction_id));
    const paymentCompany = payment ? keyText(transactionGroupCompany(payment, mappingByName.get(payment.normalized_particulars))) : "";
    const receiptCompany = receipt ? keyText(transactionGroupCompany(receipt, mappingByName.get(receipt.normalized_particulars))) : "";
    if (!payment || !receipt || !strictContraPairChecks(payment, receipt).valid
      || transactionEntrySide(payment) !== "payment" || transactionEntrySide(receipt) !== "receipt"
      || keyText(payment.bank_name) === keyText(receipt.bank_name)
      || (paymentCompany && receiptCompany && paymentCompany !== receiptCompany)) {
      invalidMatchIds.push(String(match._id));
    }
  }
  if (!invalidMatchIds.length) return 0;
  await Transaction.updateMany(
    { company_id: companyId, contra_match_id: { $in: invalidMatchIds } },
    { $unset: { contra_match_id: 1, contra_match_status: 1, contra_counter_bank: 1 } }
  );
  await ContraMatch.deleteMany({ company_id: companyId, _id: { $in: invalidMatchIds } });
  return invalidMatchIds.length;
}

async function createContraMatch(companyId, paymentId, receiptId, req, method = "manual") {
  if (!mongoose.Types.ObjectId.isValid(paymentId) || !mongoose.Types.ObjectId.isValid(receiptId) || paymentId === receiptId) {
    const error = new Error("Select two different valid Bank Statement rows."); error.status = 400; throw error;
  }
  const [payment, receipt] = await Promise.all([
    Transaction.findOne({ _id: paymentId, company_id: companyId }).lean(),
    Transaction.findOne({ _id: receiptId, company_id: companyId }).lean(),
  ]);
  if (!payment || !receipt) { const error = new Error("One or both Bank Statement rows were not found in this company."); error.status = 404; throw error; }
  if (transactionEntrySide(payment) !== "payment" || transactionEntrySide(receipt) !== "receipt") {
    const error = new Error("Contra Match requires one Payment row and one Receipt row."); error.status = 400; throw error;
  }
  if (!text(payment.bank_name) || !text(receipt.bank_name) || keyText(payment.bank_name) === keyText(receipt.bank_name)) {
    const error = new Error("Contra Match must connect two different Bank Accounts."); error.status = 400; throw error;
  }
  const paymentAmount = transactionEntryAmount(payment);
  const receiptAmount = transactionEntryAmount(receipt);
  if (Math.abs(paymentAmount - receiptAmount) > 0.01) {
    const error = new Error(`Payment ${paymentAmount.toFixed(2)} and Receipt ${receiptAmount.toFixed(2)} must have the same amount.`); error.status = 400; throw error;
  }
  const strictChecks = strictContraPairChecks(payment, receipt);
  if (!strictChecks.valid) {
    const labels = {
      voucher_type: "Voucher Type must be Contra on both rows",
      amount: "Receipt and Payment amounts must match exactly",
      transaction_id: "Transaction ID must be present and match",
      instrument_no: "Instrument Number must be present and match",
    };
    const error = new Error(`Contra Match rejected: ${strictChecks.failed.map((key) => labels[key] || key).join("; ")}.`);
    error.status = 400;
    throw error;
  }
  if (text(payment.contra_match_id) || text(receipt.contra_match_id)) {
    const error = new Error("One of these transactions is already linked to another Contra Transfer."); error.status = 409; throw error;
  }
  const contraMappings = await LedgerMapping.find({
    company_id: companyId,
    active: true,
    normalized_name: { $in: [payment.normalized_particulars, receipt.normalized_particulars].filter(Boolean) },
  }).lean();
  const contraMappingByName = new Map(contraMappings.map((row) => [row.normalized_name, row]));
  const paymentCompany = keyText(transactionGroupCompany(payment, contraMappingByName.get(payment.normalized_particulars)));
  const receiptCompany = keyText(transactionGroupCompany(receipt, contraMappingByName.get(receipt.normalized_particulars)));
  if (paymentCompany && receiptCompany && paymentCompany !== receiptCompany) {
    const error = new Error("These Bank rows belong to different Group Companies and cannot be linked as an intra-company Contra Transfer."); error.status = 400; throw error;
  }
  const paymentReference = normalizedBankReference(payment);
  const receiptReference = normalizedBankReference(receipt);
  const transferId = `CTR-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const match = await ContraMatch.create({
    company_id: companyId,
    transfer_id: transferId,
    payment_transaction_id: String(payment._id),
    receipt_transaction_id: String(receipt._id),
    payment_bank: text(payment.bank_name),
    receipt_bank: text(receipt.bank_name),
    amount: paymentAmount,
    payment_date: payment.bank_date,
    receipt_date: receipt.bank_date,
    payment_reference: paymentReference || "",
    receipt_reference: receiptReference || "",
    match_method: method,
    status: "matched",
    matched_by: text(req.user?.name || req.user?.username || req.user?.employee_name || req.user?._id),
  });
  const matchId = String(match._id);
  try {
    const paymentUpdate = await Transaction.updateOne(
      { _id: payment._id, company_id: companyId, $or: [{ contra_match_id: { $exists: false } }, { contra_match_id: "" }, { contra_match_id: null }] },
      { $set: { contra_match_id: matchId, contra_match_status: "matched", contra_counter_bank: text(receipt.bank_name) } }
    );
    if (Number(paymentUpdate.modifiedCount ?? paymentUpdate.nModified ?? 0) !== 1) throw new Error("Payment row was matched by another user. Refresh and try again.");
    const receiptUpdate = await Transaction.updateOne(
      { _id: receipt._id, company_id: companyId, $or: [{ contra_match_id: { $exists: false } }, { contra_match_id: "" }, { contra_match_id: null }] },
      { $set: { contra_match_id: matchId, contra_match_status: "matched", contra_counter_bank: text(payment.bank_name) } }
    );
    if (Number(receiptUpdate.modifiedCount ?? receiptUpdate.nModified ?? 0) !== 1) throw new Error("Receipt row was matched by another user. Refresh and try again.");
  } catch (error) {
    await Transaction.updateMany({ company_id: companyId, contra_match_id: matchId }, { $unset: { contra_match_id: 1, contra_match_status: 1, contra_counter_bank: 1 } });
    await ContraMatch.deleteOne({ _id: match._id, company_id: companyId });
    throw error;
  }
  return { ...match.toObject(), id: matchId, payment: contraTransactionView(payment), receipt: contraTransactionView(receipt) };
}

async function autoMatchUniqueContraTransfers(companyId, req) {
  // Remove historical unsafe auto/manual links that do not satisfy the new
  // strict Contra rule. The original statement rows and balances are retained.
  const releasedLegacyMatches = await revalidateExistingContraMatches(companyId);
  const unmatchedRows = await Transaction.find({
    company_id: companyId,
    $or: [{ contra_match_id: { $exists: false } }, { contra_match_id: "" }, { contra_match_id: null }],
  }).sort({ bank_date: 1, bank_time: 1, _id: 1 }).limit(10000).lean();
  const mappings = await LedgerMapping.find({ company_id: companyId, active: true }).lean();
  const mappingByName = new Map(mappings.map((row) => [row.normalized_name, row]));
  const suggestions = buildContraSuggestions(unmatchedRows, mappingByName);
  const created = [];
  for (const row of suggestions.filter((item) => item.auto_safe)) {
    try {
      created.push(await createContraMatch(companyId, row.payment_transaction_id, row.receipt_transaction_id, req, row.match_method));
    } catch (error) {
      if (![11000, 409].includes(Number(error.code || error.status))) console.warn("Contra auto-match candidate skipped:", error.message);
    }
  }
  return {
    matches: created,
    matched_count: created.length,
    review_required_count: suggestions.filter((row) => !row.auto_safe).length,
    suggestions_count: suggestions.length,
    released_legacy_matches: releasedLegacyMatches,
  };
}

function transactionAllocations(row, ctx) {
  const saved = Array.isArray(row?.allocations) ? row.allocations.filter((item) => item && numberValue(item.amount) > 0) : [];
  if (saved.length) {
    return saved.map((item) => {
      const selectedGroup = ctx.groupById.get(String(item.group_id || ""));
      const subgroup = item.subgroup_id ? ctx.subgroupById.get(String(item.subgroup_id)) : null;
      const group = subgroup ? ctx.groupById.get(String(subgroup.group_id)) || selectedGroup : selectedGroup;
      return {
        ...item,
        ledger_name: text(item.ledger_name) || "Unspecified Ledger",
        group_id: group ? String(group._id) : String(item.group_id || ""),
        group_name: group?.name || item.group_name || "Unmapped",
        subgroup_id: subgroup ? String(subgroup._id) : String(item.subgroup_id || ""),
        subgroup_name: subgroup?.name || item.subgroup_name || "",
        group_company: text(item.group_company),
        nature: group?.nature || item.nature || "",
        report_placement: group?.report_placement || item.report_placement || "",
        side: item.side === "receipt" ? "receipt" : "payment",
        amount: numberValue(item.amount),
      };
    });
  }
  const mapping = ctx.mappingByName.get(row?.normalized_particulars) || null;
  if (!mapping) {
    const amount = transactionEntryAmount(row);
    if (!amount) return [];
    return [{
      ledger_name: transactionLedgerName(row, null),
      group_id: "", group_name: "Unmapped", subgroup_id: "", subgroup_name: "",
      group_company: transactionGroupCompany(row, null), nature: "", report_placement: "",
      side: transactionEntrySide(row), amount,
    }];
  }
  const group = ctx.groupById.get(String(mapping.group_id));
  const subgroup = mapping.subgroup_id ? ctx.subgroupById.get(String(mapping.subgroup_id)) : null;
  const amount = transactionEntryAmount(row);
  if (!amount) return [];
  return [{
    ledger_name: transactionLedgerName(row, mapping),
    group_id: String(mapping.group_id || ""),
    group_name: group?.name || mapping.group_name || "Unmapped",
    subgroup_id: String(mapping.subgroup_id || ""),
    subgroup_name: subgroup?.name || mapping.subgroup_name || "",
    group_company: transactionGroupCompany(row, mapping),
    nature: group?.nature || mapping.nature || "",
    report_placement: group?.report_placement || mapping.report_placement || "",
    side: transactionEntrySide(row),
    amount,
  }];
}

function mapTransaction(row, ctx) {
  const baseMapping = ctx.mappingByName.get(row.normalized_particulars) || null;
  const group = baseMapping ? ctx.groupById.get(String(baseMapping.group_id)) : null;
  const subgroup = baseMapping?.subgroup_id ? ctx.subgroupById.get(String(baseMapping.subgroup_id)) : null;
  const ledgerName = transactionLedgerName(row, baseMapping);
  const groupCompany = transactionGroupCompany(row, baseMapping);
  const hasRowOverrides = Boolean(text(row.ledger_name_override) || text(row.group_company_override));
  const mapping = baseMapping ? {
    ...baseMapping,
    ledger_name: ledgerName,
    group_company: groupCompany,
  } : (hasRowOverrides ? {
    particulars_name: row.particulars_name,
    ledger_name: ledgerName,
    group_company: groupCompany,
  } : null);
  return {
    ...row,
    id: String(row._id),
    // Keep the original Excel L-column Particulars while displaying an optional Excel Q-column Ledger Name.
    ledger_name: ledgerName,
    allocations: transactionAllocations(row, ctx),
    // Raw saved split rows only; legacy mapped transactions use an on-the-fly fallback for reports.
    split_allocations: Array.isArray(row.allocations) ? row.allocations : [],
    mapping: mapping ? {
      group_id: baseMapping?.group_id || "",
      group_name: group?.name || baseMapping?.group_name || "",
      ledger_name: ledgerName,
      original_particulars_name: row.particulars_name,
      subgroup_id: baseMapping?.subgroup_id || "",
      subgroup_name: subgroup?.name || baseMapping?.subgroup_name || "",
      group_company: groupCompany,
      nature: group?.nature || baseMapping?.nature || "",
      report_placement: group?.report_placement || baseMapping?.report_placement || "",
    } : null,
  };
}

// Import Tally-reconciled ICICI / bank statement exports using the exact A:P layout.
router.post("/import", upload.single("file"), async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    if (!req.file) return res.status(400).json({ error: "Please select a bank statement Excel file." });
    const companyId = companyIdFrom(req);
    const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return res.status(400).json({ error: "The uploaded workbook has no worksheet." });
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true });
    if (!matrix.length || matrix[0].length < 16) {
      return res.status(400).json({ error: "This import requires the 16-column bank/Tally export layout (A:P)." });
    }
    const headers = matrix[0].map((v) => text(v).toLowerCase());
    if (!headers[0].includes("tran.date") || !headers[3].includes("inst.type") || !headers[11].includes("particulars") || !headers[12].includes("voucher type") || !headers[13].includes("voucher number")) {
      return res.status(400).json({ error: "Column headers do not match the expected A:P Bank Statement format. Keep the original headers unchanged." });
    }
    // Optional user-defined transaction ledger alias and reporting company.
    // Keep A:P intact; add these headers after the existing statement columns.
    const ledgerNameColumn = optionalHeaderIndex(headers, ["ledgername", "reportledgername", "mappedledgername", "ledgernameforreport", "ledgernamereportname"]);
    const groupCompanyColumn = optionalHeaderIndex(headers, ["groupcompany", "groupcompanyname", "companygroup", "businessunit", "groupcompanyreportsplit"]);

    const batchId = crypto.randomUUID();
    const records = [];
    const invalidRows = [];
    let totalReceipts = 0;
    let totalPayments = 0;
    let minDate = null;
    let maxDate = null;
    for (let index = 1; index < matrix.length; index += 1) {
      const row = matrix[index] || [];
      if (row.every((value) => value === null || value === undefined || value === "")) continue;
      const bankDate = excelDate(row[0]);
      const bankName = text(row[3]);
      const particulars = text(row[11]);
      const voucherType = text(row[12]);
      const voucherNo = text(row[13]);
      if (!bankDate || !bankName || !particulars || !voucherType || !voucherNo) {
        invalidRows.push({ row: index + 1, reason: "Missing Date, Bank Name (D), Particulars (L), Voucher Type (M), or Voucher Number (N)." });
        continue;
      }
      const receiptAmount = numberValue(row[14]);
      const paymentAmount = numberValue(row[15]);
      const statementDebit = numberValue(row[5]);
      const statementCredit = numberValue(row[6]);
      const transactionId = text(row[8]);
      const sourceKey = buildTransactionSourceKey(companyId, {
        bank_date: bankDate,
        bank_time: text(row[1]),
        bank_name: bankName,
        instrument_no: text(row[4]),
        transaction_id: transactionId,
        particulars_name: particulars,
        voucher_type: voucherType,
        voucher_number: voucherNo,
        receipt_amount: receiptAmount,
        payment_amount: paymentAmount,
        bank_debit: statementDebit,
        bank_credit: statementCredit,
      });
      records.push({
        company_id: companyId,
        source_key: sourceKey,
        excel_row_number: index + 1,
        bank_date: bankDate,
        bank_time: text(row[1]),
        bank_remarks: text(row[2]),
        instrument_type: text(row[3]),
        bank_name: bankName,
        instrument_no: text(row[4]),
        bank_debit: statementDebit,
        bank_credit: statementCredit,
        bank_balance: numberValue(row[7]),
        transaction_id: transactionId,
        bank_status: text(row[9]),
        tally_date: excelDate(row[10]),
        particulars_name: particulars,
        normalized_particulars: keyText(particulars),
        ledger_name_override: ledgerNameColumn >= 0 ? text(row[ledgerNameColumn]) : "",
        group_company_override: groupCompanyColumn >= 0 ? text(row[groupCompanyColumn]) : "",
        voucher_type: voucherType,
        voucher_number: voucherNo,
        receipt_amount: receiptAmount,
        payment_amount: paymentAmount,
        import_file_name: req.file.originalname,
        import_batch_id: batchId,
        imported_by: text(req.user?.name || req.user?.username || req.user?.employee_name || req.user?._id),
      });
      totalReceipts += receiptAmount;
      totalPayments += paymentAmount;
      if (!minDate || bankDate < minDate) minDate = bankDate;
      if (!maxDate || bankDate > maxDate) maxDate = bankDate;
    }
    if (!records.length) {
      return res.status(400).json({ error: "No valid transaction rows were found.", invalid_rows: invalidRows.slice(0, 30) });
    }
    // Look up transactions already stored for the same Bank + date window and
    // compare their full transaction identity. This also recognizes old rows
    // created by the previous, weaker Bank+Date+Transaction-ID key.
    const bankNamesForImport = [...new Set(records.map((record) => record.bank_name).filter(Boolean))];
    const endDateExclusive = new Date(maxDate);
    endDateExclusive.setUTCDate(endDateExclusive.getUTCDate() + 1);
    const existingTransactions = await Transaction.find({
      company_id: companyId,
      bank_name: { $in: bankNamesForImport },
      bank_date: { $gte: minDate, $lt: endDateExclusive },
    }).select("_id source_key bank_date bank_time bank_name instrument_no transaction_id particulars_name voucher_type voucher_number receipt_amount payment_amount bank_debit bank_credit import_file_name import_batch_id").lean();
    const existingByIdentity = new Map();
    existingTransactions.forEach((existing) => {
      const identity = buildTransactionSourceKey(companyId, existing);
      if (!existingByIdentity.has(identity)) existingByIdentity.set(identity, existing);
    });

    const operations = [];
    const seenInThisFile = new Set();
    const duplicateDetails = [];
    for (const record of records) {
      const existing = existingByIdentity.get(record.source_key);
      if (existing) {
        duplicateDetails.push(importDuplicateView(record, "Already exists in Hansaria with matching transaction details.", existing));
        // Preserve the existing transaction but allow Q/R aliases to be filled
        // when the same file is re-imported after adding Ledger Name / Group Company.
        const overrideSet = {};
        if (text(record.ledger_name_override)) overrideSet.ledger_name_override = text(record.ledger_name_override);
        if (text(record.group_company_override)) overrideSet.group_company_override = text(record.group_company_override);
        if (Object.keys(overrideSet).length) {
          operations.push({ updateOne: { filter: { _id: existing._id, company_id: companyId }, update: { $set: overrideSet } } });
        }
        continue;
      }
      if (seenInThisFile.has(record.source_key)) {
        duplicateDetails.push(importDuplicateView(record, "Repeated identical transaction row inside this uploaded Excel file."));
        continue;
      }
      seenInThisFile.add(record.source_key);
      const insertRecord = { ...record };
      delete insertRecord.excel_row_number;
      delete insertRecord.ledger_name_override;
      delete insertRecord.group_company_override;
      const overrideSet = {};
      if (text(record.ledger_name_override)) overrideSet.ledger_name_override = text(record.ledger_name_override);
      if (text(record.group_company_override)) overrideSet.group_company_override = text(record.group_company_override);
      const update = { $setOnInsert: insertRecord };
      if (Object.keys(overrideSet).length) update.$set = overrideSet;
      operations.push({
        updateOne: {
          filter: { company_id: companyId, source_key: record.source_key },
          update,
          upsert: true,
        },
      });
    }
    const writeResult = operations.length
      ? await Transaction.bulkWrite(operations, { ordered: false })
      : { upsertedCount: 0 };
    const importedRows = Number(writeResult.upsertedCount || 0);
    const duplicateRows = Math.max(0, records.length - importedRows);
    const existingMappings = await LedgerMapping.find({
      company_id: companyId,
      active: true,
      normalized_name: { $in: [...new Set(records.map((row) => row.normalized_particulars))] },
    }).select("normalized_name").lean();
    const mappedNameSet = new Set(existingMappings.map((row) => row.normalized_name));
    const autoMappedRows = records.filter((row) => mappedNameSet.has(row.normalized_particulars)).length;
    const unmappedRows = Math.max(0, records.length - autoMappedRows);
    const batch = await ImportBatch.create({
      company_id: companyId,
      batch_id: batchId,
      file_name: req.file.originalname,
      total_rows: records.length + invalidRows.length,
      imported_rows: importedRows,
      duplicate_rows: duplicateRows,
      invalid_rows: invalidRows.length,
      total_receipts: totalReceipts,
      total_payments: totalPayments,
      imported_by: text(req.user?.name || req.user?.username || req.user?.employee_name || req.user?._id),
      date_from: minDate,
      date_to: maxDate,
    });
    // When a later Bank Statement is imported (for example AGRI BANK 0008
    // after AGRI BANK 2956), automatically link only unique safe contra pairs.
    // Ambiguous pairs remain visible for manual confirmation in the Contra tab.
    let contraAutoResult = { matched_count: 0, review_required_count: 0 };
    try { contraAutoResult = await autoMatchUniqueContraTransfers(companyId, req); }
    catch (matchError) { console.warn("Post-import Contra Auto Matching skipped:", matchError.message); }
    return res.json({
      success: true,
      batch_id: batchId,
      batch_record_id: String(batch._id),
      file_name: req.file.originalname,
      total_rows: records.length + invalidRows.length,
      imported_rows: importedRows,
      duplicate_rows: duplicateRows,
      duplicate_details: duplicateDetails.slice(0, 200),
      duplicate_details_truncated: duplicateDetails.length > 200,
      auto_mapped_rows: autoMappedRows,
      unmapped_rows: unmappedRows,
      excel_ledger_names: ledgerNameColumn >= 0 ? records.filter((row) => text(row.ledger_name_override)).length : 0,
      excel_group_companies: groupCompanyColumn >= 0 ? records.filter((row) => text(row.group_company_override)).length : 0,
      invalid_rows: invalidRows.length,
      invalid_details: invalidRows.slice(0, 30),
      total_receipts: totalReceipts,
      total_payments: totalPayments,
      date_from: minDate,
      date_to: maxDate,
      bank_names: [...new Set(records.map((row) => row.bank_name))],
      contra_auto_matched_count: contraAutoResult.matched_count || 0,
      contra_review_required_count: contraAutoResult.review_required_count || 0,
    });
  } catch (error) {
    console.error("Bank financial report import failed:", error);
    return res.status(500).json({ error: error.message || "Bank statement import failed." });
  }
});

router.get("/import-batches", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const rows = await Transaction.aggregate([
      { $match: { company_id: companyId } },
      { $group: {
        _id: "$import_batch_id",
        file_name: { $first: "$import_file_name" },
        imported_by: { $first: "$imported_by" },
        bank_names: { $addToSet: "$bank_name" },
        total_rows: { $sum: 1 },
        total_receipts: { $sum: "$receipt_amount" },
        total_payments: { $sum: "$payment_amount" },
        date_from: { $min: "$bank_date" },
        date_to: { $max: "$bank_date" },
        last_updated: { $max: "$updatedAt" },
      } },
      { $sort: { date_to: -1, file_name: 1 } },
      { $limit: 100 },
    ]);
    return res.json(rows.map((row) => ({
      batch_id: row._id || "",
      file_name: row.file_name || "Imported Bank Statement",
      imported_by: row.imported_by || "",
      bank_names: (row.bank_names || []).map((name) => text(name)).filter(Boolean),
      total_rows: row.total_rows || 0,
      total_receipts: row.total_receipts || 0,
      total_payments: row.total_payments || 0,
      date_from: row.date_from || null,
      date_to: row.date_to || null,
      last_updated: row.last_updated || null,
    })));
  } catch (error) { return res.status(500).json({ error: error.message || "Could not load import history." }); }
});

// Assign one Bank Name to every transaction in a selected import batch.
// This updates existing rows in place; amounts, dates, mappings, allocations,
// bank balances and the import batch identity are deliberately preserved.
router.patch("/import-batches/:batchId/bank-name", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const batchId = text(req.params.batchId);
    const bankName = text(req.body?.bank_name);
    if (!batchId) return res.status(400).json({ error: "Select a valid imported statement." });
    if (!bankName) return res.status(400).json({ error: "Please enter or select a Bank Name." });
    if (bankName.length > 120) return res.status(400).json({ error: "Bank Name cannot exceed 120 characters." });

    const filter = { company_id: companyId, import_batch_id: batchId };
    const existingRows = await Transaction.countDocuments(filter);
    if (!existingRows) return res.status(404).json({ error: "No transactions were found for this imported statement." });

    const result = await Transaction.updateMany(filter, { $set: { bank_name: bankName } });
    await refreshImportBatch(companyId, batchId);
    const updatedRows = Number(result.modifiedCount ?? result.nModified ?? 0);
    return res.json({
      success: true,
      batch_id: batchId,
      bank_name: bankName,
      total_rows: existingRows,
      updated_rows: updatedRows,
      message: `Bank Name updated for ${existingRows} imported rows.`,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not update Bank Name for this imported statement." });
  }
});


// Delete every transaction belonging to one imported file/batch while keeping
// all reusable masters (Groups, Sub-groups, Ledger Mappings and bank openings).
// Any Contra Match that references a deleted row is unlinked on BOTH sides so
// a surviving statement row is not left with a dangling transfer reference.
router.delete("/import-batches/:batchId", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const batchId = text(req.params.batchId);
    if (!batchId) return res.status(400).json({ error: "Select a valid imported statement." });

    const batchFilter = { company_id: companyId, import_batch_id: batchId };
    const rows = await Transaction.find(batchFilter).select("_id contra_match_id").lean();
    if (!rows.length) {
      // Remove an orphaned batch-history record if it exists, but never touch
      // any other batch or reusable ledger/group mapping.
      await ImportBatch.deleteOne({ company_id: companyId, batch_id: batchId });
      return res.status(404).json({ error: "No imported transactions were found for this file. The batch history record was checked." });
    }

    const transactionIds = rows.map((row) => String(row._id));
    const rowMatchIds = [...new Set(rows.map((row) => text(row.contra_match_id)).filter(Boolean))];
    const relatedMatches = await ContraMatch.find({
      company_id: companyId,
      $or: [
        { payment_transaction_id: { $in: transactionIds } },
        { receipt_transaction_id: { $in: transactionIds } },
        ...(rowMatchIds.length ? [{ _id: { $in: rowMatchIds.filter((id) => mongoose.Types.ObjectId.isValid(id)) } }] : []),
      ],
    }).select("_id transfer_id payment_transaction_id receipt_transaction_id").lean();

    const contraMatchIds = [...new Set([
      ...rowMatchIds,
      ...relatedMatches.map((match) => String(match._id)),
    ].filter(Boolean))];
    let unlinkedRows = 0;
    if (contraMatchIds.length) {
      const unlinkResult = await Transaction.updateMany(
        { company_id: companyId, contra_match_id: { $in: contraMatchIds } },
        { $unset: { contra_match_id: 1, contra_match_status: 1, contra_counter_bank: 1 } }
      );
      unlinkedRows = Number(unlinkResult.modifiedCount ?? unlinkResult.nModified ?? 0);
      await ContraMatch.deleteMany({
        company_id: companyId,
        _id: { $in: contraMatchIds.filter((id) => mongoose.Types.ObjectId.isValid(id)) },
      });
    }

    const deleteResult = await Transaction.deleteMany(batchFilter);
    await ImportBatch.deleteOne({ company_id: companyId, batch_id: batchId });

    return res.json({
      success: true,
      batch_id: batchId,
      deleted_rows: Number(deleteResult.deletedCount ?? deleteResult.n ?? 0),
      removed_contra_matches: relatedMatches.length,
      unlinked_statement_rows: unlinkedRows,
      preserved: ["Ledger / Particulars Mappings", "Groups", "Sub-groups", "Group Companies", "Bank Opening Balances"],
      message: `Imported file deleted: ${Number(deleteResult.deletedCount ?? deleteResult.n ?? 0)} statement entries removed. Ledger and Group mappings were preserved.`,
    });
  } catch (error) {
    console.error("Bank statement import batch delete failed:", error);
    return res.status(500).json({ error: error.message || "Could not delete this imported statement." });
  }
});

router.get("/summary", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const filter = { company_id: companyId, ...dateFilter(req.query) };
    const [total, rows, unmapped] = await Promise.all([
      Transaction.countDocuments(filter),
      Transaction.aggregate([
        { $match: filter },
        { $group: { _id: null, receipts: { $sum: "$receipt_amount" }, payments: { $sum: "$payment_amount" }, bank_debit: { $sum: "$bank_debit" }, bank_credit: { $sum: "$bank_credit" }, banks: { $addToSet: "$bank_name" }, types: { $push: "$voucher_type" } } },
      ]),
      Transaction.distinct("normalized_particulars", filter),
    ]);
    const mapped = await LedgerMapping.distinct("normalized_name", { company_id: companyId, active: true });
    const mappedSet = new Set(mapped);
    const typeCounts = {};
    (rows[0]?.types || []).forEach((value) => { const key = text(value) || "Unknown"; typeCounts[key] = (typeCounts[key] || 0) + 1; });
    return res.json({
      total_transactions: total,
      total_receipts: rows[0]?.receipts || 0,
      total_payments: rows[0]?.payments || 0,
      bank_debit: rows[0]?.bank_debit || 0,
      bank_credit: rows[0]?.bank_credit || 0,
      bank_names: rows[0]?.banks || [],
      voucher_type_counts: typeCounts,
      distinct_particulars: unmapped.length,
      mapped_particulars: unmapped.filter((name) => mappedSet.has(name)).length,
      unmapped_particulars: unmapped.filter((name) => !mappedSet.has(name)).length,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not load bank report summary." });
  }
});

router.get("/groups", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const rows = await Group.find({ company_id: companyIdFrom(req), active: true }).sort({ sort_order: 1, name: 1 }).lean();
    return res.json(rows.map((row) => ({ ...row, id: String(row._id) })));
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

router.post("/groups", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const name = text(req.body?.name);
    const nature = text(req.body?.nature).toLowerCase();
    const placement = text(req.body?.report_placement).toLowerCase();
    const sourceType = text(req.body?.source_type || "bank_statement").toLowerCase();
    if (!name || !NATURES.includes(nature) || !PLACEMENTS.includes(placement) || !["bank_statement", "warehouse_sale", "warehouse_purchase"].includes(sourceType)) {
      return res.status(400).json({ error: "Group Name, Account Nature, Report Placement and valid Source are required." });
    }
    if (sourceType === "warehouse_sale" && (nature !== "income" || placement !== "profit_loss")) return res.status(400).json({ error: "Warehouse Sale source must be an Income group shown in Profit & Loss." });
    if (sourceType === "warehouse_purchase" && (nature !== "expense" || placement !== "profit_loss")) return res.status(400).json({ error: "Warehouse Purchase source must be an Expense group shown in Profit & Loss." });
    const normalized = keyText(name);
    const existing = await Group.findOne({ company_id: companyId, normalized_name: normalized }).lean();
    if (existing) return res.status(409).json({ error: "This Group Name already exists." });
    if (sourceType !== "bank_statement") {
      const sourceAlreadyUsed = await Group.findOne({ company_id: companyId, source_type: sourceType, active: true }).lean();
      if (sourceAlreadyUsed) return res.status(409).json({ error: `A ${sourceType.replace("warehouse_", "Warehouse ")} source group already exists. Use the existing Group Master entry instead of creating a duplicate.` });
    }
    const row = await Group.create({ company_id: companyId, name, normalized_name: normalized, nature, report_placement: placement, source_type: sourceType, sort_order: numberValue(req.body?.sort_order), active: true });
    return res.status(201).json({ ...row.toObject(), id: String(row._id) });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

router.put("/groups/:id", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const currentGroup = await Group.findOne({ _id: req.params.id, company_id: companyId, active: true }).lean();
    if (!currentGroup) return res.status(404).json({ error: "Group not found." });
    const update = {};
    if (req.body?.name !== undefined) {
      update.name = text(req.body.name);
      update.normalized_name = keyText(req.body.name);
      if (!update.name) return res.status(400).json({ error: "Group Name is required." });
      const duplicate = await Group.findOne({ company_id: companyId, normalized_name: update.normalized_name, _id: { $ne: currentGroup._id } }).lean();
      if (duplicate) return res.status(409).json({ error: "This Group Name already exists." });
    }
    if (req.body?.nature !== undefined) update.nature = text(req.body.nature).toLowerCase();
    if (req.body?.report_placement !== undefined) update.report_placement = text(req.body.report_placement).toLowerCase();
    if (req.body?.sort_order !== undefined) update.sort_order = numberValue(req.body.sort_order);
    if (req.body?.source_type !== undefined) {
      const sourceType = text(req.body.source_type).toLowerCase();
      if (!["bank_statement", "warehouse_sale", "warehouse_purchase"].includes(sourceType)) return res.status(400).json({ error: "Invalid Group Source." });
      if (sourceType !== "bank_statement") {
        const sourceAlreadyUsed = await Group.findOne({ company_id: companyId, source_type: sourceType, active: true, _id: { $ne: req.params.id } }).lean();
        if (sourceAlreadyUsed) return res.status(409).json({ error: "Another Group already uses this Warehouse voucher source." });
        update.nature = sourceType === "warehouse_sale" ? "income" : "expense";
        update.report_placement = "profit_loss";
      }
      update.source_type = sourceType;
    }
    const effectiveSource = update.source_type || currentGroup.source_type || "bank_statement";
    const effectiveNature = update.nature || currentGroup.nature;
    const effectivePlacement = update.report_placement || currentGroup.report_placement;
    if (effectiveSource === "warehouse_sale" && (effectiveNature !== "income" || effectivePlacement !== "profit_loss")) return res.status(400).json({ error: "Warehouse Sale source must be an Income group shown in Profit & Loss." });
    if (effectiveSource === "warehouse_purchase" && (effectiveNature !== "expense" || effectivePlacement !== "profit_loss")) return res.status(400).json({ error: "Warehouse Purchase source must be an Expense group shown in Profit & Loss." });
    const row = await Group.findOneAndUpdate({ _id: req.params.id, company_id: companyId }, { $set: update }, { new: true, runValidators: true }).lean();
    if (!row) return res.status(404).json({ error: "Group not found." });
    await Promise.all([
      SubGroup.updateMany({ company_id: companyId, group_id: String(row._id), active: true }, { $set: { group_name: row.name } }),
      LedgerMapping.updateMany({ company_id: companyId, group_id: String(row._id), active: true }, { $set: { group_name: row.name, nature: row.nature, report_placement: row.report_placement } }),
    ]);
    return res.json({ ...row, id: String(row._id) });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

router.get("/subgroups", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const rows = await SubGroup.find({ company_id: companyIdFrom(req), active: true }).sort({ sort_order: 1, name: 1 }).lean();
    return res.json(rows.map((row) => ({ ...row, id: String(row._id) })));
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

router.post("/subgroups", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const name = text(req.body?.name);
    const groupId = text(req.body?.group_id);
    if (!name || !groupId || !mongoose.Types.ObjectId.isValid(groupId)) return res.status(400).json({ error: "Sub-group Name and Parent Group are required." });
    const group = await Group.findOne({ _id: groupId, company_id: companyId, active: true }).lean();
    if (!group) return res.status(400).json({ error: "Selected parent Group was not found." });
    const normalized = keyText(name);
    const existing = await SubGroup.findOne({ company_id: companyId, group_id: groupId, normalized_name: normalized }).lean();
    if (existing) return res.status(409).json({ error: "This Sub-group already exists under the selected Group." });
    const row = await SubGroup.create({ company_id: companyId, group_id: groupId, group_name: group.name, name, normalized_name: normalized, sort_order: numberValue(req.body?.sort_order), active: true });
    return res.status(201).json({ ...row.toObject(), id: String(row._id) });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

router.put("/subgroups/:id", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const subgroup = await SubGroup.findOne({ _id: req.params.id, company_id: companyId, active: true }).lean();
    if (!subgroup) return res.status(404).json({ error: "Sub-group not found." });
    const update = {};
    if (req.body?.name !== undefined) {
      update.name = text(req.body.name);
      update.normalized_name = keyText(req.body.name);
      if (!update.name) return res.status(400).json({ error: "Sub-group Name is required." });
    }
    if (req.body?.sort_order !== undefined) update.sort_order = numberValue(req.body.sort_order);
    if (req.body?.group_id !== undefined) {
      const groupId = text(req.body.group_id);
      const group = await Group.findOne({ _id: groupId, company_id: companyId, active: true }).lean();
      if (!group || (group.source_type && group.source_type !== "bank_statement")) return res.status(400).json({ error: "Select a valid Bank Statement Group." });
      update.group_id = String(group._id);
      update.group_name = group.name;
      const duplicate = await SubGroup.findOne({
        _id: { $ne: subgroup._id }, company_id: companyId,
        group_id: String(group._id), normalized_name: update.normalized_name || subgroup.normalized_name,
        active: true,
      }).lean();
      if (duplicate) return res.status(409).json({ error: "This Sub-group already exists under the selected Group." });
    }
    const nextGroupId = String(update.group_id || subgroup.group_id);
    const nextGroup = await Group.findOne({ _id: nextGroupId, company_id: companyId, active: true }).lean();
    if (!nextGroup) return res.status(400).json({ error: "Parent Group was not found." });
    const duplicate = await SubGroup.findOne({
      _id: { $ne: subgroup._id }, company_id: companyId, group_id: nextGroupId,
      normalized_name: update.normalized_name || subgroup.normalized_name, active: true,
    }).lean();
    if (duplicate) return res.status(409).json({ error: "This Sub-group already exists under the selected Group." });
    const updated = await SubGroup.findOneAndUpdate(
      { _id: subgroup._id, company_id: companyId },
      { $set: update },
      { new: true, runValidators: true }
    ).lean();
    // Keep existing saved Particulars mappings attached to this edited Sub-group.
    await LedgerMapping.updateMany(
      { company_id: companyId, subgroup_id: String(subgroup._id), active: true },
      { $set: {
        group_id: nextGroupId,
        group_name: nextGroup.name,
        subgroup_name: updated.name,
        nature: nextGroup.nature,
        report_placement: nextGroup.report_placement,
      } }
    );
    return res.json({ ...updated, id: String(updated._id) });
  } catch (error) { return res.status(500).json({ error: error.message || "Could not update Sub-group." }); }
});

router.get("/ledger-mappings", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const [mappings, groups, subgroups, rawNames] = await Promise.all([
      LedgerMapping.find({ company_id: companyId, active: true }).lean(),
      Group.find({ company_id: companyId, active: true }).lean(),
      SubGroup.find({ company_id: companyId, active: true }).lean(),
      Transaction.aggregate([
        { $match: { company_id: companyId } },
        { $group: { _id: "$normalized_particulars", name: { $first: "$particulars_name" }, count: { $sum: 1 } } },
        { $sort: { name: 1 } },
      ]),
    ]);
    const mappingMap = new Map(mappings.map((row) => [row.normalized_name, row]));
    const groupMap = new Map(groups.map((row) => [String(row._id), row]));
    const subMap = new Map(subgroups.map((row) => [String(row._id), row]));
    const namesMap = new Map();
    rawNames.forEach((item) => namesMap.set(item._id, { normalized_name: item._id, particulars_name: item.name || item._id, transaction_count: item.count }));
    // Keep saved mappings visible even when the current statement has no rows for that ledger.
    mappings.forEach((mapping) => {
      if (!namesMap.has(mapping.normalized_name)) {
        namesMap.set(mapping.normalized_name, { normalized_name: mapping.normalized_name, particulars_name: mapping.particulars_name, transaction_count: 0 });
      }
    });
    return res.json([...namesMap.values()].sort((a, b) => a.particulars_name.localeCompare(b.particulars_name)).map((item) => {
      const mapping = mappingMap.get(item.normalized_name);
      const group = mapping ? groupMap.get(String(mapping.group_id)) : null;
      const subgroup = mapping?.subgroup_id ? subMap.get(String(mapping.subgroup_id)) : null;
      return {
        ...item,
        ledger_name: text(mapping?.ledger_name) || item.particulars_name,
        group_id: mapping?.group_id || "",
        group_name: group?.name || mapping?.group_name || "",
        subgroup_id: mapping?.subgroup_id || "",
        subgroup_name: subgroup?.name || mapping?.subgroup_name || "",
        group_company: text(mapping?.group_company),
        nature: group?.nature || mapping?.nature || "",
        report_placement: group?.report_placement || mapping?.report_placement || "",
        opening_balance: mapping?.opening_balance || 0,
        opening_balance_type: mapping?.opening_balance_type || "dr",
        mapped: Boolean(mapping && group),
        mapping_id: mapping ? String(mapping._id) : "",
      };
    }));
  } catch (error) { return res.status(500).json({ error: error.message || "Could not load Particulars mapping." }); }
});

router.post("/ledger-mappings", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const particularsName = text(req.body?.particulars_name);
    const groupId = text(req.body?.group_id);
    const subgroupId = text(req.body?.subgroup_id);
    if (!particularsName || !groupId || !mongoose.Types.ObjectId.isValid(groupId)) return res.status(400).json({ error: "Particulars Name and Group are required." });
    const group = await Group.findOne({ _id: groupId, company_id: companyId, active: true }).lean();
    if (!group) return res.status(400).json({ error: "Selected Group was not found." });
    if (group.source_type && group.source_type !== "bank_statement") return res.status(400).json({ error: "Warehouse Sale / Purchase source groups are posted automatically from their vouchers and cannot be used for bank Particulars mapping." });
    let subgroup = null;
    if (subgroupId) {
      if (!mongoose.Types.ObjectId.isValid(subgroupId)) return res.status(400).json({ error: "Invalid Sub-group selected." });
      subgroup = await SubGroup.findOne({ _id: subgroupId, group_id: groupId, company_id: companyId, active: true }).lean();
      if (!subgroup) return res.status(400).json({ error: "Selected Sub-group does not belong to the chosen Group." });
    }
    const balance = numberValue(req.body?.opening_balance);
    const row = await LedgerMapping.findOneAndUpdate(
      { company_id: companyId, normalized_name: keyText(particularsName) },
      { $set: {
        particulars_name: particularsName,
        ledger_name: text(req.body?.ledger_name) || particularsName,
        group_id: groupId,
        group_name: group.name,
        subgroup_id: subgroup ? String(subgroup._id) : "",
        subgroup_name: subgroup?.name || "",
        group_company: text(req.body?.group_company),
        nature: group.nature,
        report_placement: group.report_placement,
        opening_balance: Math.abs(balance),
        opening_balance_type: String(req.body?.opening_balance_type || "dr").toLowerCase() === "cr" ? "cr" : "dr",
        active: true,
      }, $setOnInsert: { company_id: companyId, normalized_name: keyText(particularsName) } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();
    return res.json({ ...row, id: String(row._id) });
  } catch (error) { return res.status(500).json({ error: error.message || "Could not save Particulars mapping." }); }
});

router.get("/bank-opening-balances", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const filter = { company_id: companyId, active: true };
    if (text(req.query.bank_name)) filter.normalized_bank_name = keyText(req.query.bank_name);
    const rows = await BankOpeningBalance.find(filter).sort({ bank_name: 1 }).lean();
    return res.json(rows.map((row) => ({ ...row, id: String(row._id) })));
  } catch (error) { return res.status(500).json({ error: error.message || "Could not load Bank Opening Balances." }); }
});

router.post("/bank-opening-balances", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const bankName = text(req.body?.bank_name);
    const effectiveDate = excelDate(req.body?.effective_date);
    const openingBalance = Math.abs(numberValue(req.body?.opening_balance));
    const openingBalanceType = String(req.body?.opening_balance_type || "dr").toLowerCase() === "cr" ? "cr" : "dr";
    if (!bankName || !effectiveDate) return res.status(400).json({ error: "Bank Name and Opening Balance Date are required." });
    const saved = await BankOpeningBalance.findOneAndUpdate(
      { company_id: companyId, normalized_bank_name: keyText(bankName) },
      { $set: { bank_name: bankName, normalized_bank_name: keyText(bankName), effective_date: effectiveDate, opening_balance: openingBalance, opening_balance_type: openingBalanceType, notes: text(req.body?.notes), active: true } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();
    return res.json({ ...saved, id: String(saved._id) });
  } catch (error) { return res.status(500).json({ error: error.message || "Could not save Bank Opening Balance." }); }
});

router.delete("/bank-opening-balances/:id", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const deleted = await BankOpeningBalance.findOneAndUpdate({ _id: req.params.id, company_id: companyId }, { $set: { active: false } }, { new: true }).lean();
    if (!deleted) return res.status(404).json({ error: "Bank Opening Balance not found." });
    return res.json({ success: true });
  } catch (error) { return res.status(500).json({ error: error.message || "Could not remove Bank Opening Balance." }); }
});

router.get("/reports/bank-balance", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const selectedBank = keyText(req.query.bank_name);
    const toDate = text(req.query.to_date) ? new Date(`${text(req.query.to_date)}T23:59:59.999Z`) : new Date();
    const txFilter = { company_id: companyId, bank_date: { $lte: toDate } };
    if (selectedBank) {
      const escapedBankName = text(req.query.bank_name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      txFilter.bank_name = new RegExp(`^${escapedBankName}$`, "i");
    }
    const [allTransactions, openingRecords] = await Promise.all([
      Transaction.find(txFilter).sort({ bank_date: 1, _id: 1 }).limit(100000).lean(),
      BankOpeningBalance.find({ company_id: companyId, active: true, ...(selectedBank ? { normalized_bank_name: selectedBank } : {}) }).lean(),
    ]);
    const bankNames = [...new Set([...allTransactions.map((row) => text(row.bank_name)), ...openingRecords.map((row) => text(row.bank_name))].filter(Boolean))].sort((a,b) => a.localeCompare(b));
    const candidateDates = [...allTransactions.map((row) => new Date(row.bank_date).getTime()), ...openingRecords.map((row) => new Date(row.effective_date).getTime())].filter(Number.isFinite);
    const fromDate = text(req.query.from_date) ? new Date(`${text(req.query.from_date)}T00:00:00.000Z`) : new Date(candidateDates.length ? Math.min(...candidateDates) : toDate.getTime());
    if (fromDate > toDate) return res.status(400).json({ error: "From Date cannot be later than To Date." });
    const periodType = ["daily", "monthly"].includes(String(req.query.period_type || "").toLowerCase()) ? String(req.query.period_type).toLowerCase() : "range";
    // Load master mappings independently of the display filters so that
    // bank-level opening / closing balances always include every movement.
    const reportContext = await loadReportContext(companyId, {});

    // Resolve saved Contra Match links for the selected statement rows. A matched
    // transfer must be reported as a Bank-to-Bank movement (Current Assets /
    // Bank Accounts), even when the original bank particulars have no ledger
    // mapping or were previously mapped to an unrelated expense head.
    const selectedContraMatchIds = [...new Set(allTransactions.map((row) => text(row.contra_match_id)).filter(Boolean))];
    const matchedContraRecords = selectedContraMatchIds.length
      ? await ContraMatch.find({ company_id: companyId, status: "matched", _id: { $in: selectedContraMatchIds } }).lean()
      : [];
    const linkedContraTransactionIds = [...new Set(matchedContraRecords.flatMap((row) => [text(row.payment_transaction_id), text(row.receipt_transaction_id)]).filter(Boolean))];
    const alreadyLoadedIds = new Set(allTransactions.map((row) => String(row._id)));
    const missingContraTransactionIds = linkedContraTransactionIds.filter((id) => !alreadyLoadedIds.has(id));
    const missingContraRows = missingContraTransactionIds.length
      ? await Transaction.find({ company_id: companyId, _id: { $in: missingContraTransactionIds } }).lean()
      : [];
    const contraTransactionById = new Map([...allTransactions, ...missingContraRows].map((row) => [String(row._id), row]));
    const currentAssetsGroup = reportContext.groups.find((row) => keyText(row.name) === "current assets")
      || reportContext.groups.find((row) => keyText(row.nature) === "asset" && keyText(row.report_placement) === "balance_sheet");
    const bankAccountsSubgroup = reportContext.subgroups.find((row) => keyText(row.name) === "bank accounts"
      && (!currentAssetsGroup || String(row.group_id) === String(currentAssetsGroup._id)));
    const contraInfoByTransaction = new Map();
    for (const match of matchedContraRecords) {
      const paymentRow = contraTransactionById.get(String(match.payment_transaction_id));
      const receiptRow = contraTransactionById.get(String(match.receipt_transaction_id));
      if (!paymentRow || !receiptRow) continue;
      const paymentMapping = reportContext.mappingByName.get(paymentRow.normalized_particulars) || null;
      const receiptMapping = reportContext.mappingByName.get(receiptRow.normalized_particulars) || null;
      const sharedGroupCompany = transactionGroupCompany(paymentRow, paymentMapping)
        || transactionGroupCompany(receiptRow, receiptMapping)
        || "";
      contraInfoByTransaction.set(String(paymentRow._id), {
        counter_bank: text(match.receipt_bank || receiptRow.bank_name),
        group_company: sharedGroupCompany,
        transfer_id: text(match.transfer_id),
        match_id: String(match._id),
      });
      contraInfoByTransaction.set(String(receiptRow._id), {
        counter_bank: text(match.payment_bank || paymentRow.bank_name),
        group_company: sharedGroupCompany,
        transfer_id: text(match.transfer_id),
        match_id: String(match._id),
      });
    }

    const requestedCompany = requestedGroupCompany(req.query);
    const requestedGroupId = text(req.query.group_id);
    const requestedSubgroupId = text(req.query.subgroup_id);
    const rows = [];
    const details = [];
    const totals = { opening_balance: 0, receipts: 0, payments: 0, closing_balance: 0, transactions: 0 };
    const missingBanks = [];
    for (const bankName of bankNames) {
      const bankTx = allTransactions.filter((row) => keyText(row.bank_name) === keyText(bankName));
      const candidates = openingRecords.filter((row) => keyText(row.bank_name) === keyText(bankName) && new Date(row.effective_date) <= fromDate)
        .sort((a,b) => new Date(b.effective_date) - new Date(a.effective_date));
      const openingRecord = candidates[0] || null;
      let openingBalance = openingRecord ? signedBankOpening(openingRecord) : 0;
      const manualOpeningSet = Boolean(openingRecord);
      let openingSource = openingRecord ? "Manual" : "Missing";
      if (openingRecord) {
        for (const tx of bankTx) {
          const date = new Date(tx.bank_date);
          if (date >= new Date(openingRecord.effective_date) && date < fromDate) openingBalance += transactionBankReceipt(tx) - transactionBankPayment(tx);
        }
      } else {
        const previous = bankTx.filter((tx) => new Date(tx.bank_date) < fromDate).sort((a,b) => new Date(b.bank_date) - new Date(a.bank_date))[0];
        if (previous && Number.isFinite(Number(previous.bank_balance))) {
          openingBalance = numberValue(previous.bank_balance);
          openingSource = "Statement Balance";
        } else {
          const firstTransaction = bankTx.find((tx) => new Date(tx.bank_date) >= fromDate);
          if (firstTransaction && Number(firstTransaction.bank_balance || 0) !== 0) {
            openingBalance = numberValue(firstTransaction.bank_balance) - transactionBankReceipt(firstTransaction) + transactionBankPayment(firstTransaction);
            openingSource = "Derived from Statement";
          }
        }
      }
      if (!manualOpeningSet) missingBanks.push(bankName);
      const selectedTransactions = bankTx.filter((tx) => new Date(tx.bank_date) >= fromDate && new Date(tx.bank_date) <= toDate);
      // Produce a ledger-level detail line for every saved split allocation (or
      // the ordinary mapped ledger). Running bank balance is calculated once
      // per original transaction, never once per split line.
      let detailRunningBalance = openingBalance;
      for (const tx of selectedTransactions) {
        const bankReceipt = transactionBankReceipt(tx);
        const bankPayment = transactionBankPayment(tx);
        detailRunningBalance += bankReceipt - bankPayment;
        // Voucher type / imported file filters narrow the ledger detail only;
        // they must not change the bank's actual running balance. Matched rows
        // are exposed as Contra as well as retaining their original Receipt /
        // Payment side for statement reconciliation.
        const contraInfo = contraInfoByTransaction.get(String(tx._id)) || null;
        const isContra = Boolean(contraInfo) || keyText(tx.voucher_type) === "contra";
        const requestedVoucherType = keyText(req.query.voucher_type);
        const rowVoucherTypes = isContra
          ? new Set(["contra", keyText(tx.voucher_type)])
          : new Set([keyText(tx.voucher_type)]);
        if (requestedVoucherType && !rowVoucherTypes.has(requestedVoucherType)) continue;
        if (text(req.query.import_batch_id) && text(tx.import_batch_id) !== text(req.query.import_batch_id)) continue;
        const mapped = mapTransaction(tx, reportContext);
        const allocations = isContra
          ? [{
              ledger_name: text(contraInfo?.counter_bank) || transactionLedgerName(tx, reportContext.mappingByName.get(tx.normalized_particulars) || null),
              group_id: currentAssetsGroup ? String(currentAssetsGroup._id) : "",
              group_name: currentAssetsGroup?.name || "Current Assets",
              subgroup_id: bankAccountsSubgroup ? String(bankAccountsSubgroup._id) : "",
              subgroup_name: bankAccountsSubgroup?.name || "Bank Accounts",
              group_company: text(contraInfo?.group_company) || transactionGroupCompany(tx, reportContext.mappingByName.get(tx.normalized_particulars) || null),
              side: transactionEntrySide(tx),
              amount: transactionEntryAmount(tx),
            }]
          : (Array.isArray(mapped.allocations) ? mapped.allocations : []);
        const visibleAllocations = allocations.filter((allocation) => {
          if (requestedGroupId && String(allocation.group_id || "") !== requestedGroupId) return false;
          if (requestedSubgroupId && String(allocation.subgroup_id || "") !== requestedSubgroupId) return false;
          return matchesGroupCompany(allocation, requestedCompany);
        });
        visibleAllocations.forEach((allocation, allocationIndex) => {
          const side = allocation.side === "receipt" ? "receipt" : "payment";
          const amount = numberValue(allocation.amount);
          details.push({
            id: `${String(tx._id)}:${allocationIndex}`,
            transaction_id: String(tx._id),
            bank_date: tx.bank_date,
            bank_time: tx.bank_time || "",
            bank_name: text(tx.bank_name),
            original_particulars: text(tx.particulars_name),
            ledger_name: text(allocation.ledger_name) || mapped.ledger_name || "Unmapped Ledger",
            voucher_type: isContra ? "Contra" : text(tx.voucher_type),
            voucher_number: text(tx.voucher_number),
            contra_transfer_id: text(contraInfo?.transfer_id),
            contra_match_id: text(contraInfo?.match_id || tx.contra_match_id),
            contra_counter_bank: text(contraInfo?.counter_bank || tx.contra_counter_bank),
            group_company: text(allocation.group_company),
            group_id: text(allocation.group_id),
            group_name: text(allocation.group_name) || "Unmapped",
            subgroup_id: text(allocation.subgroup_id),
            subgroup_name: text(allocation.subgroup_name),
            receipt_amount: side === "receipt" ? amount : 0,
            payment_amount: side === "payment" ? amount : 0,
            allocation_amount: amount,
            allocation_side: side,
            statement_debit: allocationIndex === 0 ? numberValue(tx.bank_debit) : null,
            statement_credit: allocationIndex === 0 ? numberValue(tx.bank_credit) : null,
            bank_balance: allocationIndex === 0 ? (tx.bank_balance === undefined || tx.bank_balance === null ? null : numberValue(tx.bank_balance)) : null,
            running_balance: allocationIndex === 0 ? detailRunningBalance : null,
            bank_remarks: text(tx.bank_remarks),
            instrument_type: text(tx.instrument_type),
            instrument_no: text(tx.instrument_no),
            transaction_reference: text(tx.transaction_id),
            bank_status: text(tx.bank_status),
            tally_date: tx.tally_date || null,
            allocation_index: allocationIndex,
            allocation_count: visibleAllocations.length,
            split: Array.isArray(tx.allocations) && tx.allocations.length > 1,
          });
        });
      }
      const buckets = new Map();
      for (const tx of selectedTransactions) {
        const period = periodType === "range" ? "Selected Period" : reportPeriodLabel(tx.bank_date, periodType);
        if (!buckets.has(period)) buckets.set(period, { period, receipts: 0, payments: 0, transactions: 0 });
        const bucket = buckets.get(period);
        bucket.receipts += transactionBankReceipt(tx);
        bucket.payments += transactionBankPayment(tx);
        bucket.transactions += 1;
      }
      if (!buckets.size) {
        const emptyPeriod = periodType === "range" ? "Selected Period" : reportPeriodLabel(fromDate, periodType);
        buckets.set(emptyPeriod, { period: emptyPeriod, receipts: 0, payments: 0, transactions: 0 });
      }
      let running = openingBalance;
      let bankReceipts = 0, bankPayments = 0, bankCount = 0;
      for (const bucket of [...buckets.values()].sort((a,b) => String(a.period).localeCompare(String(b.period)))) {
        const periodOpening = running;
        running += bucket.receipts - bucket.payments;
        bankReceipts += bucket.receipts; bankPayments += bucket.payments; bankCount += bucket.transactions;
        rows.push({ bank_name: bankName, period: bucket.period, opening_balance: periodOpening, receipts: bucket.receipts, payments: bucket.payments, closing_balance: running, transactions: bucket.transactions, opening_balance_set: manualOpeningSet, opening_balance_source: openingSource, opening_balance_date: openingRecord?.effective_date || null });
      }
      totals.opening_balance += openingBalance; totals.receipts += bankReceipts; totals.payments += bankPayments; totals.closing_balance += running; totals.transactions += bankCount;
    }
    if (!selectedBank && bankNames.length > 1) {
      const periodTotals = new Map();
      for (const row of rows) {
        if (!periodTotals.has(row.period)) periodTotals.set(row.period, { period: row.period, opening_balance: 0, receipts: 0, payments: 0, closing_balance: 0, transactions: 0, opening_balance_set: true });
        const total = periodTotals.get(row.period);
        total.opening_balance += row.opening_balance;
        total.receipts += row.receipts;
        total.payments += row.payments;
        total.closing_balance += row.closing_balance;
        total.transactions += row.transactions;
        total.opening_balance_set = total.opening_balance_set && row.opening_balance_set;
      }
      for (const total of periodTotals.values()) rows.push({ bank_name: "ALL BANKS", ...total });
    }
    rows.sort((a,b) => String(a.period).localeCompare(String(b.period)) || (a.bank_name === "ALL BANKS" ? -1 : b.bank_name === "ALL BANKS" ? 1 : a.bank_name.localeCompare(b.bank_name)));

    // Build the Sub-group summary from the same filtered allocation details
    // returned to the report. This keeps Summary and Full Details consistent,
    // and ensures each split allocation rolls into its one Sub-group total.
    // The Contra Match link does not remove either original statement row.
    const summaryMap = new Map();
    for (const detail of details) {
      const date = detail.bank_date ? new Date(detail.bank_date) : null;
      const validDate = date && Number.isFinite(date.getTime());
      const year = validDate ? date.getUTCFullYear() : 0;
      const month = validDate ? date.getUTCMonth() : 0;
      const day = validDate ? date.getUTCDate() : 0;
      const periodSortKey = periodType === "daily" && validDate
        ? `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
        : periodType === "monthly" && validDate
          ? `${year}-${String(month + 1).padStart(2, "0")}`
          : "0000-00-00";
      const period = periodType === "daily" && validDate
        ? new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(date)
        : periodType === "monthly" && validDate
          ? new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(date)
          : "Selected Period";
      const companyValue = text(detail.group_company);
      const groupCompany = companyValue || "Unassigned";
      const groupName = text(detail.group_name) || "Unmapped";
      const subgroupName = text(detail.subgroup_name) || "No Sub-group";
      const bankDisplay = selectedBank
        ? text(req.query.bank_name)
        : (bankNames.length === 1 ? bankNames[0] : "All Selected Banks");
      const summaryIdentity = [periodSortKey, companyValue, text(detail.group_id), groupName, text(detail.subgroup_id), subgroupName].join("|\u001f|");
      const summaryKey = crypto.createHash("sha1").update(summaryIdentity).digest("hex");
      // The Sub-group details popup groups detail rows by summary_key on the
      // frontend. Attach the exact same key used by summary_rows to every
      // allocation detail so the clicked summary row resolves its transactions.
      detail.summary_key = summaryKey;
      if (!summaryMap.has(summaryKey)) {
        summaryMap.set(summaryKey, {
          summary_key: summaryKey,
          period,
          period_sort_key: periodSortKey,
          bank_name: bankDisplay,
          bank_names: new Set(),
          ledger_names: new Set(),
          group_company: groupCompany,
          group_name: groupName,
          subgroup_name: subgroupName,
          receipts: 0,
          payments: 0,
          transaction_ids: new Set(),
        });
      }
      const summary = summaryMap.get(summaryKey);
      summary.receipts += numberValue(detail.receipt_amount);
      summary.payments += numberValue(detail.payment_amount);
      if (text(detail.bank_name)) summary.bank_names.add(text(detail.bank_name));
      if (text(detail.ledger_name)) summary.ledger_names.add(text(detail.ledger_name));
      if (text(detail.transaction_id)) summary.transaction_ids.add(String(detail.transaction_id));
    }
    const summaryRows = [...summaryMap.values()].map((summary) => ({
      ...summary,
      bank_names: [...summary.bank_names].sort((a, b) => a.localeCompare(b)),
      ledger_names: [...summary.ledger_names].sort((a, b) => a.localeCompare(b)),
      transactions: summary.transaction_ids.size,
      net_amount: summary.receipts - summary.payments,
      total_amount: summary.receipts - summary.payments,
      transaction_ids: undefined,
    })).sort((a,b) => String(a.period_sort_key).localeCompare(String(b.period_sort_key))
      || a.group_company.localeCompare(b.group_company)
      || a.group_name.localeCompare(b.group_name)
      || a.subgroup_name.localeCompare(b.subgroup_name));

    return res.json({ from_date: fromDate, to_date: toDate, period_type: periodType, banks: bankNames, totals, rows, summary_rows: summaryRows, details, detail_count: details.length, opening_balance_missing_banks: missingBanks });
  } catch (error) { return res.status(500).json({ error: error.message || "Could not calculate Bank Balance report." }); }
});

// Contra Auto Matching: suggestions and saved transfer links. Both original
// statement rows remain intact; the match record is the one contra relationship.
router.get("/contra-matches", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const [unmatchedRows, matchedRows, mappings] = await Promise.all([
      Transaction.find({
        company_id: companyId,
        $or: [{ contra_match_id: { $exists: false } }, { contra_match_id: "" }, { contra_match_id: null }],
      }).sort({ bank_date: 1, bank_time: 1, _id: 1 }).limit(10000).lean(),
      ContraMatch.find({ company_id: companyId, status: "matched" }).sort({ createdAt: -1 }).limit(500).lean(),
      LedgerMapping.find({ company_id: companyId, active: true }).lean(),
    ]);
    const mappingByName = new Map(mappings.map((row) => [row.normalized_name, row]));
    const suggestions = buildContraSuggestions(unmatchedRows, mappingByName).slice(0, 500);
    const transactionIds = [...new Set(matchedRows.flatMap((row) => [row.payment_transaction_id, row.receipt_transaction_id]))];
    const linkedTransactions = transactionIds.length ? await Transaction.find({ company_id: companyId, _id: { $in: transactionIds } }).lean() : [];
    const linkedMap = new Map(linkedTransactions.map((row) => [String(row._id), row]));
    const matches = matchedRows.map((row) => ({
      ...row,
      id: String(row._id),
      payment: contraTransactionView(linkedMap.get(String(row.payment_transaction_id)) || {}, mappingByName),
      receipt: contraTransactionView(linkedMap.get(String(row.receipt_transaction_id)) || {}, mappingByName),
    }));
    return res.json({
      suggestions,
      matches,
      unmatched_transactions: unmatchedRows.length,
      safe_auto_match_count: suggestions.filter((row) => row.auto_safe).length,
      review_required_count: suggestions.filter((row) => !row.auto_safe).length,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not load Contra Match suggestions." });
  }
});

router.post("/contra-matches/auto-match", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const result = await autoMatchUniqueContraTransfers(companyId, req);
    return res.json({
      success: true,
      matched_count: result.matched_count,
      matches: result.matches,
      review_required_count: result.review_required_count,
      released_legacy_matches: result.released_legacy_matches || 0,
      message: result.matched_count
        ? `${result.matched_count} strict Contra Transfer(s) matched. ${result.released_legacy_matches || 0} previous link(s) that failed strict checks were unlinked. Original Bank Statement rows and balances were not changed.`
        : result.released_legacy_matches
          ? `${result.released_legacy_matches} previous Contra link(s) failed the strict checks and were unlinked. No new pair matched all required fields.`
          : "No Contra Match was found. Both rows must have Voucher Type Contra, the exact same amount, Transaction ID and Instrument Number. Bank Remarks may differ.",
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not run Contra Auto Matching." });
  }
});

router.post("/contra-matches", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const match = await createContraMatch(
      companyId,
      text(req.body?.payment_transaction_id),
      text(req.body?.receipt_transaction_id),
      req,
      "manual"
    );
    return res.status(201).json({ success: true, match, message: `Contra Transfer ${match.transfer_id} linked successfully.` });
  } catch (error) {
    return res.status(error.status || (error.code === 11000 ? 409 : 500)).json({ error: error.message || "Could not confirm Contra Match." });
  }
});

router.delete("/contra-matches/:id", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const match = await ContraMatch.findOne({ _id: req.params.id, company_id: companyId, status: "matched" }).lean();
    if (!match) return res.status(404).json({ error: "Contra Match not found." });
    await Transaction.updateMany(
      { company_id: companyId, contra_match_id: String(match._id) },
      { $unset: { contra_match_id: 1, contra_match_status: 1, contra_counter_bank: 1 } }
    );
    await ContraMatch.deleteOne({ _id: match._id, company_id: companyId });
    return res.json({ success: true, message: `Contra Transfer ${match.transfer_id} was unlinked. Original Statement rows remain unchanged.` });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not remove Contra Match." });
  }
});

router.get("/transactions", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const filter = { company_id: companyId, ...dateFilter(req.query) };
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit || 500)));
    const rows = await Transaction.find(filter).sort({ bank_date: 1, _id: 1 }).limit(limit).lean();
    rows.sort((a, b) => {
      const dateDiff = new Date(a.bank_date).getTime() - new Date(b.bank_date).getTime();
      if (dateDiff) return dateDiff;
      const timeDiff = bankTimeSortMinutes(a.bank_time) - bankTimeSortMinutes(b.bank_time);
      if (timeDiff) return timeDiff;
      return String(a._id).localeCompare(String(b._id));
    });
    const ctx = await loadReportContext(companyId, req.query);
    const mappedRows = rows.map((row) => mapTransaction(row, ctx));
    const requested = requestedGroupCompany(req.query);
    return res.json(requested ? mappedRows.filter((row) => row.allocations?.some((allocation) => {
      const actual = keyText(allocation.group_company);
      return requested === "__unassigned__" ? !actual : actual === requested;
    }) || (!row.allocations?.length && matchesGroupCompany(row.mapping, requested))) : mappedRows);
  } catch (error) { return res.status(500).json({ error: error.message || "Could not load Bank Statement." }); }
});

router.put("/transactions/:id", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const current = await Transaction.findOne({ _id: req.params.id, company_id: companyId }).lean();
    if (!current) return res.status(404).json({ error: "Bank Statement transaction not found." });
    const update = {};
    const allowedText = ["bank_name", "bank_time", "bank_remarks", "instrument_type", "instrument_no", "transaction_id", "bank_status", "particulars_name", "ledger_name_override", "group_company_override", "voucher_type", "voucher_number"];
    allowedText.forEach((key) => {
      if (req.body?.[key] !== undefined) update[key] = text(req.body[key]);
    });
    if (req.body?.bank_date !== undefined) {
      const parsedDate = excelDate(req.body.bank_date);
      if (!parsedDate) return res.status(400).json({ error: "Please provide a valid Bank Date." });
      update.bank_date = parsedDate;
    }
    if (req.body?.tally_date !== undefined) update.tally_date = req.body.tally_date ? excelDate(req.body.tally_date) : null;
    ["bank_debit", "bank_credit", "bank_balance", "receipt_amount", "payment_amount"].forEach((key) => {
      if (req.body?.[key] !== undefined) update[key] = numberValue(req.body[key]);
    });
    if (update.receipt_amount < 0 || update.payment_amount < 0 || update.bank_debit < 0 || update.bank_credit < 0) {
      return res.status(400).json({ error: "Receipt, Payment, Debit and Credit amounts cannot be negative." });
    }
    const next = { ...current, ...update };
    if (!text(next.bank_name) || !text(next.particulars_name) || !text(next.voucher_type) || !text(next.voucher_number) || !next.bank_date) {
      return res.status(400).json({ error: "Date, Bank Name, Particulars, Voucher Type and Voucher Number are required." });
    }
    if (numberValue(next.receipt_amount) > 0 && numberValue(next.payment_amount) > 0) {
      return res.status(400).json({ error: "A row cannot contain both Receipt and Payment amounts. Correct the row before saving." });
    }
    if (Array.isArray(req.body?.allocations)) {
      const bankSide = transactionEntrySide(next);
      const bankAmount = transactionEntryAmount(next);
      const submitted = req.body.allocations.filter((item) => item && (text(item.ledger_name) || text(item.group_id) || numberValue(item.amount) > 0));
      if (!submitted.length) {
        update.allocations = [];
      } else {
        if (!bankAmount) return res.status(400).json({ error: "A split allocation requires a non-zero Receipt or Payment amount." });
        const groupIds = [...new Set(submitted.map((item) => text(item.group_id)).filter(Boolean))];
        const subgroupIds = [...new Set(submitted.map((item) => text(item.subgroup_id)).filter(Boolean))];
        if (groupIds.some((id) => !mongoose.Types.ObjectId.isValid(id)) || subgroupIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
          return res.status(400).json({ error: "One or more selected Groups / Sub-groups are invalid. Please select them again." });
        }
        const [allocationGroups, allocationSubgroups] = await Promise.all([
          Group.find({ company_id: companyId, _id: { $in: groupIds }, active: true }).lean(),
          SubGroup.find({ company_id: companyId, _id: { $in: subgroupIds }, active: true }).lean(),
        ]);
        const allocationGroupMap = new Map(allocationGroups.map((item) => [String(item._id), item]));
        const allocationSubgroupMap = new Map(allocationSubgroups.map((item) => [String(item._id), item]));
        const cleaned = [];
        for (const item of submitted) {
          const ledgerName = text(item.ledger_name);
          const groupId = text(item.group_id);
          const subgroupId = text(item.subgroup_id);
          const amount = numberValue(item.amount);
          const group = allocationGroupMap.get(groupId);
          if (!ledgerName || !group) return res.status(400).json({ error: "Each split row needs a Ledger Name and a valid Bank Statement Group." });
          if (amount <= 0) return res.status(400).json({ error: "Each split row amount must be greater than zero." });
          if (group.source_type && group.source_type !== "bank_statement") return res.status(400).json({ error: "Split allocations can use Bank Statement Groups only." });
          const subgroup = subgroupId ? allocationSubgroupMap.get(subgroupId) : null;
          if (subgroupId && (!subgroup || String(subgroup.group_id) !== groupId)) {
            return res.status(400).json({ error: `Sub-group does not belong to ${group.name}.` });
          }
          cleaned.push({
            ledger_name: ledgerName,
            group_id: groupId,
            group_name: group.name,
            subgroup_id: subgroup ? String(subgroup._id) : "",
            subgroup_name: subgroup?.name || "",
            group_company: text(item.group_company),
            nature: group.nature,
            report_placement: group.report_placement,
            side: bankSide,
            amount: Number(amount.toFixed(2)),
          });
        }
        const allocatedTotal = cleaned.reduce((sum, item) => sum + item.amount, 0);
        if (Math.abs(allocatedTotal - bankAmount) > 0.01) {
          return res.status(400).json({ error: `Split total ${allocatedTotal.toFixed(2)} must equal the Bank Statement amount ${bankAmount.toFixed(2)}.` });
        }
        update.allocations = cleaned;
      }
    }
    const nextSourceKey = buildTransactionSourceKey(companyId, next);
    const duplicate = await Transaction.findOne({ company_id: companyId, source_key: nextSourceKey, _id: { $ne: current._id } }).select("_id").lean();
    if (duplicate) return res.status(409).json({ error: "Another statement row already has the same Bank, Date, Particulars, Voucher and Amount. Please check the duplicate." });
    update.normalized_particulars = keyText(next.particulars_name);
    update.source_key = nextSourceKey;
    const row = await Transaction.findOneAndUpdate(
      { _id: current._id, company_id: companyId },
      { $set: update },
      { new: true, runValidators: true }
    ).lean();
    await refreshImportBatch(companyId, current.import_batch_id);
    if (current.import_batch_id !== next.import_batch_id) await refreshImportBatch(companyId, next.import_batch_id);
    const ctx = await loadReportContext(companyId, {});
    return res.json(mapTransaction(row, ctx));
  } catch (error) { return res.status(500).json({ error: error.message || "Could not update Bank Statement row." }); }
});

router.get("/reports/groupwise", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const ctx = await loadReportContext(companyId, req.query);
    const result = new Map();
    for (const tx of ctx.transactions) {
      const allocations = transactionAllocations(tx, ctx);
      const transactionBuckets = new Set();
      for (const allocation of allocations) {
        if (!matchesAllocationFilters(allocation, req.query)) continue;
        const group = allocation.group_id ? ctx.groupById.get(String(allocation.group_id)) : null;
        const subgroup = allocation.subgroup_id ? ctx.subgroupById.get(String(allocation.subgroup_id)) : null;
        const groupCompanyValue = allocation.group_company || "";
        if (!matchesGroupCompany({ group_company: groupCompanyValue }, req.query.group_company)) continue;
        const groupCompany = groupCompanyValue || "Unassigned";
        const ledgerName = allocation.ledger_name || "";
        const periodLabel = reportPeriodLabel(tx.bank_date, req.query.period_type);
        const key = `${group ? group._id : "unmapped"}|${subgroup?._id || ""}|${keyText(groupCompany)}|${keyText(periodLabel)}`;
        if (!result.has(key)) result.set(key, {
          period_label: periodLabel,
          group_id: group ? String(group._id) : "",
          group_name: group?.name || allocation.group_name || "Unmapped",
          subgroup_id: subgroup ? String(subgroup._id) : "",
          subgroup_name: subgroup?.name || allocation.subgroup_name || (group ? "No Sub-group" : "Needs Mapping"),
          group_company: groupCompany,
          nature: group?.nature || allocation.nature || "",
          report_placement: group?.report_placement || allocation.report_placement || "",
          transactions: 0, receipts: 0, payments: 0, net_movement: 0, ledger_names: new Set(),
        });
        const row = result.get(key);
        if (ledgerName) row.ledger_names.add(ledgerName);
        if (!transactionBuckets.has(key)) { row.transactions += 1; transactionBuckets.add(key); }
        const receipt = allocation.side === "receipt" ? numberValue(allocation.amount) : 0;
        const payment = allocation.side === "payment" ? numberValue(allocation.amount) : 0;
        row.receipts += receipt;
        row.payments += payment;
        if (row.nature === "asset") row.net_movement += payment - receipt;
        else if (["liability", "equity", "income"].includes(row.nature)) row.net_movement += receipt - payment;
        else if (row.nature === "expense") row.net_movement += payment - receipt;
      }
    }
    const groupCompanySelection = requestedGroupCompany(req.query);
    const sourceGroups = ctx.groups.filter((group) => ["warehouse_sale", "warehouse_purchase"].includes(group.source_type)
      && (!text(req.query.group_id) || String(group._id) === text(req.query.group_id))
      && !text(req.query.subgroup_id));
    if ((!groupCompanySelection || groupCompanySelection === "__unassigned__") && sourceGroups.length) {
      const dateFilterForVouchers = voucherDateFilter(req.query);
      const warehouseFilter = assignedWarehouseMongoFilter(req.user);
      const [sales, purchases] = await Promise.all([
        sourceGroups.some((group) => group.source_type === "warehouse_sale") && SaleVoucher
          ? SaleVoucher.find({ ...warehouseFilter, ...dateFilterForVouchers }).lean() : [],
        sourceGroups.some((group) => group.source_type === "warehouse_purchase") && PurchaseVoucher
          ? PurchaseVoucher.find({ ...warehouseFilter, ...dateFilterForVouchers }).lean() : [],
      ]);
      for (const group of sourceGroups) {
        const kind = group.source_type === "warehouse_sale" ? "sale" : "purchase";
        const sourceRows = kind === "sale" ? sales : purchases;
        const totalAmount = sourceRows.reduce((sum, row) => sum + voucherAmount(row, kind), 0);
        const row = {
          group_id: String(group._id), group_name: group.name, subgroup_id: "", subgroup_name: "Warehouse Vouchers",
          group_company: "Unassigned", nature: group.nature, report_placement: group.report_placement, transactions: sourceRows.length,
          receipts: kind === "sale" ? totalAmount : 0, payments: kind === "purchase" ? totalAmount : 0,
          net_movement: kind === "sale" ? totalAmount : totalAmount * -1,
        };
        result.set(`${group._id}|warehouse-vouchers`, row);
      }
    }
    return res.json([...result.values()].map((row) => ({ ...row, ledger_names: [...(row.ledger_names || [])].sort((a, b) => a.localeCompare(b)) })).sort((a,b) => String(a.period_label || "").localeCompare(String(b.period_label || "")) || a.group_name.localeCompare(b.group_name) || a.subgroup_name.localeCompare(b.subgroup_name)));
  } catch (error) { return res.status(500).json({ error: error.message || "Could not calculate Group-wise report." }); }
});

router.get("/reports/group-company", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const ctx = await loadReportContext(companyId, req.query);
    const result = new Map();
    for (const tx of ctx.transactions) {
      const allocations = transactionAllocations(tx, ctx);
      const transactionCompanies = new Set();
      for (const allocation of allocations) {
        if (!matchesAllocationFilters(allocation, req.query)) continue;
        const groupCompanyValue = allocation.group_company || "";
        if (!matchesGroupCompany({ group_company: groupCompanyValue }, req.query.group_company)) continue;
        const groupCompany = groupCompanyValue || "Unassigned";
        const ledgerName = allocation.ledger_name || "";
        const periodLabel = reportPeriodLabel(tx.bank_date, req.query.period_type);
        const key = `${keyText(groupCompany)}|${keyText(periodLabel)}`;
        if (!result.has(key)) result.set(key, {
          period_label: periodLabel,
          group_company: groupCompany, transactions: 0, ledgers: new Set(), receipts: 0, payments: 0,
          income: 0, expenses: 0, asset_movement: 0, liability_movement: 0,
        });
        const row = result.get(key);
        if (!transactionCompanies.has(key)) { row.transactions += 1; transactionCompanies.add(key); }
        if (ledgerName) row.ledgers.add(ledgerName);
        const receipt = allocation.side === "receipt" ? numberValue(allocation.amount) : 0;
        const payment = allocation.side === "payment" ? numberValue(allocation.amount) : 0;
        row.receipts += receipt;
        row.payments += payment;
        const group = allocation.group_id ? ctx.groupById.get(String(allocation.group_id)) : null;
        if (!group || String(tx.voucher_type || "").toLowerCase() === "contra") continue;
        if (group.nature === "income" && group.report_placement === "profit_loss") row.income += receipt - payment;
        else if (group.nature === "expense" && group.report_placement === "profit_loss") row.expenses += payment - receipt;
        else if (group.nature === "asset") row.asset_movement += payment - receipt;
        else if (group.nature === "liability" || group.nature === "equity") row.liability_movement += receipt - payment;
      }
    }
    return res.json([...result.values()].map((row) => ({
      ...row,
      ledger_names: [...row.ledgers].sort((a, b) => a.localeCompare(b)),
      ledgers: row.ledgers.size,
      net_profit: row.income - row.expenses,
    })).sort((a, b) => String(a.period_label || "").localeCompare(String(b.period_label || "")) || a.group_company.localeCompare(b.group_company)));
  } catch (error) { return res.status(500).json({ error: error.message || "Could not calculate Group Company report." }); }
});

router.get("/reports/profit-loss", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const ctx = await loadReportContext(companyId, req.query);
    const groups = new Map();
    let income = 0;
    let expense = 0;
    let excludedContra = 0;
    for (const tx of ctx.transactions) {
      if (String(tx.voucher_type || "").toLowerCase() === "contra") { excludedContra += 1; continue; }
      for (const allocation of transactionAllocations(tx, ctx)) {
        if (!matchesAllocationFilters(allocation, req.query)) continue;
        const groupCompanyValue = allocation.group_company || "";
        if (!matchesGroupCompany({ group_company: groupCompanyValue }, req.query.group_company)) continue;
        const groupCompany = groupCompanyValue || "Unassigned";
        const group = allocation.group_id ? ctx.groupById.get(String(allocation.group_id)) : null;
        if (!group || group.report_placement !== "profit_loss") continue;
        const side = allocation.side;
        const allocatedAmount = numberValue(allocation.amount);
        let amount = 0;
        if (group.nature === "income") amount = side === "receipt" ? allocatedAmount : -allocatedAmount;
        else if (group.nature === "expense") amount = side === "payment" ? allocatedAmount : -allocatedAmount;
        else continue;
        const isIncome = group.nature === "income";
        if (isIncome) income += amount; else expense += amount;
        const ledgerName = allocation.ledger_name || "Unspecified Ledger";
        const periodLabel = reportPeriodLabel(tx.bank_date, req.query.period_type);
        const key = `${group._id}|${allocation.subgroup_id || ""}|${keyText(groupCompany)}|${keyText(ledgerName)}|${keyText(periodLabel)}`;
        if (!groups.has(key)) groups.set(key, {
          period_label: periodLabel,
          group_name: group.name,
          subgroup_name: allocation.subgroup_name || "",
          ledger_name: ledgerName,
          group_company: groupCompany,
          nature: group.nature,
          amount: 0,
        });
        groups.get(key).amount += amount;
      }
    }
    const groupCompanySelection = requestedGroupCompany(req.query);
    const sourceGroups = ctx.groups.filter((group) => ["warehouse_sale", "warehouse_purchase"].includes(group.source_type)
      && (!text(req.query.group_id) || String(group._id) === text(req.query.group_id))
      && !text(req.query.subgroup_id));
    if ((!groupCompanySelection || groupCompanySelection === "__unassigned__") && sourceGroups.length) {
      const dateFilterForVouchers = voucherDateFilter(req.query);
      const warehouseFilter = assignedWarehouseMongoFilter(req.user);
      const [sales, purchases] = await Promise.all([
        sourceGroups.some((group) => group.source_type === "warehouse_sale") && SaleVoucher
          ? SaleVoucher.find({ ...warehouseFilter, ...dateFilterForVouchers }).lean() : [],
        sourceGroups.some((group) => group.source_type === "warehouse_purchase") && PurchaseVoucher
          ? PurchaseVoucher.find({ ...warehouseFilter, ...dateFilterForVouchers }).lean() : [],
      ]);
      for (const group of sourceGroups) {
        const kind = group.source_type === "warehouse_sale" ? "sale" : "purchase";
        const sourceRows = kind === "sale" ? sales : purchases;
        const amount = sourceRows.reduce((sum, row) => sum + voucherAmount(row, kind), 0);
        if (kind === "sale") income += amount; else expense += amount;
        const key = `${group._id}|warehouse-vouchers`;
        groups.set(key, { group_name: group.name, subgroup_name: "Warehouse Vouchers", group_company: "Unassigned", nature: group.nature, amount });
      }
    }
    return res.json({ income, expense, net_profit: income - expense, excluded_contra_rows: excludedContra, rows: [...groups.values()].sort((a,b) => String(a.period_label || "").localeCompare(String(b.period_label || "")) || a.group_name.localeCompare(b.group_name) || a.subgroup_name.localeCompare(b.subgroup_name) || String(a.ledger_name || "").localeCompare(String(b.ledger_name || ""))) });
  } catch (error) { return res.status(500).json({ error: error.message || "Could not calculate Profit & Loss." }); }
});

router.get("/reports/balance-sheet", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    // Balance Sheet is a point-in-time closing balance: include all transactions up to To Date,
    // not only the selected From Date range.
    const balanceQuery = { ...req.query };
    delete balanceQuery.from_date;
    delete balanceQuery.voucher_type;
    const ctx = await loadReportContext(companyId, balanceQuery);
    const groups = new Map();
    let totalAssets = 0;
    let totalLiabilities = 0;
    let totalEquity = 0;
    for (const mapping of ctx.mappings) {
      const group = ctx.groupById.get(String(mapping.group_id));
      if (!group || group.report_placement !== "balance_sheet" || !["asset", "liability", "equity"].includes(group.nature)) continue;
      if (text(req.query.group_id) && String(mapping.group_id) !== text(req.query.group_id)) continue;
      if (text(req.query.subgroup_id) && String(mapping.subgroup_id || "") !== text(req.query.subgroup_id)) continue;
      const normalSide = group.nature === "asset" ? "dr" : "cr";
      const ledgerTransactions = ctx.transactions.filter((tx) => tx.normalized_particulars === mapping.normalized_name && !(Array.isArray(tx.allocations) && tx.allocations.length));
      const buckets = new Map();
      const addBucket = (ledgerName, groupCompany) => {
        const key = `${keyText(ledgerName)}|${keyText(groupCompany)}`;
        if (!buckets.has(key)) buckets.set(key, { ledger_name: ledgerName, group_company: groupCompany || "Unassigned", transactions: [], opening: 0 });
        return buckets.get(key);
      };
      const defaultLedgerName = text(mapping.ledger_name) || mapping.particulars_name;
      const defaultGroupCompany = text(mapping.group_company);
      for (const tx of ledgerTransactions) {
        const groupCompanyValue = transactionGroupCompany(tx, mapping);
        if (!matchesTransactionGroupCompany(tx, mapping, req.query.group_company)) continue;
        const ledgerNameValue = transactionLedgerName(tx, mapping);
        addBucket(ledgerNameValue, groupCompanyValue).transactions.push(tx);
      }

      const hasOpening = Math.abs(numberValue(mapping.opening_balance)) > 0;
      const defaultMatchesFilter = matchesGroupCompany({ group_company: defaultGroupCompany }, req.query.group_company);
      if ((!ledgerTransactions.length && defaultMatchesFilter) || (hasOpening && defaultMatchesFilter)) {
        const defaultBucket = addBucket(defaultLedgerName, defaultGroupCompany);
        defaultBucket.opening = signedOpening(mapping, normalSide);
      }

      for (const bucket of buckets.values()) {
        let balance = bucket.opening;
        for (const tx of bucket.transactions) {
          if (group.nature === "asset") balance += numberValue(tx.payment_amount) - numberValue(tx.receipt_amount);
          else balance += numberValue(tx.receipt_amount) - numberValue(tx.payment_amount);
        }
        const groupCompany = bucket.group_company || "Unassigned";
        const row = {
          group_name: group.name,
          subgroup_name: mapping.subgroup_name || "",
          particulars_name: bucket.ledger_name,
          original_particulars_name: mapping.particulars_name,
          group_company: groupCompany,
          nature: group.nature,
          normal_balance: balance,
          debit_balance: group.nature === "asset" ? Math.max(0, balance) : Math.max(0, -balance),
          credit_balance: group.nature === "asset" ? Math.max(0, -balance) : Math.max(0, balance),
        };
        const key = `${group._id}|${mapping.subgroup_id || ""}|${keyText(groupCompany)}`;
        if (!groups.has(key)) groups.set(key, { group_name: group.name, subgroup_name: mapping.subgroup_name || "", group_company: groupCompany, nature: group.nature, balance: 0, ledgers: [] });
        groups.get(key).balance += balance;
        groups.get(key).ledgers.push(row);
        groups.get(key).ledger_names = groups.get(key).ledgers.map((ledger) => ledger.particulars_name).filter(Boolean);
        if (group.nature === "asset") totalAssets += balance;
        else if (group.nature === "liability") totalLiabilities += balance;
        else totalEquity += balance;
      }
    }

    // Split statement rows are included from their individual ledger allocations, without double-counting the original mapped row.
    for (const tx of ctx.transactions) {
      if (!Array.isArray(tx.allocations) || !tx.allocations.length) continue;
      for (const allocation of transactionAllocations(tx, ctx)) {
        if (!matchesAllocationFilters(allocation, req.query)) continue;
        const group = allocation.group_id ? ctx.groupById.get(String(allocation.group_id)) : null;
        if (!group || group.report_placement !== "balance_sheet" || !["asset", "liability", "equity"].includes(group.nature)) continue;
        const groupCompanyValue = allocation.group_company || "";
        if (!matchesGroupCompany({ group_company: groupCompanyValue }, req.query.group_company)) continue;
        const amount = numberValue(allocation.amount);
        const signed = group.nature === "asset"
          ? (allocation.side === "payment" ? amount : -amount)
          : (allocation.side === "receipt" ? amount : -amount);
        const groupCompany = groupCompanyValue || "Unassigned";
        const subgroupName = allocation.subgroup_name || "";
        const key = `${group._id}|${allocation.subgroup_id || ""}|${keyText(groupCompany)}`;
        if (!groups.has(key)) groups.set(key, { group_name: group.name, subgroup_name: subgroupName, group_company: groupCompany, nature: group.nature, balance: 0, ledgers: [] });
        const groupRow = groups.get(key);
        groupRow.balance += signed;
        const ledgerName = allocation.ledger_name || "Unspecified Ledger";
        let ledgerRow = groupRow.ledgers.find((item) => keyText(item.particulars_name) === keyText(ledgerName));
        if (!ledgerRow) {
          ledgerRow = { particulars_name: ledgerName, original_particulars_name: tx.particulars_name, group_company: groupCompany, nature: group.nature, normal_balance: 0, debit_balance: 0, credit_balance: 0 };
          groupRow.ledgers.push(ledgerRow);
        }
        ledgerRow.normal_balance += signed;
        ledgerRow.debit_balance = group.nature === "asset" ? Math.max(0, ledgerRow.normal_balance) : Math.max(0, -ledgerRow.normal_balance);
        ledgerRow.credit_balance = group.nature === "asset" ? Math.max(0, -ledgerRow.normal_balance) : Math.max(0, ledgerRow.normal_balance);
        groupRow.ledger_names = groupRow.ledgers.map((ledger) => ledger.particulars_name).filter(Boolean);
        if (group.nature === "asset") totalAssets += signed;
        else if (group.nature === "liability") totalLiabilities += signed;
        else totalEquity += signed;
      }
    }

    // Column D identifies the bank account and Column H contains its running balance.
    // Use the latest imported statement balance for each bank as a Balance Sheet asset;
    // a negative bank balance is shown as a Bank Overdraft liability.
    const latestBankRows = new Map();
    const groupCompanySelectionForBalance = requestedGroupCompany(req.query);
    const selectedBalanceGroup = text(req.query.group_id) ? ctx.groupById.get(text(req.query.group_id)) : null;
    const canShowBankAccounts = !selectedBalanceGroup || ["current assets", "loans (liability)"].includes(keyText(selectedBalanceGroup.name));
    const openingBankRecords = (groupCompanySelectionForBalance || !canShowBankAccounts || text(req.query.subgroup_id)) ? [] : await BankOpeningBalance.find({ company_id: companyId, active: true, ...(req.query.to_date ? { effective_date: { $lte: new Date(`${text(req.query.to_date)}T23:59:59.999Z`) } } : {}) }).lean();
    const allBankNames = new Set((groupCompanySelectionForBalance || !canShowBankAccounts || text(req.query.subgroup_id)) ? [] : [...ctx.transactions.map((tx) => text(tx.bank_name)), ...openingBankRecords.map((row) => text(row.bank_name))].filter(Boolean));
    for (const bankName of allBankNames) {
      const bankTransactions = ctx.transactions.filter((tx) => keyText(tx.bank_name) === keyText(bankName));
      const openingRecord = openingBankRecords.filter((row) => keyText(row.bank_name) === keyText(bankName)).sort((a,b) => new Date(b.effective_date) - new Date(a.effective_date))[0];
      const latestTx = bankTransactions.reduce((latest, tx) => !latest || new Date(tx.bank_date) >= new Date(latest.bank_date) ? tx : latest, null);
      if (!openingRecord && !latestTx) continue;
      let closingBalance;
      if (openingRecord) {
        closingBalance = signedBankOpening(openingRecord);
        for (const tx of bankTransactions) if (new Date(tx.bank_date) >= new Date(openingRecord.effective_date)) closingBalance += transactionBankReceipt(tx) - transactionBankPayment(tx);
      } else closingBalance = numberValue(latestTx.bank_balance);
      const tx = latestTx || { bank_date: openingRecord?.effective_date };
      const isOverdraft = closingBalance < 0;
      const amount = Math.abs(closingBalance);
      const nature = isOverdraft ? "liability" : "asset";
      const groupName = isOverdraft ? "Bank Overdrafts" : "Bank Accounts";
      const rowKey = `${groupName}|${bankName}`;
      const row = {
        group_name: groupName,
        subgroup_name: bankName,
        particulars_name: bankName,
        group_company: "Unassigned",
        nature,
        balance: amount,
        normal_balance: isOverdraft ? -amount : amount,
        debit_balance: isOverdraft ? 0 : amount,
        credit_balance: isOverdraft ? amount : 0,
        source: openingRecord ? "manual_opening_plus_statement_movements" : "bank_statement_column_h",
        opening_balance: openingRecord ? signedBankOpening(openingRecord) : null,
        opening_balance_date: openingRecord?.effective_date || null,
        balance_date: tx.bank_date,
      };
      groups.set(rowKey, { group_name: groupName, subgroup_name: bankName, nature, balance: amount, ledgers: [row] });
      if (isOverdraft) totalLiabilities += amount;
      else totalAssets += amount;
    }

    return res.json({
      total_assets: totalAssets,
      total_liabilities: totalLiabilities,
      total_equity: totalEquity,
      liabilities_plus_equity: totalLiabilities + totalEquity,
      difference: totalAssets - totalLiabilities - totalEquity,
      rows: [...groups.values()].sort((a,b) => a.group_name.localeCompare(b.group_name) || a.subgroup_name.localeCompare(b.subgroup_name)),
    });
  } catch (error) { return res.status(500).json({ error: error.message || "Could not calculate Balance Sheet." }); }
});

module.exports = router;
