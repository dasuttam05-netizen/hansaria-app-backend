const express = require("express");
const router = express.Router();
const db = require("../db");
const { userHasPermission } = require("../middleware/auth");
const { canAccessWarehouse, assignedWarehouseFilter } = require("../helpers/access");

function formatVoucher(slNo) {
  return `INV${String(slNo).padStart(3, "0")}`;
}

router.get("/", (req, res) => {
  if (!userHasPermission(req.user, "inward.view")) {
    return res.status(403).json({ error: "You do not have permission to view inward entries" });
  }

  const warehouseScope = assignedWarehouseFilter(req.user, "i.warehouse_id");
  const sql = `
    SELECT i.*,
      l.name AS location_name,
      e.name AS employee_name,
      p.name AS product_name,
      w.name AS warehouse_name,
      c.name AS company_name,
      ca.account_name AS company_account_name
    FROM inward i
    LEFT JOIN locations l ON i.location_id = l.id
    LEFT JOIN employees e ON i.employee_id = e.id
    LEFT JOIN products p ON i.product_id = p.id
    LEFT JOIN warehouses w ON i.warehouse_id = w.id
    LEFT JOIN companies c ON i.company_id = c.id
    LEFT JOIN company_accounts ca ON i.company_account_id = ca.id
    WHERE 1=1
    ${warehouseScope.clause}
    ORDER BY i.id DESC
  `;

  db.all(sql, warehouseScope.params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    return res.json(rows);
  });
});

router.post("/", (req, res) => {
  if (!userHasPermission(req.user, "inward.create")) {
    return res.status(403).json({ error: "You do not have permission to create inward entries" });
  }

  const {
    date,
    employee_id,
    location_id,
    warehouse_id,
    product_id,
    company_id,
    company_account_id,
    lorry_no,
    weight,
  } = req.body;

  if (!date) {
    return res.status(400).json({ error: "Date is required" });
  }

  if (!canAccessWarehouse(req.user, warehouse_id)) {
    return res.status(403).json({ error: "You can only create entries for your assigned warehouse" });
  }

  const w = Number(weight) || 0;

  db.get(`SELECT MAX(sl_no) as max_sl FROM inward`, [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    const nextSl = row?.max_sl ? row.max_sl + 1 : 1;
    const voucher_no = formatVoucher(nextSl);

    const sql = `
      INSERT INTO inward
      (sl_no, voucher_no, date, employee_id, location_id, warehouse_id, product_id, company_id, company_account_id, lorry_no, weight, remaining_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(
      sql,
      [
        nextSl,
        voucher_no,
        date,
        employee_id || null,
        location_id || null,
        warehouse_id || null,
        product_id || null,
        company_id || null,
        company_account_id || null,
        lorry_no || null,
        w,
        w,
      ],
      function onInsert(insertErr) {
        if (insertErr) {
          return res.status(500).json({ error: insertErr.message });
        }

        return res.json({
          id: this.lastID,
          sl_no: nextSl,
          voucher_no,
        });
      }
    );
  });
});

router.put("/:id", (req, res) => {
  if (!userHasPermission(req.user, "inward.edit")) {
    return res.status(403).json({ error: "You do not have permission to edit inward entries" });
  }

  const { id } = req.params;
  const {
    date,
    employee_id,
    location_id,
    warehouse_id,
    product_id,
    company_id,
    company_account_id,
    lorry_no,
    weight,
  } = req.body;

  const w = Number(weight) || 0;

  db.get(`SELECT warehouse_id FROM inward WHERE id = ?`, [id], (findErr, inwardRow) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!inwardRow) return res.status(404).json({ error: "Inward not found" });

    if (!canAccessWarehouse(req.user, inwardRow.warehouse_id) || !canAccessWarehouse(req.user, warehouse_id)) {
      return res.status(403).json({ error: "You can only edit entries for your assigned warehouse" });
    }

    const sql = `
      UPDATE inward SET
        date=?, employee_id=?, location_id=?, warehouse_id=?, product_id=?, company_id=?, company_account_id=?, lorry_no=?, weight=?, remaining_qty=?
      WHERE id=?
    `;

    db.run(
      sql,
      [
        date,
        employee_id || null,
        location_id || null,
        warehouse_id || null,
        product_id || null,
        company_id || null,
        company_account_id || null,
        lorry_no || null,
        w,
        w,
        id,
      ],
      function onUpdate(updateErr) {
        if (updateErr) {
          return res.status(500).json({ error: updateErr.message });
        }

        return res.json({ updated: this.changes });
      }
    );
  });
});

router.delete("/:id", (req, res) => {
  if (!userHasPermission(req.user, "inward.delete")) {
    return res.status(403).json({ error: "You do not have permission to delete inward entries" });
  }

  const { id } = req.params;
  db.get(`SELECT warehouse_id FROM inward WHERE id = ?`, [id], (findErr, inwardRow) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!inwardRow) return res.status(404).json({ error: "Inward not found" });

    if (!canAccessWarehouse(req.user, inwardRow.warehouse_id)) {
      return res.status(403).json({ error: "You can only delete entries for your assigned warehouse" });
    }

    db.run(`DELETE FROM inward WHERE id=?`, [id], function onDelete(deleteErr) {
      if (deleteErr) return res.status(500).json({ error: deleteErr.message });
      return res.json({ deleted: this.changes });
    });
  });
});

router.get("/report", (req, res) => {
  if (!userHasPermission(req.user, "reports.view") && !userHasPermission(req.user, "inward.view")) {
    return res.status(403).json({ error: "You do not have permission to view this report" });
  }

  const { company_id, warehouse_id, from_date, to_date } = req.query;
  let sql = `
    SELECT i.id, i.sl_no, i.date, i.voucher_no, i.weight,
           c.name AS company_name,
           w.name AS warehouse_name,
           e.name AS employee_name,
           p.name AS product_name
    FROM inward i
    LEFT JOIN companies c ON i.company_id = c.id
    LEFT JOIN warehouses w ON i.warehouse_id = w.id
    LEFT JOIN employees e ON i.employee_id = e.id
    LEFT JOIN products p ON i.product_id = p.id
    WHERE 1=1
  `;

  const params = [];
  const warehouseScope = assignedWarehouseFilter(req.user, "i.warehouse_id");
  sql += warehouseScope.clause;
  params.push(...warehouseScope.params);

  if (company_id) {
    sql += " AND i.company_id = ?";
    params.push(company_id);
  }
  if (warehouse_id) {
    if (!canAccessWarehouse(req.user, warehouse_id)) {
      return res.status(403).json({ error: "You can only view your assigned warehouse data" });
    }
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

  sql += " ORDER BY i.date DESC";

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    return res.json(rows);
  });
});

module.exports = router;
