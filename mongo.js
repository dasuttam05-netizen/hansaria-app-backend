const mongoose = require("mongoose");
const dns = require("node:dns");

require("dotenv").config();

mongoose.set("bufferCommands", false);

const rawMongoUri = process.env.MONGODB_URI?.trim() || "";
const mongoDnsServers = String(process.env.MONGODB_DNS_SERVERS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (mongoDnsServers.length > 0) {
  dns.setServers(mongoDnsServers);
  console.log(`Using custom DNS servers for MongoDB: ${mongoDnsServers.join(", ")}`);
}

function normalizeAtlasUri(uri) {
  if (!uri || !uri.startsWith("mongodb+srv://")) return uri;
  return uri.replace(
    /\/([^/?#=]+)=([^/?#]+)$/,
    "/$1?retryWrites=true&w=majority&appName=$2"
  );
}

const mongodbUri = normalizeAtlasUri(rawMongoUri);
const hasMongoUri = mongodbUri && !mongodbUri.includes("username:password");

if (!hasMongoUri) {
  console.log("MongoDB URI is not configured or contains placeholder credentials.");
} else if (mongoose.connection.readyState === 0) {
  if (mongodbUri !== rawMongoUri) {
    console.log("Normalized MongoDB URI format from legacy value in .env.");
  }

  mongoose
    .connect(mongodbUri, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 45000,
    })
    .then(() => console.log("Connected to MongoDB"))
    .catch((err) => {
      if (err?.syscall === "querySrv") {
        console.error("MongoDB SRV DNS lookup failed. Switch DNS server or use Atlas non-SRV URI.");
      }
      console.error("MongoDB Connection Error:", err.message);
    });
}


// =========================
// LOCATION
// =========================
const locationSchema =
  new mongoose.Schema({

    name: String,

    address: String,

    abbr: String,
  });


// =========================
// EMPLOYEE
// =========================
const employeeSchema =
  new mongoose.Schema({

    // CUSTOM EMPLOYEE ID
    employee_id: {
      type: String,
      unique: true,
    },

    name: String,

    mobile: String,

    address: String,

    username: {
      type: String,
      unique: true,
    },

    password: String,

    location_id: {
      type:
        mongoose.Schema.Types.ObjectId,
      ref: "Location",
    },

    location_ids: [{
      type:
        mongoose.Schema.Types.ObjectId,
      ref: "Location",
    }],

    all_location_access: {
      type: Boolean,
      default: false,
    },

    role: String,

    permissions: [String],

    opening_balance: {
      type: Number,
      default: 0,
    },

    opening_balance_type: {
      type: String,
      default: "dr",
    },

    assigned_warehouse_ids: [{
      type:
        mongoose.Schema.Types.ObjectId,
      ref: "Warehouse",
    }],

    all_warehouse_access: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  });


// =========================
// COMPANY
// =========================
const companySchema =
  new mongoose.Schema({

    name: String,

    address: String,

    mobile: String,

    opening_balance: {
      type: Number,
      default: 0,
    },

    opening_balance_type: {
      type: String,
      default: "dr",
    },
  },
  {
    timestamps: true,
  });


// =========================
// FARMER
// =========================
const farmerSchema =
  new mongoose.Schema({
    name: {
      type: String,
      required: true,
    },
    mobile: String,
    email: String,
    address: String,
    village: String,
    pincode: String,
    state: String,
    district: String,
    city: String,
    room_floor_building: String,
    street_locality_landmark: String,
    gst_no: String,
    pan_no: String,
    aadhar_no: String,
    aadhaar_pan_link_status: {
      type: String,
      default: "unknown",
    },
    bank_name: String,
    bank_account_no: String,
    ifsc_code: String,
    branch_name: String,
    account_holder_name: String,
    location: String,
  },
  {
    timestamps: true,
  });


// =========================
// COMPANY ACCOUNT
// =========================
const companyAccountSchema =
  new mongoose.Schema({

    account_name: String,

    address: String,

    company_id: {
      type:
        mongoose.Schema.Types.ObjectId,
      ref: "Company",
    },

    pan_no: String,

    mobile: String,
  });


// =========================
// WAREHOUSE
// =========================
const warehouseSchema =
  new mongoose.Schema({

    name: String,

    address: String,
    pincode: String,
    state: String,
    district: String,
    city: String,
    room_floor_building: String,
    street_locality_landmark: String,

    location_id: {
      type:
        mongoose.Schema.Types.ObjectId,
      ref: "Location",
    },

    employee_id: {
      type:
        mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },

    employee_ids: [{
      type:
        mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    }],

    opening_balance: {
      type: Number,
      default: 0,
    },

    opening_balance_type: {
      type: String,
      default: "dr",
    },
  });


// =========================
// PRODUCT
// =========================
const productSchema =
  new mongoose.Schema({

    name: String,

    hsn_code: String,
  });


// =========================
// WAREHOUSE PURCHASE VOUCHER
// =========================
const purchaseVoucherSchema =
  new mongoose.Schema({
    voucher_no: {
      type: String,
      index: true,
    },
    date: String,
    warehouse_id: String,
    farmer_id: String,
    company_account_id: String,
    product_id: String,
    quantity: { type: Number, default: 0 },
    rate: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    packet: { type: Number, default: 0 },
    gross_weight: { type: Number, default: 0 },
    tare_weight: { type: Number, default: 0 },
    dhalta: { type: Number, default: 0 },
    less_bags_weight: { type: Number, default: 0 },
    moisture: { type: Number, default: 0 },
    dunki: { type: Number, default: 0 },
    fungus: { type: Number, default: 0 },
    discolour: { type: Number, default: 0 },
    others: { type: Number, default: 0 },
    net_weight: { type: Number, default: 0 },
    bags_claim: { type: Number, default: 0 },
    labour: { type: Number, default: 0 },
    total_deduct_amount: { type: Number, default: 0 },
    total_qty: { type: Number, default: 0 },
    total_deduction: { type: Number, default: 0 },
    round_off: { type: Number, default: 0 },
    net_amount_payable: { type: Number, default: 0 },
    employee_id: String,
    location_id: String,
    description: String,
  },
  {
    timestamps: true,
  });


// =========================
// WAREHOUSE SALE VOUCHER
// =========================
const saleVoucherSchema =
  new mongoose.Schema({
    voucher_no: {
      type: String,
      index: true,
    },
    date: String,
    unloading_date: String,
    warehouse_id: String,
    buyer_id: String,
    company_id: String,
    company_account_id: String,
    consignee_id: String,
    po_no: String,
    due_date: String,
    against_purchase_enabled: { type: Boolean, default: false },
    against_purchase_farmer_id: String,
    against_purchase_links: [
      {
        purchase_id: String,
        voucher_no: String,
        farmer_id: String,
        quantity: { type: Number, default: 0 },
        rate: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
    ],
    lorry_no: String,
    product_id: String,
    quantity: { type: Number, default: 0 },
    shortage_quantity: { type: Number, default: 0 },
    rate: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    packet: { type: Number, default: 0 },
    gross_weight: { type: Number, default: 0 },
    tare_weight: { type: Number, default: 0 },
    net_weight: { type: Number, default: 0 },
    unloading_qty: { type: Number, default: 0 },
    moisture: { type: Number, default: 0 },
    dunki: { type: Number, default: 0 },
    fungus: { type: Number, default: 0 },
    discolour: { type: Number, default: 0 },
    others: { type: Number, default: 0 },
    total_deduction: { type: Number, default: 0 },
    bags_claim: { type: Number, default: 0 },
    other_deduction: { type: Number, default: 0 },
    claim_amount: { type: Number, default: 0 },
    cd_percent: { type: Number, default: 0 },
    cd_amount: { type: Number, default: 0 },
    adjustment_amount: { type: Number, default: 0 },
    tds_amount: { type: Number, default: 0 },
    net_amount: { type: Number, default: 0 },
    net_receivable_amount: { type: Number, default: 0 },
    fifo_rate: { type: Number, default: 0 },
    fifo_amount: { type: Number, default: 0 },
    outstanding: { type: Number, default: 0 },
    round_off: { type: Number, default: 0 },
    net_amount_payable: { type: Number, default: 0 },
    employee_id: String,
    location_id: String,
    description: String,
  },
  {
    timestamps: true,
  });


// =========================
// EXPORTS
// =========================
module.exports = {

  mongoose,

  Location:
    mongoose.models.Location ||
    mongoose.model(
      "Location",
      locationSchema
    ),

  Employee:
    mongoose.models.Employee ||
    mongoose.model(
      "Employee",
      employeeSchema
    ),

  Company:
    mongoose.models.Company ||
    mongoose.model(
      "Company",
      companySchema
    ),

  Farmer:
    mongoose.models.Farmer ||
    mongoose.model(
      "Farmer",
      farmerSchema
    ),

  CompanyAccount:
    mongoose.models.CompanyAccount ||
    mongoose.model(
      "CompanyAccount",
      companyAccountSchema
    ),

  Warehouse:
    mongoose.models.Warehouse ||
    mongoose.model(
      "Warehouse",
      warehouseSchema
    ),

  Product:
    mongoose.models.Product ||
    mongoose.model(
      "Product",
      productSchema
    ),

  PurchaseVoucher:
    mongoose.models.PurchaseVoucher ||
    mongoose.model(
      "PurchaseVoucher",
      purchaseVoucherSchema
    ),

  SaleVoucher:
    mongoose.models.SaleVoucher ||
    mongoose.model(
      "SaleVoucher",
      saleVoucherSchema
    ),
};
