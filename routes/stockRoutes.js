const express = require("express");
const router = express.Router();
const db = require("../db");

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

function getAvailableQty(weight, inwardDate, alreadyAdjusted) {
  const slab = calculateMonthSlab(inwardDate, new Date().toISOString());
  const grossQty = Number(weight) || 0;
  const shortageQty = grossQty * 0.02 * slab.monthsDiff;
  return grossQty - shortageQty - Number(alreadyAdjusted || 0);
}

router.get("/party-stock", (req, res) => {
  const sql = `
    SELECT
      i.id,
      COALESCE(c.name, ca.account_name, 'Unknown') AS party,
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
      const availableQty = getAvailableQty(row.weight, row.inward_date, row.already_adjusted);
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
      i.weight,
      i.date AS inward_date,
      IFNULL((
        SELECT SUM(a.qty)
        FROM adjustment a
        WHERE a.inward_id = i.id
      ), 0) AS already_adjusted
    FROM inward i
    LEFT JOIN warehouses w ON w.id = i.warehouse_id
    WHERE i.warehouse_id IS NOT NULL
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("Warehouse stock error:", err.message);
      return res.status(500).json({ error: err.message });
    }

    const warehouseMap = {};
    rows.forEach((row) => {
      const availableQty = getAvailableQty(row.weight, row.inward_date, row.already_adjusted);
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
