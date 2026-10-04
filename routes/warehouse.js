const express = require("express");

const router = express.Router();

const {
  mongoose,
  Warehouse,
} = require("../mongo");

const {
  userHasPermission,
  isAdminUser,
} = require("../middleware/auth");

router.get("/", async (req, res) => {

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: "Database service is temporarily unavailable. Please try again in a moment.",
      });
    }

    const assignedIds =
      req.user?.assigned_warehouse_ids || [];

    const restrictToAssigned =
      req.user &&
      !userHasPermission(req.user, "all") &&
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
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: "Database is temporarily unavailable",
      });
    }

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
      pincode,
      state,
      district,
      city,
      room_floor_building,
      street_locality_landmark,
      location_id,
      employee_id,
      employee_ids,
      opening_balance,
      opening_balance_type,
      company_id,
      monthly_rent,
      rent_flow,
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

        pincode: pincode || null,
        state: state || null,
        district: district || null,
        city: city || null,
        room_floor_building: room_floor_building || null,
        street_locality_landmark: street_locality_landmark || null,

        location_id:
          location_id || null,

        employee_id:
          employee_id || null,

        employee_ids: Array.isArray(employee_ids) ? employee_ids.filter(Boolean) : (employee_id ? [employee_id] : []),
        opening_balance: Number.isFinite(Number(opening_balance)) ? Number(opening_balance) : 0,
        opening_balance_type: String(opening_balance_type || "dr").toLowerCase() === "cr" ? "cr" : "dr",
        company_id: company_id || null,
        monthly_rent: Number.isFinite(Number(monthly_rent)) ? Number(monthly_rent) : 0,
        rent_flow: String(rent_flow || "payable").toLowerCase() === "receivable" ? "receivable" : "payable",

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
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: "Database is temporarily unavailable",
      });
    }

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
      pincode,
      state,
      district,
      city,
      room_floor_building,
      street_locality_landmark,
      location_id,
      employee_id,
      employee_ids,
      opening_balance,
      opening_balance_type,
      company_id,
      monthly_rent,
      rent_flow,
    } = req.body;

    const updated =
      await Warehouse.findByIdAndUpdate(
        req.params.id,

        {
          name,

          address,

          pincode: pincode || null,
          state: state || null,
          district: district || null,
          city: city || null,
          room_floor_building: room_floor_building || null,
          street_locality_landmark: street_locality_landmark || null,

          location_id:
            location_id || null,

          employee_id:
            employee_id || null,

          employee_ids: Array.isArray(employee_ids) ? employee_ids.filter(Boolean) : (employee_id ? [employee_id] : []),
          opening_balance: Number.isFinite(Number(opening_balance)) ? Number(opening_balance) : 0,
          opening_balance_type: String(opening_balance_type || "dr").toLowerCase() === "cr" ? "cr" : "dr",
          company_id: company_id || null,
          monthly_rent: Number.isFinite(Number(monthly_rent)) ? Number(monthly_rent) : 0,
          rent_flow: String(rent_flow || "payable").toLowerCase() === "receivable" ? "receivable" : "payable",
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
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: "Database is temporarily unavailable",
      });
    }

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
