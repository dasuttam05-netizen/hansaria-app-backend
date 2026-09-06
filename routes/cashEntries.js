const express = require("express");

const router = express.Router();

const {
  mongoose,
  CashEntry,
  CashBookSettings,
  CashActivityLog,
  Company,
  CompanyAccount,
  Warehouse,
  Employee,
  Location,
} = require("../db-mongodb");

const {
  userHasPermission,
} = require("../middleware/auth");

const ADJ_DETAIL_MARKER = " | Adj Details -> ";

function mongoReady() {
  return (
    mongoose.connection.readyState === 1 &&
    !!mongoose.connection.db
  );
}

function isAdminUser(user) {
  return !!(
    user &&
    (
      user.role === "admin" ||
      (Array.isArray(user.permissions) &&
        user.permissions.includes("all")) ||
      userHasPermission(user, "warehouses.manage")
    )
  );
}

function normalizeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCreatedBy(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    if (typeof value === "object") {
      for (const nested of [
        value.id,
        value.employee_id,
        value.user_id,
      ]) {
        const n = Number(nested);
        if (Number.isFinite(n) && n > 0) {
          return n;
        }
      }
      continue;
    }

    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }

  return null;
}

function normalizeMixedId(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const text = String(value).trim();

  if (!text) {
    return null;
  }

  if (/^\d+$/.test(text)) {
    return Number(text);
  }

  return text;
}

function idValues(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  const text = String(value).trim();
  const values = [text];

  if (/^\d+$/.test(text)) {
    values.push(Number(text));
  }

  return [
    ...new Map(
      values.map((item) => [String(item), item])
    ).values(),
  ];
}

function matchField(field, value) {
  const values = idValues(value);

  if (!values.length) {
    return {};
  }

  if (values.length === 1) {
    return { [field]: values[0] };
  }

  return {
    $or: values.map((item) => ({
      [field]: item,
    })),
  };
}

async function findMaster(model, value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const text = String(value).trim();

  if (
    mongoose.Types.ObjectId.isValid(text)
  ) {
    const byObjectId = await model
      .findById(text)
      .lean()
      .catch(() => null);

    if (byObjectId) {
      return byObjectId;
    }
  }

  if (/^\d+$/.test(text)) {
    const n = Number(text);

    return model
      .findOne({
        $or: [
          { id: n },
          { legacy_id: n },
        ],
      })
      .lean()
      .catch(() => null);
  }

  return null;
}

async function resolveMasterId(model, value) {
  const doc = await findMaster(model, value);

  if (doc) {
    if (doc.id !== undefined && doc.id !== null) {
      return Number.isFinite(Number(doc.id))
        ? Number(doc.id)
        : String(doc.id);
    }

    return String(doc._id);
  }

  return normalizeMixedId(value);
}

async function assignedWarehouseIds(user) {
  if (isAdminUser(user)) {
    return [];
  }

  const ids = Array.isArray(
    user?.assigned_warehouse_ids
  )
    ? user.assigned_warehouse_ids
    : [];

  return ids.map((x) => String(x));
}

async function hasWarehouseAccess(
  req,
  warehouseId
) {
  if (isAdminUser(req.user)) {
    return true;
  }

  const scope = await assignedWarehouseIds(
    req.user
  );

  if (!scope.length) {
    return false;
  }

  const value = String(
    warehouseId ?? ""
  );

  if (scope.includes(value)) {
    return true;
  }

  const warehouse = await findMaster(
    Warehouse,
    warehouseId
  );

  if (!warehouse) {
    return false;
  }

  const alternatives = [
    warehouse._id,
    warehouse.id,
    warehouse.legacy_id,
  ]
    .filter(
      (x) =>
        x !== undefined &&
        x !== null &&
        x !== ""
    )
    .map(String);

  return alternatives.some((x) =>
    scope.includes(x)
  );
}

async function ensureWarehouseAccess(
  req,
  res,
  warehouseId
) {
  const ok = await hasWarehouseAccess(
    req,
    warehouseId
  );

  if (!ok) {
    res.status(403).json({
      error: "Warehouse access denied",
    });
    return false;
  }

  return true;
}

async function nextNumericCashId() {
  const row = await CashEntry
    .findOne({
      id: { $type: "number" },
    })
    .sort({ id: -1 })
    .select("id")
    .lean();

  return Number(row?.id || 0) + 1;
}

async function getNextVoucherNo(prefix) {
  const rows = await CashEntry
    .find({
      voucher_no: {
        $regex: `^${String(prefix)}`,
        $options: "i",
      },
    })
    .select("voucher_no")
    .lean();

  let max = 0;

  for (const row of rows || []) {
    const m = String(
      row?.voucher_no || ""
    ).match(
      new RegExp(
        `^${String(prefix)}(\\d+)$`,
        "i"
      )
    );

    if (m) {
      const n = Number(m[1]);

      if (Number.isFinite(n)) {
        max = Math.max(max, n);
      }
    }
  }

  return `${prefix}${String(
    max + 1
  ).padStart(5, "0")}`;
}

function getVoucherPrefix(
  transactionMode,
  entryType
) {
  const mode = String(
    transactionMode || ""
  ).toLowerCase();

  if (mode === "journal") {
    return "JV";
  }

  if (mode === "receipt") {
    return "REC";
  }

  if (mode === "payment") {
    return "PAY";
  }

  return String(entryType || "")
    .toLowerCase() === "income"
    ? "REC"
    : "PAY";
}

async function getCashById(id) {
  const n = Number(id);

  if (Number.isFinite(n)) {
    const row = await CashEntry
      .findOne({ id: n })
      .lean();

    if (row) {
      return row;
    }
  }

  if (
    mongoose.Types.ObjectId.isValid(
      String(id)
    )
  ) {
    return CashEntry
      .findById(String(id))
      .lean();
  }

  return null;
}

function adjustmentTargetId(item) {
  return item?.target_entry_id ??
    item?.targetEntryId ??
    null;
}

function adjustmentAmount(item) {
  return Number(
    item?.adjusted_amount ??
      item?.adjustedAmount ??
      0
  );
}

function cleanAdjustments(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => ({
      target_entry_id:
        normalizeMixedId(
          adjustmentTargetId(item)
        ),
      adjusted_amount:
        adjustmentAmount(item),
    }))
    .filter(
      (item) =>
        item.target_entry_id !== null &&
        Number.isFinite(
          item.adjusted_amount
        ) &&
        item.adjusted_amount > 0
    );
}

function sameId(a, b) {
  const av = idValues(a).map(String);
  const bv = idValues(b).map(String);

  return av.some((x) =>
    bv.includes(x)
  );
}

async function getAdjustmentMap(
  entries
) {
  const map = new Map();

  for (const source of entries || []) {
    const sourceId =
      source?.id ?? source?._id;

    for (const adjustment of
      source?.adjustments || []) {
      const targetId =
        adjustmentTargetId(
          adjustment
        );

      if (
        targetId === undefined ||
        targetId === null ||
        targetId === ""
      ) {
        continue;
      }

      const key = String(targetId);

      if (!map.has(key)) {
        map.set(key, []);
      }

      map.get(key).push({
        source_entry_id: sourceId,
        adjusted_amount:
          adjustmentAmount(
            adjustment
          ),
      });
    }
  }

  return map;
}

function adjustedTotalFor(
  adjustmentMap,
  id
) {
  const rows =
    adjustmentMap.get(String(id)) ||
    [];

  return rows.reduce(
    (sum, row) =>
      sum +
      Number(
        row.adjusted_amount || 0
      ),
    0
  );
}

async function decorateRows(
  rows,
  allEntries = null
) {
  const entries =
    allEntries || rows || [];

  const adjustmentMap =
    await getAdjustmentMap(
      entries
    );

  const companyIds = new Set();
  const accountIds = new Set();
  const warehouseIds = new Set();
  const employeeIds = new Set();

  for (const row of rows || []) {
    if (row.company_id !== null &&
        row.company_id !== undefined) {
      companyIds.add(
        String(row.company_id)
      );
    }

    if (
      row.company_account_id !==
        null &&
      row.company_account_id !==
        undefined
    ) {
      accountIds.add(
        String(row.company_account_id)
      );
    }

    if (
      row.warehouse_id !== null &&
      row.warehouse_id !== undefined
    ) {
      warehouseIds.add(
        String(row.warehouse_id)
      );
    }

    if (
      row.employee_id !== null &&
      row.employee_id !== undefined
    ) {
      employeeIds.add(
        String(row.employee_id)
      );
    }
  }

  const [
    companies,
    accounts,
    warehouses,
    employees,
  ] = await Promise.all([
    Company.find({
      $or: [
        {
          _id: {
            $in:
              [
                ...companyIds,
              ].filter(
                mongoose.Types.ObjectId.isValid
              ),
          },
        },
        {
          id: {
            $in:
              [...companyIds]
                .filter((x) => /^\d+$/.test(x))
                .map(Number),
          },
        },
      ],
    })
      .lean()
      .catch(() => []),

    CompanyAccount.find({
      $or: [
        {
          _id: {
            $in:
              [
                ...accountIds,
              ].filter(
                mongoose.Types.ObjectId.isValid
              ),
          },
        },
        {
          id: {
            $in:
              [...accountIds]
                .filter((x) => /^\d+$/.test(x))
                .map(Number),
          },
        },
      ],
    })
      .lean()
      .catch(() => []),

    Warehouse.find({
      $or: [
        {
          _id: {
            $in:
              [
                ...warehouseIds,
              ].filter(
                mongoose.Types.ObjectId.isValid
              ),
          },
        },
        {
          id: {
            $in:
              [...warehouseIds]
                .filter((x) => /^\d+$/.test(x))
                .map(Number),
          },
        },
      ],
    })
      .lean()
      .catch(() => []),

    Employee.find({
      $or: [
        {
          _id: {
            $in:
              [
                ...employeeIds,
              ].filter(
                mongoose.Types.ObjectId.isValid
              ),
          },
        },
        {
          id: {
            $in:
              [...employeeIds]
                .filter((x) => /^\d+$/.test(x))
                .map(Number),
          },
        },
      ],
    })
      .lean()
      .catch(() => []),
  ]);

  const companyMap =
    new Map();

  const accountMap =
    new Map();

  const warehouseMap =
    new Map();

  const employeeMap =
    new Map();

  for (const item of
    companies || []) {
    companyMap.set(
      String(item._id),
      item
    );

    if (
      item.id !== undefined &&
      item.id !== null
    ) {
      companyMap.set(
        String(item.id),
        item
      );
    }

    if (
      item.legacy_id !== undefined &&
      item.legacy_id !== null
    ) {
      companyMap.set(
        String(item.legacy_id),
        item
      );
    }
  }

  for (const item of
    accounts || []) {
    accountMap.set(
      String(item._id),
      item
    );

    if (
      item.id !== undefined &&
      item.id !== null
    ) {
      accountMap.set(
        String(item.id),
        item
      );
    }

    if (
      item.legacy_id !== undefined &&
      item.legacy_id !== null
    ) {
      accountMap.set(
        String(item.legacy_id),
        item
      );
    }
  }

  for (const item of
    warehouses || []) {
    warehouseMap.set(
      String(item._id),
      item
    );

    if (
      item.id !== undefined &&
      item.id !== null
    ) {
      warehouseMap.set(
        String(item.id),
        item
      );
    }
  }

  for (const item of
    employees || []) {
    employeeMap.set(
      String(item._id),
      item
    );

    if (
      item.id !== undefined &&
      item.id !== null
    ) {
      employeeMap.set(
        String(item.id),
        item
      );
    }

    if (
      item.legacy_id !== undefined &&
      item.legacy_id !== null
    ) {
      employeeMap.set(
        String(item.legacy_id),
        item
      );
    }
  }

  return (rows || []).map(
    (row) => {
      const adjustedTotal =
        adjustedTotalFor(
          adjustmentMap,
          row?.id
        );

      const company =
        companyMap.get(
          String(
            row.company_id ?? ""
          )
        ) || {};

      const account =
        accountMap.get(
          String(
            row.company_account_id ??
              ""
          )
        ) || {};

      const warehouse =
        warehouseMap.get(
          String(
            row.warehouse_id ?? ""
          )
        ) || {};

      const employee =
        employeeMap.get(
          String(
            row.employee_id ?? ""
          )
        ) || {};

      const adjustments =
        Array.isArray(
          row.adjustments
        )
          ? row.adjustments.map(
              (item) => ({
                ...item,
                adjusted_amount:
                  adjustmentAmount(
                    item
                  ),
              })
            )
          : [];

      return {
        ...row,
        _id: String(
          row._id ?? row.id
        ),
        id: String(
          row.id ?? row._id
        ),
        warehouse_name:
          row.warehouse_name ||
          warehouse.name ||
          "",
        company_name:
          row.company_name ||
          company.name ||
          "",
        company_account_name:
          row.company_account_name ||
          account.account_name ||
          account.name ||
          "",
        account_name:
          row.account_name ||
          account.account_name ||
          account.name ||
          "",
        employee_name:
          row.employee_name ||
          employee.name ||
          "",
        adjusted_total:
          Number(
            adjustedTotal.toFixed(2)
          ),
        pending_amount:
          Number(
            (
              Number(row.amount || 0) -
              adjustedTotal
            ).toFixed(2)
          ),
        fund_source:
          row.fund_source ||
          "main_cash",
        status:
          row.status ||
          "pending",
        adjustments,
        adjustment_details:
          adjustments
            .map(
              (item) =>
                `CE-${item.target_entry_id} ${Number(
                  item.adjusted_amount || 0
                ).toFixed(2)}`
            )
            .join(" | "),
      };
    }
  );
}

async function getVisibleEntries(
  req,
  query = {}
) {
  const {
    from_date,
    to_date,
    warehouse_id,
    company_id,
    entry_type,
    status,
    include_cancelled,
  } = query;

  const rows =
    await CashEntry
      .find({})
      .sort({
        entry_date: -1,
        id: -1,
        _id: -1,
      })
      .lean();

  const filtered = [];

  const isPendingExpenseOnly =
    !userHasPermission(
      req.user,
      "cash.view"
    ) &&
    userHasPermission(
      req.user,
      "expense.pending"
    );

  for (const row of rows || []) {
    if (
      !isAdminUser(req.user) &&
      !(await hasWarehouseAccess(
        req,
        row.warehouse_id
      ))
    ) {
      continue;
    }

    if (
      String(include_cancelled || "0") !== "1" &&
      String(row.status || "pending")
        .toLowerCase() ===
        "cancelled"
    ) {
      continue;
    }

    if (
      from_date &&
      new Date(row.entry_date) <
        new Date(
          `${from_date}T00:00:00.000Z`
        )
    ) {
      continue;
    }

    if (
      to_date &&
      new Date(row.entry_date) >
        new Date(
          `${to_date}T23:59:59.999Z`
        )
    ) {
      continue;
    }

    if (
      warehouse_id &&
      !sameId(
        row.warehouse_id,
        warehouse_id
      )
    ) {
      continue;
    }

    if (
      company_id &&
      !sameId(
        row.company_id,
        company_id
      )
    ) {
      continue;
    }

    if (
      entry_type &&
      String(row.entry_type || "")
        .toLowerCase() !==
        String(entry_type)
          .toLowerCase()
    ) {
      continue;
    }

    if (
      status &&
      String(row.status || "pending")
        .toLowerCase() !==
        String(status)
          .toLowerCase()
    ) {
      continue;
    }

    if (isPendingExpenseOnly) {
      if (
        String(row.entry_type || "")
          .toLowerCase() !==
        "expense"
      ) {
        continue;
      }

      if (
        String(row.status || "pending")
          .toLowerCase() !==
        "pending"
      ) {
        continue;
      }

      if (
        row.source_expense_id ===
          null ||
        row.source_expense_id ===
          undefined ||
        row.source_expense_id ===
          ""
      ) {
        continue;
      }
    }

    filtered.push(row);
  }

  return filtered;
}

function dedupePendingExpenseRows(
  rows
) {
  const grouped =
    new Map();

  for (const row of
    rows || []) {
    const key =
      row.source_expense_id
        ? `expense:${row.source_expense_id}`
        : row.reference_no
        ? `ref:${row.reference_no}`
        : `row:${row.id}`;

    const old =
      grouped.get(key);

    const score = (item) => {
      const voucher =
        String(
          item?.voucher_no || ""
        ).toUpperCase();

      const helper =
        voucher.endsWith("-EMP") ||
        voucher.endsWith("-PARTY");

      return (
        (helper ? 0 : 1000000) +
        Number(item?.id || 0)
      );
    };

    if (
      !old ||
      score(row) > score(old)
    ) {
      grouped.set(key, row);
    }
  }

  return [
    ...grouped.values(),
  ].sort((a, b) => {
    const da =
      String(a.entry_date || "");
    const db =
      String(b.entry_date || "");

    if (da !== db) {
      return da < db ? 1 : -1;
    }

    return (
      Number(b.id || 0) -
      Number(a.id || 0)
    );
  });
}

function writeAudit({
  req,
  action,
  entry_id = null,
  voucher_no = null,
  details = {},
}) {
  if (!mongoReady() || !CashActivityLog) return;
  const actor = req?.user || {};
  CashActivityLog.create({
    at: new Date(),
    action,
    entry_id,
    voucher_no,
    actor_user_id: actor.id ?? null,
    actor_username: actor.username ?? null,
    actor_name: actor.name ?? null,
    details: details || {},
  }).catch((err) => {
    console.error("Cash audit write error:", err.message);
  });
}

router.get("/", async (req, res) => {
  if (
    !userHasPermission(
      req.user,
      "cash.view"
    ) &&
    !userHasPermission(
      req.user,
      "expense.pending"
    )
  ) {
    return res.status(403).json({
      error:
        "You do not have permission to view cash entries",
    });
  }

  if (!mongoReady()) {
    return res.status(503).json({
      error:
        "MongoDB is not connected. Cash entries are MongoDB-only.",
    });
  }

  try {
    const raw =
      await getVisibleEntries(
        req,
        req.query
      );

    const rows =
      await decorateRows(
        raw,
        await CashEntry.find({}).lean()
      );

    const pendingExpense =
      String(
        req.query.status || ""
      ).toLowerCase() ===
        "pending" &&
      String(
        req.query.entry_type || ""
      ).toLowerCase() ===
        "expense";

    return res.json(
      pendingExpense
        ? dedupePendingExpenseRows(
            rows
          )
        : rows
    );
  } catch (err) {
    console.error(
      "GET /cash-entries Mongo error:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

router.get(
  "/activity-logs",
  async (req, res) => {
    if (!isAdminUser(req.user)) {
      return res.status(403).json({
        error:
          "Only admin can view activity logs",
      });
    }

    try {
      if (!mongoReady() || !CashActivityLog) {
        return res.status(503).json({ error: "MongoDB is not connected." });
      }

      const {
        action,
        from_date,
        to_date,
        user_id,
        limit,
      } = req.query;

      const safeLimit =
        Math.max(
          10,
          Math.min(
            1000,
            Number(limit) || 200
          )
        );

      const filter = {};
      if (action) filter.action = String(action);
      if (user_id) {
        filter.actor_user_id = Number.isFinite(Number(user_id))
          ? Number(user_id)
          : String(user_id);
      }
      if (from_date || to_date) {
        filter.at = {};
        if (from_date) filter.at.$gte = new Date(`${from_date}T00:00:00.000Z`);
        if (to_date) {
          filter.at.$lt = new Date(`${to_date}T00:00:00.000Z`);
          filter.at.$lt.setUTCDate(filter.at.$lt.getUTCDate() + 1);
        }
      }

      const output = await CashActivityLog.find(filter)
        .sort({ at: -1, _id: -1 })
        .limit(safeLimit)
        .lean();

      return res.json(output);
    } catch (err) {
      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

router.get(
  "/opening/main",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "cash.mainBook.view"
      ) &&
      !userHasPermission(
        req.user,
        "cash.mainBook.create"
      ) &&
      !userHasPermission(
        req.user,
        "cash.mainBook.edit"
      ) &&
      !userHasPermission(
        req.user,
        "cash.mainBook.delete"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to view main cash opening balance",
      });
    }

    if (!mongoReady()) {
      return res.status(503).json({
        error:
          "MongoDB is not connected.",
      });
    }

    try {
      let settings =
        await CashBookSettings.findOne({
          id: 1,
        });

      if (!settings) {
        settings =
          await CashBookSettings.create({
            id: 1,
            main_opening_balance: 0,
            main_opening_type: "dr",
            opening_locked: 0,
            opening_locked_by: null,
            opening_locked_at: null,
            updated_by: null,
            created_at: new Date(),
            updated_at: new Date(),
          });
      }

      return res.json({
        main_opening_balance:
          Number(
            settings.main_opening_balance ||
              0
          ),
        main_opening_type:
          String(
            settings.main_opening_type ||
              "dr"
          ).toLowerCase() === "cr"
            ? "cr"
            : "dr",
        opening_locked:
          Number(
            settings.opening_locked || 0
          ) === 1,
        opening_locked_by:
          settings.opening_locked_by ||
          null,
        opening_locked_at:
          settings.opening_locked_at ||
          null,
        updated_by:
          settings.updated_by ||
          null,
        updated_at:
          settings.updated_at ||
          null,
      });
    } catch (err) {
      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

router.put(
  "/opening/main",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "cash.mainBook.edit"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to update main cash opening balance",
      });
    }

    if (!mongoReady()) {
      return res.status(503).json({
        error:
          "MongoDB is not connected.",
      });
    }

    const amount =
      Math.abs(
        Number(
          req.body?.main_opening_balance ||
            0
        )
      );

    if (
      !Number.isFinite(amount)
    ) {
      return res.status(400).json({
        error:
          "Invalid opening balance amount",
      });
    }

    const openingType =
      String(
        req.body?.main_opening_type ||
          "dr"
      ).toLowerCase() === "cr"
        ? "cr"
        : "dr";

    try {
      const settings =
        await CashBookSettings.findOneAndUpdate(
          { id: 1 },
          {
            $setOnInsert: {
              id: 1,
              created_at:
                new Date(),
            },
            $set: {
              main_opening_balance:
                amount,
              main_opening_type:
                openingType,
              updated_by:
                normalizeCreatedBy(
                  req.user?.id,
                  req.user?.employee_id
                ),
              updated_at:
                new Date(),
            },
          },
          {
            new: true,
            upsert: true,
          }
        );

      if (
        Number(
          settings.opening_locked || 0
        ) === 1
      ) {
        return res.status(423).json({
          error:
            "Main opening is locked. Unlock opening before editing.",
        });
      }

      writeAudit({
        req,
        action:
          "main_opening_update",
        details: {
          main_opening_balance:
            amount,
          main_opening_type:
            openingType,
        },
      });

      return res.json({
        main_opening_balance:
          amount,
        main_opening_type:
          openingType,
        updated_at:
          settings.updated_at,
      });
    } catch (err) {
      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

router.patch(
  "/opening/main/lock",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "cash.mainBook.edit"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to lock/unlock main cash opening",
      });
    }

    if (!mongoReady()) {
      return res.status(503).json({
        error:
          "MongoDB is not connected.",
      });
    }

    const lock =
      req.body?.locked !== undefined
        ? (
            req.body.locked === true ||
            String(
              req.body.locked
            ) === "1" ||
            String(
              req.body.locked
            ).toLowerCase() ===
              "true"
          )
        : true;

    try {
      const updated =
        await CashBookSettings.findOneAndUpdate(
          { id: 1 },
          {
            $setOnInsert: {
              id: 1,
              main_opening_balance: 0,
              main_opening_type: "dr",
              created_at:
                new Date(),
            },
            $set: {
              opening_locked:
                lock ? 1 : 0,
              opening_locked_by:
                lock
                  ? normalizeCreatedBy(
                      req.user?.id,
                      req.user?.employee_id
                    )
                  : null,
              opening_locked_at:
                lock
                  ? new Date()
                  : null,
              updated_by:
                normalizeCreatedBy(
                  req.user?.id,
                  req.user?.employee_id
                ),
              updated_at:
                new Date(),
            },
          },
          {
            new: true,
            upsert: true,
          }
        );

      writeAudit({
        req,
        action:
          lock
            ? "main_opening_lock"
            : "main_opening_unlock",
      });

      return res.json({
        opening_locked:
          Number(
            updated.opening_locked || 0
          ) === 1,
        opening_locked_by:
          updated.opening_locked_by ||
          null,
        opening_locked_at:
          updated.opening_locked_at ||
          null,
      });
    } catch (err) {
      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

router.get(
  "/aging/company/:companyId",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "cash.view"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to view cash aging",
      });
    }

    if (!mongoReady()) {
      return res.status(503).json({
        error:
          "MongoDB is not connected.",
      });
    }

    try {
      const companyId =
        req.params.companyId;

      const {
        entry_type,
        source_entry_id,
        include_all,
      } = req.query;

      const preferredType =
        entry_type === "income"
          ? "expense"
          : entry_type === "expense"
          ? "income"
          : null;

      const excludeId =
        source_entry_id
          ? Number(
              source_entry_id
            )
          : null;

      const all =
        await CashEntry.find({})
          .sort({
            entry_date: 1,
            id: 1,
          })
          .lean();

      const adjustmentMap =
        await getAdjustmentMap(
          all
        );

      const output = [];

      for (const row of
        all || []) {
        if (
          !sameId(
            row.company_id,
            companyId
          )
        ) {
          continue;
        }

        if (
          preferredType &&
          String(
            row.entry_type || ""
          ).toLowerCase() !==
            preferredType
        ) {
          continue;
        }

        const adjusted =
          (
            adjustmentMap.get(
              String(row.id)
            ) || []
          )
            .filter(
              (x) =>
                !excludeId ||
                Number(
                  x.source_entry_id
                ) !==
                  excludeId
            )
            .reduce(
              (sum, x) =>
                sum +
                Number(
                  x.adjusted_amount ||
                    0
                ),
              0
            );

        const pending =
          Number(row.amount || 0) -
          adjusted;

        if (
          String(
            include_all || "0"
          ) !== "1" &&
          pending <= 0.0001
        ) {
          continue;
        }

        const date =
          new Date(
            row.entry_date
          );

        const ageDays =
          Number.isNaN(
            date.getTime()
          )
            ? 0
            : Math.max(
                0,
                Math.floor(
                  (
                    Date.now() -
                    date.getTime()
                  ) /
                    86400000
                )
              );

        output.push({
          ...row,
          id: String(
            row.id ??
              row._id
          ),
          adjusted_total:
            Number(
              adjusted.toFixed(2)
            ),
          pending_amount:
            Number(
              pending.toFixed(2)
            ),
          age_days: ageDays,
          is_preferred_type:
            preferredType
              ? row.entry_type ===
                preferredType
              : false,
        });
      }

      return res.json(
        output
      );
    } catch (err) {
      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

router.get(
  "/summary/by-warehouse",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "cash.view"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to view cash summary",
      });
    }

    if (!mongoReady()) {
      return res.status(503).json({
        error:
          "MongoDB is not connected.",
      });
    }

    try {
      const rows =
        await CashEntry.find({})
          .lean();

      const map =
        new Map();

      for (const row of
        rows || []) {
        if (
          req.query.from_date &&
          new Date(
            row.entry_date
          ) <
            new Date(
              `${req.query.from_date}T00:00:00.000Z`
            )
        ) {
          continue;
        }

        if (
          req.query.to_date &&
          new Date(
            row.entry_date
          ) >
            new Date(
              `${req.query.to_date}T23:59:59.999Z`
            )
        ) {
          continue;
        }

        if (
          !isAdminUser(req.user) &&
          !(await hasWarehouseAccess(
            req,
            row.warehouse_id
          ))
        ) {
          continue;
        }

        const key =
          String(
            row.warehouse_id ??
              ""
          );

        if (!map.has(key)) {
          map.set(key, {
            warehouse_name:
              "",
            entry_type:
              row.entry_type,
            total_amount: 0,
            entry_count: 0,
            warehouse_id:
              row.warehouse_id ??
              null,
          });
        }

        const item =
          map.get(key);

        if (
          item.entry_type !==
          row.entry_type
        ) {
          const compound =
            `${key}:${row.entry_type}`;

          if (!map.has(
            compound
          )) {
            map.set(
              compound,
              {
                warehouse_name:
                  "",
                entry_type:
                  row.entry_type,
                total_amount: 0,
                entry_count: 0,
                warehouse_id:
                  row.warehouse_id ??
                  null,
              }
            );
          }
        }

        const actualKey =
          `${key}:${row.entry_type}`;

        if (!map.has(
          actualKey
        )) {
          map.set(
            actualKey,
            {
              warehouse_name:
                "",
              entry_type:
                row.entry_type,
              total_amount: 0,
              entry_count: 0,
              warehouse_id:
                row.warehouse_id ??
                null,
            }
          );
        }

        const target =
          map.get(actualKey);

        target.total_amount +=
          Number(
            row.amount || 0
          );

        target.entry_count += 1;
      }

      const warehouses =
        await Warehouse.find({})
          .lean()
          .catch(() => []);

      const warehouseMap =
        new Map();

      for (const w of
        warehouses || []) {
        warehouseMap.set(
          String(w._id),
          w.name || ""
        );

        if (
          w.id !== undefined &&
          w.id !== null
        ) {
          warehouseMap.set(
            String(w.id),
            w.name || ""
          );
        }
      }

      const output =
        [
          ...map.values(),
        ].map((item) => ({
          ...item,
          warehouse_name:
            warehouseMap.get(
              String(
                item.warehouse_id ??
                  ""
              )
            ) || "",
        }));

      output.sort(
        (a, b) =>
          String(
            a.warehouse_name || ""
          ).localeCompare(
            String(
              b.warehouse_name || ""
            )
          ) ||
          String(
            a.entry_type || ""
          ).localeCompare(
            String(
              b.entry_type || ""
            )
          )
      );

      return res.json(
        output
      );
    } catch (err) {
      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

router.get(
  "/summary/total-balance",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "cash.view"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to view cash summary",
      });
    }

    if (!mongoReady()) {
      return res.status(503).json({
        error:
          "MongoDB is not connected.",
      });
    }

    try {
      const rows =
        await CashEntry.find({})
          .lean();

      let totalIncome = 0;
      let totalExpense = 0;

      for (const row of
        rows || []) {
        if (
          req.query.from_date &&
          new Date(
            row.entry_date
          ) <
            new Date(
              `${req.query.from_date}T00:00:00.000Z`
            )
        ) {
          continue;
        }

        if (
          req.query.to_date &&
          new Date(
            row.entry_date
          ) >
            new Date(
              `${req.query.to_date}T23:59:59.999Z`
            )
        ) {
          continue;
        }

        if (
          !isAdminUser(req.user) &&
          !(await hasWarehouseAccess(
            req,
            row.warehouse_id
          ))
        ) {
          continue;
        }

        if (
          String(
            row.entry_type || ""
          ).toLowerCase() ===
          "income"
        ) {
          totalIncome +=
            Number(
              row.amount || 0
            );
        } else if (
          String(
            row.entry_type || ""
          ).toLowerCase() ===
          "expense"
        ) {
          totalExpense +=
            Number(
              row.amount || 0
            );
        }
      }

      return res.json({
        total_income:
          Number(
            totalIncome.toFixed(2)
          ),
        total_expense:
          Number(
            totalExpense.toFixed(2)
          ),
        net_balance:
          Number(
            (
              totalIncome -
              totalExpense
            ).toFixed(2)
          ),
      });
    } catch (err) {
      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

router.get(
  "/:id(\\d+)",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "cash.view"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to view cash entries",
      });
    }

    if (!mongoReady()) {
      return res.status(503).json({
        error:
          "MongoDB is not connected.",
      });
    }

    try {
      const row =
        await getCashById(
          req.params.id
        );

      if (!row) {
        return res.status(404).json({
          error:
            "Entry not found",
        });
      }

      if (
        !(await ensureWarehouseAccess(
          req,
          res,
          row.warehouse_id
        ))
      ) {
        return;
      }

      const all =
        await CashEntry.find({})
          .lean();

      const [
        decorated,
      ] = await decorateRows(
        [row],
        all
      );

      return res.json(
        decorated || null
      );
    } catch (err) {
      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

router.post(
  "/",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "cash.create"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to create cash entries",
      });
    }

    if (!mongoReady()) {
      return res.status(503).json({
        error:
          "MongoDB is not connected. Cash entries are MongoDB-only.",
      });
    }

    const body =
      req.body || {};

    const {
      voucher_no,
      transaction_mode,
      entry_date,
      entry_type,
      warehouse_id,
      company_id,
      company_account_id,
      description,
      amount,
      payment_method,
      reference_no,
      narration,
      created_by,
      employee_id,
      journal_group_no,
      status,
      fund_source,
      source_expense_id,
      adjustments,
      auto_staff_entry,
    } = body;

    if (
      !entry_date ||
      !entry_type ||
      !description ||
      !Number(amount)
    ) {
      return res.status(400).json({
        error:
          "Required fields missing",
      });
    }

    try {
      if (
        !(await ensureWarehouseAccess(
          req,
          res,
          warehouse_id
        ))
      ) {
        return;
      }

      const normalizedMode =
        String(
          transaction_mode || ""
        ).toLowerCase();

      const effectiveType =
        normalizedMode ===
        "payment"
          ? "expense"
          : normalizedMode ===
            "receipt"
          ? "income"
          : String(
              entry_type
            ).toLowerCase();

      if (
        ![
          "income",
          "expense",
        ].includes(
          effectiveType
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid entry type",
        });
      }

      const normalizedWarehouse =
        await resolveMasterId(
          Warehouse,
          warehouse_id
        );

      const normalizedCompany =
        await resolveMasterId(
          Company,
          company_id
        );

      const normalizedAccount =
        await resolveMasterId(
          CompanyAccount,
          company_account_id
        );

      const normalizedEmployee =
        await resolveMasterId(
          Employee,
          employee_id
        );

      let finalVoucherNo =
        String(
          voucher_no || ""
        ).trim();

      if (!finalVoucherNo) {
        finalVoucherNo =
          await getNextVoucherNo(
            getVoucherPrefix(
              normalizedMode,
              effectiveType
            )
          );
      }

      const id =
        await nextNumericCashId();

      const clean =
        cleanAdjustments(
          adjustments
        );

      const totalAdjusted =
        clean.reduce(
          (sum, item) =>
            sum +
            Number(
              item.adjusted_amount
            ),
          0
        );

      if (
        totalAdjusted >
        Number(amount)
      ) {
        return res.status(400).json({
          error:
            "Adjusted total cannot exceed entry amount",
        });
      }

      for (const item of
        clean) {
        if (
          Number(item.target_entry_id) ===
          Number(id)
        ) {
          return res.status(400).json({
            error:
              "Entry cannot adjust itself",
          });
        }

        const target =
          await getCashById(
            item.target_entry_id
          );

        if (!target) {
          return res.status(400).json({
            error:
              "Invalid adjustment target",
          });
        }

        if (
          !sameId(
            target.company_id,
            normalizedCompany
          )
        ) {
          return res.status(400).json({
            error:
              "Adjustment target company mismatch",
          });
        }

        if (
          String(
            target.entry_type ||
            ""
          ).toLowerCase() ===
          effectiveType
        ) {
          return res.status(400).json({
            error:
              "Adjustment requires opposite entry type",
          });
        }
      }

      const allExisting =
        await CashEntry.find({})
          .lean();

      const adjustmentMap =
        await getAdjustmentMap(
          allExisting
        );

      for (const item of
        clean) {
        const pending =
          Number(
            (
              (
                await getCashById(
                  item.target_entry_id
                )
              )?.amount || 0
            )
          ) -
          adjustedTotalFor(
            adjustmentMap,
            item.target_entry_id
          );

        if (
          Number(
            item.adjusted_amount
          ) >
          pending + 0.0001
        ) {
          return res.status(400).json({
            error:
              "Adjusted amount exceeds pending amount",
          });
        }
      }

      const normalizedFundSource =
        normalizedCompany &&
        !normalizedEmployee
          ? "party_cash"
          : normalizedEmployee &&
            !normalizedCompany
          ? "employee_cash"
          : [
              "party_cash",
              "employee_cash",
              "main_cash",
            ].includes(
              String(
                fund_source ||
                  "main_cash"
              ).toLowerCase()
            )
          ? String(
              fund_source ||
                "main_cash"
            ).toLowerCase()
          : "main_cash";

      const now =
        new Date();

      const mainDoc = {
        id,
        voucher_no:
          finalVoucherNo,
        journal_group_no:
          journal_group_no ||
          null,
        entry_date:
          new Date(entry_date),
        entry_type:
          effectiveType,
        warehouse_id:
          normalizedWarehouse,
        company_id:
          normalizedCompany,
        company_account_id:
          normalizedAccount,
        description:
          String(
            description || ""
          ),
        amount:
          Number(amount),
        payment_method:
          payment_method ||
          "Cash",
        reference_no:
          reference_no ||
          null,
        narration:
          narration ||
          null,
        created_by:
          normalizeCreatedBy(
            req.user?.id,
            created_by,
            normalizedEmployee
          ),
        employee_id:
          normalizedEmployee,
        fund_source:
          normalizedFundSource,
        status:
          status || "pending",
        source_expense_id:
          normalizeMixedId(
            source_expense_id
          ),
        linked_entry_id:
          null,
        adjustments:
          clean,
        created_at: now,
        updated_at: now,
      };

      let staffDoc = null;

      const createStaff =
        auto_staff_entry ===
          true ||
        auto_staff_entry ===
          "true" ||
        auto_staff_entry ===
          1 ||
        auto_staff_entry ===
          "1";

      if (
        createStaff &&
        normalizedEmployee &&
        normalizedFundSource ===
          "main_cash" &&
        (
          normalizedMode ===
            "receipt" ||
          normalizedMode ===
            "payment"
        )
      ) {
        const staffId =
          id + 1;

        const staffType =
          normalizedMode ===
          "payment"
            ? "income"
            : "expense";

        const staffPrefix =
          staffType ===
          "income"
            ? "REC"
            : "PAY";

        staffDoc = {
          id: staffId,
          voucher_no:
            await getNextVoucherNo(
              staffPrefix
            ),
          journal_group_no:
            journal_group_no ||
            null,
          entry_date:
            new Date(entry_date),
          entry_type:
            staffType,
          warehouse_id:
            normalizedWarehouse,
          company_id:
            null,
          company_account_id:
            null,
          description:
            String(
              description || ""
            ),
          amount:
            Number(amount),
          payment_method:
            payment_method ||
            "Cash",
          reference_no:
            reference_no ||
            null,
          narration:
            narration ||
            null,
          created_by:
            normalizeCreatedBy(
              req.user?.id,
              created_by
            ),
          employee_id:
            normalizedEmployee,
          fund_source:
            "employee_cash",
          status:
            status ||
            "pending",
          source_expense_id:
            null,
          linked_entry_id:
            id,
          adjustments: [],
          created_at: now,
          updated_at: now,
        };

        mainDoc.linked_entry_id =
          staffId;
      }

      if (staffDoc) {
        await CashEntry.insertMany(
          [
            mainDoc,
            staffDoc,
          ],
          {
            ordered: true,
          }
        );
      } else {
        await CashEntry.create(
          mainDoc
        );
      }

      writeAudit({
        req,
        action:
          staffDoc
            ? "create_with_staff_entry"
            : "create",
        entry_id: id,
        voucher_no:
          finalVoucherNo,
        details: {
          entry_type:
            effectiveType,
          amount:
            Number(amount),
          adjustments:
            clean,
          linked_entry_id:
            staffDoc?.id ||
            null,
        },
      });

      return res.json({
        id,
        linked_entry_id:
          staffDoc?.id ||
          null,
        message:
          staffDoc
            ? "Cash entry and staff entry created successfully"
            : "Cash entry created successfully",
      });
    } catch (err) {
      console.error(
        "POST /cash-entries Mongo error:",
        err
      );

      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

router.put(
  "/:id(\\d+)",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "cash.edit"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to edit cash entries",
      });
    }

    if (!mongoReady()) {
      return res.status(503).json({
        error:
          "MongoDB is not connected.",
      });
    }

    try {
      const id =
        Number(req.params.id);

      const old =
        await getCashById(id);

      if (!old) {
        return res.status(404).json({
          error:
            "Entry not found",
        });
      }

      if (
        !(await ensureWarehouseAccess(
          req,
          res,
          old.warehouse_id
        ))
      ) {
        return;
      }

      const body =
        req.body || {};

      const {
        entry_date,
        entry_type,
        warehouse_id,
        company_id,
        company_account_id,
        description,
        amount,
        payment_method,
        reference_no,
        narration,
        employee_id,
        status,
        fund_source,
        adjustments,
      } = body;

      const clean =
        cleanAdjustments(
          adjustments
        );

      const totalAdjusted =
        clean.reduce(
          (sum, item) =>
            sum +
            Number(
              item.adjusted_amount
            ),
          0
        );

      if (
        totalAdjusted >
        Number(amount || 0)
      ) {
        return res.status(400).json({
          error:
            "Adjusted total cannot exceed entry amount",
        });
      }

      const normalizedWarehouse =
        await resolveMasterId(
          Warehouse,
          warehouse_id
        );

      const normalizedCompany =
        await resolveMasterId(
          Company,
          company_id
        );

      const normalizedAccount =
        await resolveMasterId(
          CompanyAccount,
          company_account_id
        );

      const normalizedEmployee =
        await resolveMasterId(
          Employee,
          employee_id
        );

      const allExisting =
        await CashEntry.find({})
          .lean();

      const adjustmentMap =
        await getAdjustmentMap(
          allExisting
        );

      for (const item of
        clean) {
        if (
          Number(
            item.target_entry_id
          ) === id
        ) {
          return res.status(400).json({
            error:
              "Entry cannot adjust itself",
          });
        }

        const target =
          await getCashById(
            item.target_entry_id
          );

        if (!target) {
          return res.status(400).json({
            error:
              "Invalid adjustment target",
          });
        }

        if (
          !sameId(
            target.company_id,
            normalizedCompany
          )
        ) {
          return res.status(400).json({
            error:
              "Adjustment target company mismatch",
          });
        }

        if (
          String(
            target.entry_type ||
              ""
          ).toLowerCase() ===
          String(
            entry_type || ""
          ).toLowerCase()
        ) {
          return res.status(400).json({
            error:
              "Adjustment requires opposite entry type",
          });
        }

        const previousAdjusted =
          (
            adjustmentMap.get(
              String(
                item.target_entry_id
              )
            ) || []
          )
            .filter(
              (x) =>
                Number(
                  x.source_entry_id
                ) !== id
            )
            .reduce(
              (sum, x) =>
                sum +
                Number(
                  x.adjusted_amount ||
                    0
                ),
              0
            );

        const pending =
          Number(
            target.amount || 0
          ) -
          previousAdjusted;

        if (
          Number(
            item.adjusted_amount
          ) >
          pending + 0.0001
        ) {
          return res.status(400).json({
            error:
              "Adjusted amount exceeds pending amount",
          });
        }
      }

      const next =
        await CashEntry.findOneAndUpdate(
          { id },
          {
            $set: {
              entry_date:
                new Date(
                  entry_date
                ),
              entry_type:
                String(
                  entry_type
                ).toLowerCase(),
              warehouse_id:
                normalizedWarehouse,
              company_id:
                normalizedCompany,
              company_account_id:
                normalizedAccount,
              description:
                String(
                  description || ""
                ),
              amount:
                Number(amount || 0),
              payment_method:
                payment_method ||
                "Cash",
              reference_no:
                reference_no ||
                null,
              narration:
                narration ||
                null,
              employee_id:
                normalizedEmployee,
              fund_source:
                String(
                  fund_source ||
                    "main_cash"
                ),
              status:
                status || "pending",
              adjustments:
                clean,
              updated_at:
                new Date(),
            },
          },
          {
            new: true,
            runValidators: true,
          }
        )
          .lean();

      writeAudit({
        req,
        action: "edit",
        entry_id: id,
        voucher_no:
          old.voucher_no ||
          null,
        details: {
          before: old,
          after: next,
        },
      });

      return res.json({
        id: String(id),
        updated: 1,
        message:
          "Cash entry updated successfully",
      });
    } catch (err) {
      console.error(
        "PUT /cash-entries Mongo error:",
        err
      );

      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

router.patch(
  "/bulk-cancel",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "cash.delete"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to cancel cash entries",
      });
    }

    if (!mongoReady()) {
      return res.status(503).json({
        error:
          "MongoDB is not connected.",
      });
    }

    try {
      const rawIds =
        Array.isArray(
          req.body?.ids
        )
          ? req.body.ids
          : [];

      if (rawIds.length) {
        const ids =
          rawIds
            .map(Number)
            .filter(
              (x) =>
                Number.isFinite(x) &&
                x > 0
            );

        let changes = 0;

        for (const id of
          ids) {
          const old =
            await getCashById(
              id
            );

          if (!old) {
            continue;
          }

          if (
            !(await hasWarehouseAccess(
              req,
              old.warehouse_id
            ))
          ) {
            continue;
          }

          const result =
            await CashEntry.updateOne(
              { id },
              {
                $set: {
                  status:
                    "cancelled",
                  updated_at:
                    new Date(),
                },
              }
            );

          if (
            result.modifiedCount
          ) {
            changes +=
              result.modifiedCount;
          }
        }

        writeAudit({
          req,
          action:
            "bulk_cancel",
          details: {
            ids,
            changes,
          },
        });

        return res.json({
          message:
            "Selected entries cancelled successfully",
          changes,
        });
      }

      const rows =
        await CashEntry.find({
          status: {
            $ne:
              "cancelled",
          },
        })
          .lean();

      let changes = 0;

      for (const row of
        rows || []) {
        if (
          !isAdminUser(req.user) &&
          !(await hasWarehouseAccess(
            req,
            row.warehouse_id
          ))
        ) {
          continue;
        }

        const result =
          await CashEntry.updateOne(
            { _id: row._id },
            {
              $set: {
                status:
                  "cancelled",
                updated_at:
                  new Date(),
              },
            }
          );

        if (
          result.modifiedCount
        ) {
          changes +=
            result.modifiedCount;
        }
      }

      writeAudit({
        req,
        action:
          "bulk_cancel",
        details: {
          all_active: true,
          changes,
        },
      });

      return res.json({
        message:
          "All active entries cancelled successfully",
        changes,
      });
    } catch (err) {
      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

router.patch(
  "/:id(\\d+)",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "cash.edit"
      ) &&
      !userHasPermission(
        req.user,
        "cash.pending.post"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to update cash entry status",
      });
    }

    if (!mongoReady()) {
      return res.status(503).json({
        error:
          "MongoDB is not connected.",
      });
    }

    try {
      const id =
        Number(req.params.id);

      const old =
        await getCashById(id);

      if (!old) {
        return res.status(404).json({
          error:
            "Entry not found",
        });
      }

      if (
        !(await hasWarehouseAccess(
          req,
          old.warehouse_id
        ))
      ) {
        return res.status(403).json({
          error:
            "Warehouse access denied",
        });
      }

      const status =
        String(
          req.body?.status || ""
        ).trim();

      if (!status) {
        return res.status(400).json({
          error:
            "Status is required",
        });
      }

      const result =
        await CashEntry.updateOne(
          { id },
          {
            $set: {
              status,
              updated_at:
                new Date(),
            },
          }
        );

      writeAudit({
        req,
        action:
          status ===
          "cancelled"
            ? "cancel"
            : "status_change",
        entry_id: id,
        voucher_no:
          old.voucher_no ||
          null,
        details: {
          before_status:
            old.status ||
            "pending",
          after_status:
            status,
        },
      });

      return res.json({
        message:
          "Cash entry status updated successfully",
        changes:
          result.modifiedCount ||
          0,
      });
    } catch (err) {
      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

router.delete(
  "/:id(\\d+)",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "cash.delete"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to delete cash entries",
      });
    }

    if (!mongoReady()) {
      return res.status(503).json({
        error:
          "MongoDB is not connected.",
      });
    }

    try {
      const id =
        Number(req.params.id);

      const old =
        await getCashById(id);

      if (!old) {
        return res.status(404).json({
          error:
            "Entry not found",
        });
      }

      if (
        !(await hasWarehouseAccess(
          req,
          old.warehouse_id
        ))
      ) {
        return res.status(403).json({
          error:
            "Warehouse access denied",
        });
      }

      const permanent =
        String(
          req.query?.permanent ||
            "0"
        ) === "1";

      if (permanent) {
        await CashEntry.updateMany(
          {},
          {
            $pull: {
              adjustments: {
                target_entry_id:
                  id,
              },
            },
          }
        );

        const result =
          await CashEntry.deleteOne({
            id,
          });

        if (
          !result.deletedCount
        ) {
          return res.status(404).json({
            error:
              "Entry not found",
          });
        }

        writeAudit({
          req,
          action:
            "permanent_delete",
          entry_id: id,
          voucher_no:
            old.voucher_no ||
            null,
          details: {
            previous_status:
              old.status ||
              "pending",
          },
        });

        return res.json({
          message:
            "Cash entry deleted permanently",
          deleted: 1,
        });
      }

      const result =
        await CashEntry.updateOne(
          { id },
          {
            $set: {
              status:
                "cancelled",
              updated_at:
                new Date(),
            },
          }
        );

      writeAudit({
        req,
        action: "delete",
        entry_id: id,
        voucher_no:
          old.voucher_no ||
          null,
        details: {
          before_status:
            old.status ||
            "pending",
          after_status:
            "cancelled",
        },
      });

      return res.json({
        message:
          "Cash entry cancelled successfully",
        changes:
          result.modifiedCount ||
          0,
      });
    } catch (err) {
      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

module.exports = router;
