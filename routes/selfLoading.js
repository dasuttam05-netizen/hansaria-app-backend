const express = require("express");
const router = express.Router();
const db = require("../db");
const { assignedWarehouseFilter } = require("../helpers/access");
const { resolveWarehouseIds } = require("../helpers/sqliteMasterResolver");
const { userHasPermission } = require("../middleware/auth");

router.get("/", async (req, res) => {
  if (!userHasPermission(req.user, "expense.selfLoading")) {
    return res.status(403).json({ error: "You do not have permission to view Self Loading entries" });
  }

  // Self loading outwards can have warehouse_id NULL; we still want them visible.
  // So we scope by assigned warehouses ONLY when warehouse_id is not NULL.
  let warehouseClause = "";
  let params = [];
  const warehouseScope = assignedWarehouseFilter(req.user, "o.warehouse_id");
  const assignedIds = await resolveWarehouseIds(db, warehouseScope.params || []).catch(() => []);
  if (warehouseScope.clause && warehouseScope.clause.includes("1 = 0")) {
    warehouseClause = ` AND o.warehouse_id IS NULL`;
  } else if (assignedIds.length > 0) {
    warehouseClause = ` AND (o.warehouse_id IS NULL OR o.warehouse_id IN (${assignedIds.map(() => "?").join(",")}))`;
    params = [...assignedIds];
  }
  db.all(
    `
    SELECT
      o.*,
      x.id AS expense_id,
      x.voucher_no AS expense_voucher_no,
      w.name AS warehouse_name,
      p.name AS product_name,
      c.name AS company_name,
      ca.account_name AS party_name,
      l.name AS location_name,
      e.name AS employee_name
    FROM outward o
    LEFT JOIN expenses x
      ON x.outward_id = o.id
      AND x.work_description = 'Self Loading'
    LEFT JOIN warehouses w ON o.warehouse_id = w.id
    LEFT JOIN locations l ON l.id = o.location_id
    LEFT JOIN employees e ON e.id = o.employee_id
    LEFT JOIN products p ON p.id = o.product_id
    LEFT JOIN companies c ON c.id = o.company_id
    LEFT JOIN company_accounts ca ON ca.id = o.company_account_id
    WHERE LOWER(COALESCE(o.self_loading, 'No')) = 'yes'
    ${warehouseClause}
    ORDER BY o.id DESC
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
