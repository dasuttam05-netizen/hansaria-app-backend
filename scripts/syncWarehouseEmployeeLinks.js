require("dotenv").config();

const { mongoose, Warehouse, Employee } = require("../mongo");

function normalizeId(value) {
  if (!value) return "";
  if (value._id) return String(value._id);
  return String(value);
}

function parseIds(input) {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input.map((v) => normalizeId(v)).filter(Boolean)
    )
  );
}

async function waitForMongo(timeoutMs = 15000) {
  if (mongoose.connection.readyState === 1) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Mongo connection timeout")), timeoutMs);
    mongoose.connection.once("connected", () => {
      clearTimeout(timer);
      resolve();
    });
    mongoose.connection.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function run() {
  await waitForMongo();

  const warehouses = await Warehouse.find({}, { _id: 1, employee_id: 1, employee_ids: 1 }).lean();
  const mapByEmployee = new Map();

  for (const wh of warehouses) {
    const whId = normalizeId(wh._id);
    const ids = Array.from(
      new Set([
        ...parseIds(wh.employee_ids),
        ...(normalizeId(wh.employee_id) ? [normalizeId(wh.employee_id)] : []),
      ])
    );
    ids.forEach((empId) => {
      if (!mapByEmployee.has(empId)) mapByEmployee.set(empId, new Set());
      mapByEmployee.get(empId).add(whId);
    });
  }

  // reset all assigned links first
  await Employee.collection.updateMany({}, { $set: { assigned_warehouse_ids: [] } });

  let updated = 0;
  for (const [empId, whSet] of mapByEmployee.entries()) {
    if (!mongoose.Types.ObjectId.isValid(empId)) continue;
    const whIds = Array.from(whSet).filter((id) => mongoose.Types.ObjectId.isValid(id));
    await Employee.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(empId) },
      { $set: { assigned_warehouse_ids: whIds } }
    );
    updated += 1;
  }

  console.log(JSON.stringify({ warehouses_scanned: warehouses.length, employees_updated: updated }, null, 2));
}

run()
  .catch((err) => {
    console.error("syncWarehouseEmployeeLinks failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.connection.close();
    } catch (_err) {}
  });
