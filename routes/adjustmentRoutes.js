const express = require("express");
const router = express.Router();
const db = require("../db");

function calculateMonthSlab(inwardDateStr, outwardDateStr) {
  const inwardDate = new Date(inwardDateStr);
  const outwardDate = new Date(outwardDateStr);

  const msPerDay = 1000 * 60 * 60 * 24;
  const daysDiff = Math.floor((outwardDate - inwardDate) / msPerDay);

  let monthsDiff = Math.floor(daysDiff / 30) + 1;
  if (monthsDiff < 1) monthsDiff = 1;

  return {
    daysDiff: daysDiff < 0 ? 0 : daysDiff,
    monthsDiff,
  };
}

function normalizeQty(value) {
  const qty = Number(value);
  if (!Number.isFinite(qty)) return 0;
  return Number(qty.toFixed(4));
}

function addQty(...values) {
  return normalizeQty(values.reduce((sum, value) => sum + normalizeQty(value), 0));
}

router.get("/parties", (req, res) => {
  const { warehouse_id, location_id, product_id } = req.query;
  const warehouseId = Number(warehouse_id) || null;
  const locationId = Number(location_id) || null;

  if (!warehouseId && !locationId) {
    return res.status(400).json({ error: "warehouse_id or location_id required" });
  }

  const productId = product_id ? Number(product_id) || null : null;
  const useWarehouse = Number.isFinite(warehouseId) && warehouseId > 0;
  const scopeValue = useWarehouse ? warehouseId : locationId;

  const sql = `
    SELECT DISTINCT id, name, source_type
    FROM (
      SELECT
        c.id,
        c.name,
        'inward' AS source_type
      FROM inward i
      LEFT JOIN companies c ON c.id = i.company_id
      WHERE ${useWarehouse ? 'i.warehouse_id = ?' : 'i.location_id = ?'}
        AND i.remaining_qty > 0
        AND i.company_id IS NOT NULL
        AND (? IS NULL OR i.product_id = ?)

      UNION

      SELECT
        c.id,
        c.name,
        'palti_lorry' AS source_type
      FROM palti_lorry_entries p
      LEFT JOIN warehouses w ON w.id = p.warehouse_id
      LEFT JOIN companies c ON c.id = p.company_id
      WHERE c.id IS NOT NULL
        AND ${useWarehouse ? 'p.warehouse_id = ?' : 'w.location_id = ?'}
        AND (IFNULL(p.balance, 0) - IFNULL((
          SELECT SUM(a.qty)
          FROM adjustment a
          WHERE a.palti_lorry_id = p.id
            AND COALESCE(a.source_type, 'inward') = 'palti_lorry'
        ), 0)) > 0
        AND (? IS NULL OR p.product_id = ?)
    )
    ORDER BY name ASC, source_type ASC
  `;

  db.all(sql, [scopeValue, productId, productId, scopeValue, productId, productId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

router.get("/inward/report", (req, res) => {
  const { warehouse_id, location_id, company_id, outward_date, source_type } = req.query;
  const warehouseId = Number(warehouse_id) || null;
  const locationId = Number(location_id) || null;

  if ((!warehouseId && !locationId) || !company_id || !outward_date) {
    return res.status(400).json({
      error: "warehouse_id or location_id, company_id and outward_date required",
    });
  }

  if (source_type === "palti_lorry") {
    const useWarehouse = Number.isFinite(warehouseId) && warehouseId > 0;
    const scopeValue = useWarehouse ? warehouseId : locationId;
    const paltiSql = `
      SELECT
        p.id,
        p.voucher_no,
        p.expense_date AS date,
        COALESCE(NULLIF(TRIM(p.reg_lorry_no), ''), NULLIF(TRIM(p.new_lorry_no), ''), '-') AS lorry_no,
        p.balance AS gross_qty,
        p.balance AS remaining_qty,
        w.name AS warehouse_name,
        c.name AS company_name,
        loc.name AS location_name,
        IFNULL((
          SELECT SUM(a.qty)
          FROM adjustment a
          WHERE a.palti_lorry_id = p.id
            AND COALESCE(a.source_type, 'inward') = 'palti_lorry'
        ), 0) AS already_adjusted
      FROM palti_lorry_entries p
      INNER JOIN warehouses w ON w.id = p.warehouse_id
      LEFT JOIN locations loc ON w.location_id = loc.id
      LEFT JOIN companies c ON c.id = p.company_id
      WHERE p.company_id = ?
        AND ${useWarehouse ? 'p.warehouse_id = ?' : 'w.location_id = ?'}
      ORDER BY p.expense_date ASC, p.id ASC
    `;

    return db.all(paltiSql, [company_id, scopeValue], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const result = (rows || [])
        .map((row) => {
          const slab = calculateMonthSlab(row.date, outward_date);
          const grossQty = Number(row.gross_qty) || 0;
          const alreadyAdjusted = Number(row.already_adjusted) || 0;
          const availableQty = grossQty - alreadyAdjusted;

          return {
            ...row,
            source_type: "palti_lorry",
            outward_date,
            days_diff: slab.daysDiff,
            months_diff: slab.monthsDiff,
            shortage_qty: 0,
            warehouse_chgs: 0,
            net_opening_qty: Number(grossQty.toFixed(4)),
            already_adjusted: Number(alreadyAdjusted.toFixed(4)),
            available_qty: Number(Math.max(availableQty, 0).toFixed(4)),
          };
        })
        .filter((row) => row.available_qty > 0);

      return res.json(result);
    });
  }

  const useWarehouse = Number.isFinite(warehouseId) && warehouseId > 0;
  const scopeValue = useWarehouse ? warehouseId : locationId;
  const sql = `
    SELECT
      i.id,
      i.voucher_no,
      i.date,
      i.lorry_no,
      i.weight AS inward_qty,
      i.weight AS gross_qty,
      i.remaining_qty,
      w.name AS warehouse_name,
      c.name AS company_name,
      IFNULL((
        SELECT SUM(a.qty)
        FROM adjustment a
        WHERE a.inward_id = i.id
      ), 0) AS already_adjusted
    FROM inward i
    LEFT JOIN warehouses w ON w.id = i.warehouse_id
    LEFT JOIN companies c ON c.id = i.company_id
    WHERE ${useWarehouse ? 'i.warehouse_id = ?' : 'i.location_id = ?'}
      AND i.company_id = ?
    ORDER BY i.date ASC, i.id ASC
  `;

  db.all(sql, [scopeValue, company_id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const result = rows
      .map((row) => {
        const slab = calculateMonthSlab(row.date, outward_date);
        const grossQty = Number(row.gross_qty) || 0;
        const alreadyAdjusted = Number(row.already_adjusted) || 0;
        const shortageQty = grossQty * 0.02 * slab.monthsDiff;
        const netOpeningQty = grossQty - shortageQty;
        const availableQty = netOpeningQty - alreadyAdjusted;

        return {
          ...row,
          source_type: "inward",
          outward_date,
          days_diff: slab.daysDiff,
          months_diff: slab.monthsDiff,
          gross_qty: Number(grossQty.toFixed(4)),
          shortage_qty: Number(shortageQty.toFixed(4)),
          warehouse_chgs: Number(shortageQty.toFixed(4)),
          net_opening_qty: Number(netOpeningQty.toFixed(4)),
          already_adjusted: Number(alreadyAdjusted.toFixed(4)),
          available_qty: Number(Math.max(availableQty, 0).toFixed(4)),
        };
      })
      .filter((row) => row.available_qty > 0);

    res.json(result);
  });
});

router.post("/final-save", (req, res) => {
  const { outward_id, adjustments } = req.body;

  if (!outward_id || !Array.isArray(adjustments) || adjustments.length === 0) {
    return res.status(400).json({ error: "Data required" });
  }

  db.get(`SELECT * FROM outward WHERE id=?`, [outward_id], (err, outward) => {
    if (err || !outward) {
      return res.status(404).json({ error: "Outward not found" });
    }

    const outwardQty = normalizeQty(outward.quantity);
    const outwardWarehouseId = Number(outward.warehouse_id) || null;
    const outwardLocationId = Number(outward.location_id) || null;
    const totalAdjust = addQty(...adjustments.map((a) => normalizeQty(a.qty || 0)));

    db.get(
      `SELECT IFNULL(SUM(qty), 0) AS alreadyAdjusted FROM adjustment WHERE outward_id=?`,
      [outward_id],
      (err2, row2) => {
        if (err2) return res.status(500).json({ error: err2.message });

        const alreadyAdj = normalizeQty(row2?.alreadyAdjusted);
        const remainingToAdjust = normalizeQty(outwardQty - alreadyAdj);

        if (remainingToAdjust <= 0) {
          return res.status(400).json({ error: "This outward is already fully adjusted" });
        }

        if (totalAdjust > remainingToAdjust) {
          return res.status(400).json({
            error: `Total adjustment cannot exceed remaining ${remainingToAdjust}`,
          });
        }

        db.serialize(() => {
          db.run("BEGIN TRANSACTION");

          let i = 0;

          const rollback400 = (message) => {
            db.run("ROLLBACK", () => res.status(400).json({ error: message }));
          };

          const rollback500 = (message) => {
            db.run("ROLLBACK", () => res.status(500).json({ error: message }));
          };

          const saveNext = () => {
            if (i >= adjustments.length) {
              const finalStatus =
                totalAdjust === remainingToAdjust ? "Completed" : "Partial";

              db.run(
                `UPDATE outward SET status=? WHERE id=?`,
                [finalStatus, outward_id],
                (statusErr) => {
                  if (statusErr) return rollback500(statusErr.message);

                  db.run("COMMIT", (commitErr) => {
                    if (commitErr) return rollback500(commitErr.message);
                    res.json({
                      message: "Adjustment Saved Successfully",
                      status: finalStatus,
                    });
                  });
                }
              );
              return;
            }

            const adj = adjustments[i];
            const adjQty = normalizeQty(adj.qty);

            if (!adj.company_id || adjQty <= 0) {
              return rollback400("Invalid adjustment row");
            }

            if ((adj.source_type || "inward") === "palti_lorry") {
              if (!adj.palti_lorry_id) {
                return rollback400("Invalid Palti Lorry adjustment row");
              }

              return db.get(
                `
                SELECT
                  p.id,
                  p.balance,
                  p.warehouse_id,
                  p.company_id,
                  w.location_id,
                  IFNULL((
                    SELECT SUM(a.qty)
                    FROM adjustment a
                    WHERE a.palti_lorry_id = p.id
                      AND COALESCE(a.source_type, 'inward') = 'palti_lorry'
                  ), 0) AS already_adjusted
                FROM palti_lorry_entries p
                LEFT JOIN warehouses w ON w.id = p.warehouse_id
                WHERE p.id = ?
                `,
                [adj.palti_lorry_id],
                (paltiErr, paltiRow) => {
                  if (paltiErr) return rollback500(paltiErr.message);
                  if (!paltiRow) return rollback400(`Invalid palti_lorry_id ${adj.palti_lorry_id}`);

                  if (Number(paltiRow.company_id) !== Number(adj.company_id)) {
                    return rollback400(`Company mismatch for palti_lorry_id ${adj.palti_lorry_id}`);
                  }

                  // Check warehouse/location compatibility
                  if (outwardWarehouseId) {
                    // If outward is warehouse-specific, palti must be in same warehouse
                    if (Number(paltiRow.warehouse_id) !== outwardWarehouseId) {
                      return rollback400(`Warehouse mismatch for palti_lorry_id ${adj.palti_lorry_id}`);
                    }
                  } else if (outwardLocationId) {
                    // If outward is location-specific, palti's warehouse must be in same location
                    const paltiLocationId = paltiRow.location_id;
                    if (Number(paltiLocationId || 0) !== outwardLocationId) {
                      return rollback400(`Location mismatch for palti_lorry_id ${adj.palti_lorry_id}`);
                    }
                  }

                  const grossQty = normalizeQty(paltiRow.balance);
                  const alreadyAdjustedForThisPalti = normalizeQty(paltiRow.already_adjusted);
                  const availableQty = normalizeQty(grossQty - alreadyAdjustedForThisPalti);

                  if (adjQty > availableQty) {
                    return rollback400(
                      `Adjusted qty exceeds available qty for palti_lorry_id ${adj.palti_lorry_id}`
                    );
                  }

                  db.run(
                    `INSERT INTO adjustment (outward_id, inward_id, palti_lorry_id, source_type, qty) VALUES (?, ?, ?, ?, ?)`,
                    [outward_id, null, adj.palti_lorry_id, "palti_lorry", adj.qty],
                    (insertErr) => {
                      if (insertErr) return rollback500(insertErr.message);

                      i += 1;
                      saveNext();
                    }
                  );
                }
              );
            }

            if (!adj.inward_id) {
              return rollback400("Invalid inward adjustment row");
            }

            db.get(
              `
              SELECT
                i.id,
                i.date,
                i.weight,
                i.remaining_qty,
                i.warehouse_id,
                i.location_id,
                i.company_id,
                w.location_id AS warehouse_location_id,
                IFNULL((
                  SELECT SUM(a.qty)
                  FROM adjustment a
                  WHERE a.inward_id = i.id
                ), 0) AS already_adjusted
              FROM inward i
              LEFT JOIN warehouses w ON w.id = i.warehouse_id
              WHERE i.id=?
              `,
              [adj.inward_id],
              (inwardErr, inwardRow) => {
                if (inwardErr) return rollback500(inwardErr.message);
                if (!inwardRow) return rollback400(`Invalid inward_id ${adj.inward_id}`);

                // Check warehouse/location compatibility
                if (outwardWarehouseId) {
                  // If outward is warehouse-specific, inward must be in same warehouse
                  if (Number(inwardRow.warehouse_id) !== outwardWarehouseId) {
                    return rollback400(`Warehouse mismatch for inward_id ${adj.inward_id}`);
                  }
                } else if (outwardLocationId) {
                  // If outward is location-specific, inward's warehouse must be in same location
                  const inwardLocationId = inwardRow.location_id || inwardRow.warehouse_location_id;
                  if (Number(inwardLocationId || 0) !== outwardLocationId) {
                    return rollback400(`Location mismatch for inward_id ${adj.inward_id}`);
                  }
                }

                if (Number(inwardRow.company_id) !== Number(adj.company_id)) {
                  return rollback400(`Company mismatch for inward_id ${adj.inward_id}`);
                }

                const slab = calculateMonthSlab(inwardRow.date, outward.date);
                const grossQty = normalizeQty(inwardRow.weight);
                const alreadyAdjustedForThisInward = normalizeQty(inwardRow.already_adjusted);
                const shortageQty = normalizeQty(grossQty * 0.02 * slab.monthsDiff);
                const netOpeningQty = normalizeQty(grossQty - shortageQty);
                const availableQty = normalizeQty(netOpeningQty - alreadyAdjustedForThisInward);

                if (adjQty > availableQty) {
                  return rollback400(
                    `Adjusted qty exceeds available qty for inward_id ${adj.inward_id}`
                  );
                }

                if (adjQty > normalizeQty(inwardRow.remaining_qty || 0)) {
                  return rollback400(
                    `Adjusted qty exceeds physical remaining qty for inward_id ${adj.inward_id}`
                  );
                }

                db.run(
                  `UPDATE inward SET remaining_qty = remaining_qty - ? WHERE id=?`,
                  [adj.qty, adj.inward_id],
                  (updateErr) => {
                    if (updateErr) return rollback500(updateErr.message);

                    db.run(
                      `INSERT INTO adjustment (outward_id, inward_id, palti_lorry_id, source_type, qty) VALUES (?, ?, ?, ?, ?)`,
                      [outward_id, adj.inward_id, null, "inward", adj.qty],
                      (insertErr) => {
                        if (insertErr) return rollback500(insertErr.message);

                        i += 1;
                        saveNext();
                      }
                    );
                  }
                );
              }
            );
          };

          saveNext();
        });
      }
    );
  });
});

router.put("/log/:id", (req, res) => {
  const { qty } = req.body;
  const adjustmentId = req.params.id;

  if (!qty || Number(qty) <= 0) {
    return res.status(400).json({ error: "Valid qty required" });
  }

  db.get(
    `
    SELECT
      a.*,
      o.quantity AS outward_qty,
      o.id AS outward_id,
      o.date AS outward_date,
      i.remaining_qty,
      i.date AS inward_date,
      i.weight AS inward_weight,
      p.balance AS palti_balance
    FROM adjustment a
    LEFT JOIN outward o ON o.id = a.outward_id
    LEFT JOIN inward i ON i.id = a.inward_id
    LEFT JOIN palti_lorry_entries p ON p.id = a.palti_lorry_id
    WHERE a.id = ?
    `,
    [adjustmentId],
    (err, row) => {
      if (err || !row) {
        return res.status(404).json({ error: "Adjustment not found" });
      }

      const oldQty = Number(row.qty) || 0;
      const newQty = Number(qty);
      const isPalti = String(row.source_type || "inward") === "palti_lorry";
      const currentRemaining = Number(row.remaining_qty) || 0;
      const grossQty = isPalti ? Number(row.palti_balance) || 0 : Number(row.inward_weight) || 0;

      const slab = isPalti ? { monthsDiff: 1 } : calculateMonthSlab(row.inward_date, row.outward_date);
      const shortageQty = isPalti ? 0 : grossQty * 0.02 * slab.monthsDiff;
      const netOpeningQty = grossQty - shortageQty;

      db.get(
        `SELECT IFNULL(SUM(qty), 0) AS totalAdj FROM adjustment WHERE outward_id=? AND id<>?`,
        [row.outward_id, adjustmentId],
        (err2, outwardSumRow) => {
          if (err2) return res.status(500).json({ error: err2.message });

          const otherOutwardAdjusted = Number(outwardSumRow?.totalAdj) || 0;
          if (otherOutwardAdjusted + newQty > Number(row.outward_qty)) {
            return res.status(400).json({ error: "Updated qty exceeds outward qty" });
          }

          db.get(
            isPalti
              ? `SELECT IFNULL(SUM(qty), 0) AS totalAdj FROM adjustment WHERE palti_lorry_id=? AND id<>? AND COALESCE(source_type, 'inward')='palti_lorry'`
              : `SELECT IFNULL(SUM(qty), 0) AS totalAdj FROM adjustment WHERE inward_id=? AND id<>?`,
            [isPalti ? row.palti_lorry_id : row.inward_id, adjustmentId],
            (err3, inwardSumRow) => {
              if (err3) return res.status(500).json({ error: err3.message });

              const otherInwardAdjusted = Number(inwardSumRow?.totalAdj) || 0;
              const availableQty = netOpeningQty - otherInwardAdjusted;

              if (newQty > availableQty) {
                return res.status(400).json({ error: "Updated qty exceeds available qty" });
              }

              if (!isPalti && newQty > currentRemaining + oldQty) {
                return res.status(400).json({ error: "Not enough physical stock available" });
              }

              db.run("BEGIN TRANSACTION", (beginErr) => {
                if (beginErr) {
                  return res.status(500).json({ error: beginErr.message });
                }

                db.run(
                  `UPDATE adjustment SET qty=? WHERE id=?`,
                  [newQty, adjustmentId],
                  (uErr) => {
                    if (uErr) {
                      db.run("ROLLBACK", () => {
                        return res.status(500).json({ error: uErr.message });
                      });
                      return;
                    }

                    const continueAfterSourceUpdate = () => {
                      db.get(
                        `SELECT quantity FROM outward WHERE id=?`,
                        [row.outward_id],
                        (oErr, oRow) => {
                          if (oErr || !oRow) {
                            db.run("ROLLBACK", () => {
                              return res.status(500).json({ error: "Outward not found" });
                            });
                            return;
                          }

                          db.get(
                            `SELECT IFNULL(SUM(qty), 0) AS totalAdj FROM adjustment WHERE outward_id=?`,
                            [row.outward_id],
                            (sErr, finalRow) => {
                              if (sErr) {
                                db.run("ROLLBACK", () => {
                                  return res.status(500).json({ error: sErr.message });
                                });
                                return;
                              }

                              const totalAdj = Number(finalRow?.totalAdj) || 0;
                              const status =
                                totalAdj >= Number(oRow.quantity)
                                  ? "Completed"
                                  : totalAdj > 0
                                  ? "Partial"
                                  : "Pending";

                              db.run(
                                `UPDATE outward SET status=? WHERE id=?`,
                                [status, row.outward_id],
                                (stErr) => {
                                  if (stErr) {
                                    db.run("ROLLBACK", () => {
                                      return res.status(500).json({ error: stErr.message });
                                    });
                                    return;
                                  }

                                  db.run("COMMIT", (cErr) => {
                                    if (cErr) return res.status(500).json({ error: cErr.message });
                                    return res.json({ message: "Adjustment updated successfully" });
                                  });
                                }
                              );
                            }
                          );
                        }
                      );
                    };

                    if (isPalti) {
                      return continueAfterSourceUpdate();
                    }

                    db.run(
                      `UPDATE inward SET remaining_qty = remaining_qty + ? WHERE id=?`,
                      [oldQty - newQty, row.inward_id],
                      (iErr) => {
                        if (iErr) {
                          db.run("ROLLBACK", () => {
                            return res.status(500).json({ error: iErr.message });
                          });
                          return;
                        }

                        return continueAfterSourceUpdate();
                      }
                    );
                  }
                );
              });
            }
          );
        }
      );
    }
  );
});

router.delete("/log/:id", (req, res) => {
  const adjustmentId = Number(req.params.id);
  if (!Number.isFinite(adjustmentId) || adjustmentId <= 0) {
    return res.status(400).json({ error: "Invalid adjustment id" });
  }

  db.get(`SELECT * FROM adjustment WHERE id=?`, [adjustmentId], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: "Adjustment not found" });
    }

    const isPalti = String(row.source_type || "inward") === "palti_lorry";
    const adjustmentQty = normalizeQty(row.qty || 0);

    db.run("BEGIN TRANSACTION", (beginErr) => {
      if (beginErr) {
        return res.status(500).json({ error: beginErr.message });
      }

      db.run(`DELETE FROM adjustment WHERE id=?`, [adjustmentId], (dErr) => {
        if (dErr) {
          db.run("ROLLBACK", () => {
            return res.status(500).json({ error: dErr.message });
          });
          return;
        }

        const updateOutwardStatus = () => {
          db.get(`SELECT quantity FROM outward WHERE id=?`, [row.outward_id], (oErr, oRow) => {
            if (oErr || !oRow) {
              db.run("ROLLBACK", () => {
                return res.status(500).json({ error: "Outward not found" });
              });
              return;
            }

            db.get(
              `SELECT IFNULL(SUM(qty), 0) AS totalAdj FROM adjustment WHERE outward_id=?`,
              [row.outward_id],
              (sErr, finalRow) => {
                if (sErr) {
                  db.run("ROLLBACK", () => {
                    return res.status(500).json({ error: sErr.message });
                  });
                  return;
                }

                const totalAdj = normalizeQty(finalRow?.totalAdj || 0);
                const outwardQty = normalizeQty(Number(oRow.quantity) || 0);
                const status =
                  totalAdj >= outwardQty
                    ? "Completed"
                    : totalAdj > 0
                    ? "Partial"
                    : "Pending";

                db.run(
                  `UPDATE outward SET status=? WHERE id=?`,
                  [status, row.outward_id],
                  (stErr) => {
                    if (stErr) {
                      db.run("ROLLBACK", () => {
                        return res.status(500).json({ error: stErr.message });
                      });
                      return;
                    }

                    db.run("COMMIT", (cErr) => {
                      if (cErr) return res.status(500).json({ error: cErr.message });
                      return res.json({ message: "Adjustment deleted successfully" });
                    });
                  }
                );
              }
            );
          });
        };

        if (isPalti) {
          return updateOutwardStatus();
        }

        db.run(
          `UPDATE inward SET remaining_qty = remaining_qty + ? WHERE id=?`,
          [adjustmentQty, row.inward_id],
          (uErr) => {
            if (uErr) {
              db.run("ROLLBACK", () => {
                return res.status(500).json({ error: uErr.message });
              });
              return;
            }
            return updateOutwardStatus();
          }
        );
      });
    });
  });
});

router.get("/:id", (req, res) => {
  db.all(
    `
    SELECT
      a.id,
      a.qty,
      COALESCE(i.voucher_no, p.voucher_no) AS inward_voucher,
      COALESCE(NULLIF(TRIM(i.lorry_no), ''), NULLIF(TRIM(p.reg_lorry_no), ''), NULLIF(TRIM(p.new_lorry_no), ''), '-') AS lorry_no,
      COALESCE(i.date, p.expense_date) AS inward_date,
      COALESCE(c.name, cp.name) AS company_name,
      COALESCE(w.name, wp.name) AS warehouse_name,
      COALESCE(a.source_type, 'inward') AS source_type
    FROM adjustment a
    LEFT JOIN inward i ON a.inward_id = i.id
    LEFT JOIN palti_lorry_entries p ON a.palti_lorry_id = p.id
    LEFT JOIN companies c ON i.company_id = c.id
    LEFT JOIN companies cp ON p.company_id = cp.id
    LEFT JOIN warehouses w ON i.warehouse_id = w.id
    LEFT JOIN warehouses wp ON p.warehouse_id = wp.id
    WHERE a.outward_id=?
    ORDER BY a.id ASC
    `,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

module.exports = router;





