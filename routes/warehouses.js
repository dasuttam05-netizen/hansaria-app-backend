const express = require("express");

const router = express.Router();

const {
  Warehouse,
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
        .populate(
          "employee_ids",
          "name"
        )

        .sort({
          created_at: -1,
        });

    const formatted =
      rows.map((row) => ({

        ...row.toObject(),

        id: row._id,

        short_id:
          String(row._id).slice(-6),

        location_name:
          row.location_id?.name || "",

        employee_name:
          row.employee_id?.name || "",

        employee_ids:
          Array.isArray(row.employee_ids)
            ? row.employee_ids.map((emp) =>
                emp?._id
                  ? String(emp._id)
                  : String(emp)
              )
            : [],

        employee_names:
          Array.isArray(row.employee_ids)
            ? row.employee_ids
                .map((emp) => emp?.name)
                .filter(Boolean)
            : [],

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
