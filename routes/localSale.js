const express = require("express");
const router = express.Router();
const db = require("../db");
const { assignedWarehouseFilter } = require("../helpers/access");
const { userHasPermission } = require("../middleware/auth");

router.get("/", (req, res) => {
  if (!userHasPermission(req.user, "expense.localSale")) {
    return res.status(403).json({ error: "You do not have permission to view Local Sale entries" });
  }

  const warehouseFilter = assignedWarehouseFilter(req.user, "e.warehouse_id");
  const params = [...warehouseFilter.params, "Local Sale"];
  db.all(
    `
    SELECT
      e.id,
      e.voucher_no,
      e.expense_date,
      e.location_id,
      e.warehouse_id,
      e.employee_id,
      e.product_id,
      e.company_id,
      e.work_description,
      e.reg_lorry_no,
      e.balance,
      e.status,
      l.name AS location_name,
      w.name AS warehouse_name,
      em.name AS employee_name,
      pr.name AS product_name,
      c.name AS company_name
    FROM expenses e
    LEFT JOIN locations l ON l.id = e.location_id
    LEFT JOIN warehouses w ON w.id = e.warehouse_id
    LEFT JOIN employees em ON em.id = e.employee_id
    LEFT JOIN products pr ON pr.id = e.product_id
    LEFT JOIN companies c ON c.id = e.company_id
    WHERE e.work_description = ? ${warehouseFilter.clause}
    ORDER BY e.expense_date DESC, e.id DESC
    `,
    params,
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      return res.json(rows || []);
    }
  );
});

module.exports = router;
