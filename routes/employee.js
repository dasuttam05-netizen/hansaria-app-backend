const express = require("express");
const bcrypt = require("bcryptjs");

const {
  mongoose,
  Employee,
  Location,
  Warehouse,
} = require("../mongo");

const {
  parsePermissions,
  userHasPermission,
  isAdminUser,
  normalizeRole,
} = require("../middleware/auth");

const router = express.Router();

function parseWarehouseIds(input) {

  const raw = Array.isArray(input)
    ? input
    : String(input || "").split(",");

  return Array.from(
    new Set(
      raw
        .map((item) =>
          String(item).trim()
        )
        .filter((item) => item)
    )
  );
}

function getRecordId(value) {
  if (!value) return null;
  if (value._id) return String(value._id);
  if (value.id) return String(value.id);
  return String(value);
}

function getEmployeeMobile(value) {
  return String(value?.mobile ?? value?.mobile_no ?? value?.phone ?? "").trim();
}

function getIncomingMobile(body = {}) {
  return String(body.mobile ?? body.mobile_no ?? body.phone ?? "").trim();
}

function normalizeIdArray(input) {
  return Array.isArray(input)
    ? Array.from(
        new Set(
          input
            .map((id) => String(id).trim())
            .filter(Boolean)
        )
      )
    : [];
}

function buildEmployeeResponse(employee) {
  if (!employee) return null;

  return {
    id: employee._id,
    employee_id: employee.employee_id,
    name: employee.name,
    mobile: getEmployeeMobile(employee),
    address: employee.address,
    username: employee.username,
    location_id: getRecordId(employee.location_id),
    location_ids: Array.isArray(employee.location_ids)
      ? employee.location_ids.map(getRecordId)
      : [],
    all_location_access: !!employee.all_location_access,
    role: employee.role,
    permissions: employee.permissions,
    opening_balance: employee.opening_balance,
    opening_balance_type: employee.opening_balance_type,
    assigned_warehouse_ids: parseWarehouseIds(employee.assigned_warehouse_ids),
    all_warehouse_access: !!employee.all_warehouse_access,
  };
}

// =========================
// GET ALL EMPLOYEES
// =========================
function canReadEmployees(user) {
  return [
    "employees.view",
    "employees.manage",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
    "inward.view",
    "outward.view",
    "cash.view",
    "report.erp",
  ].some((permission) => userHasPermission(user, permission));
}

router.get("/", async (req, res) => {

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.json([]);
    }

    if (!canReadEmployees(req.user)) {
      return res.status(403).json({
        error: "You do not have permission to view employees",
      });
    }

    const employees =
      await Employee.find()
        .populate("location_id")
        .sort({ created_at: -1 });

    const formatted =
      employees.map((row) => ({

        ...row.toObject(),

        id: row._id,

        location_id:
          getRecordId(row.location_id),

        location_ids:
          Array.isArray(row.location_ids)
            ? row.location_ids.map(getRecordId)
            : [],

        all_location_access:
          !!row.all_location_access,

        employee_id:
          row.employee_id || "",

        mobile:
          getEmployeeMobile(row),

        location_name:
          row.location_id?.name || "",

        permissions:
          parsePermissions(
            row.permissions,
            row.role
          ),

        assigned_warehouse_ids:
          parseWarehouseIds(
            row.assigned_warehouse_ids
          ),

        all_warehouse_access:
          !!row.all_warehouse_access,
      }));

    return res.json(formatted);

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });
  }
});


// =========================
// GET SINGLE EMPLOYEE
// =========================
router.get("/:id", async (req, res) => {

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: "Database is temporarily unavailable",
      });
    }

    if (!canReadEmployees(req.user)) {
      return res.status(403).json({
        error: "You do not have permission to view employees",
      });
    }

    const row =
      await Employee.findById(
        req.params.id
      )
        .populate("location_id");

    if (!row) {

      return res.status(404).json({
        error: "Employee not found",
      });
    }

    return res.json({

      ...row.toObject(),

      id: row._id,

      location_id:
        getRecordId(row.location_id),

      location_ids:
        Array.isArray(row.location_ids)
          ? row.location_ids.map(getRecordId)
          : [],

      all_location_access:
        !!row.all_location_access,

      employee_id:
        row.employee_id || "",

      mobile:
        getEmployeeMobile(row),

      permissions:
        parsePermissions(
          row.permissions,
          row.role
        ),

      assigned_warehouse_ids:
        parseWarehouseIds(
          row.assigned_warehouse_ids
        ),

      all_warehouse_access:
        !!row.all_warehouse_access,
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });
  }
});


// =========================
// CREATE EMPLOYEE
// =========================
router.post("/", async (req, res) => {

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: "Database is temporarily unavailable",
      });
    }

    if (!isAdminUser(req.user)) {

      return res.status(403).json({
        error:
          "Only admin can create employee users",
      });
    }

    const {
      name,
      address,
      username,
      password,
      location_id,
      location_ids,
      all_location_access,
      role,
      permissions,
      opening_balance,
      opening_balance_type,
      assigned_warehouse_ids,
      all_warehouse_access,
    } = req.body;
    const mobile = getIncomingMobile(req.body);

    if (
      !name ||
      !username ||
      !password
    ) {

      return res.status(400).json({
        error:
          "Name, username, and password are required",
      });
    }

    // PREVENT ROLE ESCALATION
    const safeRole =
      normalizeRole(
        role || "staff"
      );

    if (
      safeRole === "admin" &&
      !isAdminUser(req.user)
    ) {

      return res.status(403).json({
        error:
          "Only admin can create admin users",
      });
    }

    const existing =
      await Employee.findOne({
        username,
      });

    if (existing) {

      return res.status(400).json({
        error:
          "Username already exists",
      });
    }


    // =========================
    // GENERATE EMPLOYEE ID
    // =========================

    let employee_id = "EMP001";

    if (location_id) {

      const location =
        await Location.findById(
          location_id
        );

      if (location && location.abbr) {

        const abbr =
          String(location.abbr)
            .trim()
            .toUpperCase();

        // Count existing employees for this location
        const count =
          await Employee.countDocuments({
            location_id,
          });

        const nextSeq =
          (count + 1)
            .toString()
            .padStart(2, "0");

        employee_id =
          abbr + nextSeq;
      }
    }

    // Fallback if no location abbr
    if (
      employee_id === "EMP001"
    ) {

      const lastEmployee =
        await Employee.findOne()
          .sort({ createdAt: -1 });

      let nextNumber = 1;

      if (
        lastEmployee &&
        lastEmployee.employee_id
      ) {

        const lastNumber =
          parseInt(
            lastEmployee
              .employee_id
              .replace(/\D/g, "")
          );

        if (!isNaN(lastNumber)) {

          nextNumber =
            lastNumber + 1;
        }
      }

      employee_id =
        "EMP" +
        String(nextNumber)
          .padStart(3, "0");
    }

    const safePermissions =
      safeRole === "admin"
        ? ["all"]
        : parsePermissions(
            permissions,
            safeRole
          );

    const hash =
      await bcrypt.hash(
        password,
        10
      );

    // Parse location_ids array
    const safeLocationIds = normalizeIdArray(location_ids);

    const employee =
      await Employee.create({

        employee_id,

        name,

      mobile:
          String(mobile ?? "").trim(),

        address:
          address || "",

        username,

        password: hash,

        location_id:
          location_id || null,

        location_ids:
          safeLocationIds,

        all_location_access:
          !!all_location_access,

        role: safeRole,

        permissions:
          safePermissions,

        opening_balance:
          Number(
            opening_balance || 0
          ),

      opening_balance_type:
          String(
            opening_balance_type || "dr"
          ).toLowerCase() === "cr"
            ? "cr"
            : "dr",

        assigned_warehouse_ids:
          parseWarehouseIds(
            assigned_warehouse_ids
          ),

        all_warehouse_access:
          !!all_warehouse_access,
      });

    return res.json(buildEmployeeResponse(employee));

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });
  }
});


// =========================
// UPDATE EMPLOYEE
// =========================
router.put("/:id", async (req, res) => {

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: "Database is temporarily unavailable",
      });
    }

    const targetEmployeeId =
      req.params.id;

    const admin =
      isAdminUser(req.user);

    const canEditNonAdmin =
      userHasPermission(
        req.user,
        "employees.edit.non_admin"
      );

    if (
      !admin &&
      !canEditNonAdmin
    ) {

      return res.status(403).json({
        error:
          "You do not have permission to edit employees",
      });
    }

    const {
      name,
      address,
      username,
      password,
      location_id,
      location_ids,
      all_location_access,
      role,
      permissions,
      opening_balance,
      opening_balance_type,
      assigned_warehouse_ids,
      all_warehouse_access,
    } = req.body;
    const mobile = getIncomingMobile(req.body);

    const target =
      await Employee.findById(
        targetEmployeeId
      );

    if (!target) {

      return res.status(404).json({
        error: "Employee not found",
      });
    }

    // PREVENT ROLE ESCALATION
    const safeRole =
      normalizeRole(
        role !== undefined
          ? role
          : target.role || "staff"
      );

    // Check if trying to set admin role without being admin
    if (
      safeRole === "admin" &&
      !admin
    ) {

      return res.status(403).json({
        error:
          "Only admin can set admin role",
      });
    }

    // Check if trying to change admin's role
    const targetIsAdmin =
      target.role === "admin" ||
      (Array.isArray(target.permissions) &&
        target.permissions.includes("all"));

    if (
      targetIsAdmin &&
      !admin
    ) {

      return res.status(403).json({
        error:
          "Only admin can edit admin user",
      });
    }

    const safePermissions =
      safeRole === "admin"
        ? ["all"]
        : permissions !== undefined
          ? parsePermissions(
              permissions,
              safeRole
            )
          : parsePermissions(
              target.permissions,
              safeRole
            );

    // Parse location_ids array
    const safeLocationIds =
      normalizeIdArray(location_ids).length
        ? normalizeIdArray(location_ids)
        : Array.isArray(target.location_ids)
          ? target.location_ids.map(getRecordId).filter(Boolean)
          : [];

    const updateData = {

      name:
        name ?? target.name,

      mobile:
        String(mobile ?? target.mobile ?? target.mobile_no ?? target.phone ?? "").trim(),

      address:
        address ?? target.address ?? "",

      username:
        username ?? target.username,

      location_id:
        location_id !== undefined
          ? location_id || null
          : target.location_id || null,

      location_ids:
        safeLocationIds,

      all_location_access:
        all_location_access !== undefined
          ? !!all_location_access
          : !!target.all_location_access,

      role:
        safeRole,

      permissions:
        safePermissions,

      opening_balance:
        opening_balance !== undefined
          ? Number(
              opening_balance || 0
            )
          : Number(target.opening_balance || 0),

      opening_balance_type:
        opening_balance_type !== undefined
          ? String(
              opening_balance_type || "dr"
            ).toLowerCase() === "cr"
            ? "cr"
            : "dr"
          : String(target.opening_balance_type || "dr").toLowerCase() === "cr"
            ? "cr"
            : "dr",

      assigned_warehouse_ids:
        assigned_warehouse_ids !== undefined
          ? parseWarehouseIds(
              assigned_warehouse_ids
            )
          : parseWarehouseIds(
              target.assigned_warehouse_ids
            ),

      all_warehouse_access:
        all_warehouse_access !== undefined
          ? !!all_warehouse_access
          : !!target.all_warehouse_access,
    };

    if (password) {

      updateData.password =
        await bcrypt.hash(
          password,
          10
        );
    }

    Object.assign(target, updateData);
    await target.save();

    const refreshedEmployee = await Employee.findById(targetEmployeeId);

    return res.json({
      updated: 1,
      employee: buildEmployeeResponse(refreshedEmployee),
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });
  }
});


// =========================
// DELETE EMPLOYEE
// =========================
router.delete("/:id", async (req, res) => {

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: "Database is temporarily unavailable",
      });
    }

    if (!isAdminUser(req.user)) {

      return res.status(403).json({
        error:
          "Only admin can delete employee users",
      });
    }

    const deleted =
      await Employee.findByIdAndDelete(
        req.params.id
      );

    if (!deleted) {

      return res.status(404).json({
        error: "Employee not found",
      });
    }

    await Warehouse.updateMany(
      {
        employee_id:
          req.params.id,
      },
      {
        $set: {
          employee_id: null,
        },
      }
    );

    return res.json({
      deleted: 1,
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });
  }
});

module.exports = router;
