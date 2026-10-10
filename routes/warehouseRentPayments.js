const express = require("express");
const router = express.Router();
const { mongoose, CashEntry } = require("../db-mongodb");
const { Warehouse, WarehouseRentBooking, Company } = require("../mongo");
const { userHasPermission } = require("../middleware/auth");

const RentPayment = mongoose.models.WarehouseRentPaymentEntry ||
  mongoose.model(
    "WarehouseRentPaymentEntry",
    new mongoose.Schema(
      { id: { type: Number, index: true } },
      {
        strict: false,
        minimize: false,
        collection: "warehouserentpaymententries",
      }
    )
  );

const text = (value) => value === undefined || value === null ? "" : String(value).trim();
const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const round2 = (value) => Math.round((number(value) + Number.EPSILON) * 100) / 100;
const canAccess = (req) =>
  userHasPermission(req.user, "all") ||
  userHasPermission(req.user, "warehouses.manage") ||
  userHasPermission(req.user, "expense.entry") ||
  userHasPermission(req.user, "cash.create");

function requireAccess(req, res) {
  if (canAccess(req)) return true;
  res.status(403).json({ error: "Permission denied for Warehouse Rent Payment" });
  return false;
}

async function nextNumericId(Model) {
  const latest = await Model.findOne({ id: { $type: "number" } })
    .sort({ id: -1 })
    .select({ id: 1 })
    .lean();
  return Number(latest?.id || 0) + 1;
}

async function nextVoucherNo() {
  const rows = await RentPayment.find({ voucher_no: /^WRENT\d+$/i })
    .select({ voucher_no: 1 })
    .lean();
  const highest = (rows || []).reduce((max, row) => {
    const match = text(row.voucher_no).match(/^WRENT(\d+)$/i);
    return match ? Math.max(max, Number(match[1]) || 0) : max;
  }, 0);
  return `WRENT${String(highest + 1).padStart(6, "0")}`;
}

function isPayableBooking(booking) {
  return !booking.rent_flow || booking.rent_flow === "payable";
}

router.get("/companies", async (req, res) => {
  try {
    if (!requireAccess(req, res)) return;
    const warehouses = await Warehouse.find({
      monthly_rent: { $gt: 0 },
      company_id: { $ne: null },
      $or: [{ rent_flow: "payable" }, { rent_flow: { $exists: false } }, { rent_flow: null }, { rent_flow: "" }],
    }).select({ company_id: 1 }).lean();
    const companyIds = [...new Set(warehouses.map((row) => String(row.company_id || "")).filter(Boolean))];
    const companies = companyIds.length
      ? await Company.find({ _id: { $in: companyIds } }).select({ _id: 1, name: 1 }).sort({ name: 1 }).lean()
      : [];
    return res.json(companies.map((company) => ({ id: String(company._id), name: company.name || "" })));
  } catch (error) {
    console.error("Warehouse rent payment companies failed:", error);
    return res.status(500).json({ error: error.message || "Failed to load rent payees" });
  }
});

router.get("/pending", async (req, res) => {
  try {
    if (!requireAccess(req, res)) return;
    const companyId = text(req.query.company_id);
    if (!mongoose.isValidObjectId(companyId)) {
      return res.status(400).json({ error: "Valid company_id is required" });
    }
    const rows = await WarehouseRentBooking.find({
      company_id: companyId,
      status: { $ne: "paid" },
      $or: [{ rent_flow: "payable" }, { rent_flow: { $exists: false } }, { rent_flow: null }, { rent_flow: "" }],
    })
      .populate("warehouse_id", "name")
      .populate("company_id", "name")
      .sort({ rent_month: -1, createdAt: -1 })
      .lean();
    const bills = rows.map((row) => {
      const paid = round2(row.paid_amount);
      const balance = row.balance_amount === undefined || row.balance_amount === null
        ? round2(Math.max(number(row.monthly_rent) - paid, 0))
        : round2(Math.max(number(row.balance_amount), 0));
      return {
        id: String(row._id),
        bill_no: row.booking_no || String(row._id),
        rent_month: row.rent_month || "",
        date: row.booking_date || "",
        company_id: String(row.company_id?._id || row.company_id || ""),
        company_name: row.company_id?.name || "",
        warehouse_id: String(row.warehouse_id?._id || row.warehouse_id || ""),
        warehouse_name: row.warehouse_id?.name || "",
        bill_amount: round2(row.monthly_rent),
        paid_amount: paid,
        pending_amount: balance,
      };
    }).filter((row) => row.pending_amount > 0);
    return res.json({ bills, total_pending: round2(bills.reduce((sum, row) => sum + row.pending_amount, 0)) });
  } catch (error) {
    console.error("Warehouse rent pending bills failed:", error);
    return res.status(500).json({ error: error.message || "Failed to load pending rent bills" });
  }
});

router.get("/", async (req, res) => {
  try {
    if (!requireAccess(req, res)) return;
    const rows = await RentPayment.find({})
      .sort({ date: -1, id: -1, _id: -1 })
      .limit(500)
      .lean();
    return res.json({ rows });
  } catch (error) {
    console.error("Warehouse rent payment history failed:", error);
    return res.status(500).json({ error: error.message || "Failed to load payment history" });
  }
});

router.post("/", async (req, res) => {
  if (!requireAccess(req, res)) return;
  const body = req.body || {};
  const companyId = text(body.company_id);
  const date = text(body.date);
  const amount = round2(body.amount);
  const paymentMethod = text(body.payment_method) || "Cash";
  const allocations = Array.isArray(body.allocations) ? body.allocations : [];
  const seen = new Set();
  const updatedBookings = [];
  let paymentDoc = null;
  let cashEntry = null;

  try {
    if (!mongoose.isValidObjectId(companyId)) {
      return res.status(400).json({ error: "Select a valid rent payee company" });
    }
    if (!date) return res.status(400).json({ error: "Payment date is required" });
    if (amount <= 0) return res.status(400).json({ error: "Payment amount must be greater than zero" });
    if (!allocations.length) return res.status(400).json({ error: "Allocate the payment to at least one rent bill" });

    const company = await Company.findById(companyId).select({ name: 1 }).lean();
    if (!company) return res.status(400).json({ error: "Rent payee company was not found" });

    const cleanAllocations = [];
    for (const item of allocations) {
      const bookingId = text(item?.booking_id ?? item?.id);
      const adjustedAmount = round2(item?.adjusted_amount ?? item?.amount);
      if (!bookingId || adjustedAmount <= 0) continue;
      if (seen.has(bookingId)) {
        return res.status(400).json({ error: `Duplicate rent bill allocation ${bookingId}` });
      }
      seen.add(bookingId);
      if (!mongoose.isValidObjectId(bookingId)) {
        return res.status(400).json({ error: `Invalid rent bill ${bookingId}` });
      }
      const booking = await WarehouseRentBooking.findById(bookingId)
        .populate("warehouse_id", "name")
        .lean();
      if (!booking || !isPayableBooking(booking) || String(booking.company_id || "") !== companyId) {
        return res.status(400).json({ error: "A selected rent bill is not payable to this company" });
      }
      const pending = booking.balance_amount === undefined || booking.balance_amount === null
        ? round2(Math.max(number(booking.monthly_rent) - number(booking.paid_amount), 0))
        : round2(Math.max(number(booking.balance_amount), 0));
      if (adjustedAmount > pending + 0.009) {
        return res.status(400).json({ error: `Payment exceeds balance for ${booking.booking_no || bookingId}` });
      }
      cleanAllocations.push({
        booking_id: bookingId,
        bill_no: booking.booking_no || bookingId,
        rent_month: booking.rent_month || "",
        warehouse_id: String(booking.warehouse_id?._id || booking.warehouse_id || ""),
        warehouse_name: booking.warehouse_id?.name || "",
        bill_amount: round2(booking.monthly_rent),
        pending_before: pending,
        adjusted_amount: adjustedAmount,
      });
    }
    const allocatedTotal = round2(cleanAllocations.reduce((sum, row) => sum + row.adjusted_amount, 0));
    if (Math.abs(allocatedTotal - amount) > 0.009) {
      return res.status(400).json({ error: "Payment amount must equal the total allocated to rent bills" });
    }

    let voucherNo = text(body.voucher_no);
    if (voucherNo && await RentPayment.exists({ voucher_no: voucherNo })) {
      return res.status(409).json({ error: "Voucher number already exists" });
    }
    if (!voucherNo) voucherNo = await nextVoucherNo();

    paymentDoc = await RentPayment.create({
      id: await nextNumericId(RentPayment),
      voucher_no: voucherNo,
      date,
      company_id: companyId,
      company_name: company.name || "",
      amount,
      payment_method: paymentMethod,
      narration: text(body.narration),
      allocations: cleanAllocations,
      created_by: Number(req.user?.id) || null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    for (const allocation of cleanAllocations) {
      const booking = await WarehouseRentBooking.findById(allocation.booking_id);
      if (!booking || !isPayableBooking(booking) || String(booking.company_id || "") !== companyId) {
        throw new Error(`Rent bill ${allocation.bill_no} changed while saving payment`);
      }
      const currentBalance = booking.balance_amount === undefined || booking.balance_amount === null
        ? round2(Math.max(number(booking.monthly_rent) - number(booking.paid_amount), 0))
        : round2(Math.max(number(booking.balance_amount), 0));
      if (allocation.adjusted_amount > currentBalance + 0.009) {
        throw new Error(`Rent bill ${allocation.bill_no} no longer has the expected balance`);
      }
      updatedBookings.push({
        id: booking._id,
        paid_amount: number(booking.paid_amount || 0),
        balance_amount: booking.balance_amount,
        status: booking.status,
        payment_mode: booking.payment_mode,
        reference_no: booking.reference_no,
      });
      const nextPaid = round2(number(booking.paid_amount) + allocation.adjusted_amount);
      const nextBalance = round2(Math.max(number(booking.monthly_rent) - nextPaid, 0));
      const update = await WarehouseRentBooking.updateOne(
        { _id: booking._id, balance_amount: currentBalance },
        {
          $set: {
            paid_amount: nextPaid,
            balance_amount: nextBalance,
            status: nextBalance <= 0.009 ? "paid" : "partial",
            payment_mode: paymentMethod,
            reference_no: voucherNo,
          },
        }
      );
      if (update.modifiedCount !== 1) {
        throw new Error(`Rent bill ${allocation.bill_no} was updated by another payment`);
      }
    }

    if (/^(cash|main\s*cash)$/i.test(paymentMethod)) {
      const warehouseIds = [...new Set(cleanAllocations.map((row) => row.warehouse_id).filter(Boolean))];
      const primaryWarehouseId = warehouseIds.length === 1 ? warehouseIds[0] : null;
      const warehouse = primaryWarehouseId ? await Warehouse.findById(primaryWarehouseId).select({ name: 1 }).lean() : null;
      cashEntry = await CashEntry.create({
        id: await nextNumericId(CashEntry),
        voucher_no: voucherNo,
        entry_date: new Date(`${date}T00:00:00`),
        entry_type: "expense",
        warehouse_id: primaryWarehouseId,
        company_id: companyId,
        company_account_id: null,
        description: `Warehouse Rent Payment - ${company.name || "Company"}`,
        amount,
        payment_method: paymentMethod,
        reference_no: voucherNo,
        narration: text(body.narration) || `Warehouse rent payment${warehouse ? ` - ${warehouse.name}` : ""}`,
        created_by: Number(req.user?.id) || null,
        employee_id: null,
        fund_source: "main_cash",
        status: "posted",
        linked_entry_id: paymentDoc._id,
        source_expense_id: `warehouse_rent_payment:${paymentDoc.id}`,
        created_at: new Date(),
        updated_at: new Date(),
      });
      await RentPayment.updateOne(
        { _id: paymentDoc._id },
        { $set: { cash_entry_id: String(cashEntry._id) } }
      );
    }

    return res.status(201).json({
      message: "Warehouse rent payment saved successfully",
      id: paymentDoc.id,
      payment_id: String(paymentDoc._id),
      voucher_no: voucherNo,
      amount,
      company_name: company.name || "",
    });
  } catch (error) {
    console.error("Warehouse rent payment save failed:", error);
    for (const prior of updatedBookings.reverse()) {
      try {
        await WarehouseRentBooking.updateOne(
          { _id: prior.id },
          {
            $set: {
              paid_amount: prior.paid_amount,
              balance_amount: prior.balance_amount,
              status: prior.status,
              payment_mode: prior.payment_mode || "",
              reference_no: prior.reference_no || "",
            },
          }
        );
      } catch (rollbackError) {
        console.error("Warehouse rent booking rollback failed:", rollbackError);
      }
    }
    if (cashEntry?._id) {
      try {
        await CashEntry.deleteOne({ _id: cashEntry._id });
      } catch (rollbackError) {
        console.error("Warehouse rent cash entry rollback failed:", rollbackError);
      }
    }
    if (paymentDoc?._id) {
      try {
        await RentPayment.deleteOne({ _id: paymentDoc._id });
      } catch (rollbackError) {
        console.error("Warehouse rent payment rollback failed:", rollbackError);
      }
    }
    return res.status(500).json({ error: error.message || "Failed to save warehouse rent payment" });
  }
});

module.exports = router;
