const express = require("express");
const router = express.Router();
const db = require("../db");
const { calculateShortageQty } = require("./shortageHelper");

function calculateMonthSlab(inwardDateStr, currentDateStr) {
  const inwardDate = new Date(inwardDateStr);
  const currentDate = new Date(currentDateStr);
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysDiff = Math.floor((currentDate - inwardDate) / msPerDay);
  let monthsDiff = Math.floor(daysDiff / 30) + 1;
  if (monthsDiff < 1) monthsDiff = 1;
  return {
    daysDiff: daysDiff < 0 ? 0 : daysDiff,
    monthsDiff,
  };
}

function getAvailableQty(weight, inwardDate, alreadyAdjusted, shortagePercent = null) {
  const slab = calculateMonthSlab(inwardDate, new Date().toISOString());
  const grossQty = Number(weight) || 0;
  const shortageQty = calculateShortageQty(grossQty, slab.monthsDiff, shortagePercent);
  return grossQty - shortageQty - Number(alreadyAdjusted || 0);
}

router.get("/party-stock", (req, res) => {
  const sql = `
    SELECT
      i.id,
      COALESCE(c.name, ca.account_name, 'Unknown') AS party,
      COALESCE(i.shortage_percent, c.shortage_percent, ca.shortage_percent) AS shortage_percent,
      i.weight,
      i.date AS inward_date,
      IFNULL((
        SELECT SUM(a.qty)
        FROM adjustment a
        WHERE a.inward_id = i.id
      ), 0) AS already_adjusted
    FROM inward i
    LEFT JOIN companies c ON c.id = i.company_id
    LEFT JOIN company_accounts ca ON ca.id = i.company_account_id
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("Party stock error:", err.message);
      return res.status(500).json({ error: err.message });
    }

    const companyMap = {};
    rows.forEach((row) => {
      const availableQty = getAvailableQty(row.weight, row.inward_date, row.already_adjusted, row.shortage_percent);
      const partyName = row.party || "Unknown";

      if (!companyMap[partyName]) {
        companyMap[partyName] = {
          party: partyName,
          stock: 0,
        };
      }

      companyMap[partyName].stock += availableQty;
    });

    const result = Object.values(companyMap).map((item) => ({
      party: item.party,
      stock: Number(item.stock.toFixed(4)),
    }));

    result.sort((a, b) => a.party.localeCompare(b.party));
    res.json(result);
  });
});

router.get("/warehouse-stock", (req, res) => {
  const sql = `
    SELECT
      i.id,
      i.warehouse_id,
      COALESCE(w.name, 'Unknown') AS warehouse,
      COALESCE(i.shortage_percent, c.shortage_percent, ca.shortage_percent) AS shortage_percent,
      i.weight,
      i.date AS inward_date,
      IFNULL((
        SELECT SUM(a.qty)
        FROM adjustment a
        WHERE a.inward_id = i.id
      ), 0) AS already_adjusted
    FROM inward i
    LEFT JOIN warehouses w ON w.id = i.warehouse_id
    LEFT JOIN companies c ON c.id = i.company_id
    LEFT JOIN company_accounts ca ON ca.id = i.company_account_id
    WHERE i.warehouse_id IS NOT NULL
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("Warehouse stock error:", err.message);
      return res.status(500).json({ error: err.message });
    }

    const warehouseMap = {};
    rows.forEach((row) => {
      const availableQty = getAvailableQty(row.weight, row.inward_date, row.already_adjusted, row.shortage_percent);
      const warehouseName = row.warehouse || "Unknown";

      if (!warehouseMap[warehouseName]) {
        warehouseMap[warehouseName] = {
          warehouse: warehouseName,
          stock: 0,
        };
      }

      warehouseMap[warehouseName].stock += availableQty;
    });

    const result = Object.values(warehouseMap).map((item) => ({
      warehouse: item.warehouse,
      stock: Number(item.stock.toFixed(4)),
    }));

    result.sort((a, b) => a.warehouse.localeCompare(b.warehouse));
    res.json(result);
  });
});

router.get("/total-stock", (req, res) => {
  const sql = `
    SELECT
      i.weight,
      i.date AS inward_date,
      IFNULL((
        SELECT SUM(a.qty)
        FROM adjustment a
        WHERE a.inward_id = i.id
      ), 0) AS already_adjusted
    FROM inward i
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("Total stock error:", err.message);
      return res.status(500).json({ error: err.message });
    }

    const total = rows.reduce((sum, row) => {
      return sum + getAvailableQty(row.weight, row.inward_date, row.already_adjusted);
    }, 0);

    res.json({ total: Number(total.toFixed(4)) });
  });
});

module.exports = router;

// FIFO-based stock with average purchase rate
router.get("/fifo-stock", (req, res) => {
  const { product_id, warehouse_id } = req.query;
  if (!product_id) return res.status(400).json({ error: "product_id is required" });

  const params = [product_id];
  let inwardSql = `
    SELECT
      i.id,
      i.date AS inward_date,
      i.weight,
      IFNULL((SELECT SUM(a.qty) FROM adjustment a WHERE a.inward_id = i.id), 0) AS already_adjusted,
      i.warehouse_id
    FROM inward i
    WHERE i.product_id = ?
  `;

  if (warehouse_id) {
    inwardSql += " AND i.warehouse_id = ?";
    params.push(warehouse_id);
  }

  inwardSql += " ORDER BY i.date ASC, i.id ASC";

  db.all(inwardSql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const batches = rows.map((r) => {
      const avail = getAvailableQty(r.weight, r.inward_date, r.already_adjusted);
      return {
        inward_id: r.id,
        warehouse_id: r.warehouse_id,
        inward_date: r.inward_date,
        gross_qty: Number(r.weight || 0),
        already_adjusted: Number(r.already_adjusted || 0),
        available_qty: Number(avail.toFixed(4)),
      };
    }).filter(b => b.available_qty > 0);

    // compute average purchase rate from wh_purchase_vouchers
    const prParams = [product_id];
    let prSql = `SELECT COALESCE(SUM(quantity * rate),0) as tot_amt, COALESCE(SUM(quantity),0) as tot_qty FROM wh_purchase_vouchers WHERE product_id = ?`;
    if (warehouse_id) {
      prSql += " AND warehouse_id = ?";
      prParams.push(warehouse_id);
    }

    db.get(prSql, prParams, (err2, prRow) => {
      if (err2) return res.status(500).json({ error: err2.message });
      const totAmt = prRow?.tot_amt || 0;
      const totQty = prRow?.tot_qty || 0;
      const avg_rate = totQty > 0 ? Number((totAmt / totQty).toFixed(4)) : 0;

      res.json({ batches, avg_rate });
    });
  });
});
