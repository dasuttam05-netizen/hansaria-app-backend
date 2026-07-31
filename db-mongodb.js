const mongoose = require('mongoose');
const dns = require('node:dns');

require('dotenv').config();

mongoose.set('bufferCommands', false);

const rawMongoUri = process.env.MONGODB_URI?.trim() || '';
const mongoMirrorEnabled = String(process.env.MONGODB_MIRROR_ENABLED || 'true').toLowerCase() !== 'false';
const mongoDnsServers = String(process.env.MONGODB_DNS_SERVERS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

if (mongoDnsServers.length > 0) {
  dns.setServers(mongoDnsServers);
  console.log(`Using custom DNS servers for MongoDB: ${mongoDnsServers.join(', ')}`);
}

function normalizeAtlasUri(uri) {
  if (!uri || !uri.startsWith('mongodb+srv://')) return uri;
  return uri.replace(
    /\/([^/?#=]+)=([^/?#]+)$/,
    '/$1?retryWrites=true&w=majority&appName=$2'
  );
}

const mongodbUri = normalizeAtlasUri(rawMongoUri);
const hasMongoUri = mongodbUri && !mongodbUri.includes('username:password');
const mongoMirrorConfigured = mongoMirrorEnabled && hasMongoUri;

function isMongoMirrorReady() {
  return mongoMirrorEnabled && mongoose.connection.readyState === 1;
}

if (!mongoMirrorEnabled) {
  console.log('MongoDB mirror disabled (MONGODB_MIRROR_ENABLED=false).');
} else if (!hasMongoUri) {
  console.log('MongoDB URI is not configured or contains placeholder credentials. Skipping MongoDB mirror.');
} else if (mongoose.connection.readyState === 0) {
  if (mongodbUri !== rawMongoUri) {
    console.log('Normalized MongoDB URI format from legacy value in .env.');
  }

  mongoose
    .connect(mongodbUri, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 45000,
    })
    .then(() => console.log('Connected to MongoDB'))
    .catch((err) => {
      if (err?.syscall === 'querySrv') {
        console.error('MongoDB SRV DNS lookup failed. Switch DNS server or use Atlas non-SRV URI.');
      }
      console.error('MongoDB Connection Error:', err.message);
    });
} else {
  console.log('MongoDB connection already initialized.');
}

// Define Schemas and Models
const locationSchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: String,
  hsn_code: String,
  created_at: { type: Date, default: Date.now },
});

const employeeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  employee_id: { type: String, unique: true, sparse: true },
  address: String,
  mobile: String,
  location_id: mongoose.Schema.Types.ObjectId,
  location_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: "Location" }],
  all_location_access: { type: Boolean, default: false },
  username: { type: String, unique: true, sparse: true },
  password: String,
  role: { type: String, default: 'staff' },
  permissions: { type: [String], default: [] },
  opening_balance: { type: Number, default: 0 },
  opening_balance_type: { type: String, default: "dr" },
  assigned_warehouse_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: "Warehouse" }],
  all_warehouse_access: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
});

const roleSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  permissions: { type: [String], default: [] },
  is_admin: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

const companySchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: String,
  mobile: String,
  opening_balance: { type: Number, default: 0 },
  opening_balance_type: { type: String, default: "dr" },
  created_at: { type: Date, default: Date.now },
});

const companyAccountSchema = new mongoose.Schema({
  account_name: { type: String, required: true },
  address: String,
  company_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  pan_no: String,
  mobile: String,
  created_at: { type: Date, default: Date.now },
});

const warehouseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: String,
  location_id: mongoose.Schema.Types.ObjectId,
  employee_id: mongoose.Schema.Types.ObjectId,
  created_at: { type: Date, default: Date.now },
});

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  hsn_code: String,
  created_at: { type: Date, default: Date.now },
});

const buyerNameSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  mobile: String,
  email: String,
  address: String,
  gst_no: String,
  pan_no: String,
  state: String,
  created_at: { type: Date, default: Date.now },
});

const consigneeNameSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  buyer_ids: [String],
  mobile: String,
  email: String,
  address: String,
  gst_no: String,
  state: String,
  created_at: { type: Date, default: Date.now },
});

const inwardSchema = new mongoose.Schema({
  date: Date,
  location: String,
  inward_no: String,
  company: String,
  company_account: String,
  product: String,
  quantity: Number,
  rate: Number,
  amount: Number,
  narration: String,
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

const outwardSchema = new mongoose.Schema({
  date: Date,
  location: String,
  outward_no: String,
  employee_id: { type: mongoose.Schema.Types.Mixed },
  location_id: { type: mongoose.Schema.Types.Mixed },
  warehouse_id: { type: mongoose.Schema.Types.Mixed },
  product_id: { type: mongoose.Schema.Types.Mixed },
  company_id: { type: mongoose.Schema.Types.Mixed },
  company_account_id: { type: mongoose.Schema.Types.Mixed },
  buyer: String,
  buyer_id: { type: mongoose.Schema.Types.Mixed },
  buyer_name: String,
  consignee_id: { type: mongoose.Schema.Types.Mixed },
  consignee_name: String,
  product: String,
  quantity: Number,
  rate: Number,
  amount: Number,
  transporter: String,
  lorry_no: String,
  inv_no: String,
  self_loading: String,
  status: { type: String, default: "Pending" },
  narration: String,
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

const adjustmentSchema = new mongoose.Schema({
  date: Date,
  location: String,
  product: String,
  old_quantity: Number,
  new_quantity: Number,
  reason: String,
  created_at: { type: Date, default: Date.now },
});

const buyerAdjustmentSchema = new mongoose.Schema({
  outward_id: { type: Number, required: true, index: true },
  buyer_id: Number,
  buyer_name: String,
  consignee_name: String,
  unloading_date: Date,
  weight: { type: Number, default: 0 },
  qty: { type: Number, default: 0 },
  rate: { type: Number, default: 0 },
  claim: { type: Number, default: 0 },
  other_deduction: { type: Number, default: 0 },
  shortage: { type: Number, default: 0 },
  shortage_amount: { type: Number, default: 0 },
  status: { type: String, default: 'Pending' },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

const stockSchema = new mongoose.Schema({
  location: String,
  product: String,
  quantity: { type: Number, default: 0 },
  updated_at: { type: Date, default: Date.now },
});

const transporterSchema = new mongoose.Schema({
  name: { type: String, required: true },
  mobile: String,
  address: String,
  gst_no: String,
  created_at: { type: Date, default: Date.now },
});

const expenseSchema = new mongoose.Schema({
  date: Date,
  location: String,
  category: String,
  amount: Number,
  description: String,
  created_at: { type: Date, default: Date.now },
});

const cashEntryAdjustmentSchema = new mongoose.Schema({
  target_entry_id: Number,
  adjusted_amount: Number,
});

const cashEntrySchema = new mongoose.Schema({
  id: { type: Number, index: true, unique: true },
  voucher_no: String,
  journal_group_no: String,
  entry_date: Date,
  entry_type: { type: String, enum: ['income', 'expense'] },
  warehouse_id: Number,
  company_id: Number,
  company_account_id: Number,
  description: String,
  amount: Number,
  payment_method: String,
  reference_no: String,
  narration: String,
  created_by: Number,
  employee_id: Number,
  fund_source: String,
  status: String,
  source_expense_id: Number,
  linked_entry_id: Number,
  adjustments: [cashEntryAdjustmentSchema],
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

cashEntrySchema.index({ entry_date: 1 });

const sqliteMirrorRowSchema = new mongoose.Schema(
  {
    table: { type: String, required: true, index: true },
    row_id: { type: Number, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    updated_at: { type: Date, default: Date.now },
  },
  {
    minimize: false,
  }
);

sqliteMirrorRowSchema.index({ table: 1, row_id: 1 }, { unique: true });

// Export models
module.exports = {
  mongoose,
  isMongoMirrorReady,
  mongoMirrorEnabled,
  mongoMirrorConfigured,
  Location: mongoose.models.Location || mongoose.model('Location', locationSchema),
  Employee: mongoose.models.Employee || mongoose.model('Employee', employeeSchema),
  Role: mongoose.models.Role || mongoose.model('Role', roleSchema),
  Company: mongoose.models.Company || mongoose.model('Company', companySchema),
  CompanyAccount: mongoose.models.CompanyAccount || mongoose.model('CompanyAccount', companyAccountSchema),
  Warehouse: mongoose.models.Warehouse || mongoose.model('Warehouse', warehouseSchema),
  Product: mongoose.models.Product || mongoose.model('Product', productSchema),
  BuyerName: mongoose.models.BuyerName || mongoose.model('BuyerName', buyerNameSchema),
  ConsigneeName: mongoose.models.ConsigneeName || mongoose.model('ConsigneeName', consigneeNameSchema),
  Inward: mongoose.models.Inward || mongoose.model('Inward', inwardSchema),
  Outward: mongoose.models.Outward || mongoose.model('Outward', outwardSchema),
  Adjustment: mongoose.models.Adjustment || mongoose.model('Adjustment', adjustmentSchema),
  BuyerAdjustment: mongoose.models.BuyerAdjustment || mongoose.model('BuyerAdjustment', buyerAdjustmentSchema),
  Stock: mongoose.models.Stock || mongoose.model('Stock', stockSchema),
  Transporter: mongoose.models.Transporter || mongoose.model('Transporter', transporterSchema),
  Expense: mongoose.models.Expense || mongoose.model('Expense', expenseSchema),
  CashEntry: mongoose.models.CashEntry || mongoose.model('CashEntry', cashEntrySchema),
  SqliteMirrorRow: mongoose.models.SqliteMirrorRow || mongoose.model('SqliteMirrorRow', sqliteMirrorRowSchema),
};
