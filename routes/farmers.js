const express = require("express");
const https = require("https");
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

const cleanText = (value) => {
  const text = String(value || "").trim();
  return text ? text : null;
};

const compactUpper = (value) => String(value || "").replace(/\s/g, "").toUpperCase();
const compactDigits = (value) => String(value || "").replace(/\D/g, "");
const isValidPan = (value) => !value || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(value);
const isValidAadhar = (value) => !value || /^[0-9]{12}$/.test(value);
const isValidGst = (value) =>
  !value || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value);

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 10000 }, (response) => {
      let raw = "";
      response.on("data", (chunk) => {
        raw += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Lookup failed with status ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("Lookup timed out"));
    });
    request.on("error", reject);
  });
}

function buildFarmerPayload(body) {
  const panNo = compactUpper(body.pan_no);
  const gstNo = compactUpper(body.gst_no);
  const aadharNo = compactDigits(body.aadhar_no);
  const pincode = compactDigits(body.pincode);
  const ifscCode = compactUpper(body.ifsc_code);

  if (!isValidPan(panNo)) {
    return { error: "Invalid PAN No. format" };
  }
  if (!isValidAadhar(aadharNo)) {
    return { error: "Invalid Aadhaar No. format" };
  }
  if (!/^[0-9]{6}$/.test(pincode)) {
    return { error: "PIN No. is required and must be 6 digits" };
  }
  if (!isValidGst(gstNo)) {
    return { error: "Invalid GST No. format" };
  }
  if (gstNo && panNo && gstNo.slice(2, 12) !== panNo) {
    return { error: "GST No. PAN part does not match PAN No." };
  }
  if (ifscCode && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) {
    return { error: "Invalid IFSC Code format" };
  }

  return {
    payload: {
      name: String(body.name || "").trim(),
      mobile: String(body.mobile || "").trim(),
      email: cleanText(body.email),
      address: cleanText(body.address),
      village: cleanText(body.village),
      pincode,
      state: cleanText(body.state),
      district: cleanText(body.district),
      city: cleanText(body.city),
      room_floor_building: cleanText(body.room_floor_building),
      street_locality_landmark: cleanText(body.street_locality_landmark),
      gst_no: gstNo || null,
      pan_no: panNo || null,
      aadhar_no: aadharNo || null,
      aadhaar_pan_link_status: ["linked", "not_linked", "unknown"].includes(body.aadhaar_pan_link_status)
        ? body.aadhaar_pan_link_status
        : "unknown",
      bank_name: cleanText(body.bank_name),
      bank_account_no: compactDigits(body.bank_account_no) || null,
      ifsc_code: ifscCode || null,
      branch_name: cleanText(body.branch_name),
      account_holder_name: cleanText(body.account_holder_name),
      location: cleanText(body.location),
    },
  };
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

router.get("/lookup/pincode/:pincode", async (req, res) => {
  try {
    const pincode = compactDigits(req.params.pincode);
    if (!/^[0-9]{6}$/.test(pincode)) {
      return res.status(400).json({ error: "PIN No. must be 6 digits" });
    }

    const result = await fetchJson(`https://api.postalpincode.in/pincode/${pincode}`);
    const item = Array.isArray(result) ? result[0] : null;
    const postOffice = item?.PostOffice?.[0];
    if (!postOffice) {
      return res.status(404).json({ error: "PIN not found" });
    }

    res.json({
      location: postOffice.District || postOffice.Block || "",
      state: postOffice.State || "",
      village: postOffice.Name || "",
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "PIN lookup failed" });
  }
});

router.get("/lookup/ifsc/:ifsc", async (req, res) => {
  try {
    const ifsc = compactUpper(req.params.ifsc);
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
      return res.status(400).json({ error: "Invalid IFSC Code format" });
    }

    const data = await fetchJson(`https://ifsc.razorpay.com/${ifsc}`);
    res.json({
      bank_name: data?.BANK || "",
      branch_name: data?.BRANCH || "",
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "IFSC lookup failed" });
  }
});

router.post("/", async (req, res) => {
  try {
    if (!canManageFarmers(req.user, "create")) {
      return res.status(403).json({
        error: "You do not have permission to manage farmers",
      });
    }

    const { name, mobile, pincode } = req.body;

    if (!name || !mobile || !pincode) {
      return res.status(400).json({
        error: "Farmer name, mobile and PIN No. are required",
      });
    }

    const built = buildFarmerPayload(req.body);
    if (built.error) return res.status(400).json({ error: built.error });

    const farmer = await Farmer.create(built.payload);

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

    const { name, mobile, pincode } = req.body;

    if (!name || !mobile || !pincode) {
      return res.status(400).json({
        error: "Farmer name, mobile and PIN No. are required",
      });
    }

    const built = buildFarmerPayload(req.body);
    if (built.error) return res.status(400).json({ error: built.error });

    const updated = await Farmer.findByIdAndUpdate(req.params.id, built.payload, { new: true });

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
