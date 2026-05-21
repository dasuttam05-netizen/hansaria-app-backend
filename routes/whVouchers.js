const express = require("express");
const router = express.Router();
const db = require("../db");
const { userHasPermission } = require("../middleware/auth");
const { assignedWarehouseFilter, canAccessWarehouse } = require("../helpers/access");
const PDFDocument = require('pdfkit');
function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function fmtNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

function getWarehouseScopedRows(req, res, tableName, orderBy = "date DESC") {
  const filter = assignedWarehouseFilter(req.user, "v.warehouse_id");
  const query = `
    SELECT v.*, ca.account_name AS company_account_name
    FROM ${tableName} v
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
    WHERE 1 = 1 ${filter.clause}
    ORDER BY v.${orderBy}
  `;
  db.all(query, filter.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
}

function getPurchaseVoucherRows(req, res) {
  const filter = assignedWarehouseFilter(req.user, "v.warehouse_id");
  const fallbackFilter = assignedWarehouseFilter(req.user, "warehouse_id");
  const query = `
    SELECT
      v.*,
      (SELECT name FROM products WHERE CAST(id AS TEXT) = CAST(v.product_id AS TEXT) LIMIT 1) AS product_name,
      (SELECT name FROM warehouses WHERE CAST(id AS TEXT) = CAST(v.warehouse_id AS TEXT) LIMIT 1) AS warehouse_name,
      (SELECT name FROM farmers WHERE CAST(id AS TEXT) = CAST(v.farmer_id AS TEXT) LIMIT 1) AS farmer_name,
      ca.account_name AS company_account_name
    FROM wh_purchase_vouchers v
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
    WHERE 1 = 1 ${filter.clause}
    ORDER BY v.date DESC, v.id DESC
  `;

  db.all(query, filter.params, (err, rows) => {
    if (!err) {
      return res.json(rows || []);
    }

    console.error("Purchase voucher mapped query failed, falling back to base rows:", err.message);
    const fallbackQuery = `
      SELECT *
      FROM wh_purchase_vouchers
      WHERE 1 = 1 ${fallbackFilter.clause}
      ORDER BY date DESC, id DESC
    `;
    db.all(fallbackQuery, fallbackFilter.params, (fallbackErr, fallbackRows) => {
      if (fallbackErr) return res.status(500).json({ error: fallbackErr.message });
      res.json(fallbackRows || []);
    });
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

function getVoucherPrefix(type) {
  const prefixMap = {
    purchase: "PUR",
    sale: "SAL",
    payment: "PAY",
    receipt: "REC",
    journal: "JRN",
  };
  return prefixMap[type] || String(type || "").toUpperCase().slice(0, 3);
}

function getVoucherTable(type) {
  const tableMap = {
    purchase: "wh_purchase_vouchers",
    sale: "wh_sale_vouchers",
    payment: "wh_payment_vouchers",
    receipt: "wh_receipt_vouchers",
    journal: "wh_journal_vouchers",
  };
  return tableMap[type];
}

function createSequentialVoucherNo(type, callback) {
  const table = getVoucherTable(type);
  if (!table) return callback(new Error("Invalid voucher type"));
  const shortPrefix = getVoucherPrefix(type);
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `${shortPrefix}-${datePart}-`;
  const query = `SELECT voucher_no FROM ${table} WHERE voucher_no LIKE ? ORDER BY id DESC LIMIT 1`;
  db.get(query, [`${shortPrefix}-%`], (err, row) => {
    if (err) return callback(err);
    let next = 1;
    if (row && row.voucher_no) {
      const pieces = String(row.voucher_no).split("-");
      const last = Number(pieces[pieces.length - 1]);
      if (Number.isFinite(last) && last >= 1) next = last + 1;
    }
    callback(null, `${prefix}${String(next).padStart(4, "0")}`);
  });
}

function computeOutstandingForFarmer(farmerId, callback) {
  const purchaseSql = `SELECT COALESCE(SUM(COALESCE(NULLIF(net_amount_payable, 0), amount)), 0) AS total_purchase FROM wh_purchase_vouchers WHERE farmer_id = ?`;
  const paymentSql = `SELECT COALESCE(SUM(amount), 0) AS total_payment FROM wh_payment_vouchers WHERE farmer_id = ?`;
  db.get(purchaseSql, [farmerId], (err, purchase) => {
    if (err) return callback(err);
    db.get(paymentSql, [farmerId], (err2, payment) => {
      if (err2) return callback(err2);
      const totalPurchase = purchase?.total_purchase || 0;
      const totalPayment = payment?.total_payment || 0;
      callback(null, {
        total_purchase: totalPurchase,
        total_payment: totalPayment,
        outstanding: Number((totalPurchase - totalPayment).toFixed(2)),
      });
    });
  });
}

function computeOutstandingForCompany(companyId, callback) {
  const saleSql = `SELECT COALESCE(SUM(COALESCE(NULLIF(net_receivable_amount, 0), amount)), 0) AS total_sale FROM wh_sale_vouchers WHERE company_id = ?`;
  const receiptSql = `SELECT COALESCE(SUM(amount), 0) AS total_receipt FROM wh_receipt_vouchers WHERE company_id = ?`;
  db.get(saleSql, [companyId], (err, sale) => {
    if (err) return callback(err);
    db.get(receiptSql, [companyId], (err2, receipt) => {
      if (err2) return callback(err2);
      const totalSale = sale?.total_sale || 0;
      const totalReceipt = receipt?.total_receipt || 0;
      callback(null, {
        total_sale: totalSale,
        total_receipt: totalReceipt,
        outstanding: Number((totalSale - totalReceipt).toFixed(2)),
      });
    });
  });
}

function createVoucherNoIfMissing(type, voucherNo, callback) {
  if (voucherNo && String(voucherNo).trim()) return callback(null, voucherNo);
  createSequentialVoucherNo(type, callback);
}

// Idempotency helpers: prevent duplicate resource creation when client retries
function getIdempotency(key, route, cb) {
  if (!key) return cb(null, null);
  db.get(`SELECT response_id FROM idempotency_keys WHERE key = ? AND route = ?`, [key, route], (err, row) => {
    if (err) return cb(err);
    cb(null, row ? row.response_id : null);
  });
}

function saveIdempotency(key, route, responseId, cb) {
  if (!key) return cb && cb();
  db.run(
    `INSERT OR REPLACE INTO idempotency_keys (key, route, response_id, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
    [key, route, responseId],
    (err) => cb && cb(err)
  );
}

// ===========================
// PURCHASE VOUCHERS
// ===========================
router.get("/purchase", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }
  getPurchaseVoucherRows(req, res);
});

router.post("/purchase", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const {
    voucher_no,
    date,
    warehouse_id,
    farmer_id,
    company_account_id,
    product_id,
    quantity,
    rate,
    amount,
    packet,
    gross_weight,
    tare_weight,
    dhalta,
    less_bags_weight,
    moisture,
    dunki,
    fungus,
    discolour,
    others,
    net_weight,
    bags_claim,
    labour,
    total_deduct_amount,
    total_qty,
    total_deduction,
    round_off,
    net_amount_payable,
    employee_id,
    location_id,
    description,
  } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  const query = `
    INSERT INTO wh_purchase_vouchers (
      voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
      packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
      discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
      total_deduction, round_off, net_amount_payable, employee_id, location_id, description
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const idemKey = req.get("Idempotency-Key") || req.headers["idempotency-key"];
  if (idemKey) {
    return getIdempotency(idemKey, "purchase", (err, existingId) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existingId) {
        return db.get(`SELECT * FROM wh_purchase_vouchers WHERE id = ?`, [existingId], (e2, existingRow) => {
          if (e2) return res.status(500).json({ error: e2.message });
          return res.json({ id: existingRow.id, voucher_no: existingRow.voucher_no, existing: existingRow });
        });
      }

      createVoucherNoIfMissing("purchase", voucher_no, (err, generatedVoucherNo) => {
        if (err) return res.status(500).json({ error: err.message });

        const query = `
          INSERT INTO wh_purchase_vouchers (
            voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
            packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
            discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
            total_deduction, round_off, net_amount_payable, employee_id, location_id, description
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [
          generatedVoucherNo,
          date,
          warehouse_id,
          farmer_id,
          company_account_id,
          product_id,
          quantity,
          rate,
          amount,
          packet,
          gross_weight,
          tare_weight,
          dhalta,
          less_bags_weight,
          moisture,
          dunki,
          fungus,
          discolour,
          others,
          net_weight,
          bags_claim,
          labour,
          total_deduct_amount,
          total_qty,
          total_deduction,
          round_off,
          net_amount_payable,
          employee_id,
          location_id,
          description,
        ], function (err) {
          if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }
          saveIdempotency(idemKey, "purchase", this.lastID, () => {});
          res.json({ id: this.lastID, voucher_no: generatedVoucherNo });
        });
      });
    });
  }

  // no idempotency key, proceed normally
  createVoucherNoIfMissing("purchase", voucher_no, (err, generatedVoucherNo) => {
    if (err) return res.status(500).json({ error: err.message });

    const query = `
      INSERT INTO wh_purchase_vouchers (
        voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
        packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
        discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
        total_deduction, round_off, net_amount_payable, employee_id, location_id, description
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [
      generatedVoucherNo,
      date,
      warehouse_id,
      farmer_id,
      company_account_id,
      product_id,
      quantity,
      rate,
      amount,
      packet,
      gross_weight,
      tare_weight,
      dhalta,
      less_bags_weight,
      moisture,
      dunki,
      fungus,
      discolour,
      others,
      net_weight,
      bags_claim,
      labour,
      total_deduct_amount,
      total_qty,
      total_deduction,
      round_off,
      net_amount_payable,
      employee_id,
      location_id,
      description,
    ], function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, voucher_no: generatedVoucherNo });
    });
  });
});

router.get("/next-voucher-no", (req, res) => {
  const { type } = req.query;
  if (!type) return res.status(400).json({ error: "type query param is required" });
  createSequentialVoucherNo(type, (err, voucher_no) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ voucher_no });
  });
});

router.get("/outstanding", (req, res) => {
  const { party_type, id, warehouse_id, location_id } = req.query;
  if (!party_type || !id) return res.status(400).json({ error: "party_type and id are required" });

  const filters = ["1=1"];
  const params = [id];
  let detailsQuery;
  let paymentsQuery;

  if (party_type === "farmer") {
    if (warehouse_id) {
      filters.push("warehouse_id = ?");
      params.push(warehouse_id);
    }
    if (location_id) {
      filters.push("location_id = ?");
      params.push(location_id);
    }
    detailsQuery = `SELECT id, voucher_no, date, warehouse_id, location_id, COALESCE(NULLIF(net_amount_payable, 0), amount) AS amount FROM wh_purchase_vouchers WHERE farmer_id = ? ${filters.slice(1).length ? `AND ${filters.slice(1).join(" AND ")}` : ""} ORDER BY date ASC`;
    paymentsQuery = `SELECT id, voucher_no, date, warehouse_id, location_id, amount FROM wh_payment_vouchers WHERE farmer_id = ? ${filters.slice(1).length ? `AND ${filters.slice(1).join(" AND ")}` : ""} ORDER BY date ASC`;
    computeOutstandingForFarmer(id, (err, stats) => {
      if (err) return res.status(500).json({ error: err.message });
      db.all(detailsQuery, params, (err2, purchases) => {
        if (err2) return res.status(500).json({ error: err2.message });
        db.all(paymentsQuery, params, (err3, payments) => {
          if (err3) return res.status(500).json({ error: err3.message });
          res.json({ party_type: "farmer", id, stats, purchases, payments });
        });
      });
    });
    return;
  }

  if (party_type === "company") {
    if (warehouse_id) {
      filters.push("warehouse_id = ?");
      params.push(warehouse_id);
    }
    if (location_id) {
      filters.push("location_id = ?");
      params.push(location_id);
    }
    detailsQuery = `SELECT id, voucher_no, date, warehouse_id, location_id, COALESCE(NULLIF(net_receivable_amount, 0), amount) AS amount FROM wh_sale_vouchers WHERE company_id = ? ${filters.slice(1).length ? `AND ${filters.slice(1).join(" AND ")}` : ""} ORDER BY date ASC`;
    paymentsQuery = `SELECT id, voucher_no, date, warehouse_id, location_id, amount FROM wh_receipt_vouchers WHERE company_id = ? ${filters.slice(1).length ? `AND ${filters.slice(1).join(" AND ")}` : ""} ORDER BY date ASC`;
    computeOutstandingForCompany(id, (err, stats) => {
      if (err) return res.status(500).json({ error: err.message });
      db.all(detailsQuery, params, (err2, sales) => {
        if (err2) return res.status(500).json({ error: err2.message });
        db.all(paymentsQuery, params, (err3, receipts) => {
          if (err3) return res.status(500).json({ error: err3.message });
          res.json({ party_type: "company", id, stats, sales, receipts });
        });
      });
    });
    return;
  }

  res.status(400).json({ error: "Unsupported party_type" });
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

  const { voucher_no, date, unloading_date, warehouse_id, company_id, company_account_id, consignee_id, product_id, quantity, shortage_quantity, unloading_qty, rate, amount, claim_amount, other_deduction, adjustment_amount, tds_amount, employee_id, location_id, description } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  const idemKey = req.get("Idempotency-Key") || req.headers["idempotency-key"];
  if (idemKey) {
    return getIdempotency(idemKey, "sale", (err, existingId) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existingId) {
        return db.get(`SELECT * FROM wh_sale_vouchers WHERE id = ?`, [existingId], (e2, existingRow) => {
          if (e2) return res.status(500).json({ error: e2.message });
          return res.json({ id: existingRow.id, voucher_no: existingRow.voucher_no, existing: existingRow });
        });
      }

      createVoucherNoIfMissing("sale", voucher_no, (err, generatedVoucherNo) => {
        if (err) return res.status(500).json({ error: err.message });

        const amountValue = Number(amount) || 0;
        const claimValue = Number(claim_amount) || 0;
        const otherDeductionValue = Number(other_deduction) || 0;
        const adjustmentValue = Number(adjustment_amount) || 0;
        const tdsValue = Number(tds_amount) || 0;
        const netAmount = amountValue - claimValue - otherDeductionValue - adjustmentValue - tdsValue;
        const unloadingQtyValue = Number(unloading_qty) || Number(quantity) || 0;
        const fifoAmountValue = amountValue;
        const fifoRateValue = unloadingQtyValue > 0 ? amountValue / unloadingQtyValue : 0;
        const netReceivableValue = netAmount;
        const outstanding = netAmount;

        const query = `
          INSERT INTO wh_sale_vouchers (voucher_no, date, unloading_date, warehouse_id, company_id, company_account_id, consignee_id, product_id, quantity, shortage_quantity, unloading_qty, rate, amount, claim_amount, other_deduction, adjustment_amount, tds_amount, net_amount, net_receivable_amount, fifo_rate, fifo_amount, outstanding, employee_id, location_id, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [generatedVoucherNo, date, unloading_date, warehouse_id, company_id, company_account_id, consignee_id, product_id, quantity, shortage_quantity, unloadingQtyValue, rate, amountValue, claimValue, otherDeductionValue, adjustmentValue, tdsValue, netAmount, netReceivableValue, fifoRateValue, fifoAmountValue, outstanding, employee_id, location_id, description], function (err) {
          if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }
          saveIdempotency(idemKey, "sale", this.lastID, () => {});
          res.json({ id: this.lastID, voucher_no: generatedVoucherNo, net_amount: netAmount, outstanding });
        });
      });
    });
  }

  createVoucherNoIfMissing("sale", voucher_no, (err, generatedVoucherNo) => {
    if (err) return res.status(500).json({ error: err.message });

    const amountValue = Number(amount) || 0;
    const claimValue = Number(claim_amount) || 0;
    const otherDeductionValue = Number(other_deduction) || 0;
    const adjustmentValue = Number(adjustment_amount) || 0;
    const tdsValue = Number(tds_amount) || 0;
    const netAmount = amountValue - claimValue - otherDeductionValue - adjustmentValue - tdsValue;
    const unloadingQtyValue = Number(unloading_qty) || Number(quantity) || 0;
    const fifoAmountValue = amountValue;
    const fifoRateValue = unloadingQtyValue > 0 ? amountValue / unloadingQtyValue : 0;
    const netReceivableValue = netAmount;
    const outstanding = netAmount;

    const query = `
      INSERT INTO wh_sale_vouchers (voucher_no, date, unloading_date, warehouse_id, company_id, company_account_id, consignee_id, product_id, quantity, shortage_quantity, unloading_qty, rate, amount, claim_amount, other_deduction, adjustment_amount, tds_amount, net_amount, net_receivable_amount, fifo_rate, fifo_amount, outstanding, employee_id, location_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [generatedVoucherNo, date, unloading_date, warehouse_id, company_id, company_account_id, consignee_id, product_id, quantity, shortage_quantity, unloadingQtyValue, rate, amountValue, claimValue, otherDeductionValue, adjustmentValue, tdsValue, netAmount, netReceivableValue, fifoRateValue, fifoAmountValue, outstanding, employee_id, location_id, description], function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, voucher_no: generatedVoucherNo, net_amount: netAmount, outstanding });
    });
  });
});

router.put("/sale/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.sale.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  const { voucher_no, date, unloading_date, warehouse_id, company_id, company_account_id, consignee_id, product_id, quantity, shortage_quantity, unloading_qty, rate, amount, claim_amount, other_deduction, adjustment_amount, tds_amount, employee_id, location_id, description } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  const amountValue = Number(amount) || 0;
  const claimValue = Number(claim_amount) || 0;
  const otherDeductionValue = Number(other_deduction) || 0;
  const adjustmentValue = Number(adjustment_amount) || 0;
  const tdsValue = Number(tds_amount) || 0;
  const netAmount = amountValue - claimValue - otherDeductionValue - adjustmentValue - tdsValue;
  const unloadingQtyValue = Number(unloading_qty) || Number(quantity) || 0;
  const fifoAmountValue = amountValue;
  const fifoRateValue = unloadingQtyValue > 0 ? amountValue / unloadingQtyValue : 0;
  const netReceivableValue = netAmount;

  const query = `
    UPDATE wh_sale_vouchers SET
      voucher_no=?, date=?, unloading_date=?, warehouse_id=?, company_id=?, company_account_id=?, consignee_id=?, product_id=?,
      quantity=?, shortage_quantity=?, unloading_qty=?, rate=?, amount=?, claim_amount=?, other_deduction=?,
      adjustment_amount=?, tds_amount=?, net_amount=?, net_receivable_amount=?, fifo_rate=?, fifo_amount=?,
      outstanding=?, employee_id=?, location_id=?, description=?
    WHERE id = ?
  `;

  db.run(query, [
    voucher_no, date, unloading_date, warehouse_id, company_id, company_account_id, consignee_id, product_id,
    quantity, shortage_quantity, unloadingQtyValue, rate, amountValue, claimValue, otherDeductionValue,
    adjustmentValue, tdsValue, netAmount, netReceivableValue, fifoRateValue, fifoAmountValue,
    netAmount, employee_id, location_id, description, id
  ], function (err) {
    if (err) {
      if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
      return res.status(500).json({ error: err.message });
    }
    res.json({ id, updated: 1, net_amount: netAmount, net_receivable_amount: netReceivableValue, outstanding: netAmount });
  });
});

router.delete("/sale/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.sale.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  db.get("SELECT warehouse_id FROM wh_sale_vouchers WHERE id = ?", [id], (findErr, row) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!row) return res.status(404).json({ error: "Voucher not found" });
    if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;

    db.run("DELETE FROM wh_sale_vouchers WHERE id = ?", [id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ deleted: 1 });
    });
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

  const { voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, employee_id, location_id, description } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;
  if (!farmer_id) return res.status(400).json({ error: "Farmer is required for payment vouchers" });

  const idemKey = req.get("Idempotency-Key") || req.headers["idempotency-key"];
  if (idemKey) {
    return getIdempotency(idemKey, "payment", (err, existingId) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existingId) {
        return db.get(`SELECT * FROM wh_payment_vouchers WHERE id = ?`, [existingId], (e2, existingRow) => {
          if (e2) return res.status(500).json({ error: e2.message });
          return res.json({ id: existingRow.id, voucher_no: existingRow.voucher_no, existing: existingRow });
        });
      }

      createVoucherNoIfMissing("payment", voucher_no, (err, generatedVoucherNo) => {
        if (err) return res.status(500).json({ error: err.message });

        const query = `
          INSERT INTO wh_payment_vouchers (voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, employee_id, location_id, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [generatedVoucherNo, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, employee_id, location_id, description], function (err) {
          if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }

          const paymentId = this.lastID;
          saveIdempotency(idemKey, "payment", paymentId, () => {});
          computeOutstandingForFarmer(farmer_id, (err2, stats) => {
            if (err2) return res.status(500).json({ error: err2.message });
            db.run("UPDATE wh_payment_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, paymentId], () => {
              res.json({ id: paymentId, voucher_no: generatedVoucherNo, stats });
            });
          });
        });
      });
    });
  }

  createVoucherNoIfMissing("payment", voucher_no, (err, generatedVoucherNo) => {
    if (err) return res.status(500).json({ error: err.message });

    const query = `
      INSERT INTO wh_payment_vouchers (voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, employee_id, location_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [generatedVoucherNo, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, employee_id, location_id, description], function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: err.message });
      }

      const paymentId = this.lastID;
      computeOutstandingForFarmer(farmer_id, (err2, stats) => {
        if (err2) return res.status(500).json({ error: err2.message });
        db.run("UPDATE wh_payment_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, paymentId], () => {
          res.json({ id: paymentId, voucher_no: generatedVoucherNo, stats });
        });
      });
    });
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

  const { voucher_no, date, warehouse_id, company_id, company_account_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;
  if (!company_id) return res.status(400).json({ error: "Company is required for receipt vouchers" });

  const idemKey = req.get("Idempotency-Key") || req.headers["idempotency-key"];
  if (idemKey) {
    return getIdempotency(idemKey, "receipt", (err, existingId) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existingId) {
        return db.get(`SELECT * FROM wh_receipt_vouchers WHERE id = ?`, [existingId], (e2, existingRow) => {
          if (e2) return res.status(500).json({ error: e2.message });
          return res.json({ id: existingRow.id, voucher_no: existingRow.voucher_no, existing: existingRow });
        });
      }

      createVoucherNoIfMissing("receipt", voucher_no, (err, generatedVoucherNo) => {
        if (err) return res.status(500).json({ error: err.message });

        const query = `
          INSERT INTO wh_receipt_vouchers (voucher_no, date, warehouse_id, company_id, company_account_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [generatedVoucherNo, date, warehouse_id, company_id, company_account_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description], function (err) {
          if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }

          const receiptId = this.lastID;
          saveIdempotency(idemKey, "receipt", receiptId, () => {});
          computeOutstandingForCompany(company_id, (err2, stats) => {
            if (err2) return res.status(500).json({ error: err2.message });
            db.run("UPDATE wh_receipt_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, receiptId], () => {
              res.json({ id: receiptId, voucher_no: generatedVoucherNo, stats });
            });
          });
        });
      });
    });
  }

  createVoucherNoIfMissing("receipt", voucher_no, (err, generatedVoucherNo) => {
    if (err) return res.status(500).json({ error: err.message });

    const query = `
      INSERT INTO wh_receipt_vouchers (voucher_no, date, warehouse_id, company_id, company_account_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [generatedVoucherNo, date, warehouse_id, company_id, company_account_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description], function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: err.message });
      }

      const receiptId = this.lastID;
      computeOutstandingForCompany(company_id, (err2, stats) => {
        if (err2) return res.status(500).json({ error: err2.message });
        db.run("UPDATE wh_receipt_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, receiptId], () => {
          res.json({ id: receiptId, voucher_no: generatedVoucherNo, stats });
        });
      });
    });
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

  const { voucher_no, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  const idemKey = req.get("Idempotency-Key") || req.headers["idempotency-key"];
  if (idemKey) {
    return getIdempotency(idemKey, "journal", (err, existingId) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existingId) {
        return db.get(`SELECT * FROM wh_journal_vouchers WHERE id = ?`, [existingId], (e2, existingRow) => {
          if (e2) return res.status(500).json({ error: e2.message });
          return res.json({ id: existingRow.id, voucher_no: existingRow.voucher_no, existing: existingRow });
        });
      }

      createVoucherNoIfMissing("journal", voucher_no, (err, generatedVoucherNo) => {
        if (err) return res.status(500).json({ error: err.message });

        const query = `
          INSERT INTO wh_journal_vouchers (voucher_no, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [generatedVoucherNo, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description], function (err) {
          if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }
          saveIdempotency(idemKey, "journal", this.lastID, () => {});
          res.json({ id: this.lastID, voucher_no: generatedVoucherNo });
        });
      });
    });
  }

  createVoucherNoIfMissing("journal", voucher_no, (err, generatedVoucherNo) => {
    if (err) return res.status(500).json({ error: err.message });

    const query = `
      INSERT INTO wh_journal_vouchers (voucher_no, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [generatedVoucherNo, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description], function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, voucher_no: generatedVoucherNo });
    });
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
      SUM(COALESCE(NULLIF(unloading_qty, 0), quantity)) as total_quantity, 
      SUM(COALESCE(NULLIF(net_receivable_amount, 0), amount)) as total_amount 
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

  const filter = assignedWarehouseFilter(req.user, "v.warehouse_id");
  const query = `
    SELECT
      v.*,
      w.name AS warehouse_name,
      ca.account_name AS company_account_name,
      f.name AS farmer_name,
      p.name AS product_name,
      (COALESCE(NULLIF(v.total_qty, 0), NULLIF(v.net_weight, 0), v.quantity) * COALESCE(v.rate, 0)) AS gross_amount,
      COALESCE(NULLIF(v.total_qty, 0), v.quantity) AS total_quantity,
      COALESCE(NULLIF(v.net_amount_payable, 0), v.amount) AS total_amount
    FROM wh_purchase_vouchers v
    LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(v.warehouse_id AS TEXT)
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
    LEFT JOIN farmers f ON CAST(f.id AS TEXT) = CAST(v.farmer_id AS TEXT)
    LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(v.product_id AS TEXT)
    WHERE 1 = 1 ${filter.clause}
    ORDER BY v.date DESC, v.id DESC
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
      (SELECT COALESCE(SUM(COALESCE(NULLIF(net_receivable_amount, 0), amount)), 0) FROM wh_sale_vouchers WHERE warehouse_id = w.id) as sale_amount,
      (SELECT COALESCE(SUM(COALESCE(NULLIF(net_amount_payable, 0), amount)), 0) FROM wh_purchase_vouchers WHERE warehouse_id = w.id) as purchase_amount,
      (SELECT COALESCE(SUM(COALESCE(NULLIF(net_receivable_amount, 0), amount)), 0) FROM wh_sale_vouchers WHERE warehouse_id = w.id) - 
      (SELECT COALESCE(SUM(COALESCE(NULLIF(net_amount_payable, 0), amount)), 0) FROM wh_purchase_vouchers WHERE warehouse_id = w.id) as profit_loss
    FROM warehouses w
    WHERE 1 = 1 ${filter.clause}
  `;
  db.all(query, filter.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// PDF download for purchase voucher - available to authenticated users
router.get("/purchase/:id/pdf", (req, res) => {
  const id = req.params.id;
  const q = `
    SELECT
      p.*,
      w.name AS warehouse_name,
      w.address AS warehouse_address,
      ca.account_name AS company_account_name,
      ca.mobile AS company_account_mobile,
      ca.pan_no AS company_account_pan,
      ca.address AS company_account_address,
      f.name AS farmer_name,
      f.mobile AS farmer_mobile,
      f.village AS farmer_village,
      pr.name AS product_name
    FROM wh_purchase_vouchers p
    LEFT JOIN warehouses w ON w.id = p.warehouse_id
    LEFT JOIN company_accounts ca ON ca.id = p.company_account_id
    LEFT JOIN farmers f ON f.id = p.farmer_id
    LEFT JOIN products pr ON pr.id = p.product_id
    WHERE p.id = ?
  `;
  db.get(q, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Not found" });
    if (!req.user) return res.status(403).json({ error: "Authentication required" });
    if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;

    const doc = new PDFDocument({ size: "A4", margin: 28 });
    res.setHeader('Content-Type', 'application/pdf');
    const filename = `purchase_${row.voucher_no || id}.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    const pageW = doc.page.width;
    const contentW = pageW - 56;
    const blue = "#0b2a66";
    const orange = "#e67e22";
    const light = "#f7f8fb";
    const x = 28;
    let y = 28;

    doc.rect(x, y, contentW, 82).fill(light);
    doc.rect(x + contentW - 255, y, 255, 82).fill(blue);
    doc.polygon([x + contentW - 295, y + 82], [x + contentW - 255, y], [x + contentW - 255, y + 82]).fill(blue);
    doc.fillColor(blue).fontSize(30).text("SHIVANSH", x + 16, y + 12, { continued: true });
    doc.fillColor("#1b1b1b").fontSize(30).text(" TRADING CO.");
    doc.fillColor(orange).fontSize(11).text("GRAIN MERCHANT & COMMISSION AGENT", x + 18, y + 50);
    doc.fillColor("#333").fontSize(10).text("Sanjat Bajar, Ward No.-01, Bairasray, Pin - 851120, Bihar", x + 18, y + 66, { width: contentW - 310 });
    doc.fillColor("#fff").fontSize(24).text("PURCHASE MEMO", x + contentW - 245, y + 28, { width: 225, align: "center" });
    y += 92;

    doc.strokeColor("#d7d7d7").lineWidth(1).moveTo(x, y).lineTo(x + contentW, y).stroke();
    y += 12;

    doc.fillColor("#222").fontSize(12).text(`Serial No.: ${row.voucher_no || id}`, x + 2, y);
    doc.text(`Date: ${fmtDate(row.date)}`, x + contentW - 180, y, { width: 178, align: "right" });
    y += 26;

    const leftW = (contentW - 16) / 2;
    const rightX = x + leftW + 16;
    doc.roundedRect(x, y, leftW, 132, 6).stroke("#c9c9c9");
    doc.roundedRect(rightX, y, leftW, 132, 6).stroke("#c9c9c9");
    doc.rect(x, y, leftW, 22).fill(blue);
    doc.rect(rightX, y, leftW, 22).fill(orange);
    doc.fillColor("#fff").fontSize(12).text("PARTY INFORMATION", x + 10, y + 5);
    doc.text("DOCUMENT INFORMATION", rightX + 10, y + 5);

    doc.fillColor("#222").fontSize(11);
    const pStart = y + 32;
    doc.text(`Name: ${row.farmer_name || "-"}`, x + 10, pStart);
    doc.text(`Phone: ${row.farmer_mobile || "-"}`, x + 10, pStart + 20);
    doc.text(`Village: ${row.farmer_village || "-"}`, x + 10, pStart + 40);
    doc.text(`Account: ${row.company_account_name || "-"}`, x + 10, pStart + 60);
    doc.text(`Warehouse: ${row.warehouse_name || row.warehouse_id || "-"}`, x + 10, pStart + 80);

    doc.text(`R.S.T. No.: -`, rightX + 10, pStart);
    doc.text(`Transport No.: -`, rightX + 10, pStart + 20);
    doc.text(`Product: ${row.product_name || row.product_id || "-"}`, rightX + 10, pStart + 40);
    doc.text(`Account Mobile: ${row.company_account_mobile || "-"}`, rightX + 10, pStart + 60);
    doc.text(`Account PAN: ${row.company_account_pan || "-"}`, rightX + 10, pStart + 80);
    y += 146;

    const tableX = x;
    const tableW = contentW;
    const col1 = 42;
    const col2 = tableW - 180 - col1;
    const col3 = 180;
    doc.rect(tableX, y, tableW, 26).fill(blue);
    doc.fillColor("#fff").fontSize(12).text("#", tableX + 14, y + 7);
    doc.text("PARTICULARS", tableX + col1 + 10, y + 7);
    doc.text("AMOUNT (Rs.)", tableX + col1 + col2 + 10, y + 7);
    y += 26;

    const lines = [
      ["1", "Brokerage", fmtNum(row.total_deduct_amount)],
      ["2", "Packet", fmtNum(row.packet)],
      ["3", "Gross Weight", fmtNum(row.gross_weight)],
      ["4", "Tare Weight", fmtNum(row.tare_weight)],
      ["5", "Dhalta", fmtNum(row.dhalta)],
      ["6", "Less Bags Weight", fmtNum(row.less_bags_weight)],
      ["7", "Moisture / Dunki / Fungas", fmtNum(Number(row.moisture || 0) + Number(row.dunki || 0) + Number(row.fungus || 0))],
      ["8", "Disclour / Others", fmtNum(Number(row.discolour || 0) + Number(row.others || 0))],
      ["9", "Lorry Claim", fmtNum(row.bags_claim)],
      ["10", "Net Amount Payable", fmtNum(row.net_amount_payable || row.amount)],
    ];

    lines.forEach((ln) => {
      doc.rect(tableX, y, tableW, 24).stroke("#d8d8d8");
      doc.text(ln[0], tableX + 14, y + 6);
      doc.text(ln[1], tableX + col1 + 10, y + 6);
      doc.text(ln[2], tableX + col1 + col2 + 10, y + 6);
      y += 24;
    });

    y += 10;
    doc.roundedRect(x, y, contentW, 86, 6).stroke("#cfcfcf");
    doc.fontSize(11).fillColor("#222").text(`Purchased Kg.: ${fmtNum(row.gross_weight)}`, x + 12, y + 12);
    doc.text(`Net Qty.: ${fmtNum(row.total_qty || row.net_weight || row.quantity)}`, x + 142, y + 12);
    doc.text(`Labour Charges: ${fmtNum(row.labour)}`, x + 268, y + 12);
    doc.text(`Total Deductions: ${fmtNum(row.total_deduction || row.total_deduct_amount)}`, x + 410, y + 12);
    doc.rect(x + contentW - 220, y + 40, 220, 34).fill(blue);
    doc.fillColor("#fff").fontSize(13).text("Net Amount Payable", x + contentW - 210, y + 50);
    doc.fillColor(orange).fontSize(15).text(`Rs. ${fmtNum(row.net_amount_payable || row.amount)}`, x + contentW - 105, y + 49, { width: 95, align: "right" });

    y += 98;
    doc.roundedRect(x, y, contentW, 58, 6).stroke("#cfcfcf");
    doc.fillColor(blue).fontSize(11).text("ADDITIONAL DETAILS", x + 12, y + 10);
    doc.fillColor("#222").fontSize(10).text(`Bank / Account: ${row.company_account_name || "-"}`, x + 12, y + 31, { width: 170 });
    doc.text(`Account Address: ${row.company_account_address || "-"}`, x + 205, y + 31, { width: 170 });
    doc.text(`Transport No.: -`, x + 405, y + 31, { width: 120 });

    if (row.description) {
      y += 70;
      doc.fillColor("#222").fontSize(11).text(`Remarks: ${row.description}`, x, y, { width: contentW });
    }

    doc.end();
  });
});

router.get("/sale/:id/pdf", (req, res) => {
  const id = req.params.id;
  const q = `
    SELECT
      s.*,
      w.name AS warehouse_name,
      c.name AS company_name,
      co.name AS consignee_name,
      p.name AS product_name
    FROM wh_sale_vouchers s
    LEFT JOIN warehouses w ON w.id = s.warehouse_id
    LEFT JOIN companies c ON c.id = s.company_id
    LEFT JOIN consignee_names co ON co.id = s.consignee_id
    LEFT JOIN products p ON p.id = s.product_id
    WHERE s.id = ?
  `;

  db.get(q, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Not found" });
    if (!req.user) return res.status(403).json({ error: "Authentication required" });
    if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;

    const doc = new PDFDocument({ size: "A4", margin: 36 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="sale_${row.voucher_no || id}.pdf"`);
    doc.pipe(res);

    doc.fontSize(18).text("SALE VOUCHER", { align: "center" });
    doc.moveDown(0.6);
    doc.fontSize(11).text(`Voucher No: ${row.voucher_no || "-"}`);
    doc.text(`Sale Date: ${fmtDate(row.date)}`);
    doc.text(`Unloading Date: ${fmtDate(row.unloading_date)}`);
    doc.text(`Warehouse: ${row.warehouse_name || row.warehouse_id || "-"}`);
    doc.text(`Company: ${row.company_name || "-"}`);
    doc.text(`Consignee: ${row.consignee_name || "-"}`);
    doc.text(`Product: ${row.product_name || "-"}`);
    doc.moveDown(0.4);
    doc.text(`Qty: ${fmtNum(row.quantity)}`);
    doc.text(`Unloading Qty: ${fmtNum(row.unloading_qty || row.quantity)}`);
    doc.text(`Shortage Qty: ${fmtNum(row.shortage_quantity)}`);
    doc.text(`Rate: ${fmtNum(row.rate)}`);
    doc.text(`Amount: ${fmtNum(row.amount)}`);
    doc.text(`Claim: ${fmtNum(row.claim_amount)}`);
    doc.text(`Other Deduction: ${fmtNum(row.other_deduction)}`);
    doc.text(`Adjustment: ${fmtNum(row.adjustment_amount)}`);
    doc.text(`TDS: ${fmtNum(row.tds_amount)}`);
    doc.text(`Net Receivable: ${fmtNum(row.net_receivable_amount || row.net_amount || row.amount)}`);
    doc.text(`Outstanding: ${fmtNum(row.outstanding)}`);

    if (row.description) {
      doc.moveDown(0.4);
      doc.text(`Remarks: ${row.description}`);
    }

    doc.end();
  });
});

// Update purchase voucher
router.put("/purchase/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  const {
    voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
    packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
    discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
    total_deduction, round_off, net_amount_payable, employee_id, location_id, description
  } = req.body;

  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  const query = `
    UPDATE wh_purchase_vouchers SET
      voucher_no=?, date=?, warehouse_id=?, farmer_id=?, company_account_id=?, product_id=?, quantity=?, rate=?, amount=?,
      packet=?, gross_weight=?, tare_weight=?, dhalta=?, less_bags_weight=?, moisture=?, dunki=?, fungus=?,
      discolour=?, others=?, net_weight=?, bags_claim=?, labour=?, total_deduct_amount=?, total_qty=?,
      total_deduction=?, round_off=?, net_amount_payable=?, employee_id=?, location_id=?, description=?
    WHERE id = ?
  `;

  db.run(query, [
    voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
    packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
    discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
    total_deduction, round_off, net_amount_payable, employee_id, location_id, description, id
  ], function(err) {
    if (err) {
      if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
      return res.status(500).json({ error: err.message });
    }
    res.json({ id, message: "Voucher updated successfully" });
  });
});

// Delete purchase voucher
router.delete("/purchase/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  const query = "DELETE FROM wh_purchase_vouchers WHERE id = ?";

  db.run(query, [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "Voucher not found" });
    res.json({ message: "Voucher deleted successfully" });
  });
});

module.exports = router;
