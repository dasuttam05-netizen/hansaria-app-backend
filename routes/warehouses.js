const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

const {
  Warehouse,
  Employee,
  Company,
} = require("../mongo");

const {
  userHasPermission,
  isAdminUser,
} = require("../middleware/auth");

function parseEmployeeIds(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || "").split(",");

  return Array.from(
    new Set(
      raw
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
}

function mergeUniqueIds(...groups) {
  return Array.from(
    new Set(
      groups
        .flatMap((group) => (Array.isArray(group) ? group : []))
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
}

function normalizeId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value._id) return String(value._id);
  if (value.id) return String(value.id);
  return String(value);
}

function normalizeIdArray(input) {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => normalizeId(item))
        .filter(Boolean)
    )
  );
}

async function syncWarehouseEmployeeAssignments(warehouseId, employeeIds = []) {
  const warehouseIdStr = String(warehouseId || "");
  const safeEmployeeIds = Array.from(
    new Set(
      (Array.isArray(employeeIds) ? employeeIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )
  );

  // Remove this warehouse from all employees first, then add to selected employees.
  await Employee.collection.updateMany(
    {},
    { $pull: { assigned_warehouse_ids: warehouseIdStr } }
  );

  if (!safeEmployeeIds.length) return;

  const safeObjectIds = safeEmployeeIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (!safeObjectIds.length) return;

  await Employee.collection.updateMany(
    { _id: { $in: safeObjectIds } },
    { $addToSet: { assigned_warehouse_ids: warehouseIdStr } }
  );
}

router.get("/", async (req, res) => {

  try {

    const assignedIds =
      req.user?.assigned_warehouse_ids || [];

    const restrictToAssigned =
      req.user &&
      !userHasPermission(req.user, "all") &&
      !userHasPermission(
        req.user,
        "warehouses.manage"
      ) &&
      !userHasPermission(
        req.user,
        "report.partyStock"
      ) &&
      !userHasPermission(
        req.user,
        "report.partyLedger"
      ) &&
      !userHasPermission(
        req.user,
        "report.warehouseRentLedger"
      ) &&
      !userHasPermission(
        req.user,
        "report.warehouseRentMonthEnd"
      ) &&
      assignedIds.length > 0;

    const filter =
      restrictToAssigned
        ? {
            _id: {
              $in: assignedIds,
            },
          }
        : {};

    const rows =
      await Warehouse.find(filter)

        .populate(
          "location_id",
          "name"
        )

        .populate(
          "employee_id",
          "name"
        )

        .sort({
          created_at: -1,
        });

    const companyIds = Array.from(new Set(rows.map((row) => normalizeId(row.company_id)).filter(Boolean)));
    const companyNameMap = new Map();
    if (companyIds.length) {
      const companyRows = await Company.find({ _id: { $in: companyIds } }, { name: 1, company_name: 1 });
      companyRows.forEach((company) => {
        companyNameMap.set(String(company._id), company.name || company.company_name || "");
      });
    }

    const warehouseIds = rows.map((row) => String(row._id));
    const employeeRowsByAssignment =
      warehouseIds.length
        ? await Employee.collection
            .find(
              { assigned_warehouse_ids: { $in: warehouseIds } },
              { projection: { _id: 1, name: 1, assigned_warehouse_ids: 1 } }
            )
            .toArray()
        : [];

    const employeeIdsFromRows = Array.from(
      new Set(
        rows.flatMap((row) =>
          mergeUniqueIds(
            normalizeIdArray(row.employee_ids),
            normalizeId(row.employee_id) ? [normalizeId(row.employee_id)] : []
          )
        )
      )
    );

    const allEmployeeIds =
      Array.from(
        new Set([
          ...employeeIdsFromRows,
          ...(employeeRowsByAssignment || []).map((emp) => String(emp._id)),
        ])
      );

    const employeeNameMap =
      new Map();

    if (allEmployeeIds.length) {
      const employeeRows =
        await Employee.find(
          { _id: { $in: allEmployeeIds } },
          { name: 1 }
        );
      employeeRows.forEach((emp) => {
        employeeNameMap.set(String(emp._id), emp.name || "");
      });
    }

    const warehouseToEmployeeSet = new Map();
    for (const row of rows) {
      const key = String(row._id);
      warehouseToEmployeeSet.set(
        key,
        new Set(
          mergeUniqueIds(
            normalizeIdArray(row.employee_ids),
            normalizeId(row.employee_id) ? [normalizeId(row.employee_id)] : []
          )
        )
      );
    }

    for (const emp of employeeRowsByAssignment || []) {
      const empId = String(emp._id);
      const assignedWarehouseIds = normalizeIdArray(emp.assigned_warehouse_ids);
      assignedWarehouseIds.forEach((whId) => {
        if (!warehouseToEmployeeSet.has(String(whId))) return;
        warehouseToEmployeeSet.get(String(whId)).add(empId);
      });
    }

    const formatted =
      rows.map((row) => ({

        ...row.toObject(),

        id: row._id,

        short_id:
          String(row._id).slice(-6),

        location_id:
          normalizeId(row.location_id),

        location_name:
          row.location_id?.name || "",

        employee_id:
          normalizeId(row.employee_id),

        employee_name:
          row.employee_id?.name || "",

        employee_ids: Array.from(
          warehouseToEmployeeSet.get(String(row._id)) || []
        ),

        employee_names:
          Array.from(
            new Set([
              ...Array.from(
                warehouseToEmployeeSet.get(String(row._id)) || []
              ).map((empId) => employeeNameMap.get(empId) || ""),
              row.employee_name || "",
            ])
          )
            .filter(Boolean),

        company_id: normalizeId(row.company_id),
        company_name: companyNameMap.get(normalizeId(row.company_id)) || "",
        monthly_rent: Number(row.monthly_rent || 0),

      }));

    return res.json(
      formatted
    );

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });

  }

});

router.post("/", async (req, res) => {

  try {

    if (!userHasPermission(req.user, "warehouses.create")) {

      return res.status(403).json({
        error:
          "Only admin can edit warehouse master",
      });

    }

    const {
      name,
      address,
      pincode,
      state,
      district,
      city,
      room_floor_building,
      street_locality_landmark,
      location_id,
      employee_id,
      employee_ids,
      opening_balance,
      opening_balance_type,
      company_id,
      monthly_rent,
    } = req.body;

    if (
      !name ||
      !address
    ) {

      return res.status(400).json({
        error:
          "Name and address are required",
      });

    }

    const safeEmployeeIds =
      parseEmployeeIds(employee_ids);

    const primaryEmployeeId =
      safeEmployeeIds[0] ||
      employee_id ||
      null;

    const safeOpeningBalance = Number.isFinite(Number(opening_balance)) ? Number(opening_balance) : 0;
    const safeOpeningBalanceType =
      String(opening_balance_type || "dr").toLowerCase() === "cr"
        ? "cr"
        : "dr";

    const warehouse =
      await Warehouse.create({

        name,

        address,

        pincode: pincode || null,
        state: state || null,
        district: district || null,
        city: city || null,
        room_floor_building: room_floor_building || null,
        street_locality_landmark: street_locality_landmark || null,

        location_id:
          location_id || null,

        employee_id:
          primaryEmployeeId,

        employee_ids:
          safeEmployeeIds,

        opening_balance: safeOpeningBalance,
        opening_balance_type: safeOpeningBalanceType,
        company_id: company_id || null,
        monthly_rent: Number.isFinite(Number(monthly_rent)) ? Number(monthly_rent) : 0,

      });

    await syncWarehouseEmployeeAssignments(
      warehouse._id,
      safeEmployeeIds
    );

    return res.json(
      warehouse
    );

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });

  }

});

router.put("/:id", async (req, res) => {

  try {

    if (!userHasPermission(req.user, "warehouses.edit")) {

      return res.status(403).json({
        error:
          "Only admin can edit warehouse master",
      });

    }

    const {
      name,
      address,
      pincode,
      state,
      district,
      city,
      room_floor_building,
      street_locality_landmark,
      location_id,
      employee_id,
      employee_ids,
      opening_balance,
      opening_balance_type,
      company_id,
      monthly_rent,
    } = req.body;

    const safeEmployeeIds =
      parseEmployeeIds(employee_ids);

    const primaryEmployeeId =
      safeEmployeeIds[0] ||
      employee_id ||
      null;

    const safeOpeningBalance = Number.isFinite(Number(opening_balance)) ? Number(opening_balance) : 0;
    const safeOpeningBalanceType =
      String(opening_balance_type || "dr").toLowerCase() === "cr"
        ? "cr"
        : "dr";

    const updated =
      await Warehouse.findByIdAndUpdate(
        req.params.id,

        {
          name,

          address,

          pincode: pincode || null,
          state: state || null,
          district: district || null,
          city: city || null,
          room_floor_building: room_floor_building || null,
          street_locality_landmark: street_locality_landmark || null,

          location_id:
            location_id || null,

          employee_id:
            primaryEmployeeId,

          employee_ids:
            safeEmployeeIds,

          opening_balance: safeOpeningBalance,
          opening_balance_type: safeOpeningBalanceType,
          company_id: company_id || null,
          monthly_rent: Number.isFinite(Number(monthly_rent)) ? Number(monthly_rent) : 0,
        },

        {
          new: true,
        }
      );

    if (!updated) {

      return res.status(404).json({
        error:
          "Warehouse not found",
      });

    }

    await syncWarehouseEmployeeAssignments(
      req.params.id,
      safeEmployeeIds
    );

    return res.json({
      updated: 1,
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });

  }

});

router.delete("/:id", async (req, res) => {

  try {

    if (!userHasPermission(req.user, "warehouses.delete")) {

      return res.status(403).json({
        error:
          "Only admin can edit warehouse master",
      });

    }

    const deleted =
      await Warehouse.findByIdAndDelete(
        req.params.id
      );

    if (!deleted) {

      return res.status(404).json({
        error:
          "Warehouse not found",
      });

    }

    await Employee.updateMany(
      {},
      { $pull: { assigned_warehouse_ids: String(req.params.id) } }
    );

    return res.json({
      deleted: 1,
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });

  }

});

module.exports = router;
