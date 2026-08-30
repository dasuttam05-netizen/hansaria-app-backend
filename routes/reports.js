const express = require("express");
const router = express.Router();
const { userHasPermission } = require("../middleware/auth");
const { calculateShortageQty } = require("./shortageHelper");
const { Inward } = require("../db-mongodb");

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

router.get("/palti-lorry-adjustment", authorizeReport("report.paltiLorryAdjustment"), (_req, res) => res.json([]));

module.exports = router;
