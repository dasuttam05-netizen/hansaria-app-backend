const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const db = require("../db");
const {
  Location: MongoLocation,
  Employee: MongoEmployee,
  Warehouse: MongoWarehouse,
  Product: MongoProduct,
  Company: MongoCompany,
  CompanyAccount: MongoCompanyAccount,
  Outward: MongoOutward,
  SqliteMirrorRow,
  isMongoMirrorReady,
} = require("../db-mongodb");

const wrapAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
const { userHasPermission } = require("../middleware/auth");
const { canAccessWarehouse, assignedWarehouseFilter } = require("../helpers/access");
const { resolveEntryMasterIds, resolveWarehouseIds } = require("../helpers/sqliteMasterResolver");

function isSelfLoadingOutward(row) {
  return String(row?.self_loading || "").trim().toLowerCase() === "yes";
}

function canAccessOutwardRow(user, row) {
  if (!row) return false;
  if (isSelfLoadingOutward(row)) return true;
  return canAccessWarehouse(user, row.warehouse_id);
}

const safeNumber = (v) => (v === undefined || v === null || v === "" ? 0 : Number(v));
const safeText = (v) => (v ? v : null);
const formatOutwardVoucher = (slNo) => `OUT-${String(slNo).padStart(4, "0")}`;
const mongoReady = () => isMongoMirrorReady();
const coerceSqlId = (value) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) && num > 0 ? num : trimmed;
  }
  if (typeof value === "object") {
    return coerceSqlId(value.id || value._id || value.value);
  }
  return null;
};

function buildOutwardMirrorRowData(rowId, payload = {}, resolvedIds = {}, normalizedWarehouseId = null, extra = {}) {
  const qty = safeNumber(payload?.quantity ?? payload?.qty ?? payload?.weight);
  const rateVal = safeNumber(payload?.rate);
  const amount = qty * rateVal;
  const selfLoading = safeText(payload?.self_loading) || "No";
  const voucherNo = safeText(payload?.voucher_no || payload?.outward_no || payload?.inv_no || extra?.voucher_no);

  return {
    id: Number(rowId),
    sl_no: extra?.sl_no ?? null,
    voucher_no: voucherNo,
    outward_no: safeText(payload?.outward_no || payload?.voucher_no || payload?.inv_no || extra?.voucher_no),
    date: safeText(payload?.date),
    employee_id: resolvedIds?.employee_id || payload?.employee_id || null,
    location_id: resolvedIds?.location_id || payload?.location_id || null,
    warehouse_id: normalizedWarehouseId ?? payload?.warehouse_id ?? null,
    product_id: resolvedIds?.product_id || payload?.product_id || null,
    company_id: resolvedIds?.company_id || payload?.company_id || null,
    company_account_id: resolvedIds?.company_account_id || payload?.company_account_id || null,
    buyer_name: safeText(payload?.buyer_name),
    consignee_name: safeText(payload?.consignee_name),
    lorry_no: safeText(payload?.lorry_no),
    weight: safeNumber(payload?.weight),
    quantity: qty,
    rate: rateVal,
    amount,
    inv_no: safeText(payload?.inv_no),
    self_loading: selfLoading,
    status: extra?.status || "Pending",
    ...extra,
  };
}

function normalizeId(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "object") {
    if (typeof value.toString === "function" && value.toString() !== "[object Object]") {
      return String(value.toString());
    }
    return String(value._id || value.id || "");
  }
  return String(value);
}

async function querySqliteLookupMap(table, idField, nameField, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return new Map();
  }

  const numericIds = ids
    .map((id) => (typeof id === "string" ? Number(id) : Number(id)))
    .filter((id) => Number.isFinite(id));
  if (numericIds.length === 0) {
    return new Map();
  }

  const placeholders = numericIds.map(() => "?").join(",");
  const sql = `SELECT ${idField} AS id, ${nameField} AS name FROM ${table} WHERE ${idField} IN (${placeholders})`;

  return new Promise((resolve) => {
    db.all(sql, numericIds, (err, rows) => {
      if (err || !Array.isArray(rows)) {
        return resolve(new Map());
      }
      const map = new Map();
      rows.forEach((row) => {
        const key = normalizeId(row?.id);
        if (key) map.set(key, row?.name || "");
      });
      resolve(map);
    });
  });
}

async function buildSqliteLookupMaps(docs) {
  const employeeIds = new Set();
  const locationIds = new Set();
  const warehouseIds = new Set();
  const productIds = new Set();
  const companyIds = new Set();
  const accountIds = new Set();

  for (const doc of docs || []) {
    if (!doc) continue;
    if (doc.employee_id != null) employeeIds.add(normalizeId(doc.employee_id));
    if (doc.location_id != null) locationIds.add(normalizeId(doc.location_id));
    if (doc.warehouse_id != null) warehouseIds.add(normalizeId(doc.warehouse_id));
    if (doc.product_id != null) productIds.add(normalizeId(doc.product_id));
    if (doc.company_id != null) companyIds.add(normalizeId(doc.company_id));
    if (doc.company_account_id != null) accountIds.add(normalizeId(doc.company_account_id));
  }

  const [employeeNames, locationNames, warehouseNames, productNames, companyNames, accountNames] = await Promise.all([
    querySqliteLookupMap("employees", "id", "name", Array.from(employeeIds)),
    querySqliteLookupMap("locations", "id", "name", Array.from(locationIds)),
    querySqliteLookupMap("warehouses", "id", "name", Array.from(warehouseIds)),
    querySqliteLookupMap("products", "id", "name", Array.from(productIds)),
    querySqliteLookupMap("companies", "id", "name", Array.from(companyIds)),
    querySqliteLookupMap("company_accounts", "id", "account_name", Array.from(accountIds)),
  ]);

  return { employeeNames, locationNames, warehouseNames, productNames, companyNames, accountNames };
}

function extractValidObjectIds(values) {
  return Array.from(values)
    .filter((value) => {
      if (!value) return false;
      try {
        return mongoose.Types.ObjectId.isValid(value);
      } catch (error) {
        return false;
      }
    })
    .map((value) => new mongoose.Types.ObjectId(value));
}

async function buildMongoLookupMaps(docs) {
  const employeeIds = new Set();
  const locationIds = new Set();
  const warehouseIds = new Set();
  const productIds = new Set();
  const companyIds = new Set();
  const accountIds = new Set();

  for (const doc of docs || []) {
    if (!doc) continue;
    if (doc.employee_id != null) employeeIds.add(normalizeId(doc.employee_id));
    if (doc.location_id != null) locationIds.add(normalizeId(doc.location_id));
    if (doc.warehouse_id != null) warehouseIds.add(normalizeId(doc.warehouse_id));
    if (doc.product_id != null) productIds.add(normalizeId(doc.product_id));
    if (doc.company_id != null) companyIds.add(normalizeId(doc.company_id));
    if (doc.company_account_id != null) accountIds.add(normalizeId(doc.company_account_id));
  }

  const mongoEmployeeIds = extractValidObjectIds(employeeIds);
  const mongoLocationIds = extractValidObjectIds(locationIds);
  const mongoWarehouseIds = extractValidObjectIds(warehouseIds);
  const mongoProductIds = extractValidObjectIds(productIds);
  const mongoCompanyIds = extractValidObjectIds(companyIds);
  const mongoAccountIds = extractValidObjectIds(accountIds);

  const [employeeNames, locationNames, warehouseNames, productNames, companyNames, accountNames] = await Promise.all([
    MongoEmployee.find({ _id: { $in: mongoEmployeeIds } }).lean().then((rows) => new Map(rows.map((row) => [normalizeId(row._id || row.id), row.name || ""]))),
    MongoLocation.find({ _id: { $in: mongoLocationIds } }).lean().then((rows) => new Map(rows.map((row) => [normalizeId(row._id || row.id), row.name || ""]))),
    MongoWarehouse.find({ _id: { $in: mongoWarehouseIds } }).lean().then((rows) => new Map(rows.map((row) => [normalizeId(row._id || row.id), row.name || ""]))),
    MongoProduct.find({ _id: { $in: mongoProductIds } }).lean().then((rows) => new Map(rows.map((row) => [normalizeId(row._id || row.id), row.name || ""]))),
    MongoCompany.find({ _id: { $in: mongoCompanyIds } }).lean().then((rows) => new Map(rows.map((row) => [normalizeId(row._id || row.id), row.name || ""]))),
    MongoCompanyAccount.find({ _id: { $in: mongoAccountIds } }).lean().then((rows) => new Map(rows.map((row) => [normalizeId(row._id || row.id), row.account_name || ""]))),
  ]);

  return { employeeNames, locationNames, warehouseNames, productNames, companyNames, accountNames };
}

function mergeLookupMaps(mongoMaps, sqliteMaps) {
  return {
    employeeNames: new Map([...sqliteMaps.employeeNames, ...mongoMaps.employeeNames]),
    locationNames: new Map([...sqliteMaps.locationNames, ...mongoMaps.locationNames]),
    warehouseNames: new Map([...sqliteMaps.warehouseNames, ...mongoMaps.warehouseNames]),
    productNames: new Map([...sqliteMaps.productNames, ...mongoMaps.productNames]),
    companyNames: new Map([...sqliteMaps.companyNames, ...mongoMaps.companyNames]),
    accountNames: new Map([...sqliteMaps.accountNames, ...mongoMaps.accountNames]),
  };
}

function upsertOutwardMirrorByVoucherNo(voucherNo, payload, resolvedIds, normalizedWarehouseId, callback, existingRowId = null) {
  const cleanedVoucherNo = safeText(voucherNo || payload?.voucher_no || payload?.outward_no || payload?.inv_no);
  const qty = safeNumber(payload.quantity) || safeNumber(payload.weight);
  const rateVal = safeNumber(payload.rate);
  const amount = qty * rateVal;
  const selfLoading = safeText(payload.self_loading) || "No";

  const saveRow = (rowId = null) => {
    const sql = rowId
      ? `
        UPDATE outward SET
          date=?, employee_id=?, location_id=?, warehouse_id=?,
          product_id=?, company_id=?, company_account_id=?,
          buyer_name=?, consignee_name=?,
          lorry_no=?, weight=?, quantity=?, rate=?, amount=?,
          inv_no=?, self_loading=?,
          status='Pending'
        WHERE id=?
      `
      : `
        INSERT INTO outward (
          sl_no, voucher_no, date, employee_id, location_id, warehouse_id,
          product_id, company_id, company_account_id,
          lorry_no, weight, quantity, rate, amount,
          buyer_name, consignee_name,
          inv_no, self_loading,
          status
        ) VALUES (
          COALESCE((SELECT MAX(sl_no) + 1 FROM outward), 1),
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `;

    const params = rowId
      ? [
          safeText(payload.date),
          resolvedIds.employee_id || null,
          resolvedIds.location_id || null,
          normalizedWarehouseId,
          resolvedIds.product_id || null,
          resolvedIds.company_id || null,
          resolvedIds.company_account_id || null,
          safeText(payload.buyer_name),
          safeText(payload.consignee_name),
          safeText(payload.lorry_no),
          safeNumber(payload.weight),
          qty,
          rateVal,
          amount,
          safeText(payload.inv_no),
          selfLoading,
          rowId,
        ]
      : [
          cleanedVoucherNo,
          safeText(payload.date),
          resolvedIds.employee_id || null,
          resolvedIds.location_id || null,
          normalizedWarehouseId,
          resolvedIds.product_id || null,
          resolvedIds.company_id || null,
          resolvedIds.company_account_id || null,
          safeText(payload.lorry_no),
          safeNumber(payload.weight),
          qty,
          rateVal,
          amount,
          safeText(payload.buyer_name),
          safeText(payload.consignee_name),
          cleanedVoucherNo,
          selfLoading,
          "Pending",
        ];

    db.run(sql, params, function onSync(err) {
      if (err) return callback(err);
      const savedId = rowId || this.lastID;
      const mirrorRow = buildOutwardMirrorRowData(
        savedId,
        payload,
        resolvedIds,
        normalizedWarehouseId,
        {
          sl_no: null,
          voucher_no: cleanedVoucherNo,
          status: "Pending",
        }
      );

      syncOutwardRowToMirror(savedId, mirrorRow).catch((mirrorErr) => {
        console.error("Outward mirror row sync failed:", mirrorErr?.message || mirrorErr);
      });

      return callback(null, { id: savedId, voucher_no: cleanedVoucherNo });
    });
  };

  const lookupId = safeNumber(existingRowId);
  const lookupSql = lookupId > 0
    ? `SELECT id FROM outward WHERE id = ? OR voucher_no = ? ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id ASC LIMIT 1`
    : `SELECT id FROM outward WHERE voucher_no = ? ORDER BY id ASC LIMIT 1`;
  const lookupParams = lookupId > 0 ? [lookupId, cleanedVoucherNo, lookupId] : [cleanedVoucherNo];

  db.get(lookupSql, lookupParams, (findErr, existing) => {
    if (findErr) return callback(findErr);
    if (existing?.id) return saveRow(existing.id);
    return saveRow(null);
  });
}

async function syncOutwardRowToMirror(rowId, rowData) {
  if (!rowId || !SqliteMirrorRow || typeof SqliteMirrorRow.updateOne !== "function") {
    return null;
  }

  const safeRowId = Number(rowId);
  if (!Number.isFinite(safeRowId) || safeRowId <= 0) {
    return null;
  }

  const payload = {
    ...(rowData || {}),
    id: safeRowId,
  };

  const mirrorPayload = buildOutwardMirrorRowData(
    safeRowId,
    payload,
    {
      employee_id: payload.employee_id,
      location_id: payload.location_id,
      warehouse_id: payload.warehouse_id,
      product_id: payload.product_id,
      company_id: payload.company_id,
      company_account_id: payload.company_account_id,
    },
    payload.warehouse_id,
    payload
  );

  return SqliteMirrorRow.updateOne(
    { table: "outward", row_id: safeRowId },
    {
      $set: {
        data: mirrorPayload,
        updated_at: new Date(),
      },
    },
    { upsert: true }
  ).exec();
}

function buildMongoOutwardPayload(reqBody, resolvedIds, normalizedWarehouseId) {
  const qty = safeNumber(reqBody.quantity) || safeNumber(reqBody.weight);
  const rateVal = safeNumber(reqBody.rate);
  return {
    date: safeText(reqBody.date) ? new Date(safeText(reqBody.date)) : null,
    location: resolvedIds.location_id ? String(resolvedIds.location_id) : safeText(reqBody.location_id),
    outward_no:
      safeText(reqBody.outward_no) || safeText(reqBody.voucher_no) || safeText(reqBody.inv_no) || "",
    employee_id: resolvedIds.employee_id || safeText(reqBody.employee_id) || null,
    location_id: resolvedIds.location_id || safeText(reqBody.location_id) || null,
    warehouse_id: normalizedWarehouseId || safeText(reqBody.warehouse_id) || null,
    product_id: resolvedIds.product_id || safeText(reqBody.product_id) || null,
    company_id: resolvedIds.company_id || safeText(reqBody.company_id) || null,
    company_account_id: resolvedIds.company_account_id || safeText(reqBody.company_account_id) || null,
    buyer: safeText(reqBody.buyer_name) || "",
    buyer_name: safeText(reqBody.buyer_name) || "",
    consignee_id: safeText(reqBody.consignee_id) || null,
    consignee_name: safeText(reqBody.consignee_name) || "",
    product: resolvedIds.product_id ? String(resolvedIds.product_id) : safeText(reqBody.product_id),
    quantity: qty,
    rate: rateVal,
    amount: qty * rateVal,
    transporter: safeText(reqBody.lorry_no) || "",
    lorry_no: safeText(reqBody.lorry_no) || "",
    inv_no: safeText(reqBody.inv_no) || "",
    self_loading: safeText(reqBody.self_loading) || "No",
    status: "Pending",
    narration: safeText(reqBody.narration) || "",
  };
}

function insertSQLiteOutwardRecord(payload, resolvedIds, normalizedWarehouseId, callback) {
  const qty = safeNumber(payload.quantity) || safeNumber(payload.weight);
  const rateVal = safeNumber(payload.rate);
  const amount = qty * rateVal;

  db.get("SELECT IFNULL(MAX(sl_no),0)+1 as sl FROM outward", (err, row) => {
    if (err) return callback(err);

    const sl_no = row?.sl || 1;
    const voucher_no = formatOutwardVoucher(sl_no);

    db.run(
      `
      INSERT INTO outward (
        sl_no, voucher_no, date, employee_id, location_id, warehouse_id,
        product_id, company_id, company_account_id,
        buyer_name, consignee_name,
        lorry_no, weight, quantity, rate, amount,
        inv_no, self_loading,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        sl_no,
        voucher_no,
        safeText(payload.date),
        resolvedIds.employee_id || null,
        resolvedIds.location_id || null,
        normalizedWarehouseId,
        resolvedIds.product_id || null,
        resolvedIds.company_id || null,
        resolvedIds.company_account_id || null,
        safeText(payload.buyer_name),
        safeText(payload.consignee_name),
        safeText(payload.lorry_no),
        safeNumber(payload.weight),
        qty,
        rateVal,
        amount,
        safeText(payload.inv_no),
        safeText(payload.self_loading) || "No",
        "Pending",
      ],
      function onInsert(insertErr) {
        if (insertErr) return callback(insertErr);
        const savedId = this.lastID;
        const mirrorRow = buildOutwardMirrorRowData(
          savedId,
          payload,
          resolvedIds,
          normalizedWarehouseId,
          {
            sl_no,
            voucher_no,
            status: "Pending",
          }
        );

        syncOutwardRowToMirror(savedId, mirrorRow).catch((mirrorErr) => {
          console.error("Outward mirror row sync failed:", mirrorErr?.message || mirrorErr);
        });

        return callback(null, { id: savedId, voucher_no });
      }
    );
  });
}

function buildOutwardResponse(doc, source = "mongodb") {
  if (!doc) return null;
  const plain = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    ...plain,
    id: String(plain._id || plain.id || ""),
    saved_to: source,
  };
}

function getAvailableWarehouseStock({ warehouse_id, product_id, outwardId }, callback) {
  const params = [safeNumber(product_id), safeNumber(warehouse_id)];
  let excludeClause = "";

  if (outwardId) {
    excludeClause = "AND o.id <> ?";
    params.push(safeNumber(outwardId));
  }

  const sql = `
    SELECT
      IFNULL((
        SELECT SUM(i.remaining_qty)
        FROM inward i
        WHERE i.product_id = ?
          AND i.warehouse_id = ?
      ), 0) AS current_stock,
      IFNULL((
        SELECT SUM(
          MAX(
            (IFNULL(o.quantity, 0) - IFNULL((
              SELECT SUM(a.qty)
              FROM adjustment a
              WHERE a.outward_id = o.id
            ), 0)),
            0
          )
        )
        FROM outward o
        WHERE o.product_id = ?
          AND o.warehouse_id = ?
          AND o.status IN ('Pending', 'Partial')
          ${excludeClause}
      ), 0) AS reserved_stock
  `;

  const queryParams = [params[0], params[1], params[0], params[1], ...params.slice(2)];
  db.get(sql, queryParams, (err, row) => {
    if (err) return callback(err);

    const currentStock = Number(row?.current_stock) || 0;
    const reservedStock = Number(row?.reserved_stock) || 0;
    return callback(null, {
      currentStock,
      reservedStock,
      availableStock: Math.max(currentStock - reservedStock, 0),
    });
  });
}

function validateOutwardStock({ warehouse_id, product_id, qty, outwardId }, callback) {
  getAvailableWarehouseStock({ warehouse_id, product_id, outwardId }, (err, stock) => {
    if (err) return callback(err);

    if (stock.availableStock < qty) {
      return callback(null, {
        ok: false,
        error: `Not enough stock in this warehouse. Available stock is ${stock.availableStock.toFixed(2)}.`,
      });
    }

    return callback(null, { ok: true, stock });
  });
}

router.get("/available-stock", async (req, res) => {
  if (!userHasPermission(req.user, "outward.view") && !userHasPermission(req.user, "outward.create") && !userHasPermission(req.user, "outward.edit")) {
    return res.status(403).json({ error: "You do not have permission to view outward stock" });
  }

  let resolvedIds;
  try {
    resolvedIds = await resolveEntryMasterIds(db, req.query);
  } catch (resolveErr) {
    return res.status(500).json({ error: resolveErr.message });
  }

  const warehouseId = resolvedIds.warehouse_id || safeNumber(req.query.warehouse_id);
  const productId = resolvedIds.product_id || safeNumber(req.query.product_id);
  const outwardId = safeNumber(req.query.outward_id);

  if (!warehouseId || !productId) {
    return res.json({
      currentStock: 0,
      reservedStock: 0,
      availableStock: 0,
    });
  }

  if (!canAccessWarehouse(req.user, req.query.warehouse_id) && !canAccessWarehouse(req.user, warehouseId)) {
    return res.status(403).json({ error: "You can only view stock for your assigned warehouse" });
  }

  getAvailableWarehouseStock({ warehouse_id: warehouseId, product_id: productId, outwardId }, (err, stock) => {
    if (err) return res.status(500).json({ error: err.message });
    return res.json(stock);
  });
});

router.get("/pending", async (req, res) => {
  if (!userHasPermission(req.user, "outward.view")) {
    return res.status(403).json({ error: "You do not have permission to view outward entries" });
  }

  if (mongoReady()) {
    try {
      const docs = await MongoOutward.find({ status: { $in: ["Pending", "Partial"] } }).lean();
      const lookup = mergeLookupMaps(await buildMongoLookupMaps(docs), await buildSqliteLookupMaps(docs));
      const rows = (docs || [])
        .filter((row) => canAccessOutwardRow(req.user, row))
        .map((row) => ({
          ...row,
          id: String(row._id),
          voucher_no: row.outward_no || row.voucher_no || null,
          employee_name: lookup.employeeNames.get(normalizeId(row.employee_id)) || row.employee_name || "",
          location_name: lookup.locationNames.get(normalizeId(row.location_id)) || row.location_name || "",
          warehouse_name: lookup.warehouseNames.get(normalizeId(row.warehouse_id)) || row.warehouse_name || "",
          product_name: lookup.productNames.get(normalizeId(row.product_id)) || row.product_name || row.product || "",
          company_name: lookup.companyNames.get(normalizeId(row.company_id)) || row.company_name || row.buyer_name || row.buyer || "",
          party_name: lookup.accountNames.get(normalizeId(row.company_account_id)) || row.party_name || row.company_account_name || "",
          saved_from: "mongodb",
        }));
      if (rows.length > 0) {
        return res.json(rows);
      }
    } catch (err) {
      console.error("Mongo outward pending fetch failed, falling back to SQLite:", err.message);
    }
  }

  const rawWarehouseScope = assignedWarehouseFilter(req.user, "o.warehouse_id");
  const resolvedWarehouseIds = await resolveWarehouseIds(db, rawWarehouseScope.params).catch(() => []);
  const warehouseScope = rawWarehouseScope.clause
    ? resolvedWarehouseIds.length > 0
      ? {
          clause: ` AND (o.warehouse_id IN (${resolvedWarehouseIds.map(() => "?").join(",")}) OR LOWER(COALESCE(o.self_loading, 'No')) = 'yes')`,
          params: resolvedWarehouseIds,
        }
      : { clause: " AND LOWER(COALESCE(o.self_loading, 'No')) = 'yes'", params: [] }
    : rawWarehouseScope;
  const sql = `
    SELECT o.*, 
      w.name AS warehouse_name,
      p.name AS product_name,
      c.name AS company_name,
      ca.account_name AS party_name
    FROM outward o
    LEFT JOIN warehouses w ON o.warehouse_id = w.id
    LEFT JOIN products p ON o.product_id = p.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN company_accounts ca ON o.company_account_id = ca.id
    WHERE o.status IN ('Pending','Partial')
    ${warehouseScope.clause}
    ORDER BY o.id DESC
  `;

  db.all(sql, warehouseScope.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    return res.json(rows);
  });
});

router.put("/complete/:id", (req, res) => {
  if (!userHasPermission(req.user, "outward.edit")) {
    return res.status(403).json({ error: "You do not have permission to complete outward entries" });
  }

  const outwardId = req.params.id;

  db.get(`SELECT * FROM outward WHERE id=?`, [outwardId], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: "Outward not found" });
    }
    if (!canAccessOutwardRow(req.user, row)) {
      return res.status(403).json({ error: "You can only update entries for your assigned warehouse" });
    }

    let remaining = Number(row.quantity) || 0;

    db.serialize(() => {
      db.run("BEGIN TRANSACTION");

      db.all(
        `
        SELECT * FROM inward 
        WHERE product_id=? 
          AND warehouse_id=? 
          AND remaining_qty > 0
        ORDER BY id ASC
        `,
        [row.product_id, row.warehouse_id],
        (err2, inwardRows) => {
          if (err2) {
            db.run("ROLLBACK");
            return res.status(500).json({ error: err2.message });
          }

          const processNext = (index) => {
            if (index >= inwardRows.length || remaining <= 0) {
              return finish();
            }

            const inw = inwardRows[index];
            const useQty = Math.min(Number(inw.remaining_qty), remaining);

            db.run(
              `UPDATE inward SET remaining_qty = remaining_qty - ? WHERE id=?`,
              [useQty, inw.id],
              (err3) => {
                if (err3) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: err3.message });
                }

                db.run(
                  `INSERT INTO adjustment (outward_id, inward_id, qty) VALUES (?, ?, ?)`,
                  [outwardId, inw.id, useQty],
                  (err4) => {
                    if (err4) {
                      db.run("ROLLBACK");
                      return res.status(500).json({ error: err4.message });
                    }

                    remaining -= useQty;
                    processNext(index + 1);
                  }
                );
              }
            );
          };

          const finish = () => {
            const status = remaining > 0 ? "Partial" : "Completed";

            db.run(`UPDATE outward SET status=? WHERE id=?`, [status, outwardId], (err5) => {
              if (err5) {
                db.run("ROLLBACK");
                return res.status(500).json({ error: err5.message });
              }

              db.run("COMMIT", (err6) => {
                if (err6) return res.status(500).json({ error: err6.message });
                return res.json({
                  message: "FIFO Adjustment Done",
                  remaining_qty: remaining,
                  status,
                });
              });
            });
          };

          processNext(0);
        }
      );
    });
  });
});

router.get("/", async (req, res) => {
  if (!userHasPermission(req.user, "outward.view")) {
    return res.status(403).json({ error: "You do not have permission to view outward entries" });
  }

  if (mongoReady()) {
    try {
      const docs = await MongoOutward.find({}).sort({ created_at: -1, _id: -1 }).lean();
      const lookup = mergeLookupMaps(await buildMongoLookupMaps(docs), await buildSqliteLookupMaps(docs));
      const rows = (docs || [])
        .filter((row) => canAccessOutwardRow(req.user, row))
        .map((row) => ({
          ...row,
          id: String(row._id),
          voucher_no: row.outward_no || row.voucher_no || null,
          location_name: lookup.locationNames.get(normalizeId(row.location_id)) || row.location_name || "",
          employee_name: lookup.employeeNames.get(normalizeId(row.employee_id)) || row.employee_name || "",
          warehouse_name: lookup.warehouseNames.get(normalizeId(row.warehouse_id)) || row.warehouse_name || "",
          product_name: lookup.productNames.get(normalizeId(row.product_id)) || row.product_name || row.product || "",
          company_name: lookup.companyNames.get(normalizeId(row.company_id)) || row.company_name || row.buyer_name || row.buyer || "",
          party_name: lookup.accountNames.get(normalizeId(row.company_account_id)) || row.party_name || row.company_account_name || "",
          saved_from: "mongodb",
        }));
      if (rows.length > 0) {
        return res.json(rows);
      }
    } catch (err) {
      console.error("Mongo outward fetch failed, falling back to SQLite:", err.message);
    }
  }

  const rawWarehouseScope = assignedWarehouseFilter(req.user, "o.warehouse_id");
  const resolvedWarehouseIds = await resolveWarehouseIds(db, rawWarehouseScope.params).catch(() => []);
  const warehouseScope = rawWarehouseScope.clause
    ? resolvedWarehouseIds.length > 0
      ? {
          clause: ` AND (o.warehouse_id IN (${resolvedWarehouseIds.map(() => "?").join(",")}) OR LOWER(COALESCE(o.self_loading, 'No')) = 'yes')`,
          params: resolvedWarehouseIds,
        }
      : { clause: " AND LOWER(COALESCE(o.self_loading, 'No')) = 'yes'", params: [] }
    : rawWarehouseScope;
  const sql = `
    SELECT o.*, 
      l.name AS location_name,
      e.name AS employee_name,
      w.name AS warehouse_name,
      p.name AS product_name,
      c.name AS company_name,
      ca.account_name AS party_name
    FROM outward o
    LEFT JOIN locations l ON o.location_id = l.id
    LEFT JOIN employees e ON o.employee_id = e.id
    LEFT JOIN warehouses w ON o.warehouse_id = w.id
    LEFT JOIN products p ON o.product_id = p.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN company_accounts ca ON o.company_account_id = ca.id
    WHERE 1=1
    ${warehouseScope.clause}
    ORDER BY o.id DESC
  `;

  db.all(sql, warehouseScope.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    return res.json(rows);
  });
});

router.post("/", wrapAsync(async (req, res) => {
  if (!userHasPermission(req.user, "outward.create")) {
    return res.status(403).json({ error: "You do not have permission to create outward entries" });
  }

  const {
    date,
    employee_id,
    location_id,
    warehouse_id,
    product_id,
    company_id,
    company_account_id,
    buyer_name,
    consignee_name,
    lorry_no,
    weight,
    quantity,
    rate,
    inv_no,
    self_loading,
  } = req.body;

  const qty = safeNumber(quantity) || safeNumber(weight);
  const isSelfLoading = String(self_loading || "No").trim().toLowerCase() === "yes";
  const resolvedIds = {
    employee_id: coerceSqlId(employee_id),
    location_id: coerceSqlId(location_id),
    warehouse_id: coerceSqlId(warehouse_id),
    product_id: coerceSqlId(product_id),
    company_id: coerceSqlId(company_id),
    company_account_id: coerceSqlId(company_account_id),
  };

  const normalizedWarehouseId = isSelfLoading ? null : resolvedIds.warehouse_id;
  if (!isSelfLoading && !normalizedWarehouseId) {
    return res.status(400).json({ error: "Warehouse could not be resolved. Please select a valid warehouse." });
  }
  if (!resolvedIds.product_id) {
    return res.status(400).json({ error: "Product could not be resolved. Please select a valid product." });
  }

  if (!isSelfLoading && !canAccessWarehouse(req.user, warehouse_id) && !canAccessWarehouse(req.user, normalizedWarehouseId)) {
    return res.status(403).json({ error: "You can only create entries for your assigned warehouse" });
  }

  const payload = {
    date,
    employee_id,
    location_id,
    warehouse_id,
    product_id,
    company_id,
    company_account_id,
    buyer_name,
    consignee_name,
    lorry_no,
    weight,
    quantity,
    rate,
    inv_no,
    self_loading,
  };

  const finalizeResponse = (source, mongoDoc, sqliteRow, extra = {}) => {
    return res.json({
      id: mongoDoc?._id ? String(mongoDoc._id) : sqliteRow?.id,
      voucher_no: mongoDoc?.outward_no || sqliteRow?.voucher_no || null,
      saved_to: source,
      ...extra,
    });
  };

  const saveSQLiteFirst = () =>
    insertSQLiteOutwardRecord(payload, resolvedIds, normalizedWarehouseId, (sqliteErr, sqliteRow) => {
      if (sqliteErr) {
        return res.status(500).json({ error: sqliteErr.message });
      }

      return finalizeResponse("sqlite", null, sqliteRow);
    });

  if (isSelfLoading) {
    return saveSQLiteFirst();
  }

  return saveSQLiteFirst();
}));

router.put("/:id", async (req, res) => {
  if (!userHasPermission(req.user, "outward.edit")) {
    return res.status(403).json({ error: "You do not have permission to edit outward entries" });
  }

  const {
    date,
    employee_id,
    location_id,
    warehouse_id,
    product_id,
    company_id,
    company_account_id,
    buyer_name,
    consignee_name,
    lorry_no,
    weight,
    quantity,
    rate,
    inv_no,
    self_loading,
  } = req.body;

  const payload = {
    date,
    employee_id,
    location_id,
    warehouse_id,
    product_id,
    company_id,
    company_account_id,
    buyer_name,
    consignee_name,
    lorry_no,
    weight,
    quantity,
    rate,
    inv_no,
    self_loading,
  };

  const qty = safeNumber(quantity) || safeNumber(weight);
  const rateVal = safeNumber(rate);
  const amount = qty * rateVal;
  const isSelfLoading = String(self_loading || "No").trim().toLowerCase() === "yes";
  const resolvedIds = {
    employee_id: coerceSqlId(employee_id),
    location_id: coerceSqlId(location_id),
    warehouse_id: coerceSqlId(warehouse_id),
    product_id: coerceSqlId(product_id),
    company_id: coerceSqlId(company_id),
    company_account_id: coerceSqlId(company_account_id),
  };

  const normalizedWarehouseId = isSelfLoading ? null : resolvedIds.warehouse_id;

  if (mongoReady() && mongoose.Types.ObjectId.isValid(req.params.id)) {
    const mongoPayload = buildMongoOutwardPayload(payload, resolvedIds, normalizedWarehouseId);

    const currentDoc = await MongoOutward.findById(req.params.id).lean();
    if (!currentDoc) {
      return res.status(404).json({ error: "Outward not found" });
    }

    const canAccessExistingWarehouse = !currentDoc.warehouse_id || canAccessWarehouse(req.user, currentDoc.warehouse_id);
    const canAccessNewWarehouse =
      isSelfLoading ||
      canAccessWarehouse(req.user, warehouse_id) ||
      canAccessWarehouse(req.user, normalizedWarehouseId);

    if (!canAccessExistingWarehouse || !canAccessNewWarehouse) {
      return res.status(403).json({ error: "You can only edit entries for your assigned warehouse" });
    }

    if (!isSelfLoading && normalizedWarehouseId) {
      const stockCheck = await new Promise((resolve, reject) => {
        validateOutwardStock(
          { warehouse_id: normalizedWarehouseId, product_id: resolvedIds.product_id, qty, outwardId: req.params.id },
          (stockErr, validation) => {
            if (stockErr) return reject(stockErr);
            return resolve(validation);
          }
        );
      }).catch((err) => ({ ok: false, error: err.message }));

      if (!stockCheck?.ok) {
        return res.status(400).json({ error: stockCheck.error || "Not enough stock in this warehouse." });
      }
    }

    const updatedDoc = await MongoOutward.findByIdAndUpdate(req.params.id, mongoPayload, { new: true }).lean();
    const mirrorVoucherNo = currentDoc.outward_no || currentDoc.voucher_no || mongoPayload.outward_no || safeText(inv_no);

    return upsertOutwardMirrorByVoucherNo(
      mirrorVoucherNo,
      payload,
      resolvedIds,
      normalizedWarehouseId,
      (mirrorErr) => {
        if (mirrorErr) {
          console.error("Mongo outward mirror sync failed:", mirrorErr.message);
          return res.status(500).json({ error: mirrorErr.message });
        }

        return res.json(buildOutwardResponse(updatedDoc, "mongodb"));
      },
      null
    );
  }

  db.get(`SELECT sl_no, voucher_no, warehouse_id FROM outward WHERE id = ?`, [req.params.id], (findErr, row) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!row) return res.status(404).json({ error: "Outward not found" });

    const canAccessExistingWarehouse = !row.warehouse_id || canAccessWarehouse(req.user, row.warehouse_id);
    const canAccessNewWarehouse =
      isSelfLoading ||
      canAccessWarehouse(req.user, warehouse_id) ||
      canAccessWarehouse(req.user, normalizedWarehouseId);

    if (!canAccessExistingWarehouse || !canAccessNewWarehouse) {
      return res.status(403).json({ error: "You can only edit entries for your assigned warehouse" });
    }

    const continueUpdate = () => {
      db.run(
        `
        UPDATE outward SET
          date=?, employee_id=?, location_id=?, warehouse_id=?,
          product_id=?, company_id=?, company_account_id=?,
          buyer_name=?, consignee_name=?,
          lorry_no=?, weight=?, quantity=?, rate=?, amount=?,
          inv_no=?, self_loading=?,
          status='Pending'
        WHERE id=?
        `,
        [
          safeText(date),
          resolvedIds.employee_id || null,
          resolvedIds.location_id || null,
          normalizedWarehouseId,
          resolvedIds.product_id || null,
          resolvedIds.company_id || null,
          resolvedIds.company_account_id || null,
          safeText(buyer_name),
          safeText(consignee_name),
          safeText(lorry_no),
          safeNumber(weight),
          qty,
          rateVal,
          amount,
          safeText(inv_no),
          safeText(self_loading) || "No",
          req.params.id,
        ],
        function onUpdate(err) {
          if (err) return res.status(500).json({ error: err.message });

          const mirrorRow = buildOutwardMirrorRowData(
            req.params.id,
            payload,
            resolvedIds,
            normalizedWarehouseId,
            {
              sl_no: row.sl_no,
              voucher_no: row.voucher_no,
              status: "Pending",
            }
          );

          syncOutwardRowToMirror(req.params.id, mirrorRow).catch((mirrorErr) => {
            console.error("Outward mirror row sync failed on update:", mirrorErr?.message || mirrorErr);
          });

          return res.json({ message: "Updated & Reset to Pending" });
        }
      );
    };

    if (isSelfLoading) {
      return continueUpdate();
    }

    return continueUpdate();
  });
});

router.delete("/:id", (req, res) => {
  if (!userHasPermission(req.user, "outward.delete")) {
    return res.status(403).json({ error: "You do not have permission to delete outward entries" });
  }

  const id = req.params.id;

  if (mongoReady() && mongoose.Types.ObjectId.isValid(id)) {
    MongoOutward.findByIdAndDelete(id)
      .lean()
      .then((deletedDoc) => {
        if (!deletedDoc) {
          return res.status(404).json({ error: "Outward not found" });
        }

        const voucherNo = deletedDoc.outward_no || deletedDoc.voucher_no || "";
        if (!voucherNo) {
          return res.json({ deleted: 1, deleted_from: "mongodb" });
        }

        return db.run(`DELETE FROM outward WHERE voucher_no=?`, [voucherNo], function (err2) {
          if (err2) return res.status(500).json({ error: err2.message });
          return res.json({ deleted: 1, deleted_from: "mongodb" });
        });
      })
      .catch((mongoErr) => res.status(500).json({ error: mongoErr.message }));
    return;
  }

  db.get(`SELECT warehouse_id FROM outward WHERE id = ?`, [id], (findErr, outwardRow) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!outwardRow) return res.status(404).json({ error: "Outward not found" });
    if (!canAccessWarehouse(req.user, outwardRow.warehouse_id)) {
      return res.status(403).json({ error: "You can only delete entries for your assigned warehouse" });
    }

    db.get(`SELECT COUNT(*) as cnt FROM adjustment WHERE outward_id=?`, [id], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });

      if (row?.cnt > 0) {
        return res.status(400).json({
          error: "Cannot delete. Adjustment exists.",
        });
      }

      db.run(`DELETE FROM outward WHERE id=?`, [id], function (err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        return res.json({ deleted: this.changes });
      });
    });
  });
});

module.exports = router;
