const express = require("express");
const router = express.Router();
const { Warehouse, WarehouseRentBooking } = require("../mongo");
const { userHasPermission } = require("../middleware/auth");

function canManage(req) {
  return userHasPermission(req.user, "warehouses.manage") || userHasPermission(req.user, "all");
}

router.get("/", async (req,res)=>{
  try {
    if (!canManage(req)) return res.status(403).json({error:"Permission denied"});
    const rows = await WarehouseRentBooking.find({}).populate("warehouse_id","name monthly_rent").populate("company_id","name").sort({rent_month:-1, createdAt:-1});
    res.json(rows.map(r=>({...r.toObject(), id:String(r._id), warehouse_name:r.warehouse_id?.name||"", company_name:r.company_id?.name||""})));
  } catch(e){ console.error(e); res.status(500).json({error:e.message}); }
});

router.post("/", async (req,res)=>{
  try {
    if (!canManage(req)) return res.status(403).json({error:"Permission denied"});
    const {warehouse_id, rent_month, booking_date, remarks=""}=req.body;
    if (!warehouse_id || !rent_month || !booking_date) return res.status(400).json({error:"Warehouse, month and booking date are required"});
    const warehouse = await Warehouse.findById(warehouse_id).populate("company_id","name");
    if (!warehouse) return res.status(404).json({error:"Warehouse not found"});
    const monthlyRent = Number(warehouse.monthly_rent || 0);
    const existing = await WarehouseRentBooking.findOne({warehouse_id, rent_month});
    if (existing) return res.status(409).json({error:"This warehouse is already booked for this month"});
    const bookingNo = `WRB-${new Date().getTime()}`;
    const booking = await WarehouseRentBooking.create({booking_no:bookingNo, booking_date, rent_month, warehouse_id, company_id:warehouse.company_id?._id || null, monthly_rent:monthlyRent, status:"unpaid", paid_amount:0, balance_amount:monthlyRent, remarks});
    res.json({ok:true, ...booking.toObject(), id:String(booking._id), company_name:warehouse.company_id?.name||"", warehouse_name:warehouse.name});
  } catch(e){ console.error(e); res.status(500).json({error:e.message}); }
});

module.exports = router;
