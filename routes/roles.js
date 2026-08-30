const express = require("express");

const {
  Role,
  isMongoMirrorReady,
} = require("../db-mongodb");

const {
  isAdminUser,
} = require("../middleware/auth");

const router = express.Router();

/*
====================================================
DEFAULT ROLES
====================================================
*/

const DEFAULT_ROLES = [
  {
    name: "HO",

    is_admin: 0,

    permissions: [
      "dashboard.view",

      "employees.view",
      "employees.edit.non_admin",

      "companies.manage",
      "companyAccounts.manage",
      "locations.manage",
      "warehouses.manage",
      "products.manage",

      "inward.view",
      "inward.create",
      "inward.edit",
      "inward.delete",
      "inward.import",
      "inward.export",

      "outward.view",
      "outward.create",
      "outward.edit",
      "outward.delete",
      "outward.import",
      "outward.export",

      "adjustment.manage",
      "settlement.view",

      "expense.entry",
      "expense.view",
      "expense.create",
      "expense.edit",
      "expense.delete",
      "expense.postedInward",
      "expense.palti",
      "expense.selfLoading",
      "expense.localSale",
      "expense.pending",

      "cash.mainBook.view",
      "cash.mainBook.create",
      "cash.mainBook.edit",
      "cash.mainBook.delete",

      "cash.partiesBook.view",
      "cash.partiesBook.create",
      "cash.partiesBook.edit",
      "cash.partiesBook.delete",

      "cash.employeeBook.view",
      "cash.employeeBook.create",
      "cash.employeeBook.edit",
      "cash.employeeBook.delete",

      "warehouse.trading.purchase.view",
      "warehouse.trading.purchase.create",
      "warehouse.trading.purchase.edit",
      "warehouse.trading.purchase.delete",

      "warehouse.trading.sale.view",
      "warehouse.trading.sale.create",
      "warehouse.trading.sale.edit",
      "warehouse.trading.sale.delete",

      "warehouse.trading.payment.view",
      "warehouse.trading.payment.create",
      "warehouse.trading.payment.edit",
      "warehouse.trading.payment.delete",

      "warehouse.trading.receipt.view",
      "warehouse.trading.receipt.create",
      "warehouse.trading.receipt.edit",
      "warehouse.trading.receipt.delete",

      "warehouse.trading.journal.view",
      "warehouse.trading.journal.create",
      "warehouse.trading.journal.edit",
      "warehouse.trading.journal.delete",

      "warehouse.trading.report.sale",
      "warehouse.trading.report.purchase",
      "warehouse.trading.report.profitLoss",

      "report.inward",
      "report.erp",
      "report.partyLedger",
      "report.partyStock",
      "report.warehouseRentLedger",
      "report.warehouseRentMonthEnd",
      "report.outwardSettlement",
      "report.expense",
      "report.paltiLorryAdjustment",
      "report.cash",

      "transport.manage",
    ],
  },

  {
    name: "BM",

    is_admin: 0,

    permissions: [
      "dashboard.view",

      "inward.view",
      "inward.create",
      "inward.edit",
      "inward.import",
      "inward.export",

      "outward.view",
      "outward.create",
      "outward.edit",
      "outward.import",
      "outward.export",

      "adjustment.manage",
      "settlement.view",

      "expense.entry",
      "expense.view",
      "expense.create",
      "expense.edit",
      "expense.postedInward",
      "expense.palti",
      "expense.selfLoading",
      "expense.localSale",
      "expense.pending",

      "cash.mainBook.view",
      "cash.mainBook.create",

      "cash.employeeBook.view",
      "cash.employeeBook.create",

      "report.inward",
      "report.outwardSettlement",
      "report.expense",
      "report.cash",
    ],
  },
];

/*
====================================================
HELPERS
====================================================
*/

function requireMongo(res) {
  if (!isMongoMirrorReady()) {
    res.status(503).json({
      error:
        "MongoDB is not connected. Please try again in a moment.",
    });

    return false;
  }

  return true;
}

function normalizePermissions(
  permissions
) {
  const raw =
    Array.isArray(permissions)
      ? permissions
      : [];

  return Array.from(
    new Set(
      raw
        .filter(Boolean)
        .map((item) =>
          String(item).trim()
        )
        .filter(Boolean)
    )
  );
}

function formatRoleRow(
  row
) {
  if (!row) return null;

  return {
    ...row,

    id:
      row._id
        ? String(row._id)
        : row.id,

    name:
      row.name || "",

    permissions:
      Array.isArray(
        row.permissions
      )
        ? row.permissions
        : [],

    is_admin:
      Number(row.is_admin) || 0,

    created_at:
      row.created_at ||
      null,

    updated_at:
      row.updated_at ||
      null,
  };
}

function getDefaultRoleRows() {
  return DEFAULT_ROLES.map(
    (
      role,
      index
    ) => ({
      id:
        `default-${index + 1}`,

      name:
        role.name,

      permissions:
        normalizePermissions(
          role.permissions
        ),

      is_admin:
        Number(
          role.is_admin
        ) || 0,

      created_at:
        null,

      updated_at:
        null,
    })
  );
}

/*
====================================================
ENSURE DEFAULT ROLES
====================================================
*/

async function ensureDefaultRoles() {
  if (!isMongoMirrorReady()) {
    return;
  }

  const defaultNames =
    DEFAULT_ROLES.map(
      (role) =>
        role.name
    );

  const existing =
    await Role.find({
      name: {
        $in:
          defaultNames,
      },
    })
      .lean()
      .exec();

  const existingNames =
    new Set(
      (existing || []).map(
        (role) =>
          String(
            role.name || ""
          ).toLowerCase()
      )
    );

  const missing =
    DEFAULT_ROLES.filter(
      (role) =>
        !existingNames.has(
          String(
            role.name
          ).toLowerCase()
        )
    );

  if (
    missing.length === 0
  ) {
    return;
  }

  await Role.insertMany(
    missing.map(
      (role) => ({
        name:
          role.name,

        permissions:
          normalizePermissions(
            role.permissions
          ),

        is_admin:
          Number(
            role.is_admin
          ) || 0,

        created_at:
          new Date(),

        updated_at:
          new Date(),
      })
    ),
    {
      ordered: false,
    }
  );
}

/*
====================================================
GET ALL ROLES
====================================================
*/

router.get(
  "/",
  async (req, res) => {
    try {
      if (!requireMongo(res)) {
        return;
      }

      await ensureDefaultRoles();

      const docs =
        await Role.find({})
          .sort({
            name: 1,
            _id: 1,
          })
          .lean()
          .exec();

      return res.json(
        (docs || []).map(
          formatRoleRow
        )
      );
    } catch (err) {
      console.error(
        "Role list failed:",
        err
      );

      /*
       * Do not silently switch to legacy storage.
       * MongoDB is now the only source of truth.
       */
      return res.status(500).json({
        error:
          err.message ||
          "Failed to load roles",
      });
    }
  }
);

/*
====================================================
CREATE ROLE
====================================================
*/

router.post(
  "/",
  async (req, res) => {
    try {
      if (
        !isAdminUser(
          req.user
        )
      ) {
        return res.status(403).json({
          error:
            "Only admin can manage roles",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const name =
        String(
          req.body?.name ||
            ""
        ).trim();

      const permissions =
        normalizePermissions(
          req.body?.permissions
        );

      const is_admin =
        req.body?.is_admin
          ? 1
          : 0;

      if (!name) {
        return res.status(400).json({
          error:
            "Role name is required",
        });
      }

      const duplicate =
        await Role.findOne({
          name: {
            $regex:
              `^${name.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&"
              )}$`,

            $options: "i",
          },
        }).lean();

      if (duplicate) {
        return res.status(409).json({
          error:
            "Role already exists",
        });
      }

      const finalPermissions =
        is_admin
          ? ["all"]
          : permissions;

      const role =
        await Role.create({
          name,

          permissions:
            finalPermissions,

          is_admin,

          created_at:
            new Date(),

          updated_at:
            new Date(),
        });

      return res.status(201).json(
        formatRoleRow(
          role.toObject()
        )
      );
    } catch (err) {
      console.error(
        "Role create failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message ||
          "Failed to create role",
      });
    }
  }
);

/*
====================================================
UPDATE ROLE
====================================================
*/

router.put(
  "/:id",
  async (req, res) => {
    try {
      if (
        !isAdminUser(
          req.user
        )
      ) {
        return res.status(403).json({
          error:
            "Only admin can manage roles",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const roleId =
        String(
          req.params.id ||
            ""
        ).trim();

      if (!roleId) {
        return res.status(400).json({
          error:
            "Role ID is required",
        });
      }

      const name =
        String(
          req.body?.name ||
            ""
        ).trim();

      const permissions =
        normalizePermissions(
          req.body?.permissions
        );

      const is_admin =
        req.body?.is_admin
          ? 1
          : 0;

      if (!name) {
        return res.status(400).json({
          error:
            "Role name is required",
        });
      }

      const existing =
        await Role.findById(
          roleId
        );

      if (!existing) {
        return res.status(404).json({
          error:
            "Role not found",
        });
      }

      const duplicate =
        await Role.findOne({
          _id: {
            $ne:
              existing._id,
          },

          name: {
            $regex:
              `^${name.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&"
              )}$`,

            $options: "i",
          },
        }).lean();

      if (duplicate) {
        return res.status(409).json({
          error:
            "Another role with the same name already exists",
        });
      }

      existing.name =
        name;

      existing.permissions =
        is_admin
          ? ["all"]
          : permissions;

      existing.is_admin =
        is_admin;

      existing.updated_at =
        new Date();

      await existing.save();

      return res.json(
        formatRoleRow(
          existing.toObject()
        )
      );
    } catch (err) {
      console.error(
        "Role update failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message ||
          "Failed to update role",
      });
    }
  }
);

/*
====================================================
DELETE ROLE
====================================================
*/

router.delete(
  "/:id",
  async (req, res) => {
    try {
      if (
        !isAdminUser(
          req.user
        )
      ) {
        return res.status(403).json({
          error:
            "Only admin can manage roles",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const roleId =
        String(
          req.params.id ||
            ""
        ).trim();

      if (!roleId) {
        return res.status(400).json({
          error:
            "Role ID is required",
        });
      }

      const role =
        await Role.findById(
          roleId
        );

      if (!role) {
        return res.status(404).json({
          error:
            "Role not found",
        });
      }

      /*
       * Protect admin roles.
       */
      if (
        Number(
          role.is_admin
        ) === 1
      ) {
        return res.status(400).json({
          error:
            "Admin role cannot be deleted",
        });
      }

      await Role.deleteOne({
        _id:
          role._id,
      });

      return res.json({
        deleted:
          1,

        id:
          String(
            role._id
          ),

        source:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Role delete failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message ||
          "Failed to delete role",
      });
    }
  }
);

module.exports = router;
