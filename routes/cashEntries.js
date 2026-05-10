const express = require("express");
const router = express.Router();
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

async function findSqliteIdByName(table, name) {
  const cleanedName = String(name || "").trim();
  if (!cleanedName) return null;
  const row = await dbGet(
    `SELECT id FROM ${table} WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) ORDER BY id ASC LIMIT 1`,
    [cleanedName]
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
      "INSERT INTO employees (name, address, location_id, username, password, role, permissions) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        doc.name || "",
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
  return {
    warehouse_id: await resolveMongoMasterId(values.warehouse_id, MongoWarehouse, "warehouses"),
    company_id: await resolveMongoMasterId(values.company_id, MongoCompany, "companies"),
    company_account_id: await resolveMongoMasterId(values.company_account_id, MongoCompanyAccount, "company_accounts"),
    employee_id: await resolveMongoMasterId(values.employee_id, MongoEmployee, "employees"),
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
           description, amount, payment_method, reference_no, narration, employee_id, status, fund_source, journal_group_no
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
    where.push("COALESCE(ce.status, 'pending') = ?");
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
      ce.journal_group_no,
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
    WHERE ${where.join(" AND ")}
    GROUP BY ce.id
    ORDER BY ce.entry_date DESC, ce.id DESC
  `;

  db.all(sql, params, async (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const enrichedRows = await enrichCashRowsWithMongoNames(rows || []);
    res.json(enrichedRows);
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
  db.get(
    `
    SELECT
      main_opening_balance,
      main_opening_type,
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
        updated_by: row?.updated_by || null,
        updated_at: row?.updated_at || null,
      });
    }
  );
});

router.put("/opening/main", (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Only admin can update main cash opening balance" });
  }

  const openingAmount = Number(req.body?.main_opening_balance || 0);
  const openingType = String(req.body?.main_opening_type || "dr").toLowerCase() === "cr" ? "cr" : "dr";

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
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: "Main cash opening settings not found" });

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
        main_opening_balance: openingAmount,
        main_opening_type: openingType,
      });
    }
  );
});

// Get cash entry by ID
router.get("/:id(\\d+)", (req, res) => {
  const sql = `
    SELECT
      ce.id,
      ce.voucher_no,
      ce.journal_group_no,
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
        COALESCE(t.journal_group_no, t.voucher_no) AS target_voucher_no,
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
        return res.json({
          ...enrichedRow,
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
    journal_group_no,
    status,
    fund_source,
    source_expense_id,
    adjustments,
    auto_staff_entry,
  } = req.body;

  if (!entry_date || !entry_type || !description || !amount) {
    return res.status(400).json({ error: "Required fields missing" });
  }

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
        journal_group_no,
        fund_source,
        status,
        source_expense_id,
        linked_entry_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(
      sql,
      [
        finalVoucherNo,
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
        req.user?.id || created_by || null,
        resolvedIds.employee_id || null,
        journal_group_no || null,
        String(fund_source || "main_cash"),
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
          const normalizedMode = String(transaction_mode || "").toLowerCase();
          const normalizedEntryType = String(entry_type || "").toLowerCase();
          const isReceiptFromEmployee =
            auto_staff_entry === true &&
            employee_id &&
            normalizedMode === "receipt" &&
            normalizedEntryType === "income" &&
            String(fund_source || "main_cash") === "main_cash";
          const isPaymentToEmployee =
            auto_staff_entry === true &&
            employee_id &&
            normalizedMode === "payment" &&
            normalizedEntryType === "expense" &&
            String(fund_source || "main_cash") === "main_cash";

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
                  narration, created_by, employee_id, journal_group_no, fund_source, 
                  status, source_expense_id, linked_entry_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                  journal_group_no || null,
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
                          entry_type,
                          amount: Number(amount || 0),
                          status: status || "pending",
                          employee_id,
                          staff_entry_type: staffEntryType,
                        },
                      });

upsertCashEntryToMongo({
                        id: newEntryId,
                        voucher_no: finalVoucherNo,
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
                        created_by: req.user?.id || created_by || null,
                        employee_id: employee_id || null,
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
                        entry_type: "income",
                        warehouse_id: warehouse_id || null,
                        company_id: null,
                        company_account_id: null,
                        description: baseDescriptionText(description),
                        amount,
                        payment_method: payment_method || "Cash",
                        reference_no: reference_no || null,
                        narration: narration || null,
                        created_by: req.user?.id || created_by || null,
                        employee_id: employee_id || null,
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
              amount: Number(amount || 0),
              status: status || "pending",
              has_adjustments: false,
            },
          });

          upsertCashEntryToMongo({
            id: newEntryId,
            voucher_no: finalVoucherNo,
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
            created_by: req.user?.id || created_by || null,
            employee_id: employee_id || null,
            journal_group_no: journal_group_no || null,
            fund_source: String(fund_source || "main_cash"),
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
            COALESCE(ce.journal_group_no, ce.voucher_no) AS voucher_no,
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

              if (String(target.company_id || "") !== String(company_id || "")) {
                db.run("DELETE FROM cash_entries WHERE id = ?", [newEntryId], () => {
                  return res.status(400).json({ error: "Adjustment target company mismatch" });
                });
                return;
              }

              if (String(target.entry_type) === String(entry_type)) {
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
                const finalDescription = `${baseDescriptionText(description)}${adjDetails}`;
                return db.run(
                  "UPDATE cash_entries SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                  [finalDescription, newEntryId],
                  (updateDescErr) => {
                    if (updateDescErr) return res.status(500).json({ error: updateDescErr.message });
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
                );
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
    const prefix = getVoucherPrefix({ transaction_mode, entry_type });
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
    journal_group_no,
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
      journal_group_no = ?,
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
        journal_group_no === undefined ? oldRow.journal_group_no || null : journal_group_no || null,
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
                COALESCE(ce.journal_group_no, ce.voucher_no) AS voucher_no,
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
                    const finalDescription = `${baseDescriptionText(description)}${adjDetails}`;
                    return db.run(
                      "UPDATE cash_entries SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                      [finalDescription, sourceEntryId],
                      (updateDescErr) => {
                        if (updateDescErr) return res.status(500).json({ error: updateDescErr.message });
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
                              description: finalDescription,
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
                          description: finalDescription,
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
                    );
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

router.get("/aging/company/:companyId", (req, res) => {
  const { companyId } = req.params;
  const { entry_type, source_entry_id } = req.query;
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

  const sql = `
    SELECT
      ce.id,
      COALESCE(ce.journal_group_no, ce.voucher_no) AS voucher_no,
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
    WHERE ce.company_id = ?
      AND (? IS NULL OR ce.entry_type = ?)
    GROUP BY ce.id
    HAVING pending_amount > 0.0001
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
      companyId,
      preferredType,
      preferredType,
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

    db.run(
      `
      UPDATE cash_entries
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `,
      [status, req.params.id],
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

        updateMongoCashEntryFields(Number(req.params.id), {
          status,
          updated_at: new Date(),
        }).catch((err) => {
          console.error("Mongo mirror error:", err.message);
        });

        return res.json({ message: "Cash entry status updated successfully" });
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
