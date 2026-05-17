require("dotenv").config();

const { mongoose, Employee, Warehouse } = require("../mongo");

function asId(value) {
  if (!value) return "";
  if (value._id) return String(value._id);
  return String(value);
}

async function waitForMongoConnection(timeoutMs = 15000) {
  if (mongoose.connection.readyState === 1) return;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("MongoDB connection timeout"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      mongoose.connection.off("connected", onConnected);
      mongoose.connection.off("error", onError);
    }

    function onConnected() {
      cleanup();
      resolve();
    }

    function onError(err) {
      cleanup();
      reject(err || new Error("MongoDB connection failed"));
    }

    mongoose.connection.on("connected", onConnected);
    mongoose.connection.on("error", onError);
  });
}

async function run() {
  await waitForMongoConnection();

  const employees = await Employee.find(
    {},
    { _id: 1, assigned_warehouse_ids: 1 }
  ).lean();

  const warehouses = await Warehouse.find(
    {},
    { _id: 1, employee_id: 1, employee_ids: 1 }
  ).lean();

  const employeeToWarehouseMap = new Map();

  for (const employee of employees) {
    employeeToWarehouseMap.set(
      asId(employee._id),
      new Set(
        Array.isArray(employee.assigned_warehouse_ids)
          ? employee.assigned_warehouse_ids.map((id) => asId(id)).filter(Boolean)
          : []
      )
    );
  }

  for (const warehouse of warehouses) {
    const warehouseId = asId(warehouse._id);
    if (!warehouseId) continue;

    const legacyEmployeeIds = new Set();
    if (warehouse.employee_id) {
      legacyEmployeeIds.add(asId(warehouse.employee_id));
    }
    if (Array.isArray(warehouse.employee_ids)) {
      for (const employeeId of warehouse.employee_ids) {
        legacyEmployeeIds.add(asId(employeeId));
      }
    }

    for (const employeeId of legacyEmployeeIds) {
      if (!employeeId) continue;
      if (!employeeToWarehouseMap.has(employeeId)) {
        employeeToWarehouseMap.set(employeeId, new Set());
      }
      employeeToWarehouseMap.get(employeeId).add(warehouseId);
    }
  }

  const bulkOps = [];
  let changedCount = 0;

  for (const employee of employees) {
    const employeeId = asId(employee._id);
    const nextIds = Array.from(employeeToWarehouseMap.get(employeeId) || []);
    const currentIds = Array.isArray(employee.assigned_warehouse_ids)
      ? employee.assigned_warehouse_ids.map((id) => asId(id)).filter(Boolean)
      : [];

    const currentKey = currentIds.slice().sort().join(",");
    const nextKey = nextIds.slice().sort().join(",");

    if (currentKey === nextKey) continue;

    changedCount += 1;
    bulkOps.push({
      updateOne: {
        filter: { _id: employee._id },
        update: {
          $set: {
            assigned_warehouse_ids: nextIds,
          },
        },
      },
    });
  }

  if (bulkOps.length > 0) {
    await Employee.bulkWrite(bulkOps);
  }

  console.log(
    JSON.stringify(
      {
        employees_scanned: employees.length,
        warehouses_scanned: warehouses.length,
        employees_updated: changedCount,
      },
      null,
      2
    )
  );
}

run()
  .catch((err) => {
    console.error("Migration failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.connection.close();
    } catch (_err) {
      // ignore close errors
    }
  });
