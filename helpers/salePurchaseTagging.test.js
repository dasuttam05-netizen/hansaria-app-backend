import { buildSalePurchaseTag, filterAvailablePurchaseTags } from "./salePurchaseTagging";

test("builds direct-sale purchase tag metadata with purchase date and party details", () => {
  const tag = buildSalePurchaseTag({
    _id: "p-100",
    id: "p-100",
    voucher_no: "PI-105",
    date: "2026-09-08",
    farmer_id: "farmer-7",
    farmer_name: "Rahim Mia",
    lorry_no: "WB-12-4567",
    total_qty: 18.5,
    quantity: 18.5,
    consignee_name: "Hossain Traders",
    rate: 1850,
    amount: 34225,
  }, "farmer-7");

  expect(tag).toMatchObject({
    purchase_id: "p-100",
    voucher_no: "PI-105",
    farmer_id: "farmer-7",
    farmer_name: "Rahim Mia",
    date: "2026-09-08",
    lorry_no: "WB-12-4567",
    weight: 18.5,
    consignee_name: "Hossain Traders",
    rate: 1850,
    amount: 34225,
  });
});

test("filters out purchase bills already linked to the sale", () => {
  const rows = [
    { _id: "1", voucher_no: "PI-001", date: "2026-09-01" },
    { _id: "2", voucher_no: "PI-002", date: "2026-09-02" },
    { _id: "3", voucher_no: "PI-003", date: "2026-09-03" },
  ];

  const linked = [
    { purchase_id: "2" },
    { purchase_id: "3" },
  ];

  expect(filterAvailablePurchaseTags(rows, linked).map((row) => row._id)).toEqual(["1"]);
});
