const express = require("express");
const router = express.Router();
const { userHasPermission } = require("../middleware/auth");
const {
  mongoose,
  BuyerAdjustment,
  Outward,
  Warehouse,
  Product,
  Company,
  CompanyAccount,
  BuyerName,
} = require("../db-mongodb");

const safeNumber = (v) => (v === undefined || v === null || v === "" ? 0 : Number(v));
const safeText = (v) => (v ? String(v) : null);

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ""));
}

function normalizeDateValue(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function toDateKey(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function makeAdjustmentSignature(row) {
  return [
    String(row?.outward_id ?? "").trim(),
    String(row?.buyer_id ?? "").trim(),
    String(row?.buyer_name ?? "").trim().toLowerCase(),
    String(row?.consignee_name ?? "").trim().toLowerCase(),
    toDateKey(row?.unloading_date),
    String(Number(row?.weight || 0)),
    String(Number(row?.qty || 0)),
    String(Number(row?.rate || 0)),
    String(Number(row?.claim || 0)),
    String(Number(row?.other_deduction || 0)),
    String(Number(row?.shortage || 0)),
    String(Number(row?.shortage_amount || 0)),
    String(row?.status || "Pending").trim().toLowerCase(),
  ].join("|");
}

function dedupeAdjustments(rows) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const signature = makeAdjustmentSignature(row);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

async function hydrateBuyerAdjustment(row) {
  if (!row) return null;

  const outward = row.outward_id ? await Outward.findOne({ id: Number(row.outward_id) }).lean().catch(() => null) : null;
  const buyer = row.buyer_id ? await BuyerName.findOne({ id: Number(row.buyer_id) }).lean().catch(() => null) : null;
  const warehouse = outward?.warehouse_id ? await Warehouse.findOne({ id: Number(outward.warehouse_id) }).lean().catch(() => null) : null;
  const product = outward?.product_id ? await Product.findOne({ id: Number(outward.product_id) }).lean().catch(() => null) : null;
  const company = outward?.company_id ? await Company.findOne({ id: Number(outward.company_id) }).lean().catch(() => null) : null;
  const account = outward?.company_account_id ? await CompanyAccount.findOne({ id: Number(outward.company_account_id) }).lean().catch(() => null) : null;

  const buyerName = row.buyer_name || buyer?.name || "";
  const consigneeName = row.consignee_name || outward?.consignee_name || "";

  return {
    id: row._id?.toString(),
    outward_id: row.outward_id,
    buyer_id: row.buyer_id ?? null,
    buyer_name: buyerName,
    consignee_name: consigneeName,
    unloading_date: row.unloading_date ? new Date(row.unloading_date).toISOString().slice(0, 10) : "",
    weight: Number(row.weight || 0),
    qty: Number(row.qty || 0),
    rate: Number(row.rate || 0),
    claim: Number(row.claim || 0),
    other_deduction: Number(row.other_deduction || 0),
    shortage: Number(row.shortage || 0),
    shortage_amount: Number(row.shortage_amount || 0),
    status: row.status || "Pending",
    created_at: row.createdAt || row.created_at || null,
    updated_at: row.updatedAt || row.updated_at || null,
    outward: outward
      ? {
          ...outward,
          employee_name: outward.employee_name || "",
          location_name: outward.location_name || "",
          warehouse_name: warehouse?.name || outward.warehouse_name || "",
          product_name: product?.name || outward.product_name || "",
          company_name: company?.name || outward.company_name || "",
          account_name: account?.account_name || outward.account_name || "",
          party_name: account?.account_name || buyerName || outward.party_name || "",
        }
      : null,
    warehouse_name: warehouse?.name || "",
    product_name: product?.name || "",
    company_name: company?.name || "",
    account_name: account?.account_name || "",
    party_name: account?.account_name || buyerName || "",
  };
}

// Get outward entries without unloading details (no buyer adjustments)
router.get("/without-unloading", async (req, res) => {
  if (!userHasPermission(req.user, "outward.view") && !userHasPermission(req.user, "outward.create")) {
    return res.status(403).json({ error: "You do not have permission to view outward entries" });
  }

  try {
    const adjustedOutwardIds = await BuyerAdjustment.distinct("outward_id").catch(() => []);
    const query = { status: { $in: ["Pending", "Partial"] } };
    if (Array.isArray(adjustedOutwardIds) && adjustedOutwardIds.length > 0) {
      query.id = { $nin: adjustedOutwardIds.map((id) => Number(id)).filter(Number.isFinite) };
    }

    const rows = await Outward.find(query).sort({ createdAt: -1, _id: -1 }).lean();
    const hydrated = await Promise.all((rows || []).map(async (outward) => {
      const warehouse = outward.warehouse_id ? await Warehouse.findOne({ id: Number(outward.warehouse_id) }).lean().catch(() => null) : null;
      const product = outward.product_id ? await Product.findOne({ id: Number(outward.product_id) }).lean().catch(() => null) : null;
      const company = outward.company_id ? await Company.findOne({ id: Number(outward.company_id) }).lean().catch(() => null) : null;
      const account = outward.company_account_id ? await CompanyAccount.findOne({ id: Number(outward.company_account_id) }).lean().catch(() => null) : null;
      return {
        ...outward,
        employee_name: outward.employee_name || "",
        location_name: outward.location_name || "",
        warehouse_name: warehouse?.name || outward.warehouse_name || "",
        product_name: product?.name || outward.product_name || "",
        company_name: company?.name || outward.company_name || "",
        account_name: account?.account_name || outward.account_name || "",
        party_name: account?.account_name || outward.party_name || "",
      };
    }));

    return res.json(hydrated);
  } catch (err) {
    console.error("Error fetching outward entries:", err);
    return res.status(500).json({ error: "Database error: " + err.message });
  }
});

// Get outward entries that already have buyer adjustments
router.get("/with-adjustments", async (req, res) => {
  if (!userHasPermission(req.user, "outward.view") && !userHasPermission(req.user, "outward.create")) {
    return res.status(403).json({ error: "You do not have permission to view outward entries" });
  }

  try {
    const adjustments = await BuyerAdjustment.find().sort({ createdAt: -1, _id: -1 }).lean();
    const rows = await Promise.all(dedupeAdjustments(adjustments).map((row) => hydrateBuyerAdjustment(row)));
    return res.json(rows.filter(Boolean));
  } catch (err) {
    console.error("Error fetching outward entries with buyer adjustments:", err);
    return res.status(500).json({ error: "Database error: " + err.message });
  }
});

// Get buyer adjustments for a specific outward
router.get("/:outwardId", async (req, res) => {
  if (!userHasPermission(req.user, "outward.view")) {
    return res.status(403).json({ error: "You do not have permission" });
  }

  const outwardId = Number(req.params.outwardId);
  if (!Number.isFinite(outwardId)) {
    return res.json([]);
  }

  try {
    const rows = await BuyerAdjustment.find({ outward_id: outwardId }).sort({ createdAt: -1, _id: -1 }).lean();
    const hydrated = await Promise.all(dedupeAdjustments(rows).map((row) => hydrateBuyerAdjustment(row)));
    return res.json(hydrated.filter(Boolean));
  } catch (err) {
    console.error("Error fetching buyer adjustments:", err);
    return res.status(500).json({ error: "Database error" });
  }
});

// Create buyer adjustment
router.post("/", async (req, res) => {
  if (!userHasPermission(req.user, "adjustment.manage")) {
    return res.status(403).json({ error: "You do not have permission to create adjustments" });
  }

  const {
    outward_id,
    buyer_id,
    buyer_name,
    consignee_name,
    unloading_date,
    weight,
    qty,
    rate,
    claim,
    other_deduction,
    shortage,
    shortage_amount,
    status,
  } = req.body;

  if (!outward_id || !qty) {
    return res.status(400).json({ error: "Missing required fields: outward_id, qty" });
  }

  try {
    const signature = makeAdjustmentSignature({
      outward_id: safeNumber(outward_id),
      buyer_id: safeNumber(buyer_id) || null,
      buyer_name: safeText(buyer_name),
      consignee_name: safeText(consignee_name),
      unloading_date: normalizeDateValue(unloading_date),
      weight: safeNumber(weight),
      qty: safeNumber(qty),
      rate: safeNumber(rate),
      claim: safeNumber(claim),
      other_deduction: safeNumber(other_deduction),
      shortage: safeNumber(shortage),
      shortage_amount: safeNumber(shortage_amount),
      status: safeText(status) || "Pending",
    });

    const existing = await BuyerAdjustment.find({ outward_id: safeNumber(outward_id) }).sort({ createdAt: -1, _id: -1 }).lean();
    const duplicate = (existing || []).find((row) => makeAdjustmentSignature(row) === signature);
    if (duplicate) {
      await BuyerAdjustment.updateOne(
        { _id: duplicate._id },
        {
          $set: {
            buyer_id: safeNumber(buyer_id) || null,
            buyer_name: safeText(buyer_name),
            consignee_name: safeText(consignee_name),
            unloading_date: normalizeDateValue(unloading_date),
            weight: safeNumber(weight),
            qty: safeNumber(qty),
            rate: safeNumber(rate),
            claim: safeNumber(claim),
            other_deduction: safeNumber(other_deduction),
            shortage: safeNumber(shortage),
            shortage_amount: safeNumber(shortage_amount),
            status: safeText(status) || "Pending",
          },
        }
      );
      return res.json({ id: duplicate._id?.toString(), message: "Buyer adjustment saved successfully" });
    }

    const doc = await BuyerAdjustment.create({
      outward_id: safeNumber(outward_id),
      buyer_id: safeNumber(buyer_id) || null,
      buyer_name: safeText(buyer_name),
      consignee_name: safeText(consignee_name),
      unloading_date: normalizeDateValue(unloading_date),
      weight: safeNumber(weight),
      qty: safeNumber(qty),
      rate: safeNumber(rate),
      claim: safeNumber(claim),
      other_deduction: safeNumber(other_deduction),
      shortage: safeNumber(shortage),
      shortage_amount: safeNumber(shortage_amount),
      status: safeText(status) || "Pending",
    });

    return res.json({ id: doc._id?.toString(), message: "Buyer adjustment created successfully" });
  } catch (err) {
    console.error("Error creating buyer adjustment:", err);
    return res.status(500).json({ error: "Failed to create buyer adjustment" });
  }
});

// Update buyer adjustment
router.put("/:id", async (req, res) => {
  if (!userHasPermission(req.user, "adjustment.manage")) {
    return res.status(403).json({ error: "You do not have permission to update adjustments" });
  }

  const { id } = req.params;
  const {
    buyer_id,
    buyer_name,
    consignee_name,
    unloading_date,
    weight,
    qty,
    rate,
    claim,
    other_deduction,
    shortage,
    shortage_amount,
    status,
  } = req.body;

  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: "Invalid adjustment id" });
  }

  try {
    await BuyerAdjustment.updateOne(
      { _id: id },
      {
        $set: {
          buyer_id: safeNumber(buyer_id) || null,
          buyer_name: safeText(buyer_name),
          consignee_name: safeText(consignee_name),
          unloading_date: normalizeDateValue(unloading_date),
          weight: safeNumber(weight),
          qty: safeNumber(qty),
          rate: safeNumber(rate),
          claim: safeNumber(claim),
          other_deduction: safeNumber(other_deduction),
          shortage: safeNumber(shortage),
          shortage_amount: safeNumber(shortage_amount),
          status: safeText(status) || "Pending",
        },
      }
    );

    return res.json({ message: "Buyer adjustment updated successfully" });
  } catch (err) {
    console.error("Error updating buyer adjustment:", err);
    return res.status(500).json({ error: "Failed to update buyer adjustment" });
  }
});

// Delete buyer adjustment
router.delete("/:id", async (req, res) => {
  if (!userHasPermission(req.user, "adjustment.manage")) {
    return res.status(403).json({ error: "You do not have permission to delete adjustments" });
  }

  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: "Invalid adjustment id" });
  }

  try {
    await BuyerAdjustment.deleteOne({ _id: id });
    return res.json({ message: "Buyer adjustment deleted successfully" });
  } catch (err) {
    console.error("Error deleting buyer adjustment:", err);
    return res.status(500).json({ error: "Failed to delete buyer adjustment" });
  }
});

module.exports = router;
