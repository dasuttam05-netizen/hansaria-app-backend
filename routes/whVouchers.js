const express = require("express");
const router = express.Router();
const db = require("../db");
const { userHasPermission } = require("../middleware/auth");
const { assignedWarehouseFilter, canAccessWarehouse } = require("../helpers/access");
const PDFDocument = require('pdfkit');
const {
  mongoose,
  PurchaseVoucher,
  Warehouse,
  Farmer,
  Product,
  CompanyAccount,
} = require("../mongo");

function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function fmtNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

function getWarehouseScopedRows(req, res, tableName, orderBy = "date DESC") {
  const filter = assignedWarehouseFilter(req.user, "v.warehouse_id");
  const query = `
    SELECT v.*, ca.account_name AS company_account_name
    FROM ${tableName} v
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
    WHERE 1 = 1 ${filter.clause}
    ORDER BY v.${orderBy}
  `;
  db.all(query, filter.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
}

const mongoReady = () => mongoose.connection.readyState === 1;

const numberFields = [
  "quantity",
  "rate",
  "amount",
  "packet",
  "gross_weight",
  "tare_weight",
  "dhalta",
  "less_bags_weight",
  "moisture",
  "dunki",
  "fungus",
  "discolour",
  "others",
  "net_weight",
  "bags_claim",
  "labour",
  "total_deduct_amount",
  "total_qty",
  "total_deduction",
  "round_off",
  "net_amount_payable",
];

function buildPurchasePayload(body, voucherNo) {
  const payload = {
    voucher_no: voucherNo || body.voucher_no,
    date: body.date,
    warehouse_id: body.warehouse_id ? String(body.warehouse_id) : "",
    farmer_id: body.farmer_id ? String(body.farmer_id) : "",
    company_account_id: body.company_account_id ? String(body.company_account_id) : "",
    product_id: body.product_id ? String(body.product_id) : "",
    employee_id: body.employee_id ? String(body.employee_id) : "",
    location_id: body.location_id ? String(body.location_id) : "",
    description: body.description || "",
  };

  numberFields.forEach((field) => {
    const value = Number(body[field]);
    payload[field] = Number.isFinite(value) ? value : 0;
  });

  return payload;
}

function assignedWarehouseIdsForMongo(user) {
  const ids = user?.assigned_warehouse_ids || user?.assigned_sqlite_warehouse_ids || [];
  return ids.map((id) => String(id));
}

function mongoPurchaseScope(user) {
  if (!user || user.role === "admin" || userHasPermission(user, "warehouses.manage")) {
    return {};
  }

  const ids = assignedWarehouseIdsForMongo(user);
  if (ids.length === 0) return { _id: null };
  return { warehouse_id: { $in: ids } };
}

async function nextMongoVoucherNo(type) {
  const shortPrefix = getVoucherPrefix(type);
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `${shortPrefix}-${datePart}-`;
  const latest = await PurchaseVoucher.findOne({ voucher_no: new RegExp(`^${shortPrefix}-`) })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  let next = 1;
  if (latest?.voucher_no) {
    const pieces = String(latest.voucher_no).split("-");
    const last = Number(pieces[pieces.length - 1]);
    if (Number.isFinite(last) && last >= 1) next = last + 1;
  }
  return `${prefix}${String(next).padStart(4, "0")}`;
}

function mongoIdFilter(id) {
  const value = String(id || "");
  return mongoose.Types.ObjectId.isValid(value) ? { _id: value } : null;
}

async function decoratePurchaseRows(rows) {
  const warehouseIds = [...new Set(rows.map((r) => r.warehouse_id).filter(mongoose.Types.ObjectId.isValid))];
  const farmerIds = [...new Set(rows.map((r) => r.farmer_id).filter(mongoose.Types.ObjectId.isValid))];
  const productIds = [...new Set(rows.map((r) => r.product_id).filter(mongoose.Types.ObjectId.isValid))];
  const accountIds = [...new Set(rows.map((r) => r.company_account_id).filter(mongoose.Types.ObjectId.isValid))];

  const [warehouses, farmers, products, accounts] = await Promise.all([
    warehouseIds.length ? Warehouse.find({ _id: { $in: warehouseIds } }).lean() : [],
    farmerIds.length ? Farmer.find({ _id: { $in: farmerIds } }).lean() : [],
    productIds.length ? Product.find({ _id: { $in: productIds } }).lean() : [],
    accountIds.length ? CompanyAccount.find({ _id: { $in: accountIds } }).lean() : [],
  ]);

  const byId = (items) => new Map(items.map((item) => [String(item._id), item]));
  const warehouseMap = byId(warehouses);
  const farmerMap = byId(farmers);
  const productMap = byId(products);
  const accountMap = byId(accounts);

  return rows.map((row) => {
    const plain = row.toObject ? row.toObject() : row;
    const warehouse = warehouseMap.get(String(plain.warehouse_id));
    const farmer = farmerMap.get(String(plain.farmer_id));
    const product = productMap.get(String(plain.product_id));
    const account = accountMap.get(String(plain.company_account_id));
    return {
      ...plain,
      id: String(plain._id),
      _id: String(plain._id),
      warehouse_name: warehouse?.name || plain.warehouse_name,
      farmer_name: farmer?.name || plain.farmer_name,
      product_name: product?.name || plain.product_name,
      company_account_name: account?.account_name || plain.company_account_name,
      total_quantity: plain.total_qty || plain.net_weight || plain.quantity || 0,
      total_amount: plain.net_amount_payable || plain.amount || 0,
      gross_amount: (plain.total_qty || plain.net_weight || plain.quantity || 0) * (plain.rate || 0),
    };
  });
}

function getSqlitePurchaseRows(req) {
  const filter = assignedWarehouseFilter(req.user, "v.warehouse_id");
  const fallbackFilter = assignedWarehouseFilter(req.user, "warehouse_id");
  const query = `
    SELECT
      v.*,
      (SELECT name FROM products WHERE CAST(id AS TEXT) = CAST(v.product_id AS TEXT) LIMIT 1) AS product_name,
      (SELECT name FROM warehouses WHERE CAST(id AS TEXT) = CAST(v.warehouse_id AS TEXT) LIMIT 1) AS warehouse_name,
      (SELECT name FROM farmers WHERE CAST(id AS TEXT) = CAST(v.farmer_id AS TEXT) LIMIT 1) AS farmer_name,
      ca.account_name AS company_account_name
    FROM wh_purchase_vouchers v
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
    WHERE 1 = 1 ${filter.clause}
    ORDER BY v.date DESC, v.id DESC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, filter.params, (err, rows) => {
      if (!err) {
        resolve(rows || []);
        return;
      }

      console.error("Purchase voucher mapped query failed, falling back to base rows:", err.message);
      const fallbackQuery = `
        SELECT *
        FROM wh_purchase_vouchers
        WHERE 1 = 1 ${fallbackFilter.clause}
        ORDER BY date DESC, id DESC
      `;
      db.all(fallbackQuery, fallbackFilter.params, (fallbackErr, fallbackRows) => {
        if (fallbackErr) {
          reject(fallbackErr);
          return;
        }
        resolve(fallbackRows || []);
      });
    });
  });
}

function mergePurchaseRows(mongoRows, sqliteRows) {
  const mongoByVoucherNo = new Map();
  const merged = [];

  for (const row of mongoRows) {
    const key = String(row.voucher_no || row._id || "");
    if (key) mongoByVoucherNo.set(key, row);
    merged.push(row);
  }

  for (const row of sqliteRows) {
    const key = String(row.voucher_no || row.id || "");
    if (!key || !mongoByVoucherNo.has(key)) {
      merged.push(row);
    }
  }

  return merged.sort((a, b) => {
    const dateA = new Date(a.date || a.created_at || 0).getTime();
    const dateB = new Date(b.date || b.created_at || 0).getTime();
    if (dateA !== dateB) return dateB - dateA;
    const voucherA = String(a.voucher_no || a.id || a._id || "");
    const voucherB = String(b.voucher_no || b.id || b._id || "");
    return voucherB.localeCompare(voucherA, undefined, { numeric: true, sensitivity: "base" });
  });
}

async function getAllPurchaseVoucherRows(req) {
  const mongoRows = await PurchaseVoucher.find(mongoPurchaseScope(req.user)).lean();
  const sqliteRows = await getSqlitePurchaseRows(req);
  return mergePurchaseRows(
    await decoratePurchaseRows(mongoRows),
    sqliteRows
  );
}

function getPurchaseVoucherRows(req, res) {
  if (mongoReady()) {
    getAllPurchaseVoucherRows(req)
      .then((rows) => res.json(rows || []))
      .catch((err) => {
        console.error("Mongo purchase voucher query failed, falling back to SQLite:", err.message);
        getPurchaseVoucherRowsSqlite(req, res);
      });
    return;
  }

  getPurchaseVoucherRowsSqlite(req, res);
}

function getPurchaseVoucherRowsSqlite(req, res) {
  const filter = assignedWarehouseFilter(req.user, "v.warehouse_id");
  const fallbackFilter = assignedWarehouseFilter(req.user, "warehouse_id");
  const query = `
    SELECT
      v.*,
      (SELECT name FROM products WHERE CAST(id AS TEXT) = CAST(v.product_id AS TEXT) LIMIT 1) AS product_name,
      (SELECT name FROM warehouses WHERE CAST(id AS TEXT) = CAST(v.warehouse_id AS TEXT) LIMIT 1) AS warehouse_name,
      (SELECT name FROM farmers WHERE CAST(id AS TEXT) = CAST(v.farmer_id AS TEXT) LIMIT 1) AS farmer_name,
      ca.account_name AS company_account_name
    FROM wh_purchase_vouchers v
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
    WHERE 1 = 1 ${filter.clause}
    ORDER BY v.date DESC, v.id DESC
  `;

  db.all(query, filter.params, (err, rows) => {
    if (!err) {
      return res.json(rows || []);
    }

    console.error("Purchase voucher mapped query failed, falling back to base rows:", err.message);
    const fallbackQuery = `
      SELECT *
      FROM wh_purchase_vouchers
      WHERE 1 = 1 ${fallbackFilter.clause}
      ORDER BY date DESC, id DESC
    `;
    db.all(fallbackQuery, fallbackFilter.params, (fallbackErr, fallbackRows) => {
      if (fallbackErr) return res.status(500).json({ error: fallbackErr.message });
      res.json(fallbackRows || []);
    });
  });
}

function ensureWarehouseAccess(req, res, warehouseId) {
  if (!warehouseId) {
    res.status(400).json({ error: "Warehouse is required" });
    return false;
  }

  if (!canAccessWarehouse(req.user, warehouseId)) {
    res.status(403).json({ error: "You do not have access to this warehouse" });
    return false;
  }

  return true;
}

async function getMongoPurchaseVoucherForPdf(id) {
  const filter = mongoIdFilter(id);
  if (!filter || !mongoReady()) return null;

  const row = await PurchaseVoucher.findOne(filter).lean();
  if (!row) return null;

  const [warehouse, farmer, product, account] = await Promise.all([
    row.warehouse_id && mongoose.Types.ObjectId.isValid(row.warehouse_id)
      ? Warehouse.findById(row.warehouse_id).lean()
      : null,
    row.farmer_id && mongoose.Types.ObjectId.isValid(row.farmer_id)
      ? Farmer.findById(row.farmer_id).lean()
      : null,
    row.product_id && mongoose.Types.ObjectId.isValid(row.product_id)
      ? Product.findById(row.product_id).lean()
      : null,
    row.company_account_id && mongoose.Types.ObjectId.isValid(row.company_account_id)
      ? CompanyAccount.findById(row.company_account_id).lean()
      : null,
  ]);

  return {
    ...row,
    id: String(row._id),
    warehouse_name: warehouse?.name || row.warehouse_name,
    warehouse_address: warehouse?.address || row.warehouse_address,
    warehouse_location: warehouse?.location || row.warehouse_location,
    farmer_name: farmer?.name || row.farmer_name,
    farmer_mobile: farmer?.mobile || row.farmer_mobile,
    farmer_address: farmer?.address || row.farmer_address,
    farmer_village: farmer?.village || row.farmer_village,
    farmer_gst: farmer?.gst_no || row.farmer_gst,
    farmer_pan: farmer?.pan_no || row.farmer_pan,
    farmer_state: farmer?.state || row.farmer_state,
    farmer_bank_name: farmer?.bank_name || row.farmer_bank_name,
    farmer_bank_account_no: farmer?.bank_account_no || row.farmer_bank_account_no,
    farmer_ifsc_code: farmer?.ifsc_code || row.farmer_ifsc_code,
    farmer_branch_name: farmer?.branch_name || row.farmer_branch_name,
    farmer_account_holder_name: farmer?.account_holder_name || row.farmer_account_holder_name,
    product_name: product?.name || row.product_name,
    company_account_name: account?.account_name || row.company_account_name,
    company_account_mobile: account?.mobile || row.company_account_mobile,
    company_account_pan: account?.pan_no || row.company_account_pan,
    company_account_address: account?.address || row.company_account_address,
  };
}

async function enrichPurchaseVoucherPdfRow(row) {
  if (!row || !mongoReady()) return row;
  const farmerId = String(row.farmer_id || "");
  if (!mongoose.Types.ObjectId.isValid(farmerId)) return row;

  const farmer = await Farmer.findById(farmerId).lean();
  if (!farmer) return row;

  return {
    ...row,
    farmer_name: row.farmer_name || farmer.name,
    farmer_mobile: row.farmer_mobile || farmer.mobile,
    farmer_address: row.farmer_address || farmer.address,
    farmer_village: row.farmer_village || farmer.village,
    farmer_gst: row.farmer_gst || farmer.gst_no,
    farmer_pan: row.farmer_pan || farmer.pan_no,
    farmer_state: row.farmer_state || farmer.state,
    farmer_bank_name: row.farmer_bank_name || farmer.bank_name,
    farmer_bank_account_no: row.farmer_bank_account_no || farmer.bank_account_no,
    farmer_ifsc_code: row.farmer_ifsc_code || farmer.ifsc_code,
    farmer_branch_name: row.farmer_branch_name || farmer.branch_name,
    farmer_account_holder_name: row.farmer_account_holder_name || farmer.account_holder_name,
  };
}

function sendPurchaseVoucherPdf(res, row, id) {
  const doc = new PDFDocument({ size: "A4", margin: 28 });
  res.setHeader("Content-Type", "application/pdf");
  const safeName = String(row.voucher_no || id).replace(/[/\\?%*:|"<>]/g, "-");
  res.setHeader("Content-Disposition", `attachment; filename="purchase_${safeName}.pdf"`);
  doc.pipe(res);

  const pageW = doc.page.width;
  const contentW = pageW - 56;
  const primary = "#0f2f63";
  const accent = "#ea580c";
  const muted = "#64748b";
  const border = "#cbd5e1";
  const light = "#f8fafc";
  const x = 28;
  let y = 28;
  const accountName = row.company_account_name || "SHIVANSH";
  const accountAddress = row.company_account_address || row.warehouse_address || "-";
  const warehouseLine = [row.warehouse_name, row.warehouse_location].filter(Boolean).join(" - ");
  const netQty = row.total_qty || row.net_weight || row.quantity || 0;
  const grossAmount = Number(netQty || 0) * Number(row.rate || 0);
  const netPayable = row.net_amount_payable || row.amount || 0;
  const fmt4 = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(4) : "0.0000";
  };

  const labelValue = (label, value, tx, ty, width = 120) => {
    doc.fillColor("#111827").fontSize(8.4).text(label, tx, ty, { width: width * 0.45 });
    doc.fillColor(muted).text(":", tx + width * 0.45, ty);
    doc.fillColor("#111827").text(value || "-", tx + width * 0.52, ty, { width: width * 0.48 });
  };

  doc.rect(x - 10, y - 10, contentW + 20, 760).lineWidth(2).stroke(primary);

  doc.circle(x + 28, y + 28, 24).lineWidth(2).stroke(accent);
  doc.fillColor(primary).fontSize(25).text(accountName, x + 66, y + 13, { width: 285 });
  doc.fillColor(accent).fontSize(7.8).text("GRAIN MERCHANT & COMMISSION AGENT", x + 70, y + 50);
  doc.fillColor(primary).fontSize(8.5).text("Phone", x + 340, y + 15);
  doc.fillColor("#111827").text(row.company_account_mobile || "9064348416 / 9304251749", x + 370, y + 15);
  doc.fillColor(primary).text("Mobile", x + 448, y + 15);
  doc.fillColor("#111827").text(row.farmer_mobile || "7004862400", x + 485, y + 15);
  doc.polygon([x + 382, y + 46], [x + contentW, y + 46], [x + contentW, y + 86], [x + 348, y + 86]).fill(primary);
  doc.fillColor("#fff").fontSize(14).text("PURCHASE MEMO", x + 388, y + 58, { width: 178, align: "center" });
  doc.fillColor("#111827").fontSize(9).text(`Location: ${warehouseLine || "-"}`, x, y + 94, { width: contentW });
  doc.moveTo(x, y + 116).lineTo(x + contentW, y + 116).stroke(border);
  y += 132;

  doc.fillColor("#111827").fontSize(10).text("Serial No.", x + 10, y);
  doc.fillColor(accent).fontSize(12).text(row.voucher_no || id, x + 85, y - 1);
  doc.fillColor("#111827").fontSize(10).text("Date", x + contentW - 130, y);
  doc.fillColor(accent).fontSize(11).text(fmtDate(row.date), x + contentW - 82, y);
  y += 30;

  const leftW = (contentW - 14) / 2;
  const rightX = x + leftW + 14;
  doc.roundedRect(x, y + 14, leftW, 96, 4).stroke(border);
  doc.roundedRect(rightX, y + 14, leftW, 96, 4).stroke(border);
  doc.rect(x, y, 210, 28).fill(primary);
  doc.polygon([x + 210, y], [x + 236, y], [x + 216, y + 28], [x + 210, y + 28]).fill(primary);
  doc.rect(rightX, y, 220, 28).fill(accent);
  doc.polygon([rightX + 220, y], [rightX + 246, y], [rightX + 226, y + 28], [rightX + 220, y + 28]).fill(accent);
  doc.fillColor("#fff").fontSize(10).text("PARTY INFORMATION", x + 55, y + 9);
  doc.text("DOCUMENT INFORMATION", rightX + 65, y + 9);

  const pStart = y + 38;
  labelValue("Name of Party", row.farmer_name, x + 10, pStart, leftW - 20);
  labelValue("PAN", row.farmer_pan, x + 10, pStart + 18, leftW - 20);
  labelValue("GSTIN", row.farmer_gst, x + 10, pStart + 36, leftW - 20);
  labelValue("Phone", row.farmer_mobile, x + 10, pStart + 54, leftW - 20);
  labelValue("Village", row.farmer_village || row.farmer_address, x + 10, pStart + 72, leftW - 20);

  labelValue("R.S.T. No.", row.reference_id || "-", rightX + 10, pStart + 8, leftW - 20);
  labelValue("Transport No.", "-", rightX + 10, pStart + 34, leftW - 20);
  labelValue("Warehouse", row.warehouse_name || row.warehouse_id, rightX + 10, pStart + 60, leftW - 20);
  y += 130;

  const remarksW = 150;
  const tableX = x + remarksW + 10;
  const tableW = contentW - remarksW - 10;
  const col1 = 42;
  const col2 = tableW - 180 - col1;
  const tableY = y;
  doc.roundedRect(x, tableY, remarksW, 244, 4).stroke(border);
  doc.rect(x, tableY, remarksW, 24).fill(primary);
  doc.fillColor("#fff").fontSize(10).text("REMARKS", x, tableY + 7, { width: remarksW, align: "center" });
  doc.fillColor("#111827").fontSize(9).text(row.description || "", x + 10, tableY + 36, { width: remarksW - 20, height: 190 });

  doc.roundedRect(tableX, tableY, tableW, 244, 4).stroke(border);
  doc.rect(tableX, tableY, tableW, 24).fill(primary);
  doc.fillColor("#fff").fontSize(10).text("", tableX + 10, tableY + 7);
  doc.text("PARTICULARS", tableX + col1 + 10, tableY + 7);
  doc.text("AMOUNT (Rs.)", tableX + col1 + col2 + 10, tableY + 7, { width: 160, align: "right" });
  y = tableY + 24;

  [
    ["1", "Product", row.product_name || row.product_id || "-"],
    ["2", "Packet", fmt4(row.packet)],
    ["3", "Gross Weight", fmt4(row.gross_weight)],
    ["4", "Tare Weight", fmt4(row.tare_weight)],
    ["5", "New Weight", fmt4(Math.max(Number(row.gross_weight || 0) - Number(row.tare_weight || 0), 0))],
    ["6", "Dhalta", fmt4(row.dhalta)],
    ["7", "Less Bags Weight", fmt4(row.less_bags_weight)],
    ["8", "Moisture", fmt4(row.moisture)],
    ["9", "Dunki / Fungus", fmt4(Number(row.dunki || 0) + Number(row.fungus || 0))],
    ["10", "Discolour / Others", fmt4(Number(row.discolour || 0) + Number(row.others || 0))],
    ["11", "Bags Claim", fmt4(row.bags_claim)],
    ["12", "Labour", fmt4(row.labour)],
    ["13", "Round Off", fmt4(row.round_off)],
  ].forEach((ln) => {
    doc.rect(tableX, y, tableW, 18).stroke(border);
    doc.fillColor("#111827").fontSize(8.8).text(ln[0], tableX + 14, y + 5);
    doc.text(ln[1], tableX + col1 + 10, y + 5);
    doc.text(ln[2], tableX + col1 + col2 + 10, y + 5, { width: 160, align: "right" });
    y += 18;
  });

  y = tableY + 258;
  const summaryW = 330;
  const totalX = x + summaryW + 10;
  const boxW = summaryW / 5;
  [
    ["PURCHASED KG.", fmt4(row.gross_weight)],
    ["MAKKA QTY.", fmt4(netQty)],
    ["BORA QTY.", fmt4(row.packet)],
    ["LABOUR CHARGES", fmt4(row.labour)],
    ["TOTAL", fmt4(grossAmount || netPayable)],
  ].forEach((item, index) => {
    const bx = x + index * boxW;
    doc.rect(bx, y, boxW, 52).stroke(border);
    doc.fillColor(primary).fontSize(7.2).text(item[0], bx + 4, y + 10, { width: boxW - 8, align: "center" });
    doc.fillColor(accent).fontSize(10).text(item[1], bx + 4, y + 32, { width: boxW - 8, align: "center" });
  });

  doc.roundedRect(totalX, y, contentW - summaryW - 10, 52, 4).stroke(border);
  labelValue("Total Qty.", fmt4(netQty), totalX + 12, y + 8, contentW - summaryW - 34);
  labelValue("Total Deductions", fmt4(row.total_deduction || row.total_deduct_amount), totalX + 12, y + 25, contentW - summaryW - 34);
  doc.rect(totalX, y + 36, contentW - summaryW - 10, 16).fill(primary);
  doc.fillColor("#fff").fontSize(8.5).text("Net Amount Payable", totalX + 12, y + 41);
  doc.fillColor("#fff").fontSize(8.5).text(fmt4(netPayable), totalX + 100, y + 41, { width: contentW - summaryW - 124, align: "right" });

  y += 68;
  doc.roundedRect(x, y, contentW, 76, 4).stroke(border);
  doc.rect(x + 58, y, 190, 22).fill(primary);
  doc.polygon([x + 248, y], [x + 270, y], [x + 252, y + 22], [x + 248, y + 22]).fill(primary);
  doc.fillColor("#fff").fontSize(10).text("ADDITIONAL DETAILS", x + 80, y + 7);
  labelValue("Bank", row.farmer_bank_name || "-", x + 12, y + 38, 160);
  labelValue("IFSC Code", row.farmer_ifsc_code || "-", x + 12, y + 58, 160);
  labelValue("Name of Party", row.farmer_account_holder_name || row.farmer_name, x + 205, y + 38, 160);
  labelValue("Branch", row.farmer_branch_name || "-", x + 205, y + 58, 160);
  labelValue("Account Number", row.farmer_bank_account_no || "-", x + 395, y + 38, 150);
  labelValue("Transport No.", "-", x + 395, y + 58, 150);

  y += 94;
  doc.roundedRect(x + 110, y, contentW - 220, 34, 3).stroke(accent);
  doc.fillColor(accent).fontSize(8).text("NOTE", x + 255, y - 6);
  doc.fillColor("#111827").fontSize(8.5).text("Buyer and Seller disputes will be resolved at village level.", x + 130, y + 11, { width: contentW - 260, align: "center" });
  y += 58;
  doc.fillColor("#111827").fontSize(9).text("Customer Signature", x + 48, y);
  doc.moveTo(x + 35, y + 22).lineTo(x + 170, y + 22).stroke(border);
  doc.text("Authorised Signature", x + contentW - 180, y);
  doc.moveTo(x + contentW - 190, y + 22).lineTo(x + contentW - 45, y + 22).stroke(border);

  doc.end();
}

function getVoucherPrefix(type) {
  const prefixMap = {
    purchase: "PUR",
    sale: "SAL",
    payment: "PAY",
    receipt: "REC",
    journal: "JRN",
  };
  return prefixMap[type] || String(type || "").toUpperCase().slice(0, 3);
}

function getVoucherTable(type) {
  const tableMap = {
    purchase: "wh_purchase_vouchers",
    sale: "wh_sale_vouchers",
    payment: "wh_payment_vouchers",
    receipt: "wh_receipt_vouchers",
    journal: "wh_journal_vouchers",
  };
  return tableMap[type];
}

function createSequentialVoucherNo(type, callback) {
  const table = getVoucherTable(type);
  if (!table) return callback(new Error("Invalid voucher type"));
  const shortPrefix = getVoucherPrefix(type);
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `${shortPrefix}-${datePart}-`;
  const query = `SELECT voucher_no FROM ${table} WHERE voucher_no LIKE ? ORDER BY id DESC LIMIT 1`;
  db.get(query, [`${shortPrefix}-%`], (err, row) => {
    if (err) return callback(err);
    let next = 1;
    if (row && row.voucher_no) {
      const pieces = String(row.voucher_no).split("-");
      const last = Number(pieces[pieces.length - 1]);
      if (Number.isFinite(last) && last >= 1) next = last + 1;
    }
    callback(null, `${prefix}${String(next).padStart(4, "0")}`);
  });
}

function computeOutstandingForFarmer(farmerId, callback, companyAccountId = null) {
  const purchaseSql = mongoReady()
    ? null
    : `SELECT COALESCE(SUM(COALESCE(NULLIF(net_amount_payable, 0), amount)), 0) AS total_purchase FROM wh_purchase_vouchers WHERE farmer_id = ?${companyAccountId ? " AND company_account_id = ?" : ""}`;
  const paymentSql = `SELECT COALESCE(SUM(amount), 0) AS total_payment FROM wh_payment_vouchers WHERE farmer_id = ?${companyAccountId ? " AND company_account_id = ?" : ""}`;
  const finish = (totalPurchase) => {
    const paymentParams = [farmerId];
    if (companyAccountId) paymentParams.push(companyAccountId);
    db.get(paymentSql, paymentParams, (err2, payment) => {
      if (err2) return callback(err2);
      const totalPayment = payment?.total_payment || 0;
      callback(null, {
        total_purchase: totalPurchase,
        total_payment: totalPayment,
        outstanding: Number((totalPurchase - totalPayment).toFixed(2)),
      });
    });
  };

  if (mongoReady()) {
    const filter = { farmer_id: String(farmerId || "") };
    if (companyAccountId) filter.company_account_id = String(companyAccountId);
    PurchaseVoucher.find(filter)
      .lean()
      .then((rows) => {
        const totalPurchase = (rows || []).reduce(
          (sum, row) => sum + Number(row.net_amount_payable || row.amount || 0),
          0
        );
        finish(totalPurchase);
      })
      .catch(callback);
    return;
  }

  const purchaseParams = [farmerId];
  if (companyAccountId) purchaseParams.push(companyAccountId);
  db.get(purchaseSql, purchaseParams, (err, purchase) => {
    if (err) return callback(err);
    finish(purchase?.total_purchase || 0);
  });
}

function computeOutstandingForCompany(companyId, callback) {
  const saleSql = `SELECT COALESCE(SUM(COALESCE(NULLIF(net_receivable_amount, 0), amount)), 0) AS total_sale FROM wh_sale_vouchers WHERE company_id = ?`;
  const receiptSql = `SELECT COALESCE(SUM(amount), 0) AS total_receipt FROM wh_receipt_vouchers WHERE company_id = ?`;
  db.get(saleSql, [companyId], (err, sale) => {
    if (err) return callback(err);
    db.get(receiptSql, [companyId], (err2, receipt) => {
      if (err2) return callback(err2);
      const totalSale = sale?.total_sale || 0;
      const totalReceipt = receipt?.total_receipt || 0;
      callback(null, {
        total_sale: totalSale,
        total_receipt: totalReceipt,
        outstanding: Number((totalSale - totalReceipt).toFixed(2)),
      });
    });
  });
}

function createVoucherNoIfMissing(type, voucherNo, callback) {
  if (voucherNo && String(voucherNo).trim()) return callback(null, voucherNo);
  if (type === "purchase" && mongoReady()) {
    nextMongoVoucherNo(type)
      .then((nextNo) => callback(null, nextNo))
      .catch((err) => callback(err));
    return;
  }
  createSequentialVoucherNo(type, callback);
}

// Idempotency helpers: prevent duplicate resource creation when client retries
function getIdempotency(key, route, cb) {
  if (!key) return cb(null, null);
  db.get(`SELECT response_id FROM idempotency_keys WHERE key = ? AND route = ?`, [key, route], (err, row) => {
    if (err) return cb(err);
    cb(null, row ? row.response_id : null);
  });
}

function saveIdempotency(key, route, responseId, cb) {
  if (!key) return cb && cb();
  db.run(
    `INSERT OR REPLACE INTO idempotency_keys (key, route, response_id, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
    [key, route, responseId],
    (err) => cb && cb(err)
  );
}

function getPaymentAdjustmentsByPurchase(callback, excludePaymentId = null) {
  const params = [];
  let excludeClause = "";
  if (excludePaymentId) {
    excludeClause = "WHERE CAST(payment_id AS TEXT) <> CAST(? AS TEXT)";
    params.push(excludePaymentId);
  }
  db.all(
    `
      SELECT purchase_id, COALESCE(SUM(adjusted_amount), 0) AS adjusted_amount
      FROM wh_payment_adjustments
      ${excludeClause}
      GROUP BY purchase_id
    `,
    params,
    (err, rows) => {
      if (err) return callback(err);
      const map = new Map();
      (rows || []).forEach((row) => {
        map.set(String(row.purchase_id), Number(row.adjusted_amount || 0));
      });
      callback(null, map);
    }
  );
}

function normalizePaymentAdjustments(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => ({
      purchase_id: String(item?.purchase_id || item?.id || "").trim(),
      adjusted_amount: Number(item?.adjusted_amount),
      voucher_no: item?.voucher_no || item?.purchase_voucher_no || "",
    }))
    .filter((item) => item.purchase_id && Number.isFinite(item.adjusted_amount) && item.adjusted_amount > 0);
}

function validatePaymentAdjustments({ farmerId, warehouseId, amount, adjustments, excludePaymentId = null }, callback) {
  const cleanAdjustments = normalizePaymentAdjustments(adjustments);
  const paymentAmount = Number(amount || 0);
  const adjustedTotal = cleanAdjustments.reduce((sum, item) => sum + item.adjusted_amount, 0);

  if (paymentAmount <= 0) {
    return callback(new Error("Payment amount is required"));
  }

  if (!cleanAdjustments.length) {
    return callback(new Error("Please adjust this payment against purchase bills"));
  }

  if (Math.abs(adjustedTotal - paymentAmount) > 0.0001) {
    return callback(new Error("Payment amount and adjustment amount must be equal"));
  }

  getPaymentAdjustmentsByPurchase((err, adjustedMap) => {
    if (err) return callback(err);

    const finish = (purchaseRows) => {
      const purchaseMap = new Map((purchaseRows || []).map((row) => [String(row.id || row._id), row]));
      for (const item of cleanAdjustments) {
        const purchase = purchaseMap.get(String(item.purchase_id));
        if (!purchase) {
          return callback(new Error("Invalid purchase adjustment target"));
        }

        const billAmount = Number(purchase.amount || purchase.net_amount_payable || purchase.total_amount || 0);
        const alreadyAdjusted = adjustedMap.get(String(item.purchase_id)) || 0;
        const pending = Math.max(0, billAmount - alreadyAdjusted);
        if (item.adjusted_amount - pending > 0.0001) {
          return callback(new Error(`Adjustment cannot exceed pending amount for ${purchase.voucher_no || item.purchase_id}`));
        }
      }

      callback(null, cleanAdjustments);
    };

    if (mongoReady()) {
      const filter = { farmer_id: String(farmerId || "") };
      if (warehouseId) filter.warehouse_id = String(warehouseId);
      PurchaseVoucher.find(filter)
        .lean()
        .then((rows) => finish((rows || []).map((row) => ({
          ...row,
          id: String(row._id),
          amount: Number(row.net_amount_payable || row.amount || 0),
        }))))
        .catch(callback);
      return;
    }

    const params = [farmerId];
    let warehouseClause = "";
    if (warehouseId) {
      warehouseClause = " AND CAST(warehouse_id AS TEXT) = CAST(? AS TEXT)";
      params.push(warehouseId);
    }
    db.all(
      `
        SELECT id, voucher_no, COALESCE(NULLIF(net_amount_payable, 0), amount) AS amount
        FROM wh_purchase_vouchers
        WHERE CAST(farmer_id AS TEXT) = CAST(? AS TEXT) ${warehouseClause}
      `,
      params,
      (rowsErr, rows) => (rowsErr ? callback(rowsErr) : finish(rows || []))
    );
  }, excludePaymentId);
}

function insertPaymentAdjustments(paymentId, adjustments, callback) {
  if (!adjustments.length) return callback();
  const stmt = "INSERT INTO wh_payment_adjustments (payment_id, purchase_id, adjusted_amount) VALUES (?, ?, ?)";
  let index = 0;
  const next = () => {
    if (index >= adjustments.length) return callback();
    const item = adjustments[index];
    index += 1;
    db.run(stmt, [paymentId, item.purchase_id, item.adjusted_amount], (err) => (err ? callback(err) : next()));
  };
  next();
}

function buildPaymentReferenceId(adjustments, purchaseRows = []) {
  const purchaseMap = new Map((purchaseRows || []).map((row) => [String(row.id || row._id), row]));
  return normalizePaymentAdjustments(adjustments)
    .map((item) => item.voucher_no || purchaseMap.get(String(item.purchase_id))?.voucher_no || item.purchase_id)
    .filter(Boolean)
    .join(", ");
}

function getPaymentRowsForUser(req, res) {
  const filter = assignedWarehouseFilter(req.user, "p.warehouse_id");
  const query = `
    SELECT p.*, ca.account_name AS company_account_name, f.name AS farmer_name
    FROM wh_payment_vouchers p
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(p.company_account_id AS TEXT)
    LEFT JOIN farmers f ON CAST(f.id AS TEXT) = CAST(p.farmer_id AS TEXT)
    WHERE 1 = 1 ${filter.clause}
    ORDER BY p.date DESC, p.id DESC
  `;
  db.all(query, filter.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const paymentRows = rows || [];
    if (!paymentRows.length) return res.json([]);
    const ids = paymentRows.map((row) => row.id);
    db.all(
      `
        SELECT a.*, pv.voucher_no AS purchase_voucher_no
        FROM wh_payment_adjustments a
        LEFT JOIN wh_purchase_vouchers pv ON CAST(pv.id AS TEXT) = CAST(a.purchase_id AS TEXT)
        WHERE a.payment_id IN (${ids.map(() => "?").join(",")})
        ORDER BY a.id ASC
      `,
      ids,
      async (adjErr, adjustmentRows) => {
        if (adjErr) return res.status(500).json({ error: adjErr.message });
        let mongoPurchaseMap = new Map();
        if (mongoReady()) {
          const mongoPurchaseIds = [...new Set((adjustmentRows || [])
            .map((row) => String(row.purchase_id || ""))
            .filter((id) => mongoose.Types.ObjectId.isValid(id)))];
          if (mongoPurchaseIds.length) {
            try {
              const mongoPurchases = await PurchaseVoucher.find({ _id: { $in: mongoPurchaseIds } }).lean();
              mongoPurchaseMap = new Map((mongoPurchases || []).map((row) => [String(row._id), row]));
            } catch (mongoErr) {
              console.error("Payment adjustment purchase lookup failed:", mongoErr.message);
            }
          }
        }
        const byPayment = new Map();
        (adjustmentRows || []).forEach((row) => {
          const paymentId = String(row.payment_id);
          const mongoPurchase = mongoPurchaseMap.get(String(row.purchase_id));
          if (!byPayment.has(paymentId)) byPayment.set(paymentId, []);
          byPayment.get(paymentId).push({
            ...row,
            voucher_no: row.purchase_voucher_no || mongoPurchase?.voucher_no || row.purchase_id,
            purchase_voucher_no: row.purchase_voucher_no || mongoPurchase?.voucher_no || row.purchase_id,
          });
        });
        res.json(paymentRows.map((row) => {
          const adjustments = byPayment.get(String(row.id)) || [];
          const adjustmentDetails = adjustments
            .filter((item) => item.purchase_voucher_no && item.adjusted_amount)
            .map((item) => `${item.purchase_voucher_no}: ${fmtNum(item.adjusted_amount)}`)
            .join(", ");
          return {
            ...row,
            party_name: row.company_account_name || row.farmer_name || "-",
            adjustments,
            reference_type: row.reference_type || "purchase",
            reference_id: row.reference_id || adjustmentDetails || adjustments.map((item) => item.purchase_voucher_no).filter(Boolean).join(", "),
          };
        }));
      }
    );
  });
}

// ===========================
// PURCHASE VOUCHERS
// ===========================
router.get("/purchase", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }
  getPurchaseVoucherRows(req, res);
});

router.post("/purchase", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const {
    voucher_no,
    date,
    warehouse_id,
    farmer_id,
    company_account_id,
    product_id,
    quantity,
    rate,
    amount,
    packet,
    gross_weight,
    tare_weight,
    dhalta,
    less_bags_weight,
    moisture,
    dunki,
    fungus,
    discolour,
    others,
    net_weight,
    bags_claim,
    labour,
    total_deduct_amount,
    total_qty,
    total_deduction,
    round_off,
    net_amount_payable,
    employee_id,
    location_id,
    description,
  } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  if (!mongoReady()) {
    return res.status(503).json({ error: "MongoDB is not connected. Purchase data must be saved in MongoDB." });
  }

  if (mongoReady()) {
    return createVoucherNoIfMissing("purchase", voucher_no, async (err, generatedVoucherNo) => {
      if (err) return res.status(500).json({ error: err.message });
      try {
        const payload = buildPurchasePayload(req.body, generatedVoucherNo);
        const doc = await PurchaseVoucher.create(payload);
        return res.json({ id: String(doc._id), _id: String(doc._id), voucher_no: doc.voucher_no, saved_to: "mongodb" });
      } catch (mongoErr) {
        if (mongoErr?.code === 11000) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: mongoErr.message });
      }
    });
  }

  const query = `
    INSERT INTO wh_purchase_vouchers (
      voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
      packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
      discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
      total_deduction, round_off, net_amount_payable, employee_id, location_id, description
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const idemKey = req.get("Idempotency-Key") || req.headers["idempotency-key"];
  if (idemKey) {
    return getIdempotency(idemKey, "purchase", (err, existingId) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existingId) {
        return db.get(`SELECT * FROM wh_purchase_vouchers WHERE id = ?`, [existingId], (e2, existingRow) => {
          if (e2) return res.status(500).json({ error: e2.message });
          return res.json({ id: existingRow.id, voucher_no: existingRow.voucher_no, existing: existingRow });
        });
      }

      createVoucherNoIfMissing("purchase", voucher_no, (err, generatedVoucherNo) => {
        if (err) return res.status(500).json({ error: err.message });

        const query = `
          INSERT INTO wh_purchase_vouchers (
            voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
            packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
            discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
            total_deduction, round_off, net_amount_payable, employee_id, location_id, description
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [
          generatedVoucherNo,
          date,
          warehouse_id,
          farmer_id,
          company_account_id,
          product_id,
          quantity,
          rate,
          amount,
          packet,
          gross_weight,
          tare_weight,
          dhalta,
          less_bags_weight,
          moisture,
          dunki,
          fungus,
          discolour,
          others,
          net_weight,
          bags_claim,
          labour,
          total_deduct_amount,
          total_qty,
          total_deduction,
          round_off,
          net_amount_payable,
          employee_id,
          location_id,
          description,
        ], function (err) {
          if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }
          saveIdempotency(idemKey, "purchase", this.lastID, () => {});
          res.json({ id: this.lastID, voucher_no: generatedVoucherNo });
        });
      });
    });
  }

  // no idempotency key, proceed normally
  createVoucherNoIfMissing("purchase", voucher_no, (err, generatedVoucherNo) => {
    if (err) return res.status(500).json({ error: err.message });

    const query = `
      INSERT INTO wh_purchase_vouchers (
        voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
        packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
        discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
        total_deduction, round_off, net_amount_payable, employee_id, location_id, description
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [
      generatedVoucherNo,
      date,
      warehouse_id,
      farmer_id,
      company_account_id,
      product_id,
      quantity,
      rate,
      amount,
      packet,
      gross_weight,
      tare_weight,
      dhalta,
      less_bags_weight,
      moisture,
      dunki,
      fungus,
      discolour,
      others,
      net_weight,
      bags_claim,
      labour,
      total_deduct_amount,
      total_qty,
      total_deduction,
      round_off,
      net_amount_payable,
      employee_id,
      location_id,
      description,
    ], function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, voucher_no: generatedVoucherNo });
    });
  });
});

router.get("/next-voucher-no", (req, res) => {
  const { type } = req.query;
  if (!type) return res.status(400).json({ error: "type query param is required" });
  if (type === "purchase" && mongoReady()) {
    nextMongoVoucherNo(type)
      .then((voucher_no) => res.json({ voucher_no }))
      .catch((err) => res.status(500).json({ error: err.message }));
    return;
  }
  createSequentialVoucherNo(type, (err, voucher_no) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ voucher_no });
  });
});

router.get("/outstanding", (req, res) => {
  const { party_type, id, warehouse_id, location_id, exclude_payment_id, company_account_id } = req.query;
  if (!party_type || !id) return res.status(400).json({ error: "party_type and id are required" });

  const filters = ["1=1"];
  const params = [id];
  let detailsQuery;
  let paymentsQuery;

  if (party_type === "farmer") {
    if (warehouse_id) {
      filters.push("warehouse_id = ?");
      params.push(warehouse_id);
    }
    if (location_id) {
      filters.push("location_id = ?");
      params.push(location_id);
    }
    if (company_account_id) {
      filters.push("company_account_id = ?");
      params.push(company_account_id);
    }
    const paymentFilters = filters.slice(1);
    const paymentParams = [...params];
    if (exclude_payment_id) {
      paymentFilters.push("CAST(id AS TEXT) <> CAST(? AS TEXT)");
      paymentParams.push(exclude_payment_id);
    }
    paymentsQuery = `SELECT id, voucher_no, date, warehouse_id, location_id, amount FROM wh_payment_vouchers WHERE farmer_id = ? ${paymentFilters.length ? `AND ${paymentFilters.join(" AND ")}` : ""} ORDER BY date ASC`;
    computeOutstandingForFarmer(id, (err, stats) => {
      if (err) return res.status(500).json({ error: err.message });
      getPaymentAdjustmentsByPurchase((adjustErr, adjustedMap) => {
        if (adjustErr) return res.status(500).json({ error: adjustErr.message });

        const send = (purchaseRows) => {
          const purchases = (purchaseRows || []).map((row) => {
            const purchaseId = String(row.id || row._id);
            const amount = Number(row.amount || row.net_amount_payable || row.total_amount || 0);
            const adjusted_amount = adjustedMap.get(purchaseId) || 0;
            return {
              ...row,
              id: purchaseId,
              amount,
              adjusted_amount,
              pending_amount: Number(Math.max(0, amount - adjusted_amount).toFixed(2)),
            };
          });

          db.all(paymentsQuery, paymentParams, (err3, payments) => {
            if (err3) return res.status(500).json({ error: err3.message });
            const totalPurchase = purchases.reduce((sum, row) => sum + Number(row.amount || 0), 0);
            const totalPayment = (payments || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
            const scopedStats = {
              total_purchase: Number(totalPurchase.toFixed(2)),
              total_payment: Number(totalPayment.toFixed(2)),
              outstanding: Number((totalPurchase - totalPayment).toFixed(2)),
            };
            res.json({ party_type: "farmer", id, stats: scopedStats, purchases, payments });
          });
        };

        if (mongoReady()) {
          const filter = { farmer_id: String(id || "") };
          if (warehouse_id) filter.warehouse_id = String(warehouse_id);
          if (company_account_id) filter.company_account_id = String(company_account_id);
          PurchaseVoucher.find(filter)
            .sort({ date: 1, createdAt: 1, _id: 1 })
            .lean()
            .then((rows) => decoratePurchaseRows(rows || []))
            .then((rows) => send(rows.map((row) => ({
              ...row,
              amount: Number(row.total_amount || row.net_amount_payable || row.amount || 0),
            }))))
            .catch((mongoErr) => res.status(500).json({ error: mongoErr.message }));
          return;
        }

        detailsQuery = `SELECT id, voucher_no, date, warehouse_id, location_id, COALESCE(NULLIF(net_amount_payable, 0), amount) AS amount FROM wh_purchase_vouchers WHERE farmer_id = ? ${filters.slice(1).length ? `AND ${filters.slice(1).join(" AND ")}` : ""} ORDER BY date ASC`;
        db.all(detailsQuery, params, (err2, purchases) => {
          if (err2) return res.status(500).json({ error: err2.message });
          send(purchases || []);
        });
      }, exclude_payment_id);
    }, company_account_id);
    return;
  }

  if (party_type === "company") {
    if (warehouse_id) {
      filters.push("warehouse_id = ?");
      params.push(warehouse_id);
    }
    if (location_id) {
      filters.push("location_id = ?");
      params.push(location_id);
    }
    detailsQuery = `SELECT id, voucher_no, date, warehouse_id, location_id, COALESCE(NULLIF(net_receivable_amount, 0), amount) AS amount FROM wh_sale_vouchers WHERE company_id = ? ${filters.slice(1).length ? `AND ${filters.slice(1).join(" AND ")}` : ""} ORDER BY date ASC`;
    paymentsQuery = `SELECT id, voucher_no, date, warehouse_id, location_id, amount FROM wh_receipt_vouchers WHERE company_id = ? ${filters.slice(1).length ? `AND ${filters.slice(1).join(" AND ")}` : ""} ORDER BY date ASC`;
    computeOutstandingForCompany(id, (err, stats) => {
      if (err) return res.status(500).json({ error: err.message });
      db.all(detailsQuery, params, (err2, sales) => {
        if (err2) return res.status(500).json({ error: err2.message });
        db.all(paymentsQuery, params, (err3, receipts) => {
          if (err3) return res.status(500).json({ error: err3.message });
          res.json({ party_type: "company", id, stats, sales, receipts });
        });
      });
    });
    return;
  }

  res.status(400).json({ error: "Unsupported party_type" });
});

// ===========================
// FARMERS BY ACCOUNT WITH OUTSTANDING
// ===========================
router.get("/farmers-by-account/:accountId", (req, res) => {
  const { accountId } = req.params;
  const { warehouse_id } = req.query;
  if (!accountId) return res.status(400).json({ error: "Account ID is required" });

  if (mongoReady()) {
    const filter = { company_account_id: String(accountId) };
    const selectedWarehouseId = String(warehouse_id || "").trim();
    const assignedWarehouses = req.user && Array.isArray(req.user.assigned_warehouses)
      ? req.user.assigned_warehouses.map((id) => String(id))
      : [];
    if (selectedWarehouseId) {
      if (assignedWarehouses.length) {
        if (!assignedWarehouses.includes(selectedWarehouseId)) return res.json([]);
      }
      filter.warehouse_id = selectedWarehouseId;
    } else if (assignedWarehouses.length) {
      filter.warehouse_id = { $in: assignedWarehouses };
    }

    return PurchaseVoucher.find(filter)
      .lean()
      .then(async (rows) => {
        const farmerIds = [...new Set((rows || []).map((r) => String(r.farmer_id || "")).filter(Boolean))];
        if (!farmerIds.length) return res.json([]);

        const farmers = await Farmer.find({ _id: { $in: farmerIds } })
          .select("_id name mobile address village")
          .lean();

        const result = await Promise.all(
          (farmers || []).map(
            (f) =>
              new Promise((resolve) => {
                computeOutstandingForFarmer(String(f._id), (_err, stats = {}) => {
                  const outstanding = Number(stats.outstanding || 0);
                  resolve({
                    id: String(f._id),
                    name: f.name,
                    mobile: f.mobile,
                    address: f.address,
                    village: f.village,
                    total_purchase: Number(stats.total_purchase || 0),
                    total_adjusted: Number(stats.total_payment || 0),
                    outstanding: Number(outstanding.toFixed(2)),
                  });
                }, accountId);
              })
          )
        );

        return res.json(result.filter((f) => f.outstanding > 0));
      })
      .catch((err) => res.status(500).json({ error: err.message }));
  }

  const filter = assignedWarehouseFilter(req.user, "pv.warehouse_id");
  const filters = ["1=1"];
  const params = [];
  
  if (warehouse_id) {
    filters.push("pv.warehouse_id = ?");
    params.push(warehouse_id);
  }

  const query = `
    SELECT DISTINCT f.id, f.name, f.mobile, f.address, f.village
    FROM wh_purchase_vouchers pv
    INNER JOIN farmers f ON CAST(f.id AS TEXT) = CAST(pv.farmer_id AS TEXT)
    WHERE CAST(pv.company_account_id AS TEXT) = CAST(? AS TEXT) ${filter.clause} ${filters.slice(1).length ? `AND ${filters.slice(1).join(" AND ")}` : ""}
    ORDER BY f.name ASC
  `;

  db.all(query, [accountId, ...filter.params, ...params], (err, farmers) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (!farmers || !farmers.length) return res.json([]);

    const farmerIds = farmers.map((f) => f.id);
    const adjustSql = `
      SELECT pv.farmer_id, SUM(COALESCE(pa.adjusted_amount, 0)) as total_adjusted
      FROM wh_payment_adjustments pa
      INNER JOIN wh_payment_vouchers pv ON pa.payment_id = pv.id
      WHERE CAST(pv.company_account_id AS TEXT) = CAST(? AS TEXT) AND pv.farmer_id IN (${farmerIds.map(() => "?").join(",")})
      GROUP BY pv.farmer_id
    `;

    const purchaseSql = `
      SELECT farmer_id, SUM(COALESCE(NULLIF(net_amount_payable, 0), amount, 0)) as total_purchase
      FROM wh_purchase_vouchers
      WHERE CAST(company_account_id AS TEXT) = CAST(? AS TEXT) AND farmer_id IN (${farmerIds.map(() => "?").join(",")})
      GROUP BY farmer_id
    `;

    db.all(adjustSql, [accountId, ...farmerIds], (adjErr, adjRows) => {
      if (adjErr) console.error("Adjustment query error:", adjErr);
      db.all(purchaseSql, [accountId, ...farmerIds], (purErr, purRows) => {
        if (purErr) console.error("Purchase query error:", purErr);
        
        const adjustMap = new Map((adjRows || []).map((r) => [String(r.farmer_id), Number(r.total_adjusted || 0)]));
        const purchaseMap = new Map((purRows || []).map((r) => [String(r.farmer_id), Number(r.total_purchase || 0)]));
        
        const result = farmers.map((f) => {
          const totalPurchase = purchaseMap.get(String(f.id)) || 0;
          const totalAdjusted = adjustMap.get(String(f.id)) || 0;
          const outstanding = Math.max(0, totalPurchase - totalAdjusted);
          
          return {
            ...f,
            total_purchase: Number(totalPurchase.toFixed(2)),
            total_adjusted: Number(totalAdjusted.toFixed(2)),
            outstanding: Number(outstanding.toFixed(2)),
          };
        });
        
        res.json(result.filter((f) => f.outstanding > 0));
      });
    });
  });
});

// ===========================
// SALE VOUCHERS
// ===========================
router.get("/sale", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.sale.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  getWarehouseScopedRows(req, res, "wh_sale_vouchers");
});

router.post("/sale", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.sale.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { voucher_no, date, unloading_date, warehouse_id, company_id, company_account_id, consignee_id, product_id, quantity, shortage_quantity, unloading_qty, rate, amount, claim_amount, other_deduction, adjustment_amount, tds_amount, employee_id, location_id, description } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  const idemKey = req.get("Idempotency-Key") || req.headers["idempotency-key"];
  if (idemKey) {
    return getIdempotency(idemKey, "sale", (err, existingId) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existingId) {
        return db.get(`SELECT * FROM wh_sale_vouchers WHERE id = ?`, [existingId], (e2, existingRow) => {
          if (e2) return res.status(500).json({ error: e2.message });
          return res.json({ id: existingRow.id, voucher_no: existingRow.voucher_no, existing: existingRow });
        });
      }

      createVoucherNoIfMissing("sale", voucher_no, (err, generatedVoucherNo) => {
        if (err) return res.status(500).json({ error: err.message });

        const amountValue = Number(amount) || 0;
        const claimValue = Number(claim_amount) || 0;
        const otherDeductionValue = Number(other_deduction) || 0;
        const adjustmentValue = Number(adjustment_amount) || 0;
        const tdsValue = Number(tds_amount) || 0;
        const netAmount = amountValue - claimValue - otherDeductionValue - adjustmentValue - tdsValue;
        const unloadingQtyValue = Number(unloading_qty) || Number(quantity) || 0;
        const fifoAmountValue = amountValue;
        const fifoRateValue = unloadingQtyValue > 0 ? amountValue / unloadingQtyValue : 0;
        const netReceivableValue = netAmount;
        const outstanding = netAmount;

        const query = `
          INSERT INTO wh_sale_vouchers (voucher_no, date, unloading_date, warehouse_id, company_id, company_account_id, consignee_id, product_id, quantity, shortage_quantity, unloading_qty, rate, amount, claim_amount, other_deduction, adjustment_amount, tds_amount, net_amount, net_receivable_amount, fifo_rate, fifo_amount, outstanding, employee_id, location_id, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [generatedVoucherNo, date, unloading_date, warehouse_id, company_id, company_account_id, consignee_id, product_id, quantity, shortage_quantity, unloadingQtyValue, rate, amountValue, claimValue, otherDeductionValue, adjustmentValue, tdsValue, netAmount, netReceivableValue, fifoRateValue, fifoAmountValue, outstanding, employee_id, location_id, description], function (err) {
          if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }
          saveIdempotency(idemKey, "sale", this.lastID, () => {});
          res.json({ id: this.lastID, voucher_no: generatedVoucherNo, net_amount: netAmount, outstanding });
        });
      });
    });
  }

  createVoucherNoIfMissing("sale", voucher_no, (err, generatedVoucherNo) => {
    if (err) return res.status(500).json({ error: err.message });

    const amountValue = Number(amount) || 0;
    const claimValue = Number(claim_amount) || 0;
    const otherDeductionValue = Number(other_deduction) || 0;
    const adjustmentValue = Number(adjustment_amount) || 0;
    const tdsValue = Number(tds_amount) || 0;
    const netAmount = amountValue - claimValue - otherDeductionValue - adjustmentValue - tdsValue;
    const unloadingQtyValue = Number(unloading_qty) || Number(quantity) || 0;
    const fifoAmountValue = amountValue;
    const fifoRateValue = unloadingQtyValue > 0 ? amountValue / unloadingQtyValue : 0;
    const netReceivableValue = netAmount;
    const outstanding = netAmount;

    const query = `
      INSERT INTO wh_sale_vouchers (voucher_no, date, unloading_date, warehouse_id, company_id, company_account_id, consignee_id, product_id, quantity, shortage_quantity, unloading_qty, rate, amount, claim_amount, other_deduction, adjustment_amount, tds_amount, net_amount, net_receivable_amount, fifo_rate, fifo_amount, outstanding, employee_id, location_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [generatedVoucherNo, date, unloading_date, warehouse_id, company_id, company_account_id, consignee_id, product_id, quantity, shortage_quantity, unloadingQtyValue, rate, amountValue, claimValue, otherDeductionValue, adjustmentValue, tdsValue, netAmount, netReceivableValue, fifoRateValue, fifoAmountValue, outstanding, employee_id, location_id, description], function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, voucher_no: generatedVoucherNo, net_amount: netAmount, outstanding });
    });
  });
});

router.put("/sale/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.sale.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  const { voucher_no, date, unloading_date, warehouse_id, company_id, company_account_id, consignee_id, product_id, quantity, shortage_quantity, unloading_qty, rate, amount, claim_amount, other_deduction, adjustment_amount, tds_amount, employee_id, location_id, description } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  const amountValue = Number(amount) || 0;
  const claimValue = Number(claim_amount) || 0;
  const otherDeductionValue = Number(other_deduction) || 0;
  const adjustmentValue = Number(adjustment_amount) || 0;
  const tdsValue = Number(tds_amount) || 0;
  const netAmount = amountValue - claimValue - otherDeductionValue - adjustmentValue - tdsValue;
  const unloadingQtyValue = Number(unloading_qty) || Number(quantity) || 0;
  const fifoAmountValue = amountValue;
  const fifoRateValue = unloadingQtyValue > 0 ? amountValue / unloadingQtyValue : 0;
  const netReceivableValue = netAmount;

  const query = `
    UPDATE wh_sale_vouchers SET
      voucher_no=?, date=?, unloading_date=?, warehouse_id=?, company_id=?, company_account_id=?, consignee_id=?, product_id=?,
      quantity=?, shortage_quantity=?, unloading_qty=?, rate=?, amount=?, claim_amount=?, other_deduction=?,
      adjustment_amount=?, tds_amount=?, net_amount=?, net_receivable_amount=?, fifo_rate=?, fifo_amount=?,
      outstanding=?, employee_id=?, location_id=?, description=?
    WHERE id = ?
  `;

  db.run(query, [
    voucher_no, date, unloading_date, warehouse_id, company_id, company_account_id, consignee_id, product_id,
    quantity, shortage_quantity, unloadingQtyValue, rate, amountValue, claimValue, otherDeductionValue,
    adjustmentValue, tdsValue, netAmount, netReceivableValue, fifoRateValue, fifoAmountValue,
    netAmount, employee_id, location_id, description, id
  ], function (err) {
    if (err) {
      if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
      return res.status(500).json({ error: err.message });
    }
    res.json({ id, updated: 1, net_amount: netAmount, net_receivable_amount: netReceivableValue, outstanding: netAmount });
  });
});

router.delete("/sale/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.sale.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  db.get("SELECT warehouse_id FROM wh_sale_vouchers WHERE id = ?", [id], (findErr, row) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!row) return res.status(404).json({ error: "Voucher not found" });
    if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;

    db.run("DELETE FROM wh_sale_vouchers WHERE id = ?", [id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ deleted: 1 });
    });
  });
});

// ===========================
// PAYMENT VOUCHERS
// ===========================
router.get("/payment", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  getPaymentRowsForUser(req, res);
});

router.post("/payment", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, employee_id, location_id, description, adjustments } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;
  if (!farmer_id) return res.status(400).json({ error: "Farmer is required for payment vouchers" });

  validatePaymentAdjustments({ farmerId: farmer_id, warehouseId: warehouse_id, amount, adjustments }, (validationErr, cleanAdjustments) => {
    if (validationErr) return res.status(400).json({ error: validationErr.message });

    const idemKey = req.get("Idempotency-Key") || req.headers["idempotency-key"];
    if (idemKey) {
      return getIdempotency(idemKey, "payment", (err, existingId) => {
        if (err) return res.status(500).json({ error: err.message });
      if (existingId) {
        return db.get(`SELECT * FROM wh_payment_vouchers WHERE id = ?`, [existingId], (e2, existingRow) => {
          if (e2) return res.status(500).json({ error: e2.message });
          return res.json({ id: existingRow.id, voucher_no: existingRow.voucher_no, existing: existingRow });
        });
      }

      createVoucherNoIfMissing("payment", voucher_no, (err, generatedVoucherNo) => {
        if (err) return res.status(500).json({ error: err.message });

        const query = `
          INSERT INTO wh_payment_vouchers (voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, employee_id, location_id, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const finalReferenceType = reference_type || "purchase";
        const finalReferenceId = reference_id || buildPaymentReferenceId(cleanAdjustments);
        db.run(query, [generatedVoucherNo, date, warehouse_id, farmer_id, company_account_id, amount, finalReferenceType, finalReferenceId, employee_id, location_id, description], function (err) {
          if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }

            const paymentId = this.lastID;
            insertPaymentAdjustments(paymentId, cleanAdjustments, (adjErr) => {
              if (adjErr) return res.status(500).json({ error: adjErr.message });
              saveIdempotency(idemKey, "payment", paymentId, () => {});
              computeOutstandingForFarmer(farmer_id, (err2, stats) => {
                if (err2) return res.status(500).json({ error: err2.message });
                db.run("UPDATE wh_payment_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, paymentId], () => {
                  res.json({ id: paymentId, voucher_no: generatedVoucherNo, stats, adjustments: cleanAdjustments });
                });
              });
            });
        });
      });
    });
    }

    createVoucherNoIfMissing("payment", voucher_no, (err, generatedVoucherNo) => {
      if (err) return res.status(500).json({ error: err.message });

      const query = `
        INSERT INTO wh_payment_vouchers (voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, employee_id, location_id, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const finalReferenceType = reference_type || "purchase";
      const finalReferenceId = reference_id || buildPaymentReferenceId(cleanAdjustments);
      db.run(query, [generatedVoucherNo, date, warehouse_id, farmer_id, company_account_id, amount, finalReferenceType, finalReferenceId, employee_id, location_id, description], function (err) {
        if (err) {
          if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
          return res.status(500).json({ error: err.message });
        }

        const paymentId = this.lastID;
        insertPaymentAdjustments(paymentId, cleanAdjustments, (adjErr) => {
          if (adjErr) return res.status(500).json({ error: adjErr.message });
          computeOutstandingForFarmer(farmer_id, (err2, stats) => {
            if (err2) return res.status(500).json({ error: err2.message });
            db.run("UPDATE wh_payment_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, paymentId], () => {
              res.json({ id: paymentId, voucher_no: generatedVoucherNo, stats, adjustments: cleanAdjustments });
            });
          });
        });
      });
    });
  });
});

router.put("/payment/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  const { voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, reference_type, reference_id, employee_id, location_id, description, adjustments } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;
  if (!farmer_id) return res.status(400).json({ error: "Farmer is required for payment vouchers" });

  db.get("SELECT * FROM wh_payment_vouchers WHERE id = ?", [id], (findErr, oldRow) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!oldRow) return res.status(404).json({ error: "Payment voucher not found" });
    if (!ensureWarehouseAccess(req, res, oldRow.warehouse_id)) return;

    validatePaymentAdjustments({ farmerId: farmer_id, warehouseId: warehouse_id, amount, adjustments, excludePaymentId: id }, (validationErr, cleanAdjustments) => {
      if (validationErr) return res.status(400).json({ error: validationErr.message });

      const finalReferenceType = reference_type || "purchase";
      const finalReferenceId = reference_id || buildPaymentReferenceId(cleanAdjustments);
      const query = `
        UPDATE wh_payment_vouchers SET
          voucher_no=?, date=?, warehouse_id=?, farmer_id=?, company_account_id=?, amount=?,
          reference_type=?, reference_id=?, employee_id=?, location_id=?, description=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `;

      db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run(query, [voucher_no, date, warehouse_id, farmer_id, company_account_id, amount, finalReferenceType, finalReferenceId, employee_id, location_id, description, id], function (err) {
          if (err) {
            db.run("ROLLBACK");
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }

          db.run("DELETE FROM wh_payment_adjustments WHERE payment_id = ?", [id], (deleteErr) => {
            if (deleteErr) {
              db.run("ROLLBACK");
              return res.status(500).json({ error: deleteErr.message });
            }

            insertPaymentAdjustments(id, cleanAdjustments, (adjErr) => {
              if (adjErr) {
                db.run("ROLLBACK");
                return res.status(500).json({ error: adjErr.message });
              }
              computeOutstandingForFarmer(farmer_id, (statsErr, stats) => {
                if (statsErr) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: statsErr.message });
                }
                db.run("UPDATE wh_payment_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, id], (outErr) => {
                  if (outErr) {
                    db.run("ROLLBACK");
                    return res.status(500).json({ error: outErr.message });
                  }
                  db.run("COMMIT", (commitErr) => {
                    if (commitErr) return res.status(500).json({ error: commitErr.message });
                    res.json({ id, updated: 1, voucher_no, stats, adjustments: cleanAdjustments, reference_id: finalReferenceId });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});

router.delete("/payment/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.payment.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  db.get("SELECT * FROM wh_payment_vouchers WHERE id = ?", [id], (findErr, row) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!row) return res.status(404).json({ error: "Payment voucher not found" });
    if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;

    db.serialize(() => {
      db.run("BEGIN TRANSACTION");
      db.run("DELETE FROM wh_payment_adjustments WHERE payment_id = ?", [id], (adjErr) => {
        if (adjErr) {
          db.run("ROLLBACK");
          return res.status(500).json({ error: adjErr.message });
        }
        db.run("DELETE FROM wh_payment_vouchers WHERE id = ?", [id], function (deleteErr) {
          if (deleteErr) {
            db.run("ROLLBACK");
            return res.status(500).json({ error: deleteErr.message });
          }
          computeOutstandingForFarmer(row.farmer_id, (statsErr, stats) => {
            if (statsErr) {
              db.run("ROLLBACK");
              return res.status(500).json({ error: statsErr.message });
            }
            db.run("COMMIT", (commitErr) => {
              if (commitErr) return res.status(500).json({ error: commitErr.message });
              res.json({ deleted: 1, stats });
            });
          });
        });
      });
    });
  });
});

// ===========================
// RECEIPT VOUCHERS
// ===========================
router.get("/receipt", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  getWarehouseScopedRows(req, res, "wh_receipt_vouchers");
});

router.post("/receipt", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.receipt.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { voucher_no, date, warehouse_id, company_id, company_account_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;
  if (!company_id) return res.status(400).json({ error: "Company is required for receipt vouchers" });

  const idemKey = req.get("Idempotency-Key") || req.headers["idempotency-key"];
  if (idemKey) {
    return getIdempotency(idemKey, "receipt", (err, existingId) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existingId) {
        return db.get(`SELECT * FROM wh_receipt_vouchers WHERE id = ?`, [existingId], (e2, existingRow) => {
          if (e2) return res.status(500).json({ error: e2.message });
          return res.json({ id: existingRow.id, voucher_no: existingRow.voucher_no, existing: existingRow });
        });
      }

      createVoucherNoIfMissing("receipt", voucher_no, (err, generatedVoucherNo) => {
        if (err) return res.status(500).json({ error: err.message });

        const query = `
          INSERT INTO wh_receipt_vouchers (voucher_no, date, warehouse_id, company_id, company_account_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [generatedVoucherNo, date, warehouse_id, company_id, company_account_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description], function (err) {
          if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }

          const receiptId = this.lastID;
          saveIdempotency(idemKey, "receipt", receiptId, () => {});
          computeOutstandingForCompany(company_id, (err2, stats) => {
            if (err2) return res.status(500).json({ error: err2.message });
            db.run("UPDATE wh_receipt_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, receiptId], () => {
              res.json({ id: receiptId, voucher_no: generatedVoucherNo, stats });
            });
          });
        });
      });
    });
  }

  createVoucherNoIfMissing("receipt", voucher_no, (err, generatedVoucherNo) => {
    if (err) return res.status(500).json({ error: err.message });

    const query = `
      INSERT INTO wh_receipt_vouchers (voucher_no, date, warehouse_id, company_id, company_account_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [generatedVoucherNo, date, warehouse_id, company_id, company_account_id, consignee_id, amount, reference_type, reference_id, employee_id, location_id, description], function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: err.message });
      }

      const receiptId = this.lastID;
      computeOutstandingForCompany(company_id, (err2, stats) => {
        if (err2) return res.status(500).json({ error: err2.message });
        db.run("UPDATE wh_receipt_vouchers SET outstanding_after = ? WHERE id = ?", [stats.outstanding, receiptId], () => {
          res.json({ id: receiptId, voucher_no: generatedVoucherNo, stats });
        });
      });
    });
  });
});

// ===========================
// JOURNAL VOUCHERS
// ===========================
router.get("/journal", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.journal.view")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  getWarehouseScopedRows(req, res, "wh_journal_vouchers");
});

router.post("/journal", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.journal.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const { voucher_no, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description } = req.body;
  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  const idemKey = req.get("Idempotency-Key") || req.headers["idempotency-key"];
  if (idemKey) {
    return getIdempotency(idemKey, "journal", (err, existingId) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existingId) {
        return db.get(`SELECT * FROM wh_journal_vouchers WHERE id = ?`, [existingId], (e2, existingRow) => {
          if (e2) return res.status(500).json({ error: e2.message });
          return res.json({ id: existingRow.id, voucher_no: existingRow.voucher_no, existing: existingRow });
        });
      }

      createVoucherNoIfMissing("journal", voucher_no, (err, generatedVoucherNo) => {
        if (err) return res.status(500).json({ error: err.message });

        const query = `
          INSERT INTO wh_journal_vouchers (voucher_no, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [generatedVoucherNo, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description], function (err) {
          if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
            return res.status(500).json({ error: err.message });
          }
          saveIdempotency(idemKey, "journal", this.lastID, () => {});
          res.json({ id: this.lastID, voucher_no: generatedVoucherNo });
        });
      });
    });
  }

  createVoucherNoIfMissing("journal", voucher_no, (err, generatedVoucherNo) => {
    if (err) return res.status(500).json({ error: err.message });

    const query = `
      INSERT INTO wh_journal_vouchers (voucher_no, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [generatedVoucherNo, date, warehouse_id, company_account_id, debit_account, credit_account, amount, employee_id, location_id, description], function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, voucher_no: generatedVoucherNo });
    });
  });
});

function dbAll(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function getPurchaseReportRowsForUser(user) {
  if (mongoReady()) {
    const rows = await PurchaseVoucher.find(mongoPurchaseScope(user))
      .sort({ date: -1, createdAt: -1, _id: -1 })
      .lean();
    return decoratePurchaseRows(rows);
  }

  const filter = assignedWarehouseFilter(user, "v.warehouse_id");
  return dbAll(
    `
      SELECT
        v.*,
        w.name AS warehouse_name,
        ca.account_name AS company_account_name,
        f.name AS farmer_name,
        p.name AS product_name,
        (COALESCE(NULLIF(v.total_qty, 0), NULLIF(v.net_weight, 0), v.quantity) * COALESCE(v.rate, 0)) AS gross_amount,
        COALESCE(NULLIF(v.total_qty, 0), NULLIF(v.net_weight, 0), v.quantity) AS total_quantity,
        COALESCE(NULLIF(v.net_amount_payable, 0), v.amount) AS total_amount
      FROM wh_purchase_vouchers v
      LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(v.warehouse_id AS TEXT)
      LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
      LEFT JOIN farmers f ON CAST(f.id AS TEXT) = CAST(v.farmer_id AS TEXT)
      LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(v.product_id AS TEXT)
      WHERE 1 = 1 ${filter.clause}
      ORDER BY v.date DESC, v.id DESC
    `,
    filter.params
  );
}

async function getSaleReportRowsForUser(user) {
  const filter = assignedWarehouseFilter(user, "s.warehouse_id");
  return dbAll(
    `
      SELECT
        s.*,
        w.name AS warehouse_name,
        c.name AS company_name,
        ca.account_name AS company_account_name,
        p.name AS product_name,
        COALESCE(NULLIF(s.unloading_qty, 0), s.quantity) AS total_quantity,
        COALESCE(NULLIF(s.net_receivable_amount, 0), s.amount) AS total_amount
      FROM wh_sale_vouchers s
      LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(s.warehouse_id AS TEXT)
      LEFT JOIN companies c ON CAST(c.id AS TEXT) = CAST(s.company_id AS TEXT)
      LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(s.company_account_id AS TEXT)
      LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(s.product_id AS TEXT)
      WHERE 1 = 1 ${filter.clause}
      ORDER BY s.date DESC, s.id DESC
    `,
    filter.params
  );
}

function buildLedgerRows(rows, getPartyId, getPartyName) {
  const balances = new Map();
  return rows
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
    .map((row) => {
      const key = getPartyId(row) || "unknown";
      const previous = balances.get(key) || 0;
      const debit = Number(row.debit || 0);
      const credit = Number(row.credit || 0);
      const balance = previous + debit - credit;
      balances.set(key, balance);
      return {
        ...row,
        party_id: key,
        party_name: getPartyName(row),
        debit,
        credit,
        balance: Number(balance.toFixed(2)),
      };
    })
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

function groupStock(purchases, sales) {
  const groups = new Map();
  const keyOf = (row) => `${row.warehouse_id || ""}::${row.product_id || ""}`;
  const ensure = (row) => {
    const key = keyOf(row);
    if (!groups.has(key)) {
      groups.set(key, {
        warehouse_id: row.warehouse_id,
        warehouse_name: row.warehouse_name || "",
        product_id: row.product_id,
        product_name: row.product_name || "",
        purchase_qty: 0,
        sale_qty: 0,
        gross_weight: 0,
        purchase_amount: 0,
        sale_amount: 0,
      });
    }
    const item = groups.get(key);
    item.warehouse_name = item.warehouse_name || row.warehouse_name || "";
    item.product_name = item.product_name || row.product_name || "";
    return item;
  };

  purchases.forEach((row) => {
    const item = ensure(row);
    const netQty = Number(row.total_quantity || row.total_qty || row.net_weight || row.quantity || 0);
    const grossQty = Number(row.gross_weight || 0);
    const qty = grossQty > 0 ? grossQty : netQty;
    item.purchase_qty += qty;
    item.gross_weight += qty;
    item.purchase_amount += Number(row.total_amount || row.net_amount_payable || row.amount || 0);
  });

  sales.forEach((row) => {
    const item = ensure(row);
    const qty = Number(row.total_quantity || row.unloading_qty || row.quantity || 0);
    item.sale_qty += qty;
    item.sale_amount += Number(row.total_amount || row.net_receivable_amount || row.amount || 0);
  });

  return Array.from(groups.values()).map((item) => {
    const stockQty = item.purchase_qty - item.sale_qty;
    const avgRate = item.purchase_qty > 0 ? item.purchase_amount / item.purchase_qty : 0;
    return {
      ...item,
      purchase_qty: Number(item.purchase_qty.toFixed(4)),
      sale_qty: Number(item.sale_qty.toFixed(4)),
      gross_weight: Number(item.gross_weight.toFixed(4)),
      stock_qty: Number(stockQty.toFixed(4)),
      avg_rate: Number(avgRate.toFixed(4)),
      stock_amount: Number((stockQty * avgRate).toFixed(4)),
    };
  });
}

function buildFifoStock(purchases, sales) {
  const lotsByKey = new Map();
  const keyOf = (row) => `${row.warehouse_id || ""}::${row.product_id || ""}`;

  purchases
    .slice()
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
    .forEach((row) => {
      const key = keyOf(row);
      const netQty = Number(row.total_quantity || row.total_qty || row.net_weight || row.quantity || 0);
      const grossQty = Number(row.gross_weight || 0);
      const qty = grossQty > 0 ? grossQty : netQty;
      const amount = Number(row.total_amount || row.net_amount_payable || row.amount || 0);
      if (!lotsByKey.has(key)) lotsByKey.set(key, []);
      lotsByKey.get(key).push({
        ...row,
        purchase_qty: qty,
        remaining_qty: qty,
        fifo_rate: qty > 0 ? amount / qty : Number(row.rate || 0),
      });
    });

  sales
    .slice()
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
    .forEach((row) => {
      const lots = lotsByKey.get(keyOf(row)) || [];
      let saleQty = Number(row.total_quantity || row.unloading_qty || row.quantity || 0);
      for (const lot of lots) {
        if (saleQty <= 0) break;
        const used = Math.min(lot.remaining_qty, saleQty);
        lot.remaining_qty -= used;
        saleQty -= used;
      }
    });

  return Array.from(lotsByKey.values())
    .flat()
    .filter((lot) => lot.remaining_qty > 0.0001)
    .map((lot) => ({
      date: lot.date,
      voucher_no: lot.voucher_no,
      warehouse_id: lot.warehouse_id,
      warehouse_name: lot.warehouse_name,
      product_id: lot.product_id,
      product_name: lot.product_name,
      purchase_qty: Number(lot.purchase_qty.toFixed(4)),
      remaining_qty: Number(lot.remaining_qty.toFixed(4)),
      rate: Number(lot.fifo_rate.toFixed(4)),
      amount: Number((lot.remaining_qty * lot.fifo_rate).toFixed(4)),
      gross_weight: Number((Number(lot.gross_weight || lot.purchase_qty || 0)).toFixed(4)),
    }));
}

// ===========================
// REPORTS
// ===========================
router.get("/report/sale-summary", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.sale")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const filter = assignedWarehouseFilter(req.user, "warehouse_id");
  const query = `
    SELECT 
      warehouse_id, 
      SUM(COALESCE(NULLIF(unloading_qty, 0), quantity)) as total_quantity, 
      SUM(COALESCE(NULLIF(net_receivable_amount, 0), amount)) as total_amount 
    FROM wh_sale_vouchers 
    WHERE 1 = 1 ${filter.clause}
    GROUP BY warehouse_id
  `;
  db.all(query, filter.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

router.get("/report/purchase-summary", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.purchase")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  if (mongoReady()) {
    return PurchaseVoucher.find(mongoPurchaseScope(req.user))
      .sort({ date: -1, createdAt: -1, _id: -1 })
      .lean()
      .then((rows) => decoratePurchaseRows(rows))
      .then((rows) => res.json(rows || []))
      .catch((err) => {
        console.error("Mongo purchase report query failed, falling back to SQLite:", err.message);
        res.status(500).json({ error: err.message });
      });
  }

  const filter = assignedWarehouseFilter(req.user, "v.warehouse_id");
  const legacyFilter = assignedWarehouseFilter(req.user, "t.warehouse_id");
  const query = `
    SELECT
      v.*,
      w.name AS warehouse_name,
      ca.account_name AS company_account_name,
      f.name AS farmer_name,
      p.name AS product_name,
      (COALESCE(NULLIF(v.total_qty, 0), NULLIF(v.net_weight, 0), v.quantity) * COALESCE(v.rate, 0)) AS gross_amount,
      COALESCE(NULLIF(v.total_qty, 0), NULLIF(v.net_weight, 0), v.quantity) AS total_quantity,
      COALESCE(NULLIF(v.net_amount_payable, 0), v.amount) AS total_amount
    FROM wh_purchase_vouchers v
    LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(v.warehouse_id AS TEXT)
    LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(v.company_account_id AS TEXT)
    LEFT JOIN farmers f ON CAST(f.id AS TEXT) = CAST(v.farmer_id AS TEXT)
    LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(v.product_id AS TEXT)
    WHERE 1 = 1 ${filter.clause}
    ORDER BY v.date DESC, v.id DESC
  `;
  db.all(query, filter.params, (err, rows) => {
    const sendRowsWithLegacy = (purchaseRows) => {
      const legacyQuery = `
        SELECT
          t.id,
          t.date,
          t.warehouse_id,
          t.farmer_id,
          t.product_id,
          t.quantity,
          t.amount,
          t.description,
          t.created_at,
          w.name AS warehouse_name,
          f.name AS farmer_name,
          p.name AS product_name,
          t.quantity AS total_quantity,
          t.amount AS total_amount,
          t.amount AS net_amount_payable,
          1 AS legacy_purchase_entry
        FROM warehouse_trading_entries t
        LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(t.warehouse_id AS TEXT)
        LEFT JOIN farmers f ON CAST(f.id AS TEXT) = CAST(t.farmer_id AS TEXT)
        LEFT JOIN products p ON CAST(p.id AS TEXT) = CAST(t.product_id AS TEXT)
        WHERE LOWER(COALESCE(t.transaction_type, '')) = 'purchase' ${legacyFilter.clause}
        ORDER BY t.date DESC, t.id DESC
      `;

      db.all(legacyQuery, legacyFilter.params, (legacyErr, legacyRows) => {
        if (legacyErr) {
          console.error("Legacy purchase report query failed:", legacyErr.message);
          return res.json(purchaseRows || []);
        }
        res.json([...(purchaseRows || []), ...(legacyRows || [])]);
      });
    };

    if (err) {
      console.error("Purchase report mapped query failed, falling back to base rows:", err.message);
      const fallbackQuery = `
        SELECT
          v.*,
          (SELECT name FROM warehouses WHERE CAST(id AS TEXT) = CAST(v.warehouse_id AS TEXT) LIMIT 1) AS warehouse_name,
          (SELECT name FROM farmers WHERE CAST(id AS TEXT) = CAST(v.farmer_id AS TEXT) LIMIT 1) AS farmer_name,
          (SELECT name FROM products WHERE CAST(id AS TEXT) = CAST(v.product_id AS TEXT) LIMIT 1) AS product_name,
          (COALESCE(NULLIF(v.total_qty, 0), NULLIF(v.net_weight, 0), v.quantity) * COALESCE(v.rate, 0)) AS gross_amount,
          COALESCE(NULLIF(v.total_qty, 0), NULLIF(v.net_weight, 0), v.quantity) AS total_quantity,
          COALESCE(NULLIF(v.net_amount_payable, 0), v.amount) AS total_amount
        FROM wh_purchase_vouchers v
        WHERE 1 = 1 ${filter.clause}
        ORDER BY v.date DESC, v.id DESC
      `;
      return db.all(fallbackQuery, filter.params, (fallbackErr, fallbackRows) => {
        if (fallbackErr) return res.status(500).json({ error: fallbackErr.message });
        sendRowsWithLegacy(fallbackRows || []);
      });
    }
    sendRowsWithLegacy(rows || []);
  });
});

router.get("/report/profit-loss", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.profitLoss")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    const [purchases, sales] = await Promise.all([
      getPurchaseReportRowsForUser(req.user),
      getSaleReportRowsForUser(req.user),
    ]);
    const rows = new Map();
    const ensure = (row) => {
      const key = String(row.warehouse_id || "");
      if (!rows.has(key)) {
        rows.set(key, {
          id: row.warehouse_id,
          warehouse_id: row.warehouse_id,
          warehouse_name: row.warehouse_name || "",
          sale_amount: 0,
          purchase_amount: 0,
          profit_loss: 0,
        });
      }
      const item = rows.get(key);
      item.warehouse_name = item.warehouse_name || row.warehouse_name || "";
      return item;
    };

    purchases.forEach((row) => {
      const item = ensure(row);
      item.purchase_amount += Number(row.total_amount || row.net_amount_payable || row.amount || 0);
    });
    sales.forEach((row) => {
      const item = ensure(row);
      item.sale_amount += Number(row.total_amount || row.net_receivable_amount || row.amount || 0);
    });

    res.json(
      Array.from(rows.values()).map((row) => ({
        ...row,
        sale_amount: Number(row.sale_amount.toFixed(2)),
        purchase_amount: Number(row.purchase_amount.toFixed(2)),
        profit_loss: Number((row.sale_amount - row.purchase_amount).toFixed(2)),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/report/purchase-party-ledger", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.purchase")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    const farmerId = String(req.query.farmer_id || "").trim();
    const companyAccountId = String(req.query.company_account_id || "").trim();
    const allPurchases = await getPurchaseReportRowsForUser(req.user);
    const purchases = allPurchases.filter((row) => {
      if (farmerId && String(row.farmer_id || "") !== farmerId) return false;
      if (companyAccountId && String(row.company_account_id || "") !== companyAccountId) return false;
      return true;
    });
    const filter = assignedWarehouseFilter(req.user, "p.warehouse_id");
    const paymentParams = [...filter.params];
    let farmerClause = "";
    let accountClause = "";
    if (farmerId) {
      farmerClause = " AND CAST(p.farmer_id AS TEXT) = CAST(? AS TEXT)";
      paymentParams.push(farmerId);
    }
    if (companyAccountId) {
      accountClause = " AND CAST(p.company_account_id AS TEXT) = CAST(? AS TEXT)";
      paymentParams.push(companyAccountId);
    }
    const payments = await dbAll(
      `
        SELECT p.*, w.name AS warehouse_name, f.name AS farmer_name, ca.account_name AS company_account_name
        FROM wh_payment_vouchers p
        LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(p.warehouse_id AS TEXT)
        LEFT JOIN farmers f ON CAST(f.id AS TEXT) = CAST(p.farmer_id AS TEXT)
        LEFT JOIN company_accounts ca ON CAST(ca.id AS TEXT) = CAST(p.company_account_id AS TEXT)
        WHERE 1 = 1 ${filter.clause} ${farmerClause} ${accountClause}
      `,
      paymentParams
    );

    const paymentIds = payments.map((row) => row.id);
    const sqliteAdjustments = paymentIds.length
      ? await dbAll(
          `
            SELECT a.*, pv.voucher_no AS purchase_voucher_no
            FROM wh_payment_adjustments a
            LEFT JOIN wh_purchase_vouchers pv ON CAST(pv.id AS TEXT) = CAST(a.purchase_id AS TEXT)
            WHERE a.payment_id IN (${paymentIds.map(() => "?").join(",")})
            ORDER BY a.id ASC
          `,
          paymentIds
        )
      : [];
    const purchaseMap = new Map(purchases.map((row) => [String(row.id || row._id), row]));
    const paymentMap = new Map(payments.map((row) => [String(row.id), row]));
    const adjustmentsByPayment = new Map();
    const adjustmentsByPurchase = new Map();
    sqliteAdjustments.forEach((item) => {
      const paymentId = String(item.payment_id);
      const purchaseId = String(item.purchase_id);
      const purchase = purchaseMap.get(String(item.purchase_id));
      const payment = paymentMap.get(paymentId);
      const voucherNo = item.purchase_voucher_no || purchase?.voucher_no || item.purchase_id;
      const detail = {
        ...item,
        purchase_voucher_no: voucherNo,
        payment_date: payment?.date || "",
        payment_voucher_no: payment?.voucher_no || "",
        payment_amount: Number(payment?.amount || 0),
      };
      if (!adjustmentsByPayment.has(paymentId)) adjustmentsByPayment.set(paymentId, []);
      adjustmentsByPayment.get(paymentId).push(detail);
      if (!adjustmentsByPurchase.has(purchaseId)) adjustmentsByPurchase.set(purchaseId, []);
      adjustmentsByPurchase.get(purchaseId).push(detail);
    });

    const rows = [
      ...purchases.map((row) => {
        const purchaseId = String(row.id || row._id);
        const paymentDetails = adjustmentsByPurchase.get(purchaseId) || [];
        const purchaseAmount = Number(row.total_amount || row.net_amount_payable || row.amount || 0);
        const paymentAmount = paymentDetails.reduce((sum, item) => sum + Number(item.adjusted_amount || 0), 0);
        return {
          date: row.date,
          voucher_no: row.voucher_no,
          voucher_type: "Purchase",
          particulars: `Purchase Bill ${row.voucher_no || ""}`.trim(),
          adjustment_details: paymentDetails
            .map((item) => `${item.payment_date || "-"} ${item.payment_voucher_no || "-"}: Rs.${fmtNum(item.adjusted_amount)}`)
            .join("; "),
          payment_details: paymentDetails,
          purchase_id: purchaseId,
          purchase_amount: Number(purchaseAmount.toFixed(2)),
          payment_amount: Number(paymentAmount.toFixed(2)),
          journal_amount: 0,
          receipt_amount: 0,
          bill_balance: Number((purchaseAmount - paymentAmount).toFixed(2)),
          warehouse_id: row.warehouse_id,
          warehouse_name: row.warehouse_name,
          farmer_id: row.farmer_id,
          farmer_name: row.farmer_name,
          company_account_id: row.company_account_id,
          company_account_name: row.company_account_name,
          debit: 0,
          credit: purchaseAmount,
        };
      }),
      ...payments.map((row) => {
        const paymentAdjustments = adjustmentsByPayment.get(String(row.id)) || [];
        const adjustmentDetails = paymentAdjustments
          .map((item) => `${item.purchase_voucher_no}: Rs.${fmtNum(item.adjusted_amount)}`)
          .join("; ");
        return {
          date: row.date,
          voucher_no: row.voucher_no,
          voucher_type: "Payment",
          particulars: `Payment adjusted against ${paymentAdjustments.map((item) => item.purchase_voucher_no).filter(Boolean).join(", ") || row.reference_id || "purchase bill"}`,
          adjustment_details: adjustmentDetails,
          reference_id: row.reference_id || paymentAdjustments.map((item) => item.purchase_voucher_no).filter(Boolean).join(", "),
          warehouse_id: row.warehouse_id,
          warehouse_name: row.warehouse_name,
          farmer_id: row.farmer_id,
          farmer_name: row.farmer_name,
          company_account_id: row.company_account_id,
          company_account_name: row.company_account_name,
          debit: Number(row.amount || 0),
          credit: 0,
        };
      }),
    ];

    res.json(buildLedgerRows(rows, (row) => row.farmer_id, (row) => row.farmer_name || "Unknown Farmer"));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/report/sale-party-ledger", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.sale")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    const sales = await getSaleReportRowsForUser(req.user);
    const filter = assignedWarehouseFilter(req.user, "r.warehouse_id");
    const receipts = await dbAll(
      `
        SELECT r.*, w.name AS warehouse_name, c.name AS company_name
        FROM wh_receipt_vouchers r
        LEFT JOIN warehouses w ON CAST(w.id AS TEXT) = CAST(r.warehouse_id AS TEXT)
        LEFT JOIN companies c ON CAST(c.id AS TEXT) = CAST(r.company_id AS TEXT)
        WHERE 1 = 1 ${filter.clause}
      `,
      filter.params
    );

    const rows = [
      ...sales.map((row) => ({
        date: row.date,
        voucher_no: row.voucher_no,
        voucher_type: "Sale",
        warehouse_id: row.warehouse_id,
        warehouse_name: row.warehouse_name,
        company_id: row.company_id,
        company_name: row.company_name,
        debit: Number(row.total_amount || row.net_receivable_amount || row.amount || 0),
        credit: 0,
      })),
      ...receipts.map((row) => ({
        date: row.date,
        voucher_no: row.voucher_no,
        voucher_type: "Receipt",
        warehouse_id: row.warehouse_id,
        warehouse_name: row.warehouse_name,
        company_id: row.company_id,
        company_name: row.company_name,
        debit: 0,
        credit: Number(row.amount || 0),
      })),
    ];

    res.json(buildLedgerRows(rows, (row) => row.company_id, (row) => row.company_name || "Unknown Company"));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/report/warehouse-stock", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.purchase") && !userHasPermission(req.user, "warehouse.trading.report.sale")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    const [purchases, sales] = await Promise.all([
      getPurchaseReportRowsForUser(req.user),
      getSaleReportRowsForUser(req.user),
    ]);
    res.json(groupStock(purchases, sales));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/report/fifo-stock", async (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.report.purchase") && !userHasPermission(req.user, "warehouse.trading.report.sale")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    const [purchases, sales] = await Promise.all([
      getPurchaseReportRowsForUser(req.user),
      getSaleReportRowsForUser(req.user),
    ]);
    res.json(buildFifoStock(purchases, sales));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PDF download for purchase voucher - available to authenticated users
router.get("/purchase/:id/pdf", (req, res) => {
  const id = req.params.id;
  const q = `
    SELECT
      p.*,
      w.name AS warehouse_name,
      w.address AS warehouse_address,
      l.name AS warehouse_location,
      ca.account_name AS company_account_name,
      ca.mobile AS company_account_mobile,
      ca.pan_no AS company_account_pan,
      ca.address AS company_account_address,
      f.name AS farmer_name,
      f.mobile AS farmer_mobile,
      f.address AS farmer_address,
      f.village AS farmer_village,
      f.gst_no AS farmer_gst,
      f.pan_no AS farmer_pan,
      f.state AS farmer_state,
      NULL AS farmer_bank_name,
      NULL AS farmer_bank_account_no,
      NULL AS farmer_ifsc_code,
      NULL AS farmer_branch_name,
      NULL AS farmer_account_holder_name,
      pr.name AS product_name
    FROM wh_purchase_vouchers p
    LEFT JOIN warehouses w ON w.id = p.warehouse_id
    LEFT JOIN locations l ON l.id = w.location_id
    LEFT JOIN company_accounts ca ON ca.id = p.company_account_id
    LEFT JOIN farmers f ON f.id = p.farmer_id
    LEFT JOIN products pr ON pr.id = p.product_id
    WHERE p.id = ?
  `;
  db.get(q, [id], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) {
      try {
        row = await getMongoPurchaseVoucherForPdf(id);
      } catch (mongoErr) {
        console.error("Mongo purchase PDF lookup failed:", mongoErr.message);
        return res.status(500).json({ error: mongoErr.message });
      }
    }

    if (!row) return res.status(404).json({ error: "Not found" });
    if (!req.user) return res.status(403).json({ error: "Authentication required" });
    if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;

    try {
      row = await enrichPurchaseVoucherPdfRow(row);
    } catch (enrichErr) {
      console.error("Purchase PDF enrichment failed:", enrichErr.message);
    }

    sendPurchaseVoucherPdf(res, row, id);
  });
});

router.get("/sale/:id/pdf", (req, res) => {
  const id = req.params.id;
  const q = `
    SELECT
      s.*,
      w.name AS warehouse_name,
      c.name AS company_name,
      co.name AS consignee_name,
      p.name AS product_name
    FROM wh_sale_vouchers s
    LEFT JOIN warehouses w ON w.id = s.warehouse_id
    LEFT JOIN companies c ON c.id = s.company_id
    LEFT JOIN consignee_names co ON co.id = s.consignee_id
    LEFT JOIN products p ON p.id = s.product_id
    WHERE s.id = ?
  `;

  db.get(q, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Not found" });
    if (!req.user) return res.status(403).json({ error: "Authentication required" });
    if (!ensureWarehouseAccess(req, res, row.warehouse_id)) return;

    const doc = new PDFDocument({ size: "A4", margin: 36 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="sale_${row.voucher_no || id}.pdf"`);
    doc.pipe(res);

    doc.fontSize(18).text("SALE VOUCHER", { align: "center" });
    doc.moveDown(0.6);
    doc.fontSize(11).text(`Voucher No: ${row.voucher_no || "-"}`);
    doc.text(`Sale Date: ${fmtDate(row.date)}`);
    doc.text(`Unloading Date: ${fmtDate(row.unloading_date)}`);
    doc.text(`Warehouse: ${row.warehouse_name || row.warehouse_id || "-"}`);
    doc.text(`Company: ${row.company_name || "-"}`);
    doc.text(`Consignee: ${row.consignee_name || "-"}`);
    doc.text(`Product: ${row.product_name || "-"}`);
    doc.moveDown(0.4);
    doc.text(`Qty: ${fmtNum(row.quantity)}`);
    doc.text(`Unloading Qty: ${fmtNum(row.unloading_qty || row.quantity)}`);
    doc.text(`Shortage Qty: ${fmtNum(row.shortage_quantity)}`);
    doc.text(`Rate: ${fmtNum(row.rate)}`);
    doc.text(`Amount: ${fmtNum(row.amount)}`);
    doc.text(`Claim: ${fmtNum(row.claim_amount)}`);
    doc.text(`Other Deduction: ${fmtNum(row.other_deduction)}`);
    doc.text(`Adjustment: ${fmtNum(row.adjustment_amount)}`);
    doc.text(`TDS: ${fmtNum(row.tds_amount)}`);
    doc.text(`Net Receivable: ${fmtNum(row.net_receivable_amount || row.net_amount || row.amount)}`);
    doc.text(`Outstanding: ${fmtNum(row.outstanding)}`);

    if (row.description) {
      doc.moveDown(0.4);
      doc.text(`Remarks: ${row.description}`);
    }

    doc.end();
  });
});

// Update purchase voucher
router.put("/purchase/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  const {
    voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
    packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
    discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
    total_deduction, round_off, net_amount_payable, employee_id, location_id, description
  } = req.body;

  if (!ensureWarehouseAccess(req, res, warehouse_id)) return;

  if (mongoReady() && mongoose.Types.ObjectId.isValid(String(id))) {
    const payload = buildPurchasePayload(req.body, voucher_no);
    return PurchaseVoucher.findByIdAndUpdate(id, payload, { new: true })
      .then((doc) => {
        if (!doc) return res.status(404).json({ error: "Voucher not found" });
        res.json({ id: String(doc._id), _id: String(doc._id), message: "Voucher updated successfully", saved_to: "mongodb" });
      })
      .catch((err) => {
        if (err?.code === 11000) return res.status(400).json({ error: "Voucher number already exists" });
        res.status(500).json({ error: err.message });
      });
  }

  const query = `
    UPDATE wh_purchase_vouchers SET
      voucher_no=?, date=?, warehouse_id=?, farmer_id=?, company_account_id=?, product_id=?, quantity=?, rate=?, amount=?,
      packet=?, gross_weight=?, tare_weight=?, dhalta=?, less_bags_weight=?, moisture=?, dunki=?, fungus=?,
      discolour=?, others=?, net_weight=?, bags_claim=?, labour=?, total_deduct_amount=?, total_qty=?,
      total_deduction=?, round_off=?, net_amount_payable=?, employee_id=?, location_id=?, description=?
    WHERE id = ?
  `;

  db.run(query, [
    voucher_no, date, warehouse_id, farmer_id, company_account_id, product_id, quantity, rate, amount,
    packet, gross_weight, tare_weight, dhalta, less_bags_weight, moisture, dunki, fungus,
    discolour, others, net_weight, bags_claim, labour, total_deduct_amount, total_qty,
    total_deduction, round_off, net_amount_payable, employee_id, location_id, description, id
  ], function(err) {
    if (err) {
      if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Voucher number already exists" });
      return res.status(500).json({ error: err.message });
    }
    res.json({ id, message: "Voucher updated successfully" });
  });
});

// Delete purchase voucher
router.delete("/purchase/:id", (req, res) => {
  if (!userHasPermission(req.user, "warehouse.trading.purchase.manage")) {
    return res.status(403).json({ error: "Permission denied" });
  }

  const id = req.params.id;
  if (mongoReady() && mongoose.Types.ObjectId.isValid(String(id))) {
    return PurchaseVoucher.findById(id)
      .then((doc) => {
        if (!doc) return res.status(404).json({ error: "Voucher not found" });
        if (!ensureWarehouseAccess(req, res, doc.warehouse_id)) return null;
        return PurchaseVoucher.deleteOne({ _id: id }).then(() => res.json({ message: "Voucher deleted successfully" }));
      })
      .catch((err) => res.status(500).json({ error: err.message }));
  }

  const query = "DELETE FROM wh_purchase_vouchers WHERE id = ?";

  db.run(query, [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "Voucher not found" });
    res.json({ message: "Voucher deleted successfully" });
  });
});

module.exports = router;
