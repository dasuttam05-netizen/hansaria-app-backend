const express = require("express");
const router = express.Router();
const { Warehouse, WarehouseRentBooking } = require("../mongo");
const { userHasPermission } = require("../middleware/auth");

function canManage(req) {
  return userHasPermission(req.user, "warehouses.manage") || userHasPermission(req.user, "all");
}

function normalizeFlow(value) {
  return String(value || "payable").toLowerCase() === "receivable" ? "receivable" : "payable";
}

function istToday() {
  return new Date(Date.now() + 19800000).toISOString().slice(0, 10);
}

router.get("/", async (req, res) => {
  try {
    if (!canManage(req)) return res.status(403).json({ error: "Permission denied" });
    const filter = {};
    if (req.query.rent_month) filter.rent_month = String(req.query.rent_month);
    if (req.query.rent_flow) filter.rent_flow = normalizeFlow(req.query.rent_flow);
    const rows = await WarehouseRentBooking.find(filter)
      .populate("warehouse_id", "name monthly_rent rent_flow")
      .populate("company_id", "name")
      .sort({ rent_month: -1, createdAt: -1 });
    res.json(rows.map((r) => {
      const obj = r.toObject();
      return {
        ...obj,
        id: String(r._id),
        warehouse_name: r.warehouse_id?.name || "",
        company_name: r.company_id?.name || "",
        rent_flow: obj.rent_flow || r.warehouse_id?.rent_flow || "payable",
      };
    }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

router.post("/", async (req, res) => {
  try {
    if (!canManage(req)) return res.status(403).json({ error: "Permission denied" });
    const { warehouse_id, rent_month, booking_date, remarks = "", rent_flow } = req.body;
    if (!warehouse_id || !rent_month || !booking_date) {
      return res.status(400).json({ error: "Warehouse, month and booking date are required" });
    }
    const warehouse = await Warehouse.findById(warehouse_id).populate("company_id", "name");
    if (!warehouse) return res.status(404).json({ error: "Warehouse not found" });
    const monthlyRent = Number(warehouse.monthly_rent || 0);
    if (monthlyRent <= 0) return res.status(400).json({ error: "Monthly warehouse rent must be greater than 0" });
    const flow = normalizeFlow(rent_flow || warehouse.rent_flow);
    if (!warehouse.company_id?._id) {
      return res.status(400).json({ error: "Company / rent payee is required for warehouse rent" });
    }
    const existing = await WarehouseRentBooking.findOne({ warehouse_id, rent_month });
    if (existing) return res.status(409).json({ error: "This warehouse is already booked for this month" });
    const bookingNo = `WRB-${String(rent_month).replace(/-/g, "")}-${Date.now()}-${String(warehouse._id).slice(-4)}`;
    const booking = await WarehouseRentBooking.create({
      booking_no: bookingNo,
      booking_date,
      rent_month,
      warehouse_id,
      company_id: warehouse.company_id?._id || null,
      monthly_rent: monthlyRent,
      rent_flow: flow,
      auto_booked: false,
      billing_status: flow === "receivable" ? "pending" : "not_applicable",
      status: "unpaid",
      paid_amount: 0,
      balance_amount: monthlyRent,
      remarks,
    });
    res.json({ ok: true, ...booking.toObject(), id: String(booking._id), company_name: warehouse.company_id?.name || "", warehouse_name: warehouse.name });
  } catch (e) {
    console.error(e);
    if (e?.code === 11000) return res.status(409).json({ error: "This warehouse is already booked for this month" });
    res.status(500).json({ error: e.message });
  }
});

router.post("/bulk", async (req, res) => {
  try {
    if (!canManage(req)) return res.status(403).json({ error: "Permission denied" });
    const rentMonth = String(req.body.rent_month || "").trim();
    const bookingDate = String(req.body.booking_date || istToday()).trim();
    const selectedIds = Array.isArray(req.body.warehouse_ids) ? req.body.warehouse_ids.filter(Boolean).map(String) : [];
    const rentFlow = req.body.rent_flow
      ? normalizeFlow(req.body.rent_flow)
      : "receivable";
    if (!/^\d{4}-\d{2}$/.test(rentMonth)) return res.status(400).json({ error: "Valid rent month is required (YYYY-MM)" });
    if (rentFlow === "payable" && !selectedIds.length) {
      return res.status(400).json({ error: "Select at least one warehouse to generate payable rent bills" });
    }

    const filter = rentFlow === "receivable"
      ? { rent_flow: "receivable" }
      : { rent_flow: { $ne: "receivable" } };
    if (selectedIds.length) filter._id = { $in: selectedIds };
    const warehouses = await Warehouse.find(filter).populate("company_id", "name").sort({ name: 1 });
    const existing = await WarehouseRentBooking.find({ rent_month: rentMonth }).select("warehouse_id").lean();
    const existingIds = new Set(existing.map((row) => String(row.warehouse_id)));

    const created = [];
    const skipped = [];
    const errors = [];
    for (const warehouse of warehouses) {
      const wid = String(warehouse._id);
      const rent = Number(warehouse.monthly_rent || 0);
      if (existingIds.has(wid)) {
        skipped.push({ warehouse_id: wid, warehouse_name: warehouse.name, reason: "Already booked" });
        continue;
      }
      if (!warehouse.company_id?._id) {
        errors.push({ warehouse_id: wid, warehouse_name: warehouse.name, reason: "Company is missing" });
        continue;
      }
      if (rent <= 0) {
        errors.push({ warehouse_id: wid, warehouse_name: warehouse.name, reason: "Monthly rent is 0" });
        continue;
      }
      try {
        const booking = await WarehouseRentBooking.create({
          booking_no: `WRB-${rentMonth.replace(/-/g, "")}-${Date.now()}-${wid.slice(-6)}`,
          booking_date: bookingDate,
          rent_month: rentMonth,
          warehouse_id: warehouse._id,
          company_id: warehouse.company_id._id,
          monthly_rent: rent,
          rent_flow: rentFlow,
          auto_booked: false,
          billing_status: rentFlow === "receivable" ? "pending" : "not_applicable",
          status: "unpaid",
          paid_amount: 0,
          balance_amount: rent,
          remarks: String(req.body.remarks || (rentFlow === "receivable" ? "Bulk company rent booking" : "Monthly warehouse rent bill")),
        });
        existingIds.add(wid);
        created.push({
          id: String(booking._id),
          booking_no: booking.booking_no,
          warehouse_id: wid,
          warehouse_name: warehouse.name,
          company_name: warehouse.company_id?.name || "",
          monthly_rent: rent,
          rent_flow: rentFlow,
        });
      } catch (err) {
        if (err?.code === 11000) skipped.push({ warehouse_id: wid, warehouse_name: warehouse.name, reason: "Already booked" });
        else errors.push({ warehouse_id: wid, warehouse_name: warehouse.name, reason: err.message });
      }
    }
    return res.json({ ok: true, rent_month: rentMonth, rent_flow: rentFlow, created, skipped, errors, created_count: created.length, skipped_count: skipped.length, error_count: errors.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
