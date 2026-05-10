const express = require("express");
const bcrypt = require("bcryptjs");

const {
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

async function syncEmployeeWarehouses(
  employeeId,
  assignedWarehouseIds
) {

  const safeWarehouseIds =
    parseWarehouseIds(
      assignedWarehouseIds
    );

  await Warehouse.updateMany(
    {
      employee_id: employeeId,
    },
    {
      $set: {
        employee_id: null,
      },
    }
  );

  if (safeWarehouseIds.length === 0) {
    return;
  }

  await Warehouse.updateMany(
    {
      _id: {
        $in: safeWarehouseIds,
      },
    },
    {
      $set: {
        employee_id: employeeId,
      },
    }
  );
}


// =========================
// GET ALL EMPLOYEES
// =========================
router.get("/", async (req, res) => {

  try {

    const employees =
      await Employee.find()
        .populate("location_id")
        .sort({ created_at: -1 });

    const formatted =
      employees.map((row) => ({

        ...row.toObject(),

        id: row._id,

        employee_id:
          row.employee_id || "",

        location_name:
          row.location_id?.name || "",

        permissions:
          parsePermissions(
            row.permissions,
            row.role
          ),
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

    const row =
      await Employee.findById(
        req.params.id
      );

    if (!row) {

      return res.status(404).json({
        error: "Employee not found",
      });
    }

    return res.json({

      ...row.toObject(),

      id: row._id,

      employee_id:
        row.employee_id || "",

      permissions:
        parsePermissions(
          row.permissions,
          row.role
        ),
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
      role,
      permissions,
      opening_balance,
      opening_balance_type,
      assigned_warehouse_ids,
    } = req.body;

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
          lastEmployee.employee_id.replace(
            "EMP",
            ""
          )
        );

      nextNumber =
        lastNumber + 1;
    }

    const employee_id =
      "EMP" +
      String(nextNumber).padStart(
        3,
        "0"
      );


    const safeRole =
      normalizeRole(
        role || "staff"
      );

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

    const employee =
      await Employee.create({

        employee_id,

        name,

        address:
          address || "",

        username,

        password: hash,

        location_id:
          location_id || null,

        role: safeRole,

        permissions:
          safePermissions,

        opening_balance:
          Number(
            opening_balance || 0
          ),

        opening_balance_type:
          String(
            opening_balance || "dr"
          ).toLowerCase() === "cr"
            ? "cr"
            : "dr",
      });

    await syncEmployeeWarehouses(
      employee._id,
      assigned_warehouse_ids
    );

    return res.json({

      id: employee._id,

      employee_id:
        employee.employee_id,

      name: employee.name,

      address:
        employee.address,

      username:
        employee.username,

      location_id:
        employee.location_id,

      role:
        employee.role,

      permissions:
        employee.permissions,

      opening_balance:
        employee.opening_balance,

      opening_balance_type:
        employee.opening_balance_type,

      assigned_warehouse_ids:
        parseWarehouseIds(
          assigned_warehouse_ids
        ),
    });

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
      role,
      permissions,
      opening_balance,
      opening_balance_type,
      assigned_warehouse_ids,
    } = req.body;

    const target =
      await Employee.findById(
        targetEmployeeId
      );

    if (!target) {

      return res.status(404).json({
        error: "Employee not found",
      });
    }

    const safeRole =
      normalizeRole(
        role ||
          target.role ||
          "staff"
      );

    const safePermissions =
      safeRole === "admin"
        ? ["all"]
        : parsePermissions(
            permissions,
            safeRole
          );

    const updateData = {

      name,

      address:
        address || "",

      username,

      location_id:
        location_id || null,

      role:
        safeRole,

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
    };

    if (password) {

      updateData.password =
        await bcrypt.hash(
          password,
          10
        );
    }

    await Employee.findByIdAndUpdate(
      targetEmployeeId,
      updateData
    );

    await syncEmployeeWarehouses(
      targetEmployeeId,
      assigned_warehouse_ids
    );

    return res.json({
      updated: 1,
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