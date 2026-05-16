const express = require("express");
const router = express.Router();
const db = require("../db");
const { userHasPermission } = require("../middleware/auth");
const { assignedWarehouseFilter, canAccessWarehouse } = require("../helpers/access");
const PDFDocument = require('pdfkit');

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
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `${getVoucherPrefix(type)}-${datePart}-`;
  const query = `SELECT voucher_no FROM ${table} WHERE voucher_no LIKE ? ORDER BY voucher_no DESC LIMIT 1`;
  db.get(query, [`${prefix}%`], (err, row) => {
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
  const saleSql = `SELECT COALESCE(SUM(amount), 0) AS total_sale FROM wh_sale_vouchers WHERE company_id = ?`;
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
  
  getWarehouseScopedRows(req, res, "wh_purchase_vouchers");
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
    net_amount_payable,
    employee_id,
    location_id,
    description,
  } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  const query = `
    INSERT INTO wh_purchase_vouchers (
      voucher_no, date, warehouse_id, farmer_id, product_id, quantity, rate, amount,
      packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
      discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
      total_deduction, net_amount_payable, employee_id, location_id, description
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            voucher_no, date, warehouse_id, farmer_id, product_id, quantity, rate, amount,
            packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
            discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
            total_deduction, net_amount_payable, employee_id, location_id, description
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [
          generatedVoucherNo,
          date,
          warehouse_id,
          farmer_id,
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
        voucher_no, date, warehouse_id, farmer_id, product_id, quantity, rate, amount,
        packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
        discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
        total_deduction, net_amount_payable, employee_id, location_id, description
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [
      generatedVoucherNo,
      date,
      warehouse_id,
      farmer_id,
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
    detailsQuery = `SELECT id, voucher_no, date, warehouse_id, location_id, amount FROM wh_sale_vouchers WHERE company_id = ? ${filters.slice(1).length ? `AND ${filters.slice(1).join(" AND ")}` : ""} ORDER BY date ASC`;
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

  const { voucher_no, date, unloading_date, warehouse_id, company_id, consignee_id, product_id, quantity, shortage_quantity, rate, amount, claim_amount, tds_amount, employee_id, location_id, description } = req.body;
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
        const tdsValue = Number(tds_amount) || 0;
        const netAmount = amountValue - claimValue - tdsValue;
        const outstanding = netAmount;

        const query = `
          INSERT INTO wh_sale_vouchers (voucher_no, date, unloading_date, warehouse_id, company_id, consignee_id, product_id, quantity, shortage_quantity, rate, amount, claim_amount, tds_amount, net_amount, outstanding, employee_id, location_id, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [generatedVoucherNo, date, unloading_date, warehouse_id, company_id, consignee_id, product_id, quantity, shortage_quantity, rate, amountValue, claimValue, tdsValue, netAmount, outstanding, employee_id, location_id, description], function (err) {
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
    const tdsValue = Number(tds_amount) || 0;
    const netAmount = amountValue - claimValue - tdsValue;
    const outstanding = netAmount;

    const query = `
      INSERT INTO wh_sale_vouchers (voucher_no, date, unloading_date, warehouse_id, company_id, consignee_id, product_id, quantity, shortage_quantity, rate, amount, claim_amount, tds_amount, net_amount, outstanding, employee_id, location_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [generatedVoucherNo, date, unloading_date, warehouse_id, company_id, consignee_id, product_id, quantity, shortage_quantity, rate, amountValue, claimValue, tdsValue, netAmount, outstanding, employee_id, location_id, description], function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, voucher_no: generatedVoucherNo, net_amount: netAmount, outstanding });
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

  const { voucher_no, date, warehouse_id, farmer_id, amount, reference_type, reference_id, employee_id, location_id, description } = req.body;
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
          INSERT INTO wh_payment_vouchers (voucher_no, date, warehouse_id, farmer_id, amount, reference_type, reference_id, employee_id, location_id, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [generatedVoucherNo, date, warehouse_id, farmer_id, amount, reference_type, reference_id, employee_id, location_id, description], function (err) {
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
      INSERT INTO wh_payment_vouchers (voucher_no, date, warehouse_id, farmer_id, amount, reference_type, reference_id, employee_id, location_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [generatedVoucherNo, date, warehouse_id, farmer_id, amount, reference_type, reference_id, employee_id, location_id, description], function (err) {
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

  const { voucher_no, date, warehouse_id, company_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description } = req.body;
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
          INSERT INTO wh_receipt_vouchers (voucher_no, date, warehouse_id, company_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [generatedVoucherNo, date, warehouse_id, company_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description], function (err) {
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
      INSERT INTO wh_receipt_vouchers (voucher_no, date, warehouse_id, company_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [generatedVoucherNo, date, warehouse_id, company_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description], function (err) {
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

  const { voucher_no, date, warehouse_id, debit_account, credit_account, amount, employee_id, location_id, description } = req.body;
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
          INSERT INTO wh_journal_vouchers (voucher_no, date, warehouse_id, debit_account, credit_account, amount, employee_id, location_id, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [generatedVoucherNo, date, warehouse_id, debit_account, credit_account, amount, employee_id, location_id, description], function (err) {
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
      INSERT INTO wh_journal_vouchers (voucher_no, date, warehouse_id, debit_account, credit_account, amount, employee_id, location_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [generatedVoucherNo, date, warehouse_id, debit_account, credit_account, amount, employee_id, location_id, description], function (err) {
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
      SUM(COALESCE(NULLIF(total_qty, 0), quantity)) as total_quantity, 
      SUM(COALESCE(NULLIF(net_amount_payable, 0), amount)) as total_amount 
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
      (SELECT COALESCE(SUM(COALESCE(NULLIF(net_amount_payable, 0), amount)), 0) FROM wh_purchase_vouchers WHERE warehouse_id = w.id) as purchase_amount,
      (SELECT COALESCE(SUM(amount), 0) FROM wh_sale_vouchers WHERE warehouse_id = w.id) - 
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
  const q = "SELECT * FROM wh_purchase_vouchers WHERE id = ?";
  db.get(q, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Not found" });
    if (!req.user) return res.status(403).json({ error: "Authentication required" });

    const doc = new PDFDocument({ margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    const filename = `purchase_${row.voucher_no || id}.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    doc.fontSize(18).text('Agri Rise Pvt Ltd', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(14).text(`Purchase Voucher`, { align: 'center' });
    doc.moveDown();

    const fields = [
      ['Voucher No', row.voucher_no || id],
      ['Date', row.date],
      ['Warehouse ID', row.warehouse_id],
      ['Farmer ID', row.farmer_id],
      ['Product ID', row.product_id],
      ['Quantity', row.quantity],
      ['Rate', row.rate],
      ['Amount', row.amount],
      ['Net Payable', row.net_amount_payable],
      ['Description', row.description || '']
    ];

    fields.forEach(f => {
      doc.fontSize(12).text(`${f[0]}: ${f[1]}`);
    });

    doc.end();
  });
});

module.exports = router;
