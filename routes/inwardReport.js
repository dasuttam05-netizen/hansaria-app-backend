// routes/inwardReport.js
const express = require("express");
const router = express.Router();
const db = require("../db");

router.get("/report", (req, res) => {
  const { company_id, warehouse_id, from_date, to_date } = req.query;

  let sql = `
    SELECT i.*, 
      e.name AS employee_name,
      l.name AS location_name,
      w.name AS warehouse_name,
      p.name AS product_name,
      c.name AS company_name,
      ca.account_name AS company_account_name
    FROM inward i
    LEFT JOIN employees e ON i.employee_id = e.id
    LEFT JOIN locations l ON i.location_id = l.id
    LEFT JOIN warehouses w ON i.warehouse_id = w.id
    LEFT JOIN products p ON i.product_id = p.id
    LEFT JOIN companies c ON i.company_id = c.id
    LEFT JOIN company_accounts ca ON i.company_account_id = ca.id
    WHERE 1=1
  `;

  const params = [];
  if (company_id) {
    sql += " AND i.company_id = ?";
    params.push(company_id);
  }
  if (warehouse_id) {
    sql += " AND i.warehouse_id = ?";
    params.push(warehouse_id);
  }
  if (from_date) {
    sql += " AND i.date >= ?";
    params.push(from_date);
  }
  if (to_date) {
    sql += " AND i.date <= ?";
    params.push(to_date);
  }

  sql += " ORDER BY i.date ASC";

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

module.exports = router;
