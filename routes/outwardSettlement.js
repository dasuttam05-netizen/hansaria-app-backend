const express = require("express");
const router = express.Router();
const db = require("../db");

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function getAdjustmentDetails(outwardId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        a.id,
        a.outward_id,
        COALESCE(a.source_type, 'inward') AS source_type,
        a.qty AS settlement_weight,
        COALESCE(i.voucher_no, p.voucher_no) AS inward_voucher_no,
        COALESCE(i.lorry_no, p.new_lorry_no, p.reg_lorry_no) AS lorry_no,
        COALESCE(i.date, p.expense_date) AS inward_date,
        COALESCE(c.name, cp.name) AS company_name,
        COALESCE(w.name, wp.name) AS warehouse_name
      FROM adjustment a
      LEFT JOIN inward i ON i.id = a.inward_id
      LEFT JOIN palti_lorry_entries p ON p.id = a.palti_lorry_id
      LEFT JOIN companies c ON c.id = i.company_id
      LEFT JOIN companies cp ON cp.id = p.company_id
      LEFT JOIN warehouses w ON w.id = i.warehouse_id
      LEFT JOIN warehouses wp ON wp.id = p.warehouse_id
      WHERE a.outward_id = ?
      ORDER BY a.id ASC
      `,
      [outwardId],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(rows || []);
      }
    );
  });
}

function calculateSettlement(data) {
  const dispatch_qty = num(data.dispatch_qty);
  const unloading_qty = num(data.unloading_qty);
  const settlement_weight = num(data.settlement_weight || unloading_qty);
  const sale_rate = num(data.sale_rate);
  const company_rate = num(data.company_rate);
  const freight = num(data.freight);
  const outward_labour_charges = num(data.outward_labour_charges);
  const other_charges = num(data.other_charges);
  const charge_bearer = data.charge_bearer === "company" ? "company" : "self";

  const shortage_qty = Math.max(dispatch_qty - unloading_qty, 0);
  const sale_amount = dispatch_qty * sale_rate;
  const company_amount = settlement_weight * company_rate;
  const gross_amount = Math.max(
    dispatch_qty * sale_rate - freight - outward_labour_charges - other_charges,
    0
  );
  const shortage_amount = shortage_qty * company_rate;
  const perMtCharges =
    dispatch_qty > 0
      ? (freight + outward_labour_charges + other_charges) / dispatch_qty
      : 0;
  const company_payable = company_amount - settlement_weight * perMtCharges - shortage_amount;
  const receivable_amount = gross_amount - company_payable;

  return {
    dispatch_qty,
    unloading_qty,
    billable_qty: shortage_qty,
    settlement_weight,
    sale_rate,
    company_rate,
    sale_amount,
    company_amount,
    gross_amount,
    receivable_amount,
    freight,
    outward_labour_charges,
    other_charges,
    charge_bearer,
    gross_profit: gross_amount,
    net_profit: receivable_amount,
    company_payable,
  };
}

function getApprovedLabourExpense(outwardId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        x.id,
        x.voucher_no,
        x.total_expense_amount,
        x.grand_total,
        COALESCE(SUM(
          CASE
            WHEN LOWER(TRIM(ei.particular_name)) LIKE '%labour%'
              OR LOWER(TRIM(ei.particular_name)) LIKE '%labor%'
            THEN IFNULL(ei.amount, 0)
            ELSE 0
          END
        ), 0) AS labour_item_amount
      FROM expenses x
      LEFT JOIN expense_items ei ON ei.expense_id = x.id
      WHERE x.outward_id = ?
        AND UPPER(TRIM(IFNULL(x.status, ''))) = 'CONFIRMED_BY_HO'
      GROUP BY x.id
      ORDER BY x.id ASC
      `,
      [outwardId],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        const items = (rows || []).map((row) => {
          const labourItemAmount = num(row.labour_item_amount);
          const fallbackAmount = num(row.total_expense_amount || row.grand_total);
          return {
            id: row.id,
            voucher_no: row.voucher_no,
            amount: labourItemAmount > 0 ? labourItemAmount : fallbackAmount,
          };
        }).filter((row) => row.amount > 0);

        resolve({
          amount: items.reduce((sum, item) => sum + num(item.amount), 0),
          count: items.length,
          vouchers: items.map((item) => item.voucher_no || `EXP-${item.id}`).filter(Boolean),
        });
      }
    );
  });
}

router.get("/:outward_id", async (req, res) => {
  const outwardId = req.params.outward_id;

  const sql = `
    SELECT
      s.*,
      o.date AS outward_date,
      o.voucher_no,
      o.inv_no,
      o.weight AS outward_weight,
      o.quantity AS outward_quantity,
      o.rate AS outward_rate,
      o.lorry_no,
      o.buyer_name,
      o.consignee_name,
      c.name AS company_name,
      ca.account_name AS account_name,
      w.name AS warehouse_name,
      COALESCE(o.location_id, w.location_id) AS effective_location_id,
      COALESCE(l.name, wl.name) AS location_name,
      p.name AS product_name
    FROM outward o
    LEFT JOIN outward_settlement s ON s.outward_id = o.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN company_accounts ca ON o.company_account_id = ca.id
    LEFT JOIN warehouses w ON o.warehouse_id = w.id
    LEFT JOIN locations l ON l.id = o.location_id
    LEFT JOIN locations wl ON wl.id = w.location_id
    LEFT JOIN products p ON o.product_id = p.id
    WHERE o.id = ?
  `;

  db.get(sql, [outwardId], async (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: "Outward not found" });
    }

    try {
      const adjustment_details = await getAdjustmentDetails(outwardId);
      const labourExpense = await getApprovedLabourExpense(outwardId);
      const totalSettlementWeight = adjustment_details.reduce(
        (sum, item) => sum + num(item.settlement_weight),
        0
      );

      const defaultDispatch = num(row.outward_quantity || row.outward_weight);

      const payload = {
        outward_id: Number(outwardId),
        outward_date: row.outward_date,
        voucher_no: row.voucher_no,
        lorry_no: row.lorry_no,
        buyer_name: row.buyer_name,
        consignee_name: row.consignee_name,
        company_name: row.company_name,
        account_name: row.account_name,
        warehouse_name: row.warehouse_name,
        location_id: row.effective_location_id || null,
        location_name: row.location_name || null,
        product_name: row.product_name,
        outward_quantity: defaultDispatch,
        labour_expense: labourExpense,
        adjustment_details: adjustment_details.map((item) => ({
          ...item,
          company_rate: num(row.company_rate ?? 0),
          amount: num(item.settlement_weight) * num(row.company_rate ?? 0),
        })),
        settlement: {
          id: row.id || null,
          dispatch_qty: row.dispatch_qty ?? defaultDispatch,
          unloading_qty: row.unloading_qty ?? totalSettlementWeight,
          settlement_weight: totalSettlementWeight,
          billable_qty: row.billable_qty ?? 0,
          sale_rate: row.sale_rate ?? num(row.outward_rate),
          company_rate: row.company_rate ?? 0,
          sale_amount: row.sale_amount ?? 0,
          company_amount: row.company_amount ?? 0,
          gross_amount: row.gross_amount ?? row.gross_profit ?? 0,
          receivable_amount: row.receivable_amount ?? row.net_profit ?? 0,
          freight: row.freight ?? 0,
          outward_labour_charges: row.outward_labour_charges ?? 0,
          other_charges: row.other_charges ?? 0,
          charge_bearer: row.charge_bearer || "self",
          gross_profit: row.gross_profit ?? 0,
          net_profit: row.net_profit ?? 0,
          company_payable: row.company_payable ?? 0,
          narration: row.narration || "",
        },
      };

      return res.json(payload);
    } catch (detailsError) {
      return res.status(500).json({ error: detailsError.message });
    }
  });
});

router.post("/save", async (req, res) => {
  const {
    outward_id,
    dispatch_qty,
    unloading_qty,
    sale_rate,
    company_rate,
    freight,
    outward_labour_charges,
    other_charges,
    charge_bearer,
    narration,
  } = req.body;

  if (!outward_id) {
    return res.status(400).json({ error: "outward_id required" });
  }

  db.get(`SELECT * FROM outward WHERE id = ?`, [outward_id], async (err, outward) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!outward) {
      return res.status(404).json({ error: "Outward not found" });
    }

    try {
      const adjustment_details = await getAdjustmentDetails(outward_id);
      const settlementWeight = adjustment_details.reduce(
        (sum, item) => sum + num(item.settlement_weight),
        0
      );

      const settlement = calculateSettlement({
        dispatch_qty: dispatch_qty ?? num(outward.quantity || outward.weight),
        unloading_qty,
        settlement_weight: settlementWeight,
        sale_rate,
        company_rate,
        freight,
        outward_labour_charges,
        other_charges,
        charge_bearer,
      });

      db.get(
        `SELECT id FROM outward_settlement WHERE outward_id = ?`,
        [outward_id],
        (checkErr, existing) => {
          if (checkErr) {
            return res.status(500).json({ error: checkErr.message });
          }

          const params = [
            settlement.dispatch_qty,
            settlement.unloading_qty,
            settlement.billable_qty,
            settlement.sale_rate,
            settlement.company_rate,
            settlement.sale_amount,
            settlement.company_amount,
            settlement.gross_amount,
            settlement.receivable_amount,
            settlement.freight,
            settlement.outward_labour_charges,
            settlement.other_charges,
            settlement.charge_bearer,
            settlement.gross_profit,
            settlement.net_profit,
            settlement.company_payable,
            narration || "",
          ];

          if (existing) {
            db.run(
              `
              UPDATE outward_settlement SET
                dispatch_qty = ?,
                unloading_qty = ?,
                billable_qty = ?,
                sale_rate = ?,
                company_rate = ?,
                sale_amount = ?,
                company_amount = ?,
                gross_amount = ?,
                receivable_amount = ?,
                freight = ?,
                outward_labour_charges = ?,
                other_charges = ?,
                charge_bearer = ?,
                gross_profit = ?,
                net_profit = ?,
                company_payable = ?,
                narration = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE outward_id = ?
              `,
              [...params, outward_id],
              (updateErr) => {
                if (updateErr) {
                  return res.status(500).json({ error: updateErr.message });
                }
                return res.json({ message: "Settlement updated successfully" });
              }
            );
          } else {
            db.run(
              `
              INSERT INTO outward_settlement (
                outward_id,
                dispatch_qty,
                unloading_qty,
                billable_qty,
                sale_rate,
                company_rate,
                sale_amount,
                company_amount,
                gross_amount,
                receivable_amount,
                freight,
                outward_labour_charges,
                other_charges,
                charge_bearer,
                gross_profit,
                net_profit,
                company_payable,
                narration
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `,
              [outward_id, ...params],
              (insertErr) => {
                if (insertErr) {
                  return res.status(500).json({ error: insertErr.message });
                }
                return res.json({ message: "Settlement saved successfully" });
              }
            );
          }
        }
      );
    } catch (detailsError) {
      return res.status(500).json({ error: detailsError.message });
    }
  });
});

router.get("/report/list", (req, res) => {
  const { from_date, to_date, company_id, warehouse_id } = req.query;

  const where = ["1=1"];
  const params = [];

  if (from_date) {
    where.push("o.date >= ?");
    params.push(from_date);
  }
  if (to_date) {
    where.push("o.date <= ?");
    params.push(to_date);
  }
  if (company_id) {
    where.push("o.company_id = ?");
    params.push(company_id);
  }
  if (warehouse_id) {
    where.push("o.warehouse_id = ?");
    params.push(warehouse_id);
  }

  const sql = `
    SELECT
      s.id,
      s.outward_id,
      o.date,
      o.voucher_no,
      o.inv_no,
      o.lorry_no,
      o.quantity AS outward_qty,
      c.name AS company_name,
      ca.account_name AS account_name,
      w.name AS warehouse_name,
      COALESCE(o.location_id, w.location_id) AS effective_location_id,
      COALESCE(l.name, wl.name) AS location_name,
      p.name AS product_name,
      o.buyer_name,
      o.consignee_name,
      s.dispatch_qty,
      s.unloading_qty,
      s.billable_qty,
      s.sale_rate,
      s.company_rate,
      s.sale_amount,
      s.company_amount,
      s.gross_amount,
      s.receivable_amount,
      s.freight,
      s.outward_labour_charges,
      s.other_charges,
      s.charge_bearer,
      s.gross_profit,
      s.net_profit,
      s.company_payable,
      s.narration
    FROM outward_settlement s
    INNER JOIN outward o ON o.id = s.outward_id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN company_accounts ca ON o.company_account_id = ca.id
    LEFT JOIN warehouses w ON o.warehouse_id = w.id
    LEFT JOIN locations l ON l.id = o.location_id
    LEFT JOIN locations wl ON wl.id = w.location_id
    LEFT JOIN products p ON o.product_id = p.id
    WHERE ${where.join(" AND ")}
    ORDER BY o.date DESC, s.id DESC
  `;

  db.all(sql, params, async (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    try {
      const enrichedRows = await Promise.all(
        (rows || []).map(async (row) => {
          const adjustment_details = await getAdjustmentDetails(row.outward_id);
          const settlement_weight = adjustment_details.reduce(
            (sum, item) => sum + num(item.settlement_weight),
            0
          );
          const dispatchQty = num(row.dispatch_qty);
          const shortage_qty = num(row.billable_qty);
          const gross_amount = num(row.gross_amount || row.gross_profit);

          const mappedAdjustmentDetails = adjustment_details.map((item, index) => {
            const amount = num(item.settlement_weight) * num(row.company_rate);
            const perMtFreight = dispatchQty > 0 ? num(row.freight) / dispatchQty : 0;
            const perMtLabour = dispatchQty > 0 ? num(row.outward_labour_charges) / dispatchQty : 0;
            const perMtOther = dispatchQty > 0 ? num(row.other_charges) / dispatchQty : 0;
            const short_amount =
              dispatchQty > 0
                ? (num(item.settlement_weight) / dispatchQty) * shortage_qty * num(row.company_rate)
                : 0;
            const freight = num(item.settlement_weight) * perMtFreight;
            const labour_charges = num(item.settlement_weight) * perMtLabour;
            const other_charges = num(item.settlement_weight) * perMtOther;
            const net_payable = amount - freight - labour_charges - other_charges - short_amount;

            return {
              ...item,
              sr_no: index + 1,
              company_rate: num(row.company_rate),
              short_amount,
              freight,
              labour_charges,
              other_charges,
              amount,
              net_payable,
            };
          });

          const company_payable = mappedAdjustmentDetails.reduce(
            (sum, item) => sum + num(item.net_payable),
            0
          );

          return {
            ...row,
            shortage_qty,
            settlement_weight,
            gross_amount,
            company_payable,
            receivable_amount: gross_amount - company_payable,
            adjustment_details: mappedAdjustmentDetails,
          };
        })
      );

      return res.json(enrichedRows);
    } catch (detailsError) {
      return res.status(500).json({ error: detailsError.message });
    }
  });
});

module.exports = router;
