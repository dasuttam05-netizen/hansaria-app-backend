const express = require("express");
const router = express.Router();
const { userHasPermission } = require("../middleware/auth");
const { calculateShortageQty } = require("./shortageHelper");
const {
  mongoose,
  Inward,
  Outward,
  Warehouse,
  Product,
  Company,
  ConsigneeName,
  isMongoMirrorReady,
} = require("../db-mongodb");

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

async function loadInwards(query) {
  const filter = dateFilter(query);
  ["company_id", "warehouse_id", "product_id", "location_id", "employee_id", "company_account_id"].forEach((field) => {
    addIdFilter(filter, field, query[field] || query[`${field}s`]);
  });
  return Inward.find(filter).sort({ date: 1, _id: 1 }).lean();
}

function availableQty(row) {
  const gross = Number(row.weight || row.quantity || 0);
  const shortage = calculateShortageQty(gross, 1, row.shortage_percent);
  return gross - shortage - Number(row.adjusted_qty || 0);
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
    const rows = (await loadInwards(req.query)).map((row) => ({ ...row, available_balance_qty: availableQty(row) }));
    const summary = summaryBy(rows, (row) => `${row.company_name || row.company || "Unknown"}::${row.warehouse_name || row.warehouse_id || "Unknown"}`, (row) => ({
      party_name: row.company_name || row.company || "Unknown Party",
      warehouse_name: row.warehouse_name || "Unknown",
      available_balance_qty: Number(row.available_balance_qty || 0),
    }));
    return res.json({ summary, details: rows });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

router.get("/warehouse-stock", authorizeReport("report.partyStock"), async (req, res) => {
  try {
    const rows = (await loadInwards(req.query)).map((row) => ({ ...row, stock: availableQty(row) }));
    return res.json(summaryBy(rows, (row) => `${row.warehouse_name || row.warehouse_id || "Unknown"}::${row.company_name || row.company || "Unknown"}::${row.location_name || row.location_id || "Unknown"}`, (row) => ({
      warehouse: row.warehouse_name || "Unknown", party: row.company_name || row.company || "Unknown", location: row.location_name || "Unknown", stock: Number(row.stock || 0),
    })));
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

router.get("/total-stock", authorizeReport("report.partyStock"), async (req, res) => {
  try { const rows = await loadInwards(req.query); return res.json({ total: Number(rows.reduce((sum, row) => sum + availableQty(row), 0).toFixed(4)) }); }
  catch (error) { return res.status(500).json({ error: error.message }); }
});

router.get("/warehouse-rent-ledger", authorizeReport("report.warehouseRentLedger"), async (req, res) => {
  try {
    const data = (await loadInwards(req.query)).map((row) => ({ id: row._id, inward_date: row.date, party_name: row.company_name || row.company, warehouse_name: row.warehouse_name, voucher_no: row.voucher_no, original_weight: Number(row.weight || 0), balance_qty: Number(availableQty(row).toFixed(4)) }));
    return res.json(req.query.page || req.query.page_size ? { data, pagination: { page: Number(req.query.page) || 1, pageSize: Number(req.query.page_size) || data.length, totalCount: data.length, totalPages: data.length ? 1 : 0 } } : data);
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

router.get("/warehouse-rent-month-end", authorizeReport("report.warehouseRentMonthEnd"), async (req, res) => {
  try { const details = await loadInwards(req.query); return res.json({ month: req.query.month || req.query.from_month, summary: [], details }); }
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
    const adjustments = await db.collection("adjustments").find({
      source_type: "palti_lorry",
    }).sort({ created_at: 1, _id: 1 }).toArray();

    if (!adjustments.length) {
      return res.json({
        summary: {
          total_palti_entries: 0,
          total_palti_balance: 0,
          total_adjusted_qty: 0,
          total_available_balance: 0,
          total_adjustment_rows: 0,
          total_adjusted_dispatched: 0,
        },
        details: [],
      });
    }

    const paltiIds = Array.from(new Set(
      adjustments.map((row) => String(row?.palti_lorry_id ?? "").trim()).filter(Boolean)
    ));
    const outwardIds = Array.from(new Set(
      adjustments.map((row) => String(row?.outward_id ?? "").trim()).filter(Boolean)
    ));

    const paltiConditions = paltiIds.flatMap((value) => {
      const conditions = [{ id: value }, { legacy_id: value }, { sl_no: value }];
      if (mongoose.Types.ObjectId.isValid(value)) conditions.push({ _id: new mongoose.Types.ObjectId(value) });
      const n = Number(value);
      if (Number.isFinite(n)) {
        conditions.push({ id: n }, { legacy_id: n }, { sl_no: n });
      }
      return conditions;
    });

    const outwardConditions = outwardIds.flatMap((value) => {
      const conditions = [{ id: value }, { legacy_id: value }, { sl_no: value }];
      if (mongoose.Types.ObjectId.isValid(value)) conditions.push({ _id: new mongoose.Types.ObjectId(value) });
      const n = Number(value);
      if (Number.isFinite(n)) conditions.push({ id: n }, { legacy_id: n }, { sl_no: n });
      return conditions;
    });

    const [paltiRows, outwardRows, warehouses, products, companies, consignees] = await Promise.all([
      db.collection("paltilorryentries").find(paltiConditions.length ? { $or: paltiConditions } : {}).toArray(),
      Outward.find(outwardConditions.length ? { $or: outwardConditions } : {}).lean(),
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

    const from = req.query.from_date ? new Date(`${req.query.from_date}T00:00:00`) : null;
    const to = req.query.to_date ? new Date(`${req.query.to_date}T23:59:59.999`) : null;
    const companyFilter = String(req.query.company_id || "").trim();
    const warehouseFilter = String(req.query.warehouse_id || "").trim();

    const adjustedByPalti = new Map();
    for (const row of adjustments) {
      const key = String(row?.palti_lorry_id ?? "").trim();
      if (!key) continue;
      adjustedByPalti.set(key, (adjustedByPalti.get(key) || 0) + Number(row?.qty || 0));
    }

    const details = [];
    for (const adjustment of adjustments) {
      const paltiKey = String(adjustment?.palti_lorry_id ?? "").trim();
      const palti = paltiMap.get(paltiKey);
      if (!palti) continue;

      const paltiDate = palti.expense_date || palti.date || null;
      const paltiDateObj = paltiDate ? new Date(paltiDate) : null;
      if (from && (!paltiDateObj || paltiDateObj < from)) continue;
      if (to && (!paltiDateObj || paltiDateObj > to)) continue;

      const companyId = String(palti.company_id ?? adjustment.company_id ?? "").trim();
      const warehouseId = String(palti.warehouse_id ?? "").trim();
      if (companyFilter && !reportIdAliases({ id: companyId }).includes(companyFilter)) continue;
      if (warehouseFilter && !reportIdAliases({ id: warehouseId }).includes(warehouseFilter)) continue;

      const company = companyMap.get(companyId) || {};
      const warehouse = warehouseMap.get(warehouseId) || {};
      const product = productMap.get(String(palti.product_id ?? "").trim()) || {};
      const regFromConsignee = consigneeMap.get(String(palti.reg_from_consignee_id ?? "").trim()) || {};
      const regFromCompany = companyMap.get(String(palti.reg_from_company_id ?? "").trim()) || {};
      const outward = outwardMap.get(String(adjustment.outward_id ?? "").trim()) || {};

      const totalAdjusted = Number((adjustedByPalti.get(paltiKey) || 0).toFixed(4));
      const paltiBalance = Number(reportPaltiQty(palti).toFixed(4));
      const availableBalance = Number(Math.max(paltiBalance - totalAdjusted, 0).toFixed(4));
      const adjustedQty = Number(Number(adjustment.qty || 0).toFixed(4));

      details.push({
        adjustment_id: adjustment?._id ? String(adjustment._id) : null,
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
        outward_voucher_no: outward.outward_no || outward.outward_voucher_no || outward.voucher_no || outward.inv_no || "-",
        outward_date: outward.date || null,
        outward_party_name: outward.company_name || outward.buyer_name || outward.buyer || "-",
        outward_lorry_no: outward.lorry_no || outward.reg_lorry_no || outward.new_lorry_no || "-",
        adjusted_qty: adjustedQty,
        adjusted_at: adjustment.created_at || adjustment.updated_at || null,
      });
    }

    const uniquePalti = new Map();
    for (const row of details) uniquePalti.set(String(row.palti_id), row);

    const summary = {
      total_palti_entries: uniquePalti.size,
      total_palti_balance: Number(details.reduce((sum, row) => sum + row.palti_balance, 0).toFixed(4)),
      total_adjusted_qty: Number(details.reduce((sum, row) => sum + row.total_adjusted_qty, 0).toFixed(4)),
      total_available_balance: Number(details.reduce((sum, row) => sum + row.available_balance, 0).toFixed(4)),
      total_adjustment_rows: details.length,
      total_adjusted_dispatched: Number(details.reduce((sum, row) => sum + row.adjusted_qty, 0).toFixed(4)),
    };

    return res.json({ summary, details });
  } catch (error) {
    console.error("[palti-lorry-adjustment report] error:", error);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
