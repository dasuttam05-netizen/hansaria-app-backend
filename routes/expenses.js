const express = require("express");
const router = express.Router();
const db = require("../db");
const { canAccessWarehouse, assignedWarehouseFilter } = require("../helpers/access");
const { userHasPermission } = require("../middleware/auth");

const WORK_DESCRIPTION_OPTIONS = [
  "Palti Lorry",
  "Self Loading",
  "Local Sale",
  "Warehouse Inward",
  "Warehouse Outward",
  "Others",
];

function nextVoucher(callback) {
  db.get(
    "SELECT id FROM expenses ORDER BY id DESC LIMIT 1",
    [],
    (err, row) => {
      if (err) {
        callback(err);
        return;
      }

      const nextId = (row?.id || 0) + 1;
      callback(null, `EXP-${String(nextId).padStart(4, "0")}`);
    }
  );
}

function loadExpenseItems(expenseId, callback) {
  db.all(
    `
    SELECT id, line_no, particular_name, bags, rate, amount
    FROM expense_items
    WHERE expense_id = ?
    ORDER BY line_no ASC, id ASC
    `,
    [expenseId],
    callback
  );
}

function formatInwardVoucher(slNo) {
  return `INV${String(slNo).padStart(3, "0")}`;
}

function formatOutwardVoucher(slNo) {
  return `OUT-${String(slNo).padStart(4, "0")}`;
}

function normalizeWorkDescription(value) {
  const cleaned = String(value || "").trim();
  return WORK_DESCRIPTION_OPTIONS.includes(cleaned) ? cleaned : null;
}

function shouldPostExpenseToInward(expense) {
  return String(expense?.work_description || "").trim() === "Warehouse Inward";
}

function shouldPostExpenseToOutward(expense) {
  const work = String(expense?.work_description || "").trim();
  return work === "Warehouse Outward" || work === "Self Loading";
}

function normalizeLorryNo(...values) {
  for (const value of values) {
    const cleaned = String(value ?? '').trim();
    if (cleaned && cleaned !== '0') {
      return cleaned;
    }
  }
  return '';
}

function calculateExpenseBalance(loading, unloading, shortage, excess) {
  const total =
    (Number(loading) || 0) -
    (Number(unloading) || 0) -
    (Number(shortage) || 0) +
    (Number(excess) || 0);

  return Number(total.toFixed(2));
}

function resolveWarehouseForLocation(user, locationId, callback) {
  const normalizedLocationId = Number(locationId);
  if (!Number.isFinite(normalizedLocationId) || normalizedLocationId <= 0) {
    callback(new Error("Location is required"));
    return;
  }

  const assignedIds = user?.assigned_warehouse_ids || [];
  const canUseAllWarehouses =
    !user || user.role === "admin" || userHasPermission(user, "warehouses.manage");

  const params = [normalizedLocationId];
  let sql = `
    SELECT id
    FROM warehouses
    WHERE location_id = ?
  `;

  if (!canUseAllWarehouses) {
    if (assignedIds.length === 0) {
      callback(new Error("You do not have access to this location"));
      return;
    }
    sql += ` AND id IN (${assignedIds.map(() => "?").join(",")})`;
    params.push(...assignedIds);
  }

  sql += ` ORDER BY id ASC`;

  db.all(sql, params, (err, rows) => {
    if (err) {
      callback(err);
      return;
    }

    if (!rows || rows.length === 0) {
      callback(new Error("No warehouse is mapped with the selected location"));
      return;
    }

    callback(null, Number(rows[0].id));
  });
}

function postExpenseToInward(expense, callback) {
  if (!expense || Number(expense.posted_to_inward || 0) === 1 || Number(expense.inward_id || 0) > 0) {
    callback(null, { posted: false, already_posted: true, inward_id: expense?.inward_id || null });
    return;
  }

  const inwardWeight =
    Number(expense.new_weight) || Number(expense.net_weight) || Number(expense.balance) || 0;
  const lorryNo = normalizeLorryNo(expense.reg_lorry_no, expense.new_lorry_no);
  const narrationParts = [`From Expense ${expense.voucher_no || ""}`.trim()];
  if (expense.work_description) narrationParts.push(`Work: ${expense.work_description}`);
  const narrationText = narrationParts.join(" | ");

  db.get("SELECT MAX(sl_no) AS max_sl FROM inward", [], (maxErr, row) => {
    if (maxErr) {
      callback(maxErr);
      return;
    }

    const nextSl = row?.max_sl ? Number(row.max_sl) + 1 : 1;
    const inwardVoucher = formatInwardVoucher(nextSl);
    db.run(
      `
      INSERT INTO inward (
        sl_no, voucher_no, date, employee_id, location_id, warehouse_id,
        product_id, company_id, company_account_id, lorry_no, weight, remaining_qty, narration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        nextSl,
        inwardVoucher,
        expense.expense_date,
        expense.employee_id || null,
        expense.location_id || expense.warehouse_location_id || null,
        expense.warehouse_id || null,
        expense.product_id || null,
        expense.company_id || null,
        expense.company_account_id || null,
        lorryNo || null,
        inwardWeight,
        inwardWeight,
        narrationText,
      ],
      function onInwardInsert(insertErr) {
        if (insertErr) {
          callback(insertErr);
          return;
        }

        const inwardId = this.lastID;
        db.run(
          "UPDATE expenses SET posted_to_inward = 1, inward_id = ?, inward_posted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [inwardId, expense.id],
          (updateErr) => {
            if (updateErr) {
              callback(updateErr);
              return;
            }
            callback(null, {
              posted: true,
              inward_id: inwardId,
              inward_voucher_no: inwardVoucher,
            });
          }
        );
      }
    );
  });
}

function postExpenseToPaltiLorry(expense, userId, callback) {
  if (!expense || Number(expense.posted_to_palti || 0) === 1) {
    callback(null, { posted: false, already_posted: true });
    return;
  }

  db.run(
    `
    INSERT INTO palti_lorry_entries (
      expense_id, voucher_no, expense_date, warehouse_id, employee_id, product_id,
      company_id, reg_from_consignee_id, reg_from_company_id, reg_lorry_no,
      balance, new_lorry_no, new_weight, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      expense.id,
      expense.voucher_no || null,
      expense.expense_date || null,
      expense.warehouse_id || null,
      expense.employee_id || null,
      expense.product_id || null,
      expense.company_id || null,
      expense.reg_from_consignee_id || null,
      expense.reg_from_company_id || null,
      normalizeLorryNo(expense.reg_lorry_no),
      Number(expense.balance) || 0,
      normalizeLorryNo(expense.reg_lorry_no, expense.new_lorry_no),
      Number(expense.new_weight) || 0,
      userId || null,
    ],
    function insertPalti(insertErr) {
      if (insertErr) {
        if (String(insertErr.message || "").includes("UNIQUE constraint failed")) {
          db.run(
            "UPDATE expenses SET posted_to_palti = 1, palti_posted_at = COALESCE(palti_posted_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [expense.id],
            () => callback(null, { posted: false, already_posted: true })
          );
          return;
        }
        callback(insertErr);
        return;
      }

      db.run(
        "UPDATE expenses SET posted_to_palti = 1, palti_posted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [expense.id],
        (updateErr) => {
          if (updateErr) {
            callback(updateErr);
            return;
          }
          callback(null, { posted: true, palti_id: this.lastID });
        }
      );
    }
  );
}
function shouldPostExpenseToPaltiLorry(expense) {
  const workDescription = String(expense?.work_description || "").trim().toLowerCase();
  return expense?.send_to_kind === "palti_lorry" || workDescription === "palti lorry";
}

function postExpenseToOutward(expense, callback) {
  if (!expense || Number(expense.posted_to_outward || 0) === 1 || Number(expense.outward_id || 0) > 0) {
    callback(null, { posted: false, already_posted: true, outward_id: expense?.outward_id || null });
    return;
  }

  const outwardQty = Number(expense.balance) || Number(expense.new_weight) || 0;
  const lorryNo = normalizeLorryNo(expense.reg_lorry_no, expense.new_lorry_no);
  const outwardDate = expense.expense_date || null;
  const isSelfLoading = String(expense?.work_description || "").trim() === "Self Loading";

  db.get("SELECT IFNULL(MAX(sl_no),0)+1 as sl FROM outward", [], (slErr, row) => {
    if (slErr) {
      callback(slErr);
      return;
    }

    const nextSl = row?.sl || 1;
    const outwardVoucher = formatOutwardVoucher(nextSl);

    db.run(
      `
      INSERT INTO outward (
        sl_no, voucher_no, date, employee_id, location_id, warehouse_id,
        product_id, company_id, company_account_id, buyer_name, consignee_name,
        lorry_no, weight, quantity, rate, amount, inv_no, narration, status, self_loading
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        nextSl,
        outwardVoucher,
        outwardDate,
        expense.employee_id || null,
        expense.location_id || expense.warehouse_location_id || null,
        isSelfLoading ? null : expense.warehouse_id || null,
        expense.product_id || null,
        expense.company_id || null,
        expense.company_account_id || null,
        null,
        null,
        lorryNo || null,
        outwardQty,
        outwardQty,
        0,
        0,
        expense.voucher_no || null,
        `From Expense ${expense.voucher_no || ""}`.trim(),
        "Pending",
        isSelfLoading ? "Yes" : "No",
      ],
      function onOutwardInsert(insertErr) {
        if (insertErr) {
          callback(insertErr);
          return;
        }

        const outwardId = this.lastID;
        db.run(
          "UPDATE expenses SET posted_to_outward = 1, outward_id = ?, outward_posted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [outwardId, expense.id],
          (updateErr) => {
            if (updateErr) {
              callback(updateErr);
              return;
            }

            callback(null, {
              posted: true,
              outward_id: outwardId,
              outward_voucher_no: outwardVoucher,
            });
          }
        );
      }
    );
  });
}

router.get("/", (req, res) => {
  if (
    !userHasPermission(req.user, "expense.entry") &&
    !userHasPermission(req.user, "expense.view") &&
    !userHasPermission(req.user, "expense.create") &&
    !userHasPermission(req.user, "expense.edit") &&
    !userHasPermission(req.user, "expense.delete") &&
    !userHasPermission(req.user, "report.expense")
  ) {
    return res.status(403).json({ error: "You do not have permission to view expenses" });
  }
  const { status } = req.query;
  const warehouseFilter = assignedWarehouseFilter(req.user, "x.warehouse_id");
  const whereParts = ["1 = 1"];
  const params = [];

  if (status) {
    whereParts.push("x.status = ?");
    params.push(status);
  }

  params.push(...warehouseFilter.params);
  db.all(
    `
    SELECT
      x.*,
      COALESCE(x.location_id, w.location_id) AS effective_location_id,
      COALESCE(loc.name, wl.name) AS location_name,
      w.name AS warehouse_name,
      e.name AS employee_name,
      p.name AS product_name,
      c.name AS company_name,
      ca.account_name AS company_account_name,
      COALESCE(rcn.name, rf.name) AS reg_from_company_name,
      COALESCE(
        CASE x.send_to_kind
          WHEN 'consignee' THEN cn_st.name
          WHEN 'company' THEN c_st.name
          WHEN 'warehouse' THEN wh_st.name
          WHEN 'palti_lorry' THEN 'Palti Lorry'
          ELSE NULL
        END,
        bpn.name,
        st.name
      ) AS send_to_company_name
    FROM expenses x
    LEFT JOIN warehouses w ON w.id = x.warehouse_id
    LEFT JOIN locations loc ON loc.id = x.location_id
    LEFT JOIN locations wl ON wl.id = w.location_id
    LEFT JOIN employees e ON e.id = x.employee_id
    LEFT JOIN products p ON p.id = x.product_id
    LEFT JOIN companies c ON c.id = x.company_id
    LEFT JOIN company_accounts ca ON ca.id = x.company_account_id
    LEFT JOIN consignee_names rcn ON rcn.id = x.reg_from_consignee_id
    LEFT JOIN companies rf ON rf.id = x.reg_from_company_id
    LEFT JOIN consignee_names cn_st ON x.send_to_kind = 'consignee' AND cn_st.id = x.send_to_ref_id
    LEFT JOIN companies c_st ON x.send_to_kind = 'company' AND c_st.id = x.send_to_ref_id
    LEFT JOIN warehouses wh_st ON x.send_to_kind = 'warehouse' AND wh_st.id = x.send_to_ref_id
    LEFT JOIN buyer_names bpn ON bpn.id = x.send_to_party_id
    LEFT JOIN companies st ON st.id = x.send_to_company_id
    WHERE ${whereParts.join(" AND ")} ${warehouseFilter.clause}
    ORDER BY x.id DESC
    `,
    params,
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      const entries = rows || [];
      if (entries.length === 0) {
        return res.json([]);
      }

      const expenseIds = entries.map((entry) => entry.id);
      db.all(
        `
        SELECT expense_id, id, line_no, particular_name, bags, rate, amount
        FROM expense_items
        WHERE expense_id IN (${expenseIds.map(() => "?").join(",")})
        ORDER BY line_no ASC, id ASC
        `,
        expenseIds,
        (itemsErr, items) => {
          if (itemsErr) {
            return res.status(500).json({ error: itemsErr.message });
          }

          const itemMap = new Map();
          (items || []).forEach((item) => {
            if (!itemMap.has(item.expense_id)) {
              itemMap.set(item.expense_id, []);
            }
            itemMap.get(item.expense_id).push(item);
          });

          return res.json(
            entries.map((entry) => ({
              ...entry,
              items: itemMap.get(entry.id) || [],
            }))
          );
        }
      );
    }
  );
});


router.get("/inward-posted", (req, res) => {
  if (!userHasPermission(req.user, "expense.postedInward")) {
    return res.status(403).json({ error: "You do not have permission to view posted inward list" });
  }

  const warehouseFilter = assignedWarehouseFilter(req.user, "x.warehouse_id");
  db.all(
    `
    SELECT
      x.id AS expense_id,
      x.voucher_no AS expense_voucher_no,
      x.expense_date,
      x.work_description,
      COALESCE(x.location_id, w.location_id) AS effective_location_id,
      COALESCE(loc.name, wl.name) AS location_name,
      x.inward_posted_at,
      x.inward_id,
      i.voucher_no AS inward_voucher_no,
      i.date AS inward_date,
      i.narration AS inward_narration,
      w.name AS warehouse_name,
      e.name AS employee_name,
      p.name AS product_name,
      c.name AS company_name
    FROM expenses x
    LEFT JOIN inward i ON i.id = x.inward_id
    LEFT JOIN warehouses w ON w.id = x.warehouse_id
    LEFT JOIN locations loc ON loc.id = x.location_id
    LEFT JOIN locations wl ON wl.id = w.location_id
    LEFT JOIN employees e ON e.id = x.employee_id
    LEFT JOIN products p ON p.id = x.product_id
    LEFT JOIN companies c ON c.id = x.company_id
    WHERE x.posted_to_inward = 1 ${warehouseFilter.clause}
    ORDER BY x.inward_posted_at DESC, x.id DESC
    `,
    warehouseFilter.params,
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      return res.json(rows || []);
    }
  );
});

router.get("/:id", (req, res) => {
  if (
    !userHasPermission(req.user, "expense.entry") &&
    !userHasPermission(req.user, "expense.view") &&
    !userHasPermission(req.user, "expense.create") &&
    !userHasPermission(req.user, "expense.edit") &&
    !userHasPermission(req.user, "report.expense")
  ) {
    return res.status(403).json({ error: "You do not have permission to view expense entries" });
  }

  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid expense id" });
  }

  const warehouseFilter = assignedWarehouseFilter(req.user, "e.warehouse_id");
  const params = [id, ...warehouseFilter.params];

  db.get(
    `
    SELECT
      e.*,
      l.name AS location_name,
      w.name AS warehouse_name,
      w.location_id AS warehouse_location_id,
      emp.name AS employee_name,
      pr.name AS product_name,
      c.name AS company_name,
      ca.account_name AS company_account_name,
      cn.name AS reg_from_consignee_name,
      rc.name AS reg_from_company_name,
      stc.name AS send_to_company_name
    FROM expenses e
    LEFT JOIN locations l ON l.id = e.location_id
    LEFT JOIN warehouses w ON w.id = e.warehouse_id
    LEFT JOIN employees emp ON emp.id = e.employee_id
    LEFT JOIN products pr ON pr.id = e.product_id
    LEFT JOIN companies c ON c.id = e.company_id
    LEFT JOIN company_accounts ca ON ca.id = e.company_account_id
    LEFT JOIN consignee_names cn ON cn.id = e.reg_from_consignee_id
    LEFT JOIN companies rc ON rc.id = e.reg_from_company_id
    LEFT JOIN companies stc ON stc.id = e.send_to_company_id
    WHERE e.id = ? ${warehouseFilter.clause}
    `,
    params,
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      if (!row) {
        return res.status(404).json({ error: "Expense entry not found" });
      }

      loadExpenseItems(id, (itemsErr, items = []) => {
        if (itemsErr) {
          return res.status(500).json({ error: itemsErr.message });
        }

        return res.json({
          ...row,
          items: Array.isArray(items) ? items : [],
        });
      });
    }
  );
});

router.post("/:id/approve-cash-book", (req, res) => {
  if (!userHasPermission(req.user, "expense.edit") || !userHasPermission(req.user, "cash.create")) {
    return res.status(403).json({ error: "You need both expense edit and cash create permission to approve to cash book" });
  }
  const { id } = req.params;

  db.get(
    `
    SELECT
      x.*,
      w.location_id AS warehouse_location_id,
      COALESCE(loc.name, wl.name) AS location_name,
      w.name AS warehouse_name,
      c.name AS company_name
    FROM expenses x
    LEFT JOIN warehouses w ON w.id = x.warehouse_id
    LEFT JOIN locations loc ON loc.id = x.location_id
    LEFT JOIN locations wl ON wl.id = w.location_id
    LEFT JOIN companies c ON c.id = x.company_id
    WHERE x.id = ?
    `,
    [id],
    (findErr, expense) => {
      if (findErr) {
        return res.status(500).json({ error: findErr.message });
      }

      if (!expense) {
        return res.status(404).json({ error: "Expense not found" });
      }

      if (!canAccessWarehouse(req.user, expense.warehouse_id)) {
        return res.status(403).json({ error: "You cannot approve expenses for this warehouse" });
      }

      db.get(
        "SELECT id FROM cash_entries WHERE source_expense_id = ? LIMIT 1",
        [id],
        (checkErr, existingCashEntry) => {
          if (checkErr) {
            return res.status(500).json({ error: checkErr.message });
          }

          if (existingCashEntry) {
            return res.status(400).json({ error: "This expense is already in Cash Book pending list" });
          }

          db.run(
            "UPDATE expenses SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            ["CONFIRMED_BY_HO", id],
            (statusErr) => {
              if (statusErr) {
                return res.status(500).json({ error: statusErr.message });
              }

              db.run(
                `
                INSERT INTO cash_entries (
                  voucher_no,
                  entry_date,
                  entry_type,
                  warehouse_id,
                  company_id,
                  company_account_id,
                  description,
                  amount,
                  payment_method,
                  reference_no,
                  narration,
                  created_by,
                  status,
                  source_expense_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                  expense.voucher_no || null,
                  expense.expense_date,
                  "expense",
                  expense.warehouse_id || null,
                  expense.company_id || null,
                  expense.company_account_id || null,
                  `Expense ${expense.voucher_no || ""}${expense.work_description ? ` - ${expense.work_description}` : ""}`.trim(),
                  Number(expense.total_expense_amount) || 0,
                  "Cash",
                  expense.voucher_no || null,
                  expense.narration || null,
                  req.user?.id || null,
                  "pending",
                  expense.id,
                ],
                function insertCashEntry(insertErr) {
                  if (insertErr) {
                    db.run(
                      "UPDATE expenses SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                      [expense.status || "PENDING", id],
                      () => {}
                    );
                    return res.status(500).json({ error: insertErr.message });
                  }

                  const cashEntryId = this.lastID;
                  const handleAfterPosting = (inwardInfo, outwardInfo) => {
                    const sendSuccessResponse = (paltiInfo) => {
                      const inwardPosted = !!inwardInfo?.posted || !!inwardInfo?.already_posted;
                      const outwardPosted = !!outwardInfo?.posted || !!outwardInfo?.already_posted;
                      const paltiPosted = !!paltiInfo?.posted || !!paltiInfo?.already_posted;
                      let message = "Expense approved and moved to Cash Book pending list";

                      if (inwardPosted) {
                        message += ", and posted to Inward";
                      }
                      if (outwardPosted) {
                        message += ", and posted to Outward";
                      }
                      if (paltiPosted) {
                        message += ", and posted to Palti Lorry";
                      }

                      return res.json({
                        approved: true,
                        expense_id: expense.id,
                        cash_entry_id: cashEntryId,
                        inward_posted: inwardPosted,
                        inward_id: inwardInfo?.inward_id || null,
                        inward_voucher_no: inwardInfo?.inward_voucher_no || null,
                        outward_posted: outwardPosted,
                        outward_id: outwardInfo?.outward_id || null,
                        outward_voucher_no: outwardInfo?.outward_voucher_no || null,
                        palti_posted: paltiPosted,
                        message,
                      });
                    };

                    if (shouldPostExpenseToPaltiLorry(expense)) {
                      postExpenseToPaltiLorry(expense, req.user?.id, (paltiErr, paltiInfo) => {
                        if (paltiErr) {
                          return res.status(500).json({ error: paltiErr.message });
                        }
                        return sendSuccessResponse(paltiInfo);
                      });
                      return;
                    }

                    return sendSuccessResponse({ posted: false, already_posted: false });
                  };

                  const inwardNeeded = shouldPostExpenseToInward(expense);
                  const outwardNeeded = shouldPostExpenseToOutward(expense);

                  const continueWithOutward = (inwardInfo) => {
                    if (!outwardNeeded) {
                      return handleAfterPosting(inwardInfo, { posted: false, already_posted: false });
                    }

                    postExpenseToOutward(expense, (outwardErr, outwardInfo) => {
                      if (outwardErr) {
                        return res.status(500).json({ error: outwardErr.message });
                      }
                      return handleAfterPosting(inwardInfo, outwardInfo);
                    });
                  };

                  if (!inwardNeeded) {
                    return continueWithOutward({ posted: false, already_posted: false });
                  }

                  postExpenseToInward(expense, (inwardErr, inwardInfo) => {
                    if (inwardErr) {
                      return res.status(500).json({ error: inwardErr.message });
                    }
                    return continueWithOutward(inwardInfo);
                  });
                }
              );
            }
          );
        }
      );
    }
  );
});

router.post("/", (req, res) => {
  if (!userHasPermission(req.user, "expense.create")) {
    return res.status(403).json({ error: "You do not have permission to create expenses" });
  }
  const {
    expense_date,
    location_id,
    employee_id,
    product_id,
    company_id,
    company_account_id,
    reg_from_company_id,
    send_to_company_id,
    reg_from_consignee_id,
    send_to_party_id,
    send_to_kind,
    send_to_ref_id,
    work_description,
    reg_lorry_no,
    loading,
    unloading,
    shortage,
    excess,
    shortage_excess,
    net_weight,
    new_lorry_no,
    new_weight,
    challan_weight,
    mb_no,
    paid_by,
    paid_by_mobile,
    status,
    receive_cash_from_party,
    receive_cash_from_driver,
    grand_total,
    total_expense_amount,
    narration,
    items,
  } = req.body;

  if (!expense_date || !location_id) {
    return res.status(400).json({ error: "Expense date and location are required" });
  }

  const normalizedWorkDescription = normalizeWorkDescription(work_description);
  if (!normalizedWorkDescription) {
    return res.status(400).json({ error: "Work Description is required" });
  }

  const sendKindRaw = (send_to_kind || "").trim() || null;
  let send_to_kind_norm = sendKindRaw;
  let send_to_ref_norm = sendKindRaw === "palti_lorry" ? null : sendKindRaw ? Number(send_to_ref_id) : null;
  if (sendKindRaw) {
    if (!["consignee", "company", "warehouse", "palti_lorry"].includes(sendKindRaw)) {
      return res.status(400).json({ error: "Invalid Send To — pick consignee, company, warehouse, or palti lorry" });
    }
    if (sendKindRaw !== "palti_lorry" && !Number.isFinite(send_to_ref_norm)) {
      return res.status(400).json({ error: "Invalid Send To — pick consignee, company, warehouse, or palti lorry" });
    }
  } else {
    send_to_kind_norm = null;
    send_to_ref_norm = null;
  }

  const send_to_company_ins = sendKindRaw ? null : Number(send_to_company_id) || null;
  const send_to_party_ins = sendKindRaw ? null : Number(send_to_party_id) || null;

  const safeItems = Array.isArray(items)
    ? items.filter((item) => item && item.particular_name)
    : [];

  resolveWarehouseForLocation(req.user, location_id, (warehouseErr, resolvedWarehouseId) => {
    if (warehouseErr) {
      return res.status(400).json({ error: warehouseErr.message });
    }

    const computedBalance = calculateExpenseBalance(
      loading,
      unloading,
      shortage,
      excess
    );

    nextVoucher((voucherErr, voucherNo) => {
    if (voucherErr) {
      return res.status(500).json({ error: voucherErr.message });
    }

    db.run(
      `
      INSERT INTO expenses (
        voucher_no, expense_date, warehouse_id, location_id, employee_id, product_id, company_id,
        company_account_id, reg_from_company_id, send_to_company_id, reg_from_consignee_id, send_to_party_id, send_to_kind, send_to_ref_id, work_description,
        reg_lorry_no, loading, unloading, shortage, excess, shortage_excess, balance, net_weight, new_lorry_no, new_weight,
        challan_weight, mb_no, paid_by, paid_by_mobile, status,
        receive_cash_from_party, receive_cash_from_driver, grand_total, total_expense_amount, narration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        voucherNo,
        expense_date,
        resolvedWarehouseId,
        Number(location_id) || null,
        employee_id || null,
        product_id || null,
        company_id || null,
        company_account_id || null,
        reg_from_company_id || null,
        send_to_company_ins,
        reg_from_consignee_id || null,
        send_to_party_ins,
        send_to_kind_norm,
        send_to_ref_norm,
        normalizedWorkDescription,
        reg_lorry_no || "",
        Number(loading) || 0,
        Number(unloading) || 0,
        Number(shortage) || 0,
        Number(excess) || 0,
        Number(shortage_excess) || 0,
        computedBalance,
        Number(net_weight) || 0,
        new_lorry_no || "",
        Number(new_weight) || 0,
        Number(challan_weight) || 0,
        mb_no || "",
        paid_by || "",
        paid_by_mobile || "",
        status || "PENDING",
        Number(receive_cash_from_party) || 0,
        Number(receive_cash_from_driver) || 0,
        Number(grand_total) || 0,
        Number(total_expense_amount) || 0,
        narration || "",
      ],
      function insertExpense(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        const expenseId = this.lastID;
        const maybeAutoPostSelfLoading = () => {
          if (normalizedWorkDescription !== "Self Loading") {
            return res.json({ id: expenseId, voucher_no: voucherNo });
          }

          db.get("SELECT * FROM expenses WHERE id = ?", [expenseId], (loadErr, expenseRow) => {
            if (loadErr) {
              return res.status(500).json({ error: loadErr.message });
            }
            if (!expenseRow) {
              return res.json({ id: expenseId, voucher_no: voucherNo });
            }

            postExpenseToOutward(expenseRow, (postErr, outwardInfo) => {
              if (postErr) {
                return res.status(500).json({ error: postErr.message });
              }
              return res.json({
                id: expenseId,
                voucher_no: voucherNo,
                self_loading_posted: !!outwardInfo?.posted || !!outwardInfo?.already_posted,
                outward_id: outwardInfo?.outward_id || null,
                outward_voucher_no: outwardInfo?.outward_voucher_no || null,
              });
            });
          });
        };

        if (safeItems.length === 0) {
          return maybeAutoPostSelfLoading();
        }

        const stmt = db.prepare(
          `
          INSERT INTO expense_items (expense_id, line_no, particular_name, bags, rate, amount)
          VALUES (?, ?, ?, ?, ?, ?)
          `
        );

        safeItems.forEach((item, index) => {
          stmt.run([
            expenseId,
            index + 1,
            item.particular_name,
            Number(item.bags) || 0,
            Number(item.rate) || 0,
            Number(item.amount) || 0,
          ]);
        });

        stmt.finalize((finalizeErr) => {
          if (finalizeErr) {
            return res.status(500).json({ error: finalizeErr.message });
          }

          return maybeAutoPostSelfLoading();
        });
      }
    );
    });
  });
});

router.put("/:id", (req, res) => {
  if (!userHasPermission(req.user, "expense.edit")) {
    return res.status(403).json({ error: "You do not have permission to edit expenses" });
  }
  const { id } = req.params;
  const {
    expense_date,
    location_id,
    employee_id,
    product_id,
    company_id,
    company_account_id,
    reg_from_company_id,
    send_to_company_id,
    reg_from_consignee_id,
    send_to_party_id,
    send_to_kind,
    send_to_ref_id,
    work_description,
    reg_lorry_no,
    loading,
    unloading,
    shortage,
    excess,
    shortage_excess,
    net_weight,
    new_lorry_no,
    new_weight,
    challan_weight,
    mb_no,
    paid_by,
    paid_by_mobile,
    status,
    receive_cash_from_party,
    receive_cash_from_driver,
    grand_total,
    total_expense_amount,
    narration,
    items,
  } = req.body;

  const putSendKindRaw = (send_to_kind || "").trim() || null;
  let put_send_to_kind = putSendKindRaw;
  let put_send_to_ref = putSendKindRaw === "palti_lorry" ? null : putSendKindRaw ? Number(send_to_ref_id) : null;
  if (putSendKindRaw) {
    if (!["consignee", "company", "warehouse", "palti_lorry"].includes(putSendKindRaw)) {
      return res.status(400).json({ error: "Invalid Send To — pick consignee, company, warehouse, or palti lorry" });
    }
    if (putSendKindRaw !== "palti_lorry" && !Number.isFinite(put_send_to_ref)) {
      return res.status(400).json({ error: "Invalid Send To — pick consignee, company, warehouse, or palti lorry" });
    }
  } else {
    put_send_to_kind = null;
    put_send_to_ref = null;
  }
  const put_send_to_company = putSendKindRaw ? null : Number(send_to_company_id) || null;
  const put_send_to_party = putSendKindRaw ? null : Number(send_to_party_id) || null;

  const normalizedWorkDescription = normalizeWorkDescription(work_description);
  if (!normalizedWorkDescription) {
    return res.status(400).json({ error: "Work Description is required" });
  }

  db.get("SELECT id, warehouse_id FROM expenses WHERE id = ?", [id], (findErr, row) => {
    if (findErr) {
      return res.status(500).json({ error: findErr.message });
    }

    if (!row) {
      return res.status(404).json({ error: "Expense not found" });
    }

    if (!canAccessWarehouse(req.user, row.warehouse_id)) {
      return res.status(403).json({ error: "You cannot edit expenses for this warehouse" });
    }

    const safeItems = Array.isArray(items)
      ? items.filter((item) => item && item.particular_name)
      : [];

    resolveWarehouseForLocation(req.user, location_id, (warehouseErr, resolvedWarehouseId) => {
      if (warehouseErr) {
        return res.status(400).json({ error: warehouseErr.message });
      }

      const computedBalance = calculateExpenseBalance(
        loading,
        unloading,
        shortage,
        excess
      );

      db.run(
      `
      UPDATE expenses
      SET expense_date = ?, warehouse_id = ?, location_id = ?, employee_id = ?, product_id = ?, company_id = ?,
          company_account_id = ?, reg_from_company_id = ?, send_to_company_id = ?, reg_from_consignee_id = ?, send_to_party_id = ?, send_to_kind = ?, send_to_ref_id = ?, work_description = ?,
          reg_lorry_no = ?, loading = ?, unloading = ?, shortage = ?, excess = ?, shortage_excess = ?, balance = ?, net_weight = ?,
          new_lorry_no = ?, new_weight = ?, challan_weight = ?, mb_no = ?, paid_by = ?, paid_by_mobile = ?, status = ?,
          receive_cash_from_party = ?, receive_cash_from_driver = ?, grand_total = ?, total_expense_amount = ?,
          narration = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `,
      [
        expense_date,
        resolvedWarehouseId,
        Number(location_id) || null,
        employee_id || null,
        product_id || null,
        company_id || null,
        company_account_id || null,
        reg_from_company_id || null,
        put_send_to_company,
        reg_from_consignee_id || null,
        put_send_to_party,
        put_send_to_kind,
        put_send_to_ref,
        normalizedWorkDescription,
        reg_lorry_no || "",
        Number(loading) || 0,
        Number(unloading) || 0,
        Number(shortage) || 0,
        Number(excess) || 0,
        Number(shortage_excess) || 0,
        computedBalance,
        Number(net_weight) || 0,
        new_lorry_no || "",
        Number(new_weight) || 0,
        Number(challan_weight) || 0,
        mb_no || "",
        paid_by || "",
        paid_by_mobile || "",
        status || "PENDING",
        Number(receive_cash_from_party) || 0,
        Number(receive_cash_from_driver) || 0,
        Number(grand_total) || 0,
        Number(total_expense_amount) || 0,
        narration || "",
        id,
      ],
      (updateErr) => {
        if (updateErr) {
          return res.status(500).json({ error: updateErr.message });
        }

        db.run("DELETE FROM expense_items WHERE expense_id = ?", [id], (deleteErr) => {
          if (deleteErr) {
            return res.status(500).json({ error: deleteErr.message });
          }

          if (safeItems.length === 0) {
            return res.json({ updated: true });
          }

        const stmt = db.prepare(
            `
            INSERT INTO expense_items (expense_id, line_no, particular_name, bags, rate, amount)
            VALUES (?, ?, ?, ?, ?, ?)
            `
          );

          safeItems.forEach((item, index) => {
            stmt.run([
              id,
              index + 1,
              item.particular_name,
              Number(item.bags) || 0,
              Number(item.rate) || 0,
              Number(item.amount) || 0,
            ]);
          });

          stmt.finalize((finalizeErr) => {
            if (finalizeErr) {
              return res.status(500).json({ error: finalizeErr.message });
            }

            return res.json({ updated: true });
          });
        });
      }
      );
    });
  });
});

router.delete("/:id", (req, res) => {
  if (!userHasPermission(req.user, "expense.delete")) {
    return res.status(403).json({ error: "You do not have permission to delete expenses" });
  }
  const { id } = req.params;

  db.get("SELECT id, warehouse_id FROM expenses WHERE id = ?", [id], (findErr, row) => {
    if (findErr) {
      return res.status(500).json({ error: findErr.message });
    }

    if (!row) {
      return res.status(404).json({ error: "Expense not found" });
    }

    if (!canAccessWarehouse(req.user, row.warehouse_id)) {
      return res.status(403).json({ error: "You cannot delete expenses for this warehouse" });
    }

    db.run("DELETE FROM expense_items WHERE expense_id = ?", [id], (itemErr) => {
      if (itemErr) {
        return res.status(500).json({ error: itemErr.message });
      }

      db.run("DELETE FROM expenses WHERE id = ?", [id], function deleteExpense(expenseErr) {
        if (expenseErr) {
          return res.status(500).json({ error: expenseErr.message });
        }

        return res.json({ deleted: this.changes > 0 });
      });
    });
  });
});

router.post("/:id/post-palti-lorry", (req, res) => {
  if (!userHasPermission(req.user, "expense.edit")) {
    return res.status(403).json({ error: "You do not have permission to post to Palti Lorry" });
  }

  const { id } = req.params;
  db.get("SELECT * FROM expenses WHERE id = ?", [id], (findErr, expense) => {
    if (findErr) {
      return res.status(500).json({ error: findErr.message });
    }
    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }
    if (!canAccessWarehouse(req.user, expense.warehouse_id)) {
      return res.status(403).json({ error: "You cannot post this warehouse expense" });
    }
    postExpenseToPaltiLorry(expense, req.user?.id, (paltiErr, paltiInfo) => {
      if (paltiErr) {
        return res.status(500).json({ error: paltiErr.message });
      }
      if (paltiInfo?.already_posted) {
        return res.status(400).json({ error: "This expense is already posted to Palti Lorry" });
      }
      return res.json({
        posted: true,
        palti_id: paltiInfo?.palti_id || null,
        message: "Expense posted to Palti Lorry",
      });
    });
  });
});

module.exports = router;






