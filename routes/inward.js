const express = require("express");
const router = express.Router();
const db = require("../db");
const multer = require("multer");
const XLSX = require("xlsx");
const { userHasPermission } = require("../middleware/auth");
const { canAccessWarehouse, assignedWarehouseFilter } = require("../helpers/access");
const { resolveEntryMasterIds, resolveWarehouseIds } = require("../helpers/sqliteMasterResolver");

const upload = multer({ storage: multer.memoryStorage() });

router.options("/template-xlsx", (req, res) => res.sendStatus(204));
router.options("/import-xlsx", (req, res) => {
  console.log("[inward.import] preflight", {
    origin: req.headers.origin || "",
    method: req.method,
    contentType: req.headers["content-type"] || "",
  });
  return res.sendStatus(204);
});

function buildInwardTemplateRows() {
  return [
    {
      date: "2026-07-21",
      employee_name: "Employee Name",
      location_name: "Location Name",
      warehouse_name: "Warehouse Name",
      product_name: "Product Name",
      company_name: "Company Name",
      company_account_name: "Company Account Name",
      lorry_no: "WB00A0000",
      weight: 0,
    },
  ];
}

function normalizeInwardImportRow(row) {
  const pick = (...keys) => {
    for (const key of keys) {
      if (row?.[key] !== undefined && row?.[key] !== null && String(row?.[key]).trim() !== "") {
        return row[key];
      }
    }
    return "";
  };

  return {
    date: pick("date", "Date", "DATE"),
    employee_id: pick("employee_id", "EmployeeID", "EmployeeId", "Employee ID"),
    employee_name: pick("employee_name", "EmployeeName", "Employee Name", "Employee"),
    location_id: pick("location_id", "LocationID", "LocationId", "Location ID"),
    location_name: pick("location_name", "LocationName", "Location Name", "Location"),
    warehouse_id: pick("warehouse_id", "WarehouseID", "WarehouseId", "Warehouse ID"),
    warehouse_name: pick("warehouse_name", "WarehouseName", "Warehouse Name", "Warehouse"),
    product_id: pick("product_id", "ProductID", "ProductId", "Product ID"),
    product_name: pick("product_name", "ProductName", "Product Name", "Product"),
    company_id: pick("company_id", "CompanyID", "CompanyId", "Company ID"),
    company_name: pick("company_name", "CompanyName", "Company Name", "Company"),
    company_account_id: pick("company_account_id", "CompanyAccountID", "CompanyAccountId", "Company Account ID"),
    company_account_name: pick(
      "company_account_name",
      "CompanyAccountName",
      "Company Account Name",
      "CompanyAccount",
      "Company Account",
      "Account Name",
      "Account"
    ),
    lorry_no: pick("lorry_no", "LorryNo", "Lorry No"),
    weight: pick("weight", "Weight"),
  };
}

function createLookupMaps(rows) {
  const maps = {
    employee: new Map(),
    location: new Map(),
    warehouse: new Map(),
    product: new Map(),
    company: new Map(),
    companyAccount: new Map(),
  };

  for (const row of rows || []) {
    const add = (map, key, value) => {
      const normalizedKey = String(key || "").trim().toLowerCase();
      const normalizedValue = String(value || "").trim();
      if (!normalizedKey || !normalizedValue) return;
      if (!map.has(normalizedKey)) map.set(normalizedKey, normalizedValue);
    };

    add(maps.employee, row.id, row.name);
    add(maps.employee, row.name, row.id);
    add(maps.location, row.id, row.name);
    add(maps.location, row.name, row.id);
    add(maps.warehouse, row.id, row.name);
    add(maps.warehouse, row.name, row.id);
    add(maps.product, row.id, row.name);
    add(maps.product, row.name, row.id);
    add(maps.company, row.id, row.name);
    add(maps.company, row.name, row.id);
    add(maps.companyAccount, row.id, row.account_name);
    add(maps.companyAccount, row.account_name, row.id);
  }

  return maps;
}

async function buildInwardLookupMaps(dbInstance, rows) {
  const makeSqlMap = (table, field) =>
    new Promise((resolve) => {
      dbInstance.all(
        `SELECT id, ${field} AS label FROM ${table}`,
        [],
        (err, rowsOut) => {
          if (err || !Array.isArray(rowsOut)) return resolve(new Map());
          resolve(
            new Map(
              rowsOut.map((r) => [String(r.id), String(r.label || "").trim()]).filter(([k, v]) => k && v)
            )
          );
        }
      );
    });

  const [employeeById, locationById, warehouseById, productById, companyById, companyAccountById] =
    await Promise.all([
      makeSqlMap("employees", "name"),
      makeSqlMap("locations", "name"),
      makeSqlMap("warehouses", "name"),
      makeSqlMap("products", "name"),
      makeSqlMap("companies", "name"),
      makeSqlMap("company_accounts", "account_name"),
    ]);

  const sqlMaps = createLookupMaps([
    ...Array.from(employeeById.entries()).map(([id, name]) => ({ id, name })),
    ...Array.from(locationById.entries()).map(([id, name]) => ({ id, name })),
    ...Array.from(warehouseById.entries()).map(([id, name]) => ({ id, name })),
    ...Array.from(productById.entries()).map(([id, name]) => ({ id, name })),
    ...Array.from(companyById.entries()).map(([id, name]) => ({ id, name })),
    ...Array.from(companyAccountById.entries()).map(([id, account_name]) => ({ id, account_name })),
  ]);

  return {
    employeeById,
    locationById,
    warehouseById,
    productById,
    companyById,
    companyAccountById,
    ...sqlMaps,
  };
}

function resolveIdFromLookup(row, idValue, nameValue, idMap, nameMap) {
  const directId = String(idValue || "").trim();
  if (directId && idMap.has(directId)) return directId;
  const directName = String(nameValue || "").trim().toLowerCase();
  if (directName && nameMap.has(directName)) return nameMap.get(directName);
  return null;
}

function resolveCompanyAccountId(row, lookupMaps, companyId) {
  const directAccountId = String(row?.company_account_id || "").trim();
  if (directAccountId && lookupMaps.companyAccountById.has(directAccountId)) {
    return directAccountId;
  }

  const accountName = String(row?.company_account_name || "").trim().toLowerCase();
  if (accountName && lookupMaps.companyAccount.has(accountName)) {
    return lookupMaps.companyAccount.get(accountName);
  }

  const companyName = String(row?.company_name || "").trim().toLowerCase();
  if (companyName && lookupMaps.companyByName.has(companyName)) {
    const matchedCompanyId = lookupMaps.companyByName.get(companyName);
    const accountByCompany = Array.from(lookupMaps.companyAccountById.entries()).find(([id, accountNameValue]) => {
      if (!id || !accountNameValue) return false;
      const normalizedAccount = String(accountNameValue || "").trim().toLowerCase();
      return normalizedAccount === companyName || normalizedAccount.includes(companyName);
    });
    if (accountByCompany) return accountByCompany[0];
    if (matchedCompanyId && companyId) {
      const companyNameValue = String(lookupMaps.companyById.get(String(companyId)) || "").trim().toLowerCase();
      const accountByMatchedCompany = Array.from(lookupMaps.companyAccountById.entries()).find(([, accountNameValue]) => {
        const normalizedAccount = String(accountNameValue || "").trim().toLowerCase();
        return companyNameValue && normalizedAccount && (normalizedAccount === companyNameValue || normalizedAccount.includes(companyNameValue));
      });
      if (accountByMatchedCompany) return accountByMatchedCompany[0];
    }
  }

  if (companyId) {
    const companyNameValue = String(lookupMaps.companyById.get(String(companyId)) || "").trim().toLowerCase();
    const accountByCompanyId = Array.from(lookupMaps.companyAccountById.entries()).find(([, accountNameValue]) => {
      const normalizedAccount = String(accountNameValue || "").trim().toLowerCase();
      return companyNameValue && normalizedAccount && (normalizedAccount === companyNameValue || normalizedAccount.includes(companyNameValue));
    });
    if (accountByCompanyId) return accountByCompanyId[0];
  }

  return null;
}

function buildSampleRow(row) {
  return {
    date: String(row?.date || "").trim(),
    employee_name: String(row?.employee_name || "").trim(),
    location_name: String(row?.location_name || "").trim(),
    warehouse_name: String(row?.warehouse_name || "").trim(),
    product_name: String(row?.product_name || "").trim(),
    company_name: String(row?.company_name || "").trim(),
    company_account_name: String(row?.company_account_name || "").trim(),
    lorry_no: String(row?.lorry_no || "").trim(),
    weight: String(row?.weight || "").trim(),
  };
}

async function importInwardRows(rows, res) {
  const lookupMaps = await buildInwardLookupMaps(db, rows);
  let inserted = 0;
  let skipped = 0;
  const errors = [];

  const processRow = (index) => {
    if (index >= rows.length) {
      return res.json({ total: rows.length, inserted, skipped, errors });
    }

    const row = rows[index] || {};
    const date = String(row.date || "").trim();
    const warehouseId = resolveIdFromLookup(
      row,
      row.warehouse_id,
      row.warehouse_name,
      lookupMaps.warehouseById,
      lookupMaps.warehouse
    );
    const productId = resolveIdFromLookup(
      row,
      row.product_id,
      row.product_name,
      lookupMaps.productById,
      lookupMaps.product
    );
    const companyId = resolveIdFromLookup(
      row,
      row.company_id,
      row.company_name,
      lookupMaps.companyById,
      lookupMaps.company
    );
    const companyAccountId = resolveCompanyAccountId(row, lookupMaps, companyId);
    const employeeId = resolveIdFromLookup(
      row,
      row.employee_id,
      row.employee_name,
      lookupMaps.employeeById,
      lookupMaps.employee
    );
    const locationId = resolveIdFromLookup(
      row,
      row.location_id,
      row.location_name,
      lookupMaps.locationById,
      lookupMaps.location
    );

    const missing = [];
    let resolvedCompanyAccountId = companyAccountId;
    if (!resolvedCompanyAccountId && companyId) {
      const match = Array.from(lookupMaps.companyAccountById.entries()).find(([, accountName]) => {
        const rowCompanyName = String(lookupMaps.companyById.get(String(companyId)) || "").trim().toLowerCase();
        const accountText = String(accountName || "").trim().toLowerCase();
        return rowCompanyName && accountText && accountText.includes(rowCompanyName);
      });
      if (match) {
        resolvedCompanyAccountId = match[0];
      }
    }

    if (!date) missing.push("date");
    if (!warehouseId) missing.push("warehouse");
    if (!productId) missing.push("product");
    if (!companyId) missing.push("company");
    if (!resolvedCompanyAccountId) missing.push("company account");

    if (missing.length > 0) {
      skipped += 1;
      errors.push({
        row: index + 2,
        error: `Missing or unmatched required field(s): ${missing.join(", ")}`,
        sample_row: buildSampleRow(row),
      });
      return processRow(index + 1);
    }

    const payload = {
      date,
      employee_id: employeeId,
      location_id: locationId,
      warehouse_id: warehouseId,
      product_id: productId,
      company_id: companyId,
      company_account_id: resolvedCompanyAccountId,
    };
    const weight = Number(row.weight || 0) || 0;
    const lorryNo = String(row.lorry_no || "").trim() || null;

    db.get(`SELECT COALESCE(MAX(sl_no), 0) AS max_sl FROM inward`, [], (slErr, slRow) => {
      if (slErr) {
        skipped += 1;
        errors.push({ row: index + 2, error: slErr.message, sample_row: buildSampleRow(row) });
        return processRow(index + 1);
      }

      const nextSl = Number(slRow?.max_sl || 0) + 1;
      const voucherNo = `INV${String(nextSl).padStart(3, "0")}`;

      db.run(
        `
        INSERT INTO inward (
          sl_no, voucher_no, date, employee_id, location_id, warehouse_id,
          product_id, company_id, company_account_id, lorry_no, weight, remaining_qty
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          nextSl,
          voucherNo,
          date,
          payload.employee_id,
          payload.location_id,
          payload.warehouse_id,
          payload.product_id,
          payload.company_id,
          payload.company_account_id,
          lorryNo,
          weight,
          weight,
        ],
        (insertErr) => {
          if (insertErr) {
            skipped += 1;
            errors.push({ row: index + 2, error: insertErr.message, sample_row: buildSampleRow(row) });
          } else {
            inserted += 1;
          }
          return processRow(index + 1);
        }
      );
    });
  };

  return processRow(0);
}

router.get("/template-xlsx", async (req, res) => {
  if (!userHasPermission(req.user, "inward.export")) {
    return res.status(403).json({ error: "You do not have permission to download inward template" });
  }

  const workbook = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(buildInwardTemplateRows());
  XLSX.utils.book_append_sheet(workbook, ws, "Inward Template");
  const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });

  res.setHeader("Content-Disposition", 'attachment; filename="inward-template.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  return res.send(buffer);
});

router.post("/import-xlsx", upload.single("file"), async (req, res) => {
  console.log("[inward.import] request", {
    origin: req.headers.origin || "",
    method: req.method,
    contentType: req.headers["content-type"] || "",
    hasFile: !!req.file?.buffer,
    fileName: req.file?.originalname || "",
    fileSize: req.file?.size || 0,
  });
  if (!userHasPermission(req.user, "inward.import")) {
    return res.status(403).json({ error: "You do not have permission to import inward entries" });
  }
  if (!req.file?.buffer) {
    return res.status(400).json({ error: "XLSX file is required" });
  }

  let rows = [];
  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const firstSheet = workbook.SheetNames?.[0];
    if (!firstSheet) return res.status(400).json({ error: "No sheet found in file" });
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: "" });
  } catch (err) {
    return res.status(400).json({ error: "Invalid XLSX file" });
  }

  const normalized = (Array.isArray(rows) ? rows : []).map(normalizeInwardImportRow);
  if (normalized.length === 0) {
    return res.status(400).json({ error: "No rows found in XLSX" });
  }

  return importInwardRows(normalized, res);
});

function formatVoucher(slNo) {
  return `INV${String(slNo).padStart(3, "0")}`;
}

router.get("/", async (req, res) => {
  if (!userHasPermission(req.user, "inward.view")) {
    return res.status(403).json({ error: "You do not have permission to view inward entries" });
  }

  const rawWarehouseScope = assignedWarehouseFilter(req.user, "i.warehouse_id");
  const resolvedWarehouseIds = await resolveWarehouseIds(db, rawWarehouseScope.params).catch(() => []);
  const warehouseScope = rawWarehouseScope.clause
    ? resolvedWarehouseIds.length > 0
      ? {
          clause: ` AND i.warehouse_id IN (${resolvedWarehouseIds.map(() => "?").join(",")})`,
          params: resolvedWarehouseIds,
        }
      : { clause: " AND 1 = 0", params: [] }
    : rawWarehouseScope;
  const sql = `
    SELECT i.*,
      l.name AS location_name,
      e.name AS employee_name,
      p.name AS product_name,
      w.name AS warehouse_name,
      c.name AS company_name,
      COALESCE(
        ca.account_name,
        (SELECT account_name FROM company_accounts WHERE company_id = i.company_id ORDER BY id ASC LIMIT 1)
      ) AS company_account_name
    FROM inward i
    LEFT JOIN locations l ON i.location_id = l.id
    LEFT JOIN employees e ON i.employee_id = e.id
    LEFT JOIN products p ON i.product_id = p.id
    LEFT JOIN warehouses w ON i.warehouse_id = w.id
    LEFT JOIN companies c ON i.company_id = c.id
    LEFT JOIN company_accounts ca ON i.company_account_id = ca.id
    WHERE 1=1
    ${warehouseScope.clause}
    ORDER BY i.id DESC
  `;

  db.all(sql, warehouseScope.params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    return res.json(rows);
  });
});

router.post("/", async (req, res) => {
  if (!userHasPermission(req.user, "inward.create")) {
    return res.status(403).json({ error: "You do not have permission to create inward entries" });
  }

  const {
    date,
    employee_id,
    location_id,
    warehouse_id,
    product_id,
    company_id,
    company_account_id,
    lorry_no,
    weight,
  } = req.body;

  if (!date) {
    return res.status(400).json({ error: "Date is required" });
  }

  let resolvedIds;
  try {
    resolvedIds = await resolveEntryMasterIds(db, req.body);
  } catch (resolveErr) {
    return res.status(500).json({ error: resolveErr.message });
  }

  if (!resolvedIds.company_account_id && resolvedIds.company_id) {
    const accountRow = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id FROM company_accounts WHERE company_id = ? ORDER BY id ASC LIMIT 1`,
        [resolvedIds.company_id],
        (err, row) => {
          if (err) return reject(err);
          resolve(row || null);
        }
      );
    }).catch(() => null);
    if (accountRow?.id) {
      resolvedIds.company_account_id = accountRow.id;
    }
  }

  if (!canAccessWarehouse(req.user, warehouse_id) && !canAccessWarehouse(req.user, resolvedIds.warehouse_id)) {
    return res.status(403).json({ error: "You can only create entries for your assigned warehouse" });
  }

  const w = Number(weight) || 0;

  db.get(`SELECT MAX(sl_no) as max_sl FROM inward`, [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    const nextSl = row?.max_sl ? row.max_sl + 1 : 1;
    const voucher_no = formatVoucher(nextSl);

    const sql = `
      INSERT INTO inward
      (sl_no, voucher_no, date, employee_id, location_id, warehouse_id, product_id, company_id, company_account_id, lorry_no, weight, remaining_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(
      sql,
      [
        nextSl,
        voucher_no,
        date,
        resolvedIds.employee_id || null,
        resolvedIds.location_id || null,
        resolvedIds.warehouse_id || null,
        resolvedIds.product_id || null,
        resolvedIds.company_id || null,
        resolvedIds.company_account_id || null,
        lorry_no || null,
        w,
        w,
      ],
      function onInsert(insertErr) {
        if (insertErr) {
          return res.status(500).json({ error: insertErr.message });
        }

        return res.json({
          id: this.lastID,
          sl_no: nextSl,
          voucher_no,
        });
      }
    );
  });
});

router.put("/:id", async (req, res) => {
  if (!userHasPermission(req.user, "inward.edit")) {
    return res.status(403).json({ error: "You do not have permission to edit inward entries" });
  }

  const { id } = req.params;
  const {
    date,
    employee_id,
    location_id,
    warehouse_id,
    product_id,
    company_id,
    company_account_id,
    lorry_no,
    weight,
  } = req.body;

  const w = Number(weight) || 0;
  let resolvedIds;
  try {
    resolvedIds = await resolveEntryMasterIds(db, req.body);
  } catch (resolveErr) {
    return res.status(500).json({ error: resolveErr.message });
  }

  if (!resolvedIds.company_account_id && resolvedIds.company_id) {
    const accountRow = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id FROM company_accounts WHERE company_id = ? ORDER BY id ASC LIMIT 1`,
        [resolvedIds.company_id],
        (err, row) => {
          if (err) return reject(err);
          resolve(row || null);
        }
      );
    }).catch(() => null);
    if (accountRow?.id) {
      resolvedIds.company_account_id = accountRow.id;
    }
  }

  db.get(`SELECT warehouse_id FROM inward WHERE id = ?`, [id], (findErr, inwardRow) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!inwardRow) return res.status(404).json({ error: "Inward not found" });

    if (
      !canAccessWarehouse(req.user, inwardRow.warehouse_id) ||
      (!canAccessWarehouse(req.user, warehouse_id) && !canAccessWarehouse(req.user, resolvedIds.warehouse_id))
    ) {
      return res.status(403).json({ error: "You can only edit entries for your assigned warehouse" });
    }

    const sql = `
      UPDATE inward SET
        date=?, employee_id=?, location_id=?, warehouse_id=?, product_id=?, company_id=?, company_account_id=?, lorry_no=?, weight=?, remaining_qty=?
      WHERE id=?
    `;

    db.run(
      sql,
      [
        date,
        resolvedIds.employee_id || null,
        resolvedIds.location_id || null,
        resolvedIds.warehouse_id || null,
        resolvedIds.product_id || null,
        resolvedIds.company_id || null,
        resolvedIds.company_account_id || null,
        lorry_no || null,
        w,
        w,
        id,
      ],
      function onUpdate(updateErr) {
        if (updateErr) {
          return res.status(500).json({ error: updateErr.message });
        }

        return res.json({ updated: this.changes });
      }
    );
  });
});

router.delete("/:id", (req, res) => {
  if (!userHasPermission(req.user, "inward.delete")) {
    return res.status(403).json({ error: "You do not have permission to delete inward entries" });
  }

  const { id } = req.params;
  db.get(`SELECT warehouse_id FROM inward WHERE id = ?`, [id], (findErr, inwardRow) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!inwardRow) return res.status(404).json({ error: "Inward not found" });

    if (!canAccessWarehouse(req.user, inwardRow.warehouse_id)) {
      return res.status(403).json({ error: "You can only delete entries for your assigned warehouse" });
    }

    db.run(`DELETE FROM inward WHERE id=?`, [id], function onDelete(deleteErr) {
      if (deleteErr) return res.status(500).json({ error: deleteErr.message });
      return res.json({ deleted: this.changes });
    });
  });
});

router.get("/report", (req, res) => {
  if (!userHasPermission(req.user, "reports.view") && !userHasPermission(req.user, "inward.view")) {
    return res.status(403).json({ error: "You do not have permission to view this report" });
  }

  const { company_id, warehouse_id, from_date, to_date } = req.query;
  let sql = `
    SELECT i.id, i.sl_no, i.date, i.voucher_no, i.weight,
           c.name AS company_name,
           w.name AS warehouse_name,
           e.name AS employee_name,
           p.name AS product_name,
           COALESCE(
             ca.account_name,
             (SELECT account_name FROM company_accounts WHERE company_id = i.company_id ORDER BY id ASC LIMIT 1)
           ) AS company_account_name
    FROM inward i
    LEFT JOIN companies c ON i.company_id = c.id
    LEFT JOIN warehouses w ON i.warehouse_id = w.id
    LEFT JOIN employees e ON i.employee_id = e.id
    LEFT JOIN products p ON i.product_id = p.id
    LEFT JOIN company_accounts ca ON i.company_account_id = ca.id
    WHERE 1=1
  `;

  const params = [];
  const warehouseScope = assignedWarehouseFilter(req.user, "i.warehouse_id");
  sql += warehouseScope.clause;
  params.push(...warehouseScope.params);

  if (company_id) {
    sql += " AND i.company_id = ?";
    params.push(company_id);
  }
  if (warehouse_id) {
    if (!canAccessWarehouse(req.user, warehouse_id)) {
      return res.status(403).json({ error: "You can only view your assigned warehouse data" });
    }
    sql += " AND i.warehouse_id = ?";
    params.push(warehouse_id);
  }
  if (from_date) {
    sql += " AND i.date >= ?";
    params.push(from_date);
  }
  if (to_date) {
    sql += " AND i.date <= ?";
    params.push(to_date);
  }

  sql += " ORDER BY i.date DESC";

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    return res.json(rows);
  });
});

module.exports = router;
