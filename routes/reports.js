const express = require("express");
const router = express.Router();
const { userHasPermission } = require("../middleware/auth");
const { calculateShortageQty } = require("./shortageHelper");
const {
  buildWarehouseStockSummary,
  buildTotalStock,
} = require("../helpers/reportStockSummary");
const {
  mongoose,
  Inward,
  Outward,
  Warehouse,
  Product,
  Company,
  CompanyAccount,
  ConsigneeName,
  isMongoMirrorReady,
} = require("../db-mongodb");
const { canAccessWarehouse } = require("../helpers/access");

function authorizeReport(permission) {
  return (req, res, next) => userHasPermission(req.user, permission)
    ? next()
    : res.status(403).json({ error: "You do not have permission to view this report" });
}

function dateFilter(query) {
  const filter = {};
  if (query.from_date || query.to_date) filter.date = {};
  if (query.from_date) filter.date.$gte = new Date(query.from_date);
  if (query.to_date) {
    const end = new Date(query.to_date);
    end.setUTCHours(23, 59, 59, 999);
    filter.date.$lte = end;
  }
  return filter;
}

function addIdFilter(filter, field, value) {
  if (value === undefined || value === null || value === "") return;
  const values = String(value).split(",").map((item) => item.trim()).filter(Boolean);
  filter[field] = values.length > 1 ? { $in: values } : values[0];
}

async function loadInwards(query, projection = null) {
  const filter = dateFilter(query);
  ["company_id", "warehouse_id", "product_id", "location_id", "employee_id", "company_account_id"].forEach((field) => {
    addIdFilter(filter, field, query[field] || query[`${field}s`]);
  });
  const cursor = Inward.find(filter).sort({ date: 1, _id: 1 });
  if (projection) cursor.select(projection);
  return cursor.lean();
}

function grossQty(row) { return Number(row?.weight ?? row?.quantity ?? 0) || 0; }
function normalizeShortagePercent(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
function effectiveShortagePercent(row, companyMap, accountMap) {
  const inwardPercent = normalizeShortagePercent(row?.shortage_percent);
  if (inwardPercent !== null) return inwardPercent;

  const company = companyMap?.get(String(row?.company_id ?? '').trim()) || {};
  const companyPercent = normalizeShortagePercent(company?.shortage_percent);
  if (companyPercent !== null) return companyPercent;

  const account = accountMap?.get(String(row?.company_account_id ?? '').trim()) || {};
  const accountPercent = normalizeShortagePercent(account?.shortage_percent);
  return accountPercent;
}
function shortageQty(row, shortagePercent = null) {
  return Number(calculateShortageQty(grossQty(row), 1, shortagePercent)) || 0;
}
function availableQty(row, shortagePercent = null) {
  const shortage = shortageQty(row, shortagePercent);
  if (row?.remaining_qty !== undefined && row?.remaining_qty !== null && row?.remaining_qty !== '') return Math.max(Number(row.remaining_qty) - shortage, 0);
  return Math.max(grossQty(row) - shortage - Number(row?.adjusted_qty || 0), 0);
}
function idAliases(row) { return [row?._id,row?.legacy_id,row?.id,row?.sl_no].filter(v => v !== undefined && v !== null && String(v).trim()).map(String); }
function buildAliasMap(rows) { const map=new Map(); for(const row of rows||[]) for(const id of idAliases(row)) map.set(id,row); return map; }

function buildOutwardIdConditions(ids) {
  const conditions = [];
  for (const raw of ids || []) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    conditions.push({ id: value });
    if (mongoose.Types.ObjectId.isValid(value)) conditions.push({ _id: new mongoose.Types.ObjectId(value) });
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      conditions.push({ id: numeric }, { legacy_id: numeric }, { sl_no: numeric });
    }
  }
  return conditions;
}

function buildReferenceConditions(field, ids) {
  const conditions = [];
  for (const raw of ids || []) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    conditions.push({ [field]: value });
    if (mongoose.Types.ObjectId.isValid(value)) {
      conditions.push({ [field]: new mongoose.Types.ObjectId(value) });
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) conditions.push({ [field]: numeric });
  }
  return conditions;
}

async function buildPartyStockRows(query, loadedInwards = null) {
  const inwards = loadedInwards || await loadInwards(query);
  if (!inwards.length) return [];
  const db = mongoose.connection.db;

  // Only inward adjustments can affect this report. Keep legacy rows whose
  // source_type is missing/blank because the old code treated those as inward.
  const inwardAdjustmentFilter = {
    $or: [
      { source_type: { $regex: /^inward$/i } },
      { source_type: { $exists: false } },
      { source_type: null },
      { source_type: "" },
    ],
  };
  const adjustments = await db.collection('adjustments')
    .find(inwardAdjustmentFilter, { projection: { inward_id: 1, qty: 1, quantity: 1, outward_id: 1 } })
    .toArray();

  const outwardIds = Array.from(new Set(
    adjustments.map((row) => String(row?.outward_id ?? '').trim()).filter(Boolean)
  ));
  const outwardConditions = buildOutwardIdConditions(outwardIds);

  const [outwards, warehouses, products, companies, accounts] = await Promise.all([
    outwardConditions.length ? Outward.find({ $or: outwardConditions }).select({ _id: 1, legacy_id: 1, id: 1, sl_no: 1, date: 1, outward_date: 1 }).lean() : [],
    Warehouse.find({}).select({ _id: 1, legacy_id: 1, id: 1, sl_no: 1, name: 1, address: 1, warehouse_address: 1 }).lean(),
    Product.find({}).select({ _id: 1, legacy_id: 1, id: 1, sl_no: 1, name: 1 }).lean(),
    Company.find({}).select({ _id: 1, legacy_id: 1, id: 1, sl_no: 1, name: 1, address: 1, company_address: 1, shortage_percent: 1 }).lean(),
    CompanyAccount.find({}).select({ _id: 1, legacy_id: 1, id: 1, sl_no: 1, account_name: 1, shortage_percent: 1 }).lean(),
  ]);
  const outwardMap=buildAliasMap(outwards), warehouseMap=buildAliasMap(warehouses), productMap=buildAliasMap(products), companyMap=buildAliasMap(companies), accountMap=buildAliasMap(accounts);
  const adjustedByInward=new Map(), outwardDatesByInward=new Map();
  for(const adj of adjustments||[]){
    if(String(adj?.source_type||'inward').toLowerCase() !== 'inward') continue;
    const key=String(adj?.inward_id??'').trim(); if(!key) continue;
    const qty=Number(adj?.qty??adj?.quantity??0)||0; adjustedByInward.set(key,(adjustedByInward.get(key)||0)+qty);
    const outward=outwardMap.get(String(adj?.outward_id??'').trim()); const od=outward?.date||outward?.outward_date||null;
    if(od){ const arr=outwardDatesByInward.get(key)||[]; arr.push(od); outwardDatesByInward.set(key,arr); }
  }
  return inwards.map(row=>{
    const aliases=idAliases(row); let adjusted=0; for(const key of aliases){ if(adjustedByInward.has(key)){adjusted=Number(adjustedByInward.get(key)||0); break;} }
    const warehouse=warehouseMap.get(String(row?.warehouse_id??''))||{}, product=productMap.get(String(row?.product_id??''))||{}, company=companyMap.get(String(row?.company_id??''))||{}, account=accountMap.get(String(row?.company_account_id??''))||{};
    const shortagePercent=effectiveShortagePercent(row, companyMap, accountMap);
    const gross=grossQty(row), shortage=shortageQty(row, shortagePercent), netOpening=Math.max(gross-shortage,0);
    const remainingRaw=Number(row?.remaining_qty);
    const available=Number.isFinite(remainingRaw) ? Math.max(remainingRaw-shortage,0) : Math.max(netOpening-adjusted,0);
    const dates=aliases.flatMap(k=>outwardDatesByInward.get(k)||[]).filter(Boolean).sort((a,b)=>new Date(a)-new Date(b));
    const inwardDate=row?.date||row?.inward_date||null, outwardDate=dates.at(-1)||row?.outward_date||null;
    const daysDiff=outwardDate&&inwardDate?Math.max(0,Math.floor((new Date(outwardDate)-new Date(inwardDate))/86400000)):0;
    return {...row, id:row?._id?String(row._id):(row?.legacy_id??row?.sl_no??row?.id), company_name:row?.company_name||company?.name||row?.company||'', company_address:row?.company_address||company?.address||company?.company_address||'', account_name:row?.company_account_name||row?.company_account||row?.account_name||account?.account_name||'', lorry_no:row?.lorry_no||'', employee_name:row?.employee_name||'', warehouse_name:row?.warehouse_name||warehouse?.name||row?.warehouse||'', warehouse_address:row?.warehouse_address||warehouse?.address||warehouse?.warehouse_address||'', location_name:row?.location_name||row?.location||'', product_name:row?.product_name||product?.name||row?.product||'', shortage_percent:shortagePercent, inward_shortage_percent:normalizeShortagePercent(row?.shortage_percent), company_shortage_percent:normalizeShortagePercent(company?.shortage_percent), account_shortage_percent:normalizeShortagePercent(account?.shortage_percent), inward_date:inwardDate, outward_date:outwardDate, days_diff:daysDiff, gross_qty:+gross.toFixed(4), shortage_qty:+shortage.toFixed(4), net_opening_qty:+netOpening.toFixed(4), already_adjusted_qty:+adjusted.toFixed(4), available_balance_qty:+available.toFixed(4)};
  });
}

function summaryBy(rows, keyFn, create) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, create(row));
    const target = map.get(key);
    Object.keys(target).forEach((field) => {
      if (typeof target[field] === "number" && typeof row[field] === "number") target[field] += row[field];
    });
  });
  return [...map.values()];
}

router.get("/party-ledger", authorizeReport("report.partyLedger"), async (req, res) => {
  try {
    const details = await loadInwards(req.query);
    const rows = details.map((row) => ({ ...row, balance_qty: availableQty(row) }));
    const summary = summaryBy(rows, (row) => `${row.company_name || row.company || ""}::${row.company_account_id || row.company_account_name || ""}`, (row) => ({
      party_name: row.company_name || row.company || "Unknown Party",
      account_name: row.company_account_name || row.company_account || null,
      gross_weight: Number(row.weight || row.quantity || 0),
      balance_qty: Number(row.balance_qty || 0),
    }));
    return res.json({ summary, details: rows });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

router.get("/party-stock", authorizeReport("report.partyStock"), async (req, res) => {
  try {
    const includeDashboardSummaries = String(req.query.dashboard_summaries || "") === "1";
    const inwardRows = includeDashboardSummaries ? await loadInwards(req.query) : null;
    const rows = await buildPartyStockRows(req.query, inwardRows);
    const summary = summaryBy(rows, row => `${row.company_name || "Unknown"}::${row.warehouse_name || row.warehouse_id || "Unknown"}`, row => ({
      party_name: row.company_name || "Unknown Party", company_address: row.company_address || "", warehouse_name: row.warehouse_name || "Unknown", gross_qty: Number(row.gross_qty||0), shortage_qty: Number(row.shortage_qty||0), net_opening_qty: Number(row.net_opening_qty||0), already_adjusted_qty: Number(row.already_adjusted_qty||0), available_balance_qty: Number(row.available_balance_qty||0),
    }));
    const response = { summary, details: rows };
    if (includeDashboardSummaries) {
      response.dashboardSummaries = {
        warehouseStock: buildWarehouseStockSummary(inwardRows, availableQty),
        totalStock: buildTotalStock(inwardRows, availableQty),
      };
    }
    return res.json(response);
  } catch (error) { console.error("Party stock report failed:", error); return res.status(500).json({ error: error.message }); }
});

router.get("/party-stock/adjustment-details", authorizeReport("report.partyStock"), async (req, res) => {
  try {
    if (!isMongoMirrorReady() || !mongoose.connection.db) {
      return res.status(503).json({ error: "MongoDB is not connected" });
    }

    const inwardId = String(req.query.inward_id || "").trim();
    if (!inwardId) return res.status(400).json({ error: "inward_id is required" });

    const inwardConditions = buildOutwardIdConditions([inwardId]);
    const inward = inwardConditions.length
      ? await Inward.findOne({ $or: inwardConditions }).lean()
      : null;
    if (!inward) return res.status(404).json({ error: "Inward entry not found" });
    if (inward.warehouse_id && !canAccessWarehouse(req.user, inward.warehouse_id)) {
      return res.status(403).json({ error: "You do not have access to this inward entry" });
    }

    const inwardIds = idAliases(inward);
    const adjustmentConditions = buildReferenceConditions("inward_id", inwardIds);
    const inwardSourceFilter = {
      $or: [
        { source_type: { $regex: /^inward$/i } },
        { source_type: { $exists: false } },
        { source_type: null },
        { source_type: "" },
      ],
    };
    const db = mongoose.connection.db;
    const adjustments = adjustmentConditions.length
      ? await db.collection("adjustments")
          .find({ $and: [inwardSourceFilter, { $or: adjustmentConditions }] })
          .sort({ created_at: 1, _id: 1 })
          .toArray()
      : [];

    const outwardIds = Array.from(new Set(
      adjustments.map((row) => String(row?.outward_id ?? "").trim()).filter(Boolean)
    ));
    const outwardConditions = buildOutwardIdConditions(outwardIds);
    const outwards = outwardConditions.length
      ? await Outward.find({ $or: outwardConditions })
          .select({
            _id: 1, legacy_id: 1, id: 1, sl_no: 1, voucher_no: 1,
            date: 1, outward_date: 1, warehouse_id: 1, warehouse_name: 1,
            location_id: 1, location_name: 1, location: 1,
            product_id: 1, product_name: 1, lorry_no: 1,
            company_name: 1, company_account_id: 1, company_account_name: 1,
            buyer_name: 1, buyer: 1, consignee_id: 1, consignee_name: 1,
            quantity: 1, weight: 1,
          })
          .lean()
      : [];
    const accessibleOutwards = outwards.filter(
      (row) => !row.warehouse_id || canAccessWarehouse(req.user, row.warehouse_id)
    );
    const outwardMap = buildAliasMap(accessibleOutwards);
    const accountIds = Array.from(new Set(
      accessibleOutwards
        .map((row) => String(row?.company_account_id ?? "").trim())
        .filter(Boolean)
    ));
    const accountConditions = buildOutwardIdConditions(accountIds);
    const consigneeIds = Array.from(new Set(
      accessibleOutwards
        .map((row) => String(row?.consignee_id ?? "").trim())
        .filter(Boolean)
    ));
    const consigneeConditions = buildOutwardIdConditions(consigneeIds);
    const [accounts, consignees] = await Promise.all([
      accountConditions.length
        ? CompanyAccount.find({ $or: accountConditions })
            .select({ _id: 1, id: 1, legacy_id: 1, sl_no: 1, account_name: 1 })
            .lean()
        : [],
      consigneeConditions.length
        ? ConsigneeName.find({ $or: consigneeConditions })
            .select({ _id: 1, id: 1, legacy_id: 1, sl_no: 1, name: 1 })
            .lean()
        : [],
    ]);
    const accountMap = buildAliasMap(accounts);
    const consigneeMap = buildAliasMap(consignees);

    const adjustmentEntries = adjustments.map((row) => {
      const outward = outwardMap.get(String(row?.outward_id ?? "").trim());
      const account = outward
        ? accountMap.get(String(outward.company_account_id ?? "").trim())
        : null;
      const consignee = outward
        ? consigneeMap.get(String(outward.consignee_id ?? "").trim())
        : null;
      return {
        id: row?._id ? String(row._id) : "",
        type: "Adjustment",
        quantity: Number(row?.qty ?? row?.quantity ?? 0) || 0,
        date: outward?.date || outward?.outward_date || null,
        reference: outward?.voucher_no || row?.outward_id || "-",
        account: outward?.company_account_name || account?.account_name || "-",
        consignee: outward?.consignee_name || consignee?.name || "-",
        warehouse: outward?.warehouse_name || "",
        product: outward?.product_name || "",
        lorry: outward?.lorry_no || "",
        location: outward?.location_name || outward?.location || "",
        outward_quantity: Number(outward?.quantity || outward?.weight || 0) || 0,
        source_type: row?.source_type || "inward",
      };
    });

    const journalConditions = buildReferenceConditions("inward_id", inwardIds);
    const journalRows = journalConditions.length
      ? await db.collection("stock_journals")
          .find({ $or: journalConditions })
          .sort({ date: 1, created_at: 1, _id: 1 })
          .toArray()
      : [];
    const journalEntries = journalRows
      .filter((row) => !row.warehouse_id || canAccessWarehouse(req.user, row.warehouse_id))
      .map((row) => ({
        id: row?._id ? String(row._id) : "",
        type: "Stock Journal",
        quantity: Number(row?.qty || 0) || 0,
        date: row?.date || row?.created_at || null,
        reference: row?.journal_no || row?.outward_voucher_no || row?.outward_id || "-",
        account: row?.to_party_name || "-",
        consignee: row?.consignee_name || "-",
        warehouse: row?.warehouse_name || inward.warehouse_name || "",
        product: row?.product_name || inward.product_name || "",
        lorry: row?.lorry_no || inward.lorry_no || "",
        location: row?.location_name || "",
        outward_quantity: null,
        source_type: "journal",
      }));

    return res.json({ entries: [...adjustmentEntries, ...journalEntries] });
  } catch (error) {
    console.error("Party stock adjustment details failed:", error);
    return res.status(500).json({ error: error.message || "Failed to load adjustment details" });
  }
});

router.get("/warehouse-stock", authorizeReport("report.partyStock"), async (req, res) => {
  try {
    const rows = await loadInwards(req.query, {
      _id: 1,
      warehouse_id: 1, warehouse_name: 1,
      company_id: 1, company_name: 1, company: 1,
      location_id: 1, location_name: 1, location: 1,
      weight: 1, quantity: 1, remaining_qty: 1, adjusted_qty: 1,
    });
    return res.json(buildWarehouseStockSummary(rows, availableQty));
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

router.get("/total-stock", authorizeReport("report.partyStock"), async (req, res) => {
  try {
    const rows = await loadInwards(req.query, {
      weight: 1, quantity: 1, remaining_qty: 1, adjusted_qty: 1,
    });
    return res.json({ total: buildTotalStock(rows, availableQty) });
  }
  catch (error) { return res.status(500).json({ error: error.message }); }
});

router.get("/warehouse-rent-ledger", authorizeReport("report.warehouseRentLedger"), async (req, res) => {
  try {
    const data = (await loadInwards(req.query, {
      _id: 1, date: 1, company_name: 1, company: 1, warehouse_name: 1, voucher_no: 1,
      weight: 1, quantity: 1, remaining_qty: 1, adjusted_qty: 1,
    })).map((row) => ({ id: row._id, inward_date: row.date, party_name: row.company_name || row.company, warehouse_name: row.warehouse_name, voucher_no: row.voucher_no, original_weight: Number(row.weight || 0), balance_qty: Number(availableQty(row).toFixed(4)) }));
    return res.json(req.query.page || req.query.page_size ? { data, pagination: { page: Number(req.query.page) || 1, pageSize: Number(req.query.page_size) || data.length, totalCount: data.length, totalPages: data.length ? 1 : 0 } } : data);
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

router.get("/warehouse-rent-month-end", authorizeReport("report.warehouseRentMonthEnd"), async (req, res) => {
  try {
    const month = req.query.month || req.query.from_month;
    if (String(req.query.summary_only || "") === "1") {
      return res.json({ month, summary: [], details: [] });
    }
    const details = await loadInwards(req.query);
    return res.json({ month, summary: [], details });
  }
  catch (error) { return res.status(500).json({ error: error.message }); }
});

function reportIdAliases(row) {
  return [
    row?._id != null ? String(row._id) : null,
    row?.legacy_id != null ? String(row.legacy_id) : null,
    row?.id != null ? String(row.id) : null,
    row?.sl_no != null ? String(row.sl_no) : null,
  ].filter(Boolean);
}

function buildReportMasterMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    for (const alias of reportIdAliases(row)) map.set(alias, row);
  }
  return map;
}

function reportPaltiQty(row) {
  const balance = Number(row?.balance || 0);
  if (Number.isFinite(balance) && balance > 0) return balance;
  const weight = Number(row?.new_weight || 0);
  return Number.isFinite(weight) ? weight : 0;
}

router.get("/palti-lorry-adjustment", authorizeReport("report.paltiLorryAdjustment"), async (req, res) => {
  try {
    if (!isMongoMirrorReady() || !mongoose.connection.db) {
      return res.status(503).json({ error: "MongoDB is not connected" });
    }

    const db = mongoose.connection.db;
    const from = req.query.from_date ? new Date(`${req.query.from_date}T00:00:00`) : null;
    const to = req.query.to_date ? new Date(`${req.query.to_date}T23:59:59.999`) : null;
    const companyFilter = String(req.query.company_id || "").trim();
    const warehouseFilter = String(req.query.warehouse_id || "").trim();

    // Load Palti entries themselves, not only adjustment rows. This report must
    // still show Palti balance even when a Palti entry has not been adjusted yet.
    const paltiRows = await db.collection("paltilorryentries").find({}, {
      projection: {
        _id: 1, legacy_id: 1, id: 1, sl_no: 1, voucher_no: 1,
        expense_date: 1, date: 1, company_id: 1, warehouse_id: 1, product_id: 1,
        reg_from_consignee_id: 1, reg_from_company_id: 1, warehouse_name: 1, product_name: 1,
        company_name: 1, reg_from_name: 1, reg_lorry_no: 1, new_lorry_no: 1, new_weight: 1, balance: 1,
      },
    }).sort({ expense_date: 1, _id: 1 }).toArray();
    const adjustments = await db.collection("adjustments")
      .find({ source_type: "palti_lorry" }, {
        projection: { _id: 1, palti_lorry_id: 1, outward_id: 1, qty: 1, created_at: 1, updated_at: 1 },
      })
      .sort({ created_at: 1, _id: 1 })
      .toArray();

    const outwardIds = Array.from(new Set(
      adjustments.map((row) => String(row?.outward_id ?? "").trim()).filter(Boolean)
    ));
    const outwardConditions = outwardIds.flatMap((value) => {
      const conditions = [{ id: value }, { legacy_id: value }, { sl_no: value }];
      if (mongoose.Types.ObjectId.isValid(value)) conditions.push({ _id: new mongoose.Types.ObjectId(value) });
      const n = Number(value);
      if (Number.isFinite(n)) conditions.push({ id: n }, { legacy_id: n }, { sl_no: n });
      return conditions;
    });

    const [outwardRows, warehouses, products, companies, consignees] = await Promise.all([
      outwardConditions.length ? Outward.find({ $or: outwardConditions }).lean() : [],
      Warehouse.find({}).lean(),
      Product.find({}).lean(),
      Company.find({}).lean(),
      ConsigneeName.find({}).lean(),
    ]);

    const paltiMap = buildReportMasterMap(paltiRows);
    const outwardMap = buildReportMasterMap(outwardRows);
    const warehouseMap = buildReportMasterMap(warehouses);
    const productMap = buildReportMasterMap(products);
    const companyMap = buildReportMasterMap(companies);
    const consigneeMap = buildReportMasterMap(consignees);

    const adjustmentsByPalti = new Map();
    for (const row of adjustments) {
      const key = String(row?.palti_lorry_id ?? "").trim();
      if (!key) continue;
      if (!adjustmentsByPalti.has(key)) adjustmentsByPalti.set(key, []);
      adjustmentsByPalti.get(key).push(row);
    }

    const reportRows = [];
    const includedPaltiKeys = new Set();

    for (const palti of paltiRows) {
      const paltiDate = palti.expense_date || palti.date || null;
      const paltiDateObj = paltiDate ? new Date(paltiDate) : null;
      if (from && (!paltiDateObj || paltiDateObj < from)) continue;
      if (to && (!paltiDateObj || paltiDateObj > to)) continue;

      const companyId = String(palti.company_id ?? "").trim();
      const warehouseId = String(palti.warehouse_id ?? "").trim();
      if (companyFilter && !reportIdAliases({ id: companyId }).includes(companyFilter)) continue;
      if (warehouseFilter && !reportIdAliases({ id: warehouseId }).includes(warehouseFilter)) continue;

      const paltiKey = String(palti.legacy_id ?? palti.id ?? palti.sl_no ?? palti._id ?? "").trim();
      if (!paltiKey) continue;
      includedPaltiKeys.add(paltiKey);

      const company = companyMap.get(companyId) || {};
      const warehouse = warehouseMap.get(warehouseId) || {};
      const product = productMap.get(String(palti.product_id ?? "").trim()) || {};
      const regFromConsignee = consigneeMap.get(String(palti.reg_from_consignee_id ?? "").trim()) || {};
      const regFromCompany = companyMap.get(String(palti.reg_from_company_id ?? "").trim()) || {};
      const paltiBalance = Number(reportPaltiQty(palti).toFixed(4));
      const paltiAdjustments = adjustmentsByPalti.get(paltiKey) || [];
      const totalAdjusted = Number(paltiAdjustments.reduce((sum, row) => sum + Number(row?.qty || 0), 0).toFixed(4));
      const availableBalance = Number(Math.max(paltiBalance - totalAdjusted, 0).toFixed(4));

      const base = {
        palti_id: palti.legacy_id ?? palti.id ?? palti.sl_no ?? (palti._id ? String(palti._id) : null),
        palti_voucher_no: palti.voucher_no || null,
        palti_date: paltiDate,
        warehouse_name: palti.warehouse_name || warehouse.name || "",
        product_name: palti.product_name || product.name || "",
        company_name: palti.company_name || company.name || "",
        reg_from_name: palti.reg_from_name || regFromConsignee.name || regFromCompany.name || "",
        reg_lorry_no: palti.reg_lorry_no || "",
        display_lorry_no: palti.new_lorry_no || palti.reg_lorry_no || "-",
        new_lorry_no: palti.new_lorry_no || "",
        new_weight: Number(palti.new_weight || 0),
        palti_balance: paltiBalance,
        total_adjusted_qty: totalAdjusted,
        available_balance: availableBalance,
      };

      if (!paltiAdjustments.length) {
        reportRows.push({
          ...base,
          outward_voucher_no: "-",
          outward_date: null,
          outward_party_name: "-",
          outward_lorry_no: "-",
          adjusted_qty: 0,
          adjusted_at: null,
        });
        continue;
      }

      for (const adjustment of paltiAdjustments) {
        const outward = outwardMap.get(String(adjustment.outward_id ?? "").trim()) || {};
        reportRows.push({
          ...base,
          adjustment_id: adjustment?._id ? String(adjustment._id) : null,
          outward_voucher_no: outward.outward_no || outward.outward_voucher_no || outward.voucher_no || outward.inv_no || "-",
          outward_date: outward.date || null,
          outward_party_name: outward.company_name || outward.buyer_name || outward.buyer || "-",
          outward_lorry_no: outward.lorry_no || outward.reg_lorry_no || outward.new_lorry_no || "-",
          adjusted_qty: Number(Number(adjustment.qty || 0).toFixed(4)),
          adjusted_at: adjustment.created_at || adjustment.updated_at || null,
        });
      }
    }

    const uniquePalti = new Map();
    for (const row of reportRows) uniquePalti.set(String(row.palti_id), row);

    const summary = {
      total_palti_entries: uniquePalti.size,
      total_palti_balance: Number([...uniquePalti.values()].reduce((sum, row) => sum + row.palti_balance, 0).toFixed(4)),
      total_adjusted_qty: Number([...uniquePalti.values()].reduce((sum, row) => sum + row.total_adjusted_qty, 0).toFixed(4)),
      total_available_balance: Number([...uniquePalti.values()].reduce((sum, row) => sum + row.available_balance, 0).toFixed(4)),
      total_adjustment_rows: reportRows.filter((row) => Number(row.adjusted_qty || 0) > 0).length,
      total_adjusted_dispatched: Number(reportRows.reduce((sum, row) => sum + Number(row.adjusted_qty || 0), 0).toFixed(4)),
    };

    return res.json({ summary, details: reportRows });
  } catch (error) {
    console.error("[palti-lorry-adjustment report] error:", error);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
