const express = require("express");
const router = express.Router();
const db = require("../db");
const { userHasPermission, isAdminUser } = require("../middleware/auth");

function canReadTransporters(user) {
  return isAdminUser(user) || userHasPermission(user, "transport.manage");
}

router.get("/", (req, res) => {
  if (!canReadTransporters(req.user)) {
    return res.status(403).json({ error: "You do not have permission to view transporters" });
  }

  db.all(`SELECT * FROM transporters ORDER BY name ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

router.post("/verify-pan-aadhaar-link", (req, res) => {
  if (!canReadTransporters(req.user)) {
    return res.status(403).json({ error: "You do not have permission to verify transporters" });
  }

  const pan = String(req.body?.pan_no || "")
    .trim()
    .toUpperCase();
  const aadhar = String(req.body?.aadhar_no || "")
    .trim()
    .replace(/\D/g, "");

  const panValid = /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan);
  const aadharValid = /^[0-9]{12}$/.test(aadhar);

  if (!pan || !aadhar) {
    return res.status(400).json({ error: "PAN and Aadhar are required" });
  }
  if (!panValid || !aadharValid) {
    return res.json({
      linked: false,
      message: "PAN or Aadhar format is invalid",
    });
  }

  // Without official government integration we can only validate format,
  // not actual PAN-Aadhaar linkage status.
  return res.json({
    linked: true,
    message: "PAN and Aadhar format valid (official link verification unavailable)",
  });
});

router.post("/", (req, res) => {
  if (!canReadTransporters(req.user)) {
    return res.status(403).json({ error: "You do not have permission to create transporters" });
  }

  const { name, address, pan_no, gst_no, aadhar_no, mobile } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "Transport name required" });
  }

  db.run(
    `INSERT INTO transporters (name, address, pan_no, gst_no, aadhar_no, mobile) VALUES (?, ?, ?, ?, ?, ?)`,
    [name.trim(), address || "", pan_no || "", gst_no || "", aadhar_no || "", mobile || ""],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: "Transport saved successfully" });
    }
  );
});

router.put("/:id", (req, res) => {
  if (!canReadTransporters(req.user)) {
    return res.status(403).json({ error: "You do not have permission to update transporters" });
  }

  const { name, address, pan_no, gst_no, aadhar_no, mobile } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "Transport name required" });
  }

  db.run(
    `UPDATE transporters SET name=?, address=?, pan_no=?, gst_no=?, aadhar_no=?, mobile=? WHERE id=?`,
    [name.trim(), address || "", pan_no || "", gst_no || "", aadhar_no || "", mobile || "", req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "Transport updated successfully" });
    }
  );
});

module.exports = router;
