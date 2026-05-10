const express = require("express");

const router = express.Router();

const {
  Warehouse,
} = require("../mongo");

const {
  userHasPermission,
  isAdminUser,
} = require("../middleware/auth");

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

    const warehouse =
      await Warehouse.create({

        name,

        address,

        location_id:
          location_id || null,

        employee_id:
          employee_id || null,

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
    } = req.body;

    const updated =
      await Warehouse.findByIdAndUpdate(
        req.params.id,

        {
          name,

          address,

          location_id:
            location_id || null,

          employee_id:
            employee_id || null,
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
