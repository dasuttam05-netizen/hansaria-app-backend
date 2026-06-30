const router = require("express").Router();
const db = require("../db");
const CashEntry = null;
const isMongoMirrorReady = () => false;
const fs = require("fs");
const path = require("path");
const { userHasPermission } = require("../middleware/auth");
const {
  Location: MongoLocation,
  Employee: MongoEmployee,
  Company: MongoCompany,
  CompanyAccount: MongoCompanyAccount,
  Warehouse: MongoWarehouse,
} = require("../mongo");

const CASH_AUDIT_LOG_FILE = path.join(__dirname, "..", "logs", "cash-entry-audit.log");
const ADJ_DETAIL_MARKER = " | Adj Details -> ";

function isPositiveNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0;
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

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
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

async function resolveCompanyFilterIds(companyId) {
  const rawCompanyId = String(companyId || "").trim();
  if (!rawCompanyId) return [];

  const ids = new Set();
  if (isPositiveNumber(rawCompanyId)) ids.add(String(Number(rawCompanyId)));

  const mongoCompany = await MongoCompany.findById(rawCompanyId).lean().catch(() => null);
  const companyName = String(mongoCompany?.name || "").trim();
  if (companyName) {
    const rows = await new Promise((resolve, reject) => {
      db.all(
        "SELECT id FROM companies WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))",
        [companyName],
        (err, resultRows) => {
          if (err) reject(err);
          else resolve(resultRows || []);
        }
      );
    });
    rows.forEach((row) => {
      if (row?.id != null) ids.add(String(row.id));
    });
  }

  ids.add(rawCompanyId);
  return Array.from(ids);
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

async function createSqliteMasterFromMongo(sqliteTable, doc) {
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
    if (username) {
      const existingByUsername = await dbGet(
        "SELECT id FROM employees WHERE username = ? ORDER BY id ASC LIMIT 1",
        [username]
      );
      if (existingByUsername?.id) return existingByUsername.id;
    }
    const result = await dbRun(
      "INSERT INTO employees (name, mobile, address, location_id, username, password, role, permissions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        doc.name || "",
        doc.mobile || "",
        doc.address || "",
        locationId || null,
        username,
        doc.password || null,
        doc.role || "staff",
        JSON.stringify(doc.permissions || []),
      ]
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

async function resolveMongoMasterId(value, model, sqliteTable) {
  if (!value) return null;
  if (isPositiveNumber(value)) return Number(value);

  const doc = await model.findById(value).lean().catch(() => null);
  if (!doc) return null;

  if (sqliteTable === "company_accounts") {
    return (await findSqliteAccountId(doc.account_name)) ||
      createSqliteMasterFromMongo(sqliteTable, doc);
  }

  return (await findSqliteIdByName(sqliteTable, doc.name)) ||
    createSqliteMasterFromMongo(sqliteTable, doc);
}

async function resolveCashEntryMasterIds(values) {
  const companyId = await resolveMongoMasterId(values.company_id, MongoCompany, "companies");
  const companyAccountId = await resolveMongoMasterId(values.company_account_id, MongoCompanyAccount, "company_accounts");
  const warehouseId = await resolveMongoMasterId(values.warehouse_id, MongoWarehouse, "warehouses");
  const employeeId = await resolveMongoMasterId(values.employee_id, MongoEmployee, "employees");

  return {
    warehouse_id: warehouseId || (isPositiveNumber(values.warehouse_id) ? Number(values.warehouse_id) : null),
    company_id: companyId || (isPositiveNumber(values.company_id) ? Number(values.company_id) : null),
    company_account_id:
      companyAccountId || (isPositiveNumber(values.company_account_id) ? Number(values.company_account_id) : null),
    employee_id: employeeId || (isPositiveNumber(values.employee_id) ? Number(values.employee_id) : null),
  };
}

async function enrichCashRowsWithMongoNames(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const companyIds = Array.from(
    new Set(
      safeRows
        .filter((row) => !row.company_name && row.company_id && !isPositiveNumber(row.company_id))
        .map((row) => String(row.company_id))
    )
  );
  const employeeIds = Array.from(
    new Set(
      safeRows
        .filter((row) => !row.employee_name && row.employee_id && !isPositiveNumber(row.employee_id))
        .map((row) => String(row.employee_id))
    )
  );

  const [mongoCompanies, mongoEmployees] = await Promise.all([
    companyIds.length
      ? MongoCompany.find({ _id: { $in: companyIds } }).lean().catch(() => [])
      : Promise.resolve([]),
    employeeIds.length
      ? MongoEmployee.find({ _id: { $in: employeeIds } }).lean().catch(() => [])
      : Promise.resolve([]),
  ]);

  const companyMap = new Map((mongoCompanies || []).map((row) => [String(row._id), row.name || ""]));
  const employeeMap = new Map((mongoEmployees || []).map((row) => [String(row._id), row.name || ""]));

  return safeRows.map((row) => ({
    ...row,
    company_name: row.company_name || companyMap.get(String(row.company_id)) || row.company_name,
    employee_name: row.employee_name || employeeMap.get(String(row.employee_id)) || row.employee_name,
  }));
}

function dedupePendingExpenseRows(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const grouped = new Map();

  const scoreRow = (row) => {
    const voucher = String(row?.voucher_no || "").toUpperCase();
    const isHelperSplitVoucher =
      voucher.endsWith("-EMP") || voucher.endsWith("-PARTY");
    return (isHelperSplitVoucher ? 0 : 10) + Number(row?.id || 0);
  };

  for (const row of safeRows) {
    const key = row?.source_expense_id
      ? `expense:${row.source_expense_id}`
      : row?.reference_no
      ? `ref:${row.reference_no}`
      : `row:${row.id}`;

    const existing = grouped.get(key);
    if (!existing || scoreRow(row) > scoreRow(existing)) {
      grouped.set(key, row);
    }
  }

  return Array.from(grouped.values()).sort((a, b) => {
    const aDate = String(a?.entry_date || "");
    const bDate = String(b?.entry_date || "");
    if (aDate !== bDate) return aDate < bDate ? 1 : -1;
    return Number(b?.id || 0) - Number(a?.id || 0);
  });
}

function buildMongoCashEntryPayload(entry) {
  return {
    id: Number(entry.id),
    voucher_no: entry.voucher_no || null,
    journal_group_no: entry.journal_group_no || null,
    entry_date: entry.entry_date ? new Date(entry.entry_date) : new Date(),
    entry_type: entry.entry_type || null,
    warehouse_id: entry.warehouse_id || null,
    company_id: entry.company_id || null,
    company_account_id: entry.company_account_id || null,
    description: entry.description || null,
    amount: Number(entry.amount || 0),
    payment_method: entry.payment_method || null,
    reference_no: entry.reference_no || null,
    narration: entry.narration || null,
    created_by: entry.created_by || null,
    employee_id: entry.employee_id || null,
    fund_source: entry.fund_source || "main_cash",
    status: entry.status || "pending",
    source_expense_id: entry.source_expense_id || null,
    linked_entry_id: entry.linked_entry_id || null,
    adjustments: Array.isArray(entry.adjustments) ? entry.adjustments : [],
    created_at: entry.created_at ? new Date(entry.created_at) : new Date(),
    updated_at: entry.updated_at ? new Date(entry.updated_at) : new Date(),
  };
}

function runMongoMirror(operation) {
  if (!isMongoMirrorReady()) {
    return Promise.resolve(null);
  }
  return operation();
}

function upsertCashEntryToMongo(entry) {
  return runMongoMirror(() => {
    const doc = buildMongoCashEntryPayload(entry);
    return CashEntry.updateOne({ id: doc.id }, { $set: doc }, { upsert: true }).exec();
  });
}

function updateMongoCashEntryFields(entryId, fields) {
  return runMongoMirror(() => CashEntry.updateOne({ id: Number(entryId) }, { $set: fields }).exec());
}

function removeCashEntryFromMongo(entryId) {
  return runMongoMirror(() => CashEntry.deleteOne({ id: Number(entryId) }).exec());
}

function mirrorMultipleCashEntryStatus(ids, status) {
  return runMongoMirror(() =>
    CashEntry.updateMany({ id: { $in: ids.map(Number) } }, { $set: { status, updated_at: new Date() } }).exec()
  );
}

function mirrorAllNonCancelledEntriesStatus(status) {
  return runMongoMirror(() =>
    CashEntry.updateMany({ status: { $ne: status } }, { $set: { status, updated_at: new Date() } }).exec()
  );
}

const isAdminUser = (user) => user && (user.role === "admin" || (user.permissions || []).includes("all"));

function writeCashAuditLog({
  req,
  action,
  entry_id = null,
  voucher_no = null,
  details = {},
}) {
  const actor = req?.user || {};
  const safeDetails = JSON.stringify(details || {});
  db.run(
    `
    INSERT INTO cash_entry_audit_logs (
      action, entry_id, voucher_no, actor_user_id, actor_username, actor_name, details
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      String(action || "unknown"),
      entry_id,
      voucher_no,
      actor.id || null,
      actor.username || null,
      actor.name || null,
      safeDetails,
    ],
    () => {}
  );

  try {
    fs.mkdirSync(path.dirname(CASH_AUDIT_LOG_FILE), { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      action: String(action || "unknown"),
      entry_id,
      voucher_no,
      actor_user_id: actor.id || null,
      actor_username: actor.username || null,
      actor_name: actor.name || null,
      details: details || {},
    });
    fs.appendFileSync(CASH_AUDIT_LOG_FILE, `${line}\n`, "utf8");
  } catch (fileError) {
    console.error("cash audit file write error:", fileError.message);
  }
}

function getCashEntryBasicById(entryId, cb) {
  db.get(
    `
    SELECT id, voucher_no, entry_date, entry_type, warehouse_id, company_id, company_account_id,
           description, amount, payment_method, reference_no, narration, employee_id, status, fund_source,
           source_expense_id
    FROM cash_entries
    WHERE id = ?
    `,
    [entryId],
    cb
  );
}

function baseDescriptionText(value) {
  return String(value || "").split(ADJ_DETAIL_MARKER)[0].trim();
}

function buildAdjustmentDetailsText(cleanAdjustments = [], targetById = new Map()) {
  if (!cleanAdjustments.length) return "";
  const parts = cleanAdjustments.map((row) => {
    const target = targetById.get(Number(row.target_entry_id)) || {};
    const prevPending = Number(target.pending_before || 0);
    const adjusted = Number(row.adjusted_amount || 0);
    const remaining = Math.max(0, prevPending - adjusted);
    const voucher = target.voucher_no || `CE-${row.target_entry_id}`;
    return `${voucher} (Prev:${prevPending.toFixed(2)}, Adj:${adjusted.toFixed(2)}, Rem:${remaining.toFixed(2)})`;
  });
  return `${ADJ_DETAIL_MARKER}${parts.join(" | ")}`;
}

async function attachAdjustmentDetails(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const ids = safeRows.map((row) => Number(row?.id)).filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return safeRows;

  const detailsRows = await dbAll(
    `
    SELECT
      cea.source_entry_id,
      COALESCE(t.voucher_no, 'CE-' || t.id) AS target_voucher_no,
      t.entry_type AS target_entry_type,
      t.entry_date AS target_entry_date,
      cea.adjusted_amount
    FROM cash_entry_adjustments cea
    LEFT JOIN cash_entries t ON t.id = cea.target_entry_id
    WHERE cea.source_entry_id IN (${ids.map(() => "?").join(",")})
    ORDER BY cea.source_entry_id ASC, cea.id ASC
    `,
    ids
  );

  const detailMap = new Map();
  for (const row of detailsRows || []) {
    const key = Number(row.source_entry_id);
    const text = `${row.target_voucher_no || "-"} ${String(row.target_entry_type || "").toUpperCase()} ${Number(row.adjusted_amount || 0).toFixed(2)}`;
    if (!detailMap.has(key)) detailMap.set(key, []);
    detailMap.get(key).push(text);
  }

  return safeRows.map((row) => ({
    ...row,
    adjustment_details: (detailMap.get(Number(row.id)) || []).join(" | "),
  }));
}

const getVoucherPrefix = ({ transaction_mode, entry_type }) => {
  const mode = String(transaction_mode || "").toLowerCase();
  if (mode === "journal") return "JV";
  if (mode === "receipt") return "REC";
  if (mode === "payment") return "PAY";
  if (String(entry_type || "").toLowerCase() === "income") return "REC";
  return "PAY";
};

const getNextVoucherNo = (prefix, cb) => {
  db.all(
    "SELECT voucher_no FROM cash_entries WHERE voucher_no LIKE ? ORDER BY id DESC LIMIT 200",
    [`${prefix}%`],
    (err, rows) => {
      if (err) return cb(err);
      const maxNum = (rows || []).reduce((max, row) => {
        const m = String(row.voucher_no || "").match(new RegExp(`^${prefix}(\\d+)$`));
        if (!m) return max;
        const n = Number(m[1]);
        return Number.isFinite(n) ? Math.max(max, n) : max;
      }, 0);
      cb(null, `${prefix}${String(maxNum + 1).padStart(5, "0")}`);
    }
  );
};

// Get all cash entries with optional filters
router.get("/", (req, res) => {
  const { from_date, to_date, warehouse_id, company_id, entry_type, status, include_cancelled } = req.query;
  const canViewCash = userHasPermission(req.user, "cash.view");
  const canViewExpensePending = userHasPermission(req.user, "expense.pending");

  if (!canViewCash && !canViewExpensePending) {
    return res.status(403).json({ error: "You do not have permission to view cash entries" });
  }

  let where = ["1=1"];
  const params = [];
  if (String(include_cancelled || "0") !== "1") {
    where.push("COALESCE(ce.status, 'pending') != 'cancelled'");
  }

  if (from_date) {
    where.push("ce.entry_date >= ?");
    params.push(from_date);
  }
  if (to_date) {
    where.push("ce.entry_date <= ?");
    params.push(to_date);
  }
  if (warehouse_id) {
    where.push("ce.warehouse_id = ?");
    params.push(warehouse_id);
  }
  if (company_id) {
    where.push("ce.company_id = ?");
    params.push(company_id);
  }
  if (entry_type) {
    where.push("ce.entry_type = ?");
    params.push(entry_type);
  }
  if (status) {
    where.push("LOWER(COALESCE(ce.status, 'pending')) = LOWER(?)");
    params.push(status);
  }

  if (!canViewCash && canViewExpensePending) {
    where.push("ce.entry_type = 'expense'");
    where.push("COALESCE(ce.status, 'pending') = 'pending'");
    where.push("ce.source_expense_id IS NOT NULL");
  }

  const sql = `
    SELECT
      ce.id,
      ce.voucher_no,
      ce.entry_date,
      ce.entry_type,
      ce.warehouse_id,
      w.name AS warehouse_name,
      COALESCE(ce.company_id, x.company_id) AS company_id,
      COALESCE(c.name, expCompany.name, ca.account_name, expCa.account_name) AS company_name,
      COALESCE(ce.company_account_id, x.company_account_id) AS company_account_id,
      COALESCE(ca.account_name, expCa.account_name) AS account_name,
      ce.description,
      ce.amount,
      COALESCE(SUM(cea.adjusted_amount), 0) AS adjusted_total,
      (ce.amount - COALESCE(SUM(cea.adjusted_amount), 0)) AS pending_amount,
      ce.payment_method,
      ce.reference_no,
      ce.narration,
      COALESCE(ce.fund_source, 'main_cash') AS fund_source,
      COALESCE(ce.status, 'pending') AS status,
      ce.source_expense_id,
      ce.linked_entry_id,
      ce.created_by,
      e.name AS created_by_name,
      COALESCE(ce.employee_id, x.employee_id) AS employee_id,
      COALESCE(assignedEmp.name, expEmp.name, e.name) AS employee_name,
      ce.created_at,
      ce.updated_at,
      x.id AS source_expense_exists,
      x.voucher_no AS source_expense_voucher_no,
      x.work_description AS source_expense_work_description,
      x.paid_by AS source_expense_paid_by,
      x.total_expense_amount AS source_expense_amount,
      expEmp.name AS source_expense_employee_name
    FROM cash_entries ce
    LEFT JOIN warehouses w ON w.id = ce.warehouse_id
    LEFT JOIN companies c ON c.id = ce.company_id
    LEFT JOIN company_accounts ca ON ca.id = ce.company_account_id
    LEFT JOIN employees e ON e.id = ce.created_by
    LEFT JOIN employees assignedEmp ON assignedEmp.id = ce.employee_id
    LEFT JOIN cash_entry_adjustments cea ON cea.target_entry_id = ce.id
    LEFT JOIN expenses x ON x.id = ce.source_expense_id
    LEFT JOIN employees expEmp ON expEmp.id = x.employee_id
    LEFT JOIN companies expCompany ON expCompany.id = x.company_id
    LEFT JOIN company_accounts expCa ON expCa.id = x.company_account_id
    WHERE ${where.join(" AND ")}
      AND (ce.source_expense_id IS NULL OR x.id IS NOT NULL)
    GROUP BY ce.id
    ORDER BY ce.entry_date DESC, ce.id DESC
  `;

  db.all(sql, params, async (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const enrichedRows = await enrichCashRowsWithMongoNames(rows || []);
    const rowsWithAdjustmentDetails = await attachAdjustmentDetails(enrichedRows);
    const shouldDedupePendingExpense =
      String(status || "").toLowerCase() === "pending" &&
      String(entry_type || "").toLowerCase() === "expense";
    const visibleRows = rowsWithAdjustmentDetails.filter((row) => {
      if (row?.source_expense_id && !row?.source_expense_exists) return false;
      return true;
    });
    res.json(
      shouldDedupePendingExpense
        ? dedupePendingExpenseRows(visibleRows)
        : visibleRows
    );
  });
});

router.get("/activity-logs", (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Only admin can view activity logs" });
  }

  const { action, from_date, to_date, user_id, limit } = req.query;
  const safeLimit = Math.max(10, Math.min(1000, Number(limit) || 200));
  const where = ["1=1"];
  const params = [];

  if (action) {
    where.push("l.action = ?");
    params.push(String(action));
  }
  if (from_date) {
    where.push("DATE(l.created_at) >= DATE(?)");
    params.push(from_date);
  }
  if (to_date) {
    where.push("DATE(l.created_at) <= DATE(?)");
    params.push(to_date);
  }
  if (user_id) {
    where.push("l.actor_user_id = ?");
    params.push(user_id);
  }

  const sql = `
    SELECT
      l.id,
      l.action,
      l.entry_id,
      l.voucher_no,
      l.actor_user_id,
      l.actor_username,
      l.actor_name,
      l.details,
      l.created_at
    FROM cash_entry_audit_logs l
    WHERE ${where.join(" AND ")}
    ORDER BY l.id DESC
    LIMIT ?
  `;

  db.all(sql, [...params, safeLimit], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const parsedRows = (rows || []).map((row) => {
      let parsedDetails = {};
      try {
        parsedDetails = row.details ? JSON.parse(row.details) : {};
      } catch (parseErr) {
        parsedDetails = { raw: row.details };
      }
      return { ...row, details: parsedDetails };
    });
    return res.json(parsedRows);
  });
});

router.get("/opening/main", (req, res) => {
  const canViewMainOpening =
    userHasPermission(req.user, "cash.mainBook.view") ||
    userHasPermission(req.user, "cash.mainBook.create") ||
    userHasPermission(req.user, "cash.mainBook.edit") ||
    userHasPermission(req.user, "cash.mainBook.delete");
  if (!canViewMainOpening) {
    return res.status(403).json({ error: "You do not have permission to view main cash opening balance" });
  }

  db.get(
    `
    SELECT
      main_opening_balance,
      main_opening_type,
      opening_locked,
      opening_locked_by,
      opening_locked_at,
      updated_by,
      updated_at
    FROM cash_book_settings
    WHERE id = 1
    `,
    [],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      return res.json({
        main_opening_balance: Number(row?.main_opening_balance || 0),
        main_opening_type: String(row?.main_opening_type || "dr").toLowerCase() === "cr" ? "cr" : "dr",
        opening_locked: Number(row?.opening_locked || 0) === 1,
        opening_locked_by: row?.opening_locked_by || null,
        opening_locked_at: row?.opening_locked_at || null,
        updated_by: row?.updated_by || null,
        updated_at: row?.updated_at || null,
      });
    }
  );
});

router.put("/opening/main", (req, res) => {
  if (!userHasPermission(req.user, "cash.mainBook.edit")) {
    return res.status(403).json({ error: "You do not have permission to update main cash opening balance" });
  }

  const openingAmount = Math.abs(Number(req.body?.main_opening_balance || 0));
  const openingType = String(req.body?.main_opening_type || "dr").toLowerCase() === "cr" ? "cr" : "dr";
  const expectedUpdatedAt = req.body?.expected_updated_at ? String(req.body.expected_updated_at) : null;

  if (!Number.isFinite(openingAmount)) {
    return res.status(400).json({ error: "Invalid opening balance amount" });
  }

  db.serialize(() => {
    db.run("BEGIN IMMEDIATE TRANSACTION", (beginErr) => {
      if (beginErr) {
        return res.status(500).json({ error: beginErr.message });
      }

      db.get(
        `
        SELECT
          main_opening_balance,
          main_opening_type,
          opening_locked,
          opening_locked_by,
          opening_locked_at,
          updated_at
        FROM cash_book_settings
        WHERE id = 1
        `,
        [],
        (readErr, currentRow) => {
          if (readErr) {
            return db.run("ROLLBACK", () => res.status(500).json({ error: readErr.message }));
          }
          if (!currentRow) {
            return db.run("ROLLBACK", () => res.status(404).json({ error: "Main cash opening settings not found" }));
          }

          if (Number(currentRow.opening_locked || 0) === 1) {
            return db.run("ROLLBACK", () =>
              res.status(423).json({
                error: "Main opening is locked. Unlock opening before editing.",
              })
            );
          }

          const dbUpdatedAt = currentRow.updated_at ? String(currentRow.updated_at) : null;
          if (expectedUpdatedAt && dbUpdatedAt && expectedUpdatedAt !== dbUpdatedAt) {
            return db.run("ROLLBACK", () =>
              res.status(409).json({
                error: "Opening balance was modified by another user. Please refresh and try again.",
                current: {
                  main_opening_balance: Number(currentRow.main_opening_balance || 0),
                  main_opening_type: String(currentRow.main_opening_type || "dr").toLowerCase() === "cr" ? "cr" : "dr",
                  updated_at: currentRow.updated_at || null,
                  opening_locked: Number(currentRow.opening_locked || 0) === 1,
                },
              })
            );
          }

          db.run(
            `
            UPDATE cash_book_settings
            SET
              main_opening_balance = ?,
              main_opening_type = ?,
              updated_by = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
            `,
            [openingAmount, openingType, req.user?.id || null],
            function (updateErr) {
              if (updateErr) {
                return db.run("ROLLBACK", () => res.status(500).json({ error: updateErr.message }));
              }
              if (this.changes === 0) {
                return db.run("ROLLBACK", () => res.status(404).json({ error: "Main cash opening settings not found" }));
              }

              db.get(
                `
                SELECT
                  main_opening_balance,
                  main_opening_type,
                  opening_locked,
                  opening_locked_by,
                  opening_locked_at,
                  updated_by,
                  updated_at
                FROM cash_book_settings
                WHERE id = 1
                `,
                [],
                (afterErr, afterRow) => {
                  if (afterErr) {
                    return db.run("ROLLBACK", () => res.status(500).json({ error: afterErr.message }));
                  }

                  db.run("COMMIT", (commitErr) => {
                    if (commitErr) {
                      return db.run("ROLLBACK", () => res.status(500).json({ error: commitErr.message }));
                    }

                    writeCashAuditLog({
                      req,
                      action: "main_opening_update",
                      details: {
                        main_opening_balance: openingAmount,
                        main_opening_type: openingType,
                      },
                    });

                    return res.json({
                      message: "Main cash opening updated successfully",
                      main_opening_balance: Number(afterRow?.main_opening_balance || 0),
                      main_opening_type: String(afterRow?.main_opening_type || "dr").toLowerCase() === "cr" ? "cr" : "dr",
                      opening_locked: Number(afterRow?.opening_locked || 0) === 1,
                      opening_locked_by: afterRow?.opening_locked_by || null,
                      opening_locked_at: afterRow?.opening_locked_at || null,
                      updated_by: afterRow?.updated_by || null,
                      updated_at: afterRow?.updated_at || null,
                    });
                  });
                }
              );
            }
          );
        }
      );
    });
  });
});

router.patch("/opening/main/lock", (req, res) => {
  if (!userHasPermission(req.user, "cash.mainBook.edit")) {
    return res.status(403).json({ error: "You do not have permission to lock opening settings" });
  }

  const shouldLock = !!req.body?.locked;

  db.run(
    `
    UPDATE cash_book_settings
    SET
      opening_locked = ?,
      opening_locked_by = ?,
      opening_locked_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
      updated_by = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
    `,
    [shouldLock ? 1 : 0, req.user?.id || null, shouldLock ? 1 : 0, req.user?.id || null],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: "Main cash opening settings not found" });

      db.get(
        `
        SELECT
          main_opening_balance,
          main_opening_type,
          opening_locked,
          opening_locked_by,
          opening_locked_at,
          updated_by,
          updated_at
        FROM cash_book_settings
        WHERE id = 1
        `,
        [],
        (readErr, row) => {
          if (readErr) return res.status(500).json({ error: readErr.message });

          writeCashAuditLog({
            req,
            action: shouldLock ? "main_opening_lock" : "main_opening_unlock",
            details: {
              opening_locked: shouldLock,
            },
          });

          return res.json({
            main_opening_balance: Number(row?.main_opening_balance || 0),
            main_opening_type: String(row?.main_opening_type || "dr").toLowerCase() === "cr" ? "cr" : "dr",
            opening_locked: Number(row?.opening_locked || 0) === 1,
            opening_locked_by: row?.opening_locked_by || null,
            opening_locked_at: row?.opening_locked_at || null,
            updated_by: row?.updated_by || null,
            updated_at: row?.updated_at || null,
          });
        }
      );
    }
  );
});

// Get cash entry by ID
router.get("/:id(\\d+)", (req, res) => {
  const sql = `
    SELECT
      ce.id,
      ce.voucher_no,
      ce.entry_date,
      ce.entry_type,
      ce.warehouse_id,
      w.name AS warehouse_name,
      COALESCE(ce.company_id, x.company_id) AS company_id,
      COALESCE(c.name, expCompany.name, ca.account_name, expCa.account_name) AS company_name,
      COALESCE(ce.company_account_id, x.company_account_id) AS company_account_id,
      COALESCE(ca.account_name, expCa.account_name) AS account_name,
      ce.description,
      ce.amount,
      COALESCE(SUM(cea.adjusted_amount), 0) AS adjusted_total,
      (ce.amount - COALESCE(SUM(cea.adjusted_amount), 0)) AS pending_amount,
      ce.payment_method,
      ce.reference_no,
      ce.narration,
      COALESCE(ce.fund_source, 'main_cash') AS fund_source,
      COALESCE(ce.status, 'pending') AS status,
      ce.source_expense_id,
      ce.linked_entry_id,
      ce.created_by,
      e.name AS created_by_name,
      COALESCE(ce.employee_id, x.employee_id) AS employee_id,
      COALESCE(assignedEmp.name, expEmp.name, e.name) AS employee_name,
      ce.created_at,
      ce.updated_at,
      x.voucher_no AS source_expense_voucher_no,
      x.work_description AS source_expense_work_description,
      x.paid_by AS source_expense_paid_by,
      x.total_expense_amount AS source_expense_amount,
      expEmp.name AS source_expense_employee_name
    FROM cash_entries ce
    LEFT JOIN warehouses w ON w.id = ce.warehouse_id
    LEFT JOIN companies c ON c.id = ce.company_id
    LEFT JOIN company_accounts ca ON ca.id = ce.company_account_id
    LEFT JOIN employees e ON e.id = ce.created_by
    LEFT JOIN employees assignedEmp ON assignedEmp.id = ce.employee_id
    LEFT JOIN cash_entry_adjustments cea ON cea.target_entry_id = ce.id
    LEFT JOIN expenses x ON x.id = ce.source_expense_id
    LEFT JOIN employees expEmp ON expEmp.id = x.employee_id
    LEFT JOIN companies expCompany ON expCompany.id = x.company_id
    LEFT JOIN company_accounts expCa ON expCa.id = x.company_account_id
    WHERE ce.id = ?
    GROUP BY ce.id
  `;

  db.get(sql, [req.params.id], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Entry not found" });
    const [enrichedRow] = await enrichCashRowsWithMongoNames([row]);

    db.all(
      `
      SELECT
        cea.target_entry_id,
        cea.adjusted_amount,
        t.voucher_no AS target_voucher_no,
        t.entry_date AS target_entry_date,
        t.entry_type AS target_entry_type,
        t.description AS target_description
      FROM cash_entry_adjustments cea
      LEFT JOIN cash_entries t ON t.id = cea.target_entry_id
      WHERE cea.source_entry_id = ?
      ORDER BY cea.id ASC
      `,
      [req.params.id],
      (adjErr, adjustmentRows) => {
        if (adjErr) return res.status(500).json({ error: adjErr.message });
        const adjustmentDetails = (Array.isArray(adjustmentRows) ? adjustmentRows : [])
          .map((item) => `${item.target_voucher_no || `CE-${item.target_entry_id}`} ${String(item.target_entry_type || "").toUpperCase()} ${Number(item.adjusted_amount || 0).toFixed(2)}`)
          .join(" | ");
        return res.json({
          ...enrichedRow,
          adjustment_details: adjustmentDetails,
          adjustments: Array.isArray(adjustmentRows) ? adjustmentRows : [],
        });
      }
    );
  });
});

// Create cash entry
router.post("/", async (req, res) => {
  if (!userHasPermission(req.user, "cash.create")) {
    return res.status(403).json({ error: "You do not have permission to create cash entries" });
  }

  const {
    voucher_no,
    transaction_mode,
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
    employee_id,
    status,
    fund_source,
    source_expense_id,
    adjustments,
    auto_staff_entry,
  } = req.body;

  if (!entry_date || !entry_type || !description || !amount) {
    return res.status(400).json({ error: "Required fields missing" });
  }

  const normalizedMode = String(transaction_mode || "").toLowerCase();
  const effectiveEntryType =
    normalizedMode === "payment"
      ? "expense"
      : normalizedMode === "receipt"
      ? "income"
      : entry_type;

  let resolvedIds;
  try {
    resolvedIds = await resolveCashEntryMasterIds({
      warehouse_id,
      company_id,
      company_account_id,
      employee_id,
    });
  } catch (resolveErr) {
    return res.status(400).json({ error: resolveErr.message });
  }

  const normalizedFundSource = (() => {
    const source = String(fund_source || "main_cash").toLowerCase();
    if (resolvedIds?.company_id && !resolvedIds?.employee_id) {
      return "party_cash";
    }
    if (resolvedIds?.employee_id && !resolvedIds?.company_id) {
      return "employee_cash";
    }
    if (source === "party_cash" || source === "employee_cash" || source === "main_cash") {
      return source;
    }
    return "main_cash";
  })();

  const insertEntry = (finalVoucherNo, linkedEntryId = null) => {
    const sql = `
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
        employee_id,
        fund_source,
        status,
        source_expense_id,
        linked_entry_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(
      sql,
      [
        finalVoucherNo,
        entry_date,
        effectiveEntryType,
        resolvedIds.warehouse_id || null,
        resolvedIds.company_id || null,
        resolvedIds.company_account_id || null,
        baseDescriptionText(description),
        amount,
        payment_method || "Cash",
        reference_no || null,
        narration || null,
        req.user?.id || created_by || null,
        resolvedIds.employee_id || null,
        normalizedFundSource,
        status || "pending",
        source_expense_id || null,
        linkedEntryId || null,
      ],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        const newEntryId = this.lastID;
        const cleanAdjustments = Array.isArray(adjustments)
          ? adjustments
              .map((item) => ({
                target_entry_id: Number(item?.target_entry_id),
                adjusted_amount: Number(item?.adjusted_amount),
              }))
              .filter(
                (item) =>
                  Number.isFinite(item.target_entry_id) &&
                  item.target_entry_id > 0 &&
                  Number.isFinite(item.adjusted_amount) &&
                  item.adjusted_amount > 0
              )
          : [];

        const totalAdjusted = cleanAdjustments.reduce(
          (sum, item) => sum + item.adjusted_amount,
          0
        );

        if (cleanAdjustments.length === 0) {
          // Check if we need to create a companion staff entry
          const normalizedEntryType = String(effectiveEntryType || "").toLowerCase();
          const shouldCreateStaffEntry =
            auto_staff_entry === true ||
            auto_staff_entry === "true" ||
            auto_staff_entry === 1 ||
            auto_staff_entry === "1";
          const isMainCash = normalizedFundSource === "main_cash";
          const isReceiptFromEmployee =
            shouldCreateStaffEntry &&
            resolvedIds.employee_id &&
            normalizedMode === "receipt" &&
            (normalizedEntryType === "income" || normalizedEntryType === "receipt") &&
            isMainCash;
          const isPaymentToEmployee =
            shouldCreateStaffEntry &&
            resolvedIds.employee_id &&
            normalizedMode === "payment" &&
            normalizedEntryType === "expense" &&
            isMainCash;

          if (isReceiptFromEmployee || isPaymentToEmployee) {
            const staffEntryType = isPaymentToEmployee ? "income" : "expense";
            const staffPrefix = staffEntryType === "income" ? "REC" : "PAY";
            getNextVoucherNo(staffPrefix, (voucherErr, staffVoucherNo) => {
              if (voucherErr) {
                return res.status(500).json({ error: `Main entry created but staff entry failed: ${voucherErr.message}` });
              }

              db.run(
                `INSERT INTO cash_entries (
                  voucher_no, entry_date, entry_type, warehouse_id, company_id, 
                  company_account_id, description, amount, payment_method, reference_no, 
                  narration, created_by, employee_id, fund_source, 
                  status, source_expense_id, linked_entry_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  staffVoucherNo,
                  entry_date,
                  staffEntryType,
                  resolvedIds.warehouse_id || null,
                  null,
                  null,
                  baseDescriptionText(description),
                  amount,
                  payment_method || "Cash",
                  reference_no || null,
                  narration || null,
                  req.user?.id || created_by || null,
                  resolvedIds.employee_id || null,
                        "employee_cash",
                  status || "pending",
                  null,
                  newEntryId,
                ],
                function (staffErr) {
                  if (staffErr) {
                    return res.status(500).json({ error: `Main entry created but staff entry failed: ${staffErr.message}` });
                  }

                  const staffEntryId = this.lastID;

                  // Link back the main entry to the staff entry
                  db.run(
                    "UPDATE cash_entries SET linked_entry_id = ? WHERE id = ?",
                    [staffEntryId, newEntryId],
                    (linkErr) => {
                      if (linkErr) {
                        return res.status(500).json({ error: `Linking failed: ${linkErr.message}` });
                      }

                      writeCashAuditLog({
                        req,
                        action: "create_with_staff_entry",
                        entry_id: newEntryId,
                        voucher_no: finalVoucherNo,
                        details: {
                          main_entry: newEntryId,
                          staff_entry: staffEntryId,
                          entry_type: effectiveEntryType,
                          amount: Number(amount || 0),
                          status: status || "pending",
                          employee_id: resolvedIds.employee_id || null,
                          staff_entry_type: staffEntryType,
                        },
                      });

upsertCashEntryToMongo({
                        id: newEntryId,
                        voucher_no: finalVoucherNo,
                        entry_date,
                        entry_type: effectiveEntryType,
                        warehouse_id: warehouse_id || null,
                        company_id: company_id || null,
                        company_account_id: company_account_id || null,
                        description: baseDescriptionText(description),
                        amount,
                        payment_method: payment_method || "Cash",
                        reference_no: reference_no || null,
                        narration: narration || null,
                        created_by: req.user?.id || created_by || null,
                        employee_id: resolvedIds.employee_id || null,
                        journal_group_no: journal_group_no || null,
                        fund_source: String(fund_source || "main_cash"),
                        status: status || "pending",
                        source_expense_id: source_expense_id || null,
                        linked_entry_id: staffEntryId,
                        adjustments: [],
                        created_at: new Date(),
                        updated_at: new Date(),
                      }).catch((err) => {
                        console.error("Mongo mirror error:", err.message);
                      });

                      upsertCashEntryToMongo({
                        id: staffEntryId,
                        voucher_no: staffVoucherNo,
                        entry_date,
                        entry_type: staffEntryType,
                        warehouse_id: resolvedIds.warehouse_id || null,
                        company_id: null,
                        company_account_id: null,
                        description: baseDescriptionText(description),
                        amount,
                        payment_method: payment_method || "Cash",
                        reference_no: reference_no || null,
                        narration: narration || null,
                        created_by: req.user?.id || created_by || null,
                        employee_id: resolvedIds.employee_id || null,
                        journal_group_no: journal_group_no || null,
                        fund_source: "employee_cash",
                        status: status || "pending",
                        source_expense_id: null,
                        linked_entry_id: newEntryId,
                        adjustments: [],
                        created_at: new Date(),
                        updated_at: new Date(),
                      }).catch((err) => {
                        console.error("Mongo mirror error:", err.message);
                      });

                      return res.json({
                        id: newEntryId,
                        linked_entry_id: staffEntryId,
                        message: "Cash entry and staff entry created successfully",
                      });
                    }
                  );
                }
              );
            });
            return;
          }

          writeCashAuditLog({
            req,
            action: "create",
            entry_id: newEntryId,
            voucher_no: finalVoucherNo,
            details: {
              entry_type,
              saved_entry_type: effectiveEntryType,
              amount: Number(amount || 0),
              status: status || "pending",
              has_adjustments: false,
            },
          });

          upsertCashEntryToMongo({
            id: newEntryId,
            voucher_no: finalVoucherNo,
            entry_date,
            entry_type: effectiveEntryType,
            warehouse_id: resolvedIds.warehouse_id || null,
            company_id: resolvedIds.company_id || null,
            company_account_id: resolvedIds.company_account_id || null,
            description: baseDescriptionText(description),
            amount,
            payment_method: payment_method || "Cash",
            reference_no: reference_no || null,
            narration: narration || null,
            created_by: req.user?.id || created_by || null,
            employee_id: resolvedIds.employee_id || null,
            journal_group_no: journal_group_no || null,
            fund_source: normalizedFundSource,
            status: status || "pending",
            source_expense_id: source_expense_id || null,
            linked_entry_id: linkedEntryId || null,
            adjustments: [],
            created_at: new Date(),
            updated_at: new Date(),
          }).catch((err) => {
            console.error("Mongo mirror error:", err.message);
          });

          return res.json({ id: newEntryId, message: "Cash entry created successfully" });
        }

        if (totalAdjusted > Number(amount)) {
          db.run("DELETE FROM cash_entries WHERE id = ?", [newEntryId], () => {
            return res.status(400).json({ error: "Adjusted total cannot exceed entry amount" });
          });
          return;
        }

        db.all(
          `
          SELECT
            ce.id,
            ce.voucher_no,
            ce.company_id,
            ce.entry_type,
            ce.amount,
            COALESCE(SUM(cea.adjusted_amount), 0) AS adjusted_total,
            (ce.amount - COALESCE(SUM(cea.adjusted_amount), 0)) AS pending_before
          FROM cash_entries ce
          LEFT JOIN cash_entry_adjustments cea ON cea.target_entry_id = ce.id
          WHERE ce.id IN (${cleanAdjustments.map(() => "?").join(",")})
          GROUP BY ce.id
          `,
          cleanAdjustments.map((item) => item.target_entry_id),
          (targetErr, targets) => {
            if (targetErr) {
              db.run("DELETE FROM cash_entries WHERE id = ?", [newEntryId], () => {
                return res.status(500).json({ error: targetErr.message });
              });
              return;
            }

            const targetById = new Map((targets || []).map((t) => [Number(t.id), t]));
            for (const row of cleanAdjustments) {
              const target = targetById.get(Number(row.target_entry_id));
              if (!target) {
                db.run("DELETE FROM cash_entries WHERE id = ?", [newEntryId], () => {
                  return res.status(400).json({ error: "Invalid adjustment target" });
                });
                return;
              }

              if (String(target.company_id || "") !== String(resolvedIds.company_id || "")) {
                db.run("DELETE FROM cash_entries WHERE id = ?", [newEntryId], () => {
                  return res.status(400).json({ error: "Adjustment target company mismatch" });
                });
                return;
              }

              if (String(target.entry_type) === String(effectiveEntryType)) {
                db.run("DELETE FROM cash_entries WHERE id = ?", [newEntryId], () => {
                  return res.status(400).json({ error: "Adjustment requires opposite entry type" });
                });
                return;
              }

              const pending = Number(target.amount) - Number(target.adjusted_total || 0);
              if (row.adjusted_amount - pending > 0.0001) {
                db.run("DELETE FROM cash_entries WHERE id = ?", [newEntryId], () => {
                  return res.status(400).json({ error: "Adjusted amount exceeds pending amount" });
                });
                return;
              }
            }

            const insertSql =
              "INSERT INTO cash_entry_adjustments (source_entry_id, target_entry_id, adjusted_amount) VALUES (?, ?, ?)";
            let index = 0;
            const runNext = () => {
              if (index >= cleanAdjustments.length) {
                const adjDetails = buildAdjustmentDetailsText(cleanAdjustments, targetById);
                writeCashAuditLog({
                  req,
                  action: "create",
                  entry_id: newEntryId,
                  voucher_no: finalVoucherNo,
                  details: {
                    entry_type,
                    amount: Number(amount || 0),
                    status: status || "pending",
                    has_adjustments: true,
                    adjustments: cleanAdjustments,
                    adjustment_details: adjDetails,
                  },
                });
                return res.json({
                  id: newEntryId,
                  message: "Cash entry created successfully",
                });
              }

              const item = cleanAdjustments[index++];
              db.run(
                insertSql,
                [newEntryId, item.target_entry_id, item.adjusted_amount],
                (insertAdjErr) => {
                  if (insertAdjErr) {
                    db.run("DELETE FROM cash_entry_adjustments WHERE source_entry_id = ?", [newEntryId], () => {
                      db.run("DELETE FROM cash_entries WHERE id = ?", [newEntryId], () => {
                        return res.status(500).json({ error: insertAdjErr.message });
                      });
                    });
                    return;
                  }
                  runNext();
                }
              );
            };
            runNext();
          }
        );
      }
    );
  };

  const runInsertFlow = () => {
    if (voucher_no) return insertEntry(voucher_no);
    const prefix = getVoucherPrefix({ transaction_mode, entry_type: effectiveEntryType });
    getNextVoucherNo(prefix, (voucherErr, generatedVoucherNo) => {
      if (voucherErr) return res.status(500).json({ error: voucherErr.message });
      insertEntry(generatedVoucherNo);
    });
  };

  if (source_expense_id) {
    db.get(
      "SELECT id FROM cash_entries WHERE source_expense_id = ? LIMIT 1",
      [source_expense_id],
      (checkErr, existing) => {
        if (checkErr) return res.status(500).json({ error: checkErr.message });
        if (existing) {
          return res.status(400).json({ error: "This expense is already in Cash Book pending list" });
        }
        runInsertFlow();
      }
    );
    return;
  }

  runInsertFlow();
});

// Update cash entry
router.put("/:id(\\d+)", async (req, res) => {
  if (!userHasPermission(req.user, "cash.edit")) {
    return res.status(403).json({ error: "You do not have permission to edit cash entries" });
  }

  const {
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
    employee_id,
    status,
    fund_source,
    adjustments,
  } = req.body;

  let resolvedIds;
  try {
    resolvedIds = await resolveCashEntryMasterIds({
      warehouse_id,
      company_id,
      company_account_id,
      employee_id,
    });
  } catch (resolveErr) {
    return res.status(400).json({ error: resolveErr.message });
  }

  const sql = `
    UPDATE cash_entries
    SET
      entry_date = ?,
      entry_type = ?,
      warehouse_id = ?,
      company_id = ?,
      company_account_id = ?,
      description = ?,
      amount = ?,
      payment_method = ?,
      reference_no = ?,
      narration = ?,
      employee_id = ?,
      fund_source = ?,
      status = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;

  const sourceEntryId = Number(req.params.id);
  getCashEntryBasicById(sourceEntryId, (oldErr, oldRow) => {
    if (oldErr) return res.status(500).json({ error: oldErr.message });
    if (!oldRow) return res.status(404).json({ error: "Entry not found" });

    db.run(
      sql,
      [
        entry_date,
        entry_type,
        resolvedIds.warehouse_id || null,
        resolvedIds.company_id || null,
        resolvedIds.company_account_id || null,
        baseDescriptionText(description),
        amount,
        payment_method || "Cash",
        reference_no || null,
        narration || null,
        resolvedIds.employee_id || null,
        String(fund_source || "main_cash"),
        status || "pending",
        req.params.id,
      ],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: "Entry not found" });

        const cleanAdjustments = Array.isArray(adjustments)
          ? adjustments
              .map((item) => ({
                target_entry_id: Number(item?.target_entry_id),
                adjusted_amount: Number(item?.adjusted_amount),
              }))
              .filter(
                (item) =>
                  Number.isFinite(item.target_entry_id) &&
                  item.target_entry_id > 0 &&
                  item.target_entry_id !== sourceEntryId &&
                  Number.isFinite(item.adjusted_amount) &&
                  item.adjusted_amount > 0
              )
          : [];

        const totalAdjusted = cleanAdjustments.reduce((sum, item) => sum + item.adjusted_amount, 0);
        if (totalAdjusted > Number(amount)) {
          return res.status(400).json({ error: "Adjusted total cannot exceed entry amount" });
        }

        db.run(
          "DELETE FROM cash_entry_adjustments WHERE source_entry_id = ?",
          [sourceEntryId],
          (deleteErr) => {
            if (deleteErr) return res.status(500).json({ error: deleteErr.message });

            if (cleanAdjustments.length === 0) {
              writeCashAuditLog({
                req,
                action: "edit",
                entry_id: sourceEntryId,
                voucher_no: oldRow.voucher_no || null,
                details: {
                  before: oldRow,
                  after: {
                    entry_date,
                    entry_type,
                    warehouse_id: warehouse_id || null,
                    company_id: company_id || null,
                    company_account_id: company_account_id || null,
                    description,
                    amount: Number(amount || 0),
                    payment_method: payment_method || "Cash",
                    reference_no: reference_no || null,
                    narration: narration || null,
                    employee_id: employee_id || null,
                    fund_source: String(fund_source || "main_cash"),
                    status: status || "pending",
                    adjustments: [],
                  },
                },
              });

              upsertCashEntryToMongo({
                id: sourceEntryId,
                voucher_no: oldRow.voucher_no || null,
                entry_date,
                entry_type,
                warehouse_id: warehouse_id || null,
                company_id: company_id || null,
                company_account_id: company_account_id || null,
                description: baseDescriptionText(description),
                amount,
                payment_method: payment_method || "Cash",
                reference_no: reference_no || null,
                narration: narration || null,
                created_by: oldRow.created_by || null,
                employee_id: employee_id || null,
                journal_group_no: journal_group_no === undefined ? oldRow.journal_group_no || null : journal_group_no || null,
                fund_source: String(fund_source || "main_cash"),
                status: status || "pending",
                source_expense_id: oldRow.source_expense_id || null,
                linked_entry_id: oldRow.linked_entry_id || null,
                adjustments: [],
                created_at: oldRow.created_at || new Date(),
                updated_at: new Date(),
              }).catch((err) => {
                console.error("Mongo mirror error:", err.message);
              });

              return res.json({ message: "Cash entry updated successfully" });
            }

            db.all(
              `
              SELECT
                ce.id,
                ce.voucher_no,
                ce.company_id,
                ce.entry_type,
                ce.amount,
                COALESCE(SUM(cea.adjusted_amount), 0) AS adjusted_total,
                (ce.amount - COALESCE(SUM(cea.adjusted_amount), 0)) AS pending_before
              FROM cash_entries ce
              LEFT JOIN cash_entry_adjustments cea ON cea.target_entry_id = ce.id
              WHERE ce.id IN (${cleanAdjustments.map(() => "?").join(",")})
              GROUP BY ce.id
              `,
              cleanAdjustments.map((item) => item.target_entry_id),
              (targetErr, targets) => {
                if (targetErr) return res.status(500).json({ error: targetErr.message });

                const targetById = new Map((targets || []).map((t) => [Number(t.id), t]));
                for (const row of cleanAdjustments) {
                  const target = targetById.get(Number(row.target_entry_id));
                  if (!target) {
                    return res.status(400).json({ error: "Invalid adjustment target" });
                  }

                  if (String(target.company_id || "") !== String(company_id || "")) {
                    return res.status(400).json({ error: "Adjustment target company mismatch" });
                  }

                  if (String(target.entry_type) === String(entry_type)) {
                    return res.status(400).json({ error: "Adjustment requires opposite entry type" });
                  }

                  const pending = Number(target.amount) - Number(target.adjusted_total || 0);
                  if (row.adjusted_amount - pending > 0.0001) {
                    return res.status(400).json({ error: "Adjusted amount exceeds pending amount" });
                  }
                }

                const insertSql =
                  "INSERT INTO cash_entry_adjustments (source_entry_id, target_entry_id, adjusted_amount) VALUES (?, ?, ?)";
                let index = 0;
                const runNext = () => {
                  if (index >= cleanAdjustments.length) {
                    const adjDetails = buildAdjustmentDetailsText(cleanAdjustments, targetById);
                    writeCashAuditLog({
                      req,
                      action: "edit",
                      entry_id: sourceEntryId,
                      voucher_no: oldRow.voucher_no || null,
                      details: {
                        before: oldRow,
                        after: {
                          entry_date,
                          entry_type,
                          warehouse_id: warehouse_id || null,
                          company_id: company_id || null,
                          company_account_id: company_account_id || null,
                          description: baseDescriptionText(description),
                          amount: Number(amount || 0),
                          payment_method: payment_method || "Cash",
                          reference_no: reference_no || null,
                          narration: narration || null,
                          employee_id: employee_id || null,
                          journal_group_no: journal_group_no || null,
                          fund_source: String(fund_source || "main_cash"),
                          status: status || "pending",
                          adjustments: cleanAdjustments,
                          adjustment_details: adjDetails,
                        },
                      },
                    });

                    upsertCashEntryToMongo({
                      id: sourceEntryId,
                      voucher_no: oldRow.voucher_no || null,
                      entry_date,
                      entry_type,
                      warehouse_id: warehouse_id || null,
                      company_id: company_id || null,
                      company_account_id: company_account_id || null,
                      description: baseDescriptionText(description),
                      amount,
                      payment_method: payment_method || "Cash",
                      reference_no: reference_no || null,
                      narration: narration || null,
                      created_by: oldRow.created_by || null,
                      employee_id: employee_id || null,
                      journal_group_no: journal_group_no || null,
                      fund_source: String(fund_source || "main_cash"),
                      status: status || "pending",
                      source_expense_id: oldRow.source_expense_id || null,
                      linked_entry_id: oldRow.linked_entry_id || null,
                      adjustments: cleanAdjustments,
                      created_at: oldRow.created_at || new Date(),
                      updated_at: new Date(),
                    }).catch((err) => {
                      console.error("Mongo mirror error:", err.message);
                    });

                    return res.json({ message: "Cash entry updated successfully" });
                  }
                  const item = cleanAdjustments[index++];
                  db.run(
                    insertSql,
                    [sourceEntryId, item.target_entry_id, item.adjusted_amount],
                    (insertErr) => {
                      if (insertErr) return res.status(500).json({ error: insertErr.message });
                      runNext();
                    }
                  );
                };
                runNext();
              }
            );
          }
        );
      }
    );
  });
});

router.get("/aging/company/:companyId", async (req, res) => {
  const { companyId } = req.params;
  const { entry_type, source_entry_id, include_all } = req.query;
  const includeAll = String(include_all || "0") === "1";
  const safeEntryType =
    entry_type && ["income", "expense"].includes(String(entry_type))
      ? String(entry_type)
      : null;
  const sourceEntryId = Number(source_entry_id);
  const safeSourceEntryId = Number.isFinite(sourceEntryId) && sourceEntryId > 0 ? sourceEntryId : null;
  const preferredType = safeEntryType
    ? safeEntryType === "income"
      ? "expense"
      : "income"
    : null;
  const filterType = includeAll ? null : preferredType;
  let companyFilterIds = [];
  try {
    companyFilterIds = await resolveCompanyFilterIds(companyId);
  } catch (resolveErr) {
    return res.status(500).json({ error: resolveErr.message });
  }

  if (companyFilterIds.length === 0) {
    return res.json([]);
  }

  const sql = `
    SELECT
      ce.id,
      ce.voucher_no,
      ce.entry_date,
      ce.entry_type,
      ce.description,
      ce.amount,
      COALESCE(
        SUM(
          CASE
            WHEN ? IS NOT NULL AND cea.source_entry_id = ? THEN 0
            ELSE COALESCE(cea.adjusted_amount, 0)
          END
        ),
        0
      ) AS adjusted_total,
      (
        ce.amount - COALESCE(
          SUM(
            CASE
              WHEN ? IS NOT NULL AND cea.source_entry_id = ? THEN 0
              ELSE COALESCE(cea.adjusted_amount, 0)
            END
          ),
          0
        )
      ) AS pending_amount
    FROM cash_entries ce
    LEFT JOIN cash_entry_adjustments cea ON cea.target_entry_id = ce.id
    WHERE ce.company_id IN (${companyFilterIds.map(() => "?").join(",")})
      AND (? IS NULL OR ce.entry_type = ?)
    GROUP BY ce.id
    HAVING (? = 1 OR pending_amount > 0.0001)
    ORDER BY
      CASE WHEN ? IS NOT NULL AND ce.entry_type = ? THEN 0 ELSE 1 END,
      ce.entry_date ASC,
      ce.id ASC
  `;

  db.all(
    sql,
    [
      safeSourceEntryId,
      safeSourceEntryId,
      safeSourceEntryId,
      safeSourceEntryId,
      ...companyFilterIds,
      filterType,
      filterType,
      includeAll ? 1 : 0,
      preferredType,
      preferredType,
    ],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const today = new Date();
      const result = (rows || []).map((row) => {
        const entryDate = new Date(row.entry_date);
        const ageDays = Number.isNaN(entryDate.getTime())
          ? 0
          : Math.max(0, Math.floor((today - entryDate) / (1000 * 60 * 60 * 24)));

        return {
          ...row,
          age_days: ageDays,
          is_preferred_type: preferredType ? row.entry_type === preferredType : false,
        };
      });

      return res.json(result);
    }
  );
});

router.patch("/:id(\\d+)", (req, res) => {
  if (!userHasPermission(req.user, "cash.edit")) {
    return res.status(403).json({ error: "You do not have permission to update cash entry status" });
  }

  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ error: "Status is required" });
  }

  getCashEntryBasicById(Number(req.params.id), (oldErr, oldRow) => {
    if (oldErr) return res.status(500).json({ error: oldErr.message });
    if (!oldRow) return res.status(404).json({ error: "Entry not found" });

    const isExpenseSplitEntry =
      oldRow.source_expense_id &&
      String(oldRow.entry_type || "").toLowerCase() === "expense";
    const updateSql = isExpenseSplitEntry
      ? `
        UPDATE cash_entries
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE source_expense_id = ?
          AND entry_type = 'expense'
          AND COALESCE(status, 'pending') != 'cancelled'
      `
      : `
        UPDATE cash_entries
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `;
    const updateParams = isExpenseSplitEntry
      ? [status, oldRow.source_expense_id]
      : [status, req.params.id];

    db.run(
      updateSql,
      updateParams,
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: "Entry not found" });

        writeCashAuditLog({
          req,
          action: String(status) === "cancelled" ? "cancel" : "status_change",
          entry_id: Number(req.params.id),
          voucher_no: oldRow.voucher_no || null,
          details: {
            before_status: oldRow.status || "pending",
            after_status: status,
          },
        });

        if (isExpenseSplitEntry) {
          runMongoMirror(() =>
            CashEntry.updateMany(
              { source_expense_id: Number(oldRow.source_expense_id), entry_type: "expense", status: { $ne: "cancelled" } },
              { $set: { status, updated_at: new Date() } }
            ).exec()
          ).catch((err) => {
            console.error("Mongo mirror error:", err.message);
          });
        } else {
          updateMongoCashEntryFields(Number(req.params.id), {
            status,
            updated_at: new Date(),
          }).catch((err) => {
            console.error("Mongo mirror error:", err.message);
          });
        }

        return res.json({
          message: "Cash entry status updated successfully",
          changes: this.changes || 0,
        });
      }
    );
  });
});

router.patch("/bulk-cancel", (req, res) => {
  if (!userHasPermission(req.user, "cash.delete")) {
    return res.status(403).json({ error: "You do not have permission to cancel cash entries" });
  }

  const { ids } = req.body || {};
  const cleanIds = Array.isArray(ids)
    ? ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
    : [];

  if (cleanIds.length > 0) {
    db.all(
      `SELECT id, voucher_no, status FROM cash_entries WHERE id IN (${cleanIds.map(() => "?").join(",")})`,
      cleanIds,
      (fetchErr, selectedRows) => {
        if (fetchErr) return res.status(500).json({ error: fetchErr.message });

        const sql = `
          UPDATE cash_entries
          SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
          WHERE id IN (${cleanIds.map(() => "?").join(",")})
        `;
        db.run(sql, cleanIds, function (err) {
          if (err) return res.status(500).json({ error: err.message });

          writeCashAuditLog({
            req,
            action: "bulk_cancel",
            details: {
              ids: cleanIds,
              changes: this.changes || 0,
              entries: selectedRows || [],
            },
          });
          mirrorMultipleCashEntryStatus(cleanIds, "cancelled").catch((err) => {
            console.error("Mongo mirror error:", err.message);
          });
          return res.json({ message: "Selected entries cancelled successfully", changes: this.changes || 0 });
        });
      }
    );
    return;
  }

  db.all(
    `
    SELECT id, voucher_no, status
    FROM cash_entries
    WHERE COALESCE(status, 'pending') != 'cancelled'
    ORDER BY id DESC
    `,
    [],
    (fetchErr, allRows) => {
      if (fetchErr) return res.status(500).json({ error: fetchErr.message });

      db.run(
        `
        UPDATE cash_entries
        SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE COALESCE(status, 'pending') != 'cancelled'
        `,
        function (err) {
          if (err) return res.status(500).json({ error: err.message });

          writeCashAuditLog({
            req,
            action: "bulk_cancel",
            details: {
              all_active: true,
              changes: this.changes || 0,
              entries: allRows || [],
            },
          });
          mirrorAllNonCancelledEntriesStatus("cancelled").catch((err) => {
            console.error("Mongo mirror error:", err.message);
          });
          return res.json({ message: "All active entries cancelled successfully", changes: this.changes || 0 });
        }
      );
    }
  );
});

// Delete cash entry
router.delete("/:id(\\d+)", (req, res) => {
  if (!userHasPermission(req.user, "cash.delete")) {
    return res.status(403).json({ error: "You do not have permission to delete cash entries" });
  }

  const isPermanentDelete = String(req.query?.permanent || "0") === "1";
  getCashEntryBasicById(Number(req.params.id), (oldErr, oldRow) => {
    if (oldErr) return res.status(500).json({ error: oldErr.message });
    if (!oldRow) return res.status(404).json({ error: "Entry not found" });

    if (isPermanentDelete) {
      return db.run(
        "DELETE FROM cash_entry_adjustments WHERE source_entry_id = ? OR target_entry_id = ?",
        [req.params.id, req.params.id],
        (adjErr) => {
          if (adjErr) return res.status(500).json({ error: adjErr.message });
          return db.run("DELETE FROM cash_entries WHERE id = ?", [req.params.id], function (deleteErr) {
            if (deleteErr) return res.status(500).json({ error: deleteErr.message });
            if (this.changes === 0) return res.status(404).json({ error: "Entry not found" });

            writeCashAuditLog({
              req,
              action: "permanent_delete",
              entry_id: Number(req.params.id),
              voucher_no: oldRow.voucher_no || null,
              details: {
                previous_status: oldRow.status || "pending",
              },
            });
            removeCashEntryFromMongo(req.params.id).catch((err) => {
              console.error("Mongo mirror error:", err.message);
            });
            return res.json({ message: "Cash entry deleted permanently" });
          });
        }
      );
    }

    const sql = `
      UPDATE cash_entries
      SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    db.run(sql, [req.params.id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: "Entry not found" });

      writeCashAuditLog({
        req,
        action: "delete",
        entry_id: Number(req.params.id),
        voucher_no: oldRow.voucher_no || null,
        details: {
          before_status: oldRow.status || "pending",
          after_status: "cancelled",
        },
      });
      updateMongoCashEntryFields(Number(req.params.id), {
        status: "cancelled",
        updated_at: new Date(),
      }).catch((err) => {
        console.error("Mongo mirror error:", err.message);
      });
      return res.json({ message: "Cash entry cancelled successfully" });
    });
  });
});

// Get cash summary (income vs expense by warehouse)
router.get("/summary/by-warehouse", (req, res) => {
  const { from_date, to_date } = req.query;

  let where = ["1=1"];
  const params = [];

  if (from_date) {
    where.push("ce.entry_date >= ?");
    params.push(from_date);
  }
  if (to_date) {
    where.push("ce.entry_date <= ?");
    params.push(to_date);
  }

  const sql = `
    SELECT
      w.name AS warehouse_name,
      ce.entry_type,
      SUM(ce.amount) AS total_amount,
      COUNT(*) AS entry_count
    FROM cash_entries ce
    LEFT JOIN warehouses w ON w.id = ce.warehouse_id
    WHERE ${where.join(" AND ")}
    GROUP BY ce.warehouse_id, ce.entry_type
    ORDER BY w.name ASC, ce.entry_type ASC
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Get total cash balance (income - expense)
router.get("/summary/total-balance", (req, res) => {
  const { from_date, to_date } = req.query;

  let where = ["1=1"];
  const params = [];

  if (from_date) {
    where.push("ce.entry_date >= ?");
    params.push(from_date);
  }
  if (to_date) {
    where.push("ce.entry_date <= ?");
    params.push(to_date);
  }

  const sql = `
    SELECT
      SUM(CASE WHEN ce.entry_type = 'income' THEN ce.amount ELSE 0 END) AS total_income,
      SUM(CASE WHEN ce.entry_type = 'expense' THEN ce.amount ELSE 0 END) AS total_expense,
      SUM(CASE WHEN ce.entry_type = 'income' THEN ce.amount ELSE -ce.amount END) AS net_balance
    FROM cash_entries ce
    WHERE ${where.join(" AND ")}
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows[0] || { total_income: 0, total_expense: 0, net_balance: 0 });
  });
});

module.exports = router;
