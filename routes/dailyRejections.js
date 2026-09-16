const express = require("express");
const mongoose = require("mongoose");

const {
  isMongoMirrorReady,
  Employee,
  Location,
  Warehouse,
  Company,
  CompanyAccount,
  Product,
  ConsigneeName,
  Inward,
  Outward,
} = require("../db-mongodb");

const {
  userHasPermission,
  isAdminUser,
} = require("../middleware/auth");

const { canAccessWarehouse } = require("../helpers/access");

const router = express.Router();

const VIEW = "dailyRejection.view";
const CREATE = "dailyRejection.create";
const ASSIGN = "dailyRejection.assign";
const START = "dailyRejection.start";
const COMPLETE = "dailyRejection.complete";
const REPORT = "dailyRejection.report";
const EDIT = "dailyRejection.edit";

const MANAGER_ROLES = new Set(["admin", "bm", "ho"]);

function text(value) {
  return String(value ?? "").trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const WORK_DESCRIPTIONS = new Set(["PALTI", "WAREHOUSE UNLOAD", "LOCAL SALE", "PARTY ACCOUNT", "OTHERS"]);
const REASONS = new Set(["HIGH FUNGUS", "HIGH MOISTURE", "DISCOLOUR", "DAMAGE", "LIVE INSECT", "WATER DAMAGE", "OTHERS"]);

function normalizeStatus(value) {
  const raw = text(value).toUpperCase();
  if (["PENDING", "ASSIGNED", "RUNNING", "COMPLETE"].includes(raw)) return raw;
  return "PENDING";
}

function idOf(value) {
  if (!value) return "";
  if (value._id) return String(value._id);
  if (value.id) return String(value.id);
  return String(value);
}

function objectIdOrValue(value) {
  const raw = text(value);
  return mongoose.isValidObjectId(raw) ? new mongoose.Types.ObjectId(raw) : raw;
}

function currentUserId(user) {
  return text(user?.id || user?._id || "");
}

function isManager(user) {
  return (
    isAdminUser(user) ||
    MANAGER_ROLES.has(text(user?.role).toLowerCase()) ||
    userHasPermission(user, ASSIGN) ||
    userHasPermission(user, REPORT)
  );
}

function requireMongo(res) {
  if (!isMongoMirrorReady() || mongoose.connection.readyState !== 1) {
    res.status(503).json({ error: "MongoDB is not connected. Please try again in a moment." });
    return false;
  }
  return true;
}

function assertPermission(user, permission, res) {
  if (userHasPermission(user, permission)) return true;
  res.status(403).json({ error: "Permission denied" });
  return false;
}

function allowedWarehouseIds(user) {
  const ids = Array.isArray(user?.assigned_warehouse_ids)
    ? user.assigned_warehouse_ids.map((id) => String(id)).filter(Boolean)
    : [];
  return Array.from(new Set(ids));
}

function allowedLocationIds(user) {
  const ids = Array.isArray(user?.location_ids)
    ? user.location_ids.map((id) => String(id)).filter(Boolean)
    : [];
  if (user?.location_id) ids.push(String(user.location_id));
  return Array.from(new Set(ids));
}

function userCanSeeRow(user, row) {
  if (isManager(user)) {
    if (user?.all_location_access || userHasPermission(user, "locations.manage")) return true;
    const locations = allowedLocationIds(user);
    if (locations.length && row?.location_id && locations.includes(String(row.location_id))) return true;
    const warehouses = allowedWarehouseIds(user);
    if (warehouses.length && row?.warehouse_id && warehouses.includes(String(row.warehouse_id))) return true;
    return false;
  }

  const uid = currentUserId(user);
  return String(row?.employee_id || "") === uid || String(row?.assigned_to || "") === uid;
}

async function generateRejectionNo(dateValue) {
  const year = new Date(dateValue || Date.now()).getFullYear();
  const counter = mongoose.connection.db.collection("daily_rejection_counters");
  const result = await counter.findOneAndUpdate(
    { year },
    { $inc: { seq: 1 }, $set: { updated_at: new Date() } },
    { upsert: true, returnDocument: "after" }
  );
  return `REJ-${year}-${String(result.value?.seq || result.seq || 1).padStart(5, "0")}`;
}

async function hydrateRows(rows) {
  const companyIds = Array.from(new Set(rows.map((r) => idOf(r.company_id)).filter((v) => mongoose.isValidObjectId(v))));
  const accountIds = Array.from(new Set(rows.map((r) => idOf(r.company_account_id)).filter((v) => mongoose.isValidObjectId(v))));
  const productIds = Array.from(new Set(rows.map((r) => idOf(r.product_id)).filter((v) => mongoose.isValidObjectId(v))));
  const warehouseIds = Array.from(new Set(rows.map((r) => idOf(r.warehouse_id)).filter((v) => mongoose.isValidObjectId(v))));
  const locationIds = Array.from(new Set(rows.map((r) => idOf(r.location_id)).filter((v) => mongoose.isValidObjectId(v))));
  const employeeIds = Array.from(new Set(rows.flatMap((r) => [idOf(r.employee_id), idOf(r.assigned_to)]).filter((v) => mongoose.isValidObjectId(v))));

  const [companies, accounts, products, warehouses, locations, employees] = await Promise.all([
    Company.find(companyIds.length ? { _id: { $in: companyIds } } : { _id: { $in: [] } }, { name: 1 }).lean(),
    CompanyAccount.find(accountIds.length ? { _id: { $in: accountIds } } : { _id: { $in: [] } }, { account_name: 1, name: 1, company_id: 1, company_name: 1 }).lean(),
    Product.find(productIds.length ? { _id: { $in: productIds } } : { _id: { $in: [] } }, { name: 1 }).lean(),
    Warehouse.find(warehouseIds.length ? { _id: { $in: warehouseIds } } : { _id: { $in: [] } }, { name: 1 }).lean(),
    Location.find(locationIds.length ? { _id: { $in: locationIds } } : { _id: { $in: [] } }, { name: 1 }).lean(),
    Employee.find(employeeIds.length ? { _id: { $in: employeeIds } } : { _id: { $in: [] } }, { name: 1, employee_id: 1 }).lean(),
  ]);

  const map = (items) => new Map(items.map((x) => [String(x._id), x]));
  const cm = map(companies), am = map(accounts), pm = map(products), wm = map(warehouses), lm = map(locations), em = map(employees);

  return rows.map((row) => ({
    ...row,
    id: String(row._id),
    company_name: row.company_name || cm.get(idOf(row.company_id))?.name || "",
    company_account_name: row.company_account_name || am.get(idOf(row.company_account_id))?.account_name || "",
    product_name: row.product_name || pm.get(idOf(row.product_id))?.name || "",
    warehouse_name: row.warehouse_name || wm.get(idOf(row.warehouse_id))?.name || "",
    location_name: row.location_name || lm.get(idOf(row.location_id))?.name || "",
    employee_name: row.employee_name || em.get(idOf(row.employee_id))?.name || "",
    assigned_to_name: row.assigned_to_name || em.get(idOf(row.assigned_to))?.name || "",
  }));
}

router.get("/masters", async (req, res) => {
  try {
    if (!assertPermission(req.user, VIEW, res)) return;
    if (!requireMongo(res)) return;

    const manager = isManager(req.user);
    const warehouseQuery = manager && (req.user?.all_warehouse_access || userHasPermission(req.user, "warehouses.manage"))
      ? {}
      : { _id: { $in: allowedWarehouseIds(req.user).filter((id) => mongoose.isValidObjectId(id)) } };
    const locationQuery = manager && (req.user?.all_location_access || userHasPermission(req.user, "locations.manage"))
      ? {}
      : { _id: { $in: allowedLocationIds(req.user).filter((id) => mongoose.isValidObjectId(id)) } };

    const [locations, warehouses, companies, accounts, products, employees, consignees] = await Promise.all([
      Location.find(locationQuery, { name: 1, address: 1 }).sort({ name: 1 }).lean(),
      Warehouse.find(warehouseQuery, { name: 1, location_id: 1 }).sort({ name: 1 }).lean(),
      Company.find({}, { name: 1 }).sort({ name: 1 }).lean(),
      CompanyAccount.find({}, { account_name: 1, company_id: 1 }).sort({ account_name: 1 }).lean(),
      Product.find({}, { name: 1 }).sort({ name: 1 }).lean(),
      manager ? Employee.find({}, { name: 1, employee_id: 1, role: 1, location_id: 1, location_ids: 1, assigned_warehouse_ids: 1 }).sort({ name: 1 }).lean() : Employee.find({ _id: objectIdOrValue(currentUserId(req.user)) }, { name: 1, employee_id: 1 }).lean(),
      ConsigneeName.find({}, { name: 1, consignee_name: 1, buyer_name: 1 }).sort({ name: 1, consignee_name: 1 }).lean().catch(() => []),
    ]);

    res.json({
      locations: locations.map((x) => ({ ...x, id: String(x._id) })),
      warehouses: warehouses.map((x) => ({ ...x, id: String(x._id) })),
      companies: companies.map((x) => ({ ...x, id: String(x._id) })),
      accounts: accounts.map((x) => ({ ...x, id: String(x._id), company_id: idOf(x.company_id), company_name: x.company_name || x.company?.name || "", account_name: x.account_name || x.name || "" })),
      products: products.map((x) => ({ ...x, id: String(x._id) })),
      employees: employees.map((x) => ({ ...x, id: String(x._id), employee_id: x.employee_id || "" })),
      consignees: consignees.map((x) => ({ ...x, id: String(x._id), name: x.name || x.consignee_name || x.buyer_name || "" })),
    });
  } catch (err) {
    console.error("[daily-rejections:masters]", err);
    res.status(500).json({ error: err.message || "Failed to load Daily Rejection masters" });
  }
});

router.get("/summary", async (req, res) => {
  try {
    if (!assertPermission(req.user, VIEW, res)) return;
    if (!requireMongo(res)) return;
    const collection = mongoose.connection.db.collection("daily_rejections");
    const query = {};
    const from = text(req.query.from);
    const to = text(req.query.to);
    if (from || to) {
      query.entry_date = {};
      if (from) query.entry_date.$gte = new Date(`${from}T00:00:00`);
      if (to) query.entry_date.$lte = new Date(`${to}T23:59:59.999`);
    }
    if (!isManager(req.user)) query.$or = [{ employee_id: currentUserId(req.user) }, { assigned_to: currentUserId(req.user) }];
    const rows = await collection.find(query).project({ status: 1 }).toArray();
    const summary = { total: rows.length, pending: 0, assigned: 0, running: 0, complete: 0 };
    rows.forEach((r) => { const s = normalizeStatus(r.status).toLowerCase(); if (summary[s] !== undefined) summary[s] += 1; });
    res.json(summary);
  } catch (err) {
    console.error("[daily-rejections:summary]", err);
    res.status(500).json({ error: err.message || "Failed to load summary" });
  }
});

router.get("/", async (req, res) => {
  try {
    if (!assertPermission(req.user, VIEW, res)) return;
    if (!requireMongo(res)) return;

    const collection = mongoose.connection.db.collection("daily_rejections");
    const query = {};
    const status = normalizeStatus(req.query.status || "ALL");
    const from = text(req.query.from);
    const to = text(req.query.to);
    const employeeId = text(req.query.employee_id);
    const locationId = text(req.query.location_id);
    const warehouseId = text(req.query.warehouse_id);
    const companyId = text(req.query.company_id);
    const actionType = text(req.query.action_type).toUpperCase();

    if (status !== "PENDING" && status !== "ASSIGNED" && status !== "RUNNING" && status !== "COMPLETE") {
      delete query.status;
    } else {
      query.status = status;
    }
    if (from || to) {
      query.entry_date = {};
      if (from) query.entry_date.$gte = new Date(`${from}T00:00:00`);
      if (to) query.entry_date.$lte = new Date(`${to}T23:59:59.999`);
    }
    if (employeeId) query.employee_id = employeeId;
    if (locationId) query.location_id = locationId;
    if (warehouseId) query.warehouse_id = warehouseId;
    if (companyId) query.company_id = companyId;
    if (actionType && WORK_DESCRIPTIONS.has(actionType)) query.action_type = actionType;

    if (!isManager(req.user)) {
      query.$or = [{ employee_id: currentUserId(req.user) }, { assigned_to: currentUserId(req.user) }];
    }

    const rows = await collection.find(query).sort({ entry_date: -1, created_at: -1 }).limit(2000).toArray();
    const visible = rows.filter((row) => userCanSeeRow(req.user, row));
    res.json(await hydrateRows(visible));
  } catch (err) {
    console.error("[daily-rejections:list]", err);
    res.status(500).json({ error: err.message || "Failed to load Daily Rejections" });
  }
});

router.get("/report", async (req, res) => {
  try {
    if (!userHasPermission(req.user, REPORT) && !isAdminUser(req.user)) {
      return res.status(403).json({ error: "Permission denied" });
    }
    if (!requireMongo(res)) return;
    const from = text(req.query.from);
    const to = text(req.query.to);
    const actionType = text(req.query.action_type).toUpperCase();
    const query = {};
    if (from || to) {
      query.entry_date = {};
      if (from) query.entry_date.$gte = new Date(`${from}T00:00:00`);
      if (to) query.entry_date.$lte = new Date(`${to}T23:59:59.999`);
    }
    if (actionType && actionType !== "ALL") query.action_type = actionType;
    if (!isManager(req.user)) query.$or = [{ employee_id: currentUserId(req.user) }, { assigned_to: currentUserId(req.user) }];
    const rows = await mongoose.connection.db.collection("daily_rejections").find(query).sort({ entry_date: -1, created_at: -1 }).limit(5000).toArray();
    res.json({ rows: await hydrateRows(rows), count: rows.length });
  } catch (err) {
    console.error("[daily-rejections:report]", err);
    res.status(500).json({ error: err.message || "Failed to load Daily Rejection report" });
  }
});

router.post("/", async (req, res) => {
  try {
    if (!assertPermission(req.user, CREATE, res)) return;
    if (!requireMongo(res)) return;

    const body = req.body || {};
    const entryDate = body.entry_date ? new Date(body.entry_date) : new Date();
    if (Number.isNaN(entryDate.getTime())) return res.status(400).json({ error: "Invalid entry date" });

    const locationId = text(body.location_id || req.user?.location_id);
    const employeeId = text(body.employee_id || currentUserId(req.user));
    const originalQty = num(body.original_qty);
    const actualUnloadingQty = num(body.actual_unloading_qty);
    const rejectionQty = Math.max(originalQty - actualUnloadingQty, 0);
    const reason = text(body.reason).toUpperCase();
    const consigneeId = text(body.consignee_id);
    const consignee = text(body.consignee || body.consignee_name);

    if (!locationId || !text(body.product_id) || !consigneeId || !reason || !REASONS.has(reason) || !Number.isFinite(originalQty) || !Number.isFinite(actualUnloadingQty) || actualUnloadingQty < 0 || rejectionQty <= 0) {
      return res.status(400).json({ error: "Location, Product, Consignee, Reason, Original Qty and Actual Unloading Qty are required; rejection must be positive" });
    }
    if (actualUnloadingQty > originalQty) {
      return res.status(400).json({ error: "Actual unloading quantity cannot exceed original quantity" });
    }
    const [location, employee, company, account, product, consigneeDoc] = await Promise.all([
      Location.findById(objectIdOrValue(locationId), { name: 1 }).lean().catch(() => null),
      Employee.findOne({ $or: [{ _id: objectIdOrValue(employeeId) }, { employee_id: employeeId }] }, { name: 1 }).lean().catch(() => null),
      text(body.company_id) ? Company.findById(objectIdOrValue(body.company_id), { name: 1 }).lean().catch(() => null) : null,
      text(body.company_account_id) ? CompanyAccount.findById(objectIdOrValue(body.company_account_id), { account_name: 1 }).lean().catch(() => null) : null,
      Product.findById(objectIdOrValue(body.product_id), { name: 1 }).lean().catch(() => null),
      ConsigneeName.findById(objectIdOrValue(consigneeId), { name: 1, consignee_name: 1, buyer_name: 1 }).lean().catch(() => null),
    ]);

    const rejectionNo = await generateRejectionNo(entryDate);
    const doc = {
      rejection_no: rejectionNo,
      entry_date: entryDate,
      employee_id: employee ? String(employee._id) : employeeId,
      employee_name: employee?.name || text(body.employee_name),
      location_id: locationId,
      location_name: location?.name || text(body.location_name),
      company_id: text(body.company_id) || null,
      company_name: company?.name || text(body.company_name),
      company_account_id: text(body.company_account_id) || null,
      company_account_name: account?.account_name || text(body.company_account_name),
      product_id: text(body.product_id),
      product_name: product?.name || text(body.product_name),
      consignee_id: consigneeId,
      consignee: consigneeDoc?.name || consigneeDoc?.consignee_name || consigneeDoc?.buyer_name || consignee,
      consignee_name: consigneeDoc?.name || consigneeDoc?.consignee_name || consigneeDoc?.buyer_name || consignee,
      original_qty: originalQty,
      actual_unloading_qty: actualUnloadingQty,
      rejection_qty: rejectionQty,
      reason,
      remarks: text(body.remarks),
      action_type: "",
      assigned_to: null,
      assigned_to_name: "",
      assigned_by: null,
      assigned_at: null,
      started_at: null,
      started_by: null,
      completed_at: null,
      completed_by: null,
      completion_qty: 0,
      completion_remarks: "",
      status: "PENDING",
      history: [{ action: "CREATED", by: currentUserId(req.user), by_name: req.user?.name || req.user?.username || "", at: new Date(), status: "PENDING" }],
      created_at: new Date(),
      updated_at: new Date(),
    };

    const result = await mongoose.connection.db.collection("daily_rejections").insertOne(doc);
    res.status(201).json({ ...doc, id: String(result.insertedId), _id: result.insertedId });
  } catch (err) {
    console.error("[daily-rejections:create]", err);
    res.status(500).json({ error: err.message || "Failed to create Daily Rejection" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    if (!userHasPermission(req.user, EDIT) && !isAdminUser(req.user)) {
      return res.status(403).json({ error: "Permission denied" });
    }
    if (!requireMongo(res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid rejection id" });

    const collection = mongoose.connection.db.collection("daily_rejections");
    const existing = await collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.id) });
    if (!existing) return res.status(404).json({ error: "Daily Rejection not found" });
    if (normalizeStatus(existing.status) === "COMPLETE") return res.status(400).json({ error: "Completed rejection cannot be edited" });

    const body = req.body || {};
    const entryDate = body.entry_date ? new Date(body.entry_date) : existing.entry_date;
    const originalQty = num(body.original_qty);
    const actualUnloadingQty = num(body.actual_unloading_qty);
    const rejectionQty = Math.max(originalQty - actualUnloadingQty, 0);
    const reason = text(body.reason).toUpperCase();
    const consigneeId = text(body.consignee_id);
    if (Number.isNaN(entryDate?.getTime?.()) || !text(body.location_id) || !text(body.product_id) || !consigneeId || !REASONS.has(reason) || originalQty <= 0 || actualUnloadingQty < 0 || actualUnloadingQty > originalQty || rejectionQty <= 0) {
      return res.status(400).json({ error: "Location, Product, Consignee, Reason and valid quantities are required" });
    }

    const [location, company, account, product, consigneeDoc] = await Promise.all([
      Location.findById(objectIdOrValue(body.location_id), { name: 1 }).lean().catch(() => null),
      text(body.company_id) ? Company.findById(objectIdOrValue(body.company_id), { name: 1 }).lean().catch(() => null) : null,
      text(body.company_account_id) ? CompanyAccount.findById(objectIdOrValue(body.company_account_id), { account_name: 1, name: 1 }).lean().catch(() => null) : null,
      Product.findById(objectIdOrValue(body.product_id), { name: 1 }).lean().catch(() => null),
      ConsigneeName.findById(objectIdOrValue(consigneeId), { name: 1, consignee_name: 1, buyer_name: 1 }).lean().catch(() => null),
    ]);

    const history = Array.isArray(existing.history) ? existing.history : [];
    history.push({ action: "EDITED", by: currentUserId(req.user), by_name: req.user?.name || req.user?.username || "", at: new Date(), status: normalizeStatus(existing.status) });

    await collection.updateOne(
      { _id: existing._id },
      { $set: {
        entry_date: entryDate,
        location_id: text(body.location_id),
        location_name: location?.name || text(body.location_name),
        company_id: text(body.company_id) || null,
        company_name: company?.name || text(body.company_name),
        company_account_id: text(body.company_account_id) || null,
        company_account_name: account?.account_name || account?.name || text(body.company_account_name),
        product_id: text(body.product_id),
        product_name: product?.name || text(body.product_name),
        consignee_id: consigneeId,
        consignee: consigneeDoc?.name || consigneeDoc?.consignee_name || consigneeDoc?.buyer_name || text(body.consignee_name),
        consignee_name: consigneeDoc?.name || consigneeDoc?.consignee_name || consigneeDoc?.buyer_name || text(body.consignee_name),
        original_qty: originalQty,
        actual_unloading_qty: actualUnloadingQty,
        rejection_qty: rejectionQty,
        reason,
        remarks: text(body.remarks),
        updated_at: new Date(),
        history,
      } }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[daily-rejections:edit]", err);
    res.status(500).json({ error: err.message || "Failed to edit Daily Rejection" });
  }
});

router.patch("/:id/assign", async (req, res) => {
  try {
    if (!assertPermission(req.user, ASSIGN, res)) return;
    if (!requireMongo(res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid rejection id" });

    const assignedTo = text(req.body?.assigned_to);
    const actionType = text(req.body?.action_type).toUpperCase();
    if (!assignedTo) return res.status(400).json({ error: "Employee is required" });
    if (!actionType || !WORK_DESCRIPTIONS.has(actionType)) return res.status(400).json({ error: "Work Description is required" });

    const employee = await Employee.findById(objectIdOrValue(assignedTo), { name: 1 }).lean();
    if (!employee) return res.status(404).json({ error: "Assigned employee not found" });

    const collection = mongoose.connection.db.collection("daily_rejections");
    const existing = await collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.id) });
    if (!existing) return res.status(404).json({ error: "Daily Rejection not found" });

    const now = new Date();
    const history = Array.isArray(existing.history) ? existing.history : [];
    history.push({ action: "ASSIGNED_AND_STARTED", by: currentUserId(req.user), by_name: req.user?.name || req.user?.username || "", at: now, status: "RUNNING", assigned_to: String(employee._id), action_type: actionType });

    await collection.updateOne(
      { _id: existing._id },
      { $set: { assigned_to: String(employee._id), assigned_to_name: employee.name || "", assigned_by: currentUserId(req.user), assigned_at: now, action_type: actionType, status: "RUNNING", started_at: now, started_by: currentUserId(req.user), updated_at: now, history } }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[daily-rejections:assign]", err);
    res.status(500).json({ error: err.message || "Failed to assign rejection" });
  }
});

router.post("/:id/start", async (req, res) => {
  try {
    if (!assertPermission(req.user, START, res)) return;
    if (!requireMongo(res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid rejection id" });
    const collection = mongoose.connection.db.collection("daily_rejections");
    const existing = await collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.id) });
    if (!existing) return res.status(404).json({ error: "Daily Rejection not found" });
    const uid = currentUserId(req.user);
    if (String(existing.assigned_to || "") !== uid) return res.status(403).json({ error: "Only the assigned employee can complete this work" });
    if (!["ASSIGNED", "PENDING"].includes(normalizeStatus(existing.status))) return res.status(400).json({ error: "Only Pending or Assigned rejection can be started" });
    const now = new Date();
    const history = Array.isArray(existing.history) ? existing.history : [];
    history.push({ action: "STARTED", by: uid, by_name: req.user?.name || req.user?.username || "", at: now, status: "RUNNING" });
    await collection.updateOne({ _id: existing._id }, { $set: { status: "RUNNING", started_at: now, started_by: uid, updated_at: now, history } });
    res.json({ ok: true });
  } catch (err) {
    console.error("[daily-rejections:start]", err);
    res.status(500).json({ error: err.message || "Failed to start rejection" });
  }
});

router.post("/:id/complete", async (req, res) => {
  try {
    if (!requireMongo(res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid rejection id" });
    const collection = mongoose.connection.db.collection("daily_rejections");
    const existing = await collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.id) });
    if (!existing) return res.status(404).json({ error: "Daily Rejection not found" });
    const uid = currentUserId(req.user);
    const isAssignedEmployee = String(existing.assigned_to || "") === uid;
    if (!isAssignedEmployee && !userHasPermission(req.user, COMPLETE)) return res.status(403).json({ error: "Only the assigned employee or authorised user can complete this work" });
    if (normalizeStatus(existing.status) !== "RUNNING") return res.status(400).json({ error: "Only Running rejection can be completed" });

    const now = new Date();
    const completionQty = num(req.body?.completion_qty || existing.rejection_qty);
    const history = Array.isArray(existing.history) ? existing.history : [];
    history.push({ action: "COMPLETED", by: uid, by_name: req.user?.name || req.user?.username || "", at: now, status: "COMPLETE", completion_qty: completionQty });

    await collection.updateOne(
      { _id: existing._id },
      { $set: { status: "COMPLETE", completion_qty: completionQty, completion_remarks: text(req.body?.completion_remarks), completed_at: now, completed_by: uid, updated_at: now, history } }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[daily-rejections:complete]", err);
    res.status(500).json({ error: err.message || "Failed to complete rejection" });
  }
});

module.exports = router;
