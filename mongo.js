const mongoose = require("mongoose");

require("dotenv").config();


// =========================
// LOCATION
// =========================
const locationSchema =
  new mongoose.Schema({

    name: String,

    address: String,
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