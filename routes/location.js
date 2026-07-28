const express = require("express");
const router = express.Router();

const { mongoose, Location, Warehouse } = require("../mongo");

const {
  userHasPermission,
  isAdminUser,
} = require("../middleware/auth");

function canReadLocations(user) {
  return [
    "locations.view",
    "locations.manage",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
    "inward.view",
    "inward.create",
    "outward.view",
    "outward.create",
    "employees.view",
    "report.partyStock",
    "report.warehouseRentLedger",
    "report.warehouseRentMonthEnd",
  ].some((permission) =>
    userHasPermission(user, permission)
  );
}

router.get("/", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: "Database service is temporarily unavailable. Please try again in a moment.",
      });
    }

    if (!canReadLocations(req.user)) {
      return res.status(403).json({
        error:
          "You do not have permission to view locations",
      });
    }

    const rows = await Location.find().sort({
      created_at: -1,
    });

    res.json(rows);

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });
  }
});

router.get("/unmapped", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: "Database service is temporarily unavailable. Please try again in a moment.",
      });
    }

    if (!canReadLocations(req.user)) {
      return res.status(403).json({
        error: "You do not have permission to view locations",
      });
    }

    const [locations, warehouses] = await Promise.all([
      Location.find().sort({ created_at: -1 }).lean(),
      Warehouse.find({}, { location_id: 1 }).lean(),
    ]);

    const warehouseCountByLocation = new Map();
    for (const warehouse of warehouses || []) {
      const locationId = String(warehouse.location_id || "");
      if (!locationId) continue;
      warehouseCountByLocation.set(locationId, (warehouseCountByLocation.get(locationId) || 0) + 1);
    }

    const unmappedLocations = (locations || [])
      .filter((location) => !warehouseCountByLocation.has(String(location._id)))
      .map((location) => ({
        id: location._id,
        name: location.name || "",
        address: location.address || "",
        abbr: location.abbr || "",
        warehouse_count: 0,
      }));

    res.json({
      total_locations: locations.length,
      unmapped_count: unmappedLocations.length,
      unmapped_locations: unmappedLocations,
    });
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

    if (!userHasPermission(req.user, "locations.create")) {
      return res.status(403).json({
        error:
          "You do not have permission to create locations",
      });
    }

    const { name, address, abbr } = req.body;

    if (!name || !address) {
      return res.status(400).json({
        error:
          "Name and address are required",
      });
    }

    const location = await Location.create({
      name,
      address,
      abbr: abbr || "",
    });

    res.json(location);

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

    if (!userHasPermission(req.user, "locations.edit")) {
      return res.status(403).json({
        error:
          "You do not have permission to edit locations",
      });
    }

    const { name, address, abbr } = req.body;

    const updated =
      await Location.findByIdAndUpdate(
        req.params.id,
        {
          name,
          address,
          abbr: abbr || "",
        },
        {
          new: true,
        }
      );

    if (!updated) {
      return res.status(404).json({
        error: "Location not found",
      });
    }

    res.json(updated);

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

    if (!userHasPermission(req.user, "locations.delete")) {
      return res.status(403).json({
        error:
          "You do not have permission to delete locations",
      });
    }

    const deleted =
      await Location.findByIdAndDelete(
        req.params.id
      );

    if (!deleted) {
      return res.status(404).json({
        error: "Location not found",
      });
    }

    res.json({
      message: "Location deleted",
      id: req.params.id,
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });
  }
});

module.exports = router;
