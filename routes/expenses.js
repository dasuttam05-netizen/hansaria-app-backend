const express = require("express");
const router = express.Router();
const db = require("../db");
const { canAccessWarehouse, assignedWarehouseFilter } = require("../helpers/access");
const { userHasPermission } = require("../middleware/auth");
const {
  Location: MongoLocation,
  Employee: MongoEmployee,
  Product: MongoProduct,
  Company: MongoCompany,
  CompanyAccount: MongoCompanyAccount,
  Warehouse: MongoWarehouse,
} = require("../mongo");

const WORK_DESCRIPTION_OPTIONS = [
  "Palti Lorry",
  "Self Loading",
  "Local Sale",
  "Warehouse Inward",
  "Warehouse Outward",
  "Others",
];

const EXPENSE_PARTICULAR_DEFAULTS = [
  "KANTA",
  "JALPANI",
  "PARKING",
  "PALTI",
  "SAZAI",
  "LOADING",
  "UNLOADING",
  "NEW BAGS",
  "ADVANCE",
  "REFILLING",
  "KAMALI",
  "DALA",
  "SUTULI",
  "EXTRA",
  "VEHICLE FREIGHT",
  "BUSINESS TRAVEL",
  "HOTEL",
  "FOODING",
  "GODOWN RENT",
  "BIKE KM",
];

function buildDefaultExpenseItems() {
  return EXPENSE_PARTICULAR_DEFAULTS.map((name, index) => ({
    id: null,
    line_no: index + 1,
    particular_name: name,
    bags: 0,
    rate: 0,
    amount: 0,
  }));
}

function resolveExpenseParticularName(item, fallbackName = "") {
  const candidates = [item?.particular_name, item?.particulars, item?.name];
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim();
    if (text) return text;
  }

  return String(fallbackName ?? "").trim();
}

function normalizeExpenseItemsForDisplay(items) {
  const existingItems = Array.isArray(items) ? items.filter(Boolean) : [];
  if (existingItems.length === 0) {
    return buildDefaultExpenseItems();
  }

  const unusedItems = [...existingItems];
  const rows = EXPENSE_PARTICULAR_DEFAULTS.map((defaultName, index) => {
    const normalizedDefaultName = defaultName.trim().toLowerCase();
    let matchIndex = unusedItems.findIndex((item) => Number(item.line_no) === index + 1);

    if (matchIndex === -1) {
      matchIndex = unusedItems.findIndex(
        (item) => resolveExpenseParticularName(item).trim().toLowerCase() === normalizedDefaultName
      );
    }

    const matchedItem = matchIndex >= 0 ? unusedItems.splice(matchIndex, 1)[0] : null;

    return {
      id: matchedItem?.id || null,
      line_no: index + 1,
      particular_name: resolveExpenseParticularName(matchedItem, defaultName) || defaultName,
      bags: matchedItem?.bags ?? 0,
      rate: matchedItem?.rate ?? 0,
      amount:
        matchedItem?.amount ??
        Number(
          (
            (Number(matchedItem?.bags) || 0) *
            (Number(matchedItem?.rate) || 0)
          ).toFixed(2)
        ),
    };
  });

  const extraRows = unusedItems.map((item, index) => ({
    id: item?.id || null,
    line_no: Number(item?.line_no) || EXPENSE_PARTICULAR_DEFAULTS.length + index + 1,
    particular_name:
      resolveExpenseParticularName(
        item,
        `Particular ${EXPENSE_PARTICULAR_DEFAULTS.length + index + 1}`
      ) || `Particular ${EXPENSE_PARTICULAR_DEFAULTS.length + index + 1}`,
    bags: item?.bags ?? 0,
    rate: item?.rate ?? 0,
    amount:
      item?.amount ??
      Number(((Number(item?.bags) || 0) * (Number(item?.rate) || 0)).toFixed(2)),
  }));

  return [...rows, ...extraRows];
}

function isEffectivelyEmptyExpenseItem(item) {
  return (
    (Number(item?.bags) || 0) === 0 &&
    (Number(item?.rate) || 0) === 0 &&
    (Number(item?.amount) || 0) === 0
  );
}

function isDefaultEmptyExpenseItemsPayload(items) {
  if (!Array.isArray(items) || items.length === 0) return false;

  return items.every((item, index) => {
    const name = String(item?.particular_name || "").trim().toUpperCase();
    const defaultName = EXPENSE_PARTICULAR_DEFAULTS[index] || "";
    return name === defaultName && isEffectivelyEmptyExpenseItem(item);
  });
}

function hasSavedNonZeroExpenseItems(expenseId, callback) {
  db.get(
    `
    SELECT 1 AS has_items
    FROM expense_items
    WHERE expense_id = ?
      AND (
        COALESCE(bags, 0) <> 0 OR
        COALESCE(rate, 0) <> 0 OR
        COALESCE(amount, 0) <> 0
      )
    LIMIT 1
    `,
    [expenseId],
    (err, row) => {
      if (err) {
        callback(err);
        return;
      }

      callback(null, !!row);
    }
  );
}

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

function isPositiveNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0;
}

function shouldRestrictToOwnEmployee(user) {
  const normalizedRole = String(user?.role || "").trim().toLowerCase();
  const hasGlobalExpenseViewRole = ["admin", "ho", "bm"].includes(normalizedRole);
  return (
    !hasGlobalExpenseViewRole &&
    !userHasPermission(user, "employees.view") &&
    !userHasPermission(user, "cash.create")
  );
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row || null);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

async function findSqliteIdByName(table, name) {
  const cleanedName = String(name || "").trim();
  if (!cleanedName) return null;

  const row = await dbGet(
    `SELECT id FROM ${table} WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) ORDER BY id ASC LIMIT 1`,
    [cleanedName]
  );

  return row?.id || null;
}

async function findSqliteEmployeeIdByUsername(username) {
  const cleanedUsername = String(username || "").trim();
  if (!cleanedUsername) return null;

  const row = await dbGet(
    "SELECT id FROM employees WHERE LOWER(TRIM(username)) = LOWER(TRIM(?)) ORDER BY id ASC LIMIT 1",
    [cleanedUsername]
  );

  return row?.id || null;
}

async function findSqliteAccountId(accountName) {
  const cleanedName = String(accountName || "").trim();
  if (!cleanedName) return null;

  const row = await dbGet(
    `SELECT id FROM company_accounts WHERE LOWER(TRIM(account_name)) = LOWER(TRIM(?)) ORDER BY id ASC LIMIT 1`,
    [cleanedName]
  );

  return row?.id || null;
}

async function createSqliteMasterFromMongo(model, sqliteTable, doc) {
  if (sqliteTable === "locations") {
    const result = await dbRun(
      "INSERT INTO locations (name, address, hsn_code) VALUES (?, ?, ?)",
      [doc.name || "", doc.address || "", doc.hsn_code || ""]
    );
    return result.lastID || null;
  }

  if (sqliteTable === "employees") {
    const locationId = await resolveMongoMasterId(doc.location_id, MongoLocation, "locations");
    const username = String(doc.username || "").trim() || null;
    const employeeName = String(doc.name || "").trim();

    if (username) {
      const existingByUsername = await findSqliteEmployeeIdByUsername(username);
      if (existingByUsername) return existingByUsername;
    }

    if (employeeName) {
      const existingByName = await findSqliteIdByName("employees", employeeName);
      if (existingByName) return existingByName;
    }

    try {
      const result = await dbRun(
        "INSERT OR IGNORE INTO employees (name, address, location_id, username, password, role, permissions) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          employeeName,
          doc.address || "",
          locationId || null,
          username,
          doc.password || null,
          doc.role || "staff",
          JSON.stringify(doc.permissions || []),
        ]
      );

      if ((Number(result?.changes) || 0) > 0 && Number(result?.lastID) > 0) {
        return Number(result.lastID);
      }

      if (username) {
        const existingByUsername = await findSqliteEmployeeIdByUsername(username);
        if (existingByUsername) return existingByUsername;
      }

      if (employeeName) {
        const existingByName = await findSqliteIdByName("employees", employeeName);
        if (existingByName) return existingByName;
      }

      return null;
    } catch (err) {
      if (
        username &&
        String(err?.message || "").includes("UNIQUE constraint failed: employees.username")
      ) {
        const existingByUsername = await findSqliteEmployeeIdByUsername(username);
        if (existingByUsername) return existingByUsername;
      }

      if (employeeName) {
        const existingByName = await findSqliteIdByName("employees", employeeName);
        if (existingByName) return existingByName;
      }
      throw err;
    }
  }

  if (sqliteTable === "products") {
    const result = await dbRun(
      "INSERT INTO products (name, hsn_code) VALUES (?, ?)",
      [doc.name || "", doc.hsn_code || ""]
    );
    return result.lastID || null;
  }

  if (sqliteTable === "companies") {
    const result = await dbRun(
      "INSERT INTO companies (name, address, mobile) VALUES (?, ?, ?)",
      [doc.name || "", doc.address || "", doc.mobile || ""]
    );
    return result.lastID || null;
  }

  if (sqliteTable === "company_accounts") {
    const companyId = await resolveMongoMasterId(doc.company_id, MongoCompany, "companies");
    if (!companyId) return null;
    const result = await dbRun(
      "INSERT INTO company_accounts (account_name, address, company_id, pan_no, mobile) VALUES (?, ?, ?, ?, ?)",
      [doc.account_name || "", doc.address || "", companyId, doc.pan_no || "", doc.mobile || ""]
    );
    return result.lastID || null;
  }

  if (sqliteTable === "warehouses") {
    const locationId = await resolveMongoMasterId(doc.location_id, MongoLocation, "locations");
    const employeeId = await resolveMongoMasterId(doc.employee_id, MongoEmployee, "employees");
    const result = await dbRun(
      "INSERT INTO warehouses (name, address, location_id, employee_id) VALUES (?, ?, ?, ?)",
      [doc.name || "", doc.address || "", locationId || null, employeeId || null]
    );
    return result.lastID || null;
  }

  return null;
}

async function resolveMongoMasterId(value, model, sqliteTable, nameField = "name") {
  if (!value) return null;
  if (isPositiveNumber(value)) return Number(value);

  const doc = await model.findById(value).lean().catch(() => null);
  if (!doc) return null;

  if (sqliteTable === "company_accounts") {
    return (await findSqliteAccountId(doc.account_name)) ||
      createSqliteMasterFromMongo(model, sqliteTable, doc);
  }

  if (sqliteTable === "employees") {
    return (await findSqliteEmployeeIdByUsername(doc.username)) ||
      (await findSqliteIdByName(sqliteTable, doc[nameField])) ||
      createSqliteMasterFromMongo(model, sqliteTable, doc);
  }

  return (await findSqliteIdByName(sqliteTable, doc[nameField])) ||
    createSqliteMasterFromMongo(model, sqliteTable, doc);
}

async function resolveExpenseMasterIds(values) {
  const resolved = {
    location_id: await resolveMongoMasterId(values.location_id, MongoLocation, "locations"),
    employee_id: await resolveMongoMasterId(values.employee_id, MongoEmployee, "employees"),
    product_id: await resolveMongoMasterId(values.product_id, MongoProduct, "products"),
    company_id: await resolveMongoMasterId(values.company_id, MongoCompany, "companies"),
    company_account_id: await resolveMongoMasterId(values.company_account_id, MongoCompanyAccount, "company_accounts"),
    reg_from_company_id: await resolveMongoMasterId(values.reg_from_company_id, MongoCompany, "companies"),
  };

  if (values.send_to_kind === "company") {
    resolved.send_to_ref_id = await resolveMongoMasterId(values.send_to_ref_id, MongoCompany, "companies");
  } else if (values.send_to_kind === "warehouse") {
    resolved.send_to_ref_id = await resolveMongoMasterId(values.send_to_ref_id, MongoWarehouse, "warehouses");
  } else {
    resolved.send_to_ref_id = isPositiveNumber(values.send_to_ref_id)
      ? Number(values.send_to_ref_id)
      : null;
  }

  return resolved;
}

async function resolveAssignedWarehouseIds(user) {
  const assignedIds = [
    ...(user?.assigned_sqlite_warehouse_ids || []),
    ...(user?.assigned_warehouse_ids || []),
  ];
  const resolvedIds = [];

  for (const assignedId of assignedIds) {
    if (isPositiveNumber(assignedId)) {
      resolvedIds.push(Number(assignedId));
      continue;
    }

    const resolvedId = await resolveMongoMasterId(assignedId, MongoWarehouse, "warehouses");
    if (resolvedId) {
      resolvedIds.push(Number(resolvedId));
    }
  }

  return Array.from(new Set(resolvedIds));
}

async function canAccessExpenseWarehouse(user, warehouseId, locationId = null) {
  if (canAccessWarehouse(user, warehouseId)) {
    return true;
  }

  const resolvedWarehouseIds = await resolveAssignedWarehouseIds(user).catch(() => []);
  if (isPositiveNumber(warehouseId) && resolvedWarehouseIds.includes(Number(warehouseId))) {
    return true;
  }

  if (locationId) {
    const accessibleLocationIds = await resolveUserAccessibleLocationIds(user).catch(() => []);
    if (isPositiveNumber(locationId) && accessibleLocationIds.includes(Number(locationId))) {
      return true;
    }
  }

  return false;
}

async function resolveUserAccessibleLocationIds(user) {
  const rawLocationIds = [
    user?.location_id,
    ...(Array.isArray(user?.location_ids) ? user.location_ids : []),
  ].filter(Boolean);

  const resolvedIds = [];
  for (const rawLocationId of rawLocationIds) {
    if (isPositiveNumber(rawLocationId)) {
      resolvedIds.push(Number(rawLocationId));
      continue;
    }

    const resolvedLocationId = await resolveMongoMasterId(
      rawLocationId,
      MongoLocation,
      "locations"
    );
    if (resolvedLocationId) {
      resolvedIds.push(Number(resolvedLocationId));
    }
  }

  return Array.from(new Set(resolvedIds));
}

async function resolveCurrentSqliteEmployeeId(user) {
  const usernameCandidates = [];
  const directUsername = String(user?.username || "").trim();
  if (directUsername) {
    usernameCandidates.push(directUsername);
  }

  const userId = user?.id;
  let mongoUserDoc = null;
  if (userId && !isPositiveNumber(userId)) {
    mongoUserDoc = await MongoEmployee.findById(userId).lean().catch(() => null);
  }

  const mongoUsername = String(mongoUserDoc?.username || "").trim();
  if (
    mongoUsername &&
    !usernameCandidates.some((value) => value.toLowerCase() === mongoUsername.toLowerCase())
  ) {
    usernameCandidates.push(mongoUsername);
  }

  for (const candidateUsername of usernameCandidates) {
    const sqliteEmployeeId = await findSqliteEmployeeIdByUsername(candidateUsername);
    if (sqliteEmployeeId) {
      return Number(sqliteEmployeeId);
    }
  }

  const nameCandidates = [];
  const directName = String(user?.name || "").trim();
  if (directName) {
    nameCandidates.push(directName);
  }

  const mongoName = String(mongoUserDoc?.name || "").trim();
  if (
    mongoName &&
    !nameCandidates.some((value) => value.toLowerCase() === mongoName.toLowerCase())
  ) {
    nameCandidates.push(mongoName);
  }

  for (const candidateName of nameCandidates) {
    const sqliteEmployeeId = await findSqliteIdByName("employees", candidateName);
    if (sqliteEmployeeId) {
      return Number(sqliteEmployeeId);
    }
  }

  if (isPositiveNumber(userId)) {
    return Number(userId);
  }

  return null;
}

function resolveWarehouseForLocation(user, locationId, callback) {
  const normalizedLocationId = Number(locationId);
  if (!Number.isFinite(normalizedLocationId) || normalizedLocationId <= 0) {
    callback(new Error("Location is required"));
    return;
  }

  resolveAssignedWarehouseIds(user)
    .then(async (assignedIds) => {
      const canUseAllWarehouses =
        !user || user.role === "admin" || userHasPermission(user, "warehouses.manage");
      const accessibleLocationIds = canUseAllWarehouses
        ? []
        : await resolveUserAccessibleLocationIds(user);
      const hasExplicitLocationScope = !canUseAllWarehouses && accessibleLocationIds.length > 0;
      const hasLocationAccess = canUseAllWarehouses
        ? true
        : !hasExplicitLocationScope || accessibleLocationIds.includes(normalizedLocationId);
      const applyWarehouseAssignmentFilter = !canUseAllWarehouses && assignedIds.length > 0;

      const params = [normalizedLocationId];
      let sql = `
        SELECT id
        FROM warehouses
        WHERE location_id = ?
      `;

      if (!canUseAllWarehouses && !hasLocationAccess) {
        callback(new Error("You do not have access to this location"));
        return;
      }

      if (applyWarehouseAssignmentFilter) {
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
          if (applyWarehouseAssignmentFilter && assignedIds.length === 1) {
            callback(null, Number(assignedIds[0]));
            return;
          }

          callback(new Error("No warehouse is mapped with the selected location"));
          return;
        }

        callback(null, Number(rows[0].id));
      });
    })
    .catch(callback);
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

  const loadEntries = (currentEmployeeId = null, bypassWarehouseScope = false) => {
    const queryWhereParts = [...whereParts];
    const queryParams = [...params];
    const warehouseClause = bypassWarehouseScope ? "" : warehouseFilter.clause;

    if (status) {
      queryWhereParts.push("LOWER(x.status) = LOWER(?)");
      queryParams.push(status);
    }

    if (currentEmployeeId) {
      queryWhereParts.push("x.employee_id = ?");
      queryParams.push(currentEmployeeId);
    }

    if (!bypassWarehouseScope) {
      queryParams.push(...warehouseFilter.params);
    }
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
      WHERE ${queryWhereParts.join(" AND ")} ${warehouseClause}
      ORDER BY x.id DESC
      `,
      queryParams,
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
                items: normalizeExpenseItemsForDisplay(itemMap.get(entry.id) || []),
              }))
            );
          }
        );
      }
    );
  };

  const shouldScopeToOwnEmployee = shouldRestrictToOwnEmployee(req.user);

  if (!shouldScopeToOwnEmployee) {
    loadEntries();
    return;
  }

  resolveCurrentSqliteEmployeeId(req.user)
    .then((currentEmployeeId) => {
      loadEntries(currentEmployeeId || -1, true);
    })
    .catch((err) => {
      res.status(500).json({ error: err.message });
    });
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
  const runLookup = (currentEmployeeId = null, bypassWarehouseScope = false) => {
    const accessClause = [];
    const accessParams = [];
    const warehouseClause = bypassWarehouseScope ? "" : warehouseFilter.clause;

    if (Number.isFinite(Number(currentEmployeeId)) && Number(currentEmployeeId) > 0) {
      accessClause.push("e.employee_id = ?");
      accessParams.push(Number(currentEmployeeId));
    }

    const params = [
      id,
      ...accessParams,
      ...(bypassWarehouseScope ? [] : warehouseFilter.params),
    ];

    db.get(
      `
      SELECT
        e.*,
        COALESCE(e.location_id, w.location_id) AS effective_location_id,
        COALESCE(l.name, wl.name) AS effective_location_name,
        l.name AS location_name,
        w.name AS warehouse_name,
        w.location_id AS warehouse_location_id,
        wl.name AS warehouse_location_name,
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
      LEFT JOIN locations wl ON wl.id = w.location_id
      LEFT JOIN employees emp ON emp.id = e.employee_id
      LEFT JOIN products pr ON pr.id = e.product_id
      LEFT JOIN companies c ON c.id = e.company_id
      LEFT JOIN company_accounts ca ON ca.id = e.company_account_id
      LEFT JOIN consignee_names cn ON cn.id = e.reg_from_consignee_id
      LEFT JOIN companies rc ON rc.id = e.reg_from_company_id
      LEFT JOIN companies stc ON stc.id = e.send_to_company_id
      WHERE e.id = ?
        ${accessClause.length ? ` AND ${accessClause.join(" AND ")}` : ""}
        ${warehouseClause}
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

          const normalizedItems = normalizeExpenseItemsForDisplay(items);

          return res.json({
            ...row,
            items: normalizedItems,
          });
        });
      }
    );
  };

  if (!shouldRestrictToOwnEmployee(req.user)) {
    runLookup();
    return;
  }

  resolveCurrentSqliteEmployeeId(req.user)
    .then((currentEmployeeId) => {
      runLookup(currentEmployeeId || -1, true);
    })
    .catch((err) => {
      return res.status(500).json({ error: err.message });
    });
});

router.post("/:id/approve-cash-book", (req, res) => {
  const roleName = String(req.user?.role || "").trim().toLowerCase();
  const canApproveAsRole = roleName === "ho" || roleName === "bm";
  if (!userHasPermission(req.user, "expense.edit") || (!userHasPermission(req.user, "cash.create") && !canApproveAsRole)) {
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
    async (findErr, expense) => {
      if (findErr) {
        return res.status(500).json({ error: findErr.message });
      }

      if (!expense) {
        return res.status(404).json({ error: "Expense not found" });
      }

      if (!(await canAccessExpenseWarehouse(req.user, expense.warehouse_id, expense.location_id || expense.warehouse_location_id))) {
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

              let employeeCashEntryId = null;
              let partyCashEntryId = null;
              const cashEntrySql = `
                INSERT INTO cash_entries (
                  voucher_no, entry_date, entry_type, warehouse_id, company_id, company_account_id,
                  description, amount, payment_method, reference_no, narration, created_by,
                  employee_id, fund_source, status, source_expense_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `;
              const baseDescription = `${expense.work_description || ""}, ${expense.lorry_no || ""}`.trim();
              const cashEntryInserts = [];

              if (expense.employee_id) {
                cashEntryInserts.push(
                  new Promise((resolve, reject) => {
                    db.run(
                      cashEntrySql,
                      [
                        expense.voucher_no ? `${expense.voucher_no}-EMP` : null,
                        expense.expense_date,
                        "expense",
                        expense.warehouse_id || null,
                        null,
                        null,
                        baseDescription,
                        Number(expense.total_expense_amount) || 0,
                        "Cash",
                        expense.voucher_no || null,
                        expense.narration || null,
                        req.user?.id || null,
                        expense.employee_id || null,
                        "employee_cash",
                        "pending",
                        expense.id,
                      ],
                      function (err) {
                        if (err) return reject(err);
                        employeeCashEntryId = this.lastID;
                        return resolve();
                      }
                    );
                  })
                );
              }

              if (expense.company_id) {
                cashEntryInserts.push(
                  new Promise((resolve, reject) => {
                    db.run(
                      cashEntrySql,
                      [
                        expense.voucher_no ? `${expense.voucher_no}-PARTY` : null,
                        expense.expense_date,
                        "expense",
                        expense.warehouse_id || null,
                        expense.company_id || null,
                        expense.company_account_id || null,
                        baseDescription,
                        Number(expense.total_expense_amount) || 0,
                        "Cash",
                        expense.voucher_no || null,
                        expense.narration || null,
                        req.user?.id || null,
                        null,
                        "party_cash",
                        "pending",
                        expense.id,
                      ],
                      function (err) {
                        if (err) return reject(err);
                        partyCashEntryId = this.lastID;
                        return resolve();
                      }
                    );
                  })
                );
              }

              if (!cashEntryInserts.length) {
                db.run(
                  "UPDATE expenses SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                  [expense.status || "PENDING", id],
                  () => {}
                );
                return res.status(400).json({ error: "Employee or party is required to move expense to Cash Book" });
              }

              const sendSuccessResponse = (inwardInfo, outwardInfo, paltiInfo) => {
                const inwardPosted = !!inwardInfo?.posted || !!inwardInfo?.already_posted;
                const outwardPosted = !!outwardInfo?.posted || !!outwardInfo?.already_posted;
                const paltiPosted = !!paltiInfo?.posted || !!paltiInfo?.already_posted;
                let message = "Expense approved and moved to Employee/Party Cash Book pending list";

                if (inwardPosted) message += ", and posted to Inward";
                if (outwardPosted) message += ", and posted to Outward";
                if (paltiPosted) message += ", and posted to Palti Lorry";

                return res.json({
                  approved: true,
                  expense_id: expense.id,
                  cash_entry_id: employeeCashEntryId || partyCashEntryId,
                  employee_cash_entry_id: employeeCashEntryId,
                  party_cash_entry_id: partyCashEntryId,
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

              const continueAfterCashEntries = () => {
                const inwardNeeded = shouldPostExpenseToInward(expense);
                const outwardNeeded = shouldPostExpenseToOutward(expense);
                const paltiNeeded = shouldPostExpenseToPaltiLorry(expense);

                const continueWithPalti = (inwardInfo, outwardInfo) => {
                  if (!paltiNeeded) {
                    return sendSuccessResponse(inwardInfo, outwardInfo, { posted: false, already_posted: false });
                  }

                  return postExpenseToPaltiLorry(expense, req.user?.id, (paltiErr, paltiInfo) => {
                    if (paltiErr) return res.status(500).json({ error: paltiErr.message });
                    return sendSuccessResponse(inwardInfo, outwardInfo, paltiInfo);
                  });
                };

                const continueWithOutward = (inwardInfo) => {
                  if (!outwardNeeded) {
                    return continueWithPalti(inwardInfo, { posted: false, already_posted: false });
                  }

                  return postExpenseToOutward(expense, (outwardErr, outwardInfo) => {
                    if (outwardErr) return res.status(500).json({ error: outwardErr.message });
                    return continueWithPalti(inwardInfo, outwardInfo);
                  });
                };

                if (!inwardNeeded) {
                  return continueWithOutward({ posted: false, already_posted: false });
                }

                return postExpenseToInward(expense, (inwardErr, inwardInfo) => {
                  if (inwardErr) return res.status(500).json({ error: inwardErr.message });
                  return continueWithOutward(inwardInfo);
                });
              };

              Promise.all(cashEntryInserts)
                .then(continueAfterCashEntries)
                .catch((insertErr) => {
                  db.run(
                    "UPDATE expenses SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    [expense.status || "PENDING", id],
                    () => {}
                  );
                  return res.status(500).json({ error: insertErr.message });
                });
            }
          );
        }
      );
    }
  );
});

router.post("/", async (req, res) => {
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

  const normalizedWorkDescription = normalizeWorkDescription(work_description);
  if (!normalizedWorkDescription) {
    return res.status(400).json({ error: "Work Description is required" });
  }

  const sendKindRaw = (send_to_kind || "").trim() || null;
  let send_to_kind_norm = sendKindRaw;
  let send_to_ref_norm = null;
  if (sendKindRaw) {
    if (!["consignee", "company", "warehouse", "palti_lorry"].includes(sendKindRaw)) {
      return res.status(400).json({ error: "Invalid Send To — pick consignee, company, warehouse, or palti lorry" });
    }
    if (sendKindRaw === "__unused__") {
      // Reserved branch kept for legacy validation compatibility.
    }
    if (sendKindRaw === "__unused_invalid__") {
      return res.status(400).json({ error: "Invalid Send To — pick consignee, company, warehouse, or palti lorry" });
    }
  } else {
    send_to_kind_norm = null;
    send_to_ref_norm = null;
  }

  let resolvedIds;
  try {
    resolvedIds = await resolveExpenseMasterIds({
      location_id,
      employee_id,
      product_id,
      company_id,
      company_account_id,
      reg_from_company_id,
      send_to_kind: sendKindRaw,
      send_to_ref_id,
    });
  } catch (resolveErr) {
    return res.status(400).json({ error: resolveErr.message });
  }

  if (shouldRestrictToOwnEmployee(req.user) && !resolvedIds.employee_id) {
    resolvedIds.employee_id = await resolveCurrentSqliteEmployeeId(req.user).catch(() => null);
  }

  if (!expense_date || !resolvedIds.location_id) {
    return res.status(400).json({ error: "Expense date and location are required" });
  }

  if (sendKindRaw) {
    send_to_ref_norm = sendKindRaw === "palti_lorry" ? null : resolvedIds.send_to_ref_id;
    if (sendKindRaw !== "palti_lorry" && !Number.isFinite(Number(send_to_ref_norm))) {
      return res.status(400).json({ error: "Invalid Send To - pick consignee, company, warehouse, or palti lorry" });
    }
  }

  const send_to_company_ins = sendKindRaw ? null : Number(send_to_company_id) || null;
  const send_to_party_ins = sendKindRaw ? null : Number(send_to_party_id) || null;

  const safeItems = Array.isArray(items)
    ? items.filter((item) => item && item.particular_name)
    : [];
  const hasAnyNonZeroItemInput = safeItems.some(
    (item) =>
      (Number(item?.bags) || 0) !== 0 ||
      (Number(item?.rate) || 0) !== 0 ||
      (Number(item?.amount) || 0) !== 0
  );
  if (safeItems.length > 0 && !hasAnyNonZeroItemInput && (Number(grand_total) || 0) > 0) {
    return res.status(400).json({
      error: "Expense Particulars are empty. Please enter Bags/Rate details before saving.",
    });
  }

  resolveWarehouseForLocation(req.user, resolvedIds.location_id, (warehouseErr, resolvedWarehouseId) => {
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
        resolvedIds.location_id,
        resolvedIds.employee_id || null,
        resolvedIds.product_id || null,
        resolvedIds.company_id || null,
        resolvedIds.company_account_id || null,
        resolvedIds.reg_from_company_id || null,
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

router.put("/:id", async (req, res) => {
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
  let put_send_to_ref = null;
  if (putSendKindRaw) {
    if (!["consignee", "company", "warehouse", "palti_lorry"].includes(putSendKindRaw)) {
      return res.status(400).json({ error: "Invalid Send To — pick consignee, company, warehouse, or palti lorry" });
    }
    if (putSendKindRaw === "__unused__") {
      // Reserved branch kept for legacy validation compatibility.
    }
    if (putSendKindRaw === "__unused_invalid__") {
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

  let resolvedIds;
  try {
    resolvedIds = await resolveExpenseMasterIds({
      location_id,
      employee_id,
      product_id,
      company_id,
      company_account_id,
      reg_from_company_id,
      send_to_kind: putSendKindRaw,
      send_to_ref_id,
    });
  } catch (resolveErr) {
    return res.status(400).json({ error: resolveErr.message });
  }

  if (!expense_date || !resolvedIds.location_id) {
    return res.status(400).json({ error: "Expense date and location are required" });
  }

  if (putSendKindRaw) {
    put_send_to_ref = putSendKindRaw === "palti_lorry" ? null : resolvedIds.send_to_ref_id;
    if (putSendKindRaw !== "palti_lorry" && !Number.isFinite(Number(put_send_to_ref))) {
      return res.status(400).json({ error: "Invalid Send To - pick consignee, company, warehouse, or palti lorry" });
    }
  }

  db.get("SELECT id, warehouse_id, location_id, employee_id, grand_total, total_expense_amount FROM expenses WHERE id = ?", [id], async (findErr, row) => {
    if (findErr) {
      return res.status(500).json({ error: findErr.message });
    }

    if (!row) {
      return res.status(404).json({ error: "Expense not found" });
    }

    if (!(await canAccessExpenseWarehouse(req.user, row.warehouse_id, row.location_id))) {
      return res.status(403).json({ error: "You cannot edit expenses for this warehouse" });
    }

    if (shouldRestrictToOwnEmployee(req.user) && !resolvedIds.employee_id) {
      resolvedIds.employee_id =
        row.employee_id ||
        (await resolveCurrentSqliteEmployeeId(req.user).catch(() => null));
    }

    const hasItemsPayload = Array.isArray(items);
    let safeItems = hasItemsPayload
      ? items.filter((item) => item && item.particular_name)
      : null;
    let preservedDefaultItems = false;
    let grandTotalForUpdate = Number(grand_total) || 0;
    let totalExpenseAmountForUpdate = Number(total_expense_amount) || 0;
    const hasAnyNonZeroItemInput = Array.isArray(safeItems)
      ? safeItems.some(
          (item) =>
            (Number(item?.bags) || 0) !== 0 ||
            (Number(item?.rate) || 0) !== 0 ||
            (Number(item?.amount) || 0) !== 0
        )
      : false;

    if (
      hasItemsPayload &&
      Array.isArray(safeItems) &&
      safeItems.length > 0 &&
      !hasAnyNonZeroItemInput &&
      !isDefaultEmptyExpenseItemsPayload(safeItems) &&
      (Number(grand_total) || 0) > 0
    ) {
      return res.status(400).json({
        error: "Expense Particulars are empty. Please enter Bags/Rate details before saving.",
      });
    }

    const proceedWithUpdate = () => {
    const updateExpenseWithWarehouse = (resolvedWarehouseId) => {
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
        resolvedIds.location_id,
        resolvedIds.employee_id || null,
        resolvedIds.product_id || null,
        resolvedIds.company_id || null,
        resolvedIds.company_account_id || null,
        resolvedIds.reg_from_company_id || null,
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
        grandTotalForUpdate,
        totalExpenseAmountForUpdate,
        narration || "",
        id,
      ],
      (updateErr) => {
        if (updateErr) {
          return res.status(500).json({ error: updateErr.message });
        }

        if (!hasItemsPayload) {
          return res.json({ updated: true });
        }

        if (!safeItems || safeItems.length === 0) {
          return res.json({
            updated: true,
            ...(preservedDefaultItems ? { items_preserved: true } : {}),
          });
        }

        const replaceExpenseItems = () => {
          db.run("DELETE FROM expense_items WHERE expense_id = ?", [id], (deleteErr) => {
            if (deleteErr) {
              return res.status(500).json({ error: deleteErr.message });
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
        };

        return replaceExpenseItems();
      }
      );
    };

    resolveWarehouseForLocation(req.user, resolvedIds.location_id, (warehouseErr, resolvedWarehouseId) => {
      if (warehouseErr) {
        const isNoWarehouseMappedError = String(warehouseErr.message || "").includes(
          "No warehouse is mapped with the selected location"
        );
        const existingWarehouseId = Number(row.warehouse_id) || null;

        if (
          isNoWarehouseMappedError &&
          existingWarehouseId &&
          canAccessWarehouse(req.user, existingWarehouseId)
        ) {
          return updateExpenseWithWarehouse(existingWarehouseId);
        }

        return res.status(400).json({ error: warehouseErr.message });
      }

      return updateExpenseWithWarehouse(resolvedWarehouseId);
    });
    };

    if (isDefaultEmptyExpenseItemsPayload(safeItems)) {
      return hasSavedNonZeroExpenseItems(id, (itemsErr, hasSavedItems) => {
        if (itemsErr) {
          return res.status(500).json({ error: itemsErr.message });
        }

        if (hasSavedItems) {
          safeItems = null;
          preservedDefaultItems = true;
          grandTotalForUpdate = Number(row.grand_total) || 0;
          totalExpenseAmountForUpdate = Number(row.total_expense_amount) || 0;
        }

        return proceedWithUpdate();
      });
    }

    return proceedWithUpdate();
  });
});

router.delete("/:id", (req, res) => {
  if (!userHasPermission(req.user, "expense.delete")) {
    return res.status(403).json({ error: "You do not have permission to delete expenses" });
  }
  const { id } = req.params;

  db.get("SELECT id, warehouse_id, location_id FROM expenses WHERE id = ?", [id], async (findErr, row) => {
    if (findErr) {
      return res.status(500).json({ error: findErr.message });
    }

    if (!row) {
      return res.status(404).json({ error: "Expense not found" });
    }

    if (!(await canAccessExpenseWarehouse(req.user, row.warehouse_id, row.location_id))) {
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
  db.get("SELECT * FROM expenses WHERE id = ?", [id], async (findErr, expense) => {
    if (findErr) {
      return res.status(500).json({ error: findErr.message });
    }
    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }
    if (!(await canAccessExpenseWarehouse(req.user, expense.warehouse_id, expense.location_id))) {
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
