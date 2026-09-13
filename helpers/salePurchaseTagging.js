export function buildSalePurchaseTag(purchase, fallbackFarmerId = "") {
  const purchaseId = String(purchase?._id || purchase?.id || "").trim();
  const farmerId = String(purchase?.farmer_id || fallbackFarmerId || "").trim();
  const quantity = Number(purchase?.total_qty ?? purchase?.quantity ?? purchase?.net_weight ?? purchase?.weight ?? 0) || 0;
  const rate = Number(purchase?.rate ?? 0) || 0;
  const amount = Number(purchase?.amount ?? purchase?.net_amount_payable ?? quantity * rate ?? 0) || 0;

  return {
    purchase_id: purchaseId,
    voucher_no: String(purchase?.voucher_no || purchase?.bill_no || "").trim(),
    farmer_id: farmerId,
    farmer_name: String(purchase?.farmer_name || purchase?.farmer || "").trim(),
    date: String(purchase?.date || "").trim(),
    lorry_no: String(purchase?.lorry_no || purchase?.transport_lorry_no || purchase?.vehicle_no || "").trim(),
    weight: Number.isFinite(quantity) ? quantity : 0,
    consignee_name: String(purchase?.consignee_name || purchase?.consignee || "").trim(),
    rate,
    amount,
    quantity,
  };
}

export function filterAvailablePurchaseTags(rows = [], linkedTags = []) {
  const linkedIds = new Set(
    (Array.isArray(linkedTags) ? linkedTags : [])
      .map((item) => String(item?.purchase_id || "").trim())
      .filter(Boolean)
  );

  return (Array.isArray(rows) ? rows : []).filter((row) => !linkedIds.has(String(row?._id || row?.id || "").trim()));
}
