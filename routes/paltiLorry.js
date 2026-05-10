const express = require("express");
const router = express.Router();
const db = require("../db");
const { assignedWarehouseFilter } = require("../helpers/access");
const { userHasPermission } = require("../middleware/auth");

router.get("/", (req, res) => {
  if (!userHasPermission(req.user, "expense.palti")) {
    return res.status(403).json({ error: "You do not have permission to view Palti Lorry entries" });
  }

  const postedWarehouseFilter = assignedWarehouseFilter(req.user, "p.warehouse_id");
  const expenseWarehouseFilter = assignedWarehouseFilter(req.user, "x.warehouse_id");
  const params = [...postedWarehouseFilter.params, ...expenseWarehouseFilter.params];
  db.all(
    `
    SELECT *
    FROM (
      SELECT
        p.*,
        'posted' AS entry_status,
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
      WHERE 1 = 1 ${postedWarehouseFilter.clause}

      UNION ALL

      SELECT
        x.id AS id,
        x.id AS expense_id,
        x.voucher_no,
        x.expense_date,
        x.warehouse_id,
        x.employee_id,
        x.product_id,
        x.company_id,
        x.reg_from_consignee_id,
        x.reg_from_company_id,
        x.reg_lorry_no,
        x.balance,
        x.new_lorry_no,
        x.new_weight,
        NULL AS created_by,
        x.created_at,
        x.updated_at,
        'expense' AS entry_status,
        COALESCE(NULLIF(TRIM(x.new_lorry_no), ''), NULLIF(TRIM(x.reg_lorry_no), ''), '-') AS display_lorry_no,
        w.name AS warehouse_name,
        e.name AS employee_name,
        pr.name AS product_name,
        c.name AS company_name,
        COALESCE(cn.name, rc.name) AS reg_from_name
      FROM expenses x
      LEFT JOIN warehouses w ON w.id = x.warehouse_id
      LEFT JOIN employees e ON e.id = x.employee_id
      LEFT JOIN products pr ON pr.id = x.product_id
      LEFT JOIN companies c ON c.id = x.company_id
      LEFT JOIN consignee_names cn ON cn.id = x.reg_from_consignee_id
      LEFT JOIN companies rc ON rc.id = x.reg_from_company_id
      WHERE (x.send_to_kind = 'palti_lorry' OR LOWER(TRIM(x.work_description)) = 'palti lorry')
        AND NOT EXISTS (
          SELECT 1
          FROM palti_lorry_entries p2
          WHERE p2.expense_id = x.id
        )
        ${expenseWarehouseFilter.clause}
    )
    ORDER BY expense_date DESC, id DESC
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
