const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { Warehouse, Company, WarehouseRentBooking } = require("../mongo");

function nextBookingNo(lastNo) {
  const m = String(lastNo || "").match(/(\d+)$/);
  const n = m ? Number(m[1]) + 1 : 1;
  return `WRB-${String(n).padStart(5, "0")}`;
}

router.get("/", async (req, res) => {
  try {
    const { month, warehouse_id, company_id } = req.query;
    const filter = {};
    if (month) filter.month = String(month);
    if (warehouse_id && mongoose.Types.ObjectId.isValid(warehouse_id)) filter.warehouse_id = warehouse_id;
    if (company_id && mongoose.Types.ObjectId.isValid(company_id)) filter.company_id = company_id;
    const rows = await WarehouseRentBooking.find(filter)
      .populate("warehouse_id", "name")
      .populate("company_id", "name")
      .sort({ month: -1, createdAt: -1 })
      .lean();
    res.json(rows.map(r => ({
      ...r,
      id: String(r._id),
      warehouse_name: r.warehouse_id?.name || "",
      company_name: r.company_id?.name || "",
    })));
  } catch (err) {
    console.error("warehouse rent booking list error", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const { warehouse_id, month, booking_date } = req.body;
    if (!warehouse_id || !month) return res.status(400).json({ error: "Warehouse and month are required" });
    if (!mongoose.Types.ObjectId.isValid(warehouse_id)) return res.status(400).json({ error: "Invalid warehouse" });
    const warehouse = await Warehouse.findById(warehouse_id).populate("company_id", "name");
    if (!warehouse) return res.status(404).json({ error: "Warehouse not found" });
    if (!warehouse.company_id) return res.status(400).json({ error: "Company is not set for this warehouse" });
    const monthlyRent = Number(warehouse.monthly_rent || 0);
    if (!(monthlyRent > 0)) return res.status(400).json({ error: "Monthly rent is not set for this warehouse" });
    const exists = await WarehouseRentBooking.findOne({ warehouse_id, month: String(month) });
    if (exists) return res.status(409).json({ error: `Rent already booked for ${month}` });
    const last = await WarehouseRentBooking.findOne({}).sort({ createdAt: -1 }).select("booking_no").lean();
    const booking = await WarehouseRentBooking.create({
      booking_no: nextBookingNo(last?.booking_no),
      booking_date: booking_date || new Date().toISOString().slice(0, 10),
      month: String(month),
      warehouse_id,
      company_id: warehouse.company_id._id,
      monthly_rent: monthlyRent,
      status: "BOOKED",
      created_by: req.user?._id || null,
    });
    const out = await WarehouseRentBooking.findById(booking._id)
      .populate("warehouse_id", "name")
      .populate("company_id", "name")
      .lean();
    res.status(201).json({ ...out, id: String(out._id), warehouse_name: out.warehouse_id?.name || "", company_name: out.company_id?.name || "" });
  } catch (err) {
    console.error("warehouse rent booking save error", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
