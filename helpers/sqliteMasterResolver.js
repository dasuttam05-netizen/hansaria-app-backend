const {
  Location: MongoLocation,
  Employee: MongoEmployee,
  Product: MongoProduct,
  Company: MongoCompany,
  CompanyAccount: MongoCompanyAccount,
  Warehouse: MongoWarehouse,
} = require("../mongo");

function isPositiveNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0;
}

function normalizeOptionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

async function findSqliteIdByName(db, table, name, field = "name") {
  const cleanedName = String(name || "").trim();
  if (!cleanedName) return null;

  const row = await dbGet(
    db,
    `SELECT id FROM ${table} WHERE LOWER(TRIM(${field})) = LOWER(TRIM(?)) ORDER BY id ASC LIMIT 1`,
    [cleanedName]
  );

  return row?.id || null;
}

async function createSqliteMasterFromMongo(db, model, sqliteTable, doc) {
  if (sqliteTable === "locations") {
    const result = await dbRun(db, "INSERT INTO locations (name, address) VALUES (?, ?)", [
      doc.name || "",
      doc.address || "",
    ]);
    return result.lastID || null;
  }

  if (sqliteTable === "employees") {
    const locationId = await resolveMongoMasterId(db, doc.location_id, MongoLocation, "locations");
    const result = await dbRun(
      db,
      "INSERT INTO employees (name, mobile, address, location_id, username, password, role, permissions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        doc.name || "",
        doc.mobile || "",
        doc.address || "",
        locationId || null,
        doc.username || "",
        doc.password || "",
        doc.role || "staff",
        JSON.stringify(doc.permissions || []),
      ]
    );
    return result.lastID || null;
  }

  if (sqliteTable === "products") {
    const result = await dbRun(db, "INSERT INTO products (name, hsn_code) VALUES (?, ?)", [
      doc.name || "",
      doc.hsn_code || "",
    ]);
    return result.lastID || null;
  }

  if (sqliteTable === "companies") {
    const result = await dbRun(
      db,
      "INSERT INTO companies (name, address, mobile, shortage_percent, opening_balance, opening_balance_type) VALUES (?, ?, ?, ?, ?, ?)",
      [
        doc.name || "",
        doc.address || "",
        doc.mobile || "",
        normalizeOptionalNumber(doc.shortage_percent),
        Number(doc.opening_balance ?? 0),
        String(doc.opening_balance_type || "dr").toLowerCase() === "cr" ? "cr" : "dr",
      ]
    );
    return result.lastID || null;
  }

  if (sqliteTable === "company_accounts") {
    const companyId = await resolveMongoMasterId(db, doc.company_id, MongoCompany, "companies");
    if (!companyId) return null;
    const result = await dbRun(
      db,
      "INSERT INTO company_accounts (account_name, address, company_id, pan_no, mobile, shortage_percent) VALUES (?, ?, ?, ?, ?, ?)",
      [doc.account_name || "", doc.address || "", companyId, doc.pan_no || "", doc.mobile || "", normalizeOptionalNumber(doc.shortage_percent)]
    );
    return result.lastID || null;
  }

  if (sqliteTable === "warehouses") {
    const locationId = await resolveMongoMasterId(db, doc.location_id, MongoLocation, "locations");
    const employeeId = await resolveMongoMasterId(db, doc.employee_id, MongoEmployee, "employees");
    const result = await dbRun(
      db,
      "INSERT INTO warehouses (name, address, location_id, employee_id) VALUES (?, ?, ?, ?)",
      [doc.name || "", doc.address || "", locationId || null, employeeId || null]
    );
    return result.lastID || null;
  }

  return null;
}

async function resolveMongoMasterId(db, value, model, sqliteTable, nameField = "name") {
  const normalizedValue =
    value && typeof value === "object" ? value.id || value._id || value : value;

  if (!normalizedValue) return null;
  if (isPositiveNumber(normalizedValue)) return Number(normalizedValue);

  const doc = await model.findById(normalizedValue).lean().catch(() => null);
  if (!doc) return null;

  if (sqliteTable === "company_accounts") {
    return (
      (await findSqliteIdByName(db, "company_accounts", doc.account_name, "account_name")) ||
      createSqliteMasterFromMongo(db, model, sqliteTable, doc)
    );
  }

  return (
    (await findSqliteIdByName(db, sqliteTable, doc[nameField])) ||
    createSqliteMasterFromMongo(db, model, sqliteTable, doc)
  );
}

async function resolveEntryMasterIds(db, values) {
  return {
    employee_id: await resolveMongoMasterId(db, values.employee_id, MongoEmployee, "employees"),
    location_id: await resolveMongoMasterId(db, values.location_id, MongoLocation, "locations"),
    warehouse_id: await resolveMongoMasterId(db, values.warehouse_id, MongoWarehouse, "warehouses"),
    product_id: await resolveMongoMasterId(db, values.product_id, MongoProduct, "products"),
    company_id: await resolveMongoMasterId(db, values.company_id, MongoCompany, "companies"),
    company_account_id: await resolveMongoMasterId(db, values.company_account_id, MongoCompanyAccount, "company_accounts"),
  };
}

async function resolveWarehouseIds(db, values = []) {
  const resolved = [];

  for (const value of values || []) {
    const warehouseId = await resolveMongoMasterId(db, value, MongoWarehouse, "warehouses");
    if (warehouseId && !resolved.includes(Number(warehouseId))) {
      resolved.push(Number(warehouseId));
    }
  }

  return resolved;
}

module.exports = {
  resolveEntryMasterIds,
  resolveWarehouseIds,
};
