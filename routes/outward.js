const express = require("express");
const router = express.Router();
const db = require("../db");
const {
  mongoose,
  Outward: MongoOutward,
  mongoMirrorConfigured,
  Location: MongoLocation,
  Employee: MongoEmployee,
  Warehouse: MongoWarehouse,
  Product: MongoProduct,
  Company: MongoCompany,
  CompanyAccount: MongoCompanyAccount,
} = require("../db-mongodb");
const { userHasPermission } = require("../middleware/auth");
const { canAccessWarehouse, assignedWarehouseFilter } = require("../helpers/access");
const { resolveEntryMasterIds, resolveWarehouseIds } = require("../helpers/sqliteMasterResolver");

const safeNumber = (v) => (v === undefined || v === null || v === "" ? 0 : Number(v));
const safeText = (v) => (v ? v : null);
const formatOutwardVoucher = (slNo) => `OUT-${String(slNo).padStart(4, "0")}`;
const mongoReady = () => mongoMirrorConfigured && mongoose.connection.readyState === 1;

function normalizeId(value) {
  if (value && typeof value === "object") {
    return String(value._id || value.id || value);
  }
  return value ? String(value) : "";
}

async function buildMongoLookupMaps(docs) {
  const ids = {
    employeeIds: new Set(),
    locationIds: new Set(),
    warehouseIds: new Set(),
    productIds: new Set(),
    companyIds: new Set(),
    accountIds: new Set(),
  };

  (docs || []).forEach((row) => {
    const employeeId = normalizeId(row.employee_id);
    const locationId = normalizeId(row.location_id);
    const warehouseId = normalizeId(row.warehouse_id);
    const productId = normalizeId(row.product_id);
    const companyId = normalizeId(row.company_id);
    const accountId = normalizeId(row.company_account_id);

    if (employeeId) ids.employeeIds.add(employeeId);
    if (locationId) ids.locationIds.add(locationId);
    if (warehouseId) ids.warehouseIds.add(warehouseId);
    if (productId) ids.productIds.add(productId);
    if (companyId) ids.companyIds.add(companyId);
    if (accountId) ids.accountIds.add(accountId);
  });

  const [employees, locations, warehouses, products, companies, accounts] = await Promise.all([
    ids.employeeIds.size ? MongoEmployee.find({ _id: { $in: [...ids.employeeIds] } }).lean() : Promise.resolve([]),
    ids.locationIds.size ? MongoLocation.find({ _id: { $in: [...ids.locationIds] } }).lean() : Promise.resolve([]),
    ids.warehouseIds.size ? MongoWarehouse.find({ _id: { $in: [...ids.warehouseIds] } }).lean() : Promise.resolve([]),
    ids.productIds.size ? MongoProduct.find({ _id: { $in: [...ids.productIds] } }).lean() : Promise.resolve([]),
    ids.companyIds.size ? MongoCompany.find({ _id: { $in: [...ids.companyIds] } }).lean() : Promise.resolve([]),
    ids.accountIds.size ? MongoCompanyAccount.find({ _id: { $in: [...ids.accountIds] } }).lean() : Promise.resolve([]),
  ]);

  const byId = (rows, nameField = "name") =>
    new Map((rows || []).map((item) => [normalizeId(item._id || item.id), item?.[nameField] || item?.account_name || item?.name || ""]));

  return {
    employeeNames: byId(employees),
    locationNames: byId(locations),
    warehouseNames: byId(warehouses),
    productNames: byId(products),
    companyNames: byId(companies),
    accountNames: byId(accounts, "account_name"),
  };
}

function buildMongoOutwardPayload(reqBody, resolvedIds, normalizedWarehouseId) {
  const qty = safeNumber(reqBody.quantity) || safeNumber(reqBody.weight);
  const rateVal = safeNumber(reqBody.rate);
  return {
    date: safeText(reqBody.date) ? new Date(safeText(reqBody.date)) : null,
    location: resolvedIds.location_id ? String(resolvedIds.location_id) : safeText(reqBody.location_id),
    outward_no: safeText(reqBody.inv_no) || "",
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
        return callback(null, { id: this.lastID, voucher_no });
      }
    );
  });
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
      const lookup = await buildMongoLookupMaps(docs);
      const rows = (docs || [])
        .filter((row) => canAccessWarehouse(req.user, row.warehouse_id))
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
      return res.json(rows);
    } catch (err) {
      console.error("Mongo outward pending fetch failed, falling back to SQLite:", err.message);
    }
  }

  const rawWarehouseScope = assignedWarehouseFilter(req.user, "o.warehouse_id");
  const resolvedWarehouseIds = await resolveWarehouseIds(db, rawWarehouseScope.params).catch(() => []);
  const warehouseScope = rawWarehouseScope.clause
    ? resolvedWarehouseIds.length > 0
      ? {
          clause: ` AND o.warehouse_id IN (${resolvedWarehouseIds.map(() => "?").join(",")})`,
          params: resolvedWarehouseIds,
        }
      : { clause: " AND 1 = 0", params: [] }
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
    if (!canAccessWarehouse(req.user, row.warehouse_id)) {
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
      const lookup = await buildMongoLookupMaps(docs);
      const rows = (docs || [])
        .filter((row) => canAccessWarehouse(req.user, row.warehouse_id))
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
      return res.json(rows);
    } catch (err) {
      console.error("Mongo outward fetch failed, falling back to SQLite:", err.message);
    }
  }

  const rawWarehouseScope = assignedWarehouseFilter(req.user, "o.warehouse_id");
  const resolvedWarehouseIds = await resolveWarehouseIds(db, rawWarehouseScope.params).catch(() => []);
  const warehouseScope = rawWarehouseScope.clause
    ? resolvedWarehouseIds.length > 0
      ? {
          clause: ` AND o.warehouse_id IN (${resolvedWarehouseIds.map(() => "?").join(",")})`,
          params: resolvedWarehouseIds,
        }
      : { clause: " AND 1 = 0", params: [] }
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

router.post("/", async (req, res) => {
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
  const rateVal = safeNumber(rate);
  const amount = qty * rateVal;
  const isSelfLoading = String(self_loading || "No").trim().toLowerCase() === "yes";
  let resolvedIds;
  try {
    resolvedIds = await resolveEntryMasterIds(db, req.body);
  } catch (resolveErr) {
    return res.status(500).json({ error: resolveErr.message });
  }

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

  const saveToSQLiteCache = (mongoDoc) => {
    insertSQLiteOutwardRecord(payload, resolvedIds, normalizedWarehouseId, (sqliteErr, sqliteRow) => {
      if (sqliteErr) {
        console.error("Outward SQLite cache save failed:", sqliteErr.message);
        return;
      }
      console.log("Outward SQLite cache synced for Mongo record", mongoDoc?._id ? String(mongoDoc._id) : "");
    });
  };

  const saveToMongoFirst = () => {
    if (!mongoReady()) {
      return insertSQLiteOutwardRecord(payload, resolvedIds, normalizedWarehouseId, (sqliteErr, sqliteRow) => {
        if (sqliteErr) return res.status(500).json({ error: sqliteErr.message });
        return finalizeResponse("sqlite", null, sqliteRow);
      });
    }

    const mongoPayload = buildMongoOutwardPayload(payload, resolvedIds, normalizedWarehouseId);
    MongoOutward.create(mongoPayload)
      .then((doc) => {
        finalizeResponse("mongodb", doc, null);
        saveToSQLiteCache(doc);
      })
      .catch((mongoErr) => {
        console.error("Mongo outward save failed:", mongoErr.message);
        insertSQLiteOutwardRecord(payload, resolvedIds, normalizedWarehouseId, (sqliteErr, sqliteRow) => {
          if (sqliteErr) return res.status(500).json({ error: mongoErr.message || sqliteErr.message });
          return finalizeResponse("sqlite_fallback", null, sqliteRow, { mongo_error: mongoErr.message });
        });
      });
  };

  if (isSelfLoading) {
    return saveToMongoFirst();
  }

  validateOutwardStock({ warehouse_id: normalizedWarehouseId, product_id: resolvedIds.product_id, qty }, (stockErr, validation) => {
    if (stockErr) {
      return res.status(500).json({ error: stockErr.message });
    }
    if (!validation?.ok) {
      return res.status(400).json({ error: validation.error });
    }
    return saveToMongoFirst();
  });
});

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

  const qty = safeNumber(quantity) || safeNumber(weight);
  const rateVal = safeNumber(rate);
  const amount = qty * rateVal;
  const isSelfLoading = String(self_loading || "No").trim().toLowerCase() === "yes";
  let resolvedIds;
  try {
    resolvedIds = await resolveEntryMasterIds(db, req.body);
  } catch (resolveErr) {
    return res.status(500).json({ error: resolveErr.message });
  }

  const normalizedWarehouseId = isSelfLoading ? null : resolvedIds.warehouse_id;

  db.get(`SELECT warehouse_id FROM outward WHERE id = ?`, [req.params.id], (findErr, row) => {
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
          return res.json({ message: "Updated & Reset to Pending" });
        }
      );
    };

    if (isSelfLoading) {
      return continueUpdate();
    }

    validateOutwardStock({ warehouse_id: normalizedWarehouseId, product_id: resolvedIds.product_id, qty, outwardId: req.params.id }, (stockErr, validation) => {
      if (stockErr) {
        return res.status(500).json({ error: stockErr.message });
      }
      if (!validation?.ok) {
        return res.status(400).json({ error: validation.error });
      }
      return continueUpdate();
    });
  });
});

router.delete("/:id", (req, res) => {
  if (!userHasPermission(req.user, "outward.delete")) {
    return res.status(403).json({ error: "You do not have permission to delete outward entries" });
  }

  const id = req.params.id;

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

