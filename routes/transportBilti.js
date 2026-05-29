const express = require("express");
const router = express.Router();
const db = require("../db");
const { mongoose, SaleVoucher } = require("../mongo");

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const text = (v) => {
  if (v === undefined || v === null) return "";
  return String(v).trim();
};

function calculateBilti(data) {
  const CLAIM_FREE_SHORTAGE_KG = num(data.shortage_free_kg) > 0 ? num(data.shortage_free_kg) : 100;
  const KG_PER_MT = 1000;
  const outwardQty = num(data.outward_qty);
  const dispatchQty = num(data.dispatch_qty);
  const outwardRate = num(data.outward_rate);
  const transportRate = num(data.transport_rate);
  const detainAmount = num(data.detain_amount);
  const othersExp = num(data.others_exp);
  const advanceAmount = num(data.advance_amount);
  const tdsPercent = num(data.tds_percent);

  const shortageQty = Math.max(outwardQty - dispatchQty, 0);
  const claimFreeQtyInMt = CLAIM_FREE_SHORTAGE_KG / KG_PER_MT;
  const chargeableShortageQty = Math.max(shortageQty - claimFreeQtyInMt, 0);
  const shortageAmount = chargeableShortageQty * outwardRate;
  const grossFreight = outwardQty * transportRate;
  const netAmount = grossFreight - shortageAmount + detainAmount + othersExp;
  const tdsAmount = netAmount * (tdsPercent / 100);
  const payableAmount = netAmount - advanceAmount - tdsAmount;

  return {
    outward_qty: outwardQty,
    dispatch_qty: dispatchQty,
    shortage_free_kg: CLAIM_FREE_SHORTAGE_KG,
    shortage_qty: shortageQty,
    outward_rate: outwardRate,
    shortage_amount: shortageAmount,
    transport_rate: transportRate,
    gross_freight: grossFreight,
    detain_amount: detainAmount,
    others_exp: othersExp,
    advance_amount: advanceAmount,
    tds_percent: tdsPercent,
    tds_amount: tdsAmount,
    net_amount: netAmount,
    payable_amount: payableAmount,
  };
}

function applyCalculatedBilti(row) {
  const computed = calculateBilti(row || {});
  return {
    ...row,
    ...computed,
  };
}

function nextBiltiNo(callback) {
  db.get(
    `SELECT IFNULL(MAX(id), 0) + 1 AS next_no FROM transport_bilti`,
    [],
    (err, row) => {
      if (err) return callback(err);
      callback(null, `BLT${String(row.next_no).padStart(4, "0")}`);
    }
  );
}

router.get("/outward-list", (req, res) => {
  const sql = `
    SELECT
      o.id,
      lb.bilti_id,
      o.voucher_no,
      o.date,
      o.lorry_no,
      o.quantity,
      o.weight,
      o.rate,
      o.buyer_name,
      o.consignee_name,
      c.name AS company_name,
      ca.account_name AS account_name,
      w.name AS warehouse_name,
      p.name AS product_name
    FROM outward o
    LEFT JOIN (
      SELECT outward_id, MAX(id) AS bilti_id
      FROM transport_bilti
      GROUP BY outward_id
    ) lb ON lb.outward_id = o.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN company_accounts ca ON o.company_account_id = ca.id
    LEFT JOIN warehouses w ON o.warehouse_id = w.id
    LEFT JOIN products p ON o.product_id = p.id
    ORDER BY o.id DESC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

router.get("/sale-list", (req, res) => {
  const sql = `
    SELECT
      s.id,
      lb.bilti_id,
      s.voucher_no,
      s.date,
      s.lorry_no,
      s.quantity,
      s.unloading_qty,
      s.rate,
      s.amount,
      COALESCE(b.name, c.name) AS buyer_name,
      co.name AS consignee_name,
      ca.account_name AS account_name,
      w.name AS warehouse_name,
      p.name AS product_name
    FROM wh_sale_vouchers s
    LEFT JOIN (
      SELECT sale_id, MAX(id) AS bilti_id
      FROM transport_bilti
      WHERE sale_id IS NOT NULL
      GROUP BY sale_id
    ) lb ON lb.sale_id = s.id
    LEFT JOIN buyer_names b ON CAST(b.id AS TEXT) = CAST(s.buyer_id AS TEXT)
    LEFT JOIN companies c ON CAST(c.id AS TEXT) = CAST(s.company_id AS TEXT)
    LEFT JOIN consignee_names co ON CAST(co.id AS TEXT) = CAST(s.consignee_id AS TEXT)
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(s.company_account_id AS TEXT)
    LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(s.warehouse_id AS TEXT)
    LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(s.product_id AS TEXT)
    WHERE lb.bilti_id IS NULL
    ORDER BY s.id DESC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

router.get("/report/list", (req, res) => {
  const { from_date, to_date } = req.query;
  const reportDateExpr = "COALESCE(NULLIF(tb.dispatch_date, ''), NULLIF(tb.outward_date, ''))";

  const where = ["1=1"];
  const params = [];

  if (from_date) {
    where.push(`${reportDateExpr} >= ?`);
    params.push(from_date);
  }

  if (to_date) {
    where.push(`${reportDateExpr} <= ?`);
    params.push(to_date);
  }

  const sql = `
    SELECT
      tb.*,
      tr.name AS transporter_name,
      tr.address AS transporter_address,
      tr.pan_no AS transporter_pan_no,
      tr.mobile AS transporter_mobile,
      o.voucher_no AS outward_voucher_no,
      o.date AS outward_entry_date,
      o.buyer_name AS outward_buyer_name,
      o.consignee_name AS outward_consignee_name,
      o.lorry_no AS outward_lorry_no,
      c.name AS outward_company_name,
      ca.account_name AS outward_account_name,
      w.name AS outward_warehouse_name,
      p.name AS outward_product_name,
      s.voucher_no AS sale_voucher_no,
      s.date AS sale_entry_date,
      s.quantity AS sale_quantity,
      s.unloading_qty AS sale_unloading_qty,
      s.rate AS sale_master_rate,
      s.lorry_no AS sale_lorry_no,
      COALESCE(sb.name, sc.name) AS sale_buyer_name,
      sco.name AS sale_consignee_name,
      sca.account_name AS sale_account_name,
      sw.name AS sale_warehouse_name,
      sp.name AS sale_product_name
    FROM transport_bilti tb
    LEFT JOIN outward o ON o.id = tb.outward_id
    LEFT JOIN transporters tr ON tr.id = tb.transporter_id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN company_accounts ca ON o.company_account_id = ca.id
    LEFT JOIN warehouses w ON o.warehouse_id = w.id
    LEFT JOIN products p ON o.product_id = p.id
    LEFT JOIN wh_sale_vouchers s ON s.id = tb.sale_id
    LEFT JOIN buyer_names sb ON CAST(sb.id AS TEXT) = CAST(s.buyer_id AS TEXT)
    LEFT JOIN companies sc ON CAST(sc.id AS TEXT) = CAST(s.company_id AS TEXT)
    LEFT JOIN consignee_names sco ON CAST(sco.id AS TEXT) = CAST(s.consignee_id AS TEXT)
    LEFT JOIN company_accounts sca ON CAST(sca.id AS TEXT) = CAST(s.company_account_id AS TEXT)
    LEFT JOIN warehouses sw ON CAST(sw.id AS TEXT) = CAST(s.warehouse_id AS TEXT)
    LEFT JOIN products sp ON CAST(sp.id AS TEXT) = CAST(s.product_id AS TEXT)
    WHERE ${where.join(" AND ")}
    ORDER BY ${reportDateExpr} DESC, tb.id DESC
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json((rows || []).map((row) => applyCalculatedBilti(row)));
  });
});

router.get("/:id", (req, res) => {
  const biltiIdOrOutwardId = req.params.id;

  const biltiJoinSql = `
    SELECT
      tb.*,
      tr.name AS transporter_name,
      tr.address AS transporter_address,
      tr.pan_no AS transporter_pan_no,
      tr.mobile AS transporter_mobile,
      o.id AS outward_id,
      o.voucher_no AS outward_voucher_no,
      o.date AS outward_entry_date,
      o.quantity AS outward_quantity,
      o.weight AS outward_weight,
      o.rate AS outward_master_rate,
      o.buyer_name AS outward_buyer_name,
      o.consignee_name AS outward_consignee_name,
      o.lorry_no AS outward_lorry_no,
      c.name AS outward_company_name,
      ca.account_name AS outward_account_name,
      w.name AS outward_warehouse_name,
      p.name AS outward_product_name,
      s.id AS sale_id,
      s.voucher_no AS sale_voucher_no,
      s.date AS sale_entry_date,
      s.quantity AS sale_quantity,
      s.unloading_qty AS sale_unloading_qty,
      s.rate AS sale_master_rate,
      s.lorry_no AS sale_lorry_no,
      COALESCE(sb.name, sc.name) AS sale_buyer_name,
      sco.name AS sale_consignee_name,
      sca.account_name AS sale_account_name,
      sw.name AS sale_warehouse_name,
      sp.name AS sale_product_name
    FROM transport_bilti tb
    LEFT JOIN outward o ON o.id = tb.outward_id
    LEFT JOIN transporters tr ON tr.id = tb.transporter_id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN company_accounts ca ON o.company_account_id = ca.id
    LEFT JOIN warehouses w ON o.warehouse_id = w.id
    LEFT JOIN products p ON o.product_id = p.id
    LEFT JOIN wh_sale_vouchers s ON s.id = tb.sale_id
    LEFT JOIN buyer_names sb ON CAST(sb.id AS TEXT) = CAST(s.buyer_id AS TEXT)
    LEFT JOIN companies sc ON CAST(sc.id AS TEXT) = CAST(s.company_id AS TEXT)
    LEFT JOIN consignee_names sco ON CAST(sco.id AS TEXT) = CAST(s.consignee_id AS TEXT)
    LEFT JOIN company_accounts sca ON CAST(sca.id AS TEXT) = CAST(s.company_account_id AS TEXT)
    LEFT JOIN warehouses sw ON CAST(sw.id AS TEXT) = CAST(s.warehouse_id AS TEXT)
    LEFT JOIN products sp ON CAST(sp.id AS TEXT) = CAST(s.product_id AS TEXT)
    WHERE %WHERE_CONDITION%
    LIMIT 1
  `;

  const loadFromOutwardTable = () => {
    db.get(
      `
      SELECT
        o.id AS outward_id,
        o.voucher_no,
        o.date,
        o.lorry_no,
        o.quantity,
        o.weight,
        o.rate,
        o.buyer_name,
        o.consignee_name,
        c.name AS company_name,
        ca.account_name AS account_name,
        w.name AS warehouse_name,
        p.name AS product_name
      FROM outward o
      LEFT JOIN companies c ON o.company_id = c.id
      LEFT JOIN company_accounts ca ON o.company_account_id = ca.id
      LEFT JOIN warehouses w ON o.warehouse_id = w.id
      LEFT JOIN products p ON o.product_id = p.id
      WHERE o.id = ?
      `,
      [biltiIdOrOutwardId],
      (err2, outwardRow) => {
        if (err2) return res.status(500).json({ error: err2.message });
        if (!outwardRow) return res.status(404).json({ error: "Bilti not found" });

        res.json(applyCalculatedBilti({
          id: null,
          outward_id: outwardRow.outward_id,
          bilti_no: "",
          transporter_id: "",
          transporter_name: "",
          transporter_address: "",
          transporter_pan_no: "",
          transporter_mobile: "",
          dispatch_date: outwardRow.date || "",
          destination: "",
          days: 0,
          outward_qty: num(outwardRow.quantity || outwardRow.weight),
          dispatch_qty: num(outwardRow.quantity || outwardRow.weight),
          shortage_free_kg: 100,
          shortage_qty: 0,
          outward_rate: num(outwardRow.rate),
          shortage_amount: 0,
          transport_rate: 0,
          gross_freight: 0,
          detain_amount: 0,
          others_exp: 0,
          advance_amount: 0,
          tds_percent: 0,
          tds_amount: 0,
          net_amount: 0,
          payable_amount: 0,
          narration: "",
          outward_voucher_no: outwardRow.voucher_no || "",
          outward_entry_date: outwardRow.date || "",
          outward_quantity: num(outwardRow.quantity || outwardRow.weight),
          outward_weight: num(outwardRow.weight),
          outward_master_rate: num(outwardRow.rate),
          outward_buyer_name: outwardRow.buyer_name || "",
          outward_consignee_name: outwardRow.consignee_name || "",
          outward_lorry_no: outwardRow.lorry_no || "",
          outward_company_name: outwardRow.company_name || "",
          outward_account_name: outwardRow.account_name || "",
          outward_warehouse_name: outwardRow.warehouse_name || "",
          outward_product_name: outwardRow.product_name || "",
        }));
      }
    );
  };

  const loadFromSaleTableMongo = () => {
    if (mongoose.connection.readyState !== 1 || !mongoose.Types.ObjectId.isValid(biltiIdOrOutwardId)) {
      return false;
    }

    SaleVoucher.findById(biltiIdOrOutwardId)
      .lean()
      .then((saleDoc) => {
        if (!saleDoc) {
          return loadFromSaleTable();
        }

        const saleWeight = num(saleDoc.unloading_qty || saleDoc.quantity);
        res.json(applyCalculatedBilti({
          id: null,
          outward_id: null,
          sale_id: String(saleDoc._id || saleDoc.id),
          bilti_no: "",
          transporter_id: "",
          transporter_name: "",
          transporter_address: "",
          transporter_pan_no: "",
          transporter_mobile: "",
          dispatch_date: saleDoc.date || saleDoc.unloading_date || "",
          destination: "",
          days: 0,
          outward_qty: saleWeight,
          dispatch_qty: saleWeight,
          shortage_free_kg: 100,
          shortage_qty: 0,
          outward_rate: num(saleDoc.rate),
          shortage_amount: 0,
          transport_rate: 0,
          gross_freight: 0,
          detain_amount: 0,
          others_exp: 0,
          advance_amount: 0,
          tds_percent: 0,
          tds_amount: 0,
          net_amount: 0,
          payable_amount: 0,
          narration: "",
          sale_voucher_no: saleDoc.voucher_no || "",
          sale_entry_date: saleDoc.date || saleDoc.unloading_date || "",
          sale_quantity: num(saleDoc.quantity),
          sale_unloading_qty: num(saleDoc.unloading_qty),
          sale_master_rate: num(saleDoc.rate),
          sale_buyer_name: saleDoc.buyer_name || saleDoc.company_name || "",
          sale_consignee_name: saleDoc.consignee_name || "",
          sale_lorry_no: saleDoc.lorry_no || "",
          sale_account_name: saleDoc.company_account_name || saleDoc.account_name || "",
          sale_warehouse_name: saleDoc.warehouse_name || "",
          sale_product_name: saleDoc.product_name || "",
        }));
      })
      .catch((mongoErr) => {
        console.error("Mongo sale lookup failed:", mongoErr.message || mongoErr);
        loadFromSaleTable();
      });

    return true;
  };

  const loadFromSaleTable = () => {
    db.get(
      `
      SELECT
        s.id AS sale_id,
        s.voucher_no,
        s.date,
        s.lorry_no,
        s.quantity,
        s.unloading_qty,
        s.rate,
        COALESCE(b.name, c.name) AS buyer_name,
        co.name AS consignee_name,
        ca.account_name AS account_name,
        w.name AS warehouse_name,
        p.name AS product_name
      FROM wh_sale_vouchers s
      LEFT JOIN buyer_names b ON CAST(b.id AS TEXT) = CAST(s.buyer_id AS TEXT)
      LEFT JOIN companies c ON CAST(c.id AS TEXT) = CAST(s.company_id AS TEXT)
      LEFT JOIN consignee_names co ON CAST(co.id AS TEXT) = CAST(s.consignee_id AS TEXT)
      LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(s.company_account_id AS TEXT)
      LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(s.warehouse_id AS TEXT)
      LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(s.product_id AS TEXT)
      WHERE s.id = ?
      `,
      [biltiIdOrOutwardId],
      (err2, saleRow) => {
        if (err2) return res.status(500).json({ error: err2.message });
        if (!saleRow) return res.status(404).json({ error: "Bilti not found" });

        const saleWeight = num(saleRow.unloading_qty || saleRow.quantity);
        res.json(applyCalculatedBilti({
          id: null,
          outward_id: null,
          sale_id: saleRow.sale_id,
          bilti_no: "",
          transporter_id: "",
          transporter_name: "",
          transporter_address: "",
          transporter_pan_no: "",
          transporter_mobile: "",
          dispatch_date: saleRow.date || "",
          destination: "",
          days: 0,
          outward_qty: saleWeight,
          dispatch_qty: saleWeight,
          shortage_free_kg: 100,
          shortage_qty: 0,
          outward_rate: num(saleRow.rate),
          shortage_amount: 0,
          transport_rate: 0,
          gross_freight: 0,
          detain_amount: 0,
          others_exp: 0,
          advance_amount: 0,
          tds_percent: 0,
          tds_amount: 0,
          net_amount: 0,
          payable_amount: 0,
          narration: "",
          sale_voucher_no: saleRow.voucher_no || "",
          sale_entry_date: saleRow.date || "",
          sale_quantity: num(saleRow.quantity),
          sale_unloading_qty: num(saleRow.unloading_qty),
          sale_master_rate: num(saleRow.rate),
          sale_buyer_name: saleRow.buyer_name || "",
          sale_consignee_name: saleRow.consignee_name || "",
          sale_lorry_no: saleRow.lorry_no || "",
          sale_account_name: saleRow.account_name || "",
          sale_warehouse_name: saleRow.warehouse_name || "",
          sale_product_name: saleRow.product_name || "",
        }));
      }
    );
  };

  if (req.query.source === "sale") {
    if (loadFromSaleTableMongo()) return;
    return loadFromSaleTable();
  }
  if (req.query.source === "outward") {
    return loadFromOutwardTable();
  }

  const sqlByBiltiId = biltiJoinSql.replace("%WHERE_CONDITION%", "tb.id = ?");
  db.get(sqlByBiltiId, [biltiIdOrOutwardId], (err, biltiRow) => {
    if (err) return res.status(500).json({ error: err.message });
    if (biltiRow) return res.json(applyCalculatedBilti(biltiRow));

    const sqlByOutwardId = biltiJoinSql.replace(
      "%WHERE_CONDITION%",
      "tb.outward_id = ? ORDER BY tb.id DESC"
    );
    db.get(sqlByOutwardId, [biltiIdOrOutwardId], (err2, outwardBiltiRow) => {
      if (err2) return res.status(500).json({ error: err2.message });
      if (outwardBiltiRow) return res.json(applyCalculatedBilti(outwardBiltiRow));
      const sqlBySaleId = biltiJoinSql.replace(
        "%WHERE_CONDITION%",
        "tb.sale_id = ? ORDER BY tb.id DESC"
      );
      db.get(sqlBySaleId, [biltiIdOrOutwardId], (err3, saleBiltiRow) => {
        if (err3) return res.status(500).json({ error: err3.message });
        if (saleBiltiRow) return res.json(applyCalculatedBilti(saleBiltiRow));
        if (req.query.source === "sale") {
          if (loadFromSaleTableMongo()) return;
          return loadFromSaleTable();
        }
        loadFromOutwardTable();
      });
    });
  });
});

router.post("/save", (req, res) => {
  const {
    id,
    outward_id,
    sale_id,
    transporter_id,
    voucher_no,
    outward_date,
    dispatch_date,
    destination,
    days,
    company_name,
    account_name,
    warehouse_name,
    product_name,
    lorry_no,
    buyer_name,
    consignee_name,
    outward_qty,
    dispatch_qty,
    shortage_free_kg,
    outward_rate,
    transport_rate,
    detain_amount,
    others_exp,
    advance_amount,
    tds_percent,
    narration,
  } = req.body;

  if (!transporter_id) {
    return res.status(400).json({ error: "transporter_id required" });
  }

  const computed = calculateBilti({
    outward_qty,
    dispatch_qty,
    shortage_free_kg,
    outward_rate,
    transport_rate,
    detain_amount,
    others_exp,
    advance_amount,
    tds_percent,
  });

  const commonParams = [
    transporter_id,
    text(voucher_no),
    text(outward_date),
    text(dispatch_date),
    text(destination),
    num(days),
    text(company_name),
    text(account_name),
    text(warehouse_name),
    text(product_name),
    text(lorry_no),
    text(buyer_name),
    text(consignee_name),
    computed.outward_qty,
    computed.dispatch_qty,
    computed.shortage_free_kg,
    computed.shortage_qty,
    computed.outward_rate,
    computed.shortage_amount,
    computed.transport_rate,
    computed.gross_freight,
    computed.detain_amount,
    computed.others_exp,
    computed.advance_amount,
    computed.tds_percent,
    computed.tds_amount,
    computed.net_amount,
    computed.payable_amount,
    text(narration),
  ];

  if (id) {
    db.run(
      `
      UPDATE transport_bilti SET
        transporter_id = ?,
        voucher_no = ?,
        outward_date = ?,
        dispatch_date = ?,
        destination = ?,
        days = ?,
        company_name = ?,
        account_name = ?,
        warehouse_name = ?,
        product_name = ?,
        lorry_no = ?,
        buyer_name = ?,
        consignee_name = ?,
        outward_qty = ?,
        dispatch_qty = ?,
        shortage_free_kg = ?,
        shortage_qty = ?,
        outward_rate = ?,
        shortage_amount = ?,
        transport_rate = ?,
        gross_freight = ?,
        detain_amount = ?,
        others_exp = ?,
        advance_amount = ?,
        tds_percent = ?,
        tds_amount = ?,
        net_amount = ?,
        payable_amount = ?,
        narration = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `,
      [...commonParams, id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Bilti updated successfully", id });
      }
    );
    return;
  }

  const saveLinkedBilti = ({ sourceColumn, sourceId, successPrefix }) => {
    db.get(
      `SELECT id, bilti_no FROM transport_bilti WHERE ${sourceColumn} = ?`,
      [sourceId],
      (err, existing) => {
        if (err) return res.status(500).json({ error: err.message });

        const doSave = (biltiNo) => {
          if (existing) {
            db.run(
              `
              UPDATE transport_bilti SET
                transporter_id = ?,
                voucher_no = ?,
                outward_date = ?,
                dispatch_date = ?,
                destination = ?,
                days = ?,
                company_name = ?,
                account_name = ?,
                warehouse_name = ?,
                product_name = ?,
                lorry_no = ?,
                buyer_name = ?,
                consignee_name = ?,
                outward_qty = ?,
                dispatch_qty = ?,
                shortage_free_kg = ?,
                shortage_qty = ?,
                outward_rate = ?,
                shortage_amount = ?,
                transport_rate = ?,
                gross_freight = ?,
                detain_amount = ?,
                others_exp = ?,
                advance_amount = ?,
                tds_percent = ?,
                tds_amount = ?,
                net_amount = ?,
                payable_amount = ?,
                narration = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE ${sourceColumn} = ?
              `,
              [...commonParams, sourceId],
              function (updateErr) {
                if (updateErr) return res.status(500).json({ error: updateErr.message });
                res.json({ message: "Bilti updated successfully", id: existing.id });
              }
            );
          } else {
            db.run(
              `
              INSERT INTO transport_bilti (
                outward_id,
                sale_id,
                bilti_no,
                transporter_id,
                voucher_no,
                outward_date,
                dispatch_date,
                destination,
                days,
                company_name,
                account_name,
                warehouse_name,
                product_name,
                lorry_no,
                buyer_name,
                consignee_name,
                outward_qty,
                dispatch_qty,
                shortage_free_kg,
                shortage_qty,
                outward_rate,
                shortage_amount,
                transport_rate,
                gross_freight,
                detain_amount,
                others_exp,
                advance_amount,
                tds_percent,
                tds_amount,
                net_amount,
                payable_amount,
                narration
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `,
              [
                sourceColumn === "outward_id" ? sourceId : null,
                sourceColumn === "sale_id" ? sourceId : null,
                biltiNo,
                ...commonParams,
              ],
              function (insertErr) {
                if (insertErr) return res.status(500).json({ error: insertErr.message });
                res.json({ message: `${successPrefix} bilti created successfully`, id: this.lastID });
              }
            );
          }
        };

        if (existing?.bilti_no) {
          doSave(existing.bilti_no);
        } else {
          nextBiltiNo((noErr, biltiNo) => {
            if (noErr) return res.status(500).json({ error: noErr.message });
            doSave(biltiNo);
          });
        }
      }
    );
  };

  if (outward_id) {
    saveLinkedBilti({ sourceColumn: "outward_id", sourceId: outward_id, successPrefix: "Outward" });
    return;
  }

  if (sale_id) {
    saveLinkedBilti({ sourceColumn: "sale_id", sourceId: sale_id, successPrefix: "Sale" });
    return;
  }

  nextBiltiNo((err, biltiNo) => {
    if (err) return res.status(500).json({ error: err.message });

    db.run(
      `
      INSERT INTO transport_bilti (
        outward_id,
        sale_id,
        bilti_no,
        transporter_id,
        voucher_no,
        outward_date,
        dispatch_date,
        destination,
        days,
        company_name,
        account_name,
        warehouse_name,
        product_name,
        lorry_no,
        buyer_name,
        consignee_name,
        outward_qty,
        dispatch_qty,
        shortage_free_kg,
        shortage_qty,
        outward_rate,
        shortage_amount,
        transport_rate,
        gross_freight,
        detain_amount,
        others_exp,
        advance_amount,
        tds_percent,
        tds_amount,
        net_amount,
        payable_amount,
        narration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [null, null, biltiNo, ...commonParams],
      function (insertErr) {
        if (insertErr) return res.status(500).json({ error: insertErr.message });
        res.json({ message: "Manual bilti created successfully", id: this.lastID });
      }
    );
  });
});

router.delete("/:id", (req, res) => {
  db.run(`DELETE FROM transport_bilti WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (!this.changes) return res.status(404).json({ error: "Bilti not found" });
    res.json({ message: "Bilti deleted successfully" });
  });
});

module.exports = router;
