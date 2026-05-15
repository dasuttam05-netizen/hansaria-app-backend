const express = require("express");
const router = express.Router();
const db = require("../db");
const { userHasPermission } = require("../middleware/auth");
const { assignedWarehouseFilter, canAccessWarehouse } = require("../helpers/access");

function canManageWarehouseTrading(user) {
  return userHasPermission(user, "warehouse.trading.manage");
}

function canViewWarehouseTrading(user) {
  return userHasPermission(user, "warehouse.trading.view") || canManageWarehouseTrading(user);
}

router.get("/", (req, res) => {
  if (!canViewWarehouseTrading(req.user)) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const filter = assignedWarehouseFilter(req.user, "warehouse_id");
  const query = `
    SELECT id, date, warehouse_id, farmer_id, product_id, transaction_type, quantity, amount, description, created_at
    FROM warehouse_trading_entries
    WHERE 1 = 1 ${filter.clause}
    ORDER BY created_at DESC
  `;

  db.all(query, filter.params, (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

router.post("/", (req, res) => {
  if (!canManageWarehouseTrading(req.user)) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const {
    date,
    warehouse_id,
    farmer_id,
    product_id,
    transaction_type,
    quantity,
    amount,
    description,
  } = req.body;

  if (!date || !transaction_type || !warehouse_id) {
    return res.status(400).json({ error: "Date, Warehouse, and Transaction Type are required" });
  }

  if (!canAccessWarehouse(req.user, warehouse_id)) {
    return res.status(403).json({ error: "You do not have access to this warehouse" });
  }

  const insertQuery = `
    INSERT INTO warehouse_trading_entries (
      date,
      warehouse_id,
      farmer_id,
      product_id,
      transaction_type,
      quantity,
      amount,
      description
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(
    insertQuery,
    [
      date,
      warehouse_id || null,
      farmer_id || null,
      product_id || null,
      transaction_type,
      quantity || 0,
      amount || 0,
      description || null,
    ],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID });
    }
  );
});

module.exports = router;
