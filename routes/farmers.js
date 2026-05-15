const express = require("express");
const router = express.Router();

const { Farmer } = require("../mongo");
const { userHasPermission } = require("../middleware/auth");

function canReadFarmers(user) {
  return [
    "farmers.manage",
    "inward.view",
    "inward.create",
    "outward.view",
    "outward.create",
    "adjustment.manage",
    "expense.entry",
    "expense.view",
    "expense.create",
    "cash.view",
    "settlement.view",
    "report.inward",
    "report.erp",
    "report.partyLedger",
    "report.partyStock",
    "report.warehouseRentLedger",
    "report.warehouseRentMonthEnd",
    "report.outwardSettlement",
    "report.expense",
    "warehouse.trading.view",
    "warehouse.trading.manage",
  ].some((permission) => userHasPermission(user, permission));
}

function canManageFarmers(user, action) {
  return userHasPermission(user, "farmers.manage") || userHasPermission(user, `farmers.${action}`);
}

router.get("/", async (req, res) => {
  try {
    if (!canReadFarmers(req.user)) {
      return res.status(403).json({
        error: "You do not have permission to view farmers",
      });
    }

    const rows = await Farmer.find().sort({ created_at: -1 });
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    if (!canManageFarmers(req.user, "create")) {
      return res.status(403).json({
        error: "You do not have permission to manage farmers",
      });
    }

    const {
      name,
      mobile,
      email,
      address,
      village,
      state,
      gst_no,
      pan_no,
      location,
    } = req.body;

    if (!name || !mobile) {
      return res.status(400).json({
        error: "Farmer name and mobile are required",
      });
    }

    const farmer = await Farmer.create({
      name: String(name).trim(),
      mobile: String(mobile).trim(),
      email: email ? String(email).trim() : null,
      address: address ? String(address).trim() : null,
      village: village ? String(village).trim() : null,
      state: state ? String(state).trim() : null,
      gst_no: gst_no ? String(gst_no).trim() : null,
      pan_no: pan_no ? String(pan_no).trim() : null,
      location: location ? String(location).trim() : null,
    });

    res.json(farmer);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    if (!canManageFarmers(req.user, "edit")) {
      return res.status(403).json({
        error: "You do not have permission to manage farmers",
      });
    }

    const {
      name,
      mobile,
      email,
      address,
      village,
      state,
      gst_no,
      pan_no,
      location,
    } = req.body;

    if (!name || !mobile) {
      return res.status(400).json({
        error: "Farmer name and mobile are required",
      });
    }

    const updated = await Farmer.findByIdAndUpdate(
      req.params.id,
      {
        name: String(name).trim(),
        mobile: String(mobile).trim(),
        email: email ? String(email).trim() : null,
        address: address ? String(address).trim() : null,
        village: village ? String(village).trim() : null,
        state: state ? String(state).trim() : null,
        gst_no: gst_no ? String(gst_no).trim() : null,
        pan_no: pan_no ? String(pan_no).trim() : null,
        location: location ? String(location).trim() : null,
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "Farmer not found" });
    }

    res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!canManageFarmers(req.user, "delete")) {
      return res.status(403).json({
        error: "You do not have permission to manage farmers",
      });
    }

    const deleted = await Farmer.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Farmer not found" });
    }

    res.json({ message: "Farmer deleted", id: req.params.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
