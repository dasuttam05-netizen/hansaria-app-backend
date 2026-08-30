const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const {
  Product,
  isMongoMirrorReady,
} = require("../db-mongodb");

const {
  userHasPermission,
} = require("../middleware/auth");

function canReadProducts(user) {
  return [
    "products.view",
    "products.manage",
    "inward.view",
    "inward.create",
    "outward.view",
    "outward.create",
    "adjustment.manage",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
    "transport.manage",
    "report.inward",
    "report.erp",
    "report.partyLedger",
    "report.partyStock",
  ].some((permission) =>
    userHasPermission(user, permission)
  );
}

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

function normalizeId(id) {
  const value = String(id || "").trim();

  if (!value) {
    return null;
  }

  if (!mongoose.Types.ObjectId.isValid(value)) {
    return null;
  }

  return value;
}

function escapeRegex(value) {
  return String(value || "").replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

/*
====================================================
GET ALL PRODUCTS
====================================================
*/

router.get("/", async (req, res) => {
  try {
    if (!canReadProducts(req.user)) {
      return res.status(403).json({
        error:
          "You do not have permission to view products",
      });
    }

    if (!requireMongo(res)) {
      return;
    }

    const rows = await Product.find({})
      .sort({
        created_at: -1,
        _id: -1,
      })
      .lean();

    return res.json(
      rows.map((row) => ({
        ...row,

        id: row?._id
          ? String(row._id)
          : row?.id,

        name: row?.name || "",

        hsn_code:
          row?.hsn_code || "",
      }))
    );
  } catch (err) {
    console.error(
      "Error fetching products:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

/*
====================================================
CREATE PRODUCT
====================================================
*/

router.post("/", async (req, res) => {
  try {
    if (
      !userHasPermission(
        req.user,
        "products.create"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to create products",
      });
    }

    if (!requireMongo(res)) {
      return;
    }

    const name = String(
      req.body?.name || ""
    ).trim();

    const hsn_code = String(
      req.body?.hsn_code || ""
    ).trim();

    if (!name) {
      return res.status(400).json({
        error:
          "Product name is required",
      });
    }

    const duplicate = await Product.findOne({
      name: {
        $regex:
          `^${escapeRegex(name)}$`,
        $options: "i",
      },
    }).lean();

    if (duplicate) {
      return res.status(409).json({
        error:
          "Product already exists",
      });
    }

    const product = await Product.create({
      name,
      hsn_code,
      created_at: new Date(),
      updated_at: new Date(),
    });

    return res.status(201).json({
      ...product.toObject(),

      id: String(product._id),
    });
  } catch (err) {
    console.error(
      "Error creating product:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

/*
====================================================
UPDATE PRODUCT
====================================================
*/

router.put("/:id", async (req, res) => {
  try {
    if (
      !userHasPermission(
        req.user,
        "products.edit"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to edit products",
      });
    }

    if (!requireMongo(res)) {
      return;
    }

    const productId = normalizeId(
      req.params.id
    );

    if (!productId) {
      return res.status(400).json({
        error:
          "Invalid product ID",
      });
    }

    const name = String(
      req.body?.name || ""
    ).trim();

    const hsn_code = String(
      req.body?.hsn_code || ""
    ).trim();

    if (!name) {
      return res.status(400).json({
        error:
          "Product name is required",
      });
    }

    const existing = await Product.findById(
      productId
    );

    if (!existing) {
      return res.status(404).json({
        error:
          "Product not found",
      });
    }

    const duplicate = await Product.findOne({
      _id: {
        $ne: productId,
      },

      name: {
        $regex:
          `^${escapeRegex(name)}$`,
        $options: "i",
      },
    }).lean();

    if (duplicate) {
      return res.status(409).json({
        error:
          "Another product with the same name already exists",
      });
    }

    existing.name = name;
    existing.hsn_code = hsn_code;
    existing.updated_at = new Date();

    await existing.save();

    return res.json({
      ...existing.toObject(),

      id: String(existing._id),
    });
  } catch (err) {
    console.error(
      "Error updating product:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

/*
====================================================
DELETE PRODUCT
====================================================
*/

router.delete(
  "/:id",
  async (req, res) => {
    try {
      if (
        !userHasPermission(
          req.user,
          "products.delete"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to delete products",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const productId = normalizeId(
        req.params.id
      );

      if (!productId) {
        return res.status(400).json({
          error:
            "Invalid product ID",
        });
      }

      const deleted =
        await Product.findByIdAndDelete(
          productId
        ).lean();

      if (!deleted) {
        return res.status(404).json({
          error:
            "Product not found",
        });
      }

      return res.json({
        deleted: 1,

        deletedID:
          String(productId),

        source:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Error deleting product:",
        err
      );

      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

module.exports = router;
