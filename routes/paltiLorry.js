const express = require("express");
const router = express.Router();
const db = require("../db");
const { assignedWarehouseFilter } = require("../helpers/access");
const { userHasPermission } = require("../middleware/auth");

router.get("/", (req, res) => {
  if (!userHasPermission(req.user, "expense.palti")) {
    return res.status(403).json({ error: "You do not have permission to view Palti Lorry entries" });
  }

  const warehouseFilter = assignedWarehouseFilter(req.user, "p.warehouse_id");
  const params = [...warehouseFilter.params];
  db.all(
    `
    SELECT
      p.*,
      COALESCE(NULLIF(TRIM(p.new_lorry_no), ''), NULLIF(TRIM(p.reg_lorry_no), ''), '-') AS display_lorry_no,
      w.name AS warehouse_name,
      e.name AS employee_name,
      pr.name AS product_name,
      c.name AS company_name,
      COALESCE(cn.name, rc.name) AS reg_from_name
    FROM palti_lorry_entries p
    LEFT JOIN warehouses w ON w.id = p.warehouse_id
    LEFT JOIN employees e ON e.id = p.employee_id
    LEFT JOIN products pr ON pr.id = p.product_id
    LEFT JOIN companies c ON c.id = p.company_id
    LEFT JOIN consignee_names cn ON cn.id = p.reg_from_consignee_id
    LEFT JOIN companies rc ON rc.id = p.reg_from_company_id
    WHERE 1 = 1 ${warehouseFilter.clause}
    ORDER BY p.id DESC
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
