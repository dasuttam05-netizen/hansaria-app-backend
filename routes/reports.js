const express = require("express");
const router = express.Router();
const db = require("../db");
const { userHasPermission } = require("../middleware/auth");

function parseIdList(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || "")
        .split(",");

  return Array.from(
    new Set(
      raw
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item > 0)
    )
  );
}

function appendMultiIdFilter(where, params, columnName, singleValue, multiValue) {
  const ids = parseIdList(multiValue || singleValue);
  if (!ids.length) return;
  where.push(`${columnName} IN (${ids.map(() => "?").join(",")})`);
  params.push(...ids);
}

function authorizeReport(permission) {
  return (req, res, next) => {
    if (!userHasPermission(req.user, permission)) {
      return res.status(403).json({ error: "You do not have permission to view this report" });
    }
    return next();
  };
}

function calculateMonthSlab(inwardDateStr, refDateStr) {
  const inwardDate = new Date(inwardDateStr);
  const refDate = new Date(refDateStr);

  const msPerDay = 1000 * 60 * 60 * 24;
  const daysDiff = Math.floor((refDate - inwardDate) / msPerDay);

  let monthsDiff = Math.floor((daysDiff <= 0 ? 0 : daysDiff - 1) / 30) + 1;
  if (monthsDiff < 1) monthsDiff = 1;

  return {
    daysDiff: daysDiff < 0 ? 0 : daysDiff,
    monthsDiff,
  };
}

function getMonthEndDate(monthStr) {
  const [year, month] = monthStr.split("-").map(Number);
  const d = new Date(year, month, 0);
  return d.toISOString().split("T")[0];
}

function getMonthLabel(monthStr) {
  const [year, month] = monthStr.split("-").map(Number);
  const d = new Date(year, month - 1, 1);
  const monthName = d.toLocaleString("en-US", { month: "long" }).toLowerCase();
  return `${monthName}-${year}`;
}

router.get("/party-ledger", authorizeReport("report.partyLedger"), (req, res) => {
  const { from_date, to_date, company_id, warehouse_id, warehouse_ids, product_id, location_id, location_ids } = req.query;

  let where = ["1=1"];
  const params = [];

  if (from_date) {
    where.push("i.date >= ?");
    params.push(from_date);
  }
  if (to_date) {
    where.push("i.date <= ?");
    params.push(to_date);
  }
  if (company_id) {
    where.push("i.company_id = ?");
    params.push(company_id);
  }
  appendMultiIdFilter(where, params, "i.location_id", location_id, location_ids);
  appendMultiIdFilter(where, params, "i.warehouse_id", warehouse_id, warehouse_ids);
  if (product_id) {
    where.push("i.product_id = ?");
    params.push(product_id);
  }

  const sql = `
    SELECT
      i.id,
      i.date,
      i.voucher_no,
      i.lorry_no,
      i.weight,
      i.company_id,
      i.company_account_id,
      c.id AS company_id_val,
      c.name AS party_name,
      c.address AS company_address,
      c.mobile AS company_mobile,
      ca.account_name AS account_name,
      w.name AS warehouse_name,
      p.name AS product_name,
      IFNULL(SUM(a.qty), 0) AS adjusted_qty
    FROM inward i
    LEFT JOIN companies c ON CAST(c.id AS TEXT) = CAST(i.company_id AS TEXT)
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(i.company_account_id AS TEXT)
    LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(i.warehouse_id AS TEXT)
    LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(i.product_id AS TEXT)
    LEFT JOIN adjustment a ON CAST(a.inward_id AS TEXT) = CAST(i.id AS TEXT)
    WHERE ${where.join(" AND ")}
    GROUP BY i.id
    ORDER BY i.date ASC, i.id ASC
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const refDate = to_date || new Date().toISOString().split("T")[0];

    const details = rows.map((row) => {
      const slab = calculateMonthSlab(row.date, refDate);
      const gross = Number(row.weight) || 0;
      const shortage = gross * 0.02 * slab.monthsDiff;
      const net = gross - shortage;
      const adjusted = Number(row.adjusted_qty) || 0;
      const balance = net - adjusted;

      return {
        id: row.id,
        date: row.date,
        party_name: row.party_name,
        company_address: row.company_address,
        company_mobile: row.company_mobile,
        company_account_id: row.company_account_id,
        account_name: row.account_name,
        warehouse_name: row.warehouse_name,
        product_name: row.product_name,
        voucher_no: row.voucher_no,
        lorry_no: row.lorry_no,
        gross_weight: Number(gross.toFixed(4)),
        days_diff: slab.daysDiff,
        months_diff: slab.monthsDiff,
        shortage_qty: Number(shortage.toFixed(4)),
        net_qty: Number(net.toFixed(4)),
        adjusted_qty: Number(adjusted.toFixed(4)),
        balance_qty: Number(balance.toFixed(4)),
      };
    });

    const summaryMap = {};
    details.forEach((row) => {
      const key = `${row.party_name || ""}::${row.company_account_id || row.account_name || ""}`;

      if (!summaryMap[key]) {
        summaryMap[key] = {
          party_name: row.party_name,
          company_address: row.company_address,
          company_mobile: row.company_mobile,
          company_account_id: row.company_account_id,
          account_name: row.account_name,
          gross_weight: 0,
          shortage_qty: 0,
          net_qty: 0,
          adjusted_qty: 0,
          balance_qty: 0,
        };
      }

      summaryMap[key].gross_weight += row.gross_weight;
      summaryMap[key].shortage_qty += row.shortage_qty;
      summaryMap[key].net_qty += row.net_qty;
      summaryMap[key].adjusted_qty += row.adjusted_qty;
      summaryMap[key].balance_qty += row.balance_qty;
    });

    const summary = Object.values(summaryMap).map((row) => ({
      ...row,
      gross_weight: Number(row.gross_weight.toFixed(4)),
      shortage_qty: Number(row.shortage_qty.toFixed(4)),
      net_qty: Number(row.net_qty.toFixed(4)),
      adjusted_qty: Number(row.adjusted_qty.toFixed(4)),
      balance_qty: Number(row.balance_qty.toFixed(4)),
    }));

    res.json({ summary, details });
  });
});

router.get("/party-stock", authorizeReport("report.partyStock"), (req, res) => {
  const {
    from_date,
    to_date,
    company_id,
    warehouse_id,
    warehouse_ids,
    product_id,
    employee_id,
    account_id,
    location_id,
    location_ids,
  } = req.query;

  const where = ["1=1"];
  const params = [];

  if (from_date) {
    where.push("i.date >= ?");
    params.push(from_date);
  }
  if (to_date) {
    where.push("i.date <= ?");
    params.push(to_date);
  }
  if (company_id) {
    where.push("i.company_id = ?");
    params.push(company_id);
  }
  appendMultiIdFilter(where, params, "i.location_id", location_id, location_ids);
  appendMultiIdFilter(where, params, "i.warehouse_id", warehouse_id, warehouse_ids);
  if (product_id) {
    where.push("i.product_id = ?");
    params.push(product_id);
  }
  if (employee_id) {
    where.push("i.employee_id = ?");
    params.push(employee_id);
  }
  if (account_id) {
    where.push("i.company_account_id = ?");
    params.push(account_id);
  }

  const sql = `
    SELECT
      i.id,
      i.date AS inward_date,
      i.employee_id,
      e.name AS employee_name,
      i.location_id,
      lo.name AS location_name,
      i.warehouse_id,
      w.name AS warehouse_name,
      i.product_id,
      p.name AS product_name,
      i.company_id,
      c.id AS company_id_val,
      c.name AS company_name,
      c.address AS company_address,
      c.mobile AS company_mobile,
      i.company_account_id,
      ca.account_name AS account_name,
      i.lorry_no,
      IFNULL(i.weight, 0) AS gross_weight,
      IFNULL(SUM(a.qty), 0) AS adjusted_qty,
      MAX(o.date) AS outward_date
    FROM inward i
    LEFT JOIN employees e ON e.id = i.employee_id
    LEFT JOIN locations lo ON lo.id = i.location_id
    LEFT JOIN warehouses w ON w.id = i.warehouse_id
    LEFT JOIN products p ON p.id = i.product_id
    LEFT JOIN companies c ON c.id = i.company_id
    LEFT JOIN company_accounts ca ON ca.id = i.company_account_id
    LEFT JOIN adjustment a ON a.inward_id = i.id
    LEFT JOIN outward o ON o.id = a.outward_id
    WHERE ${where.join(" AND ")}
    GROUP BY i.id
    ORDER BY i.date ASC, i.id ASC
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const refDate = to_date || new Date().toISOString().split("T")[0];

    const details = rows.map((row) => {
      const slab = calculateMonthSlab(row.inward_date, refDate);
      const gross = Number(row.gross_weight) || 0;
      const shortage = gross * 0.02 * slab.monthsDiff;
      const netOpening = gross - shortage;
      const adjusted = Number(row.adjusted_qty) || 0;
      const balance = netOpening - adjusted;
      const partyName = row.company_name || row.account_name || "Unknown Party";
      const warehouseName = row.warehouse_name || "-";

      return {
        id: row.id,
        date: row.inward_date,
        employee_name: row.employee_name,
        location_name: row.location_name,
        warehouse_name: warehouseName,
        product_name: row.product_name,
        company_id: row.company_id_val,
        company_name: partyName,
        company_address: row.company_address,
        company_mobile: row.company_mobile,
        account_name: row.account_name,
        lorry_no: row.lorry_no,
        gross_qty: Number(gross.toFixed(4)),
        shortage_qty: Number(shortage.toFixed(4)),
        net_opening_qty: Number(netOpening.toFixed(4)),
        already_adjusted_qty: Number(adjusted.toFixed(4)),
        available_balance_qty: Number(balance.toFixed(4)),
        inward_date: row.inward_date,
        outward_date: row.outward_date,
        days_diff: slab.daysDiff,
      };
    });

    const summaryMap = {};
    details.forEach((row) => {
      const key = `${row.company_name}||${row.warehouse_name || ""}`;

      if (!summaryMap[key]) {
        summaryMap[key] = {
          party_name: row.company_name || row.account_name || "Unknown Party",
          company_address: row.company_address,
          warehouse_name: row.warehouse_name || "-",
          gross_qty: 0,
          shortage_qty: 0,
          net_opening_qty: 0,
          already_adjusted_qty: 0,
          available_balance_qty: 0,
        };
      }

      const summaryRow = summaryMap[key];
      summaryRow.gross_qty += row.gross_qty;
      summaryRow.shortage_qty += row.shortage_qty;
      summaryRow.net_opening_qty += row.net_opening_qty;
      summaryRow.already_adjusted_qty += row.already_adjusted_qty;
      summaryRow.available_balance_qty += row.available_balance_qty;
    });

    const summary = Object.values(summaryMap).map((row) => ({
      ...row,
      gross_qty: Number(row.gross_qty.toFixed(4)),
      shortage_qty: Number(row.shortage_qty.toFixed(4)),
      net_opening_qty: Number(row.net_opening_qty.toFixed(4)),
      already_adjusted_qty: Number(row.already_adjusted_qty.toFixed(4)),
      available_balance_qty: Number(row.available_balance_qty.toFixed(4)),
    }));

    res.json({ summary, details });
  });
});

function calculateAvailableQty(weight, inwardDate, alreadyAdjusted, refDate = new Date().toISOString().split("T")[0]) {
  const gross = Number(weight) || 0;
  const slab = calculateMonthSlab(inwardDate, refDate);
  const shortage = gross * 0.02 * slab.monthsDiff;
  return gross - shortage - Number(alreadyAdjusted || 0);
}

router.get("/warehouse-stock", authorizeReport("report.partyStock"), (req, res) => {
  const {
    from_date,
    to_date,
    company_id,
    warehouse_id,
    warehouse_ids,
    location_id,
    location_ids,
    product_id,
  } = req.query;
  const where = ["1=1"];
  const params = [];

  if (from_date) {
    where.push("i.date >= ?");
    params.push(from_date);
  }
  if (to_date) {
    where.push("i.date <= ?");
    params.push(to_date);
  }
  if (company_id) {
    where.push("i.company_id = ?");
    params.push(company_id);
  }
  appendMultiIdFilter(where, params, "i.location_id", location_id, location_ids);
  appendMultiIdFilter(where, params, "i.warehouse_id", warehouse_id, warehouse_ids);
  if (product_id) {
    where.push("i.product_id = ?");
    params.push(product_id);
  }

  const sql = `
    SELECT
      i.id,
      i.company_id,
      i.location_id,
      i.warehouse_id,
      c.name AS party_name,
      lo.name AS location_name,
      COALESCE(w.name, 'Unknown') AS warehouse,
      i.weight,
      i.date AS inward_date,
      IFNULL((
        SELECT SUM(a.qty)
        FROM adjustment a
        WHERE a.inward_id = i.id
      ), 0) AS already_adjusted
    FROM inward i
    LEFT JOIN companies c ON c.id = i.company_id
    LEFT JOIN locations lo ON lo.id = i.location_id
    LEFT JOIN warehouses w ON w.id = i.warehouse_id
    WHERE ${where.join(" AND ")}
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const warehouseMap = {};
    rows.forEach((row) => {
      const availableQty = calculateAvailableQty(row.weight, row.inward_date, row.already_adjusted, to_date || new Date().toISOString().split("T")[0]);
      const warehouseName = row.warehouse || "Unknown";
      const partyName = row.party_name || "Unknown";
      const locationName = row.location_name || "Unknown";
      const key = `${warehouseName}::${partyName}::${locationName}`;

      if (!warehouseMap[key]) {
        warehouseMap[key] = {
          warehouse: warehouseName,
          party: partyName,
          location: locationName,
          stock: 0,
        };
      }

      warehouseMap[key].stock += availableQty;
    });

    const result = Object.values(warehouseMap).map((item) => ({
      warehouse: item.warehouse,
      party: item.party,
      location: item.location,
      stock: Number(item.stock.toFixed(4)),
    }));

    result.sort((a, b) => {
      const warehouseSort = String(a.warehouse).localeCompare(String(b.warehouse));
      if (warehouseSort) return warehouseSort;
      const partySort = String(a.party).localeCompare(String(b.party));
      if (partySort) return partySort;
      return String(a.location).localeCompare(String(b.location));
    });
    res.json(result);
  });
});

router.get("/total-stock", authorizeReport("report.partyStock"), (req, res) => {
  const {
    from_date,
    to_date,
    company_id,
    warehouse_id,
    warehouse_ids,
    location_id,
    location_ids,
    product_id,
  } = req.query;
  const where = ["1=1"];
  const params = [];

  if (from_date) {
    where.push("i.date >= ?");
    params.push(from_date);
  }
  if (to_date) {
    where.push("i.date <= ?");
    params.push(to_date);
  }
  if (company_id) {
    where.push("i.company_id = ?");
    params.push(company_id);
  }
  appendMultiIdFilter(where, params, "i.location_id", location_id, location_ids);
  appendMultiIdFilter(where, params, "i.warehouse_id", warehouse_id, warehouse_ids);
  if (product_id) {
    where.push("i.product_id = ?");
    params.push(product_id);
  }

  const sql = `
    SELECT
      i.weight,
      i.date AS inward_date,
      IFNULL((
        SELECT SUM(a.qty)
        FROM adjustment a
        WHERE a.inward_id = i.id
      ), 0) AS already_adjusted
    FROM inward i
    WHERE ${where.join(" AND ")}
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const refDate = to_date || new Date().toISOString().split("T")[0];
    const total = rows.reduce((acc, row) => acc + calculateAvailableQty(row.weight, row.inward_date, row.already_adjusted, refDate), 0);

    res.json({ total: Number(total.toFixed(4)) });
  });
});

router.get("/warehouse-rent-ledger", authorizeReport("report.warehouseRentLedger"), (req, res) => {
  const { from_date, to_date, company_id, warehouse_id, warehouse_ids, location_id, location_ids } = req.query;

  let where = ["1=1"];
  const params = [];

  if (from_date) {
    where.push("i.date >= ?");
    params.push(from_date);
  }
  if (to_date) {
    where.push("i.date <= ?");
    params.push(to_date);
  }
  if (company_id) {
    where.push("i.company_id = ?");
    params.push(company_id);
  }
  appendMultiIdFilter(where, params, "i.location_id", location_id, location_ids);
  appendMultiIdFilter(where, params, "i.warehouse_id", warehouse_id, warehouse_ids);

  const sql = `
    SELECT
      i.id,
      i.date,
      i.voucher_no,
      i.lorry_no,
      i.weight,
      i.remaining_qty,
      c.name AS party_name,
      w.name AS warehouse_name,
      IFNULL(SUM(a.qty), 0) AS adjusted_qty,
      MAX(a.created_at) AS last_adjustment_date
    FROM inward i
    LEFT JOIN companies c ON c.id = i.company_id
    LEFT JOIN warehouses w ON w.id = i.warehouse_id
    LEFT JOIN adjustment a ON a.inward_id = i.id
    WHERE ${where.join(" AND ")}
    GROUP BY i.id
    ORDER BY i.date ASC, i.id ASC
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const today = new Date().toISOString().split("T")[0];

    const result = rows.map((row) => {
      const refDate =
        row.last_adjustment_date
          ? String(row.last_adjustment_date).split(" ")[0]
          : (to_date || today);

      const slab = calculateMonthSlab(row.date, refDate);
      const originalWeight = Number(row.weight) || 0;
      const adjustedQty = Number(row.adjusted_qty) || 0;
      const balanceQty = Number(row.remaining_qty) || 0;
      const rentRate = 200;
      const rentAmount = originalWeight * rentRate * slab.monthsDiff;

      return {
        id: row.id,
        inward_date: row.date,
        reference_date: refDate,
        days_diff: slab.daysDiff,
        month_slab: slab.monthsDiff,
        party_name: row.party_name,
        warehouse_name: row.warehouse_name,
        voucher_no: row.voucher_no,
        lorry_no: row.lorry_no,
        original_weight: Number(originalWeight.toFixed(4)),
        adjusted_qty: Number(adjustedQty.toFixed(4)),
        balance_qty: Number(balanceQty.toFixed(4)),
        rent_rate: rentRate,
        rent_amount: Number(rentAmount.toFixed(2)),
      };
    });

    res.json(result);
  });
});

router.get("/warehouse-rent-month-end", authorizeReport("report.warehouseRentMonthEnd"), (req, res) => {
  const { month, company_id, warehouse_id, warehouse_ids, location_id, location_ids } = req.query;

  if (!month) {
    return res.status(400).json({ error: "month required in YYYY-MM format" });
  }

  const monthEndDate = getMonthEndDate(month);
  const monthLabel = getMonthLabel(month);

  let where = ["i.date <= ?"];
  const params = [monthEndDate];

  if (company_id) {
    where.push("i.company_id = ?");
    params.push(company_id);
  }
  appendMultiIdFilter(where, params, "i.location_id", location_id, location_ids);
  appendMultiIdFilter(where, params, "i.warehouse_id", warehouse_id, warehouse_ids);

  const sql = `
    SELECT
      i.id,
      i.date,
      i.voucher_no,
      i.lorry_no,
      i.weight,
      IFNULL(SUM(a.qty), 0) AS adjusted_qty,
      c.name AS party_name,
      w.name AS warehouse_name
    FROM inward i
    LEFT JOIN companies c ON c.id = i.company_id
    LEFT JOIN warehouses w ON w.id = i.warehouse_id
    LEFT JOIN adjustment a ON a.inward_id = i.id
    WHERE ${where.join(" AND ")}
    GROUP BY i.id
    ORDER BY i.date ASC, i.id ASC
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const inwardIds = rows.map((row) => row.id);

    if (!inwardIds.length) {
      return res.json({
        month,
        month_label: monthLabel,
        month_end_date: monthEndDate,
        summary: [],
        details: [],
      });
    }

    const placeholders = inwardIds.map(() => "?").join(",");
    const adjustmentSql = `
      SELECT
        inward_id,
        qty,
        created_at
      FROM adjustment
      WHERE inward_id IN (${placeholders})
        AND DATE(created_at) <= ?
      ORDER BY DATE(created_at) ASC, id ASC
    `;

    db.all(adjustmentSql, [...inwardIds, monthEndDate], (adjustmentErr, adjustmentRows) => {
      if (adjustmentErr) return res.status(500).json({ error: adjustmentErr.message });

      const adjustmentMap = {};
      adjustmentRows.forEach((item) => {
        if (!adjustmentMap[item.inward_id]) {
          adjustmentMap[item.inward_id] = [];
        }
        adjustmentMap[item.inward_id].push(item);
      });

      const detailed = rows.map((row) => {
        const monthEndSlab = calculateMonthSlab(row.date, monthEndDate);
        const originalWeight = Number(row.weight) || 0;
        const rentRate = 200;
        const adjustments = adjustmentMap[row.id] || [];

        let adjustedQty = 0;
        let adjustedRentAmount = 0;

        adjustments.forEach((adjustment) => {
          const adjustmentQty = Number(adjustment.qty) || 0;
          const adjustmentDate = String(adjustment.created_at).split(" ")[0];
          const adjustmentSlab = calculateMonthSlab(row.date, adjustmentDate);

          adjustedQty += adjustmentQty;
          adjustedRentAmount += adjustmentQty * rentRate * adjustmentSlab.monthsDiff;
        });

        const shortageQty = originalWeight * 0.02 * monthEndSlab.monthsDiff;
        const balanceQty = originalWeight - shortageQty - adjustedQty;
        const balanceRentAmount = Math.max(balanceQty, 0) * rentRate * monthEndSlab.monthsDiff;
        const rentAmount = adjustedRentAmount + balanceRentAmount;

        return {
          id: row.id,
          month,
          month_label: monthLabel,
          month_end_date: monthEndDate,
          inward_date: row.date,
          party_name: row.party_name,
          warehouse_name: row.warehouse_name,
          voucher_no: row.voucher_no,
          lorry_no: row.lorry_no,
          original_weight: Number(originalWeight.toFixed(4)),
          adjusted_qty: Number(adjustedQty.toFixed(4)),
          shortage_qty: Number(shortageQty.toFixed(4)),
          balance_qty: Number(balanceQty.toFixed(4)),
          days_diff: monthEndSlab.daysDiff,
          month_slab: monthEndSlab.monthsDiff,
          rent_rate: rentRate,
          adjusted_rent_amount: Number(adjustedRentAmount.toFixed(2)),
          balance_rent_amount: Number(balanceRentAmount.toFixed(2)),
          rent_amount: Number(rentAmount.toFixed(2)),
        };
      });

      const summaryMap = {};

      detailed.forEach((row) => {
        const key = `${row.party_name}__${row.warehouse_name}`;
        if (!summaryMap[key]) {
          summaryMap[key] = {
            month: row.month,
            month_label: row.month_label,
            month_end_date: row.month_end_date,
            party_name: row.party_name,
            warehouse_name: row.warehouse_name,
            total_weight: 0,
            total_rent: 0,
            total_entries: 0,
          };
        }

        summaryMap[key].total_weight += Number(row.original_weight) || 0;
        summaryMap[key].total_rent += Number(row.rent_amount) || 0;
        summaryMap[key].total_entries += 1;
      });

      const summary = Object.values(summaryMap).map((summaryRow) => ({
        ...summaryRow,
        total_weight: Number(summaryRow.total_weight.toFixed(4)),
        total_rent: Number(summaryRow.total_rent.toFixed(2)),
      }));

      res.json({
        month,
        month_label: monthLabel,
        month_end_date: monthEndDate,
        summary,
        details: detailed,
      });
    });
  });
});

router.get("/palti-lorry-adjustment", authorizeReport("report.paltiLorryAdjustment"), (req, res) => {
  const { from_date, to_date, company_id, warehouse_id, outward_id } = req.query;
  const where = ["1=1"];
  const params = [];

  if (from_date) {
    where.push("p.expense_date >= ?");
    params.push(from_date);
  }
  if (to_date) {
    where.push("p.expense_date <= ?");
    params.push(to_date);
  }
  if (company_id) {
    where.push("p.company_id = ?");
    params.push(company_id);
  }
  if (warehouse_id) {
    where.push("p.warehouse_id = ?");
    params.push(warehouse_id);
  }
  if (outward_id) {
    where.push("a.outward_id = ?");
    params.push(outward_id);
  }

  const sql = `
    SELECT
      p.id AS palti_id,
      p.voucher_no AS palti_voucher_no,
      p.expense_date AS palti_date,
      p.balance AS palti_balance,
      p.reg_lorry_no,
      p.new_lorry_no,
      p.new_weight,
      p.company_id,
      c.name AS company_name,
      pr.name AS product_name,
      w.name AS warehouse_name,
      COALESCE(cn.name, rc.name) AS reg_from_name,
      a.id AS adjustment_id,
      a.outward_id,
      COALESCE(a.source_type, 'inward') AS source_type,
      a.qty AS adjusted_qty,
      a.created_at AS adjusted_at,
      o.date AS outward_date,
      o.voucher_no AS outward_voucher_no,
      o.lorry_no AS outward_lorry_no,
      COALESCE(oc.name, oca.account_name, '-') AS outward_party_name,
      IFNULL((
        SELECT SUM(ax.qty)
        FROM adjustment ax
        WHERE ax.palti_lorry_id = p.id
          AND COALESCE(ax.source_type, 'inward') = 'palti_lorry'
      ), 0) AS total_adjusted_qty
    FROM palti_lorry_entries p
    LEFT JOIN companies c ON c.id = p.company_id
    LEFT JOIN products pr ON pr.id = p.product_id
    LEFT JOIN warehouses w ON w.id = p.warehouse_id
    LEFT JOIN consignee_names cn ON cn.id = p.reg_from_consignee_id
    LEFT JOIN companies rc ON rc.id = p.reg_from_company_id
    LEFT JOIN adjustment a
      ON a.palti_lorry_id = p.id
      AND COALESCE(a.source_type, 'inward') = 'palti_lorry'
    LEFT JOIN outward o ON o.id = a.outward_id
    LEFT JOIN companies oc ON oc.id = o.company_id
    LEFT JOIN company_accounts oca ON oca.id = o.company_account_id
    WHERE ${where.join(" AND ")}
    ORDER BY p.expense_date DESC, p.id DESC, a.id DESC
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const details = (rows || []).map((row) => {
      const paltiBalance = Number(row.palti_balance || 0);
      const totalAdjusted = Number(row.total_adjusted_qty || 0);
      const availableBalance = paltiBalance - totalAdjusted;

      return {
        palti_id: row.palti_id,
        palti_voucher_no: row.palti_voucher_no,
        palti_date: row.palti_date,
        warehouse_name: row.warehouse_name,
        product_name: row.product_name,
        company_name: row.company_name,
        reg_from_name: row.reg_from_name,
        reg_lorry_no: row.reg_lorry_no,
        new_lorry_no: row.new_lorry_no,
        display_lorry_no:
          String(row.new_lorry_no || "").trim() ||
          String(row.reg_lorry_no || "").trim() ||
          "-",
        new_weight: Number(row.new_weight || 0),
        palti_balance: Number(paltiBalance.toFixed(4)),
        total_adjusted_qty: Number(totalAdjusted.toFixed(4)),
        available_balance: Number(availableBalance.toFixed(4)),
        adjustment_id: row.adjustment_id,
        outward_id: row.outward_id,
        outward_voucher_no: row.outward_voucher_no,
        outward_date: row.outward_date,
        outward_lorry_no: row.outward_lorry_no,
        outward_party_name: row.outward_party_name,
        source_type: row.source_type,
        adjusted_qty: Number(row.adjusted_qty || 0),
        adjusted_at: row.adjusted_at,
      };
    });

    const summary = details.reduce(
      (acc, row) => {
        if (!acc.uniquePaltiIds.has(row.palti_id)) {
          acc.uniquePaltiIds.add(row.palti_id);
          acc.total_palti_balance += Number(row.palti_balance || 0);
          acc.total_adjusted_qty += Number(row.total_adjusted_qty || 0);
          acc.total_available_balance += Number(row.available_balance || 0);
        }
        acc.total_adjustment_rows += row.adjustment_id ? 1 : 0;
        acc.total_adjusted_dispatched += Number(row.adjusted_qty || 0);
        return acc;
      },
      {
        uniquePaltiIds: new Set(),
        total_palti_balance: 0,
        total_adjusted_qty: 0,
        total_available_balance: 0,
        total_adjusted_dispatched: 0,
        total_adjustment_rows: 0,
      }
    );

    return res.json({
      summary: {
        total_palti_entries: summary.uniquePaltiIds.size,
        total_palti_balance: Number(summary.total_palti_balance.toFixed(4)),
        total_adjusted_qty: Number(summary.total_adjusted_qty.toFixed(4)),
        total_available_balance: Number(summary.total_available_balance.toFixed(4)),
        total_adjusted_dispatched: Number(summary.total_adjusted_dispatched.toFixed(4)),
        total_adjustment_rows: summary.total_adjustment_rows,
      },
      details,
    });
  });
});

module.exports = router;
