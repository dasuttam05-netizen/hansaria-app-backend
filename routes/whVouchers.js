const express = require("express");
const router = express.Router();
const db = require("../db");
const { userHasPermission } = require("../middleware/auth");
const { assignedWarehouseFilter, canAccessWarehouse } = require("../helpers/access");

function getWarehouseScopedRows(req, res, tableName, orderBy = "date DESC") {
  const filter = assignedWarehouseFilter(req.user, "warehouse_id");
  const query = `SELECT * FROM ${tableName} WHERE 1 = 1 ${filter.clause} ORDER BY ${orderBy}`;
  db.all(query, filter.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
}

function ensureWarehouseAccess(req, res, warehouseId) {
  if (!warehouseId) {
    res.status(400).json({ error: "Warehouse is required" });
    return false;
  }

  if (!canAccessWarehouse(req.user, warehouseId)) {
    res.status(403).json({ error: "You do not have access to this warehouse" });
    return false;
  }

  return true;
}

// ===========================
// PURCHASE VOUCHERS
// ===========================
router.get("/purchase", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }
  
  getWarehouseScopedRows(req, res, "wh_purchase_vouchers");
});

router.post("/purchase", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { voucher_no, date, warehouse_id, farmer_id, product_id, quantity, rate, amount, employee_id, location_id, description } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  const query = `
    INSERT INTO wh_purchase_vouchers (voucher_no, date, warehouse_id, farmer_id, product_id, quantity, rate, amount, employee_id, location_id, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(query, [voucher_no, date, warehouse_id, farmer_id, product_id, quantity, rate, amount, employee_id, location_id, description], function (err) {
    if (err) {
      if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
      return res.status(500).json({ error: err.message });
    }
    res.json({ id: this.lastID });
  });
});

// ===========================
// SALE VOUCHERS
// ===========================
router.get("/sale", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.sale.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  getWarehouseScopedRows(req, res, "wh_sale_vouchers");
});

router.post("/sale", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.sale.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { voucher_no, date, warehouse_id, company_id, consignee_id, product_id, quantity, rate, amount, employee_id, location_id, description } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  const query = `
    INSERT INTO wh_sale_vouchers (voucher_no, date, warehouse_id, company_id, consignee_id, product_id, quantity, rate, amount, employee_id, location_id, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(query, [voucher_no, date, warehouse_id, company_id, consignee_id, product_id, quantity, rate, amount, employee_id, location_id, description], function (err) {
    if (err) {
      if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
      return res.status(500).json({ error: err.message });
    }
    res.json({ id: this.lastID });
  });
});

// ===========================
// PAYMENT VOUCHERS
// ===========================
router.get("/payment", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  getWarehouseScopedRows(req, res, "wh_payment_vouchers");
});

router.post("/payment", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { voucher_no, date, warehouse_id, farmer_id, amount, employee_id, location_id, description } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  const query = `
    INSERT INTO wh_payment_vouchers (voucher_no, date, warehouse_id, farmer_id, amount, employee_id, location_id, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(query, [voucher_no, date, warehouse_id, farmer_id, amount, employee_id, location_id, description], function (err) {
    if (err) {
      if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
      return res.status(500).json({ error: err.message });
    }
    res.json({ id: this.lastID });
  });
});

// ===========================
// RECEIPT VOUCHERS
// ===========================
router.get("/receipt", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  getWarehouseScopedRows(req, res, "wh_receipt_vouchers");
});

router.post("/receipt", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { voucher_no, date, warehouse_id, company_id, consignee_id, amount, employee_id, location_id, description } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  const query = `
    INSERT INTO wh_receipt_vouchers (voucher_no, date, warehouse_id, company_id, consignee_id, amount, employee_id, location_id, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(query, [voucher_no, date, warehouse_id, company_id, consignee_id, amount, employee_id, location_id, description], function (err) {
    if (err) {
      if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
      return res.status(500).json({ error: err.message });
    }
    res.json({ id: this.lastID });
  });
});

// ===========================
// JOURNAL VOUCHERS
// ===========================
router.get("/journal", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.journal.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  getWarehouseScopedRows(req, res, "wh_journal_vouchers");
});

router.post("/journal", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.journal.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { voucher_no, date, warehouse_id, debit_account, credit_account, amount, employee_id, location_id, description } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  const query = `
    INSERT INTO wh_journal_vouchers (voucher_no, date, warehouse_id, debit_account, credit_account, amount, employee_id, location_id, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(query, [voucher_no, date, warehouse_id, debit_account, credit_account, amount, employee_id, location_id, description], function (err) {
    if (err) {
      if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
      return res.status(500).json({ error: err.message });
    }
    res.json({ id: this.lastID });
  });
});

// ===========================
// REPORTS
// ===========================
router.get("/report/sale-summary", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.sale")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const filter = assignedWarehouseFilter(req.user, "warehouse_id");
  const query = `
    SELECT 
      warehouse_id, 
      SUM(quantity) as total_quantity, 
      SUM(amount) as total_amount 
    FROM wh_sale_vouchers 
    WHERE 1 = 1 ${filter.clause}
    GROUP BY warehouse_id
  `;
  db.all(query, filter.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

router.get("/report/purchase-summary", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.purchase")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const filter = assignedWarehouseFilter(req.user, "warehouse_id");
  const query = `
    SELECT 
      warehouse_id, 
      SUM(quantity) as total_quantity, 
      SUM(amount) as total_amount 
    FROM wh_purchase_vouchers 
    WHERE 1 = 1 ${filter.clause}
    GROUP BY warehouse_id
  `;
  db.all(query, filter.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

router.get("/report/profit-loss", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.profitLoss")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const filter = assignedWarehouseFilter(req.user, "w.id");
  const query = `
    SELECT 
      w.id,
      w.name as warehouse_name,
      (SELECT COALESCE(SUM(amount), 0) FROM wh_sale_vouchers WHERE warehouse_id = w.id) as sale_amount,
      (SELECT COALESCE(SUM(amount), 0) FROM wh_purchase_vouchers WHERE warehouse_id = w.id) as purchase_amount,
      (SELECT COALESCE(SUM(amount), 0) FROM wh_sale_vouchers WHERE warehouse_id = w.id) - 
      (SELECT COALESCE(SUM(amount), 0) FROM wh_purchase_vouchers WHERE warehouse_id = w.id) as profit_loss
    FROM warehouses w
    WHERE 1 = 1 ${filter.clause}
  `;
  db.all(query, filter.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

module.exports = router;
