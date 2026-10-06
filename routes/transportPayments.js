const express = require("express");

const router = express.Router();

const {
  mongoose,
  CashEntry,
} = require("../db-mongodb");

const {
  TransportBiltiOperational,
  TransporterOperational,
  OutwardOperational,
} = require("../mongoOperationalModels");

const {
  SaleVoucher,
} = require("../mongo");

const {
  userHasPermission,
} = require("../middleware/auth");

const PaymentEntry =
  mongoose.models.TransportPaymentEntry ||
  mongoose.model(
    "TransportPaymentEntry",
    new mongoose.Schema(
      {
        id: { type: Number, index: true },
      },
      {
        strict: false,
        minimize: false,
        collection: "transportpaymententries",
      }
    )
  );

function text(value) {
  return value === undefined || value === null
    ? ""
    : String(value).trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round((num(value) + Number.EPSILON) * 100) / 100;
}

function idVariants(value) {
  const raw = text(value);
  if (!raw) return [];
  const out = [raw];
  if (/^\d+$/.test(raw)) out.push(Number(raw));
  if (mongoose.Types.ObjectId.isValid(raw)) {
    out.push(new mongoose.Types.ObjectId(raw));
  }
  return [...new Map(out.map((v) => [String(v), v])).values()];
}

function sameId(a, b) {
  const left = idVariants(a).map(String);
  const right = idVariants(b).map(String);
  return left.some((v) => right.includes(v));
}

function isAdmin(req) {
  return String(req.user?.role || "").toLowerCase() === "admin" || userHasPermission(req.user, "all");
}

function hasTransportPaymentAccess(req) {
  return isAdmin(req) || userHasPermission(req.user, "cash.create") || userHasPermission(req.user, "transport.manage");
}

function requireAccess(req, res) {
  if (!hasTransportPaymentAccess(req)) {
    res.status(403).json({ error: "Permission denied for Transport Payment" });
    return false;
  }
  return true;
}

async function nextPaymentId() {
  const row = await PaymentEntry.findOne({ id: { $type: "number" } })
    .sort({ id: -1 })
    .select({ id: 1 })
    .lean();
  return Number(row?.id || 0) + 1;
}

async function nextCashEntryId() {
  const row = await CashEntry.findOne({ id: { $type: "number" } })
    .sort({ id: -1 })
    .select({ id: 1 })
    .lean();
  return Number(row?.id || 0) + 1;
}

async function nextTransportPaymentNo() {
  const rows = await PaymentEntry.find({
    voucher_no: { $regex: /^TPAY\d+$/i },
  }).select({ voucher_no: 1 }).lean();

  let max = 0;
  for (const row of rows || []) {
    const match = String(row?.voucher_no || "").match(/^TPAY(\d+)$/i);
    if (match) max = Math.max(max, Number(match[1]) || 0);
  }
  return `TPAY${String(max + 1).padStart(6, "0")}`;
}

async function findFlexible(Model, value) {
  const raw = text(value);
  if (!raw) return null;
  const variants = idVariants(raw);
  const conditions = [];
  if (mongoose.Types.ObjectId.isValid(raw)) {
    conditions.push({ _id: new mongoose.Types.ObjectId(raw) });
  }
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    conditions.push({ id: n }, { legacy_id: n }, { sl_no: n });
  }
  conditions.push({ _id: raw });

  try {
    return await Model.findOne({ $or: conditions }).lean();
  } catch (err) {
    // Some schemas reject a string _id in a mixed $or query. Retry without it.
    try {
      return await Model.findOne({ $or: conditions.filter((c) => !Object.prototype.hasOwnProperty.call(c, "_id") || mongoose.Types.ObjectId.isValid(raw)) }).lean();
    } catch (nestedErr) {
      return null;
    }
  }
}

async function resolveSourceData(bilti) {
  const [sale, outward] = await Promise.all([
    bilti?.sale_id ? findFlexible(SaleVoucher, bilti.sale_id) : Promise.resolve(null),
    bilti?.outward_id ? findFlexible(OutwardOperational, bilti.outward_id) : Promise.resolve(null),
  ]);

  return {
    sale_voucher_no:
      sale?.voucher_no || sale?.bill_no || sale?.sale_no || "",
    sale_id: sale?._id ? String(sale._id) : text(bilti?.sale_id),
    outward_voucher_no:
      outward?.voucher_no || outward?.outward_no || outward?.inv_no || "",
    outward_id: outward
      ? String(outward?.legacy_id ?? outward?.id ?? outward?.sl_no ?? outward?._id)
      : text(bilti?.outward_id),
    warehouse_name:
      bilti?.warehouse_name || outward?.warehouse_name || sale?.warehouse_name || "",
  };
}

async function allocatedMapForBills(billIds, transporterId) {
  const ids = (billIds || []).map(text).filter(Boolean);
  const map = new Map();
  if (!ids.length) return map;

  const transporterVariants = idVariants(transporterId).map(String);
  const query = transporterVariants.length
    ? { transporter_id: { $in: transporterVariants } }
    : {};

  const payments = await PaymentEntry.find(query)
    .select({ allocations: 1 })
    .lean();

  for (const payment of payments || []) {
    for (const allocation of Array.isArray(payment?.allocations) ? payment.allocations : []) {
      const key = text(allocation?.bilti_id);
      if (!key || !ids.includes(key)) continue;
      map.set(key, round2((map.get(key) || 0) + num(allocation?.adjusted_amount)));
    }
  }

  return map;
}

async function getPendingBills(transporterId) {
  const variants = idVariants(transporterId);
  if (!variants.length) return [];

  const stringVariants = variants.map(String);
  const objectVariants = variants.filter((v) => mongoose.isValidObjectId(v));
  const ors = [{ transporter_id: { $in: stringVariants } }];
  if (objectVariants.length) ors.push({ transporter_id: { $in: objectVariants } });
  if (stringVariants.length) ors.push({ transporter_id: { $in: stringVariants.map((v) => Number(v)).filter(Number.isFinite) } });

  const bills = await TransportBiltiOperational.find({ $or: ors })
    .sort({ dispatch_date: -1, legacy_id: -1, _id: -1 })
    .lean();

  const billIds = bills.map((b) => text(b?.legacy_id ?? b?.id ?? b?._id)).filter(Boolean);
  const allocated = await allocatedMapForBills(billIds, transporterId);

  const output = [];
  for (const bill of bills) {
    const biltiId = text(bill?.legacy_id ?? bill?.id ?? bill?._id);
    if (!biltiId) continue;

    const billAmount = round2(
      bill?.payable_amount !== undefined
        ? bill.payable_amount
        : bill?.net_amount !== undefined
        ? bill.net_amount
        : bill?.gross_freight
    );
    const paid = round2(allocated.get(biltiId) || 0);
    const pending = round2(Math.max(0, billAmount - paid));
    if (pending <= 0.009) continue;

    const source = await resolveSourceData(bill);
    output.push({
      id: biltiId,
      bilti_id: biltiId,
      bilti_no: bill?.bilti_no || bill?.voucher_no || biltiId,
      date: bill?.dispatch_date || bill?.outward_date || "",
      transporter_id: text(bill?.transporter_id),
      transporter_name: bill?.transporter_name || "",
      warehouse_id: text(bill?.warehouse_id || ""),
      warehouse_name: source.warehouse_name || bill?.warehouse_name || "",
      sale_id: source.sale_id || "",
      sale_voucher_no: source.sale_voucher_no || "",
      outward_id: source.outward_id || "",
      outward_voucher_no: source.outward_voucher_no || "",
      lorry_no: bill?.lorry_no || "",
      transport_rate: num(bill?.transport_rate),
      bill_amount: billAmount,
      allocated_amount: paid,
      pending_amount: pending,
      net_amount: round2(bill?.net_amount),
      advance_amount: round2(bill?.advance_amount),
      tds_amount: round2(bill?.tds_amount),
    });
  }

  return output;
}

/*
====================================================
PENDING TRANSPORT BILLS
====================================================
*/
router.get("/pending", async (req, res) => {
  try {
    if (!requireAccess(req, res)) return;

    const transporterId = text(req.query.transporter_id);
    if (!transporterId) {
      return res.status(400).json({ error: "transporter_id is required" });
    }

    const transporter = await findFlexible(TransporterOperational, transporterId);
    const bills = await getPendingBills(transporterId);

    return res.json({
      transporter: transporter
        ? {
            id: String(transporter?._id || transporter?.legacy_id || transporter?.id),
            name: transporter?.name || "",
            mobile: transporter?.mobile || "",
            address: transporter?.address || "",
          }
        : { id: transporterId, name: "" },
      bills,
      total_pending: round2(bills.reduce((sum, bill) => sum + num(bill.pending_amount), 0)),
    });
  } catch (err) {
    console.error("Transport pending bills failed:", err);
    return res.status(500).json({ error: err.message || "Failed to load pending transport bills" });
  }
});

/*
====================================================
PAYMENT LIST / REPORT
====================================================
*/
router.get("/", async (req, res) => {
  try {
    if (!requireAccess(req, res)) return;

    const filter = {};
    const transporterId = text(req.query.transporter_id);
    const from = text(req.query.from_date);
    const to = text(req.query.to_date);

    if (transporterId) {
      filter.transporter_id = { $in: idVariants(transporterId).map(String) };
    }
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    }

    const rows = await PaymentEntry.find(filter)
      .sort({ date: -1, id: -1, _id: -1 })
      .limit(500)
      .lean();

    return res.json({
      rows,
      summary: {
        total: round2(rows.reduce((sum, row) => sum + num(row.amount), 0)),
        adjusted: round2(rows.reduce((sum, row) => sum + num(row.adjusted_amount), 0)),
        advance: round2(rows.reduce((sum, row) => sum + num(row.advance_amount), 0)),
        on_account: round2(rows.reduce((sum, row) => sum + num(row.on_account_amount), 0)),
      },
    });
  } catch (err) {
    console.error("Transport payment report failed:", err);
    return res.status(500).json({ error: err.message || "Failed to load transport payment report" });
  }
});

/*
====================================================
CREATE TRANSPORT PAYMENT
====================================================
*/
router.post("/", async (req, res) => {
  try {
    if (!requireAccess(req, res)) return;

    const body = req.body || {};
    const transporterId = text(body.transporter_id);
    const date = text(body.date) || new Date().toISOString().slice(0, 10);
    const paymentMethod = text(body.payment_method) || "Cash";
    const amount = round2(body.amount);
    const advanceAmount = round2(body.advance_amount);
    const onAccountAmount = round2(body.on_account_amount);
    const adjustments = Array.isArray(body.adjustments) ? body.adjustments : [];

    if (!transporterId) return res.status(400).json({ error: "Transport Name is required" });
    if (!date) return res.status(400).json({ error: "Date is required" });
    if (amount <= 0) return res.status(400).json({ error: "Amount must be greater than 0" });
    if (advanceAmount < 0 || onAccountAmount < 0) {
      return res.status(400).json({ error: "Advance and On Account cannot be negative" });
    }

    const transporter = await findFlexible(TransporterOperational, transporterId);
    if (!transporter) return res.status(400).json({ error: "Invalid Transport Name" });

    const pendingBills = await getPendingBills(transporterId);
    const pendingMap = new Map(pendingBills.map((bill) => [text(bill.bilti_id), bill]));

    const cleanAdjustments = [];
    const seenBills = new Set();
    for (const item of adjustments) {
      const biltiId = text(item?.bilti_id ?? item?.id ?? item?.biltiId);
      const adjustedAmount = round2(item?.adjusted_amount ?? item?.amount);
      if (!biltiId || adjustedAmount <= 0) continue;
      if (seenBills.has(biltiId)) return res.status(400).json({ error: `Duplicate transport bill adjustment ${biltiId}` });
      seenBills.add(biltiId);

      const bill = pendingMap.get(biltiId);
      if (!bill) return res.status(400).json({ error: `Transport bill ${biltiId} is no longer pending` });
      if (adjustedAmount > round2(bill.pending_amount) + 0.009) {
        return res.status(400).json({ error: `Adjustment exceeds pending amount for ${bill.bilti_no}` });
      }

      cleanAdjustments.push({
        bilti_id: biltiId,
        bilti_no: bill.bilti_no,
        bill_amount: bill.bill_amount,
        pending_before: bill.pending_amount,
        adjusted_amount: adjustedAmount,
        warehouse_id: bill.warehouse_id,
        warehouse_name: bill.warehouse_name,
        sale_id: bill.sale_id,
        sale_voucher_no: bill.sale_voucher_no,
        outward_id: bill.outward_id,
        outward_voucher_no: bill.outward_voucher_no,
        lorry_no: bill.lorry_no,
      });
    }

    const adjustedTotal = round2(cleanAdjustments.reduce((sum, row) => sum + num(row.adjusted_amount), 0));
    const allocatedTotal = round2(adjustedTotal + advanceAmount + onAccountAmount);

    if (Math.abs(allocatedTotal - amount) > 0.009) {
      return res.status(400).json({
        error: "Amount allocation mismatch",
        details: {
          amount,
          adjusted_total: adjustedTotal,
          advance_amount: advanceAmount,
          on_account_amount: onAccountAmount,
          allocated_total: allocatedTotal,
        },
      });
    }

    let voucherNo = text(body.voucher_no);
    if (!voucherNo) voucherNo = await nextTransportPaymentNo();

    const paymentId = await nextPaymentId();
    const cashEntryId = await nextCashEntryId();

    const primaryWarehouse = cleanAdjustments.length === 1 ? cleanAdjustments[0].warehouse_id : text(body.warehouse_id);
    const primaryWarehouseName = cleanAdjustments.length === 1 ? cleanAdjustments[0].warehouse_name : text(body.warehouse_name);
    const primarySaleId = cleanAdjustments.length === 1 ? cleanAdjustments[0].sale_id : text(body.sale_id);
    const primarySaleVoucherNo = cleanAdjustments.length === 1 ? cleanAdjustments[0].sale_voucher_no : text(body.sale_voucher_no);
    const primaryOutwardId = cleanAdjustments.length === 1 ? cleanAdjustments[0].outward_id : text(body.outward_id);
    const primaryOutwardVoucherNo = cleanAdjustments.length === 1 ? cleanAdjustments[0].outward_voucher_no : text(body.outward_voucher_no);

    const paymentDoc = await PaymentEntry.create({
      id: paymentId,
      voucher_no: voucherNo,
      date,
      transporter_id: String(transporter?._id || transporter?.legacy_id || transporter?.id || transporterId),
      transporter_name: transporter?.name || "",
      warehouse_id: primaryWarehouse || null,
      warehouse_name: primaryWarehouseName || "",
      sale_id: primarySaleId || null,
      sale_voucher_no: primarySaleVoucherNo || "",
      outward_id: primaryOutwardId || null,
      outward_voucher_no: primaryOutwardVoucherNo || "",
      amount,
      adjusted_amount: adjustedTotal,
      advance_amount: advanceAmount,
      on_account_amount: onAccountAmount,
      payment_method: paymentMethod,
      fund_source: text(body.fund_source) || "main_cash",
      narration: text(body.narration),
      adjustments: cleanAdjustments,
      created_by: Number(req.user?.id) || null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    try {
      const cashEntry = await CashEntry.create({
        id: cashEntryId,
        voucher_no: voucherNo,
        entry_date: new Date(`${date}T00:00:00`),
        entry_type: "expense",
        warehouse_id: primaryWarehouse || null,
        company_id: null,
        company_account_id: null,
        description: `Transport Payment - ${transporter?.name || "Transporter"}`,
        amount,
        payment_method: paymentMethod,
        reference_no: voucherNo,
        narration: text(body.narration) || "Transport Payment",
        created_by: Number(req.user?.id) || null,
        employee_id: null,
        fund_source: text(body.fund_source) || "main_cash",
        status: "posted",
        linked_entry_id: paymentDoc._id,
        source_expense_id: `transport_payment:${paymentId}`,
        created_at: new Date(),
        updated_at: new Date(),
      });

      await PaymentEntry.updateOne(
        { _id: paymentDoc._id },
        { $set: { cash_entry_id: cashEntry?._id ? String(cashEntry._id) : String(cashEntryId) } }
      );
    } catch (cashErr) {
      await PaymentEntry.deleteOne({ _id: paymentDoc._id });
      throw cashErr;
    }

    return res.status(201).json({
      message: "Transport payment saved successfully",
      id: paymentId,
      voucher_no: voucherNo,
      payment_id: String(paymentDoc._id),
      transporter_name: transporter?.name || "",
      amount,
      adjusted_amount: adjustedTotal,
      advance_amount: advanceAmount,
      on_account_amount: onAccountAmount,
    });
  } catch (err) {
    console.error("Transport payment save failed:", err);
    return res.status(500).json({ error: err.message || "Failed to save transport payment" });
  }
});

module.exports = router;
