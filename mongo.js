const mongoose = require("mongoose");

require("dotenv").config();


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
    state: String,
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
};
