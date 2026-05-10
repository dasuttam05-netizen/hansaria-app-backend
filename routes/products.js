const express = require("express");
const router = express.Router();

const { Product } = require("../mongo");

const {
  userHasPermission,
  isAdminUser,
} = require("../middleware/auth");

function canReadProducts(user) {
  return [
    "products.manage",
    "inward.view",
    "inward.create",
    "outward.view",
    "outward.create",
    "adjustment.manage",
    "expense.entry",
    "expense.view",
    "expense.create",
    "transport.manage",
    "report.inward",
    "report.erp",
    "report.partyLedger",
    "report.partyStock",
  ].some((permission) =>
    userHasPermission(user, permission)
  );
}

router.get("/", async (req, res) => {
  try {

    if (!canReadProducts(req.user)) {
      return res.status(403).json({
        error:
          "You do not have permission to view products",
      });
    }

    const rows = await Product.find().sort({
      created_at: -1,
    });

    res.json(rows);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message,
    });
  }
});

router.post("/", async (req, res) => {
  try {

    if (!isAdminUser(req.user)) {
      return res.status(403).json({
        error:
          "Only admin can edit product master",
      });
    }

    const { name, hsn_code } = req.body;

    if (!name) {
      return res.status(400).json({
        error: "Product name is required",
      });
    }

    const product = await Product.create({
      name,
      hsn_code,
    });

    res.json(product);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message,
    });
  }
});

router.put("/:id", async (req, res) => {
  try {

    if (!isAdminUser(req.user)) {
      return res.status(403).json({
        error:
          "Only admin can edit product master",
      });
    }

    const { name, hsn_code } = req.body;

    const updated = await Product.findByIdAndUpdate(
      req.params.id,
      {
        name,
        hsn_code,
      },
      {
        new: true,
      }
    );

    if (!updated) {
      return res.status(404).json({
        error: "Product not found",
      });
    }

    res.json(updated);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message,
    });
  }
});

router.delete("/:id", async (req, res) => {
  try {

    if (!isAdminUser(req.user)) {
      return res.status(403).json({
        error:
          "Only admin can edit product master",
      });
    }

    const deleted = await Product.findByIdAndDelete(
      req.params.id
    );

    if (!deleted) {
      return res.status(404).json({
        error: "Product not found",
      });
    }

    res.json({
      deletedID: req.params.id,
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message,
    });
  }
});

module.exports = router;
