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
    purchase_total_qty: quantity,
    claim_amount: Number(purchase?.claim_amount ?? purchase?.bags_claim ?? 0) || 0,
    bags_claim: Number(purchase?.bags_claim ?? purchase?.claim_amount ?? 0) || 0,
    shortage_amount: Number(purchase?.shortage_amount ?? 0) || 0,
    shortage_qty: Number(purchase?.shortage_qty ?? 0) || 0,
    moisture: Number(purchase?.moisture ?? 0) || 0,
    dunki: Number(purchase?.dunki ?? 0) || 0,
    fungus: Number(purchase?.fungus ?? 0) || 0,
    discolour: Number(purchase?.discolour ?? 0) || 0,
    less_bags_weight: Number(purchase?.less_bags_weight ?? 0) || 0,
    other_deduction: Number(purchase?.other_deduction ?? purchase?.others ?? 0) || 0,
    others: Number(purchase?.others ?? purchase?.other_deduction ?? 0) || 0,
    labour: Number(purchase?.labour ?? 0) || 0,
    transport_charge: Number(purchase?.transport_charge ?? 0) || 0,
    cd_amount: Number(purchase?.cd_amount ?? 0) || 0,
    adjustment_amount: Number(purchase?.adjustment_amount ?? 0) || 0,
    tds_amount: Number(purchase?.tds_amount ?? 0) || 0,
    round_off: Number(purchase?.round_off ?? 0) || 0,
    total_deduction: Number(purchase?.total_deduction ?? purchase?.total_deduct_amount ?? 0) || 0,
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
