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
  normalized_name: { type: String, required: true },
  group_id: { type: String, required: true },
  group_name: { type: String, required: true },
  subgroup_id: { type: String, default: "" },
  subgroup_name: { type: String, default: "" },
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
  voucher_type: String,
  voucher_number: String,
  receipt_amount: { type: Number, default: 0 },
  payment_amount: { type: Number, default: 0 },
  import_file_name: String,
  import_batch_id: String,
  imported_by: String,
}, [{ fields: { company_id: 1, source_key: 1 }, options: { unique: true } }]);

const ImportBatch = collectionModel("BankFinancialImportBatch", "bankfinancialimportbatches", {
  company_id: { type: String, default: "default" },
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

function mapTransaction(row, ctx) {
  const mapping = ctx.mappingByName.get(row.normalized_particulars) || null;
  const group = mapping ? ctx.groupById.get(String(mapping.group_id)) : null;
  const subgroup = mapping?.subgroup_id ? ctx.subgroupById.get(String(mapping.subgroup_id)) : null;
  return {
    ...row,
    id: String(row._id),
    mapping: mapping ? {
      group_id: mapping.group_id,
      group_name: group?.name || mapping.group_name,
      subgroup_id: mapping.subgroup_id || "",
      subgroup_name: subgroup?.name || mapping.subgroup_name || "",
      nature: group?.nature || mapping.nature,
      report_placement: group?.report_placement || mapping.report_placement,
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
      const keySource = transactionId
        ? `${companyId}|${keyText(bankName)}|${transactionId}|${bankDate.toISOString().slice(0, 10)}`
        : `${companyId}|${keyText(bankName)}|${bankDate.toISOString().slice(0, 10)}|${keyText(particulars)}|${keyText(voucherType)}|${voucherNo}|${receiptAmount}|${paymentAmount}`;
      const sourceKey = crypto.createHash("sha256").update(keySource).digest("hex");
      records.push({
        company_id: companyId,
        source_key: sourceKey,
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
    const operations = records.map((record) => ({
      updateOne: {
        filter: { company_id: companyId, source_key: record.source_key },
        update: { $setOnInsert: record },
        upsert: true,
      },
    }));
    const writeResult = await Transaction.bulkWrite(operations, { ordered: false });
    const importedRows = Number(writeResult.upsertedCount || 0);
    const duplicateRows = Math.max(0, records.length - importedRows);
    const batch = await ImportBatch.create({
      company_id: companyId,
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
    return res.json({
      success: true,
      batch_id: String(batch._id),
      file_name: req.file.originalname,
      total_rows: records.length + invalidRows.length,
      imported_rows: importedRows,
      duplicate_rows: duplicateRows,
      invalid_rows: invalidRows.length,
      invalid_details: invalidRows.slice(0, 30),
      total_receipts: totalReceipts,
      total_payments: totalPayments,
      date_from: minDate,
      date_to: maxDate,
      bank_names: [...new Set(records.map((row) => row.bank_name))],
    });
  } catch (error) {
    console.error("Bank financial report import failed:", error);
    return res.status(500).json({ error: error.message || "Bank statement import failed." });
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
    const update = {};
    if (req.body?.name !== undefined) { update.name = text(req.body.name); update.normalized_name = keyText(req.body.name); }
    if (req.body?.nature !== undefined) update.nature = text(req.body.nature).toLowerCase();
    if (req.body?.report_placement !== undefined) update.report_placement = text(req.body.report_placement).toLowerCase();
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
    const effectiveSource = update.source_type;
    if (effectiveSource === "warehouse_sale" && ((update.nature || "income") !== "income" || (update.report_placement || "profit_loss") !== "profit_loss")) return res.status(400).json({ error: "Warehouse Sale source must be an Income group shown in Profit & Loss." });
    if (effectiveSource === "warehouse_purchase" && ((update.nature || "expense") !== "expense" || (update.report_placement || "profit_loss") !== "profit_loss")) return res.status(400).json({ error: "Warehouse Purchase source must be an Expense group shown in Profit & Loss." });
    const row = await Group.findOneAndUpdate({ _id: req.params.id, company_id: companyId }, { $set: update }, { new: true, runValidators: true }).lean();
    if (!row) return res.status(404).json({ error: "Group not found." });
    await Group.updateOne({ _id: row._id, company_id: companyId }, { $set: { updatedAt: new Date() } });
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

router.get("/ledger-mappings", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const [names, mappings, groups, subgroups] = await Promise.all([
      Transaction.distinct("normalized_particulars", { company_id: companyId }),
      LedgerMapping.find({ company_id: companyId, active: true }).lean(),
      Group.find({ company_id: companyId, active: true }).lean(),
      SubGroup.find({ company_id: companyId, active: true }).lean(),
    ]);
    const rawNames = await Transaction.aggregate([
      { $match: { company_id: companyId } },
      { $group: { _id: "$normalized_particulars", name: { $first: "$particulars_name" }, count: { $sum: 1 } } },
      { $sort: { name: 1 } },
    ]);
    const mappingMap = new Map(mappings.map((row) => [row.normalized_name, row]));
    const groupMap = new Map(groups.map((row) => [String(row._id), row]));
    const subMap = new Map(subgroups.map((row) => [String(row._id), row]));
    return res.json(rawNames.map((item) => {
      const mapping = mappingMap.get(item._id);
      const group = mapping ? groupMap.get(String(mapping.group_id)) : null;
      const subgroup = mapping?.subgroup_id ? subMap.get(String(mapping.subgroup_id)) : null;
      return {
        particulars_name: item.name || item._id,
        normalized_name: item._id,
        transaction_count: item.count,
        group_id: mapping?.group_id || "",
        group_name: group?.name || mapping?.group_name || "",
        subgroup_id: mapping?.subgroup_id || "",
        subgroup_name: subgroup?.name || mapping?.subgroup_name || "",
        nature: group?.nature || mapping?.nature || "",
        report_placement: group?.report_placement || mapping?.report_placement || "",
        opening_balance: mapping?.opening_balance || 0,
        opening_balance_type: mapping?.opening_balance_type || "dr",
        mapped: Boolean(mapping && group),
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
        group_id: groupId,
        group_name: group.name,
        subgroup_id: subgroup ? String(subgroup._id) : "",
        subgroup_name: subgroup?.name || "",
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

router.get("/transactions", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const filter = { company_id: companyId, ...dateFilter(req.query) };
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit || 500)));
    const rows = await Transaction.find(filter).sort({ bank_date: -1, _id: -1 }).limit(limit).lean();
    const ctx = await loadReportContext(companyId, req.query);
    return res.json(rows.map((row) => mapTransaction(row, ctx)));
  } catch (error) { return res.status(500).json({ error: error.message || "Could not load Bank Statement." }); }
});

router.get("/reports/groupwise", async (req, res) => {
  try {
    if (!mongoReady(res)) return;
    const companyId = companyIdFrom(req);
    const ctx = await loadReportContext(companyId, req.query);
    const result = new Map();
    for (const tx of ctx.transactions) {
      const mapping = ctx.mappingByName.get(tx.normalized_particulars);
      const group = mapping ? ctx.groupById.get(String(mapping.group_id)) : null;
      const subgroup = mapping?.subgroup_id ? ctx.subgroupById.get(String(mapping.subgroup_id)) : null;
      const key = mapping && group ? `${group._id}|${subgroup?._id || ""}` : "unmapped";
      if (!result.has(key)) result.set(key, {
        group_id: group ? String(group._id) : "",
        group_name: group?.name || "Unmapped",
        subgroup_id: subgroup ? String(subgroup._id) : "",
        subgroup_name: subgroup?.name || (mapping ? "No Sub-group" : "Needs Mapping"),
        nature: group?.nature || "",
        report_placement: group?.report_placement || "",
        transactions: 0, receipts: 0, payments: 0, net_movement: 0,
      });
      const row = result.get(key);
      row.transactions += 1;
      row.receipts += numberValue(tx.receipt_amount);
      row.payments += numberValue(tx.payment_amount);
      if (group?.nature === "asset") row.net_movement += numberValue(tx.payment_amount) - numberValue(tx.receipt_amount);
      else if (["liability", "equity", "income"].includes(group?.nature)) row.net_movement += numberValue(tx.receipt_amount) - numberValue(tx.payment_amount);
      else if (group?.nature === "expense") row.net_movement += numberValue(tx.payment_amount) - numberValue(tx.receipt_amount);
    }
    const sourceGroups = ctx.groups.filter((group) => ["warehouse_sale", "warehouse_purchase"].includes(group.source_type));
    if (sourceGroups.length) {
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
          nature: group.nature, report_placement: group.report_placement, transactions: sourceRows.length,
          receipts: kind === "sale" ? totalAmount : 0, payments: kind === "purchase" ? totalAmount : 0,
          net_movement: kind === "sale" ? totalAmount : totalAmount * -1,
        };
        result.set(`${group._id}|warehouse-vouchers`, row);
      }
    }
    return res.json([...result.values()].sort((a,b) => a.group_name.localeCompare(b.group_name) || a.subgroup_name.localeCompare(b.subgroup_name)));
  } catch (error) { return res.status(500).json({ error: error.message || "Could not calculate Group-wise report." }); }
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
      const mapping = ctx.mappingByName.get(tx.normalized_particulars);
      const group = mapping ? ctx.groupById.get(String(mapping.group_id)) : null;
      if (!group || group.report_placement !== "profit_loss") continue;
      if (String(tx.voucher_type || "").toLowerCase() === "contra") { excludedContra += 1; continue; }
      let amount = 0;
      if (group.nature === "income") amount = numberValue(tx.receipt_amount) - numberValue(tx.payment_amount);
      else if (group.nature === "expense") amount = numberValue(tx.payment_amount) - numberValue(tx.receipt_amount);
      else continue;
      const isIncome = group.nature === "income";
      if (isIncome) income += amount; else expense += amount;
      const key = `${group._id}|${mapping.subgroup_id || ""}`;
      if (!groups.has(key)) groups.set(key, { group_name: group.name, subgroup_name: mapping.subgroup_name || "", nature: group.nature, amount: 0 });
      groups.get(key).amount += amount;
    }
    const sourceGroups = ctx.groups.filter((group) => ["warehouse_sale", "warehouse_purchase"].includes(group.source_type));
    if (sourceGroups.length) {
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
        groups.set(key, { group_name: group.name, subgroup_name: "Warehouse Vouchers", nature: group.nature, amount });
      }
    }
    return res.json({ income, expense, net_profit: income - expense, excluded_contra_rows: excludedContra, rows: [...groups.values()].sort((a,b) => a.group_name.localeCompare(b.group_name) || a.subgroup_name.localeCompare(b.subgroup_name)) });
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
      const normalSide = group.nature === "asset" ? "dr" : "cr";
      let balance = signedOpening(mapping, normalSide);
      for (const tx of ctx.transactions) {
        if (tx.normalized_particulars !== mapping.normalized_name) continue;
        if (group.nature === "asset") balance += numberValue(tx.payment_amount) - numberValue(tx.receipt_amount);
        else balance += numberValue(tx.receipt_amount) - numberValue(tx.payment_amount);
      }
      const row = {
        group_name: group.name,
        subgroup_name: mapping.subgroup_name || "",
        particulars_name: mapping.particulars_name,
        nature: group.nature,
        normal_balance: balance,
        debit_balance: group.nature === "asset" ? Math.max(0, balance) : Math.max(0, -balance),
        credit_balance: group.nature === "asset" ? Math.max(0, -balance) : Math.max(0, balance),
      };
      const key = `${group._id}|${mapping.subgroup_id || ""}`;
      if (!groups.has(key)) groups.set(key, { group_name: group.name, subgroup_name: mapping.subgroup_name || "", nature: group.nature, balance: 0, ledgers: [] });
      groups.get(key).balance += balance;
      groups.get(key).ledgers.push(row);
      if (group.nature === "asset") totalAssets += balance;
      else if (group.nature === "liability") totalLiabilities += balance;
      else totalEquity += balance;
    }

    // Column D identifies the bank account and Column H contains its running balance.
    // Use the latest imported statement balance for each bank as a Balance Sheet asset;
    // a negative bank balance is shown as a Bank Overdraft liability.
    const latestBankRows = new Map();
    for (const tx of ctx.transactions) {
      const bankName = text(tx.bank_name);
      if (!bankName) continue;
      const current = latestBankRows.get(bankName);
      if (!current || new Date(tx.bank_date).getTime() >= new Date(current.bank_date).getTime()) {
        latestBankRows.set(bankName, tx);
      }
    }
    for (const [bankName, tx] of latestBankRows.entries()) {
      const closingBalance = numberValue(tx.bank_balance);
      const isOverdraft = closingBalance < 0;
      const amount = Math.abs(closingBalance);
      const nature = isOverdraft ? "liability" : "asset";
      const groupName = isOverdraft ? "Bank Overdrafts" : "Bank Accounts";
      const rowKey = `${groupName}|${bankName}`;
      const row = {
        group_name: groupName,
        subgroup_name: bankName,
        particulars_name: bankName,
        nature,
        balance: amount,
        normal_balance: isOverdraft ? -amount : amount,
        debit_balance: isOverdraft ? 0 : amount,
        credit_balance: isOverdraft ? amount : 0,
        source: "bank_statement_column_h",
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
