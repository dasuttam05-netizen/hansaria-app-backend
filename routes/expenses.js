const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

const {
  isMongoMirrorReady,
} = require("../db-mongodb");

const {
  userHasPermission,
} = require("../middleware/auth");

const {
  canAccessWarehouse,
} = require("../helpers/access");

/*
====================================================
MONGODB COLLECTIONS
====================================================
*/

function getDb() {
  if (!mongoose.connection.db) {
    throw new Error(
      "MongoDB database handle is not available"
    );
  }

  return mongoose.connection.db;
}

function collection(name) {
  return getDb().collection(name);
}

function mongoReady() {
  return (
    isMongoMirrorReady() &&
    mongoose.connection.readyState === 1
  );
}

function requireMongo(res) {
  if (!mongoReady()) {
    res.status(503).json({
      error:
        "MongoDB is not connected. Please try again in a moment.",
    });

    return false;
  }

  return true;
}

/*
====================================================
CONSTANTS
====================================================
*/

const WORK_DESCRIPTION_OPTIONS = [
  "Palti Lorry",
  "Self Loading",
  "Local Sale",
  "Warehouse Inward",
  "Warehouse Outward",
  "Others",
];

const EXPENSE_PARTICULAR_DEFAULTS = [
  "KANTA",
  "JALPANI",
  "PARKING",
  "PALTI",
  "SAZAI",
  "LOADING",
  "UNLOADING",
  "NEW BAGS",
  "ADVANCE",
  "REFILLING",
  "KAMALI",
  "DALA",
  "SUTULI",
  "EXTRA",
  "VEHICLE FREIGHT",
  "BUSINESS TRAVEL",
  "HOTEL",
  "FOODING",
  "GODOWN RENT",
  "BIKE KM",
];

/*
====================================================
COMMON HELPERS
====================================================
*/

function text(value) {
  return String(value ?? "").trim();
}

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isPositiveNumber(value) {
  const n = Number(value);

  return (
    Number.isFinite(n) &&
    n > 0
  );
}

function normalizeLorryNo(...values) {
  for (const value of values) {
    const cleaned =
      String(
        value ?? ""
      ).trim();

    if (
      cleaned &&
      cleaned !== "0"
    ) {
      return cleaned;
    }
  }

  return "";
}

function formatInwardVoucher(slNo) {
  return `INV${String(
    slNo
  ).padStart(3, "0")}`;
}

function formatOutwardVoucher(slNo) {
  return `OUT-${String(
    slNo
  ).padStart(4, "0")}`;
}

function normalizeWorkDescription(
  value
) {
  const cleaned =
    String(
      value || ""
    ).trim();

  return WORK_DESCRIPTION_OPTIONS.includes(
    cleaned
  )
    ? cleaned
    : null;
}

function calculateExpenseBalance(
  loading,
  unloading,
  shortage,
  excess
) {
  const total =
    (Number(
      loading
    ) || 0) -
    (Number(
      unloading
    ) || 0) -
    (Number(
      shortage
    ) || 0) +
    (Number(
      excess
    ) || 0);

  return Number(
    total.toFixed(2)
  );
}

function isEffectivelyEmptyExpenseItem(
  item
) {
  return (
    numberValue(
      item?.bags
    ) === 0 &&
    numberValue(
      item?.rate
    ) === 0 &&
    numberValue(
      item?.amount
    ) === 0
  );
}

function buildDefaultExpenseItems() {
  return EXPENSE_PARTICULAR_DEFAULTS.map(
    (name, index) => ({
      id: null,
      line_no:
        index + 1,
      particular_name:
        name,
      bags: 0,
      rate: 0,
      amount: 0,
    })
  );
}

function resolveExpenseParticularName(
  item,
  fallbackName = ""
) {
  const candidates = [
    item?.particular_name,
    item?.particulars,
    item?.name,
  ];

  for (const candidate of candidates) {
    const value =
      String(
        candidate ?? ""
      ).trim();

    if (value) {
      return value;
    }
  }

  return String(
    fallbackName ?? ""
  ).trim();
}

function normalizeExpenseItemsForDisplay(
  items
) {
  const existingItems =
    Array.isArray(items)
      ? items.filter(Boolean)
      : [];

  if (
    existingItems.length ===
    0
  ) {
    return buildDefaultExpenseItems();
  }

  const unusedItems = [
    ...existingItems,
  ];

  const rows =
    EXPENSE_PARTICULAR_DEFAULTS.map(
      (
        defaultName,
        index
      ) => {
        const normalizedDefaultName =
          defaultName
            .trim()
            .toLowerCase();

        let matchIndex =
          unusedItems.findIndex(
            (item) =>
              Number(
                item.line_no
              ) ===
              index + 1
          );

        if (matchIndex === -1) {
          matchIndex =
            unusedItems.findIndex(
              (item) =>
                resolveExpenseParticularName(
                  item
                )
                  .trim()
                  .toLowerCase() ===
                normalizedDefaultName
            );
        }

        const matchedItem =
          matchIndex >= 0
            ? unusedItems.splice(
                matchIndex,
                1
              )[0]
            : null;

        const bags =
          matchedItem?.bags ??
          0;

        const rate =
          matchedItem?.rate ??
          0;

        return {
          id:
            matchedItem?.id ||
            null,

          line_no:
            index + 1,

          particular_name:
            resolveExpenseParticularName(
              matchedItem,
              defaultName
            ) ||
            defaultName,

          bags,

          rate,

          amount:
            matchedItem?.amount ??
            Number(
              (
                numberValue(
                  bags
                ) *
                numberValue(
                  rate
                )
              ).toFixed(2)
            ),
        };
      }
    );

  const extraRows =
    unusedItems.map(
      (item, index) => {
        const lineNo =
          Number(
            item?.line_no
          ) ||
          EXPENSE_PARTICULAR_DEFAULTS.length +
            index +
            1;

        const bags =
          item?.bags ??
          0;

        const rate =
          item?.rate ??
          0;

        return {
          id:
            item?.id ||
            null,

          line_no:
            lineNo,

          particular_name:
            resolveExpenseParticularName(
              item,
              `Particular ${
                EXPENSE_PARTICULAR_DEFAULTS.length +
                index +
                1
              }`
            ),

          bags,

          rate,

          amount:
            item?.amount ??
            Number(
              (
                numberValue(
                  bags
                ) *
                numberValue(
                  rate
                )
              ).toFixed(2)
            ),
        };
      }
    );

  return [
    ...rows,
    ...extraRows,
  ];
}

function isDefaultEmptyExpenseItemsPayload(
  items
) {
  if (
    !Array.isArray(items) ||
    items.length === 0
  ) {
    return false;
  }

  return items.every(
    (item, index) => {
      const name =
        String(
          item?.particular_name ||
            ""
        )
          .trim()
          .toUpperCase();

      const defaultName =
        EXPENSE_PARTICULAR_DEFAULTS[
          index
        ] || "";

      return (
        name ===
          defaultName &&
        isEffectivelyEmptyExpenseItem(
          item
        )
      );
    }
  );
}

function hasAnyNonZeroItemInput(
  items
) {
  return (
    Array.isArray(
      items
    ) &&
    items.some(
      (item) =>
        numberValue(
          item?.bags
        ) !== 0 ||
        numberValue(
          item?.rate
        ) !== 0 ||
        numberValue(
          item?.amount
        ) !== 0
    )
  );
}

function sanitizeExpenseItems(
  items
) {
  if (
    !Array.isArray(items)
  ) {
    return [];
  }

  return items
    .filter(
      (item) =>
        item &&
        String(
          item.particular_name ??
            ""
        ).trim()
    )
    .map(
      (
        item,
        index
      ) => ({
        id:
          item?.id ??
          null,

        line_no:
          Number(
            item?.line_no
          ) ||
          index + 1,

        particular_name:
          resolveExpenseParticularName(
            item
          ),

        bags:
          numberValue(
            item?.bags
          ),

        rate:
          numberValue(
            item?.rate
          ),

        amount:
          numberValue(
            item?.amount
          ),
      })
    );
}

/*
====================================================
ID HELPERS
====================================================
*/

function buildIdConditions(
  value
) {
  const raw =
    text(value);

  if (!raw) {
    return [];
  }

  const conditions = [];

  if (
    mongoose.Types.ObjectId.isValid(
      raw
    )
  ) {
    conditions.push({
      _id:
        new mongoose.Types.ObjectId(
          raw
        ),
    });
  }

  const numeric =
    Number(raw);

  if (
    Number.isFinite(
      numeric
    )
  ) {
    conditions.push({
      id:
        numeric,
    });

    conditions.push({
      legacy_id:
        numeric,
    });

    conditions.push({
      sl_no:
        numeric,
    });
  }

  return conditions;
}

function buildIdFilter(
  value
) {
  const conditions =
    buildIdConditions(
      value
    );

  if (
    !conditions.length
  ) {
    return null;
  }

  if (
    conditions.length ===
    1
  ) {
    return conditions[0];
  }

  return {
    $or:
      conditions,
  };
}

async function findFlexible(
  collectionName,
  value
) {
  const filter =
    buildIdFilter(
      value
    );

  if (!filter) {
    return null;
  }

  return collection(
    collectionName
  ).findOne(
    filter
  );
}

/*
====================================================
MASTER LOOKUPS
====================================================
*/

async function lookupMaster(
  collectionName,
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  return findFlexible(
    collectionName,
    value
  );
}

async function getMasterName(
  collectionName,
  value,
  fields = [
    "name",
  ]
) {
  const doc =
    await lookupMaster(
      collectionName,
      value
    );

  if (!doc) {
    return "";
  }

  for (const field of fields) {
    if (
      doc[field] !==
        undefined &&
      doc[field] !==
        null &&
      String(
        doc[field]
      ).trim()
    ) {
      return String(
        doc[field]
      );
    }
  }

  return "";
}

/*
====================================================
EMPLOYEE RESOLUTION
====================================================
*/

async function resolveCurrentEmployee(
  user
) {
  const employeeCollection =
    collection(
      "employees"
    );

  const candidates = [];

  if (
    user?.id
  ) {
    candidates.push({
      _id:
        mongoose.Types.ObjectId.isValid(
          String(
            user.id
          )
        )
          ? new mongoose.Types.ObjectId(
              String(
                user.id
              )
            )
          : undefined,
    });
  }

  const username =
    text(
      user?.username
    );

  if (username) {
    candidates.push({
      username: {
        $regex:
          `^${escapeRegex(
            username
          )}$`,
        $options:
          "i",
      },
    });
  }

  const employeeId =
    text(
      user?.employee_id
    );

  if (employeeId) {
    candidates.push({
      employee_id:
        employeeId,
    });
  }

  const name =
    text(
      user?.name
    );

  if (name) {
    candidates.push({
      name: {
        $regex:
          `^${escapeRegex(
            name
          )}$`,
        $options:
          "i",
      },
    });
  }

  for (
    const candidate of
      candidates
  ) {
    if (
      candidate._id ===
      undefined
    ) {
      delete candidate._id;
    }

    if (
      Object.keys(
        candidate
      ).length === 0
    ) {
      continue;
    }

    const doc =
      await employeeCollection.findOne(
        candidate
      );

    if (doc) {
      return doc;
    }
  }

  return null;
}

function escapeRegex(
  value
) {
  return String(
    value
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

/*
====================================================
EMPLOYEE / WAREHOUSE ACCESS
====================================================
*/

function shouldRestrictToOwnEmployee(
  user
) {
  return (
    !userHasPermission(
      user,
      "employees.view"
    ) &&
    !userHasPermission(
      user,
      "cash.create"
    )
  );
}

function normalizeIdString(
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "";
  }

  return String(
    value
  ).trim();
}

function getAssignedWarehouseIds(
  user
) {
  const raw = [
    ...(Array.isArray(
      user?.assigned_warehouse_ids
    )
      ? user.assigned_warehouse_ids
      : []),
  ];

  return Array.from(
    new Set(
      raw
        .map(
          normalizeIdString
        )
        .filter(Boolean)
    )
  );
}

function canUseAllWarehouses(
  user
) {
  return (
    !user ||
    user.role ===
      "admin" ||
    userHasPermission(
      user,
      "warehouses.manage"
    ) ||
    userHasPermission(
      user,
      "all"
    )
  );
}

async function resolveUserLocationIds(
  user
) {
  const values = [
    user?.location_id,
    ...(Array.isArray(
      user?.location_ids
    )
      ? user.location_ids
      : []),
  ].filter(Boolean);

  return Array.from(
    new Set(
      values.map(
        normalizeIdString
      )
    )
  );
}

async function canAccessExpenseWarehouse(
  user,
  warehouseId,
  locationId = null
) {
  if (
    canUseAllWarehouses(
      user
    )
  ) {
    return true;
  }

  /*
   * Keep existing access-helper behaviour
   * where possible, but never query legacy storage.
   */
  try {
    if (
      canAccessWarehouse(
        user,
        warehouseId
      )
    ) {
      return true;
    }
  } catch {
    // Ignore helper mismatch.
  }

  const assigned =
    getAssignedWarehouseIds(
      user
    );

  const currentWarehouse =
    normalizeIdString(
      warehouseId
    );

  if (
    assigned.includes(
      currentWarehouse
    )
  ) {
    return true;
  }

  const userLocations =
    await resolveUserLocationIds(
      user
    );

  const currentLocation =
    normalizeIdString(
      locationId
    );

  if (
    currentLocation &&
    userLocations.includes(
      currentLocation
    )
  ) {
    return true;
  }

  if (
    currentWarehouse
  ) {
    const warehouse =
      await collection(
        "warehouses"
      ).findOne(
        buildIdFilter(
          currentWarehouse
        ) || {
          _id: null,
        }
      );

    if (
      warehouse &&
      userLocations.includes(
        normalizeIdString(
          warehouse.location_id
        )
      )
    ) {
      return true;
    }
  }

  /*
   * A user with no explicit assignment
   * is not unnecessarily blocked.
   */
  return (
    assigned.length ===
      0 &&
    userLocations.length ===
      0
  );
}

async function resolveWarehouseForLocation(
  user,
  locationId
) {
  const locationKey =
    normalizeIdString(
      locationId
    );

  if (!locationKey) {
    throw new Error(
      "Location is required"
    );
  }

  if (
    !canUseAllWarehouses(
      user
    )
  ) {
    const locations =
      await resolveUserLocationIds(
        user
      );

    if (
      locations.length &&
      !locations.includes(
        locationKey
      )
    ) {
      throw new Error(
        "You do not have access to this location"
      );
    }
  }

  const warehouses =
    await collection(
      "warehouses"
    )
      .find({})
      .sort({
        created_at:
          1,
        _id:
          1,
      })
      .toArray();

  const assigned =
    getAssignedWarehouseIds(
      user
    );

  const candidates =
    warehouses.filter(
      (warehouse) =>
        normalizeIdString(
          warehouse.location_id
        ) ===
        locationKey
    );

  const allowed =
    canUseAllWarehouses(
      user
    )
      ? candidates
      : candidates.filter(
          (warehouse) =>
            assigned.length === 0 ||
            assigned.includes(
              normalizeIdString(
                warehouse._id
              )
            ) ||
            assigned.includes(
              normalizeIdString(
                warehouse.id
              )
            ) ||
            assigned.includes(
              normalizeIdString(
                warehouse.legacy_id
              )
            )
        );

  if (
    allowed.length
  ) {
    return (
      allowed[0]._id
        ? String(
            allowed[0]._id
          )
        : allowed[0].id ??
          allowed[0].legacy_id ??
          null
    );
  }

  /*
   * Preserve the old permissive behaviour:
   * expenses can exist without a warehouse.
   */
  if (
    assigned.length ===
    1
  ) {
    return assigned[0];
  }

  return null;
}

/*
====================================================
EXPENSE MASTER NORMALIZATION
====================================================
*/

async function resolveExpenseMasterIds(
  values
) {
  /*
   * IMPORTANT:
   * MongoDB is now the source.
   *
   * We keep exactly the incoming IDs where possible.
   * This supports both numeric legacy IDs and ObjectIds.
   */

  const location =
    text(
      values.location_id
    );

  const employee =
    text(
      values.employee_id
    );

  const product =
    text(
      values.product_id
    );

  const company =
    text(
      values.company_id
    );

  const companyAccount =
    text(
      values.company_account_id
    );

  const regFromCompany =
    text(
      values.reg_from_company_id
    );

  let sendToRef =
    text(
      values.send_to_ref_id
    );

  if (
    values.send_to_kind ===
    "palti_lorry"
  ) {
    sendToRef =
      null;
  }

  return {
    location_id:
      location || null,

    employee_id:
      employee || null,

    product_id:
      product || null,

    company_id:
      company || null,

    company_account_id:
      companyAccount ||
      null,

    reg_from_company_id:
      regFromCompany ||
      null,

    send_to_ref_id:
      sendToRef ||
      null,
  };
}

/*
====================================================
EXPENSE LOOKUP
====================================================
*/

async function findExpense(
  value
) {
  return findFlexible(
    "expenses",
    value
  );
}

function expenseIdValue(
  expense
) {
  if (!expense) {
    return null;
  }

  return (
    expense.id ??
    expense.legacy_id ??
    (
      expense._id
        ? String(
            expense._id
          )
        : null
    )
  );
}

function expenseResponseId(
  expense
) {
  return expenseIdValue(
    expense
  );
}

/*
====================================================
EXPENSE ITEMS
====================================================
*/

async function loadExpenseItems(
  expense
) {
  const idCandidates =
    [
      expense?.id,
      expense?.legacy_id,
      expense?._id
        ? String(
            expense._id
          )
        : null,
    ].filter(
      (
        value
      ) =>
        value !==
          undefined &&
        value !== null &&
        value !== ""
    );

  if (
    !idCandidates.length
  ) {
    return [];
  }

  const or =
    [];

  for (
    const value of
      idCandidates
  ) {
    const numeric =
      Number(value);

    if (
      Number.isFinite(
        numeric
      )
    ) {
      or.push({
        expense_id:
          numeric,
      });
    }

    or.push({
      expense_id:
        String(value),
    });
  }

  return collection(
    "expenseitems"
  )
    .find({
      $or: or,
    })
    .sort({
      line_no:
        1,
      id:
        1,
      _id:
        1,
    })
    .toArray();
}

async function hasSavedNonZeroExpenseItems(
  expense
) {
  const items =
    await loadExpenseItems(
      expense
    );

  return items.some(
    (item) =>
      numberValue(
        item.bags
      ) !== 0 ||
      numberValue(
        item.rate
      ) !== 0 ||
      numberValue(
        item.amount
      ) !== 0
  );
}

async function replaceExpenseItems(
  expense,
  items
) {
  const ids = [
    expense?.id,
    expense?.legacy_id,
    expense?._id
      ? String(
          expense._id
        )
      : null,
  ].filter(
    (value) =>
      value !==
        undefined &&
      value !== null &&
      value !== ""
  );

  if (!ids.length) {
    return;
  }

  const oldItems =
    await loadExpenseItems(
      expense
    );

  if (
    oldItems.length
  ) {
    await collection(
      "expenseitems"
    ).deleteMany({
      $or: oldItems.map(
        (item) => ({
          _id:
            item._id,
        })
      ),
    });
  }

  const safeItems =
    sanitizeExpenseItems(
      items
    );

  if (
    !safeItems.length
  ) {
    return;
  }

  const primaryId =
    expense.id ??
    expense.legacy_id ??
    (
      expense._id
        ? String(
            expense._id
          )
        : null
    );

  const docs =
    safeItems.map(
      (
        item,
        index
      ) => ({
        expense_id:
          primaryId,

        line_no:
          Number(
            item.line_no
          ) ||
          index + 1,

        particular_name:
          item.particular_name,

        bags:
          numberValue(
            item.bags
          ),

        rate:
          numberValue(
            item.rate
          ),

        amount:
          numberValue(
            item.amount
          ),

        created_at:
          new Date(),

        updated_at:
          new Date(),
      })
    );

  await collection(
    "expenseitems"
  ).insertMany(
    docs,
    {
      ordered:
        true,
    }
  );
}

/*
====================================================
VOUCHER NUMBER
====================================================
*/

async function nextExpenseVoucher() {
  const last =
    await collection(
      "expenses"
    )
      .find(
        {},
        {
          projection: {
            id: 1,
            legacy_id: 1,
          },
        }
      )
      .sort({
        id:
          -1,
        legacy_id:
          -1,
        _id:
          -1,
      })
      .limit(1)
      .next();

  const lastId =
    numberValue(
      last?.id ??
        last?.legacy_id
    );

  const nextId =
    lastId + 1;

  return {
    id:
      nextId,

    voucher_no:
      `EXP-${String(
        nextId
      ).padStart(
        4,
        "0"
      )}`,
  };
}

/*
====================================================
MASTER ENRICHMENT
====================================================
*/

async function enrichExpense(
  expense
) {
  if (!expense) {
    return null;
  }

  const [
    location,
    employee,
    product,
    company,
    account,
    warehouse,
    regFromCompany,
    regFromConsignee,
  ] =
    await Promise.all([
      lookupMaster(
        "locations",
        expense.location_id
      ),

      lookupMaster(
        "employees",
        expense.employee_id
      ),

      lookupMaster(
        "products",
        expense.product_id
      ),

      lookupMaster(
        "companies",
        expense.company_id
      ),

      lookupMaster(
        "companyaccounts",
        expense.company_account_id
      ),

      lookupMaster(
        "warehouses",
        expense.warehouse_id
      ),

      lookupMaster(
        "companies",
        expense.reg_from_company_id
      ),

      lookupMaster(
        "consigneenames",
        expense.reg_from_consignee_id
      ),
    ]);

  let sendToName =
    "";

  if (
    expense.send_to_kind ===
    "consignee"
  ) {
    sendToName =
      await getMasterName(
        "consigneenames",
        expense.send_to_ref_id,
        [
          "name",
        ]
      );
  } else if (
    expense.send_to_kind ===
    "company"
  ) {
    sendToName =
      await getMasterName(
        "companies",
        expense.send_to_ref_id,
        [
          "name",
        ]
      );
  } else if (
    expense.send_to_kind ===
    "warehouse"
  ) {
    sendToName =
      await getMasterName(
        "warehouses",
        expense.send_to_ref_id,
        [
          "name",
        ]
      );
  } else if (
    expense.send_to_kind ===
    "palti_lorry"
  ) {
    sendToName =
      "Palti Lorry";
  } else {
    if (
      expense.send_to_party_id
    ) {
      sendToName =
        await getMasterName(
          "buyernames",
          expense.send_to_party_id,
          [
            "name",
          ]
        );
    }

    if (
      !sendToName &&
      expense.send_to_company_id
    ) {
      sendToName =
        await getMasterName(
          "companies",
          expense.send_to_company_id,
          [
            "name",
          ]
        );
    }
  }

  const items =
    await loadExpenseItems(
      expense
    );

  return {
    ...expense,

    id:
      expenseResponseId(
        expense
      ),

    mongo_id:
      expense?._id
        ? String(
            expense._id
          )
        : null,

    expense_location_id:
      expense.location_id ??
      null,

    expense_location_name:
      location?.name ||
      "",

    effective_location_id:
      warehouse?.location_id ??
      expense.location_id ??
      null,

    effective_location_name:
      warehouse
        ? await getMasterName(
            "locations",
            warehouse.location_id,
            [
              "name",
            ]
          )
        : location?.name ||
          "",

    location_name:
      warehouse
        ? (
            await getMasterName(
              "locations",
              warehouse.location_id,
              [
                "name",
              ]
            )
          ) ||
          location?.name ||
          ""
        : location?.name ||
          "",

    warehouse_name:
      warehouse?.name ||
      "",

    employee_name:
      employee?.name ||
      "",

    product_name:
      product?.name ||
      "",

    company_name:
      company?.name ||
      "",

    company_account_name:
      account?.account_name ||
      account?.name ||
      "",

    reg_from_company_name:
      regFromConsignee?.name ||
      regFromCompany?.name ||
      "",

    send_to_company_name:
      sendToName ||
      "",

    items:
      normalizeExpenseItemsForDisplay(
        items
      ),
  };
}

/*
====================================================
POST TO INWARD
====================================================
*/

async function postExpenseToInward(
  expense
) {
  if (
    !expense
  ) {
    return {
      posted:
        false,
    };
  }

  if (
    numberValue(
      expense.posted_to_inward
    ) === 1 ||
    expense.inward_id
  ) {
    return {
      posted:
        false,

      already_posted:
        true,

      inward_id:
        expense.inward_id ??
        null,
    };
  }

  const inwardWeight =
    numberValue(
      expense.new_weight
    ) ||
    numberValue(
      expense.net_weight
    ) ||
    numberValue(
      expense.balance
    );

  const lorryNo =
    normalizeLorryNo(
      expense.reg_lorry_no,
      expense.new_lorry_no
    );

  const narrationParts = [
    `From Expense ${
      expense.voucher_no ||
      ""
    }`.trim(),
  ];

  if (
    expense.work_description
  ) {
    narrationParts.push(
      `Work: ${
        expense.work_description
      }`
    );
  }

  const [
    last
  ] =
    await collection(
      "inwards"
    )
      .find(
        {},
        {
          projection: {
            sl_no: 1,
          },
        }
      )
      .sort({
        sl_no:
          -1,
        _id:
          -1,
      })
      .limit(1)
      .toArray();

  const nextSl =
    numberValue(
      last?.sl_no
    ) + 1;

  const inwardVoucher =
    formatInwardVoucher(
      nextSl
    );

  const doc = {
    legacy_id:
      nextSl,

    sl_no:
      nextSl,

    voucher_no:
      inwardVoucher,

    date:
      expense.expense_date
        ? new Date(
            expense.expense_date
          )
        : new Date(),

    employee_id:
      expense.employee_id ??
      null,

    location_id:
      expense.location_id ??
      null,

    warehouse_id:
      expense.warehouse_id ??
      null,

    product_id:
      expense.product_id ??
      null,

    company_id:
      expense.company_id ??
      null,

    company_account_id:
      expense.company_account_id ??
      null,

    employee_name:
      expense.employee_name ||
      "",

    lorry_no:
      lorryNo ||
      null,

    location:
      expense.location_id ??
      null,

    inward_no:
      inwardVoucher,

    company:
      expense.company_id ??
      null,

    company_account:
      expense.company_account_id ??
      null,

    product:
      expense.product_id ??
      null,

    quantity:
      inwardWeight,

    weight:
      inwardWeight,

    remaining_qty:
      inwardWeight,

    rate:
      0,

    amount:
      0,

    narration:
      narrationParts.join(
        " | "
      ),

    created_at:
      new Date(),

    updated_at:
      new Date(),
  };

  const result =
    await collection(
      "inwards"
    ).insertOne(
      doc
    );

  const inwardId =
    Number(
      doc.legacy_id
    ) ||
    String(
      result.insertedId
    );

  await collection(
    "expenses"
  ).updateOne(
    {
      _id:
        expense._id,
    },
    {
      $set: {
        posted_to_inward:
          1,

        inward_id:
          inwardId,

        inward_posted_at:
          new Date(),

        updated_at:
          new Date(),
      },
    }
  );

  return {
    posted:
      true,

    inward_id:
      inwardId,

    inward_voucher_no:
      inwardVoucher,
  };
}

/*
====================================================
POST TO PALTI LORRY
====================================================
*/

async function postExpenseToPaltiLorry(
  expense,
  userId
) {
  if (
    !expense
  ) {
    return {
      posted:
        false,
    };
  }

  if (
    numberValue(
      expense.posted_to_palti
    ) === 1
  ) {
    return {
      posted:
        false,

      already_posted:
        true,
    };
  }

  const paltiCollection =
    collection(
      "paltilorryentries"
    );

  const existing =
    await paltiCollection.findOne(
      {
        $or: [
          {
            expense_id:
              expense.id,
          },

          {
            expense_id:
              String(
                expense.id ??
                  expense.legacy_id ??
                  ""
              ),
          },

          {
            expense_id:
              expense.legacy_id,
          },
        ],
      }
    );

  if (
    existing
  ) {
    await collection(
      "expenses"
    ).updateOne(
      {
        _id:
          expense._id,
      },
      {
        $set: {
          posted_to_palti:
            1,

          palti_lorry_id:
            existing.legacy_id ??
            existing.id ??
            String(
              existing._id
            ),

          palti_posted_at:
            expense.palti_posted_at ||
            new Date(),

          updated_at:
            new Date(),
        },
      }
    );

    return {
      posted:
        false,

      already_posted:
        true,

      palti_id:
        existing.legacy_id ??
        existing.id ??
        String(
          existing._id
        ),
    };
  }

  const doc = {
    legacy_id:
      await nextPaltiLegacyId(),

    expense_id:
      expense.id ??
      expense.legacy_id ??
      String(
        expense._id
      ),

    voucher_no:
      expense.voucher_no ||
      null,

    expense_date:
      expense.expense_date ||
      null,

    warehouse_id:
      expense.warehouse_id ??
      null,

    employee_id:
      expense.employee_id ??
      null,

    product_id:
      expense.product_id ??
      null,

    company_id:
      expense.company_id ??
      null,

    reg_from_consignee_id:
      expense.reg_from_consignee_id ??
      null,

    reg_from_company_id:
      expense.reg_from_company_id ??
      null,

    reg_lorry_no:
      normalizeLorryNo(
        expense.reg_lorry_no
      ),

    balance:
      numberValue(
        expense.balance
      ),

    new_lorry_no:
      normalizeLorryNo(
        expense.reg_lorry_no,
        expense.new_lorry_no
      ),

    new_weight:
      numberValue(
        expense.new_weight
      ),

    created_by:
      userId ??
      null,

    created_at:
      new Date(),

    updated_at:
      new Date(),
  };

  await paltiCollection.insertOne(
    doc
  );

  await collection(
    "expenses"
  ).updateOne(
    {
      _id:
        expense._id,
    },
    {
      $set: {
        posted_to_palti:
          1,

        palti_lorry_id:
          doc.legacy_id,

        palti_posted_at:
          new Date(),

        updated_at:
          new Date(),
      },
    }
  );

  return {
    posted:
      true,

    palti_id:
      doc.legacy_id,
  };
}

async function nextPaltiLegacyId() {
  const last =
    await collection(
      "paltilorryentries"
    )
      .find(
        {},
        {
          projection: {
            legacy_id: 1,
            id: 1,
          },
        }
      )
      .sort({
        legacy_id:
          -1,
        id:
          -1,
        _id:
          -1,
      })
      .limit(1)
      .next();

  return (
    Math.max(
      numberValue(
        last?.legacy_id
      ),
      numberValue(
        last?.id
      )
    ) + 1
  );
}

/*
====================================================
POST TO OUTWARD
====================================================
*/

async function postExpenseToOutward(
  expense
) {
  if (
    !expense
  ) {
    return {
      posted:
        false,
    };
  }

  if (
    numberValue(
      expense.posted_to_outward
    ) === 1 ||
    expense.outward_id
  ) {
    return {
      posted:
        false,

      already_posted:
        true,

      outward_id:
        expense.outward_id ??
        null,
    };
  }

  const outwardQty =
    numberValue(
      expense.balance
    ) ||
    numberValue(
      expense.new_weight
    );

  const lorryNo =
    normalizeLorryNo(
      expense.reg_lorry_no,
      expense.new_lorry_no
    );

  const outwardDate =
    expense.expense_date ||
    null;

  const isSelfLoading =
    String(
      expense.work_description ||
        ""
    ).trim() ===
    "Self Loading";

  const last =
    await collection(
      "outwards"
    )
      .find(
        {},
        {
          projection: {
            sl_no: 1,
          },
        }
      )
      .sort({
        sl_no:
          -1,
        _id:
          -1,
      })
      .limit(1)
      .next();

  const nextSl =
    numberValue(
      last?.sl_no
    ) + 1;

  const outwardVoucher =
    formatOutwardVoucher(
      nextSl
    );

  const doc = {
    legacy_id:
      nextSl,

    sl_no:
      nextSl,

    voucher_no:
      outwardVoucher,

    date:
      outwardDate
        ? new Date(
            outwardDate
          )
        : new Date(),

    employee_id:
      expense.employee_id ??
      null,

    location_id:
      expense.location_id ??
      null,

    warehouse_id:
      isSelfLoading
        ? null
        : (
            expense.warehouse_id ??
            null
          ),

    product_id:
      expense.product_id ??
      null,

    company_id:
      expense.company_id ??
      null,

    company_account_id:
      expense.company_account_id ??
      null,

    buyer:
      null,

    buyer_id:
      null,

    buyer_name:
      null,

    consignee_id:
      null,

    consignee_name:
      null,

    product:
      expense.product_id ??
      null,

    quantity:
      outwardQty,

    weight:
      outwardQty,

    rate:
      0,

    amount:
      0,

    lorry_no:
      lorryNo ||
      null,

    inv_no:
      expense.voucher_no ||
      null,

    narration:
      `From Expense ${
        expense.voucher_no ||
        ""
      }`.trim(),

    status:
      "Pending",

    self_loading:
      isSelfLoading
        ? "Yes"
        : "No",

    created_at:
      new Date(),

    updated_at:
      new Date(),
  };

  const result =
    await collection(
      "outwards"
    ).insertOne(
      doc
    );

  const outwardId =
    Number(
      doc.legacy_id
    ) ||
    String(
      result.insertedId
    );

  await collection(
    "expenses"
  ).updateOne(
    {
      _id:
        expense._id,
    },
    {
      $set: {
        posted_to_outward:
          1,

        outward_id:
          outwardId,

        outward_posted_at:
          new Date(),

        updated_at:
          new Date(),
      },
    }
  );

  return {
    posted:
      true,

    outward_id:
      outwardId,

    outward_voucher_no:
      outwardVoucher,
  };
}

/*
====================================================
ROUTE: LIST
====================================================
*/

router.get(
  "/",
  async (req, res) => {
    try {
      if (
        !userHasPermission(
          req.user,
          "expense.entry"
        ) &&
        !userHasPermission(
          req.user,
          "expense.view"
        ) &&
        !userHasPermission(
          req.user,
          "expense.create"
        ) &&
        !userHasPermission(
          req.user,
          "expense.edit"
        ) &&
        !userHasPermission(
          req.user,
          "expense.delete"
        ) &&
        !userHasPermission(
          req.user,
          "report.expense"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to view expenses",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const filter = {};

      if (
        req.query.status
      ) {
        filter.status =
          String(
            req.query.status
          );
      }

      const rows =
        await collection(
          "expenses"
        )
          .find(
            filter
          )
          .sort({
            id:
              -1,
            legacy_id:
              -1,
            expense_date:
              -1,
            created_at:
              -1,
            _id:
              -1,
          })
          .toArray();

      let filtered =
        rows;

      if (
        shouldRestrictToOwnEmployee(
          req.user
        )
      ) {
        const employee =
          await resolveCurrentEmployee(
            req.user
          );

        if (employee) {
          const employeeIds =
            [
              String(
                employee._id
              ),
              employee.employee_id !=
                null
                ? String(
                    employee.employee_id
                  )
                : null,
            ].filter(
              Boolean
            );

          filtered =
            filtered.filter(
              (row) =>
                employeeIds.includes(
                  String(
                    row.employee_id ??
                      ""
                  )
                )
            );
        }
      }

      const result =
        await Promise.all(
          filtered.map(
            enrichExpense
          )
        );

      return res.json(
        result
      );
    } catch (err) {
      console.error(
        "Mongo expenses list failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

/*
====================================================
ROUTE: INWARD POSTED
====================================================
*/

router.get(
  "/inward-posted",
  async (req, res) => {
    try {
      if (
        !userHasPermission(
          req.user,
          "expense.postedInward"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to view posted inward list",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const rows =
        await collection(
          "expenses"
        )
          .find({
            posted_to_inward:
              1,
          })
          .sort({
            inward_posted_at:
              -1,
            id:
              -1,
            _id:
              -1,
          })
          .toArray();

      const result =
        [];

      for (
        const expense of
          rows
      ) {
        if (
          !(
            await canAccessExpenseWarehouse(
              req.user,
              expense.warehouse_id,
              expense.location_id
            )
          )
        ) {
          continue;
        }

        const [
          warehouse,
          location,
          employee,
          product,
          company,
          inward,
        ] =
          await Promise.all([
            lookupMaster(
              "warehouses",
              expense.warehouse_id
            ),

            lookupMaster(
              "locations",
              expense.location_id
            ),

            lookupMaster(
              "employees",
              expense.employee_id
            ),

            lookupMaster(
              "products",
              expense.product_id
            ),

            lookupMaster(
              "companies",
              expense.company_id
            ),

            findFlexible(
              "inwards",
              expense.inward_id
            ),
          ]);

        result.push({
          expense_id:
            expenseResponseId(
              expense
            ),

          expense_voucher_no:
            expense.voucher_no ||
            null,

          expense_date:
            expense.expense_date ||
            null,

          work_description:
            expense.work_description ||
            null,

          inward_posted_at:
            expense.inward_posted_at ||
            null,

          inward_id:
            expense.inward_id ||
            null,

          inward_voucher_no:
            inward?.voucher_no ||
            null,

          inward_date:
            inward?.date ||
            null,

          inward_narration:
            inward?.narration ||
            null,

          warehouse_name:
            warehouse?.name ||
            "",

          location_name:
            location?.name ||
            "",

          employee_name:
            employee?.name ||
            "",

          product_name:
            product?.name ||
            "",

          company_name:
            company?.name ||
            "",

          saved_from:
            "mongodb",
        });
      }

      return res.json(
        result
      );
    } catch (err) {
      console.error(
        "Mongo inward-posted failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

/*
====================================================
ROUTE: SINGLE EXPENSE
====================================================
*/

router.get(
  "/:id",
  async (req, res) => {
    try {
      if (
        !userHasPermission(
          req.user,
          "expense.entry"
        ) &&
        !userHasPermission(
          req.user,
          "expense.view"
        ) &&
        !userHasPermission(
          req.user,
          "expense.create"
        ) &&
        !userHasPermission(
          req.user,
          "expense.edit"
        ) &&
        !userHasPermission(
          req.user,
          "report.expense"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to view expense entries",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const expense =
        await findExpense(
          req.params.id
        );

      if (!expense) {
        return res.status(404).json({
          error:
            "Expense entry not found",
        });
      }

      if (
        shouldRestrictToOwnEmployee(
          req.user
        )
      ) {
        const employee =
          await resolveCurrentEmployee(
            req.user
          );

        if (
          employee &&
          String(
            employee._id
          ) !==
            String(
              expense.employee_id
            ) &&
          String(
            employee.employee_id ??
              ""
          ) !==
            String(
              expense.employee_id ??
                ""
            )
        ) {
          return res.status(403).json({
            error:
              "You do not have access to this expense",
          });
        }
      }

      if (
        !(
          await canAccessExpenseWarehouse(
            req.user,
            expense.warehouse_id,
            expense.location_id
          )
        )
      ) {
        return res.status(403).json({
          error:
            "You cannot view expenses for this warehouse",
        });
      }

      return res.json(
        await enrichExpense(
          expense
        )
      );
    } catch (err) {
      console.error(
        "Mongo expense detail failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

/*
====================================================
ROUTE: APPROVE TO CASH BOOK
====================================================
*/

router.post(
  "/:id/approve-cash-book",
  async (req, res) => {
    try {
      const canApproveCashPost =
        userHasPermission(
          req.user,
          "cash.pending.post"
        ) ||
        userHasPermission(
          req.user,
          "cash.create"
        );

      if (
        !userHasPermission(
          req.user,
          "expense.edit"
        ) ||
        !canApproveCashPost
      ) {
        return res.status(403).json({
          error:
            "You need expense edit and cash post permission to approve to cash book",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const expense =
        await findExpense(
          req.params.id
        );

      if (!expense) {
        return res.status(404).json({
          error:
            "Expense not found",
        });
      }

      if (
        !(
          await canAccessExpenseWarehouse(
            req.user,
            expense.warehouse_id,
            expense.location_id
          )
        )
      ) {
        return res.status(403).json({
          error:
            "You cannot approve expenses for this warehouse",
        });
      }

      const expenseId =
        expense.id ??
        expense.legacy_id ??
        String(
          expense._id
        );

      const existingCash =
        await collection(
          "cashentries"
        ).findOne({
          $or: [
            {
              source_expense_id:
                expenseId,
            },

            {
              source_expense_id:
                Number(
                  expenseId
                ),
            },

            {
              source_expense_id:
                String(
                  expenseId
                ),
            },
          ],
        });

      if (
        existingCash
      ) {
        return res.status(400).json({
          error:
            "This expense is already in Cash Book pending list",
        });
      }

      const now =
        new Date();

      await collection(
        "expenses"
      ).updateOne(
        {
          _id:
            expense._id,
        },
        {
          $set: {
            status:
              "CONFIRMED_BY_HO",

            updated_at:
              now,
          },
        }
      );

      const createdCashEntries =
        [];

      const baseDescription =
        `${expense.work_description || ""}, ${
          expense.lorry_no ||
          ""
        }`.trim();

      const totalAmount =
        numberValue(
          expense.total_expense_amount
        );

      if (
        expense.employee_id
      ) {
        const employeeCashDoc = {
          id:
            await nextCashEntryId(),

          voucher_no:
            expense.voucher_no
              ? `${expense.voucher_no}-EMP`
              : null,

          journal_group_no:
            null,

          entry_date:
            expense.expense_date
              ? new Date(
                  expense.expense_date
                )
              : now,

          entry_type:
            "expense",

          warehouse_id:
            expense.warehouse_id ??
            null,

          company_id:
            null,

          company_account_id:
            null,

          description:
            baseDescription,

          amount:
            totalAmount,

          payment_method:
            "Cash",

          reference_no:
            expense.voucher_no ||
            null,

          narration:
            expense.narration ||
            null,

          created_by:
            req.user?.id ??
            null,

          employee_id:
            expense.employee_id,

          fund_source:
            "employee_cash",

          status:
            "pending",

          source_expense_id:
            expenseId,

          linked_entry_id:
            null,

          created_at:
            now,

          updated_at:
            now,
        };

        await collection(
          "cashentries"
        ).insertOne(
          employeeCashDoc
        );

        createdCashEntries.push(
          employeeCashDoc
        );
      }

      const partyCompanyId =
        expense.company_id ||
        expense.send_to_company_id ||
        null;

      if (
        partyCompanyId
      ) {
        const partyCashDoc = {
          id:
            await nextCashEntryId(),

          voucher_no:
            expense.voucher_no
              ? `${expense.voucher_no}-PARTY`
              : null,

          journal_group_no:
            null,

          entry_date:
            expense.expense_date
              ? new Date(
                  expense.expense_date
                )
              : now,

          entry_type:
            "expense",

          warehouse_id:
            expense.warehouse_id ??
            null,

          company_id:
            partyCompanyId,

          company_account_id:
            expense.company_account_id ??
            null,

          description:
            baseDescription,

          amount:
            totalAmount,

          payment_method:
            "Cash",

          reference_no:
            expense.voucher_no ||
            null,

          narration:
            expense.narration ||
            null,

          created_by:
            req.user?.id ??
            null,

          employee_id:
            null,

          fund_source:
            "party_cash",

          status:
            "pending",

          source_expense_id:
            expenseId,

          linked_entry_id:
            null,

          created_at:
            now,

          updated_at:
            now,
        };

        await collection(
          "cashentries"
        ).insertOne(
          partyCashDoc
        );

        createdCashEntries.push(
          partyCashDoc
        );
      }

      if (
        !createdCashEntries.length
      ) {
        await collection(
          "expenses"
        ).updateOne(
          {
            _id:
              expense._id,
          },
          {
            $set: {
              status:
                expense.status ||
                "PENDING",

              updated_at:
                new Date(),
            },
          }
        );

        return res.status(400).json({
          error:
            "Employee or party is required to move expense to Cash Book",
        });
      }

      const employeeCash =
        createdCashEntries.find(
          (entry) =>
            entry.fund_source ===
            "employee_cash"
        );

      const partyCash =
        createdCashEntries.find(
          (entry) =>
            entry.fund_source ===
            "party_cash"
        );

      return res.json({
        approved:
          true,

        expense_id:
          expenseResponseId(
            expense
          ),

        cash_entry_id:
          employeeCash?.id ||
          partyCash?.id ||
          null,

        employee_cash_entry_id:
          employeeCash?.id ||
          null,

        party_cash_entry_id:
          partyCash?.id ||
          null,

        inward_posted:
          false,

        inward_id:
          null,

        inward_voucher_no:
          null,

        outward_posted:
          false,

        outward_id:
          null,

        outward_voucher_no:
          null,

        palti_posted:
          false,

        message:
          "Expense approved and moved to Employee/Party Cash Book pending list",
      });
    } catch (err) {
      console.error(
        "Mongo approve-cash-book failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

async function nextCashEntryId() {
  const last =
    await collection(
      "cashentries"
    )
      .find(
        {},
        {
          projection: {
            id: 1,
          },
        }
      )
      .sort({
        id:
          -1,
        _id:
          -1,
      })
      .limit(1)
      .next();

  return (
    numberValue(
      last?.id
    ) + 1
  );
}

/*
====================================================
ROUTE: CREATE EXPENSE
====================================================
*/

router.post(
  "/",
  async (req, res) => {
    try {
      if (
        !userHasPermission(
          req.user,
          "expense.create"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to create expenses",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const {
        expense_date,
        location_id,
        employee_id,
        product_id,
        company_id,
        company_account_id,
        reg_from_company_id,
        send_to_company_id,
        reg_from_consignee_id,
        send_to_party_id,
        send_to_kind,
        send_to_ref_id,
        work_description,
        reg_lorry_no,
        loading,
        unloading,
        shortage,
        excess,
        shortage_excess,
        net_weight,
        new_lorry_no,
        new_weight,
        challan_weight,
        mb_no,
        paid_by,
        paid_by_mobile,
        status,
        receive_cash_from_party,
        receive_cash_from_driver,
        grand_total,
        total_expense_amount,
        narration,
        items,
      } =
        req.body || {};

      const normalizedWorkDescription =
        normalizeWorkDescription(
          work_description
        );

      if (
        !normalizedWorkDescription
      ) {
        return res.status(400).json({
          error:
            "Work Description is required",
        });
      }

      const sendKindRaw =
        text(
          send_to_kind
        ) ||
        null;

      if (
        sendKindRaw &&
        ![
          "consignee",
          "company",
          "warehouse",
          "palti_lorry",
        ].includes(
          sendKindRaw
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid Send To - pick consignee, company, warehouse, or palti lorry",
        });
      }

      const resolvedIds =
        await resolveExpenseMasterIds({
          location_id,
          employee_id,
          product_id,
          company_id,
          company_account_id,
          reg_from_company_id,
          send_to_kind:
            sendKindRaw,
          send_to_ref_id,
        });

      if (
        shouldRestrictToOwnEmployee(
          req.user
        ) &&
        !resolvedIds.employee_id
      ) {
        const employee =
          await resolveCurrentEmployee(
            req.user
          );

        if (employee) {
          resolvedIds.employee_id =
            String(
              employee._id
            );
        }
      }

      if (
        !expense_date ||
        !resolvedIds.location_id
      ) {
        return res.status(400).json({
          error:
            "Expense date and location are required",
        });
      }

      let sendRef =
        null;

      if (
        sendKindRaw
      ) {
        sendRef =
          sendKindRaw ===
          "palti_lorry"
            ? null
            : resolvedIds.send_to_ref_id;

        if (
          sendKindRaw !==
            "palti_lorry" &&
          !sendRef
        ) {
          return res.status(400).json({
            error:
              "Invalid Send To - pick consignee, company, warehouse, or palti lorry",
          });
        }
      }

      const safeItems =
        sanitizeExpenseItems(
          items
        );

      if (
        safeItems.length >
          0 &&
        !hasAnyNonZeroItemInput(
          safeItems
        ) &&
        numberValue(
          grand_total
        ) >
          0
      ) {
        return res.status(400).json({
          error:
            "Expense Particulars are empty. Please enter Bags/Rate details before saving.",
        });
      }

      const resolvedWarehouseId =
        await resolveWarehouseForLocation(
          req.user,
          resolvedIds.location_id
        );

      const computedBalance =
        calculateExpenseBalance(
          loading,
          unloading,
          shortage,
          excess
        );

      const {
        id:
          nextId,

        voucher_no:
          voucherNo,
      } =
        await nextExpenseVoucher();

      const now =
        new Date();

      const expenseDoc = {
        id:
          nextId,

        legacy_id:
          nextId,

        expense_date:
          expense_date,

        date:
          expense_date
            ? new Date(
                expense_date
              )
            : now,

        voucher_no:
          voucherNo,

        location_id:
          resolvedIds.location_id,

        employee_id:
          resolvedIds.employee_id,

        product_id:
          resolvedIds.product_id,

        company_id:
          resolvedIds.company_id,

        company_account_id:
          resolvedIds.company_account_id,

        warehouse_id:
          resolvedWarehouseId,

        reg_from_company_id:
          resolvedIds.reg_from_company_id,

        send_to_company_id:
          sendKindRaw
            ? null
            : (
                send_to_company_id ??
                null
              ),

        reg_from_consignee_id:
          reg_from_consignee_id ??
          null,

        send_to_party_id:
          sendKindRaw
            ? null
            : (
                send_to_party_id ??
                null
              ),

        send_to_kind:
          sendKindRaw,

        send_to_ref_id:
          sendRef,

        work_description:
          normalizedWorkDescription,

        reg_lorry_no:
          text(
            reg_lorry_no
          ),

        loading:
          numberValue(
            loading
          ),

        unloading:
          numberValue(
            unloading
          ),

        shortage:
          numberValue(
            shortage
          ),

        excess:
          numberValue(
            excess
          ),

        shortage_excess:
          numberValue(
            shortage_excess
          ),

        balance:
          computedBalance,

        net_weight:
          numberValue(
            net_weight
          ),

        new_lorry_no:
          text(
            new_lorry_no
          ),

        new_weight:
          numberValue(
            new_weight
          ),

        challan_weight:
          numberValue(
            challan_weight
          ),

        mb_no:
          text(
            mb_no
          ),

        paid_by:
          text(
            paid_by
          ),

        paid_by_mobile:
          text(
            paid_by_mobile
          ),

        status:
          text(
            status
          ) ||
          "PENDING",

        receive_cash_from_party:
          numberValue(
            receive_cash_from_party
          ),

        receive_cash_from_driver:
          numberValue(
            receive_cash_from_driver
          ),

        grand_total:
          numberValue(
            grand_total
          ),

        total_expense_amount:
          numberValue(
            total_expense_amount
          ),

        narration:
          text(
            narration
          ),

        posted_to_inward:
          0,

        posted_to_outward:
          0,

        posted_to_palti:
          0,

        items:
          safeItems,

        created_at:
          now,

        updated_at:
          now,
      };

      const insertResult =
        await collection(
          "expenses"
        ).insertOne(
          expenseDoc
        );

      /*
       * Store items in expenseitems as well.
       * This keeps compatibility with the existing
       * Mongo collection already present in Atlas.
       */
      if (
        safeItems.length
      ) {
        await replaceExpenseItems(
          {
            ...expenseDoc,

            _id:
              insertResult.insertedId,
          },
          safeItems
        );
      }

      return res.json({
        id:
          nextId,

        _id:
          String(
            insertResult.insertedId
          ),

        voucher_no:
          voucherNo,

        saved_from:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Mongo expense create failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

/*
====================================================
ROUTE: UPDATE EXPENSE
====================================================
*/

router.put(
  "/:id",
  async (req, res) => {
    try {
      if (
        !userHasPermission(
          req.user,
          "expense.edit"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to edit expenses",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const expense =
        await findExpense(
          req.params.id
        );

      if (!expense) {
        return res.status(404).json({
          error:
            "Expense not found",
        });
      }

      if (
        !(
          await canAccessExpenseWarehouse(
            req.user,
            expense.warehouse_id,
            expense.location_id
          )
        )
      ) {
        return res.status(403).json({
          error:
            "You cannot edit expenses for this warehouse",
        });
      }

      const {
        expense_date,
        location_id,
        employee_id,
        product_id,
        company_id,
        company_account_id,
        reg_from_company_id,
        send_to_company_id,
        reg_from_consignee_id,
        send_to_party_id,
        send_to_kind,
        send_to_ref_id,
        work_description,
        reg_lorry_no,
        loading,
        unloading,
        shortage,
        excess,
        shortage_excess,
        net_weight,
        new_lorry_no,
        new_weight,
        challan_weight,
        mb_no,
        paid_by,
        paid_by_mobile,
        status,
        receive_cash_from_party,
        receive_cash_from_driver,
        grand_total,
        total_expense_amount,
        narration,
        items,
      } =
        req.body || {};

      const normalizedWorkDescription =
        normalizeWorkDescription(
          work_description
        );

      if (
        !normalizedWorkDescription
      ) {
        return res.status(400).json({
          error:
            "Work Description is required",
        });
      }

      const sendKindRaw =
        text(
          send_to_kind
        ) ||
        null;

      if (
        sendKindRaw &&
        ![
          "consignee",
          "company",
          "warehouse",
          "palti_lorry",
        ].includes(
          sendKindRaw
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid Send To - pick consignee, company, warehouse, or palti lorry",
        });
      }

      const resolvedIds =
        await resolveExpenseMasterIds({
          location_id,
          employee_id,
          product_id,
          company_id,
          company_account_id,
          reg_from_company_id,
          send_to_kind:
            sendKindRaw,
          send_to_ref_id,
        });

      if (
        shouldRestrictToOwnEmployee(
          req.user
        ) &&
        !resolvedIds.employee_id
      ) {
        resolvedIds.employee_id =
          expense.employee_id ??
          (
            await resolveCurrentEmployee(
              req.user
            )
          )?._id ??
          null;
      }

      if (
        !expense_date ||
        !resolvedIds.location_id
      ) {
        return res.status(400).json({
          error:
            "Expense date and location are required",
        });
      }

      let sendRef =
        null;

      if (
        sendKindRaw
      ) {
        sendRef =
          sendKindRaw ===
          "palti_lorry"
            ? null
            : resolvedIds.send_to_ref_id;

        if (
          sendKindRaw !==
            "palti_lorry" &&
          !sendRef
        ) {
          return res.status(400).json({
            error:
              "Invalid Send To - pick consignee, company, warehouse, or palti lorry",
          });
        }
      }

      const hasItemsPayload =
        Array.isArray(
          items
        );

      let safeItems =
        hasItemsPayload
          ? sanitizeExpenseItems(
              items
            )
          : null;

      let preservedDefaultItems =
        false;

      let grandTotalForUpdate =
        numberValue(
          grand_total
        );

      let totalExpenseAmountForUpdate =
        numberValue(
          total_expense_amount
        );

      if (
        hasItemsPayload &&
        safeItems.length >
          0 &&
        !hasAnyNonZeroItemInput(
          safeItems
        ) &&
        !isDefaultEmptyExpenseItemsPayload(
          safeItems
        ) &&
        numberValue(
          grand_total
        ) >
          0
      ) {
        return res.status(400).json({
          error:
            "Expense Particulars are empty. Please enter Bags/Rate details before saving.",
        });
      }

      if (
        hasItemsPayload &&
        isDefaultEmptyExpenseItemsPayload(
          safeItems
        )
      ) {
        const hasSavedItems =
          await hasSavedNonZeroExpenseItems(
            expense
          );

        if (
          hasSavedItems
        ) {
          safeItems =
            null;

          preservedDefaultItems =
            true;

          grandTotalForUpdate =
            numberValue(
              expense.grand_total
            );

          totalExpenseAmountForUpdate =
            numberValue(
              expense.total_expense_amount
            );
        }
      }

      const resolvedWarehouseId =
        await resolveWarehouseForLocation(
          req.user,
          resolvedIds.location_id
        );

      const computedBalance =
        calculateExpenseBalance(
          loading,
          unloading,
          shortage,
          excess
        );

      const updateDoc = {
        expense_date:
          expense_date,

        date:
          expense_date
            ? new Date(
                expense_date
              )
            : expense.date,

        location_id:
          resolvedIds.location_id,

        warehouse_id:
          resolvedWarehouseId,

        employee_id:
          resolvedIds.employee_id,

        product_id:
          resolvedIds.product_id,

        company_id:
          resolvedIds.company_id,

        company_account_id:
          resolvedIds.company_account_id,

        reg_from_company_id:
          resolvedIds.reg_from_company_id,

        send_to_company_id:
          sendKindRaw
            ? null
            : (
                send_to_company_id ??
                null
              ),

        reg_from_consignee_id:
          reg_from_consignee_id ??
          null,

        send_to_party_id:
          sendKindRaw
            ? null
            : (
                send_to_party_id ??
                null
              ),

        send_to_kind:
          sendKindRaw,

        send_to_ref_id:
          sendRef,

        work_description:
          normalizedWorkDescription,

        reg_lorry_no:
          text(
            reg_lorry_no
          ),

        loading:
          numberValue(
            loading
          ),

        unloading:
          numberValue(
            unloading
          ),

        shortage:
          numberValue(
            shortage
          ),

        excess:
          numberValue(
            excess
          ),

        shortage_excess:
          numberValue(
            shortage_excess
          ),

        balance:
          computedBalance,

        net_weight:
          numberValue(
            net_weight
          ),

        new_lorry_no:
          text(
            new_lorry_no
          ),

        new_weight:
          numberValue(
            new_weight
          ),

        challan_weight:
          numberValue(
            challan_weight
          ),

        mb_no:
          text(
            mb_no
          ),

        paid_by:
          text(
            paid_by
          ),

        paid_by_mobile:
          text(
            paid_by_mobile
          ),

        status:
          text(
            status
          ) ||
          "PENDING",

        receive_cash_from_party:
          numberValue(
            receive_cash_from_party
          ),

        receive_cash_from_driver:
          numberValue(
            receive_cash_from_driver
          ),

        grand_total:
          grandTotalForUpdate,

        total_expense_amount:
          totalExpenseAmountForUpdate,

        narration:
          text(
            narration
          ),

        updated_at:
          new Date(),
      };

      await collection(
        "expenses"
      ).updateOne(
        {
          _id:
            expense._id,
        },
        {
          $set:
            updateDoc,
        }
      );

      if (
        hasItemsPayload &&
        safeItems !==
          null
      ) {
        await replaceExpenseItems(
          expense,
          safeItems
        );

        await collection(
          "expenses"
        ).updateOne(
          {
            _id:
              expense._id,
          },
          {
            $set: {
              items:
                safeItems,
            },
          }
        );
      }

      return res.json({
        updated:
          true,

        items_preserved:
          preservedDefaultItems,

        saved_from:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Mongo expense update failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

/*
====================================================
ROUTE: DELETE EXPENSE
====================================================
*/

router.delete(
  "/:id",
  async (req, res) => {
    try {
      if (
        !userHasPermission(
          req.user,
          "expense.delete"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to delete expenses",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const expense =
        await findExpense(
          req.params.id
        );

      if (!expense) {
        return res.status(404).json({
          error:
            "Expense not found",
        });
      }

      if (
        !(
          await canAccessExpenseWarehouse(
            req.user,
            expense.warehouse_id,
            expense.location_id
          )
        )
      ) {
        return res.status(403).json({
          error:
            "You cannot delete expenses for this warehouse",
        });
      }

      const expenseId =
        expense.id ??
        expense.legacy_id ??
        String(
          expense._id
        );

      /*
       * Remove cash-entry adjustments
       * linked to this expense's cash entries.
       */
      const cashEntries =
        await collection(
          "cashentries"
        )
          .find({
            $or: [
              {
                source_expense_id:
                  expenseId,
              },

              {
                source_expense_id:
                  Number(
                    expenseId
                  ),
              },

              {
                source_expense_id:
                  String(
                    expenseId
                  ),
              },
            ],
          })
          .toArray();

      if (
        cashEntries.length
      ) {
        const cashIds =
          cashEntries
            .map(
              (entry) =>
                entry.id ??
                entry.legacy_id ??
                entry._id
            )
            .filter(
              Boolean
            );

        if (
          cashIds.length
        ) {
          await collection(
            "cashentryadjustments"
          ).deleteMany({
            $or: cashIds.map(
              (id) => ({
                $or: [
                  {
                    source_entry_id:
                      id,
                  },

                  {
                    target_entry_id:
                      id,
                  },
                ],
              })
            ),
          });
        }

        await collection(
          "cashentries"
        ).deleteMany({
          $or: cashEntries.map(
            (entry) => ({
              _id:
                entry._id,
            })
          ),
        });
      }

      /*
       * Delete expense items.
       */
      const items =
        await loadExpenseItems(
          expense
        );

      if (
        items.length
      ) {
        await collection(
          "expenseitems"
        ).deleteMany({
          $or: items.map(
            (item) => ({
              _id:
                item._id,
            })
          ),
        });
      }

      const result =
        await collection(
          "expenses"
        ).deleteOne({
          _id:
            expense._id,
        });

      return res.json({
        deleted:
          result.deletedCount >
          0,

        saved_from:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Mongo expense delete failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

/*
====================================================
ROUTE: POST PALTI LORRY
====================================================
*/

router.post(
  "/:id/post-palti-lorry",
  async (req, res) => {
    try {
      if (
        !userHasPermission(
          req.user,
          "expense.edit"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to post to Palti Lorry",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const expense =
        await findExpense(
          req.params.id
        );

      if (!expense) {
        return res.status(404).json({
          error:
            "Expense not found",
        });
      }

      if (
        !(
          await canAccessExpenseWarehouse(
            req.user,
            expense.warehouse_id,
            expense.location_id
          )
        )
      ) {
        return res.status(403).json({
          error:
            "You cannot post this warehouse expense",
        });
      }

      const result =
        await postExpenseToPaltiLorry(
          expense,
          req.user?.id ??
            null
        );

      if (
        result.already_posted
      ) {
        return res.status(400).json({
          error:
            "This expense is already posted to Palti Lorry",
        });
      }

      return res.json({
        posted:
          true,

        palti_id:
          result.palti_id ||
          null,

        message:
          "Expense posted to Palti Lorry",
      });
    } catch (err) {
      console.error(
        "Mongo post-palti-lorry failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

/*
====================================================
AUTO POST HELPERS
====================================================
*/

function shouldPostExpenseToInward(
  expense
) {
  return (
    String(
      expense?.work_description ||
        ""
    ).trim() ===
    "Warehouse Inward"
  );
}

function shouldPostExpenseToOutward(
  expense
) {
  const work =
    String(
      expense?.work_description ||
        ""
    ).trim();

  return (
    work ===
      "Warehouse Outward" ||
    work ===
      "Self Loading"
  );
}

function shouldPostExpenseToPaltiLorry(
  expense
) {
  const workDescription =
    String(
      expense?.work_description ||
        ""
    )
      .trim()
      .toLowerCase();

  return (
    expense?.send_to_kind ===
      "palti_lorry" ||
    workDescription ===
      "palti lorry"
  );
}

/*
====================================================
EXPORT
====================================================
*/

module.exports =
  router;
