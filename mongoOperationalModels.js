const base = require("./db-mongodb");
const mongoose = base.mongoose;

function model(name, collection) {
  const schema = new mongoose.Schema(
    {},
    {
      strict: false,
      timestamps: false,
      collection,
    }
  );

  return (
    mongoose.models[name] ||
    mongoose.model(name, schema, collection)
  );
}

module.exports = {
  mongoose,

  CompanyOperational:
    model(
      "CompanyOperationalStep10D",
      "companies"
    ),

  CompanyAccountOperational:
    model(
      "CompanyAccountOperationalStep10D",
      "companyaccounts"
    ),

  WarehouseOperational:
    model(
      "WarehouseOperationalStep10D",
      "warehouses"
    ),

  LocationOperational:
    model(
      "LocationOperationalStep10D",
      "locations"
    ),

  ProductOperational:
    model(
      "ProductOperationalStep10D",
      "products"
    ),

  EmployeeOperational:
    model(
      "EmployeeOperationalStep10D",
      "employees"
    ),

  FarmerOperational:
    model(
      "FarmerOperationalStep10D",
      "farmers"
    ),

  InwardOperational:
    model(
      "InwardOperationalStep10D",
      "inwards"
    ),

  AdjustmentOperational:
    model(
      "AdjustmentOperationalStep10D",
      "adjustments"
    ),

  OutwardOperational:
    model(
      "OutwardOperationalStep10D",
      "outwards"
    ),

  BuyerAdjustmentOperational:
    model(
      "BuyerAdjustmentOperationalStep10D",
      "buyeradjustments"
    ),

  PurchaseVoucherOperational:
    model(
      "PurchaseVoucherOperationalStep10D",
      "purchasevouchers"
    ),

  PaltiLorryOperational:
    model(
      "PaltiLorryOperationalStep10G",
      "paltilorryentries"
    ),

  TransportBiltiOperational:
    model(
      "TransportBiltiOperationalStep10G",
      "transportbilti"
    ),

  TransporterOperational:
    model(
      "TransporterOperationalStep10G",
      "transporters"
    ),
};
