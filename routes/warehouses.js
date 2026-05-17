const express = require("express");

const router = express.Router();

const {
  Warehouse,
  Employee,
} = require("../mongo");

const {
  userHasPermission,
  isAdminUser,
} = require("../middleware/auth");

function parseEmployeeIds(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || "").split(",");

  return Array.from(
    new Set(
      raw
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
}

function normalizeId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value._id) return String(value._id);
  if (value.id) return String(value.id);
  return String(value);
}

function normalizeIdArray(input) {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => normalizeId(item))
        .filter(Boolean)
    )
  );
}

async function syncWarehouseEmployeeAssignments(warehouseId, employeeIds = []) {
  const warehouseIdStr = String(warehouseId || "");
  const safeEmployeeIds = Array.from(
    new Set(
      (Array.isArray(employeeIds) ? employeeIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )
  );

  // Remove this warehouse from all employees first, then add to selected employees.
  await Employee.updateMany(
    {},
    { $pull: { assigned_warehouse_ids: warehouseIdStr } }
  );

  if (!safeEmployeeIds.length) return;

  await Employee.updateMany(
    { _id: { $in: safeEmployeeIds } },
    { $addToSet: { assigned_warehouse_ids: warehouseIdStr } }
  );
}

router.get("/", async (req, res) => {

  try {

    const assignedIds =
      req.user?.assigned_warehouse_ids || [];

    const restrictToAssigned =
      req.user &&
      req.user.role !== "admin" &&
      !userHasPermission(
        req.user,
        "warehouses.manage"
      ) &&
      !userHasPermission(
        req.user,
        "report.partyStock"
      ) &&
      !userHasPermission(
        req.user,
        "report.partyLedger"
      ) &&
      !userHasPermission(
        req.user,
        "report.warehouseRentLedger"
      ) &&
      !userHasPermission(
        req.user,
        "report.warehouseRentMonthEnd"
      ) &&
      assignedIds.length > 0;

    const filter =
      restrictToAssigned
        ? {
            _id: {
              $in: assignedIds,
            },
          }
        : {};

    const rows =
      await Warehouse.find(filter)

        .populate(
          "location_id",
          "name"
        )

        .populate(
          "employee_id",
          "name"
        )

        .sort({
          created_at: -1,
        });

    const allEmployeeIds =
      Array.from(
        new Set(
          rows.flatMap((row) =>
            normalizeIdArray(row.employee_ids)
          )
        )
      );

    const employeeNameMap =
      new Map();

    if (allEmployeeIds.length) {
      const employeeRows =
        await Employee.find(
          { _id: { $in: allEmployeeIds } },
          { name: 1 }
        );
      employeeRows.forEach((emp) => {
        employeeNameMap.set(String(emp._id), emp.name || "");
      });
    }

    const formatted =
      rows.map((row) => ({

        ...row.toObject(),

        id: row._id,

        short_id:
          String(row._id).slice(-6),

        location_id:
          normalizeId(row.location_id),

        location_name:
          row.location_id?.name || "",

        employee_id:
          normalizeId(row.employee_id),

        employee_name:
          row.employee_id?.name || "",

        employee_ids: normalizeIdArray(row.employee_ids),

        employee_names:
          normalizeIdArray(row.employee_ids)
            .map((empId) => employeeNameMap.get(empId) || "")
            .filter(Boolean),

      }));

    return res.json(
      formatted
    );

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });

  }

});

router.post("/", async (req, res) => {

  try {

    if (
      !isAdminUser(req.user)
    ) {

      return res.status(403).json({
        error:
          "Only admin can edit warehouse master",
      });

    }

    const {
      name,
      address,
      location_id,
      employee_id,
      employee_ids,
    } = req.body;

    if (
      !name ||
      !address
    ) {

      return res.status(400).json({
        error:
          "Name and address are required",
      });

    }

    const safeEmployeeIds =
      parseEmployeeIds(employee_ids);

    const primaryEmployeeId =
      safeEmployeeIds[0] ||
      employee_id ||
      null;

    const warehouse =
      await Warehouse.create({

        name,

        address,

        location_id:
          location_id || null,

        employee_id:
          primaryEmployeeId,

        employee_ids:
          safeEmployeeIds,

      });

    await syncWarehouseEmployeeAssignments(
      warehouse._id,
      safeEmployeeIds
    );

    return res.json(
      warehouse
    );

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });

  }

});

router.put("/:id", async (req, res) => {

  try {

    if (
      !isAdminUser(req.user)
    ) {

      return res.status(403).json({
        error:
          "Only admin can edit warehouse master",
      });

    }

    const {
      name,
      address,
      location_id,
      employee_id,
      employee_ids,
    } = req.body;

    const safeEmployeeIds =
      parseEmployeeIds(employee_ids);

    const primaryEmployeeId =
      safeEmployeeIds[0] ||
      employee_id ||
      null;

    const updated =
      await Warehouse.findByIdAndUpdate(
        req.params.id,

        {
          name,

          address,

          location_id:
            location_id || null,

          employee_id:
            primaryEmployeeId,

          employee_ids:
            safeEmployeeIds,
        },

        {
          new: true,
        }
      );

    if (!updated) {

      return res.status(404).json({
        error:
          "Warehouse not found",
      });

    }

    await syncWarehouseEmployeeAssignments(
      req.params.id,
      safeEmployeeIds
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

router.delete("/:id", async (req, res) => {

  try {

    if (
      !isAdminUser(req.user)
    ) {

      return res.status(403).json({
        error:
          "Only admin can edit warehouse master",
      });

    }

    const deleted =
      await Warehouse.findByIdAndDelete(
        req.params.id
      );

    if (!deleted) {

      return res.status(404).json({
        error:
          "Warehouse not found",
      });

    }

    await Employee.updateMany(
      {},
      { $pull: { assigned_warehouse_ids: String(req.params.id) } }
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
