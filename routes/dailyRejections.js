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

// This route uses Mongo documents directly. These lightweight indexes keep
// list/assignment/reassignment lookups responsive as Daily Rejection grows.
function ensureDailyRejectionIndexes() {
  try {
    if (!mongoose.connection?.db) return;
    const collection = mongoose.connection.db.collection("daily_rejections");
    Promise.allSettled([
      collection.createIndex({ rejection_no: 1 }, { name: "daily_rejection_no" }),
      collection.createIndex({ status: 1, entry_date: -1 }, { name: "daily_rejection_status_date" }),
      collection.createIndex({ assigned_to: 1, status: 1 }, { name: "daily_rejection_assigned_status" }),
    ]).catch(() => {});
  } catch (_) {}
}
setImmediate(ensureDailyRejectionIndexes);


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

const WORK_DESCRIPTIONS = new Set(["PALTI", "WAREHOUSE UNLOAD", "LOCAL SALE", "PARTY ACCOUNT", "OTHERS", "SEND TO FACTORY"]);
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
  return String(row?.assigned_to || "") === uid;
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

  return rows.map((row) => {
    const rejectionTarget = chainNum(row?.chain_target_qty ?? row?.original_rejection_qty ?? row?.rejection_qty ?? 0);
    const rejectionProcessed = chainNum(row?.chain_processed_qty ?? row?.processed_rejection_qty ?? 0);
    const rejectionRemaining = Number.isFinite(Number(row?.chain_remaining_qty))
      ? Math.max(0, chainNum(row.chain_remaining_qty))
      : Math.max(0, rejectionTarget - rejectionProcessed);

    const otherTarget = chainNum(
      row?.chain_other_target_qty ??
      row?.other_target_qty ??
      row?.factory_other_qty ??
      0
    );
    const otherProcessed = chainNum(row?.chain_other_processed_qty ?? 0);
    const otherRemaining = Number.isFinite(Number(row?.chain_other_remaining_qty))
      ? Math.max(0, chainNum(row.chain_other_remaining_qty))
      : Math.max(0, otherTarget - otherProcessed);

    return {
      ...row,
      id: String(row._id),
      chain_target_qty: rejectionTarget,
      chain_processed_qty: rejectionProcessed,
      chain_remaining_qty: normalizeStatus(row.status) === "COMPLETE" ? 0 : rejectionRemaining,
      chain_other_target_qty: otherTarget,
      chain_other_processed_qty: otherProcessed,
      chain_other_remaining_qty: normalizeStatus(row.status) === "COMPLETE" ? 0 : otherRemaining,
      chain_total_target_qty: Number((rejectionTarget + otherTarget).toFixed(4)),
      chain_total_processed_qty: Number((rejectionProcessed + otherProcessed).toFixed(4)),
      chain_total_remaining_qty: normalizeStatus(row.status) === "COMPLETE"
        ? 0
        : Number((rejectionRemaining + otherRemaining).toFixed(4)),
      company_name: row.company_name || cm.get(idOf(row.company_id))?.name || "",
      company_account_name: row.company_account_name || am.get(idOf(row.company_account_id))?.account_name || "",
      product_name: row.product_name || pm.get(idOf(row.product_id))?.name || "",
      warehouse_name: row.warehouse_name || wm.get(idOf(row.warehouse_id))?.name || "",
      location_name: row.location_name || lm.get(idOf(row.location_id))?.name || "",
      employee_name: row.employee_name || em.get(idOf(row.employee_id))?.name || "",
      assigned_to_name: row.assigned_to_name || em.get(idOf(row.assigned_to))?.name || "",
    };
  });
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
    if (!isManager(req.user)) query.assigned_to = currentUserId(req.user);
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
      query.assigned_to = currentUserId(req.user);
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
    if (!isManager(req.user)) query.assigned_to = currentUserId(req.user);
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
      lorry_no: text(body.lorry_no),
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
      assignment_narration: "",
      chain_target_qty: rejectionQty,
      chain_processed_qty: 0,
      chain_remaining_qty: rejectionQty,
      chain_other_target_qty: num(
        body.chain_other_target_qty ??
        body.other_target_qty ??
        body.other_qty ??
        0
      ),
      chain_other_processed_qty: 0,
      chain_other_remaining_qty: num(
        body.chain_other_target_qty ??
        body.other_target_qty ??
        body.other_qty ??
        0
      ),
      chain_total_target_qty: Number((
        rejectionQty +
        num(body.chain_other_target_qty ?? body.other_target_qty ?? body.other_qty ?? 0)
      ).toFixed(4)),
      chain_total_processed_qty: 0,
      chain_total_remaining_qty: Number((
        rejectionQty +
        num(body.chain_other_target_qty ?? body.other_target_qty ?? body.other_qty ?? 0)
      ).toFixed(4)),
      chain_updated_at: null,
      latest_processed_qty: 0,
      latest_rejection_unloading_qty: 0,
      latest_rejection_adjustment_qty: 0,
      latest_other_processed_qty: 0,
      latest_other_adjustment_qty: 0,
      latest_new_rejection_qty: 0,
      latest_new_lorry_no: "",
      latest_destination_type: "",
      latest_warehouse_id: "",
      latest_warehouse_name: "",
      latest_progress_narration: "",
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
        lorry_no: text(body.lorry_no),
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


function chainNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function chainTarget(row) {
  return chainNum(
    row?.chain_target_qty ??
    row?.original_rejection_qty ??
    row?.rejection_qty ??
    row?.original_qty ??
    0
  );
}

function chainProcessed(row) {
  return chainNum(
    row?.chain_processed_qty ??
    row?.processed_rejection_qty ??
    0
  );
}

function chainRemaining(row) {
  const explicit = row?.chain_remaining_qty;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    return Math.max(0, chainNum(explicit));
  }
  return Math.max(chainTarget(row) - chainProcessed(row), 0);
}

function chainOtherTarget(row) {
  return chainNum(
    row?.chain_other_target_qty ??
    row?.other_target_qty ??
    row?.factory_other_qty ??
    0
  );
}

function chainOtherProcessed(row) {
  return chainNum(row?.chain_other_processed_qty ?? 0);
}

function chainOtherRemaining(row) {
  const explicit = row?.chain_other_remaining_qty;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    return Math.max(0, chainNum(explicit));
  }
  return Math.max(chainOtherTarget(row) - chainOtherProcessed(row), 0);
}

function chainTotalRemaining(row) {
  return Math.max(chainRemaining(row) + chainOtherRemaining(row), 0);
}

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
    history.push({
      action: "ASSIGNED_AND_STARTED",
      by: currentUserId(req.user),
      by_name: req.user?.name || req.user?.username || "",
      at: now,
      status: "RUNNING",
      assigned_to: String(employee._id),
      assigned_to_name: employee.name || "",
      action_type: actionType,
      assignment_narration: text(req.body?.assignment_narration),
    });

    const setData = {
      assigned_to: String(employee._id),
      assigned_to_name: employee.name || "",
      assigned_by: currentUserId(req.user),
      assigned_at: now,
      action_type: actionType,
      status: "RUNNING",
      started_at: now,
      started_by: currentUserId(req.user),
      updated_at: now,
      history,
      assignment_narration: text(req.body?.assignment_narration),
      chain_target_qty: chainTarget(existing),
      chain_processed_qty: chainProcessed(existing),
      chain_remaining_qty: chainRemaining(existing),
      chain_other_target_qty: Math.max(
        chainOtherTarget(existing),
        chainNum(
          req.body?.chain_other_target_qty ??
          req.body?.other_target_qty ??
          req.body?.factory_other_qty ??
          0
        )
      ),
      chain_other_processed_qty: chainOtherProcessed(existing),
      chain_other_remaining_qty: Math.max(
        0,
        Math.max(
          chainOtherTarget(existing),
          chainNum(
            req.body?.chain_other_target_qty ??
            req.body?.other_target_qty ??
            req.body?.factory_other_qty ??
            0
          )
        ) - chainOtherProcessed(existing)
      ),
      chain_total_target_qty: Number((
        chainTarget(existing) +
        Math.max(
          chainOtherTarget(existing),
          chainNum(
            req.body?.chain_other_target_qty ??
            req.body?.other_target_qty ??
            req.body?.factory_other_qty ??
            0
          )
        )
      ).toFixed(4)),
      chain_total_processed_qty: Number((
        chainProcessed(existing) + chainOtherProcessed(existing)
      ).toFixed(4)),
      chain_total_remaining_qty: Number((
        chainRemaining(existing) +
        Math.max(
          0,
          Math.max(
            chainOtherTarget(existing),
            chainNum(
              req.body?.chain_other_target_qty ??
              req.body?.other_target_qty ??
              req.body?.factory_other_qty ??
              0
            )
          ) - chainOtherProcessed(existing)
        )
      ).toFixed(4)),
      chain_updated_at: now,
    };

    history[history.length - 1].assignment_narration = text(req.body?.assignment_narration);

    // Keep the factory popup details on both the rejection row AND the
    // assignment history event so S.L.-wise history shows exactly what was
    // entered in the Send To Factory popup.
    if (actionType === "SEND TO FACTORY") {
      Object.assign(history[history.length - 1], {
        factory_date: text(req.body?.factory_date),
        factory_invoice_no: text(req.body?.factory_invoice_no),
        factory_lorry_no: text(req.body?.factory_lorry_no),
        factory_company_id: text(req.body?.factory_company_id),
        factory_company_name: text(req.body?.factory_company_name),
        factory_company_account_id: text(req.body?.factory_company_account_id),
        factory_company_account_name: text(req.body?.factory_company_account_name),
        factory_buyer_id: text(req.body?.factory_buyer_id),
        factory_buyer_name: text(req.body?.factory_buyer_name),
        factory_consignee_id: text(req.body?.factory_consignee_id),
        factory_consignee_name: text(req.body?.factory_consignee_name),
        factory_rejection_qty: Number(req.body?.factory_rejection_qty || 0),
        factory_other_qty: Number(req.body?.factory_other_qty || 0),
        factory_total_qty: Number(req.body?.factory_total_qty || 0),
        factory_weight: Number(req.body?.factory_weight ?? req.body?.factory_total_qty ?? 0),
        factory_rate: Number(req.body?.factory_rate || 0),
        factory_amount: Number(req.body?.factory_amount || 0),
      });
      Object.assign(setData, {
        factory_date: text(req.body?.factory_date),
        factory_invoice_no: text(req.body?.factory_invoice_no),
        factory_lorry_no: text(req.body?.factory_lorry_no),
        factory_company_id: text(req.body?.factory_company_id),
        factory_company_name: text(req.body?.factory_company_name),
        factory_company_account_id: text(req.body?.factory_company_account_id),
        factory_company_account_name: text(req.body?.factory_company_account_name),
        factory_buyer_id: text(req.body?.factory_buyer_id),
        factory_buyer_name: text(req.body?.factory_buyer_name),
        factory_consignee_id: text(req.body?.factory_consignee_id),
        factory_consignee_name: text(req.body?.factory_consignee_name),
        factory_rejection_qty: Number(req.body?.factory_rejection_qty || 0),
        factory_other_qty: Number(req.body?.factory_other_qty || 0),
        factory_total_qty: Number(req.body?.factory_total_qty || 0),
        factory_weight: Number(req.body?.factory_weight ?? req.body?.factory_total_qty ?? 0),
        factory_rate: Number(req.body?.factory_rate || 0),
        factory_amount: Number(req.body?.factory_amount || 0),
      });
    }

    await collection.updateOne({ _id: existing._id }, { $set: setData });
    res.json({ ok: true });
  } catch (err) {
    console.error("[daily-rejections:assign]", err);
    res.status(500).json({ error: err.message || "Failed to assign rejection" });
  }
});


router.post("/:id/progress", async (req, res) => {
  try {
    if (!requireMongo(res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid rejection id" });

    const collection = mongoose.connection.db.collection("daily_rejections");
    const existing = await collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.id) });
    if (!existing) return res.status(404).json({ error: "Daily Rejection not found" });

    const uid = currentUserId(req.user);
    if (String(existing.assigned_to || "") !== uid && !isManager(req.user)) {
      return res.status(403).json({ error: "Only the assigned employee can update this work" });
    }
    if (normalizeStatus(existing.status) !== "RUNNING") {
      return res.status(400).json({ error: "Only Running work can receive progress" });
    }

    // REJECTION and OTHER are two independent balances.
    // Rejection balance is consumed only by "Unloading Qty for Rejection".
    // Other balance is consumed only by "Other Qty".
    const rejectionProcessedQty = chainNum(
      req.body?.unloading_qty_for_rejection ??
      req.body?.rejection_unloading_qty ??
      req.body?.processed_qty ??
      0
    );
    const otherProcessedQty = chainNum(
      req.body?.other_processed_qty ??
      req.body?.other_adjustment_qty ??
      req.body?.adjusted_other_qty ??
      req.body?.other_qty ??
      0
    );
    const newRejectionQty = chainNum(req.body?.new_rejection_qty);

    if (rejectionProcessedQty <= 0 && otherProcessedQty <= 0 && newRejectionQty <= 0) {
      return res.status(400).json({
        error: "Enter Unloading Qty for Rejection or Other Qty first",
      });
    }

    const currentRejectionTarget = chainTarget(existing);
    const currentRejectionProcessed = chainProcessed(existing);
    const currentRejectionRemaining = chainRemaining(existing);

    const currentOtherTarget = chainOtherTarget(existing);
    const currentOtherProcessed = chainOtherProcessed(existing);
    const currentOtherRemaining = chainOtherRemaining(existing);

    if (rejectionProcessedQty > currentRejectionRemaining + 0.0001) {
      return res.status(400).json({
        error: `Unloading Qty for Rejection cannot exceed pending rejection balance ${currentRejectionRemaining.toFixed(2)}`,
      });
    }

    // If an older row did not have an Other target, allow the progress request
    // to establish one explicitly. This is used for flows such as:
    // Other target 10.00 -> adjust 8.50 -> pending 1.50.
    const requestedOtherTarget = chainNum(
      req.body?.chain_other_target_qty ??
      req.body?.other_target_qty ??
      existing?.other_target_qty ??
      existing?.factory_other_qty ??
      0
    );
    const nextOtherTarget = Math.max(currentOtherTarget, requestedOtherTarget);

    if (nextOtherTarget <= 0 && otherProcessedQty > 0) {
      return res.status(400).json({
        error: "Other Qty was entered but no Other target/balance is available",
      });
    }

    if (otherProcessedQty > Math.max(nextOtherTarget - currentOtherProcessed, 0) + 0.0001) {
      return res.status(400).json({
        error: `Other Qty cannot exceed pending other balance ${Math.max(nextOtherTarget - currentOtherProcessed, 0).toFixed(2)}`,
      });
    }

    const now = new Date();

    const nextRejectionTarget = Number((currentRejectionTarget + newRejectionQty).toFixed(4));
    const nextRejectionProcessed = Number((currentRejectionProcessed + rejectionProcessedQty).toFixed(4));
    const nextRejectionRemaining = Math.max(
      0,
      Number((nextRejectionTarget - nextRejectionProcessed).toFixed(4))
    );

    const nextOtherProcessed = Number((currentOtherProcessed + otherProcessedQty).toFixed(4));
    const nextOtherRemaining = Math.max(
      0,
      Number((nextOtherTarget - nextOtherProcessed).toFixed(4))
    );

    const totalRemaining = Number((
      nextRejectionRemaining + nextOtherRemaining
    ).toFixed(4));

    const complete = totalRemaining <= 0.0001;

    const rejectionAdjustmentQty = Math.max(
      0,
      Number((currentRejectionRemaining - rejectionProcessedQty).toFixed(4))
    );
    const otherAdjustmentQty = Math.max(
      0,
      Number((nextOtherTarget - nextOtherProcessed).toFixed(4))
    );

    const history = Array.isArray(existing.history) ? existing.history.slice() : [];
    history.push({
      action: complete ? "PROGRESS_COMPLETED" : "PROGRESS_SAVED_PENDING",
      by: uid,
      by_name: req.user?.name || req.user?.username || "",
      at: now,
      status: complete ? "COMPLETE" : "PENDING",
      assigned_to: String(existing.assigned_to || ""),
      assigned_to_name: String(existing.assigned_to_name || ""),
      action_type: String(existing.action_type || ""),
      assignment_narration: String(existing.assignment_narration || ""),

      unloading_qty_for_rejection: rejectionProcessedQty,
      rejection_unloading_qty: rejectionProcessedQty,
      rejection_adjustment_qty: rejectionAdjustmentQty,
      adjusted_rejection_qty: rejectionAdjustmentQty,

      other_processed_qty: otherProcessedQty,
      other_adjustment_qty: otherAdjustmentQty,
      adjusted_other_qty: otherAdjustmentQty,

      new_rejection_qty: newRejectionQty,
      new_lorry_no: text(req.body?.new_lorry_no),
      destination_type: text(req.body?.destination_type),
      warehouse_id: text(req.body?.warehouse_id),
      warehouse_name: text(req.body?.warehouse_name),
      progress_narration: text(req.body?.progress_narration),

      chain_target_qty: nextRejectionTarget,
      chain_processed_qty: nextRejectionProcessed,
      chain_remaining_qty: nextRejectionRemaining,
      chain_other_target_qty: nextOtherTarget,
      chain_other_processed_qty: nextOtherProcessed,
      chain_other_remaining_qty: nextOtherRemaining,
      chain_total_remaining_qty: totalRemaining,
    });

    const setData = {
      chain_target_qty: nextRejectionTarget,
      chain_processed_qty: nextRejectionProcessed,
      chain_remaining_qty: nextRejectionRemaining,

      chain_other_target_qty: nextOtherTarget,
      chain_other_processed_qty: nextOtherProcessed,
      chain_other_remaining_qty: nextOtherRemaining,

      chain_total_target_qty: Number((nextRejectionTarget + nextOtherTarget).toFixed(4)),
      chain_total_processed_qty: Number((nextRejectionProcessed + nextOtherProcessed).toFixed(4)),
      chain_total_remaining_qty: totalRemaining,

      chain_updated_at: now,

      latest_processed_qty: rejectionProcessedQty,
      latest_rejection_unloading_qty: rejectionProcessedQty,
      latest_rejection_adjustment_qty: rejectionAdjustmentQty,
      latest_other_processed_qty: otherProcessedQty,
      latest_other_adjustment_qty: otherAdjustmentQty,
      latest_new_rejection_qty: newRejectionQty,

      latest_new_lorry_no: text(req.body?.new_lorry_no),
      latest_destination_type: text(req.body?.destination_type),
      latest_warehouse_id: text(req.body?.warehouse_id),
      latest_warehouse_name: text(req.body?.warehouse_name),
      latest_progress_narration: text(req.body?.progress_narration),

      updated_at: now,
      history,
    };

    if (complete) {
      Object.assign(setData, {
        status: "COMPLETE",
        completion_qty: nextRejectionProcessed,
        completion_remarks: text(req.body?.progress_narration),
        completed_at: now,
        completed_by: uid,
      });
    } else {
      // IMPORTANT:
      // Any partial balance becomes PENDING and the current assignment is
      // cleared. The same Rejection No. stays open and can be reassigned by
      // an authorised user to another employee.
      Object.assign(setData, {
        status: "PENDING",
        assigned_to: null,
        assigned_to_name: "",
        assigned_by: null,
        assigned_at: null,
        started_at: null,
        started_by: null,
        completed_at: null,
        completed_by: null,
      });
    }

    await collection.updateOne(
      { _id: existing._id },
      { $set: setData }
    );

    res.json({
      ok: true,
      rejection_no: existing.rejection_no || "",
      status: complete ? "COMPLETE" : "PENDING",
      closed: complete,

      rejection_target_qty: nextRejectionTarget,
      rejection_processed_qty: nextRejectionProcessed,
      rejection_remaining_qty: nextRejectionRemaining,
      rejection_adjustment_qty: rejectionAdjustmentQty,

      other_target_qty: nextOtherTarget,
      other_processed_qty: nextOtherProcessed,
      other_remaining_qty: nextOtherRemaining,
      other_adjustment_qty: otherAdjustmentQty,

      total_target_qty: Number((nextRejectionTarget + nextOtherTarget).toFixed(4)),
      total_processed_qty: Number((nextRejectionProcessed + nextOtherProcessed).toFixed(4)),
      total_remaining_qty: totalRemaining,
    });
  } catch (err) {
    console.error("[daily-rejections:progress]", err);
    res.status(500).json({ error: err.message || "Failed to save progress" });
  }
});

router.get("/:id/history", async (req, res) => {
  try {
    if (!requireMongo(res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid rejection id" });

    const collection = mongoose.connection.db.collection("daily_rejections");
    const row = await collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.id) });
    if (!row) return res.status(404).json({ error: "Daily Rejection not found" });

    // Admin/manager can inspect all visible rejection history. A normal staff
    // member can inspect history only for work currently assigned to them.
    if (!userCanSeeRow(req.user, row)) {
      return res.status(403).json({ error: "You are not allowed to view this rejection history" });
    }

    const history = Array.isArray(row.history) ? row.history.slice().sort((a, b) => new Date(a?.at || 0) - new Date(b?.at || 0)) : [];
    const hydrated = (await hydrateRows([row]))[0] || row;
    res.json({
      ok: true,
      row: hydrated,
      history,
      count: history.length,
    });
  } catch (err) {
    console.error("[daily-rejections:history]", err);
    res.status(500).json({ error: err.message || "Failed to load rejection history" });
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
    history.push({
      action: "STARTED",
      by: uid,
      by_name: req.user?.name || req.user?.username || "",
      at: now,
      status: "RUNNING",
      assigned_to: String(existing.assigned_to || ""),
      assigned_to_name: String(existing.assigned_to_name || ""),
      action_type: String(existing.action_type || ""),
      assignment_narration: String(existing.assignment_narration || ""),
    });
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
    const managerCanComplete = isManager(req.user);
    if (!isAssignedEmployee && !managerCanComplete) return res.status(403).json({ error: "Only the assigned employee or manager can complete this work" });
    if (normalizeStatus(existing.status) !== "RUNNING") return res.status(400).json({ error: "Only Running rejection can be completed" });
    const rejectionRemainingQty = chainRemaining(existing);
    const otherRemainingQty = chainOtherRemaining(existing);
    const totalRemainingQty = chainTotalRemaining(existing);
    if (rejectionRemainingQty > 0.000001 || otherRemainingQty > 0.000001) {
      return res.status(400).json({
        error: `Work cannot be completed. Rejection Balance: ${rejectionRemainingQty.toFixed(2)}, Other Balance: ${otherRemainingQty.toFixed(2)}`
      });
    }

    const now = new Date();
    const completionQty = chainNum(existing.chain_processed_qty ?? req.body?.completion_qty ?? existing.rejection_qty);
    const history = Array.isArray(existing.history) ? existing.history : [];
    history.push({ action: "COMPLETED", by: uid, by_name: req.user?.name || req.user?.username || "", at: now, status: "COMPLETE", completion_qty: completionQty });

    await collection.updateOne(
      { _id: existing._id },
      { $set: {
          status: "COMPLETE",
          completion_qty: completionQty,
          completion_remarks: text(req.body?.completion_remarks),
          completed_at: now,
          completed_by: uid,
          chain_remaining_qty: 0,
          chain_other_remaining_qty: 0,
          chain_total_remaining_qty: 0,
          updated_at: now,
          history
        } }
    );
    res.json({
      ok: true,
      status: "COMPLETE",
      closed: true,
      rejection_remaining_qty: 0,
      other_remaining_qty: 0,
      total_remaining_qty: 0
    });
  } catch (err) {
    console.error("[daily-rejections:complete]", err);
    res.status(500).json({ error: err.message || "Failed to complete rejection" });
  }
});

module.exports = router;
