const express = require("express");
const router = express.Router();
const db = require("../db");
const { userHasPermission } = require("../middleware/auth");
const { canAccessWarehouse, assignedWarehouseFilter } = require("../helpers/access");

const safeNumber = (v) => (v === undefined || v === null || v === "" ? 0 : Number(v));
const safeText = (v) => (v ? v : null);
const formatOutwardVoucher = (slNo) => `OUT-${String(slNo).padStart(4, "0")}`;

function getAvailableWarehouseStock({ warehouse_id, product_id, outwardId }, callback) {
  const params = [safeNumber(product_id), safeNumber(warehouse_id)];
  let excludeClause = "";

  if (outwardId) {
    excludeClause = "AND o.id <> ?";
    params.push(safeNumber(outwardId));
  }

  const sql = `
    SELECT
      IFNULL((
        SELECT SUM(i.remaining_qty)
        FROM inward i
        WHERE i.product_id = ?
          AND i.warehouse_id = ?
      ), 0) AS current_stock,
      IFNULL((
        SELECT SUM(
          MAX(
            (IFNULL(o.quantity, 0) - IFNULL((
              SELECT SUM(a.qty)
              FROM adjustment a
              WHERE a.outward_id = o.id
            ), 0)),
            0
          )
        )
        FROM outward o
        WHERE o.product_id = ?
          AND o.warehouse_id = ?
          AND o.status IN ('Pending', 'Partial')
          ${excludeClause}
      ), 0) AS reserved_stock
  `;

  const queryParams = [params[0], params[1], params[0], params[1], ...params.slice(2)];
  db.get(sql, queryParams, (err, row) => {
    if (err) return callback(err);

    const currentStock = Number(row?.current_stock) || 0;
    const reservedStock = Number(row?.reserved_stock) || 0;
    return callback(null, {
      currentStock,
      reservedStock,
      availableStock: Math.max(currentStock - reservedStock, 0),
    });
  });
}

function validateOutwardStock({ warehouse_id, product_id, qty, outwardId }, callback) {
  getAvailableWarehouseStock({ warehouse_id, product_id, outwardId }, (err, stock) => {
    if (err) return callback(err);

    if (stock.availableStock < qty) {
      return callback(null, {
        ok: false,
        error: `Not enough stock in this warehouse. Available stock is ${stock.availableStock.toFixed(2)}.`,
      });
    }

    return callback(null, { ok: true, stock });
  });
}

router.get("/available-stock", (req, res) => {
  if (!userHasPermission(req.user, "outward.view") && !userHasPermission(req.user, "outward.create") && !userHasPermission(req.user, "outward.edit")) {
    return res.status(403).json({ error: "You do not have permission to view outward stock" });
  }

  const warehouseId = safeNumber(req.query.warehouse_id);
  const productId = safeNumber(req.query.product_id);
  const outwardId = safeNumber(req.query.outward_id);

  if (!warehouseId || !productId) {
    return res.json({
      currentStock: 0,
      reservedStock: 0,
      availableStock: 0,
    });
  }

  if (!canAccessWarehouse(req.user, warehouseId)) {
    return res.status(403).json({ error: "You can only view stock for your assigned warehouse" });
  }

  getAvailableWarehouseStock({ warehouse_id: warehouseId, product_id: productId, outwardId }, (err, stock) => {
    if (err) return res.status(500).json({ error: err.message });
    return res.json(stock);
  });
});

router.get("/pending", (req, res) => {
  if (!userHasPermission(req.user, "outward.view")) {
    return res.status(403).json({ error: "You do not have permission to view outward entries" });
  }

  const warehouseScope = assignedWarehouseFilter(req.user, "o.warehouse_id");
  const sql = `
    SELECT o.*, 
      w.name AS warehouse_name,
      p.name AS product_name,
      c.name AS company_name,
      ca.account_name AS party_name
    FROM outward o
    LEFT JOIN warehouses w ON o.warehouse_id = w.id
    LEFT JOIN products p ON o.product_id = p.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN company_accounts ca ON o.company_account_id = ca.id
    WHERE o.status IN ('Pending','Partial')
    ${warehouseScope.clause}
    ORDER BY o.id DESC
  `;

  db.all(sql, warehouseScope.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    return res.json(rows);
  });
});

router.put("/complete/:id", (req, res) => {
  if (!userHasPermission(req.user, "outward.edit")) {
    return res.status(403).json({ error: "You do not have permission to complete outward entries" });
  }

  const outwardId = req.params.id;

  db.get(`SELECT * FROM outward WHERE id=?`, [outwardId], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: "Outward not found" });
    }
    if (!canAccessWarehouse(req.user, row.warehouse_id)) {
      return res.status(403).json({ error: "You can only update entries for your assigned warehouse" });
    }

    let remaining = Number(row.quantity) || 0;

    db.serialize(() => {
      db.run("BEGIN TRANSACTION");

      db.all(
        `
        SELECT * FROM inward 
        WHERE product_id=? 
          AND warehouse_id=? 
          AND remaining_qty > 0
        ORDER BY id ASC
        `,
        [row.product_id, row.warehouse_id],
        (err2, inwardRows) => {
          if (err2) {
            db.run("ROLLBACK");
            return res.status(500).json({ error: err2.message });
          }

          const processNext = (index) => {
            if (index >= inwardRows.length || remaining <= 0) {
              return finish();
            }

            const inw = inwardRows[index];
            const useQty = Math.min(Number(inw.remaining_qty), remaining);

            db.run(
              `UPDATE inward SET remaining_qty = remaining_qty - ? WHERE id=?`,
              [useQty, inw.id],
              (err3) => {
                if (err3) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: err3.message });
                }

                db.run(
                  `INSERT INTO adjustment (outward_id, inward_id, qty) VALUES (?, ?, ?)`,
                  [outwardId, inw.id, useQty],
                  (err4) => {
                    if (err4) {
                      db.run("ROLLBACK");
                      return res.status(500).json({ error: err4.message });
                    }

                    remaining -= useQty;
                    processNext(index + 1);
                  }
                );
              }
            );
          };

          const finish = () => {
            const status = remaining > 0 ? "Partial" : "Completed";

            db.run(`UPDATE outward SET status=? WHERE id=?`, [status, outwardId], (err5) => {
              if (err5) {
                db.run("ROLLBACK");
                return res.status(500).json({ error: err5.message });
              }

              db.run("COMMIT", (err6) => {
                if (err6) return res.status(500).json({ error: err6.message });
                return res.json({
                  message: "FIFO Adjustment Done",
                  remaining_qty: remaining,
                  status,
                });
              });
            });
          };

          processNext(0);
        }
      );
    });
  });
});

router.get("/", (req, res) => {
  if (!userHasPermission(req.user, "outward.view")) {
    return res.status(403).json({ error: "You do not have permission to view outward entries" });
  }

  const warehouseScope = assignedWarehouseFilter(req.user, "o.warehouse_id");
  const sql = `
    SELECT o.*, 
      l.name AS location_name,
      e.name AS employee_name,
      w.name AS warehouse_name,
      p.name AS product_name,
      c.name AS company_name,
      ca.account_name AS party_name
    FROM outward o
    LEFT JOIN locations l ON o.location_id = l.id
    LEFT JOIN employees e ON o.employee_id = e.id
    LEFT JOIN warehouses w ON o.warehouse_id = w.id
    LEFT JOIN products p ON o.product_id = p.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN company_accounts ca ON o.company_account_id = ca.id
    WHERE 1=1
    ${warehouseScope.clause}
    ORDER BY o.id DESC
  `;

  db.all(sql, warehouseScope.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    return res.json(rows);
  });
});

router.post("/", (req, res) => {
  if (!userHasPermission(req.user, "outward.create")) {
    return res.status(403).json({ error: "You do not have permission to create outward entries" });
  }

  const {
    date,
    employee_id,
    location_id,
    warehouse_id,
    product_id,
    company_id,
    company_account_id,
    buyer_name,
    consignee_name,
    lorry_no,
    weight,
    quantity,
    rate,
    inv_no,
    self_loading,
  } = req.body;

  const qty = safeNumber(quantity) || safeNumber(weight);
  const rateVal = safeNumber(rate);
  const amount = qty * rateVal;
  const isSelfLoading = String(self_loading || "No").trim().toLowerCase() === "yes";
  const normalizedWarehouseId = isSelfLoading ? null : safeNumber(warehouse_id);

  if (!isSelfLoading && !canAccessWarehouse(req.user, warehouse_id)) {
    return res.status(403).json({ error: "You can only create entries for your assigned warehouse" });
  }

  const continueInsert = () => {
    db.get("SELECT IFNULL(MAX(sl_no),0)+1 as sl FROM outward", (err, row) => {
      if (err) return res.status(500).json({ error: err.message });

      const sl_no = row?.sl || 1;
      const voucher_no = formatOutwardVoucher(sl_no);

      db.run(
        `
        INSERT INTO outward (
          sl_no, voucher_no, date, employee_id, location_id, warehouse_id,
          product_id, company_id, company_account_id,
          buyer_name, consignee_name,
          lorry_no, weight, quantity, rate, amount,
          inv_no, self_loading,
          status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          sl_no,
          voucher_no,
          safeText(date),
          safeNumber(employee_id),
          safeNumber(location_id),
          normalizedWarehouseId,
          safeNumber(product_id),
          safeNumber(company_id),
          safeNumber(company_account_id),
          safeText(buyer_name),
          safeText(consignee_name),
          safeText(lorry_no),
          safeNumber(weight),
          qty,
          rateVal,
          amount,
          safeText(inv_no),
          safeText(self_loading) || "No",
          "Pending",
        ],
        function onInsert(err2) {
          if (err2) {
            return res.status(500).json({ error: err2.message });
          }

          return res.json({
            id: this.lastID,
            message: "Outward Saved",
          });
        }
      );
    });
  };

  if (isSelfLoading) {
    return continueInsert();
  }

  validateOutwardStock({ warehouse_id, product_id, qty }, (stockErr, validation) => {
    if (stockErr) {
      return res.status(500).json({ error: stockErr.message });
    }
    if (!validation?.ok) {
      return res.status(400).json({ error: validation.error });
    }
    return continueInsert();
  });
});

router.put("/:id", (req, res) => {
  if (!userHasPermission(req.user, "outward.edit")) {
    return res.status(403).json({ error: "You do not have permission to edit outward entries" });
  }

  const {
    date,
    employee_id,
    location_id,
    warehouse_id,
    product_id,
    company_id,
    company_account_id,
    buyer_name,
    consignee_name,
    lorry_no,
    weight,
    quantity,
    rate,
    inv_no,
    self_loading,
  } = req.body;

  const qty = safeNumber(quantity) || safeNumber(weight);
  const rateVal = safeNumber(rate);
  const amount = qty * rateVal;
  const isSelfLoading = String(self_loading || "No").trim().toLowerCase() === "yes";
  const normalizedWarehouseId = isSelfLoading ? null : safeNumber(warehouse_id);

  db.get(`SELECT warehouse_id FROM outward WHERE id = ?`, [req.params.id], (findErr, row) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!row) return res.status(404).json({ error: "Outward not found" });

    const canAccessExistingWarehouse = !row.warehouse_id || canAccessWarehouse(req.user, row.warehouse_id);
    const canAccessNewWarehouse = isSelfLoading || canAccessWarehouse(req.user, warehouse_id);

    if (!canAccessExistingWarehouse || !canAccessNewWarehouse) {
      return res.status(403).json({ error: "You can only edit entries for your assigned warehouse" });
    }

    const continueUpdate = () => {
      db.run(
        `
        UPDATE outward SET
          date=?, employee_id=?, location_id=?, warehouse_id=?,
          product_id=?, company_id=?, company_account_id=?,
          buyer_name=?, consignee_name=?,
          lorry_no=?, weight=?, quantity=?, rate=?, amount=?,
          inv_no=?, self_loading=?,
          status='Pending'
        WHERE id=?
        `,
        [
          safeText(date),
          safeNumber(employee_id),
          safeNumber(location_id),
          normalizedWarehouseId,
          safeNumber(product_id),
          safeNumber(company_id),
          safeNumber(company_account_id),
          safeText(buyer_name),
          safeText(consignee_name),
          safeText(lorry_no),
          safeNumber(weight),
          qty,
          rateVal,
          amount,
          safeText(inv_no),
          safeText(self_loading) || "No",
          req.params.id,
        ],
        function onUpdate(err) {
          if (err) return res.status(500).json({ error: err.message });
          return res.json({ message: "Updated & Reset to Pending" });
        }
      );
    };

    if (isSelfLoading) {
      return continueUpdate();
    }

    validateOutwardStock({ warehouse_id, product_id, qty, outwardId: req.params.id }, (stockErr, validation) => {
      if (stockErr) {
        return res.status(500).json({ error: stockErr.message });
      }
      if (!validation?.ok) {
        return res.status(400).json({ error: validation.error });
      }
      return continueUpdate();
    });
  });
});

router.delete("/:id", (req, res) => {
  if (!userHasPermission(req.user, "outward.delete")) {
    return res.status(403).json({ error: "You do not have permission to delete outward entries" });
  }

  const id = req.params.id;

  db.get(`SELECT warehouse_id FROM outward WHERE id = ?`, [id], (findErr, outwardRow) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!outwardRow) return res.status(404).json({ error: "Outward not found" });
    if (!canAccessWarehouse(req.user, outwardRow.warehouse_id)) {
      return res.status(403).json({ error: "You can only delete entries for your assigned warehouse" });
    }

    db.get(`SELECT COUNT(*) as cnt FROM adjustment WHERE outward_id=?`, [id], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });

      if (row?.cnt > 0) {
        return res.status(400).json({
          error: "Cannot delete. Adjustment exists.",
        });
      }

      db.run(`DELETE FROM outward WHERE id=?`, [id], function (err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        return res.json({ deleted: this.changes });
      });
    });
  });
});

module.exports = router;

