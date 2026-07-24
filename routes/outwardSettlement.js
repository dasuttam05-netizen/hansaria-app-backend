const express = require("express");
const router = express.Router();
const db = require("../db");
const { userHasPermission } = require("../middleware/auth");

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function dbGetAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      return resolve(row || null);
    });
  });
}

const safeJsonParse = (value, fallback = []) => {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return fallback;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (err) {
    return fallback;
  }
};

const normalizeDetailRows = (value, fallbackAmount = 0, fallbackLabel = "") => {
  const rows = safeJsonParse(value, []);
  if (rows.length > 0) {
    return rows.map((item, index) => ({
      id: item?.id ?? `${Date.now()}-${index}`,
      description: String(item?.description ?? item?.particular ?? item?.name ?? fallbackLabel ?? "").trim(),
      amount: num(item?.amount),
    }));
  }

  const amount = num(fallbackAmount);
  if (amount > 0) {
    return [
      {
        id: `${Date.now()}-0`,
        description: fallbackLabel || "",
        amount,
      },
    ];
  }

  return [
    {
      id: `${Date.now()}-0`,
      description: fallbackLabel || "",
      amount: 0,
    },
  ];
};

const normalizeRowAdjustments = (value) => {
  const rows = safeJsonParse(value, []);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((item) => ({
      adjustment_id: item?.adjustment_id ?? item?.id ?? null,
      short_amt: num(item?.short_amt),
      s_amount: num(item?.s_amount),
      c_deduction: num(item?.c_deduction),
      freight: num(item?.freight),
      labour_chgs: num(item?.labour_chgs),
      other_chgs: num(item?.other_chgs),
    }))
    .filter((item) => item.adjustment_id);
};

const stripEmptyDetailRows = (rows) =>
  (Array.isArray(rows) ? rows : []).filter((row) => String(row?.description || "").trim() || num(row?.amount) !== 0);

const sumDetailRows = (rows) =>
  (Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + num(row?.amount), 0);

function getOutwardMasterMeta(outwardId) {
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT
        o.id,
        o.company_id,
        o.company_account_id,
        o.warehouse_id,
        o.location_id,
        o.product_id,
        c.name AS company_name,
        ca.account_name AS account_name,
        w.name AS warehouse_name,
        l.name AS location_name,
        p.name AS product_name
      FROM outward o
      LEFT JOIN companies c ON CAST(o.company_id AS TEXT) = CAST(c.id AS TEXT)
      LEFT JOIN company_accounts ca ON CAST(o.company_account_id AS TEXT) = CAST(ca.id AS TEXT)
      LEFT JOIN warehouses w ON CAST(o.warehouse_id AS TEXT) = CAST(w.id AS TEXT)
      LEFT JOIN locations l ON CAST(o.location_id AS TEXT) = CAST(l.id AS TEXT)
      LEFT JOIN products p ON CAST(o.product_id AS TEXT) = CAST(p.id AS TEXT)
      WHERE CAST(o.id AS TEXT) = ?
      LIMIT 1
      `,
      [outwardId],
      (err, row) => {
        if (err) return reject(err);
        return resolve(row || null);
      }
    );
  });
}

function getAdjustmentDetails(outwardId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        a.id,
        a.outward_id,
        COALESCE(a.source_type, 'inward') AS source_type,
        a.qty AS settlement_weight,
        a.company_rate AS adjustment_company_rate,
        a.whatsapp_sent_at,
        COALESCE(i.voucher_no, p.voucher_no) AS inward_voucher_no,
        COALESCE(i.lorry_no, p.new_lorry_no, p.reg_lorry_no) AS lorry_no,
        COALESCE(i.date, p.expense_date) AS inward_date,
        COALESCE(c.name, cp.name) AS company_name,
        COALESCE(ca.account_name, cpa.account_name) AS company_account_name,
        COALESCE(w.name, wp.name) AS warehouse_name,
        COALESCE(l.name, wl.name) AS location_name,
        COALESCE(pr.name, prp.name) AS product_name
      FROM adjustment a
      LEFT JOIN inward i ON i.id = a.inward_id
      LEFT JOIN palti_lorry_entries p ON p.id = a.palti_lorry_id
      LEFT JOIN companies c ON c.id = i.company_id
      LEFT JOIN companies cp ON cp.id = p.company_id
      LEFT JOIN company_accounts ca ON ca.id = i.company_account_id
      LEFT JOIN company_accounts cpa ON cpa.company_id = p.company_id
      LEFT JOIN warehouses w ON w.id = i.warehouse_id
      LEFT JOIN warehouses wp ON wp.id = p.warehouse_id
      LEFT JOIN locations l ON l.id = i.location_id
      LEFT JOIN locations wl ON wl.id = wp.location_id
      LEFT JOIN products pr ON pr.id = i.product_id
      LEFT JOIN products prp ON prp.id = p.product_id
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

function getUnloadingDetails(outwardId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT ba.*
      FROM buyer_adjustments ba
      WHERE ba.outward_id = ?
        AND TRIM(COALESCE(ba.consignee_name, '')) <> ''
        AND IFNULL(ba.rate, 0) > 0
      ORDER BY ba.created_at DESC
      `,
      [outwardId],
      (err, rows) => {
        if (err) return reject(err);
        return resolve(Array.isArray(rows) ? rows : []);
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
  const adjustment_details = Array.isArray(data.adjustment_details) ? data.adjustment_details : [];
  const freight = num(data.freight);
  const outward_labour_charges = num(data.outward_labour_charges);
  const other_charges = num(data.other_charges);
  const unloading_date = data.unloading_date || "";
  const claim_details = Array.isArray(data.claim_details) ? data.claim_details : [];
  const other_deduction_details = Array.isArray(data.other_deduction_details) ? data.other_deduction_details : [];
  const row_adjustments = Array.isArray(data.row_adjustments) ? data.row_adjustments : [];
  const claim_amount = num(data.claim_amount) || sumDetailRows(claim_details);
  const other_deduction = num(data.other_deduction) || sumDetailRows(other_deduction_details);
  const charge_bearer = data.charge_bearer === "company" ? "company" : "self";

  const shortage_qty = Math.max(
    num(data.shortage_qty) || Math.max(dispatch_qty - unloading_qty, 0),
    0
  );
  const sale_amount = dispatch_qty * sale_rate;
  const average_rate = settlement_weight > 0
    ? adjustment_details.reduce((sum, item) => {
        const weight = num(item.settlement_weight);
        const rowRate = num(item.company_rate) || company_rate;
        return sum + weight * rowRate;
      }, 0) / settlement_weight
    : company_rate;
  const average_amount = settlement_weight * average_rate;
  const company_amount = adjustment_details.length
    ? adjustment_details.reduce((sum, item) => {
        const rowRate = num(item.company_rate) || company_rate;
        return sum + num(item.settlement_weight) * rowRate;
      }, 0)
    : settlement_weight * company_rate;
  const gross_amount = Math.max(
    dispatch_qty * sale_rate - freight - outward_labour_charges - other_charges,
    0
  );
  const shortage_amount = adjustment_details.length
    ? adjustment_details.reduce((sum, item) => {
        const rowRate = num(item.company_rate) || company_rate;
        const shortQty =
          dispatch_qty > 0 ? (num(item.settlement_weight) / dispatch_qty) * shortage_qty : 0;
        return sum + shortQty * rowRate;
      }, 0)
    : shortage_qty * company_rate;
  const perMtCharges =
    dispatch_qty > 0
      ? (freight + outward_labour_charges + other_charges) / dispatch_qty
      : 0;
  const company_payable = adjustment_details.length
    ? adjustment_details.reduce((sum, item) => {
        const weight = num(item.settlement_weight);
        const rowRate = num(item.company_rate) || company_rate;
        const shortQty = dispatch_qty > 0 ? (weight / dispatch_qty) * shortage_qty : 0;
        return sum + weight * rowRate - weight * perMtCharges - shortQty * rowRate;
      }, 0)
    : company_amount - settlement_weight * perMtCharges - shortage_amount;
  const receivable_amount = gross_amount - company_payable - claim_amount - other_deduction;

  return {
    dispatch_qty,
    unloading_qty,
    billable_qty: shortage_qty,
    settlement_weight,
    sale_rate,
    company_rate,
    average_rate,
    average_amount,
    sale_amount,
    company_amount,
    gross_amount,
    receivable_amount,
    unloading_date,
    freight,
    outward_labour_charges,
    other_charges,
    unloading_date,
    claim_amount,
    other_deduction,
    claim_details,
    other_deduction_details,
    shortage_qty,
    charge_bearer,
    gross_profit: gross_amount,
    net_profit: receivable_amount,
    company_payable,
    row_adjustments,
  };
}

function getApprovedLabourExpense(outwardId) {
  return new Promise((resolve, reject) => {
    const loadExpenseRows = (sql, params) =>
      new Promise((resolveRows, rejectRows) => {
        db.all(sql, params, (err, rows) => {
          if (err) return rejectRows(err);
          return resolveRows(rows || []);
        });
      });

    const mapRows = (rows) =>
      (rows || [])
        .map((row) => {
          const labourItemAmount = num(row.labour_item_amount);
          const fallbackAmount = num(row.total_expense_amount || row.grand_total);
          return {
            id: row.id,
            voucher_no: row.voucher_no,
            amount: labourItemAmount > 0 ? labourItemAmount : fallbackAmount,
            status: row.status || null,
          };
        })
        .filter((row) => row.amount > 0);

    (async () => {
      const primaryRows = await loadExpenseRows(
        `
        SELECT
          x.id,
          x.voucher_no,
          x.total_expense_amount,
          x.grand_total,
          x.status,
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
        GROUP BY x.id
        ORDER BY CASE WHEN UPPER(TRIM(IFNULL(x.status, ''))) = 'CONFIRMED_BY_HO' THEN 0 ELSE 1 END, x.id ASC
        `,
        [outwardId]
      );

      let items = mapRows(primaryRows);

      if (!items.length) {
        const outwardRow = await dbGetAsync(
          `SELECT date, lorry_no, voucher_no, company_id, warehouse_id, location_id FROM outward WHERE id = ?`,
          [outwardId]
        );

        if (outwardRow) {
          const fallbackRows = await loadExpenseRows(
            `
            SELECT
              x.id,
              x.voucher_no,
              x.total_expense_amount,
              x.grand_total,
              x.status,
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
            WHERE (
              (TRIM(IFNULL(x.reg_lorry_no, '')) <> '' AND (
                TRIM(IFNULL(x.reg_lorry_no, '')) = TRIM(IFNULL(?, ''))
                OR TRIM(IFNULL(x.new_lorry_no, '')) = TRIM(IFNULL(?, ''))
              ))
            )
              AND DATE(x.expense_date) = DATE(?)
            GROUP BY x.id
            ORDER BY CASE WHEN UPPER(TRIM(IFNULL(x.status, ''))) = 'CONFIRMED_BY_HO' THEN 0 ELSE 1 END, x.id ASC
            `,
            [outwardRow.lorry_no, outwardRow.lorry_no, outwardRow.date]
          );

          items = mapRows(fallbackRows);
        }
      }

      resolve({
        amount: items.reduce((sum, item) => sum + num(item.amount), 0),
        count: items.length,
        vouchers: items.map((item) => item.voucher_no || `EXP-${item.id}`).filter(Boolean),
        entries: items,
      });
    })().catch(reject);
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
      COALESCE(ca.account_name, '') AS account_name,
      COALESCE(w.name, '') AS warehouse_name,
      COALESCE(o.location_id, w.location_id) AS effective_location_id,
      COALESCE(l.name, wl.name, '') AS location_name,
      COALESCE(p.name, '') AS product_name
    FROM outward o
    LEFT JOIN outward_settlement s ON CAST(s.outward_id AS TEXT) = CAST(o.id AS TEXT)
    LEFT JOIN companies c ON CAST(o.company_id AS TEXT) = CAST(c.id AS TEXT)
    LEFT JOIN company_accounts ca ON CAST(o.company_account_id AS TEXT) = CAST(ca.id AS TEXT)
    LEFT JOIN warehouses w ON CAST(o.warehouse_id AS TEXT) = CAST(w.id AS TEXT)
    LEFT JOIN locations l ON CAST(o.location_id AS TEXT) = CAST(l.id AS TEXT)
    LEFT JOIN locations wl ON CAST(w.location_id AS TEXT) = CAST(wl.id AS TEXT)
    LEFT JOIN products p ON CAST(o.product_id AS TEXT) = CAST(p.id AS TEXT)
    WHERE CAST(o.id AS TEXT) = ?
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
      const unloadingDetails = await new Promise((resolve, reject) => {
        db.all(
          `
          SELECT
            ba.*,
            COALESCE(ba.buyer_name, b.name) AS buyer_name,
            COALESCE(ba.consignee_name, '') AS consignee_name,
            p.name AS product_name
          FROM buyer_adjustments ba
          LEFT JOIN buyer_names b ON ba.buyer_id = b.id
          LEFT JOIN outward o ON o.id = ba.outward_id
          LEFT JOIN products p ON p.id = o.product_id
          WHERE ba.outward_id = ?
            AND TRIM(COALESCE(ba.consignee_name, '')) <> ''
            AND IFNULL(ba.rate, 0) > 0
          ORDER BY ba.created_at DESC
          `,
          [outwardId],
          (buyerErr, rows) => {
            if (buyerErr) return reject(buyerErr);
            return resolve(Array.isArray(rows) ? rows : []);
          }
        );
      });
      const totalSettlementWeight = adjustment_details.reduce(
        (sum, item) => sum + num(item.settlement_weight),
        0
      );
      const claimDetails = normalizeDetailRows(row.claim_details, row.claim_amount, "Claim");
      const otherDeductionDetails = normalizeDetailRows(
        row.other_deduction_details,
        row.other_deduction,
        "Deduction"
      );
      const rowAdjustments = normalizeRowAdjustments(row.row_adjustments);

      const defaultDispatch = num(row.outward_quantity || row.outward_weight);

      const payload = {
        outward_id: Number(outwardId),
        outward_date: row.outward_date,
        voucher_no: row.voucher_no,
        lorry_no: row.lorry_no,
        buyer_name: row.buyer_name,
        consignee_name: row.consignee_name,
        company_name: row.company_name,
        account_name: row.account_name || null,
        company_account_name: row.account_name || null,
        accountName: row.account_name || null,
        warehouse_name: row.warehouse_name || null,
        outward_warehouse_name: row.warehouse_name || null,
        warehouseName: row.warehouse_name || null,
        location_id: row.effective_location_id || null,
        location_name: row.location_name || null,
        outward_location_name: row.location_name || null,
        locationName: row.location_name || null,
        product_name: row.product_name || null,
        outward_product_name: row.product_name || null,
        productName: row.product_name || null,
        outward_quantity: defaultDispatch,
        labour_expense: labourExpense,
          unloading_details: unloadingDetails,
        adjustment_details: adjustment_details.map((item) => ({
          ...item,
          company_rate: num(item.adjustment_company_rate) || num(row.company_rate ?? 0),
          amount: num(item.settlement_weight) * (num(item.adjustment_company_rate) || num(row.company_rate ?? 0)),
        })),
          settlement: {
          id: row.id || null,
          dispatch_qty: row.dispatch_qty ?? defaultDispatch,
          unloading_qty: row.unloading_qty ?? totalSettlementWeight,
          settlement_weight: totalSettlementWeight,
          billable_qty:
            row.billable_qty ??
            (unloadingDetails.reduce((sum, item) => sum + num(item.shortage), 0) || 0),
          sale_rate: row.sale_rate ?? num(row.outward_rate),
          company_rate: row.company_rate ?? 0,
          average_rate: row.average_rate ?? 0,
          average_amount: row.average_amount ?? 0,
          sale_amount: row.sale_amount ?? 0,
          company_amount: row.company_amount ?? 0,
          gross_amount: row.gross_amount ?? row.gross_profit ?? 0,
          receivable_amount: row.receivable_amount ?? row.net_profit ?? 0,
          unloading_date: row.unloading_date || "",
          freight: row.freight ?? 0,
          outward_labour_charges: row.outward_labour_charges == null ? null : row.outward_labour_charges,
          other_charges: row.other_charges ?? 0,
          claim_amount: row.claim_amount ?? 0,
          other_deduction: row.other_deduction ?? 0,
          claim_details: claimDetails,
          other_deduction_details: otherDeductionDetails,
          row_adjustments: rowAdjustments,
          charge_bearer: row.charge_bearer || "self",
          gross_profit: row.gross_profit ?? 0,
          net_profit: row.net_profit ?? 0,
          company_payable: row.company_payable ?? 0,
          narration: row.narration || "",
        },
      };

      return res.json(payload);
    } catch (detailsError) {
      console.error("Outward settlement fetch error", {
        outwardId,
        message: detailsError.message,
        stack: detailsError.stack,
      });
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
    adjustment_rates,
    freight,
    outward_labour_charges,
    other_charges,
    claim_amount,
    other_deduction,
    claim_details,
    other_deduction_details,
    shortage_qty,
    row_adjustments,
    unloading_date,
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
      const existingSettlement = await new Promise((resolve, reject) => {
        db.get(
          `SELECT company_rate FROM outward_settlement WHERE outward_id = ?`,
          [outward_id],
          (existingErr, existingRow) => {
            if (existingErr) return reject(existingErr);
            return resolve(existingRow || null);
          }
        );
      });
      const canEditCompanyRate = userHasPermission(req.user, "settlement.companyRate");
      const existingCompanyRate = num(existingSettlement?.company_rate);
      const requestedCompanyRate = num(company_rate);
      if (!canEditCompanyRate && requestedCompanyRate !== existingCompanyRate) {
        return res.status(403).json({ error: "Company rate edit access required" });
      }

      const adjustment_details = await getAdjustmentDetails(outward_id);
      const unloadingDetails = await getUnloadingDetails(outward_id);
      const unloadingShortageQty = unloadingDetails.reduce(
        (sum, item) => sum + num(item.shortage),
        0
      );
      const unloadingClaimAmount = unloadingDetails.reduce(
        (sum, item) => sum + num(item.claim),
        0
      );
      const adjustmentRateMap = new Map(
        (Array.isArray(adjustment_rates) ? adjustment_rates : [])
          .map((item) => [String(item.adjustment_id || item.id || ""), num(item.company_rate)])
          .filter(([id]) => id)
      );
      const adjustmentDetailsWithRates = adjustment_details.map((item) => ({
        ...item,
        company_rate:
          adjustmentRateMap.has(String(item.id))
            ? adjustmentRateMap.get(String(item.id))
            : num(item.adjustment_company_rate) || requestedCompanyRate,
      }));
      if (!canEditCompanyRate) {
        const changedRowRate = adjustmentDetailsWithRates.some(
          (item) => num(item.company_rate) !== (num(item.adjustment_company_rate) || existingCompanyRate)
        );
        if (changedRowRate) {
          return res.status(403).json({ error: "Company rate edit access required" });
        }
      }
      const settlementWeight = adjustment_details.reduce(
        (sum, item) => sum + num(item.settlement_weight),
        0
      );
      const normalizedClaimDetails = stripEmptyDetailRows(
        normalizeDetailRows(claim_details, claim_amount, "Claim")
      );
      const normalizedOtherDeductionDetails = stripEmptyDetailRows(
        normalizeDetailRows(
          other_deduction_details,
          other_deduction,
          "Deduction"
        )
      );
      const normalizedRowAdjustments = normalizeRowAdjustments(row_adjustments);

      const settlement = calculateSettlement({
        dispatch_qty: dispatch_qty ?? num(outward.quantity || outward.weight),
        unloading_qty,
        shortage_qty: unloadingShortageQty,
        settlement_weight: settlementWeight,
        sale_rate,
        company_rate: canEditCompanyRate ? company_rate : existingCompanyRate,
        adjustment_details: adjustmentDetailsWithRates,
        freight,
        outward_labour_charges,
        other_charges,
        unloading_date,
        claim_amount,
        other_deduction,
        claim_details: normalizedClaimDetails,
        other_deduction_details: normalizedOtherDeductionDetails,
        row_adjustments: normalizedRowAdjustments,
        charge_bearer,
      });

      const persistAdjustmentRates = (callback) => {
        if (!canEditCompanyRate || adjustmentDetailsWithRates.length === 0) {
          callback();
          return;
        }

        let index = 0;
        const next = () => {
          if (index >= adjustmentDetailsWithRates.length) {
            callback();
            return;
          }
          const item = adjustmentDetailsWithRates[index];
          index += 1;
          db.run(
            `UPDATE adjustment SET company_rate = ? WHERE id = ? AND outward_id = ?`,
            [num(item.company_rate), item.id, outward_id],
            (rateErr) => {
              if (rateErr) return callback(rateErr);
              next();
            }
          );
        };
        next();
      };

      persistAdjustmentRates((ratePersistErr) => {
        if (ratePersistErr) {
          return res.status(500).json({ error: ratePersistErr.message });
        }

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
            settlement.average_rate,
            settlement.average_amount,
          settlement.sale_amount,
          settlement.company_amount,
          settlement.gross_amount,
          settlement.receivable_amount,
          settlement.unloading_date,
          settlement.freight,
            settlement.outward_labour_charges,
            settlement.other_charges,
            settlement.claim_amount,
            settlement.other_deduction,
            JSON.stringify(settlement.claim_details || []),
            JSON.stringify(settlement.other_deduction_details || []),
            JSON.stringify(settlement.row_adjustments || []),
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
                average_rate = ?,
                average_amount = ?,
                sale_amount = ?,
                company_amount = ?,
                gross_amount = ?,
                receivable_amount = ?,
                unloading_date = ?,
                freight = ?,
                outward_labour_charges = ?,
                other_charges = ?,
                claim_amount = ?,
                other_deduction = ?,
                claim_details = ?,
                other_deduction_details = ?,
                row_adjustments = ?,
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
                average_rate,
                average_amount,
                sale_amount,
                company_amount,
                gross_amount,
                receivable_amount,
                unloading_date,
                freight,
                outward_labour_charges,
                other_charges,
                claim_amount,
                other_deduction,
                claim_details,
                other_deduction_details,
                row_adjustments,
                charge_bearer,
                gross_profit,
                net_profit,
                company_payable,
                narration
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      });
    } catch (detailsError) {
      return res.status(500).json({ error: detailsError.message });
    }
  });
});

router.post("/adjustment/:id/whatsapp-sent", (req, res) => {
  const sentAt = new Date().toISOString();
  db.run(
    `UPDATE adjustment SET whatsapp_sent_at = ? WHERE id = ?`,
    [sentAt, req.params.id],
    function onUpdate(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (!this.changes) return res.status(404).json({ error: "Adjustment not found" });
      return res.json({ whatsapp_sent_at: sentAt });
    }
  );
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
      COALESCE(ca.account_name, '') AS account_name,
      COALESCE(w.name, '') AS warehouse_name,
      COALESCE(o.location_id, w.location_id) AS effective_location_id,
      COALESCE(l.name, wl.name, '') AS location_name,
      COALESCE(p.name, '') AS product_name,
      o.buyer_name,
      o.consignee_name,
      s.dispatch_qty,
      s.unloading_qty,
      s.billable_qty,
      s.sale_rate,
      s.company_rate,
      s.average_rate,
      s.average_amount,
      s.sale_amount,
      s.company_amount,
      s.gross_amount,
      s.receivable_amount,
      s.unloading_date,
      s.freight,
      s.outward_labour_charges,
      s.other_charges,
      s.claim_amount,
      s.other_deduction,
      s.claim_details,
      s.other_deduction_details,
      s.row_adjustments,
      s.charge_bearer,
      s.gross_profit,
      s.net_profit,
      s.company_payable,
      s.narration
    FROM outward_settlement s
    INNER JOIN outward o ON CAST(o.id AS TEXT) = CAST(s.outward_id AS TEXT)
    LEFT JOIN companies c ON CAST(o.company_id AS TEXT) = CAST(c.id AS TEXT)
    LEFT JOIN company_accounts ca ON CAST(o.company_account_id AS TEXT) = CAST(ca.id AS TEXT)
    LEFT JOIN warehouses w ON CAST(o.warehouse_id AS TEXT) = CAST(w.id AS TEXT)
    LEFT JOIN locations l ON CAST(o.location_id AS TEXT) = CAST(l.id AS TEXT)
    LEFT JOIN locations wl ON CAST(w.location_id AS TEXT) = CAST(wl.id AS TEXT)
    LEFT JOIN products p ON CAST(o.product_id AS TEXT) = CAST(p.id AS TEXT)
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
          const outwardMeta = await getOutwardMasterMeta(row.outward_id);
          const adjustment_details = await getAdjustmentDetails(row.outward_id);
          const unloadingDetails = await getUnloadingDetails(row.outward_id);
          const settlement_weight = adjustment_details.reduce(
            (sum, item) => sum + num(item.settlement_weight),
            0
          );
          const dispatchQty = num(row.dispatch_qty);
          const unloadingShortageQty = unloadingDetails.reduce(
            (sum, item) => sum + num(item.shortage),
            0
          );
          const shortage_qty =
            unloadingShortageQty || num(row.billable_qty) || Math.max(dispatchQty - num(row.unloading_qty), 0);
          const gross_amount = num(row.gross_amount || row.gross_profit);
          const average_rate = num(row.average_rate);
          const average_amount = num(row.average_amount);
          const claim_amount =
            num(row.claim_amount) || unloadingDetails.reduce((sum, item) => sum + num(item.claim), 0);
          const other_deduction =
            num(row.other_deduction) || unloadingDetails.reduce((sum, item) => sum + num(item.other_deduction), 0);
          const unloadingDate = row.unloading_date || "";
          const claim_details = normalizeDetailRows(row.claim_details, claim_amount, "Claim");
          const other_deduction_details = normalizeDetailRows(
            row.other_deduction_details,
            other_deduction,
            "Deduction"
          );

          const mappedAdjustmentDetails = adjustment_details.map((item, index) => {
            const rowCompanyRate = num(item.adjustment_company_rate) || num(row.company_rate);
            const amount = num(item.settlement_weight) * rowCompanyRate;
            const perMtFreight = dispatchQty > 0 ? num(row.freight) / dispatchQty : 0;
            const perMtLabour = dispatchQty > 0 ? num(row.outward_labour_charges) / dispatchQty : 0;
            const perMtOther = dispatchQty > 0 ? num(row.other_charges) / dispatchQty : 0;
            const short_amount =
              dispatchQty > 0
                ? (num(item.settlement_weight) / dispatchQty) * shortage_qty * rowCompanyRate
                : 0;
            const freight = num(item.settlement_weight) * perMtFreight;
            const labour_charges = num(item.settlement_weight) * perMtLabour;
            const other_charges = num(item.settlement_weight) * perMtOther;
            const net_payable = amount - freight - labour_charges - other_charges - short_amount;

            return {
              ...item,
              sr_no: index + 1,
              company_rate: rowCompanyRate,
              shortQtyPerLine: dispatchQty > 0
                ? (num(item.settlement_weight) / dispatchQty) * shortage_qty
                : 0,
              shortAmount: short_amount,
              claim_per_line: dispatchQty > 0
                ? (num(item.settlement_weight) / dispatchQty) * claim_amount
                : 0,
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
            account_name: row.account_name || outwardMeta?.account_name || null,
            company_account_name: row.account_name || outwardMeta?.account_name || null,
            accountName: row.account_name || outwardMeta?.account_name || null,
            warehouse_name: row.warehouse_name || outwardMeta?.warehouse_name || null,
            warehouseName: row.warehouse_name || outwardMeta?.warehouse_name || null,
            outward_warehouse_name: row.warehouse_name || outwardMeta?.warehouse_name || null,
            location_name: row.location_name || outwardMeta?.location_name || null,
            locationName: row.location_name || outwardMeta?.location_name || null,
            outward_location_name: row.location_name || outwardMeta?.location_name || null,
            product_name: row.product_name || outwardMeta?.product_name || null,
            productName: row.product_name || outwardMeta?.product_name || null,
            outward_product_name: row.product_name || outwardMeta?.product_name || null,
            shortage_qty,
            settlement_weight,
            gross_amount,
            company_payable,
            receivable_amount: gross_amount - company_payable - claim_amount - other_deduction,
            average_rate,
            average_amount,
            claim_amount,
            other_deduction,
            unloading_date: unloadingDate,
            claim_details,
            other_deduction_details,
            row_adjustments: normalizeRowAdjustments(row.row_adjustments),
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
