const express = require("express");
const router = express.Router();

const { mongoose, Location } = require("../mongo");

const {
  userHasPermission,
  isAdminUser,
} = require("../middleware/auth");

function canReadLocations(user) {
  return [
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
      return res.json([]);
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
          "Only admin can edit location master",
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

    if (!isAdminUser(req.user)) {
      return res.status(403).json({
        error:
          "Only admin can edit location master",
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

    if (!isAdminUser(req.user)) {
      return res.status(403).json({
        error:
          "Only admin can edit location master",
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
