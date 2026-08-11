import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import axios from "axios";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FaFilePdf, FaWhatsapp } from "react-icons/fa";
import PageBackCloseActions from "../components/PageBackCloseActions";
import WarehouseTradingHeader from "./WarehouseTradingHeader";
import WarehouseVoucherPanel from "./WarehouseVoucherPanel";
import WarehouseReportPanel from "./WarehouseReportPanel";
import WarehouseReportTable from "./WarehouseReportTable";
import WarehouseBillWisePanel from "./WarehouseBillWisePanel";
import WarehouseAdjustModal from "./WarehouseAdjustModal";
import WarehouseSaleDeductionModal from "./WarehouseSaleDeductionModal";
import WarehouseSalePreviewModal from "./WarehouseSalePreviewModal";
import WarehousePurchasePreviewModal from "./WarehousePurchasePreviewModal";
import WarehouseVoucherTable from "./WarehouseVoucherTable";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { hasPermission, loadSession } from "../utils/auth";
import { consigneeHasBuyer, getConsigneeBuyerIds } from "../utils/consigneeBuyers";

const defaultForm = () => ({
  voucher_no: "",
  bill_no: "",
  date: new Date().toISOString().slice(0, 10),
  payment_mode: "on_account",
  bill_date: new Date().toISOString().slice(0, 10),
  unloading_date: "",
  due_days: "",
  add_qty: "",
  sale_type: "direct",
  warehouse_id: "",
  buyer_id: "",
  farmer_id: "",
  company_id: "",
  company_account_id: "",
  consignee_id: "",
  product_id: "",
  po_no: "",
  due_date: "",
  direct_purchase_rate: "",
  direct_purchase_amount: "",
  against_purchase_enabled: false,
  against_purchase_farmer_id: "",
  reference_type: "",
  reference_id: "",
  lorry_no: "",
  employee_id: "",
  location_id: "",
  quantity: "",
  shortage_quantity: "",
  unloading_qty: "",
  rate: "",
  amount: "",
  claim_amount: "",
  other_deduction: "",
  cd_percent: "",
  cd_amount: "",
  adjustment_amount: "",
  tds_amount: "",
  net_amount: "",
  net_receivable_amount: "",
  fifo_rate: "",
  fifo_amount: "",
  packet: "",
  gross_weight: "",
  tare_weight: "",
  dhalta: "",
  less_bags_weight: "",
  moisture: "",
  dunki: "",
  fungus: "",
  discolour: "",
  others: "",
  transport_charge: "",
  net_weight: "",
  bags_claim: "",
  labour: "",
  total_deduct_amount: "",
  total_qty: "",
  total_deduction: "",
  net_amount_payable: "",
  round_off: "",
  debit_account: "",
  credit_account: "",
  description: "",
  journey_note: "",
  journey_token: "",
  reject_qty: "",
});

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizePaymentMode = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (["advance", "advance_payment"].includes(normalized)) return "advance";
  if (["new_reference", "new reference", "newref", "new-ref", "reference"].includes(normalized)) return "new_reference";
  if (["against", "against_purchase", "purchase", "bill", "billwise"].includes(normalized)) return "against";
  if (["on_account", "on-account", "account"].includes(normalized)) return "on_account";
  return "on_account";
};

const getPaymentReferenceType = (mode) => {
  switch (mode) {
    case "advance":
      return "advance";
    case "new_reference":
      return "new_reference";
    case "against":
      return "purchase";
    default:
      return "on_account";
  }
};

const inferPaymentMode = (voucher) => {
  const explicitMode = String(voucher?.payment_mode || voucher?.mode || voucher?.reference_type || "").trim().toLowerCase();
  if (["advance", "advance_payment"].includes(explicitMode)) return "advance";
  if (["new_reference", "new reference", "newref", "new-ref", "reference"].includes(explicitMode)) return "new_reference";
  if (["against", "against_purchase", "purchase", "bill", "billwise"].includes(explicitMode)) return "against";
  if (Array.isArray(voucher?.adjustments) && voucher.adjustments.length > 0) return "against";
  return "on_account";
};

const getRecordId = (value) => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return String(value._id || value.id || value.purchase_id || "").trim();
};
const formatDecimal4 = (value) => toNumber(value).toFixed(4);
const formatMoney = (value) => toNumber(value).toFixed(2);
const titleCase = (value) =>
  String(value || "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
const formatLedgerDate = (value) => {
  const raw = String(value || "").trim();
  const datePart = raw.includes("T") ? raw.split("T")[0] : raw;
  const match = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  return raw || "-";
};

const buildJourneyToken = () => {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `JNY-${stamp}-${rand}`;
};

const diffDays = (start, end) => {
  const s = String(start || "").trim();
  const e = String(end || "").trim();
  if (!s || !e) return 0;
  const startDate = new Date(`${(s.includes("T") ? s.split("T")[0] : s)}T00:00:00Z`);
  const endDate = new Date(`${(e.includes("T") ? e.split("T")[0] : e)}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
  return Math.max(0, Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)));
};

const getArrowFocusableInputs = (root) =>
  Array.from(
    root.querySelectorAll("input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled])")
  ).filter((element) => {
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });

const buildLookupMap = (rows) => {
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const key = String(row?.id || row?._id || "").trim();
    if (key) map.set(key, row);
  });
  return map;
};

const PAGE_SIZE = 15;

const purchaseDeductionFields = [
  { key: "less_bags_weight", label: "Less Bags Weight" },
  { key: "moisture", label: "Moisture" },
  { key: "dunki", label: "Dunki" },
  { key: "fungus", label: "Fungus" },
  { key: "discolour", label: "Discolour" },
  { key: "others", label: "Others" },
];

const purchaseParticulars = [
  { key: "product_id", label: "Product Name", type: "product" },
  { key: "packet", label: "Packet" },
  { key: "gross_weight", label: "Gross Weight" },
  { key: "tare_weight", label: "Tear Weight" },
  { key: "dhalta", label: "Dhalta" },
  ...purchaseDeductionFields,
  { key: "net_weight", label: "Net Weight", readOnly: true },
];

const paymentModeOptions = [
  { value: "on_account", label: "On Account", description: "Post as a normal party account entry with no purchase bill adjustment." },
  { value: "advance", label: "Advance", description: "Record an advance payment without linking it to purchase bills." },
  { value: "new_reference", label: "New Reference", description: "Save a reference note for special-purpose payments." },
  { value: "against", label: "Against Purchase Bills", description: "Match the payment against outstanding purchase bills exactly." },
];

function formReducer(state, action) {
  if (typeof action === "function") {
    return action(state);
  }
  if (action && action.type === "merge") {
    return { ...state, ...action.payload };
  }
  if (action && action.type === "reset") {
    return defaultForm();
  }
  if (action && action.type === "replace") {
    return action.payload;
  }
  return state;
}

const reportUiInitialState = {
  reportPage: 1,
  reportFilters: {
    farmer_id: "",
    company_account_id: "",
    warehouse_id: "",
    sale_buyer_id: "",
    sale_company_account_id: "",
    sale_journey_token: "",
    sale_lorry_no: "",
    sale_bill_no: "",
    details_of_deduction: false,
  },
  saleFollowupFilter: "all",
  selectedLedgerBillId: "",
  selectedSaleLedgerBillId: "",
  showPurchaseBillWise: false,
  showSaleBillWise: false,
};

function reportUiReducer(state, action) {
  switch (action.type) {
    case "set_report_page":
      return { ...state, reportPage: action.value };
    case "set_report_filters":
      return { ...state, reportFilters: action.value };
    case "set_sale_followup_filter":
      return { ...state, saleFollowupFilter: action.value };
    case "set_selected_ledger_bill_id":
      return { ...state, selectedLedgerBillId: action.value };
    case "set_selected_sale_ledger_bill_id":
      return { ...state, selectedSaleLedgerBillId: action.value };
    case "set_show_purchase_bill_wise":
      return { ...state, showPurchaseBillWise: action.value };
    case "set_show_sale_bill_wise":
      return { ...state, showSaleBillWise: action.value };
    default:
      return state;
  }
}

export default function WarehouseTradingPage() {
  const { user } = loadSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState("vouchers");
  const [activeVoucherType, setActiveVoucherType] = useState("purchase");
  const [activeReport, setActiveReport] = useState("sale");

  const [warehouses, setWarehouses] = useState([]);
  const [farmers, setFarmers] = useState([]);
  const [accountFarmers, setAccountFarmers] = useState([]);
  const [paymentWarehouses, setPaymentWarehouses] = useState([]);
  const [buyerNames, setBuyerNames] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [companyAccounts, setCompanyAccounts] = useState([]);
  const [consignees, setConsignees] = useState([]);
  const [products, setProducts] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);

  const [formData, setFormDataDispatch] = useReducer(formReducer, defaultForm());
  const setFormData = (value) => {
    if (typeof value === "function") {
      setFormDataDispatch(value);
      return;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      setFormDataDispatch({ type: "merge", payload: value });
      return;
    }
    setFormDataDispatch({ type: "replace", payload: value });
  };
  const [editId, setEditId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState([]);
  const [reportData, setReportData] = useState([]);
  const [reportFilterOptions, setReportFilterOptions] = useState({ account_ids: [], warehouse_ids: [], farmer_ids: [], buyer_ids: [] });
  const [warehouseStockReport, setWarehouseStockReport] = useState([]);
  const [reportPageInfo, setReportPageInfo] = useState({ page: 1, pageSize: PAGE_SIZE, hasMore: false });
  const [availableSaleStock, setAvailableSaleStock] = useState(null);
  const [reportUiState, reportUiDispatch] = useReducer(reportUiReducer, reportUiInitialState);
  const {
    reportPage,
    reportFilters,
    saleFollowupFilter,
    selectedLedgerBillId,
    selectedSaleLedgerBillId,
    showPurchaseBillWise,
    showSaleBillWise,
  } = reportUiState;
  const setReportPage = (value) => reportUiDispatch({ type: "set_report_page", value: typeof value === "function" ? value(reportUiState.reportPage) : value });
  const setReportFilters = (value) => reportUiDispatch({ type: "set_report_filters", value: typeof value === "function" ? value(reportUiState.reportFilters) : value });
  const setSaleFollowupFilter = (value) => reportUiDispatch({ type: "set_sale_followup_filter", value: typeof value === "function" ? value(reportUiState.saleFollowupFilter) : value });
  const setSelectedLedgerBillId = (value) => reportUiDispatch({ type: "set_selected_ledger_bill_id", value });
  const updateReportFilter = (field, value) => {
    setReportFilters((prev) => {
      if (field === "company_account_id") {
        return {
          ...prev,
          company_account_id: value,
          warehouse_id: "",
          farmer_id: "",
        };
      }
      if (field === "warehouse_id") {
        return {
          ...prev,
          warehouse_id: value,
          farmer_id: "",
        };
      }
      return { ...prev, [field]: value };
    });
  };
  const setSelectedSaleLedgerBillId = (value) => reportUiDispatch({ type: "set_selected_sale_ledger_bill_id", value });
  const setShowPurchaseBillWise = (value) => reportUiDispatch({ type: "set_show_purchase_bill_wise", value });
  const setShowSaleBillWise = (value) => reportUiDispatch({ type: "set_show_sale_bill_wise", value });
  const [partyOutstanding, setPartyOutstanding] = useState(null);
  const [showPaymentAdjustPopup, setShowPaymentAdjustPopup] = useState(false);
  const [paymentAdjustments, setPaymentAdjustments] = useState([]);
  const [selectedPaymentId, setSelectedPaymentId] = useState(null);
  const [showReceiptAdjustPopup, setShowReceiptAdjustPopup] = useState(false);
  const [receiptAdjustments, setReceiptAdjustments] = useState([]);
  const [selectedReceiptId, setSelectedReceiptId] = useState(null);
  const [stockDrilldown, setStockDrilldown] = useState(null);
  const [stockDrilldownFromDate, setStockDrilldownFromDate] = useState("");
  const [stockDrilldownToDate, setStockDrilldownToDate] = useState("");
  const [importingPurchase, setImportingPurchase] = useState(false);
  const [importingPayment, setImportingPayment] = useState(false);
  const [importingReceipt, setImportingReceipt] = useState(false);
  const [voucherNumberLoading, setVoucherNumberLoading] = useState(false);
  const [showSaleDeductionModal, setShowSaleDeductionModal] = useState(false);
  const [saleBillSearch, setSaleBillSearch] = useState("");
  const [journeyTemplateId, setJourneyTemplateId] = useState("");
  const [showSaleAdjustedModal, setShowSaleAdjustedModal] = useState(false);
  const [salePurchaseRows, setSalePurchaseRows] = useState([]);
  const [salePurchaseLinks, setSalePurchaseLinks] = useState([]);
  const [showPurchasePreview, setShowPurchasePreview] = useState(false);
  const [purchasePreviewRow, setPurchasePreviewRow] = useState(null);
  const [purchasePreviewLoading, setPurchasePreviewLoading] = useState(false);
  const [purchasePreviewOpenedFromLedger, setPurchasePreviewOpenedFromLedger] = useState(false);
  const [purchaseBaseline, setPurchaseBaseline] = useState(null);
  const [showSalePreview, setShowSalePreview] = useState(false);
  const [salePreviewRow, setSalePreviewRow] = useState(null);
  const [salePreviewSummary, setSalePreviewSummary] = useState(null);
  const [salePreviewLoading, setSalePreviewLoading] = useState(false);
  const [saleTransportMode, setSaleTransportMode] = useState("auto");
  const [saleTransportManualAmount, setSaleTransportManualAmount] = useState("0.00");
  const [showMobileVoucherHeader, setShowMobileVoucherHeader] = useState(true);
  const [showMobileReportHeader, setShowMobileReportHeader] = useState(true);
  const [showMobileTradingTabs, setShowMobileTradingTabs] = useState(false);
  const [globalSearch, setGlobalSearch] = useState("");
  const [voucherPage, setVoucherPage] = useState(1);
  const [voucherSortAsc, setVoucherSortAsc] = useState(false);
  const [voucherPageInfo, setVoucherPageInfo] = useState({ page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 1, hasMore: false });
  const masterLoadTokenRef = useRef(0);
  const masterDataLoadedRef = useRef(false);
  const masterLoadPromiseRef = useRef(null);
  const reportFilterCacheRef = useRef(new Map());
  const reportFilterInFlightRef = useRef(new Map());
  const outstandingCacheRef = useRef(new Map());
  const outstandingInFlightRef = useRef(new Map());
  const paymentFarmersCacheRef = useRef(new Map());
  const paymentFarmersInFlightRef = useRef(new Map());
  const arrowNavRootRef = useRef(null);
  const voucherPanelRef = useRef(null);
  const reportPanelRef = useRef(null);
  const voucherLoadTokenRef = useRef(0);
  const reportLoadTokenRef = useRef(0);
  const warehouseById = useMemo(() => buildLookupMap(warehouses), [warehouses]);
  const farmerById = useMemo(() => buildLookupMap(farmers), [farmers]);
  const buyerById = useMemo(() => buildLookupMap(buyerNames), [buyerNames]);
  const companyById = useMemo(() => buildLookupMap(companies), [companies]);
  const companyAccountById = useMemo(() => buildLookupMap(companyAccounts), [companyAccounts]);
  const consigneeById = useMemo(() => buildLookupMap(consignees), [consignees]);
  const productById = useMemo(() => buildLookupMap(products), [products]);
  const employeeById = useMemo(() => buildLookupMap(employees), [employees]);
  const locationById = useMemo(() => buildLookupMap(locations), [locations]);
  const voucherById = useMemo(() => buildLookupMap(list), [list]);
  const selectedVoucher = voucherById.get(String(selectedPaymentId)) || null;
  const selectedReceiptVoucher = voucherById.get(String(selectedReceiptId)) || null;
  const selectedWarehouse = warehouseById.get(String(formData.warehouse_id)) || null;
  const selectedManualLocation = locationById.get(String(formData.location_id)) || null;
  const selectedWarehouseLocation = useMemo(() => {
    const locationId = String(getRecordId(selectedWarehouse?.location_id));
    return locationById.get(locationId)?.name || selectedManualLocation?.name || selectedWarehouse?.location || selectedWarehouse?.address || "";
  }, [locationById, selectedManualLocation, selectedWarehouse]);
  const selectedEmployee = employeeById.get(String(formData.employee_id)) || null;
  const selectedFarmer = farmerById.get(String(formData.farmer_id)) || null;
  const selectedBuyer = buyerById.get(String(formData.buyer_id || formData.company_id)) || null;
  const selectedConsignee = consigneeById.get(String(formData.consignee_id)) || null;
  const selectedEmployeeMobile = selectedEmployee?.mobile || selectedEmployee?.phone || selectedEmployee?.mobile_no || "";
  const selectedFarmerMobile = selectedFarmer?.mobile || selectedFarmer?.phone || selectedFarmer?.mobile_no || "";
  const selectedFarmerGst = selectedFarmer?.gst_no || selectedFarmer?.gst || "";
  const selectedFarmerPan = selectedFarmer?.pan_no || selectedFarmer?.pan || "";
  const selectedFarmerState = selectedFarmer?.state || "";
  const selectedLocationName = selectedWarehouseLocation || selectedManualLocation?.name || "";
  const getProductName = (item) =>
    item?.product_name ||
    productById.get(String(item?.product_id))?.name ||
    item?.product ||
    "-";
  const getWarehouseName = (item) =>
    item?.warehouse_name ||
    warehouseById.get(String(item?.warehouse_id))?.name ||
    "-";
  const getFarmerName = (item) =>
    item?.farmer_name ||
    farmerById.get(String(item?.farmer_id))?.name ||
    "-";
  const getBuyerId = (item) => item?.buyer_id || item?.company_id || "";
  const getBuyerName = (item) =>
    item?.buyer_name ||
    buyerById.get(String(getBuyerId(item)))?.name ||
    item?.company_name ||
    companyById.get(String(item?.company_id))?.name ||
    "-";
  const saleQtyFromData = (data) => {
    const newWeight = Math.max(toNumber(data.gross_weight) - toNumber(data.tare_weight), 0);
    return newWeight || toNumber(data.quantity) || toNumber(data.unloading_qty);
  };
  const saleDispatchQtyFromData = (data) => {
    const newWeight = Math.max(toNumber(data.gross_weight) - toNumber(data.tare_weight), 0);
    return toNumber(data.dispatch_qty) || toNumber(data.quantity) || newWeight || toNumber(data.unloading_qty);
  };
  const saleGrossAmountFromData = (data) => saleDispatchQtyFromData(data) * toNumber(data.rate);
  const saleBillAmountFromData = (data) => toNumber(data.amount) || saleGrossAmountFromData(data);
  const filteredConsignees = useMemo(() => {
    const buyerId = String(formData.buyer_id || formData.company_id || "");
    if (!buyerId) return consignees;
    return consignees.filter((c) => consigneeHasBuyer(c, buyerId));
  }, [consignees, formData.buyer_id, formData.company_id]);
  const openStockDrilldown = (item, mode) => {
    setStockDrilldownFromDate("");
    setStockDrilldownToDate("");
    setStockDrilldown({ item, mode });
  };
  const openSaleJourneyReport = () => {
    setReportFilters((prev) => ({
      ...prev,
      sale_journey_token: formData.journey_token || selectedSalePassBill?.journey_token || "",
      sale_lorry_no: selectedSalePassBill?.lorry_no || formData.lorry_no || "",
      sale_bill_no: selectedSalePassBill?.voucher_no || selectedSalePassBill?.bill_no || formData.bill_no || "",
    }));
    setActiveTab("reports");
    setActiveReport("sale-journey");
  };
  const applyAddQty = (extraQty) => {
    setFormData((prev) => ({
      ...prev,
      add_qty: formatDecimal4(Math.max(toNumber(extraQty), 0)),
    }));
  };
  const getJourneySourceLabel = (row) => {
    const parts = [
      row.warehouse_name || getWarehouseName(row),
      row.location_name || "",
      row.journey_note || row.description || row.reference_id || "",
    ].map((value) => String(value || "").trim()).filter(Boolean);
    return parts.join(" | ") || "-";
  };
  const purchaseDeductionTotal = purchaseDeductionFields.reduce((sum, field) => sum + toNumber(formData[field.key]), 0);
  const purchaseNewWeight = toNumber(formData.gross_weight) - toNumber(formData.tare_weight);
  const safePurchaseNewWeight = Math.max(purchaseNewWeight, 0);
  const purchaseNetWeight =
    safePurchaseNewWeight -
    toNumber(formData.dhalta) -
    purchaseDeductionTotal;
  const safePurchaseNetWeight = Math.max(purchaseNetWeight, 0);
  const purchaseGrossAmount = safePurchaseNetWeight * toNumber(formData.rate);
  const purchaseClaimAmount = toNumber(formData.claim_amount) || toNumber(formData.bags_claim);
  const purchaseTotalDeduction =
    purchaseClaimAmount +
    toNumber(formData.labour) +
    toNumber(formData.transport_charge) +
    toNumber(formData.cd_amount) +
    toNumber(formData.tds_amount) +
    toNumber(formData.other_deduction) +
    toNumber(formData.adjustment_amount);
  const purchaseRoundOff = toNumber(formData.round_off);
  const purchaseNetPayable = Math.max(purchaseGrossAmount - purchaseTotalDeduction + purchaseRoundOff, 0);
  const purchaseDeductionDefaults = purchaseBaseline || {
    less_bags_weight: "",
    moisture: "",
    dunki: "",
    fungus: "",
    discolour: "",
    others: "",
    bags_claim: "",
    labour: "",
    transport_charge: "",
    round_off: "",
  };
  const purchaseAutoFillDefaults = {
    ...purchaseDeductionDefaults,
    bags_claim: purchaseDeductionDefaults.bags_claim || "",
    labour: purchaseDeductionDefaults.labour || "",
    transport_charge: purchaseDeductionDefaults.transport_charge || "",
    round_off: purchaseDeductionDefaults.round_off || "",
  };
  const paymentAdjustmentTotal = paymentAdjustments.reduce(
    (sum, item) => sum + toNumber(item.adjusted_amount),
    0
  );
  const paymentFinancialStats = partyOutstanding?.stats || {};
  const paymentTotalBill = toNumber(
    paymentFinancialStats.total_bill ??
    paymentFinancialStats.total_purchase ??
    paymentFinancialStats.bill_amount
  );
  const paymentTotalDeduction = toNumber(
    paymentFinancialStats.total_deduction ??
    paymentFinancialStats.deduction_total
  );
  const paymentTotalPaid = toNumber(
    paymentFinancialStats.total_payment ??
    paymentFinancialStats.paid ??
    paymentFinancialStats.payment_total
  );
  // Keep the existing outstanding calculation as the accounting source of truth.
  // The deduction card is informational and is not subtracted twice from an already-net payable amount.
  const paymentTotalDue = toNumber(
    paymentFinancialStats.outstanding ??
    (paymentTotalBill - paymentTotalPaid)
  );
  const receiptAdjustmentTotal = receiptAdjustments.reduce(
    (sum, item) => sum + toNumber(item.adjusted_amount),
    0
  );
  const voucherPermissionMap = {
    purchase: "warehouse.trading.purchase.view",
    sale: "warehouse.trading.sale.view",
    payment: "warehouse.trading.payment.view",
    receipt: "warehouse.trading.receipt.view",
    journal: "warehouse.trading.journal.view",
  };
  const reportPermissionMap = {
    sale: "warehouse.trading.report.sale",
    purchase: "warehouse.trading.report.purchase",
    payment: "warehouse.trading.payment.view",
    "purchase-party-ledger": "warehouse.trading.report.purchase",
    "sale-party-ledger": "warehouse.trading.report.sale",
    "sale-followup": "warehouse.trading.report.sale",
    "sale-journey": "warehouse.trading.report.sale",
    "warehouse-stock": "warehouse.trading.report.purchase",
    "fifo-stock": "warehouse.trading.report.purchase",
    "profit-loss": "warehouse.trading.report.profitLoss",
  };
  const reportEndpointMap = {
    sale: "sale-summary",
    purchase: "purchase-summary",
    payment: "payment",
    "purchase-party-ledger": "purchase-party-ledger",
    "sale-party-ledger": "sale-party-ledger",
    "sale-followup": "sale-followup",
    "sale-journey": "sale-journey",
    "warehouse-stock": "warehouse-stock",
    "fifo-stock": "fifo-stock",
    "profit-loss": "profit-loss",
  };
  const reportLabels = {
    sale: "Sale Summary",
    purchase: "Purchase Detail",
    payment: "Payment Report",
    "purchase-party-ledger": "Purchase Party Ledger",
    "sale-party-ledger": "Sale Party Ledger",
    "sale-followup": "Sale Follow-up",
    "sale-journey": "Sale Journey Report",
    "warehouse-stock": "Warehouse Stock",
    "fifo-stock": "FIFO Stock",
    "profit-loss": "Profit/Loss",
  };
  const canUseTrading = hasPermission(user, "warehouse.trading.view");
  const canUsePurchase = hasPermission(user, "warehouse.trading.purchase.view") || hasPermission(user, "warehouse.trading.purchase.create") || hasPermission(user, "warehouse.trading.purchase.edit") || hasPermission(user, "warehouse.trading.purchase.delete");
  const canUseSale = hasPermission(user, "warehouse.trading.sale.view") || hasPermission(user, "warehouse.trading.sale.create") || hasPermission(user, "warehouse.trading.sale.edit") || hasPermission(user, "warehouse.trading.sale.delete");
  const canUsePayment = hasPermission(user, "warehouse.trading.payment.view") || hasPermission(user, "warehouse.trading.payment.create") || hasPermission(user, "warehouse.trading.payment.edit") || hasPermission(user, "warehouse.trading.payment.delete");
  const canUseReceipt = hasPermission(user, "warehouse.trading.receipt.view") || hasPermission(user, "warehouse.trading.receipt.create") || hasPermission(user, "warehouse.trading.receipt.edit") || hasPermission(user, "warehouse.trading.receipt.delete");
  const canUseJournal = hasPermission(user, "warehouse.trading.journal.view") || hasPermission(user, "warehouse.trading.journal.create") || hasPermission(user, "warehouse.trading.journal.edit") || hasPermission(user, "warehouse.trading.journal.delete");
  const canUseWarehouseStockReport = hasPermission(user, "warehouse.trading.report.purchase") || hasPermission(user, "warehouse.trading.report.sale");
  const allowedVoucherTypes = Object.keys(voucherPermissionMap).filter((type) => {
    if (type === "purchase") return canUsePurchase;
    if (type === "sale") return canUseSale;
    if (type === "payment") return canUsePayment;
    if (type === "receipt") return canUseReceipt;
    if (type === "journal") return canUseJournal;
    return false;
  });
  const allowedReports = Object.keys(reportPermissionMap).filter((type) => {
    if (type === "sale" || type === "sale-party-ledger" || type === "sale-followup" || type === "sale-journey") {
      // Sale reports must remain visible for users who can access the Sale module.
      // Some older roles only have the Sale view permission and do not have the
      // newer report-specific permission yet.
      return hasPermission(user, "warehouse.trading.report.sale") || canUseSale;
    }
    if (type === "warehouse-stock") {
      return canUseWarehouseStockReport;
    }
    if (type === "purchase" || type === "purchase-party-ledger" || type === "fifo-stock") {
      return hasPermission(user, "warehouse.trading.report.purchase");
    }
    if (type === "payment") {
      return canUsePayment;
    }
    if (type === "profit-loss") {
      return hasPermission(user, "warehouse.trading.report.profitLoss");
    }
    return false;
  });
  const saleDispatchQty = toNumber(formData.dispatch_qty) || toNumber(formData.quantity) || toNumber(formData.unloading_qty);
  const saleUnloadingQty = toNumber(formData.unloading_qty);
  const saleRejectQty = toNumber(formData.reject_qty);
  const saleRemainingQty = Math.max(saleDispatchQty - saleUnloadingQty, 0);
  const saleShortageQty = saleRemainingQty;
  const saleShortageAmount = saleShortageQty * toNumber(formData.rate);
  const saleAddQty = Math.max(toNumber(formData.add_qty), 0);
  const saleNextBillQty = Math.max(saleRemainingQty + saleAddQty, 0);
  const saleTotalQtyPreview = saleNextBillQty;
  const saleQualityDeduction =
    toNumber(formData.moisture) +
    toNumber(formData.dunki) +
    toNumber(formData.fungus) +
    toNumber(formData.discolour) +
    toNumber(formData.others);
  const saleTransportCharge = toNumber(formData.transport_charge);
  const saleCashDiscountAmount = Number((saleBillAmountFromData(formData) * toNumber(formData.cd_percent) / 100).toFixed(2));
  const partySaleTotal = list
    .filter((item) => {
      const sameBuyer = String(getBuyerId(item) || "") === String(formData.buyer_id || formData.company_id || "");
      const sameAccount = String(item.company_account_id || "") === String(formData.company_account_id || "");
      return sameBuyer && (!formData.company_account_id || sameAccount);
    })
    .reduce((sum, item) => sum + toNumber(item.total_amount || item.net_receivable_amount || item.net_amount || item.amount), 0);
  const tdsEligible = partySaleTotal > 5000000;
  const autoTdsAmount = tdsEligible
    ? Math.max(saleBillAmountFromData(formData) - saleShortageAmount - saleQualityDeduction - saleTransportCharge - saleCashDiscountAmount - toNumber(formData.adjustment_amount), 0) * 0.001
    : 0;
  const selectedBuyerSaleRows = list.filter((item) => {
    const sameBuyer = String(getBuyerId(item) || "") === String(formData.buyer_id || formData.company_id || "");
    const sameAccount = !formData.company_account_id || String(item.company_account_id || "") === String(formData.company_account_id || "");
    return activeVoucherType === "sale" && sameBuyer && sameAccount;
  });
  const selectedBuyerSaleQty = selectedBuyerSaleRows.reduce((sum, item) => sum + toNumber(item.quantity || item.total_quantity || item.unloading_qty), 0);
  const selectedBuyerSaleAmount = selectedBuyerSaleRows.reduce((sum, item) => sum + toNumber(item.net_receivable_amount || item.net_amount || item.amount), 0);
  const selectedBuyerPendingAmount = (partyOutstanding?.sales || []).reduce((sum, item) => sum + toNumber(item.pending_amount), 0);
  const selectedBuyerBalanceAmount = toNumber(partyOutstanding?.stats?.outstanding ?? partyOutstanding?.outstanding ?? selectedBuyerPendingAmount);
  const selectedWarehouseStockRow = warehouseStockReport.find((item) =>
    String(item.warehouse_id || "") === String(formData.warehouse_id || "") &&
    String(item.product_id || "") === String(formData.product_id || "")
  );
  const selectedWarehouseBalanceQty = availableSaleStock !== null
    ? toNumber(availableSaleStock)
    : selectedWarehouseStockRow
      ? toNumber(selectedWarehouseStockRow.stock_qty)
      : null;
  const againstPurchaseRows = salePurchaseRows
    .filter((item) => {
      if (formData.against_purchase_farmer_id && String(item.farmer_id || "") !== String(formData.against_purchase_farmer_id)) return false;
      if (formData.company_account_id && String(item.company_account_id || "") !== String(formData.company_account_id)) return false;
      if (formData.product_id && String(item.product_id || "") !== String(formData.product_id)) return false;
      if (formData.warehouse_id && String(item.warehouse_id || "") !== String(formData.warehouse_id)) return false;
      return true;
    })
    .slice()
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const againstPurchaseLinkMap = new Map(salePurchaseLinks.map((item) => [String(item.purchase_id), item]));
  const againstPurchaseTotalQty = salePurchaseLinks.reduce((sum, item) => sum + toNumber(item.quantity), 0);
  const againstPurchaseTotalAmount = salePurchaseLinks.reduce((sum, item) => sum + toNumber(item.amount), 0);
  const saleNetReceivablePreview =
    saleGrossAmountFromData(formData) -
    toNumber(formData.claim_amount) -
    toNumber(formData.other_deduction) -
    saleTransportCharge -
    saleCashDiscountAmount -
    toNumber(formData.adjustment_amount) -
    (tdsEligible ? autoTdsAmount : toNumber(formData.tds_amount)) +
    toNumber(formData.round_off);

  const updateSalePurchaseLink = (purchase, quantityValue) => {
    const purchaseId = String(purchase.id || purchase._id || "");
    const quantity = Math.max(0, toNumber(quantityValue));
    const rate = toNumber(purchase.rate);
    setSalePurchaseLinks((prev) => {
      const others = prev.filter((item) => String(item.purchase_id) !== purchaseId);
      if (!purchaseId || quantity <= 0) return others;
      return [
        ...others,
        {
          purchase_id: purchaseId,
          voucher_no: purchase.voucher_no || "",
          farmer_id: String(purchase.farmer_id || formData.against_purchase_farmer_id || ""),
          quantity,
          rate,
          amount: Number((quantity * rate).toFixed(2)),
        },
      ];
    });
  };
  const saleVoucherPassBills = list.filter((item) => {
    const sameWarehouse = !formData.warehouse_id || String(item.warehouse_id || "") === String(formData.warehouse_id);
    const sameAccount = !formData.company_account_id || String(item.company_account_id || "") === String(formData.company_account_id);
    const search = saleBillSearch.trim().toLowerCase();
    const searchable = [
      item.voucher_no,
      item.lorry_no,
      item.reference_id,
      getBuyerName(item),
      item.consignee_name,
      getProductName(item),
    ].join(" ").toLowerCase();
    // Ensure we only show sale vouchers here. Prefer explicit `voucher_type` when available,
    // otherwise fall back to presence of buyer/company fields which indicate sale.
    const isSaleType = String(item.voucher_type || "").toLowerCase() === "sale" || Boolean(item.buyer_id || item.company_id);
    return isSaleType && sameWarehouse && sameAccount && (!search || searchable.includes(search));
  });
  const selectedSalePassBill =
    list.find((row) => String(row.id || row._id) === String(editId)) ||
    saleVoucherPassBills.find((row) => String(row.id || row._id) === String(editId)) ||
    null;
  const selectedSalePassJourneyKey = String(
    selectedSalePassBill?.journey_token ||
      selectedSalePassBill?.journey_id ||
      selectedSalePassBill?.journey_group_no ||
      formData.journey_token ||
      ""
  ).trim();
  const selectedSalePassJourneyRows = selectedSalePassJourneyKey
    ? list.filter((row) => String(row.journey_token || row.journey_id || row.journey_group_no || "") === selectedSalePassJourneyKey)
    : (selectedSalePassBill || formData.lorry_no)
      ? list.filter((row) => {
          const sameLorry = String(row.lorry_no || "") === String(selectedSalePassBill?.lorry_no || formData.lorry_no || "");
          const sameDate = selectedSalePassBill?.date ? String(row.date || "") === String(selectedSalePassBill.date || "") : true;
          return sameLorry && sameDate;
        })
      : [];
  const selectedSalePassJourneyRemainingQty = Math.max(
    saleDispatchQty - selectedSalePassJourneyRows.reduce((sum, row) => sum + toNumber(row.unloading_qty || row.quantity || row.total_quantity || 0), 0),
    0
  );

  useEffect(() => {
    if (activeTab !== "vouchers" || activeVoucherType !== "sale" || !showSaleDeductionModal) return;
    if (editId && selectedSalePassBill) return;
    const preferredLorry = String(formData.lorry_no || "").trim();
    const preferredToken = String(formData.journey_token || "").trim();
    const autoSelected =
      saleVoucherPassBills.find((row) => preferredToken && String(row.journey_token || row.journey_id || row.journey_group_no || "") === preferredToken) ||
      saleVoucherPassBills.find((row) => preferredLorry && String(row.lorry_no || "") === preferredLorry) ||
      saleVoucherPassBills[0] ||
      null;
    if (autoSelected && String(editId || "") !== String(autoSelected.id || autoSelected._id || "")) {
      selectSaleVoucherForPass(autoSelected.id || autoSelected._id);
    }
  }, [activeTab, activeVoucherType, showSaleDeductionModal, editId, selectedSalePassBill, saleVoucherPassBills, formData.lorry_no, formData.journey_token]);

  const saleAdjustedBills = list.filter((item) => {
    const sameWarehouse = !formData.warehouse_id || String(item.warehouse_id || "") === String(formData.warehouse_id);
    const sameAccount = !formData.company_account_id || String(item.company_account_id || "") === String(formData.company_account_id);
    const hasAdjustment =
      toNumber(item.shortage_quantity) > 0 ||
      toNumber(item.claim_amount) > 0 ||
      toNumber(item.other_deduction) > 0 ||
      toNumber(item.cd_amount) > 0 ||
      toNumber(item.adjustment_amount) > 0 ||
      toNumber(item.tds_amount) > 0 ||
      Boolean(item.unloading_date);
    const search = saleBillSearch.trim().toLowerCase();
    const searchable = [
      item.voucher_no,
      item.lorry_no,
      item.reference_id,
      getBuyerName(item),
      item.consignee_name,
      getProductName(item),
    ].join(" ").toLowerCase();
    return sameWarehouse && sameAccount && hasAdjustment && (!search || searchable.includes(search));
  });

  // Load initial data
  useEffect(() => {
    const requestedType = searchParams.get("type");
    const requestedTab = searchParams.get("tab");
    const requestedReport = searchParams.get("report");
    const validVoucherTypes = allowedVoucherTypes;
    const validReports = allowedReports;
    const nextTab = validVoucherTypes.includes(requestedType)
      ? "vouchers"
      : requestedTab === "reports" || validReports.includes(requestedReport)
        ? "reports"
        : validVoucherTypes.length
          ? "vouchers"
          : validReports.length
            ? "reports"
            : "vouchers";
    const nextVoucherType = validVoucherTypes.includes(requestedType) ? requestedType : validVoucherTypes[0] || "purchase";
    const nextReport = validReports.includes(requestedReport) ? requestedReport : validReports[0] || "sale";

    setActiveTab(nextTab);
    setActiveVoucherType(nextVoucherType);
    setActiveReport(nextReport);
    if (nextTab === "reports") {
      setShowMobileTradingTabs(true);
    }

    // Master data is loaded only by the dedicated Vouchers effect below.
    // This prevents the URL/search-param effect from starting a duplicate bundle.
  }, [searchParams]);

  // Load master data once when Vouchers is actually visible. Delay it slightly
  // so the first voucher table paint is not competing with nine master requests.
  useEffect(() => {
    if (activeTab !== "vouchers") return;
    const timer = window.setTimeout(() => { loadData(); }, 900);
    return () => window.clearTimeout(timer);
  }, [activeTab]);

  // Refresh farmers whenever Purchase/New Sale voucher is opened so a farmer
  // created in the master screen is immediately available. The master bundle
  // intentionally uses a session cache for performance, but farmers are a
  // frequently-created master and must not remain stale for 30 minutes.
  useEffect(() => {
    if (activeTab !== "vouchers") return;
    if (!["purchase", "sale"].includes(activeVoucherType)) return;

    let cancelled = false;
    const refreshFarmers = async () => {
      try {
        const res = await axios.get("/api/farmers", {
          headers: { "Cache-Control": "no-cache" },
          params: { _refresh: Date.now() },
        });
        const freshFarmers = Array.isArray(res.data) ? res.data : [];
        if (cancelled) return;
        setFarmers(freshFarmers);

        // Keep the other cached master data, but replace only the farmers list.
        try {
          const cached = JSON.parse(sessionStorage.getItem("warehouseTradingMasterData:v2") || "null");
          if (cached?.data) {
            sessionStorage.setItem("warehouseTradingMasterData:v2", JSON.stringify({
              ...cached,
              time: Date.now(),
              data: { ...cached.data, farmers: freshFarmers },
            }));
          }
        } catch {}
      } catch (err) {
        // Keep the cached farmer list if the refresh endpoint is temporarily unavailable.
        if (!cancelled) console.warn("Fresh farmer list unavailable; using cached farmers", err);
      }
    };

    const timer = window.setTimeout(refreshFarmers, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeTab, activeVoucherType]);

  // Load voucher list when type changes
  useEffect(() => {
    if (activeTab !== "vouchers") return;
    const timer = window.setTimeout(() => {
      loadVouchers();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeTab, activeVoucherType, voucherSortAsc, voucherPage, globalSearch]);

  useEffect(() => {
    if (activeTab === "vouchers" && activeVoucherType === "sale") {
      loadSalePurchaseRows();
    }
  }, [activeTab, activeVoucherType]);

  useEffect(() => {
    if (activeTab === "vouchers") {
      fetchNextVoucherNo(activeVoucherType);
      setPartyOutstanding(null);
      setPaymentAdjustments([]);
      setSelectedPaymentId(null);
      setShowPaymentAdjustPopup(false);
      setReceiptAdjustments([]);
      setSelectedReceiptId(null);
      setShowReceiptAdjustPopup(false);
      setSalePurchaseLinks([]);
      setFormData((prev) => ({ ...prev, reference_type: "", reference_id: "" }));
    }
  }, [activeTab, activeVoucherType]);

  // Report rows: page/filter changes only.
  useEffect(() => {
    if (activeTab !== "reports") return;
    const timer = window.setTimeout(() => {
      loadReport();
    }, 40);
    return () => window.clearTimeout(timer);
  }, [activeTab, activeReport, reportPage, globalSearch, reportFilters.farmer_id, reportFilters.company_account_id, reportFilters.warehouse_id, reportFilters.sale_buyer_id, reportFilters.sale_company_account_id, reportFilters.sale_journey_token, reportFilters.sale_lorry_no, reportFilters.sale_bill_no, reportFilters.details_of_deduction]);

  // Filter options are independent of pagination. Never reload them just
  // because the user moves from page 1 to page 2.
  useEffect(() => {
    if (activeTab !== "reports") return;
    const timer = window.setTimeout(() => {
      loadReportFilterOptions();
    }, 40);
    return () => window.clearTimeout(timer);
  }, [activeTab, activeReport, reportFilters.farmer_id, reportFilters.company_account_id, reportFilters.warehouse_id, reportFilters.sale_buyer_id]);

  useEffect(() => {
    // Keep bill-wise detail panels hidden by default. Press F5 to reveal and
    // refresh the selected party ledger when detailed bill information is needed.
    setShowPurchaseBillWise(false);
    setShowSaleBillWise(false);
  }, [activeReport]);

  useEffect(() => {
    const handleArrowNavigation = (event) => {
      const { key, target } = event;
      if (!target || !target.closest || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) return;
      if (!target.matches("input, select, textarea") || event.metaKey || event.ctrlKey || event.altKey) return;

      const root = activeTab === "vouchers"
        ? (voucherPanelRef.current || arrowNavRootRef.current)
        : (reportPanelRef.current || arrowNavRootRef.current);
      if (!root || !root.contains(target)) return;

      const focusableElements = getArrowFocusableInputs(root);
      const index = focusableElements.indexOf(target);
      if (index === -1) return;

      const currentRect = target.getBoundingClientRect();
      const currentCenterX = currentRect.left + currentRect.width / 2;
      const currentCenterY = currentRect.top + currentRect.height / 2;
      let candidate = null;
      let bestScore = Number.POSITIVE_INFINITY;

      focusableElements.forEach((element, elementIndex) => {
        if (elementIndex === index) return;
        const rect = element.getBoundingClientRect();
        const elementCenterX = rect.left + rect.width / 2;
        const elementCenterY = rect.top + rect.height / 2;

        let score = Number.POSITIVE_INFINITY;
        if (key === "ArrowRight") {
          if (rect.left <= currentRect.left + 1) return;
          score = (rect.left - currentRect.right) + Math.abs(elementCenterY - currentCenterY) * 0.2;
        } else if (key === "ArrowLeft") {
          if (rect.right >= currentRect.right - 1) return;
          score = (currentRect.left - rect.right) + Math.abs(elementCenterY - currentCenterY) * 0.2;
        } else if (key === "ArrowDown") {
          if (rect.top <= currentRect.top + 1) return;
          score = (rect.top - currentRect.bottom) + Math.abs(elementCenterX - currentCenterX) * 0.15;
        } else if (key === "ArrowUp") {
          if (rect.bottom >= currentRect.bottom - 1) return;
          score = (currentRect.top - rect.bottom) + Math.abs(elementCenterX - currentCenterX) * 0.15;
        }

        if (score < bestScore) {
          bestScore = score;
          candidate = element;
        }
      });

      if (candidate) {
        event.preventDefault();
        candidate.focus({ preventScroll: true });
        if (typeof candidate.select === "function" && target.tagName !== "SELECT") {
          candidate.select();
        }
      }
    };

    document.addEventListener("keydown", handleArrowNavigation);
    return () => document.removeEventListener("keydown", handleArrowNavigation);
  }, []);

  useEffect(() => {
    const handleLedgerRefresh = (event) => {
      if (event.key !== "F5" || activeTab !== "reports") return;
      if (activeReport !== "purchase-party-ledger" && activeReport !== "sale-party-ledger") return;
      event.preventDefault();
      if (activeReport === "purchase-party-ledger") setShowPurchaseBillWise(true);
      if (activeReport === "sale-party-ledger") setShowSaleBillWise(true);
      loadReport();
    };
    window.addEventListener("keydown", handleLedgerRefresh);
    return () => window.removeEventListener("keydown", handleLedgerRefresh);
  }, [activeTab, activeReport, reportFilters.farmer_id, reportFilters.warehouse_id, reportFilters.company_account_id, reportFilters.sale_buyer_id, reportFilters.sale_company_account_id, reportFilters.sale_journey_token, reportFilters.sale_lorry_no, reportFilters.sale_bill_no]);

  useEffect(() => {
    const handleF2Key = (event) => {
      if (event.key !== "F2" || activeTab !== "vouchers" || activeVoucherType !== "sale") return;
      event.preventDefault();
      setShowSaleDeductionModal(true);
    };
    window.addEventListener("keydown", handleF2Key);
    return () => window.removeEventListener("keydown", handleF2Key);
  }, [activeTab, activeVoucherType]);

  useEffect(() => {
    const loadSaleTransportCharge = async () => {
      if (!showSaleDeductionModal) return;
      const biltiId = selectedSalePassBill?.bilti_id;
      if (!biltiId) {
        if (!formData.transport_charge) {
          setFormData((prev) => ({ ...prev, transport_charge: "" }));
        }
        return;
      }
      try {
        const response = await axios.get(`/api/transport-bilti/${biltiId}`);
        const amount = toNumber(response.data?.transport_charge || response.data?.net_amount || response.data?.payable_amount || response.data?.gross_freight || 0);
        setFormData((prev) => ({
          ...prev,
          transport_charge: amount > 0 ? amount.toFixed(2) : prev.transport_charge,
        }));
      } catch (err) {
        // Keep manual value if transport lookup fails.
      }
    };
    loadSaleTransportCharge();
  }, [showSaleDeductionModal, selectedSalePassBill?.bilti_id]);

  useEffect(() => {
    const loadSaleTransportFromSummary = async () => {
      if (!showSalePreview || !salePreviewRow) return;
      const saleId = salePreviewRow.id || salePreviewRow._id;
      if (!saleId) return;
      try {
        const response = await axios.get(`/api/wh-vouchers/sale/${saleId}/summary`);
        const transportValue = toNumber(response.data?.transport_charge || response.data?.summary?.transport_charge || 0);
        if (transportValue > 0) {
          setSalePreviewSummary(response.data);
        }
      } catch (err) {
        // keep current preview data
      }
    };
    loadSaleTransportFromSummary();
  }, [showSalePreview, salePreviewRow]);

  useEffect(() => {
    if (!showSalePreview) return;
    setSaleTransportMode("auto");
    setSaleTransportManualAmount("0.00");
  }, [showSalePreview, salePreviewRow]);

  useEffect(() => {
    const handleF5SaleKey = (event) => {
      if (event.key !== "F5" || activeTab !== "vouchers" || activeVoucherType !== "sale") return;
      event.preventDefault();
      setShowSaleAdjustedModal(true);
    };
    window.addEventListener("keydown", handleF5SaleKey);
    return () => window.removeEventListener("keydown", handleF5SaleKey);
  }, [activeTab, activeVoucherType]);

  useEffect(() => {
    if (activeTab !== "vouchers" || activeVoucherType !== "sale" || formData.sale_type === "direct" || !formData.warehouse_id || !formData.product_id) {
      setAvailableSaleStock(null);
      return;
    }

    let cancelled = false;
    axios
      .get("/api/wh-vouchers/available-sale-stock", {
        params: {
          warehouse_id: formData.warehouse_id,
          product_id: formData.product_id,
          exclude_sale_id: editId || undefined,
        },
      })
      .then((res) => {
        if (!cancelled) setAvailableSaleStock(res.data?.stock_qty ?? null);
      })
      .catch(() => {
        if (!cancelled) setAvailableSaleStock(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, activeVoucherType, formData.sale_type, formData.warehouse_id, formData.product_id, editId]);

  const loadData = async ({ force = false } = {}) => {
    if (!force && masterDataLoadedRef.current) return;
    if (!force && masterLoadPromiseRef.current) return masterLoadPromiseRef.current;

    const run = (async () => {
      // Reuse the master bundle between Trading page mounts. This is intentionally
      // one in-flight request group so React effects cannot fire the same 9 calls twice.
      if (!force) {
        try {
          const cached = JSON.parse(sessionStorage.getItem("warehouseTradingMasterData:v2") || "null");
          if (cached?.data && Date.now() - Number(cached.time || 0) < 30 * 60 * 1000) {
            const data = cached.data;
            setWarehouses(Array.isArray(data.warehouses) ? data.warehouses : []);
            setFarmers(Array.isArray(data.farmers) ? data.farmers : []);
            setBuyerNames(Array.isArray(data.buyerNames) ? data.buyerNames : []);
            setCompanies(Array.isArray(data.companies) ? data.companies : []);
            setCompanyAccounts(Array.isArray(data.companyAccounts) ? data.companyAccounts : []);
            setConsignees(Array.isArray(data.consignees) ? data.consignees : []);
            setProducts(Array.isArray(data.products) ? data.products : []);
            setEmployees(Array.isArray(data.employees) ? data.employees : []);
            setLocations(Array.isArray(data.locations) ? data.locations : []);
            masterDataLoadedRef.current = true;
            return;
          }
        } catch {}
      }

      const token = ++masterLoadTokenRef.current;
      try {
        const [wRes, fRes, bRes, cRes, caRes, coRes, pRes, eRes, lRes] = await Promise.allSettled([
          axios.get("/api/warehouses"),
          axios.get("/api/farmers"),
          axios.get("/api/buyer-names"),
          axios.get("/api/companies"),
          axios.get("/api/company-accounts"),
          axios.get("/api/consignee-names"),
          axios.get("/api/products"),
          axios.get("/api/employees"),
          axios.get("/api/locations"),
        ]);
        const dataOf = (result) => (result.status === "fulfilled" ? result.value.data : []);
        if (token !== masterLoadTokenRef.current) return;
        const data = {
          warehouses: Array.isArray(dataOf(wRes)) ? dataOf(wRes) : [],
          farmers: Array.isArray(dataOf(fRes)) ? dataOf(fRes) : [],
          buyerNames: Array.isArray(dataOf(bRes)) ? dataOf(bRes) : [],
          companies: Array.isArray(dataOf(cRes)) ? dataOf(cRes) : [],
          companyAccounts: Array.isArray(dataOf(caRes)) ? dataOf(caRes) : [],
          consignees: Array.isArray(dataOf(coRes)) ? dataOf(coRes) : [],
          products: Array.isArray(dataOf(pRes)) ? dataOf(pRes) : [],
          employees: Array.isArray(dataOf(eRes)) ? dataOf(eRes) : [],
          locations: Array.isArray(dataOf(lRes)) ? dataOf(lRes) : [],
        };
        setWarehouses(data.warehouses);
        setFarmers(data.farmers);
        setBuyerNames(data.buyerNames);
        setCompanies(data.companies);
        setCompanyAccounts(data.companyAccounts);
        setConsignees(data.consignees);
        setProducts(data.products);
        setEmployees(data.employees);
        setLocations(data.locations);
        masterDataLoadedRef.current = true;
        try {
          sessionStorage.setItem("warehouseTradingMasterData:v2", JSON.stringify({
            time: Date.now(),
            data,
          }));
        } catch {}
      } catch (err) {
        if (token === masterLoadTokenRef.current) console.error(err);
      }
    })();

    if (!force) masterLoadPromiseRef.current = run;
    try {
      return await run;
    } finally {
      if (!force) masterLoadPromiseRef.current = null;
    }
  };

  const loadWarehouseStockReport = async () => {
    const token = ++reportLoadTokenRef.current;
    try {
      const res = await axios.get("/api/wh-vouchers/report/warehouse-stock");
      if (token !== reportLoadTokenRef.current) return;
      setWarehouseStockReport(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      if (token !== reportLoadTokenRef.current) return;
      console.error(err);
      setWarehouseStockReport([]);
    }
  };

  const fetchNextVoucherNo = async (type) => {
    try {
      setVoucherNumberLoading(true);
      const res = await axios.get(`/api/wh-vouchers/next-voucher-no`, { params: { type } });
      if (res.data?.voucher_no) {
        setFormData((prev) => ({ ...prev, voucher_no: prev.voucher_no || res.data.voucher_no }));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setVoucherNumberLoading(false);
    }
  };

  const loadPaymentFarmers = async (companyAccountId, warehouseId = "", excludePaymentId = "") => {
    const account = String(companyAccountId || "").trim();
    const warehouse = String(warehouseId || "").trim();
    if (!account) {
      setAccountFarmers([]);
      setPaymentWarehouses([]);
      return [];
    }
    const excludePayment = String(excludePaymentId || "").trim();
    const key = `${account}::${warehouse}::${excludePayment}`;
    const cached = paymentFarmersCacheRef.current.get(key);
    if (cached && Date.now() - cached.time < 60000) {
      setAccountFarmers(cached.farmers || []);
      if (!warehouse && Array.isArray(cached.warehouse_ids)) {
        const ids = new Set(cached.warehouse_ids.map(String));
        setPaymentWarehouses(warehouses.filter((w) => ids.has(String(w.id || w._id))));
      }
      return cached.farmers || [];
    }
    const inFlight = paymentFarmersInFlightRef.current.get(key);
    if (inFlight) return inFlight;
    const request = axios.get(`/api/wh-vouchers/farmers-by-account/${account}`, {
      params: {
        ...(warehouse ? { warehouse_id: warehouse } : {}),
        ...(excludePayment ? { exclude_payment_id: excludePayment } : {}),
      },
    })
      .then((res) => {
        const farmersResult = Array.isArray(res.data) ? res.data : [];
        const warehouseIds = [...new Set(farmersResult.flatMap((f) => Array.isArray(f.warehouse_ids) ? f.warehouse_ids : []))];
        const data = { farmers: farmersResult, warehouse_ids: warehouseIds, time: Date.now() };
        paymentFarmersCacheRef.current.set(key, data);
        setAccountFarmers(farmersResult);
        if (!warehouse) {
          const ids = new Set(warehouseIds.map(String));
          setPaymentWarehouses(warehouses.filter((w) => ids.has(String(w.id || w._id))));
        }
        return farmersResult;
      })
      .finally(() => paymentFarmersInFlightRef.current.delete(key));
    paymentFarmersInFlightRef.current.set(key, request);
    return request;
  };

  const loadOutstanding = async (partyType, partyId, warehouseId = null, excludePaymentId = null, companyAccountId = null) => {
    if (!partyType || !partyId) {
      setPartyOutstanding(null);
      return null;
    }

    const warehouse = warehouseId || formData.warehouse_id || "";
    const key = JSON.stringify({
      partyType,
      partyId: String(partyId),
      warehouse: String(warehouse),
      excludePaymentId: String(excludePaymentId || ""),
      companyAccountId: String(companyAccountId || ""),
    });

    const cached = outstandingCacheRef.current.get(key);
    if (cached && Date.now() - cached.time < 10000) {
      setPartyOutstanding(cached.data || null);
      return cached.data || null;
    }

    const inFlight = outstandingInFlightRef.current.get(key);
    if (inFlight) return inFlight;

    const request = (async () => {
      try {
        const params = { party_type: partyType, id: partyId };
        if (warehouse) params.warehouse_id = warehouse;
        if (excludePaymentId) params.exclude_payment_id = excludePaymentId;
        if (companyAccountId) params.company_account_id = companyAccountId;
        const res = await axios.get(`/api/wh-vouchers/outstanding`, { params });
        const data = res.data || null;
        outstandingCacheRef.current.set(key, { time: Date.now(), data });
        setPartyOutstanding(data);
        return data;
      } catch (err) {
        console.error(err);
        setPartyOutstanding(null);
        return null;
      } finally {
        outstandingInFlightRef.current.delete(key);
      }
    })();

    outstandingInFlightRef.current.set(key, request);
    return request;
  };

  const loadVouchers = async () => {
    const token = ++voucherLoadTokenRef.current;
    try {
      if (!hasPermission(user, voucherPermissionMap[activeVoucherType])) {
        if (token !== voucherLoadTokenRef.current) return;
        setList([]);
        setVoucherPageInfo({ page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 1, hasMore: false });
        return;
      }

      const params = {
        page: voucherPage,
        limit: PAGE_SIZE,
        order: voucherSortAsc ? "asc" : "desc",
      };
      const search = String(globalSearch || "").trim();
      if (search) params.search = search;

      const res = await axios.get(`/api/wh-vouchers/${activeVoucherType}`, { params });
      if (token !== voucherLoadTokenRef.current) return;

      const payload = res.data || {};
      const rows = Array.isArray(payload) ? payload : (Array.isArray(payload.data) ? payload.data : []);
      const pagination = Array.isArray(payload) ? null : payload.pagination;
      setList(rows);
      setVoucherPageInfo({
        page: pagination?.page || voucherPage,
        pageSize: pagination?.pageSize || PAGE_SIZE,
        total: Number(pagination?.total ?? rows.length),
        totalPages: Math.max(1, Number(pagination?.totalPages || Math.ceil(Number(pagination?.total ?? rows.length) / PAGE_SIZE))),
        hasMore: Boolean(pagination?.hasMore),
      });
    } catch (err) {
      if (token !== voucherLoadTokenRef.current) return;
      console.error(err);
      setList([]);
      setVoucherPageInfo({ page: voucherPage, pageSize: PAGE_SIZE, total: 0, totalPages: 1, hasMore: false });
    }
  };

  const loadSalePurchaseRows = async () => {
    try {
      if (!hasPermission(user, voucherPermissionMap.purchase)) {
        setSalePurchaseRows([]);
        return;
      }
      // This is a form lookup, not the main voucher table. Keep it explicit so
      // the table itself remains strictly paginated.
      const res = await axios.get("/api/wh-vouchers/purchase", { params: { page: 1, limit: 100, lookup: 1, order: "asc", warehouse_id: formData.warehouse_id || undefined, farmer_id: formData.against_purchase_farmer_id || undefined, company_account_id: formData.company_account_id || undefined, product_id: formData.product_id || undefined } });
      const payload = res.data || {};
      const rows = Array.isArray(payload) ? payload : (Array.isArray(payload.data) ? payload.data : []);
      setSalePurchaseRows(rows);
    } catch (err) {
      console.error(err);
      setSalePurchaseRows([]);
    }
  };

  const loadReportFilterOptions = async (reportType = activeReport, filters = reportFilters) => {
    const supported = ["purchase", "purchase-party-ledger", "sale", "sale-party-ledger", "sale-followup", "sale-journey"].includes(reportType);
    if (!supported) {
      setReportFilterOptions({ account_ids: [], warehouse_ids: [], farmer_ids: [], buyer_ids: [], accounts: [], warehouses: [], farmers: [], buyers: [] });
      return;
    }
    try {
      const params = {};
      if (filters.company_account_id) params.company_account_id = filters.company_account_id;
      if (filters.warehouse_id) params.warehouse_id = filters.warehouse_id;
      if (filters.farmer_id) params.farmer_id = filters.farmer_id;
      if (filters.sale_buyer_id) params.buyer_id = filters.sale_buyer_id;

      const cacheKey = JSON.stringify({ reportType, params });
      const cached = reportFilterCacheRef.current.get(cacheKey);
      if (cached && Date.now() - cached.time < 5 * 60 * 1000) {
        setReportFilterOptions(cached.data);
        return;
      }

      const inFlight = reportFilterInFlightRef.current.get(cacheKey);
      if (inFlight) {
        const data = await inFlight;
        if (data) setReportFilterOptions(data);
        return;
      }

      const request = axios
        .get("/api/wh-vouchers/report/filter-options", { params: { ...params, type: reportType } })
        .then((res) => {
          const nextData = {
            account_ids: Array.isArray(res.data?.account_ids) ? res.data.account_ids : [],
            warehouse_ids: Array.isArray(res.data?.warehouse_ids) ? res.data.warehouse_ids : [],
            farmer_ids: Array.isArray(res.data?.farmer_ids) ? res.data.farmer_ids : [],
            buyer_ids: Array.isArray(res.data?.buyer_ids) ? res.data.buyer_ids : [],
            accounts: Array.isArray(res.data?.accounts) ? res.data.accounts : [],
            warehouses: Array.isArray(res.data?.warehouses) ? res.data.warehouses : [],
            farmers: Array.isArray(res.data?.farmers) ? res.data.farmers : [],
            buyers: Array.isArray(res.data?.buyers) ? res.data.buyers : [],
          };
          reportFilterCacheRef.current.set(cacheKey, { time: Date.now(), data: nextData });
          return nextData;
        })
        .finally(() => {
          reportFilterInFlightRef.current.delete(cacheKey);
        });

      reportFilterInFlightRef.current.set(cacheKey, request);
      const nextData = await request;
      setReportFilterOptions(nextData);
    } catch (err) {
      console.error("Failed to load Trading report filters:", err);
      setReportFilterOptions({ account_ids: [], warehouse_ids: [], farmer_ids: [], buyer_ids: [], accounts: [], warehouses: [], farmers: [], buyers: [] });
    }
  };

  const loadReport = async (reportType = activeReport, page = reportPage, filters = reportFilters) => {
    const token = ++reportLoadTokenRef.current;
    // Keep report-type flags outside try/catch. The previous v8.9 build
    // declared isSaleReport inside try and then referenced it from catch,
    // which caused: "isSaleReport is not defined" and hid the real API error.
    const isPurchaseReport = ["purchase", "purchase-party-ledger"].includes(reportType);
    const isSaleReport = ["sale", "sale-party-ledger", "sale-followup", "sale-journey"].includes(reportType);
    const hasActivePurchaseFilters = Boolean(filters.farmer_id || filters.warehouse_id || filters.company_account_id);
    const normalizedSearch = String(globalSearch || "").trim();

    // Do not keep stale Purchase rows visible while Sale Report is loading.
    if (token === reportLoadTokenRef.current) {
      setReportData([]);
    }

    try {
      if (!hasPermission(user, reportPermissionMap[reportType])) {
        if (token !== reportLoadTokenRef.current) return;
        setReportData([]);
        setWarehouseStockReport([]);
        return;
      }
      const endpoint = reportEndpointMap[reportType] || reportType;
      const params = {};
      if (isPurchaseReport || isSaleReport) {
        if (filters.farmer_id) params.farmer_id = filters.farmer_id;
        if (filters.warehouse_id) params.warehouse_id = filters.warehouse_id;
        if (filters.company_account_id) params.company_account_id = filters.company_account_id;
      }
      if (isSaleReport && filters.sale_buyer_id) {
        params.buyer_id = filters.sale_buyer_id;
      }
      if (reportType === "purchase-party-ledger" && filters.details_of_deduction) {
        params.details_of_deduction = 1;
      }
      // Search must be executed by MongoDB before pagination. Otherwise the
      // old UI searched only the currently loaded 15 rows.
      if ((reportType === "sale" || reportType === "purchase") && normalizedSearch) {
        params.search = normalizedSearch;
      }
      if (reportType === "sale-journey") {
        if (filters.sale_journey_token) params.journey_token = filters.sale_journey_token;
        if (filters.sale_lorry_no) params.lorry_no = filters.sale_lorry_no;
        if (filters.sale_bill_no) params.bill_no = filters.sale_bill_no;
      }
      if (!params.company_account_id && filters.sale_company_account_id) {
        params.company_account_id = filters.sale_company_account_id;
      }
      const serverPagedReport = reportType === "sale" || reportType === "purchase" || reportType === "warehouse-stock";
      if (serverPagedReport) {
        params.page = page;
        params.page_size = PAGE_SIZE;
      }
      const res = await axios.get(`/api/wh-vouchers/report/${endpoint}`, { params });
      if (token !== reportLoadTokenRef.current) return;
      const payload = res.data || [];
      const rows = Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : [];
      const pagination = Array.isArray(payload) ? null : payload.pagination || null;
      if (reportType === "warehouse-stock") {
        setWarehouseStockReport(rows);
        setReportData(rows);
        setReportPageInfo({
          page: pagination?.page || page,
          pageSize: pagination?.pageSize || PAGE_SIZE,
          total: pagination?.total ?? rows.length,
          hasMore: Boolean(pagination?.hasMore),
        });
        return;
      }
      if (reportType === "purchase" && rows.length === 0 && hasActivePurchaseFilters && hasPermission(user, voucherPermissionMap.purchase)) {
        setReportData([]);
        return;
      }
      setReportData(rows);
      if (serverPagedReport) {
        setReportPageInfo({
          page: pagination?.page || page,
          pageSize: pagination?.pageSize || PAGE_SIZE,
          total: pagination?.total ?? rows.length,
          hasMore: Boolean(pagination?.hasMore),
        });
      }
    } catch (err) {
      if (token !== reportLoadTokenRef.current) return;
      console.error(err);
      if (reportType === "warehouse-stock") {
        setWarehouseStockReport([]);
        setReportData([]);
        return;
      }
      if (reportType === "purchase" && hasPermission(user, voucherPermissionMap.purchase) && !hasActivePurchaseFilters) {
        try {
          const fallbackRes = await axios.get("/api/wh-vouchers/purchase", { params: { page: 1, limit: PAGE_SIZE, order: "desc" } });
          if (token !== reportLoadTokenRef.current) return;
          const fallbackPayload = fallbackRes.data || [];
          setReportData(Array.isArray(fallbackPayload) ? fallbackPayload : (fallbackPayload.data || []));
          return;
        } catch (fallbackErr) {
          console.error(fallbackErr);
        }
      }
      if (reportType === "sale" && canUseSale) {
        try {
          // Only Sale Summary uses the sale-voucher fallback. Do not use it
          // for Party Ledger/Follow-up/Journey because those endpoints have
          // different response shapes.
          const fallbackRes = await axios.get("/api/wh-vouchers/sale", {
            params: { page: page || 1, limit: PAGE_SIZE, order: "desc", ...params },
          });
          if (token !== reportLoadTokenRef.current) return;
          const fallbackPayload = fallbackRes.data || [];
          const fallbackRows = Array.isArray(fallbackPayload) ? fallbackPayload : (fallbackPayload.data || []);
          setReportData(fallbackRows);
          const fallbackPagination = Array.isArray(fallbackPayload) ? null : fallbackPayload.pagination;
          setReportPageInfo({
            page: fallbackPagination?.page || page || 1,
            pageSize: fallbackPagination?.pageSize || PAGE_SIZE,
            total: fallbackPagination?.total ?? fallbackRows.length,
            hasMore: Boolean(fallbackPagination?.hasMore),
          });
          return;
        } catch (fallbackSaleErr) {
          console.error("Sale report fallback failed:", fallbackSaleErr);
        }
      }
      setReportData([]);
    }
  };

  const handlePaymentModeChange = async (nextMode, opts = {}) => {
    const normalizedMode = normalizePaymentMode(nextMode);
    const amountVal = opts.amount !== undefined ? opts.amount : formData.amount;
    const farmerVal = opts.farmer_id !== undefined ? opts.farmer_id : formData.farmer_id;
    const warehouseVal = opts.warehouse_id !== undefined ? opts.warehouse_id : formData.warehouse_id;
    const companyAccountVal = opts.company_account_id !== undefined ? opts.company_account_id : formData.company_account_id;

    setFormData((prev) => ({
      ...prev,
      payment_mode: normalizedMode,
      reference_type: getPaymentReferenceType(normalizedMode),
      reference_id: normalizedMode === "new_reference" ? prev.reference_id : "",
    }));
    setPaymentAdjustments([]);
    setShowPaymentAdjustPopup(false);

    // Selecting "Against Purchase Bills" must not make a network request or
    // open the adjustment panel automatically. The user explicitly opens it.
    // Keep the values local until Open Adjustment is clicked.
  };

  const handleChange = (e) => {
    const { name, type, checked, value } = e.target;
    const fieldValue = type === "checkbox" ? checked : value;

    if (activeVoucherType === "payment" && name === "payment_mode") {
      handlePaymentModeChange(value, { amount: formData.amount, farmer_id: formData.farmer_id, warehouse_id: formData.warehouse_id, company_account_id: formData.company_account_id });
      return;
    }

    setFormData((prev) => {
      const next = { ...prev, [name]: fieldValue };
      if (name === "warehouse_id") {
        const warehouse = warehouses.find((w) => String(w.id || w._id) === String(value));
        next.location_id = getRecordId(warehouse?.location_id);
        next.employee_id = getRecordId(warehouse?.employee_id) || prev.employee_id || "";
      }
      if (activeVoucherType === "sale" && name === "buyer_id") {
        next.company_id = value;
        next.consignee_id = "";
      }
      if (activeVoucherType === "sale" && name === "consignee_id") {
        const consignee = consignees.find((c) => String(c.id || c._id) === String(value));
        const linkedBuyerIds = getConsigneeBuyerIds(consignee);
        if (linkedBuyerIds.length) {
          const currentBuyer = String(prev.buyer_id || prev.company_id || "");
          const nextBuyer = linkedBuyerIds.includes(currentBuyer) ? currentBuyer : linkedBuyerIds[0];
          next.buyer_id = nextBuyer;
          next.company_id = nextBuyer;
        }
      }
      if (name === "voucher_no") {
        next.bill_no = value;
      }
      if (name === "date") {
        next.bill_date = value;
      }
      if (name === "description") {
        next.journey_note = value;
      }
      if (name === "lorry_no" && !next.journey_token && editId) {
        next.journey_token = buildJourneyToken();
      }
      if ((name === "date" || name === "bill_date") && !next.journey_token && editId) {
        next.journey_token = buildJourneyToken();
      }
      if (activeVoucherType === "sale" && name === "unloading_date") {
        const dueDays = toNumber(prev.due_days);
        if (value && dueDays > 0) {
          const parsed = new Date(`${value}T00:00:00Z`);
          if (!Number.isNaN(parsed.getTime())) {
            parsed.setUTCDate(parsed.getUTCDate() + dueDays);
            next.due_date = parsed.toISOString().slice(0, 10);
          }
        } else if (!dueDays) {
          next.due_date = "";
        }
      }
      if (activeVoucherType === "sale" && name === "due_days") {
        const unloadingDate = prev.unloading_date || "";
        next.due_date = unloadingDate && value ? (() => {
          const parsed = new Date(`${unloadingDate}T00:00:00Z`);
          if (Number.isNaN(parsed.getTime())) return unloadingDate;
          parsed.setUTCDate(parsed.getUTCDate() + toNumber(value));
          return parsed.toISOString().slice(0, 10);
        })() : next.due_date;
      }
      if (
        activeVoucherType === "sale" &&
        ["dispatch_qty", "gross_weight", "tare_weight", "quantity", "unloading_qty", "shortage_quantity", "rate"].includes(name)
      ) {
        const derivedDispatchQty = saleDispatchQtyFromData(next);
        const derivedShortageQty = Math.max(derivedDispatchQty - toNumber(next.unloading_qty), 0);
        next.shortage_quantity = formatDecimal4(derivedShortageQty);
        next.shortage_amount = formatMoney(derivedShortageQty * toNumber(next.rate));
        if (!editId) {
          next.amount = saleGrossAmountFromData(next).toFixed(2);
        }
      }
      if (activeVoucherType === "sale" && name === "cd_percent") {
        const gross = saleGrossAmountFromData(next);
        next.cd_amount = (gross * toNumber(value) / 100).toFixed(2);
      }
      if (activeVoucherType === "sale" && name === "sale_type") {
        next.against_purchase_enabled = false;
        next.against_purchase_farmer_id = "";
        if (value === "direct") next.warehouse_id = "";
      }
      return next;
    });

    if (
      activeVoucherType === "sale" &&
      ["sale_type", "against_purchase_enabled", "against_purchase_farmer_id", "company_account_id", "product_id", "warehouse_id"].includes(name)
    ) {
      setSalePurchaseLinks([]);
    }

    if (activeVoucherType === "payment" && name === "company_account_id") {
      if (value) {
        loadPaymentFarmers(value, "", editId).catch((err) => {
          console.error("Failed to load payment account filters:", err);
          setAccountFarmers([]);
          setPaymentWarehouses([]);
        });
        setFormData((prev) => ({ ...prev, warehouse_id: "", farmer_id: "" }));
        setPartyOutstanding(null);
        setPaymentAdjustments([]);
        setShowPaymentAdjustPopup(false);
      } else {
        setAccountFarmers([]);
        setPaymentWarehouses([]);
        setPartyOutstanding(null);
        setPaymentAdjustments([]);
        setShowPaymentAdjustPopup(false);
      }
    }
    if (activeVoucherType === "payment" && name === "warehouse_id") {
      if (value && formData.company_account_id) {
        const selected = warehouses.find((w) => String(w.id || w._id) === String(value));
        if (selected) {
          setFormData((prev) => ({
            ...prev,
            location_id: prev.location_id || selected.location_id || "",
            employee_id: prev.employee_id || selected.employee_id || "",
            farmer_id: "",
          }));
        }
        loadPaymentFarmers(formData.company_account_id, value, editId).catch(() => setAccountFarmers([]));
        setPartyOutstanding(null);
        setPaymentAdjustments([]);
        setShowPaymentAdjustPopup(false);
      } else if (!value) {
        setAccountFarmers([]);
        setPartyOutstanding(null);
        setPaymentAdjustments([]);
        setShowPaymentAdjustPopup(false);
      }
    }
    if (activeVoucherType === "payment" && name === "farmer_id") {
      if (value) {
        loadOutstanding("farmer", value, formData.warehouse_id, editId, formData.company_account_id);
      } else {
        setPartyOutstanding(null);
      }
    }
    if (activeVoucherType === "receipt" && name === "company_id") {
      if (value) {
        loadOutstanding("company", value, formData.warehouse_id, null, formData.company_account_id).then(() => {
          if (toNumber(formData.amount) > 0) {
            setShowReceiptAdjustPopup(true);
          }
        });
      } else {
        setPartyOutstanding(null);
        setReceiptAdjustments([]);
        setShowReceiptAdjustPopup(false);
      }
    }
    if (activeVoucherType === "sale" && (name === "buyer_id" || name === "company_id")) {
      if (value) {
        loadOutstanding("company", value, formData.warehouse_id, null, formData.company_account_id);
      } else {
        setPartyOutstanding(null);
      }
    }
    if (name === "warehouse_id") {
      if (activeVoucherType === "payment" && formData.farmer_id && value) {
        loadOutstanding("farmer", formData.farmer_id, value, editId, formData.company_account_id);
      }
      if (activeVoucherType === "receipt" && formData.company_id) {
        loadOutstanding("company", formData.company_id, value, null, formData.company_account_id);
      }
      if (activeVoucherType === "sale" && (formData.buyer_id || formData.company_id)) {
        loadOutstanding("company", formData.buyer_id || formData.company_id, value, null, formData.company_account_id);
      }
    }
    if ((activeVoucherType === "receipt" || activeVoucherType === "sale") && name === "company_account_id" && (formData.company_id || formData.buyer_id)) {
      loadOutstanding("company", formData.company_id || formData.buyer_id, formData.warehouse_id, null, value);
    }
    if (activeVoucherType === "payment" && name === "amount") {
      // Amount entry must stay local. Do not open the adjustment panel or
      // trigger any report/ledger request automatically. The user can click
      // "Open Adjustment" when ready; Auto Adjust remains available there.
      if (toNumber(value) <= 0) {
        setPaymentAdjustments([]);
        setShowPaymentAdjustPopup(false);
      }
    }
    if (activeVoucherType === "receipt" && name === "amount") {
      if (toNumber(value) > 0 && formData.company_id) {
        setShowReceiptAdjustPopup(true);
      } else {
        setReceiptAdjustments([]);
        setShowReceiptAdjustPopup(false);
      }
    }
  };

  const buildWhatsappShareUrl = (message) => `https://wa.me/?text=${encodeURIComponent(message)}`;

  const sharePurchasePdfOnWhatsapp = async (voucherId, voucherNo, voucherDate) => {
    const response = await axios.get(`/api/wh-vouchers/purchase/${voucherId}/pdf`, {
      responseType: "blob",
    });
    const pdfBlob = new Blob([response.data], { type: "application/pdf" });
    const fileName = `Purchase-Voucher-${voucherNo || voucherId}.pdf`;
    const pdfFile = new File([pdfBlob], fileName, { type: "application/pdf" });
    const whatsappMessage = [
      "Purchase voucher attached.",
      `Voucher No: ${voucherNo || voucherId}`,
      `Date: ${formatLedgerDate(voucherDate)}`,
    ].join("\n");

    const pdfUrl = window.URL.createObjectURL(pdfBlob);
    const link = document.createElement("a");
    link.href = pdfUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.parentNode.removeChild(link);
    window.open(buildWhatsappShareUrl(`${whatsappMessage}\nPlease attach the downloaded PDF in WhatsApp.`), "_blank", "noopener,noreferrer");
    window.URL.revokeObjectURL(pdfUrl);
  };

  const saveVoucher = async () => {
    if (!formData.voucher_no || !formData.date) {
      alert("Voucher no. and date are required");
      return;
    }
    if (activeVoucherType === "payment") {
      const paymentAmount = toNumber(formData.amount);
      const paymentMode = normalizePaymentMode(formData.payment_mode);
      if (!formData.farmer_id) {
        alert("Please select farmer");
        return;
      }
      if (paymentAmount <= 0) {
        alert("Please enter payment amount first");
        return;
      }
      if (paymentMode === "against" && Math.abs(paymentAdjustmentTotal - paymentAmount) > 0.0001) {
        setShowPaymentAdjustPopup(true);
        alert("Payment amount and adjustment amount must match before saving");
        return;
      }
    }
    if (activeVoucherType === "receipt") {
      const receiptAmount = toNumber(formData.amount);
      if (!formData.company_id) {
        alert("Please select company");
        return;
      }
      if (receiptAmount <= 0) {
        alert("Please enter receipt amount first");
        return;
      }
      if (Math.abs(receiptAdjustmentTotal - receiptAmount) > 0.0001) {
        setShowReceiptAdjustPopup(true);
        alert("Receipt amount and adjustment amount must match before saving");
        return;
      }
    }
    if (activeVoucherType === "sale") {
      if (formData.sale_type !== "direct" && !formData.warehouse_id) {
        alert("Please select warehouse");
        return;
      }
      if (formData.sale_type === "direct") {
        if (!formData.location_id) {
          alert("Please select location for direct sale");
          return;
        }
        if (!formData.farmer_id) {
          alert("Please select farmer for direct sale purchase entry");
          return;
        }
        if (toNumber(formData.direct_purchase_rate) <= 0) {
          alert("Please enter purchase rate for direct sale");
          return;
        }
      }
      if (!formData.company_account_id) {
        alert("Please select account");
        return;
      }
      if (formData.sale_type !== "direct" && formData.against_purchase_enabled) {
        if (!formData.against_purchase_farmer_id) {
          alert("Please select farmer for Against Purchase Bill");
          return;
        }
        if (salePurchaseLinks.length === 0 || againstPurchaseTotalQty <= 0) {
          alert("Please enter quantity against at least one farmer purchase bill");
          return;
        }
        const saleQty = saleDispatchQtyFromData(formData);
        if (againstPurchaseTotalQty > saleQty + 0.0001) {
          alert("Against purchase quantity cannot exceed sale quantity");
          return;
        }
      }
    }
    setLoading(true);
    try {
      const numericFields = [
        "quantity",
        "dispatch_qty",
        "shortage_quantity",
        "unloading_qty",
        "rate",
        "amount",
        "claim_amount",
        "other_deduction",
        "cd_percent",
        "cd_amount",
        "adjustment_amount",
        "tds_amount",
        "direct_purchase_rate",
        "direct_purchase_amount",
        "net_receivable_amount",
        "fifo_rate",
        "fifo_amount",
        "packet",
        "gross_weight",
        "tare_weight",
        "dhalta",
        "less_bags_weight",
        "moisture",
        "dunki",
        "fungus",
        "discolour",
        "others",
        "transport_charge",
        "net_weight",
        "bags_claim",
        "labour",
        "total_deduct_amount",
        "total_qty",
        "total_deduction",
        "net_amount_payable",
        "round_off",
      ];
      const payload = { ...formData };
      numericFields.forEach((field) => {
        payload[field] = formData[field] ? Number(formData[field]) : 0;
      });
      if (activeVoucherType === "purchase") {
        payload.quantity = safePurchaseNetWeight;
        payload.net_weight = safePurchaseNetWeight;
        payload.total_qty = safePurchaseNetWeight;
        payload.claim_amount = purchaseClaimAmount;
        payload.bags_claim = purchaseClaimAmount;
        payload.cd_amount = toNumber(formData.cd_amount);
        payload.tds_amount = toNumber(formData.tds_amount);
        payload.other_deduction = toNumber(formData.other_deduction);
        payload.adjustment_amount = toNumber(formData.adjustment_amount);
        payload.transport_charge = toNumber(formData.transport_charge);
        payload.total_deduct_amount = purchaseTotalDeduction;
        payload.total_deduction = purchaseTotalDeduction;
        payload.amount = purchaseNetPayable;
        payload.net_amount_payable = purchaseNetPayable;
        payload.location_id = payload.location_id || selectedWarehouse?.location_id || "";
      }
      if (activeVoucherType === "sale") {
        payload.buyer_id = payload.buyer_id || payload.company_id || "";
        payload.company_id = payload.buyer_id;
        payload.dispatch_qty = saleDispatchQtyFromData(formData);
        payload.quantity = payload.dispatch_qty;
        payload.unloading_qty = payload.quantity;
        payload.amount = saleGrossAmountFromData(formData);
        const grossAmount = payload.amount;
        const claimAmount = Number(formData.claim_amount) || 0;
        const otherDeduction = Number(formData.other_deduction) || 0;
        const cdAmount = Number(payload.cd_amount) || Number((grossAmount * (Number(formData.cd_percent) || 0) / 100).toFixed(2)) || 0;
        const adjustmentAmount = Number(formData.adjustment_amount) || 0;
        const tdsAmount = Number(formData.tds_amount) || 0;
        const roundOff = Number(formData.round_off) || 0;
        payload.cd_amount = cdAmount;
        const netAmount = grossAmount - claimAmount - otherDeduction - cdAmount - adjustmentAmount - tdsAmount + roundOff;
        payload.net_amount = netAmount;
        payload.net_amount_payable = netAmount;
        payload.net_receivable_amount = netAmount;
        payload.outstanding = netAmount;
        const qtyForFifo = Number(payload.unloading_qty || payload.quantity) || 0;
        payload.fifo_rate = qtyForFifo > 0 ? grossAmount / qtyForFifo : 0;
        payload.fifo_amount = grossAmount;
        payload.sale_type = formData.sale_type === "direct" ? "direct" : "warehouse";
        payload.direct_purchase_amount = payload.sale_type === "direct"
          ? Number((payload.quantity * toNumber(formData.direct_purchase_rate)).toFixed(2))
          : 0;
        payload.against_purchase_enabled = payload.sale_type !== "direct" && Boolean(formData.against_purchase_enabled && salePurchaseLinks.length);
        payload.against_purchase_farmer_id = payload.sale_type === "direct" ? formData.farmer_id : (formData.against_purchase_farmer_id || "");
        payload.against_purchase_links = payload.against_purchase_enabled ? salePurchaseLinks : [];
        payload.create_against_purchase = payload.sale_type === "direct" && !editId;
        if (payload.sale_type === "direct") payload.warehouse_id = "";
      }
      if (activeVoucherType === "payment") {
        const paymentMode = normalizePaymentMode(formData.payment_mode);
        const paymentAdjustmentsPayload = paymentAdjustments
          .filter((item) => toNumber(item.adjusted_amount) > 0)
          .map((item) => ({
            purchase_id: item.purchase_id,
            voucher_no: item.voucher_no || item.purchase_voucher_no || "",
            adjusted_amount: toNumber(item.adjusted_amount),
          }));
        payload.payment_mode = paymentMode;
        payload.adjustments = paymentMode === "against" ? paymentAdjustmentsPayload : [];
        payload.reference_type = getPaymentReferenceType(paymentMode);
        payload.reference_id = paymentMode === "against"
          ? paymentAdjustments
            .map((item) => item.voucher_no || item.purchase_voucher_no || item.purchase_id)
            .filter(Boolean)
            .join(", ")
          : paymentMode === "new_reference"
            ? formData.reference_id || ""
            : "";
      }
      if (activeVoucherType === "receipt") {
        payload.adjustments = receiptAdjustments
          .filter((item) => toNumber(item.adjusted_amount) > 0)
          .map((item) => ({
            sale_id: item.sale_id,
            voucher_no: item.voucher_no || item.sale_voucher_no || "",
            adjusted_amount: toNumber(item.adjusted_amount),
          }));
        payload.reference_type = "sale";
        payload.reference_id = receiptAdjustments
          .map((item) => item.voucher_no || item.sale_voucher_no || item.sale_id)
          .filter(Boolean)
          .join(", ");
      }
      
      const isEdit = editId && String(editId).trim();
      const url = isEdit ? `/api/wh-vouchers/${activeVoucherType}/${editId}` : `/api/wh-vouchers/${activeVoucherType}`;
      const requestHeaders = typeof window !== "undefined" && localStorage.getItem("token")
        ? { Authorization: `Bearer ${localStorage.getItem("token")}` }
        : {};
      const res = isEdit
        ? await axios.put(url, payload, { headers: requestHeaders })
        : await axios.post(url, payload, { headers: requestHeaders });
      
      alert(`Voucher ${isEdit ? "updated" : "saved"} successfully`);
      if (res.data?.stats) {
        setPartyOutstanding(res.data.stats);
      }
      setFormData(defaultForm());
      setPaymentAdjustments([]);
      setReceiptAdjustments([]);
      setSalePurchaseLinks([]);
      setPartyOutstanding(null);
      setShowPaymentAdjustPopup(false);
      setShowReceiptAdjustPopup(false);
      setEditId(null);
      setVoucherPage(1);
      await loadVouchers();
      if (!isEdit) fetchNextVoucherNo(activeVoucherType);

      if (activeVoucherType === "purchase") {
        const shouldShare = window.confirm("Purchase voucher saved. Do you want to send the PDF on WhatsApp?");
        if (shouldShare) {
          try {
            await sharePurchasePdfOnWhatsapp(res.data?.id || res.data?.voucher_id || res.data?.insertId || formData.voucher_no, formData.voucher_no, formData.date);
          } catch (shareErr) {
            console.error("WhatsApp share failed:", shareErr);
            alert("Voucher saved, but WhatsApp share could not be completed.");
          }
        }
        if (purchasePreviewRow) {
          const nextFilters = {
            ...reportFilters,
            farmer_id: purchasePreviewRow.farmer_id || reportFilters.farmer_id,
            warehouse_id: purchasePreviewRow.warehouse_id || reportFilters.warehouse_id,
            company_account_id:
              purchasePreviewRow.company_account_id || purchasePreviewRow.account_id || reportFilters.company_account_id,
          };
          setShowPurchasePreview(false);
          setPurchasePreviewRow(null);
          setPurchasePreviewOpenedFromLedger(false);
          setActiveTab("reports");
          if (purchasePreviewOpenedFromLedger) {
            setActiveReport("purchase-party-ledger");
            setReportPage(1);
            setReportFilters(nextFilters);
            await loadReport("purchase-party-ledger", 1, nextFilters);
          } else {
            setActiveReport("purchase");
            await loadReport("purchase", 1, nextFilters);
          }
          return;
        }
      }
    } catch (err) {
      console.error(err);
      alert(err?.response?.data?.error || `Failed to ${editId ? "update" : "save"} voucher`);
    } finally {
      setLoading(false);
    }
  };

  const handleFormKeyDown = (event) => {
    if (event.key !== "Enter") return;

    const target = event.target;
    const isButtonTarget = target?.tagName === "BUTTON" || target?.closest("button");
    const isSubmitButton = isButtonTarget && (target?.type === "submit" || target?.closest("button[type='submit']"));

    if (isSubmitButton || isButtonTarget) {
      return;
    }

    if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // For purchase vouchers we allow direct save from the form (preview is optional)
    await saveVoucher();
  };

  const isPurchaseVoucher = activeVoucherType === "purchase";
  const isPaymentVoucher = activeVoucherType === "payment";
  const isReceiptVoucher = activeVoucherType === "receipt";
  const isSaleVoucher = activeVoucherType === "sale";
  const activePaymentMode = normalizePaymentMode(formData.payment_mode);

  const handleDeleteVoucher = async (voucherId) => {
    if (!window.confirm("Are you sure you want to delete this voucher?")) return;
    try {
      await axios.delete(`/api/wh-vouchers/${activeVoucherType}/${voucherId}`);
      alert("Voucher deleted successfully");
      loadVouchers();
    } catch (err) {
      console.error(err);
      alert(err?.response?.data?.error || "Failed to delete voucher");
    }
  };

  const handleEditVoucher = async (voucherId) => {
    const voucher = list.find((v) => String(v.id || v._id) === String(voucherId));
    if (!voucher) return;

    try {
      if (activeVoucherType === "receipt") {
        setLoading(true);
        const res = await axios.get(`/api/wh-vouchers/receipt/${voucherId}`);
        const receipt = res.data;
        setFormData({ ...defaultForm(), ...receipt });
        const existingAdjustments = Array.isArray(receipt.adjustments)
          ? receipt.adjustments.map((item) => ({
              sale_id: String(item.sale_id || item.id || ""),
              voucher_no: item.voucher_no || item.sale_voucher_no || "",
              adjusted_amount: toNumber(item.adjusted_amount),
            })).filter((item) => item.sale_id && item.adjusted_amount > 0)
          : [];
        setReceiptAdjustments(existingAdjustments);
        if (receipt.company_id) {
          loadOutstanding("company", receipt.company_id, receipt.warehouse_id, null, receipt.company_account_id);
        }
      } else {
        setFormData({
          ...defaultForm(),
          ...voucher,
          due_date: voucher.due_date || voucher.unloading_date || "",
        });
        if (activeVoucherType === "sale") {
          const existingLinks = Array.isArray(voucher.against_purchase_links)
            ? voucher.against_purchase_links.map((item) => ({
                purchase_id: String(item.purchase_id || item.id || ""),
                voucher_no: item.voucher_no || item.purchase_voucher_no || "",
                farmer_id: String(item.farmer_id || voucher.against_purchase_farmer_id || ""),
                quantity: toNumber(item.quantity),
                rate: toNumber(item.rate),
                amount: toNumber(item.amount),
              })).filter((item) => item.purchase_id && item.quantity > 0)
            : [];
          setSalePurchaseLinks(existingLinks);
        }
        if (activeVoucherType === "payment") {
          setLoading(true);
          try {
            const res = await axios.get(`/api/wh-vouchers/payment/${voucherId}`);
            const payment = res.data;
            const paymentMode = inferPaymentMode(payment);
            const existingAdjustments = Array.isArray(payment.adjustments)
              ? payment.adjustments.map((item) => ({
                  purchase_id: String(item.purchase_id || item.id || ""),
                  voucher_no: item.purchase_voucher_no || item.voucher_no || item.purchase_voucher_no || "",
                  adjusted_amount: toNumber(item.adjusted_amount),
                })).filter((item) => item.purchase_id && item.adjusted_amount > 0)
              : [];
            setFormData({
              ...defaultForm(),
              ...payment,
              payment_mode: paymentMode,
              reference_type: getPaymentReferenceType(paymentMode),
              reference_id: paymentMode === "new_reference" ? payment.reference_id || "" : "",
            });
            setPaymentAdjustments(paymentMode === "against" ? existingAdjustments : []);
            if (payment.company_account_id) {
              try {
                // Edit mode must use the same account + warehouse + exclude-current-payment
                // lookup as the normal Pending Farmer selector. This prevents the old
                // filter-options request from selecting the wrong farmer/balance.
                await loadPaymentFarmers(
                  payment.company_account_id,
                  payment.warehouse_id || "",
                  voucherId
                );
              } catch (farmerErr) {
                console.error("Failed to load payment farmers for edit:", farmerErr);
                setAccountFarmers([]);
                setPaymentWarehouses([]);
              }
            }
            // Ensure farmer appears in account-specific farmer list so dropdown shows it
            if (payment.company_account_id && payment.farmer_id) {
              const fid = String(payment.farmer_id || "");
              const loadedFarmers = await loadPaymentFarmers(
                payment.company_account_id,
                payment.warehouse_id || "",
                voucherId
              ).catch(() => []);
              const existsInAccount = (loadedFarmers || []).some((f) => String(f.id || f._id) === fid);
              if (!existsInAccount) {
                const farmerFromAll = (farmers || []).find((f) => String(f.id || f._id) === fid);
                if (farmerFromAll) {
                  setAccountFarmers((prev) => (Array.isArray(prev) ? [...prev, farmerFromAll] : [farmerFromAll]));
                } else {
                  setAccountFarmers((prev) => (Array.isArray(prev) ? [...prev, { id: fid, name: String(payment.farmer_name || "Unknown farmer").trim() }] : [{ id: fid, name: String(payment.farmer_name || "Unknown farmer").trim() }]));
                }
              }
            }

            if (payment.farmer_id) {
              await loadOutstanding("farmer", payment.farmer_id, payment.warehouse_id, voucherId, payment.company_account_id);
              if (paymentMode === "against") {
                setShowPaymentAdjustPopup(true);
              }
            }
          } catch (err) {
            console.error(err);
            alert(err?.response?.data?.error || "Failed to load payment voucher for edit");
            setLoading(false);
            return;
          } finally {
            setLoading(false);
          }
        }
      }
      setEditId(voucherId);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      console.error(err);
      alert(err?.response?.data?.error || "Failed to load voucher for edit");
    } finally {
      setLoading(false);
    }
  };

  const handleEditPurchaseReport = (voucher) => {
    const voucherId = voucher?.purchase_id || voucher?.id || voucher?._id;
    if (!voucherId) return;
    setActiveTab("vouchers");
    setActiveVoucherType("purchase");
    setPurchasePreviewRow(voucher || null);
    setShowPurchasePreview(false);
    const nextForm = { ...defaultForm(), ...voucher };
    setFormData(nextForm);
    setPurchaseBaseline({
      less_bags_weight: nextForm.less_bags_weight || "",
      moisture: nextForm.moisture || "",
      dunki: nextForm.dunki || "",
      fungus: nextForm.fungus || "",
      discolour: nextForm.discolour || "",
      others: nextForm.others || "",
      bags_claim: nextForm.bags_claim || "",
      labour: nextForm.labour || "",
      transport_charge: nextForm.transport_charge || "",
      round_off: nextForm.round_off || "",
    });
    setEditId(voucherId);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleGeneratePDF = async (voucherId) => {
    try {
      const response = await axios.get(`/api/wh-vouchers/${activeVoucherType}/${voucherId}/pdf`, {
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `${activeVoucherType === "sale" ? "Sale" : "Purchase"}-Voucher-${voucherId}.pdf`);
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
    } catch (err) {
      console.error(err);
      alert("Failed to generate PDF");
    }
  };

  const handlePurchaseReportPDF = async (voucherId) => {
    try {
      const response = await axios.get(`/api/wh-vouchers/purchase/${voucherId}/pdf`, {
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `Purchase-Memo-${voucherId}.pdf`);
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
    } catch (err) {
      console.error(err);
      alert("Failed to generate PDF");
    }
  };

  const handleDownloadPurchasePdfFromPreview = async () => {
    const voucherId = purchasePreviewRow?.purchase_id || purchasePreviewRow?.id || purchasePreviewRow?._id;
    if (!voucherId) return;
    await handlePurchaseReportPDF(voucherId);
  };

  const showPurchaseReportPreview = async (voucher, fromLedger = false) => {
    const recordId = getRecordId(voucher);
    const baseRow = voucher || null;
    setPurchasePreviewRow(baseRow);
    setPurchasePreviewOpenedFromLedger(fromLedger);
    setShowPurchasePreview(true);
    setPurchasePreviewLoading(Boolean(recordId));

    if (!recordId) return;

    try {
      const res = await axios.get(`/api/wh-vouchers/purchase/${recordId}`);
      if (res?.data) {
        setPurchasePreviewRow(res.data);
      }
    } catch (err) {
      console.error("Failed to load full purchase voucher preview:", err);
      setPurchasePreviewRow(baseRow);
    } finally {
      setPurchasePreviewLoading(false);
    }
  };

  const showSaleReportPreview = (voucher) => {
    setSalePreviewRow(voucher);
    setSalePreviewSummary(null);
    setShowSalePreview(true);
  };

  const resetPurchaseDeductions = () => {
    setFormData((prev) => ({
      ...prev,
      ...purchaseAutoFillDefaults,
    }));
  };

  const capturePurchaseDeductionsAsDefault = () => {
    setPurchaseBaseline({
      less_bags_weight: formData.less_bags_weight || "",
      moisture: formData.moisture || "",
      dunki: formData.dunki || "",
      fungus: formData.fungus || "",
      discolour: formData.discolour || "",
      others: formData.others || "",
      bags_claim: formData.bags_claim || "",
      labour: formData.labour || "",
      transport_charge: formData.transport_charge || "",
      round_off: formData.round_off || "",
    });
  };

  const getPurchasePreviewData = () => ({
    voucherNo: formData.voucher_no || "-",
    date: formatLedgerDate(formData.date),
    party: selectedFarmer?.name || "-",
    warehouse: selectedWarehouse?.name || "-",
    account: getAccountName({ company_account_id: formData.company_account_id }),
    product: getProductName({ product_id: formData.product_id }),
    packet: formatDecimal4(formData.packet),
    grossWeight: formatDecimal4(formData.gross_weight),
    tareWeight: formatDecimal4(formData.tare_weight),
    newWeight: formatDecimal4(safePurchaseNewWeight),
    netQty: formatDecimal4(safePurchaseNetWeight),
    rate: formatMoney(formData.rate),
    grossAmount: formatMoney(purchaseGrossAmount),
    totalDeduction: formatMoney(purchaseTotalDeduction),
    netPayable: formatMoney(purchaseNetPayable),
  });

  const getPurchasePreviewDataForRow = (row) => {
    const newWeight = Math.max(toNumber(row?.gross_weight) - toNumber(row?.tare_weight), 0);
    const netQty = toNumber(row?.total_qty || row?.total_quantity || row?.net_weight || row?.quantity || 0);
    const grossAmount = toNumber(row?.gross_amount || row?.amount || 0);
    const totalDeduction =
      toNumber(row?.total_deduction) ||
      toNumber(row?.less_bags_weight) +
        toNumber(row?.moisture) +
        toNumber(row?.dunki) +
        toNumber(row?.fungus) +
        toNumber(row?.discolour) +
        toNumber(row?.others) +
        toNumber(row?.bags_claim) +
        toNumber(row?.labour);

    return {
      voucherNo: row?.voucher_no || "-",
      date: formatLedgerDate(row?.date),
      party: row?.farmer_name || getFarmerName(row) || "-",
      warehouse: getWarehouseName(row),
      account: getAccountName(row),
      product: getProductName(row),
      packet: formatDecimal4(row?.packet),
      grossWeight: formatDecimal4(row?.gross_weight),
      tareWeight: formatDecimal4(row?.tare_weight),
      newWeight: formatDecimal4(row?.new_weight || newWeight),
      netQty: formatDecimal4(netQty),
      rate: formatMoney(row?.rate),
      grossAmount: formatMoney(grossAmount || netQty * toNumber(row?.rate)),
      totalDeduction: formatMoney(totalDeduction),
      netPayable: formatMoney(row?.net_amount_payable || row?.total_amount || row?.amount || grossAmount - totalDeduction),
      lessBagsWeight: formatMoney(row?.less_bags_weight),
      moisture: formatMoney(row?.moisture),
      dunki: formatMoney(row?.dunki),
      fungus: formatMoney(row?.fungus),
      discolour: formatMoney(row?.discolour),
      others: formatMoney(row?.others),
      transportCharge: formatMoney(row?.transport_charge),
      bagsClaim: formatMoney(row?.bags_claim),
      labour: formatMoney(row?.labour),
    };
  };

  const getSalePreviewDataForRow = (row) => {
    const grossAmount = toNumber(row?.amount || row?.gross_amount || 0);
    const saleQty = toNumber(row?.quantity || row?.unloading_qty || row?.total_quantity || 0);
    const grossWeight = toNumber(row?.gross_weight || row?.dispatch_qty || saleQty || 0);
    const netQty = toNumber(row?.unloading_qty || row?.quantity || row?.total_quantity || saleQty || 0);
    const claimAmount = toNumber(row?.claim_amount || 0);
    const shortageAmount = toNumber(row?.shortage_amount || 0);
    const otherDeduction = toNumber(row?.other_deduction || 0);
    const cdAmount = toNumber(row?.cd_amount || 0);
    const adjustmentAmount = toNumber(row?.adjustment_amount || 0);
    const tdsAmount = toNumber(row?.tds_amount || 0);
    const roundOff = toNumber(row?.round_off || 0);
    const totalDeduction = toNumber(row?.total_deduction || (claimAmount + otherDeduction + cdAmount + adjustmentAmount + tdsAmount - roundOff));
    const netPayable = toNumber(row?.net_amount_payable || row?.net_receivable_amount || row?.outstanding || grossAmount - totalDeduction + roundOff);
    const purchaseLinks = Array.isArray(row?.against_purchase_links) ? row.against_purchase_links : [];
    const directPurchaseAmount = toNumber(row?.direct_purchase_amount || purchaseLinks.reduce((sum, item) => sum + toNumber(item.amount || 0), 0));
    const directPurchaseRate = toNumber(row?.direct_purchase_rate || purchaseLinks[0]?.rate || 0);
    const directPurchaseQty = toNumber(row?.total_qty || row?.total_quantity || row?.quantity || purchaseLinks.reduce((sum, item) => sum + toNumber(item.quantity || 0), 0));

    return {
      voucherNo: row?.voucher_no || "-",
      date: formatLedgerDate(row?.date),
      unloadingDate: formatLedgerDate(row?.unloading_date || row?.date),
      saleType: titleCase(row?.sale_type || "direct"),
      party: getBuyerName(row) || row?.party_name || row?.company_name || "-",
      farmer: row?.farmer_name || getFarmerName(row) || "-",
      location: row?.location_name || selectedLocationName || getWarehouseName(row) || "-",
      warehouse: getWarehouseName(row) || "-",
      product: getProductName(row) || "-",
      account: getAccountName(row) || row?.company_account_name || "-",
      lorryNo: row?.lorry_no || row?.reference_id || "-",
      consignee: row?.consignee_name || selectedConsignee?.name || "-",
      quantity: formatDecimal4(saleQty),
      grossWeight: formatDecimal4(grossWeight),
      rate: formatMoney(row?.rate || 0),
      grossAmount: formatMoney(grossAmount),
      claimAmount: formatMoney(claimAmount),
      shortageAmount: formatMoney(shortageAmount),
      otherDeduction: formatMoney(otherDeduction),
      cdAmount: formatMoney(cdAmount),
      adjustmentAmount: formatMoney(adjustmentAmount),
      tdsAmount: formatMoney(tdsAmount),
      roundOff: formatMoney(roundOff),
      totalDeduction: formatMoney(totalDeduction),
      netPayable: formatMoney(netPayable),
      netReceivable: formatMoney(row?.net_receivable_amount || netPayable),
      directPurchaseQty: formatDecimal4(directPurchaseQty),
      directPurchaseRate: formatMoney(directPurchaseRate),
      directPurchaseAmount: formatMoney(directPurchaseAmount),
      paymentDetails: Array.isArray(row?.payment_details) ? row.payment_details : [],
      journalDetails: Array.isArray(row?.journal_details) ? row.journal_details : [],
      purchaseLinks,
      profitLoss: formatMoney(netPayable - directPurchaseAmount),
      profitLossLabel: netPayable - directPurchaseAmount >= 0 ? "Net Profit" : "Net Loss",
    };
  };

  useEffect(() => {
    const loadSalePreviewSummary = async () => {
      if (!showSalePreview || !salePreviewRow) return;
      const saleId = salePreviewRow.id || salePreviewRow._id;
      if (!saleId) {
        setSalePreviewSummary(salePreviewRow);
        return;
      }
      setSalePreviewLoading(true);
      try {
        const response = await axios.get(`/api/wh-vouchers/sale/${saleId}/summary`);
        setSalePreviewSummary(response.data || salePreviewRow);
      } catch (err) {
        setSalePreviewSummary(salePreviewRow);
      } finally {
        setSalePreviewLoading(false);
      }
    };
    loadSalePreviewSummary();
  }, [showSalePreview, salePreviewRow]);

  const downloadPurchaseImportTemplate = async () => {
    try {
      const response = await axios.get("/api/wh-vouchers/purchase/import-template", {
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", "purchase_voucher_import_format.xlsx");
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert(err?.response?.data?.error || "Failed to download import format");
    }
  };

  const handlePurchaseExcelImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const fileName = file.name.toLowerCase();
    if (!fileName.endsWith(".xlsx") && !fileName.endsWith(".xls")) {
      alert("Please select an Excel file (.xlsx or .xls)");
      return;
    }
    const uploadForm = new FormData();
    uploadForm.append("file", file);
    setImportingPurchase(true);
    try {
      const res = await axios.post("/api/wh-vouchers/purchase/import-xlsx", uploadForm, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const imported = Number(res.data?.imported || 0);
      const failed = Number(res.data?.failed || 0);
      const errors = Array.isArray(res.data?.errors) ? res.data.errors : [];
      const errorText = errors
        .slice(0, 8)
        .map((item) => `Row ${item.row}: ${item.error}`)
        .join("\n");
      alert(`Purchase import complete.\nImported: ${imported}\nFailed: ${failed}${errorText ? `\n\n${errorText}` : ""}`);
      setActiveVoucherType("purchase");
      await loadVouchers();
      if (activeTab === "reports") await loadReport();
      fetchNextVoucherNo("purchase");
    } catch (err) {
      console.error(err);
      alert(err?.response?.data?.error || "Purchase import failed");
    } finally {
      setImportingPurchase(false);
    }
  };

  const downloadPaymentImportTemplate = async () => {
    try {
      const response = await axios.get("/api/wh-vouchers/payment/import-template", {
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", "payment_voucher_import_format.xlsx");
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert(err?.response?.data?.error || "Failed to download payment format");
    }
  };

  const handlePaymentExcelImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const fileName = file.name.toLowerCase();
    if (!fileName.endsWith(".xlsx") && !fileName.endsWith(".xls")) {
      alert("Please select an Excel file (.xlsx or .xls)");
      return;
    }
    const uploadForm = new FormData();
    uploadForm.append("file", file);
    setImportingPayment(true);
    try {
      const res = await axios.post("/api/wh-vouchers/payment/import-xlsx", uploadForm, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const imported = Number(res.data?.imported || 0);
      const failed = Number(res.data?.failed || 0);
      const errors = Array.isArray(res.data?.errors) ? res.data.errors : [];
      const errorText = errors
        .slice(0, 8)
        .map((item) => `Row ${item.row}: ${item.error}`)
        .join("\n");
      alert(`Payment import complete.\nImported: ${imported}\nFailed: ${failed}${errorText ? `\n\n${errorText}` : ""}`);
      setActiveVoucherType("payment");
      await loadVouchers();
      if (activeTab === "reports") await loadReport();
      fetchNextVoucherNo("payment");
    } catch (err) {
      console.error(err);
      alert(err?.response?.data?.error || "Payment import failed");
    } finally {
      setImportingPayment(false);
    }
  };

  const downloadReceiptImportTemplate = async () => {
    try {
      const response = await axios.get("/api/wh-vouchers/receipt/import-template", {
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", "receipt_voucher_import_format.xlsx");
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert(err?.response?.data?.error || "Failed to download receipt format");
    }
  };

  const handleReceiptExcelImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const fileName = file.name.toLowerCase();
    if (!fileName.endsWith(".xlsx") && !fileName.endsWith(".xls")) {
      alert("Please select an Excel file (.xlsx or .xls)");
      return;
    }
    const uploadForm = new FormData();
    uploadForm.append("file", file);
    setImportingReceipt(true);
    try {
      const res = await axios.post("/api/wh-vouchers/receipt/import-xlsx", uploadForm, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const imported = Number(res.data?.imported || 0);
      const failed = Number(res.data?.failed || 0);
      const errors = Array.isArray(res.data?.errors) ? res.data.errors : [];
      const errorText = errors
        .slice(0, 8)
        .map((item) => `Row ${item.row}: ${item.error}`)
        .join("\n");
      alert(`Receipt import complete.\nImported: ${imported}\nFailed: ${failed}${errorText ? `\n\n${errorText}` : ""}`);
      setActiveVoucherType("receipt");
      await loadVouchers();
      if (activeTab === "reports") await loadReport();
      fetchNextVoucherNo("receipt");
    } catch (err) {
      console.error(err);
      alert(err?.response?.data?.error || "Receipt import failed");
    } finally {
      setImportingReceipt(false);
    }
  };

  const openPaymentAdjustmentPopup = async () => {
    if (activeVoucherType !== "payment") return;
    if (toNumber(formData.amount) <= 0) {
      alert("Please enter amount first");
      return;
    }
    if (!formData.farmer_id) {
      alert("Please select farmer");
      return;
    }
    const outstandingMatchesSelection =
      partyOutstanding &&
      String(partyOutstanding?.party_id || partyOutstanding?.farmer_id || partyOutstanding?.id || "") === String(formData.farmer_id) &&
      String(partyOutstanding?.warehouse_id || "") === String(formData.warehouse_id || "") &&
      String(partyOutstanding?.company_account_id || "") === String(formData.company_account_id || "") &&
      String(partyOutstanding?.exclude_payment_id || "") === String(editId || "") &&
      Array.isArray(partyOutstanding?.purchases);
    if (!outstandingMatchesSelection) {
      await loadOutstanding("farmer", formData.farmer_id, formData.warehouse_id, editId, formData.company_account_id);
    }
    setShowPaymentAdjustPopup(true);
  };

  const openReceiptAdjustmentPopup = async () => {
    if (activeVoucherType !== "receipt") return;
    if (toNumber(formData.amount) <= 0) {
      alert("Please enter amount first");
      return;
    }
    if (!formData.company_id) {
      alert("Please select company");
      return;
    }
    await loadOutstanding("company", formData.company_id, formData.warehouse_id, null, formData.company_account_id);
    setShowReceiptAdjustPopup(true);
  };

  const selectSaleVoucherForPass = (voucherId) => {
    const voucher = list.find((item) => String(item.id || item._id) === String(voucherId));
    if (!voucher) return;

    const billDate = voucher.bill_date || voucher.date || "";
    const loadingDate = voucher.date || billDate || "";
    const existingUnloadingDate = voucher.unloading_date || "";
    const existingDueDays = voucher.due_days !== undefined && voucher.due_days !== null && String(voucher.due_days).trim() !== ""
      ? toNumber(voucher.due_days)
      : "";
    const rawDueDate = voucher.due_date || "";
    const computedDueDate = existingUnloadingDate && existingDueDays > 0
      ? (() => {
          const parsed = new Date(`${existingUnloadingDate}T00:00:00Z`);
          if (Number.isNaN(parsed.getTime())) return rawDueDate;
          parsed.setUTCDate(parsed.getUTCDate() + existingDueDays);
          return parsed.toISOString().slice(0, 10);
        })()
      : rawDueDate;
    const derivedDueDays = existingDueDays !== "" ? existingDueDays : (computedDueDate && existingUnloadingDate ? diffDays(existingUnloadingDate, computedDueDate) : "");

    const selectedDispatchQty = saleDispatchQtyFromData(voucher);
    const selectedAmount = (voucher.amount !== undefined && voucher.amount !== null && String(voucher.amount).trim() !== "")
      ? voucher.amount
      : (voucher.total_amount !== undefined && voucher.total_amount !== null && String(voucher.total_amount).trim() !== "")
        ? voucher.total_amount
        : saleGrossAmountFromData(voucher).toFixed(2);
    const cdPercent = voucher.cd_percent || "";
    const cdAmount = voucher.cd_amount !== undefined && voucher.cd_amount !== null && String(voucher.cd_amount).trim() !== ""
      ? voucher.cd_amount
      : cdPercent
        ? Number((Number(selectedAmount) * toNumber(cdPercent) / 100).toFixed(2))
        : "";

    setFormData({
      ...defaultForm(),
      ...voucher,
      date: loadingDate,
      bill_date: billDate,
      voucher_no: voucher.voucher_no || voucher.bill_no || "",
      bill_no: voucher.bill_no || voucher.voucher_no || "",
      journey_token: voucher.journey_token || "",
      buyer_id: voucher.buyer_id || voucher.company_id || "",
      company_id: voucher.company_id || voucher.buyer_id || "",
      lorry_no: voucher.lorry_no || voucher.reference_id || "",
      dispatch_qty: formatDecimal4(selectedDispatchQty),
      amount: selectedAmount,
      unloading_qty: voucher.unloading_qty !== undefined && voucher.unloading_qty !== null ? voucher.unloading_qty : "",
      unloading_date: existingUnloadingDate || "",
      due_days: derivedDueDays,
      due_date: computedDueDate || "",
      moisture: voucher.moisture || "",
      dunki: voucher.dunki || "",
      fungus: voucher.fungus || "",
      discolour: voucher.discolour || "",
      others: voucher.others || "",
      claim_amount: voucher.claim_amount !== undefined && voucher.claim_amount !== null && String(voucher.claim_amount).trim() !== ""
        ? voucher.claim_amount
        : voucher.shortage_amount !== undefined && voucher.shortage_amount !== null && String(voucher.shortage_amount).trim() !== ""
          ? voucher.shortage_amount
          : "",
      other_deduction: voucher.other_deduction !== undefined && voucher.other_deduction !== null && String(voucher.other_deduction).trim() !== ""
        ? voucher.other_deduction
        : voucher.adjustment_amount !== undefined && voucher.adjustment_amount !== null && String(voucher.adjustment_amount).trim() !== ""
          ? voucher.adjustment_amount
          : "",
      cd_percent: cdPercent,
      cd_amount: cdAmount,
      tds_amount: voucher.tds_amount !== undefined && voucher.tds_amount !== null && String(voucher.tds_amount).trim() !== "" ? voucher.tds_amount : "",
      transport_charge: voucher.transport_charge !== undefined && voucher.transport_charge !== null && String(voucher.transport_charge).trim() !== "" ? voucher.transport_charge : "",
      journey_note: voucher.journey_note || voucher.description || "",
    });
    setEditId(voucher.id || voucher._id);
  };

  const applyJourneyTemplate = (templateId) => {
    setJourneyTemplateId(templateId);
    const template = selectedSalePassJourneyRows.find((row) => String(row.id || row._id) === String(templateId));
    if (!template) return;

    setFormData((prev) => ({
      ...prev,
      buyer_id: template.buyer_id || template.company_id || prev.buyer_id || prev.company_id || "",
      company_id: template.company_id || template.buyer_id || prev.company_id || prev.buyer_id || "",
      consignee_id: template.consignee_id || prev.consignee_id || "",
      lorry_no: template.lorry_no || template.reference_id || prev.lorry_no || "",
      rate: template.rate || prev.rate || "",
      dispatch_qty: formatDecimal4(toNumber(template.dispatch_qty || template.quantity || template.total_quantity || template.unloading_qty || saleDispatchQty)),
      unloading_qty: template.unloading_qty || "",
    }));
  };

  const saveSaleVoucherPass = async () => {
    if (!editId) {
      alert("Please select sale bill");
      return;
    }
    if (!formData.unloading_date) {
      alert("Please enter unloading date");
      return;
    }
    if (saleUnloadingQty <= 0) {
      alert("Please enter unloading weight");
      return;
    }

    const finalTdsAmount = tdsEligible ? autoTdsAmount : toNumber(formData.tds_amount);
    const finalCdAmount = Number((saleBillAmountFromData(formData) * toNumber(formData.cd_percent) / 100).toFixed(2));
    const unloadingDate = formData.unloading_date || "";
    const dueDays = formData.due_days !== undefined && formData.due_days !== null && String(formData.due_days).trim() !== "" ? toNumber(formData.due_days) : "";
    const dueDate = formData.due_date || (unloadingDate && dueDays !== "" ? (() => {
      const parsed = new Date(`${unloadingDate}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime())) return "";
      parsed.setUTCDate(parsed.getUTCDate() + toNumber(dueDays));
      return parsed.toISOString().slice(0, 10);
    })() : "");
    const payload = {
      ...formData,
      deduction_only: true,
      voucher_no: formData.voucher_no || null,
      date: formData.date || null,
      bill_no: formData.bill_no || formData.voucher_no || null,
      bill_date: formData.bill_date || formData.date || null,
      journey_token: formData.journey_token || buildJourneyToken(),
      unloading_date: unloadingDate,
      due_days: dueDays,
      due_date: dueDate,
      unloading_qty: saleUnloadingQty,
      shortage_quantity: saleShortageQty,
      shortage_amount: saleShortageAmount,
      claim_amount: saleShortageAmount,
      other_deduction: saleQualityDeduction,
      transport_charge: saleTransportCharge,
      cd_amount: finalCdAmount,
      total_deduction: saleQualityDeduction + saleTransportCharge + finalCdAmount,
      tds_amount: finalTdsAmount,
      reject_qty: toNumber(formData.reject_qty),
      amount: saleBillAmountFromData(formData),
    };

    setLoading(true);
    try {
      await axios.put(`/api/wh-vouchers/sale/${editId}`, payload);
      alert("Sale voucher pass saved successfully");
      const remainingQtyAfterSave = Math.max(saleDispatchQty - saleUnloadingQty, 0);
      const nextVoucherNo = await axios
        .get(`/api/wh-vouchers/next-voucher-no`, { params: { type: "sale" } })
        .then((res) => res.data?.voucher_no || "")
        .catch(() => "");
      setShowSaleDeductionModal(false);
      setFormData({
        ...defaultForm(),
        warehouse_id: formData.warehouse_id || "",
        company_account_id: "",
        employee_id: formData.employee_id || "",
        location_id: formData.location_id || "",
        lorry_no: formData.lorry_no || "",
        journey_token: formData.journey_token || buildJourneyToken(),
        bill_no: nextVoucherNo || "",
        voucher_no: nextVoucherNo || "",
        bill_date: new Date().toISOString().slice(0, 10),
        date: new Date().toISOString().slice(0, 10),
      dispatch_qty: remainingQtyAfterSave > 0 ? remainingQtyAfterSave.toFixed(4) : "",
      add_qty: "",
      unloading_qty: "",
        company_id: "",
        buyer_id: "",
        consignee_id: "",
        product_id: "",
        rate: "",
        unloading_date: "",
        due_days: "",
        due_date: "",
      });
      setEditId(null);
      await loadVouchers();
      if (activeTab === "reports") await loadReport();
      fetchNextVoucherNo(activeVoucherType);
    } catch (err) {
      console.error(err);
      alert(err?.response?.data?.error || "Failed to save sale voucher pass");
    } finally {
      setLoading(false);
    }
  };

  const saveSaleVoucherPassAndNew = async () => {
    if (!editId) {
      alert("Please select sale bill");
      return;
    }
    if (!formData.unloading_date) {
      alert("Please enter unloading date");
      return;
    }
    if (saleUnloadingQty <= 0) {
      alert("Please enter unloading weight");
      return;
    }

    const finalTdsAmount = tdsEligible ? autoTdsAmount : toNumber(formData.tds_amount);
    const finalCdAmount = Number((saleBillAmountFromData(formData) * toNumber(formData.cd_percent) / 100).toFixed(2));
    const unloadingDate = formData.unloading_date || "";
    const dueDays = formData.due_days !== undefined && formData.due_days !== null && String(formData.due_days).trim() !== "" ? toNumber(formData.due_days) : "";
    const dueDate = formData.due_date || (unloadingDate && dueDays !== "" ? (() => {
      const parsed = new Date(`${unloadingDate}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime())) return "";
      parsed.setUTCDate(parsed.getUTCDate() + toNumber(dueDays));
      return parsed.toISOString().slice(0, 10);
    })() : "");
    const payload = {
      ...formData,
      deduction_only: true,
      voucher_no: formData.voucher_no || null,
      date: formData.date || null,
      bill_no: formData.bill_no || formData.voucher_no || null,
      bill_date: formData.bill_date || formData.date || null,
      journey_token: formData.journey_token || buildJourneyToken(),
      unloading_date: unloadingDate,
      due_days: dueDays,
      due_date: dueDate,
      unloading_qty: saleUnloadingQty,
      shortage_quantity: saleShortageQty,
      shortage_amount: saleShortageAmount,
      claim_amount: saleShortageAmount,
      other_deduction: saleQualityDeduction,
      transport_charge: saleTransportCharge,
      cd_amount: finalCdAmount,
      total_deduction: saleQualityDeduction + saleTransportCharge + finalCdAmount,
      tds_amount: finalTdsAmount,
      reject_qty: toNumber(formData.reject_qty),
      amount: saleBillAmountFromData(formData),
    };

    setLoading(true);
    try {
      await axios.put(`/api/wh-vouchers/sale/${editId}`, payload);
      alert("Sale voucher pass saved successfully");
      const remainingQtyAfterSave = Math.max(saleDispatchQty - saleUnloadingQty, 0);
      const addQty = Math.max(toNumber(formData.add_qty), 0);
      const nextDispatchQty = Math.max(remainingQtyAfterSave + addQty, 0);
      const nextRate = toNumber(formData.rate);
      const nextAmount = Number((nextDispatchQty * nextRate).toFixed(2));
      const nextVoucherNo = await axios
        .get(`/api/wh-vouchers/next-voucher-no`, { params: { type: "sale" } })
        .then((res) => res.data?.voucher_no || "")
        .catch(() => "");

      if (nextDispatchQty <= 0) {
        alert("Sale voucher pass saved successfully. No remaining quantity left to create the next bill.");
        setShowSaleDeductionModal(false);
        setEditId(null);
        setFormData(defaultForm());
        await loadVouchers();
        if (activeTab === "reports") await loadReport();
        fetchNextVoucherNo(activeVoucherType);
        return;
      }

      const nextPayload = {
        ...formData,
        voucher_no: nextVoucherNo || "",
        bill_no: nextVoucherNo || "",
        bill_date: new Date().toISOString().slice(0, 10),
        date: new Date().toISOString().slice(0, 10),
        unloading_date: "",
        due_days: "",
        due_date: "",
        unloading_qty: "",
        shortage_quantity: "",
        shortage_amount: "",
        claim_amount: "",
        other_deduction: "",
        cd_percent: "",
        cd_amount: "",
        adjustment_amount: "",
        tds_amount: "",
        round_off: "",
        add_qty: "",
        dispatch_qty: formatDecimal4(nextDispatchQty),
        quantity: formatDecimal4(nextDispatchQty),
        rate: formData.rate || "",
        amount: nextAmount,
        buyer_id: formData.buyer_id || formData.company_id || "",
        company_id: formData.company_id || formData.buyer_id || "",
        consignee_id: formData.consignee_id || "",
        buyer_name: formData.buyer_name || "",
        consignee_name: formData.consignee_name || "",
        company_account_id: formData.company_account_id || "",
        product_id: formData.product_id || "",
        warehouse_id: formData.warehouse_id || "",
        location_id: formData.location_id || "",
        employee_id: formData.employee_id || "",
        lorry_no: formData.lorry_no || "",
        journey_token: formData.journey_token || buildJourneyToken(),
      };
      const createRes = await axios.post("/api/wh-vouchers/sale", nextPayload);
      setFormData((prev) => ({
        ...nextPayload,
        warehouse_id: prev.warehouse_id || "",
        company_account_id: prev.company_account_id || "",
        employee_id: prev.employee_id || "",
        location_id: prev.location_id || "",
        lorry_no: selectedSalePassBill?.lorry_no || prev.lorry_no || "",
        journey_token: prev.journey_token || buildJourneyToken(),
        bill_no: nextVoucherNo || "",
        voucher_no: nextVoucherNo || "",
        bill_date: new Date().toISOString().slice(0, 10),
        date: new Date().toISOString().slice(0, 10),
        dispatch_qty: nextDispatchQty > 0 ? nextDispatchQty.toFixed(4) : "",
        quantity: nextDispatchQty > 0 ? nextDispatchQty.toFixed(4) : "",
        add_qty: "",
        rate: formData.rate || "",
        amount: nextAmount,
        unloading_qty: "",
        company_id: formData.company_id || formData.buyer_id || "",
        buyer_id: formData.buyer_id || formData.company_id || "",
        consignee_id: formData.consignee_id || "",
        unloading_date: "",
        due_days: "",
        due_date: "",
      }));
      setEditId(createRes.data?.id || createRes.data?._id || editId);
      await loadVouchers();
      if (activeTab === "reports") await loadReport();
      fetchNextVoucherNo(activeVoucherType);
    } catch (err) {
      console.error(err);
      alert(err?.response?.data?.error || "Failed to save sale voucher pass");
    } finally {
      setLoading(false);
    }
  };

  const setPaymentAdjustmentAmount = (purchase, value) => {
    const purchaseId = String(purchase.id || purchase._id);
    const amount = Math.max(0, toNumber(value));
    const pending = toNumber(purchase.pending_amount ?? purchase.amount);
    const safeAmount = Math.min(amount, pending);
    setPaymentAdjustments((prev) => {
      const others = prev.filter((item) => String(item.purchase_id) !== purchaseId);
      if (safeAmount <= 0) return others;
      return [
        ...others,
        {
          purchase_id: purchaseId,
          voucher_no: purchase.voucher_no,
          adjusted_amount: safeAmount,
        },
      ];
    });
  };

  const autoFillPaymentAdjustments = () => {
    let remaining = toNumber(formData.amount);
    const next = [];
    (partyOutstanding?.purchases || [])
      .filter((row) => toNumber(row.pending_amount) > 0)
      .forEach((row) => {
        if (remaining <= 0) return;
        const adjusted = Math.min(remaining, toNumber(row.pending_amount));
        if (adjusted > 0) {
          next.push({
            purchase_id: String(row.id || row._id),
            voucher_no: row.voucher_no,
            adjusted_amount: adjusted,
          });
          remaining -= adjusted;
        }
      });
    setPaymentAdjustments(next);
  };

  const selectedAdjustmentFor = (purchaseId) =>
    paymentAdjustments.find((item) => String(item.purchase_id) === String(purchaseId))?.adjusted_amount || "";

  const setReceiptAdjustmentAmount = (sale, value) => {
    const saleId = String(sale.id || sale._id);
    const amount = Math.max(0, toNumber(value));
    const pending = toNumber(sale.pending_amount ?? sale.amount);
    const safeAmount = Math.min(amount, pending);
    setReceiptAdjustments((prev) => {
      const others = prev.filter((item) => String(item.sale_id) !== saleId);
      if (safeAmount <= 0) return others;
      return [
        ...others,
        {
          sale_id: saleId,
          voucher_no: sale.voucher_no,
          adjusted_amount: safeAmount,
        },
      ];
    });
  };

  const autoFillReceiptAdjustments = () => {
    let remaining = toNumber(formData.amount);
    const next = [];
    (partyOutstanding?.sales || [])
      .filter((row) => toNumber(row.pending_amount) > 0)
      .forEach((row) => {
        if (remaining <= 0) return;
        const adjusted = Math.min(remaining, toNumber(row.pending_amount));
        if (adjusted > 0) {
          next.push({
            sale_id: String(row.id || row._id),
            voucher_no: row.voucher_no,
            adjusted_amount: adjusted,
          });
          remaining -= adjusted;
        }
      });
    setReceiptAdjustments(next);
  };

  const selectedAdjustmentForReceipt = (saleId) =>
    receiptAdjustments.find((item) => String(item.sale_id) === String(saleId))?.adjusted_amount || "";

  const renderAccountSelect = (style = inp) => (
    <select name="company_account_id" value={formData.company_account_id} onChange={handleChange} style={style}>
      <option value="">Select Account</option>
      {companyAccounts.map((account) => (
        <option key={account.id || account._id} value={account.id || account._id}>
          {account.account_name || account.name}
        </option>
      ))}
    </select>
  );

  const getAccountName = (item) => {
    const accountId = String(item.company_account_id || item.account_id || item.companyAccountId || "");
    const account = companyAccounts.find((account) => String(account.id || account._id) === accountId);
    return account?.account_name || account?.name || item.company_account_name || item.account_name || item.account || "-";
  };

  const getCompanyName = (item) =>
    item?.company_name ||
    companies.find((c) => String(c.id || c._id) === String(item?.company_id))?.name ||
    "-";

  const reportColumns = {
    purchase: [
      ["sl", "S.L No", (_item, i) => i + 1],
      ["date", "Date", (item) => item.date || "-"],
      ["voucher_no", "Voucher No", (item) => item.voucher_no || "-"],
      ["warehouse", "Warehouse", (item) => getWarehouseName(item)],
      ["account", "Account", (item) => getAccountName(item)],
      ["farmer", "Farmer", (item) => item.farmer_name || getFarmerName(item)],
      ["product", "Product", (item) => getProductName(item)],
      ["packet", "Packet", (item) => formatDecimal4(item.packet || 0)],
      ["gross_weight", "Gross Wt", (item) => formatDecimal4(item.gross_weight || 0)],
      ["tare_weight", "Tare Wt", (item) => formatDecimal4(item.tare_weight || 0)],
      ["new_weight", "New Wt", (item) => formatDecimal4(Math.max(toNumber(item.gross_weight) - toNumber(item.tare_weight), 0))],
      ["dhalta", "Dhalta", (item) => formatDecimal4(item.dhalta || 0)],
      ["gross_amount", "Gross Amount", (item) => formatMoney(item.gross_amount || 0)],
      ["deduction", "Deduction", (item) => formatMoney(item.total_deduction || 0)],
      ["total_quantity", "Net Qty", (item) => formatDecimal4(item.total_quantity || 0)],
      ["total_amount", "Net Payable", (item) => formatMoney(item.total_amount || item.net_amount_payable || 0)],
      ["actions", "Actions", (item) =>
        item.legacy_purchase_entry ? (
          <span style={{ color: "#64748b" }}>Old Entry</span>
        ) : (
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" onClick={() => showPurchaseReportPreview(item)} style={{ ...btnAction, background: "#315f7d" }} title="View">View</button>
            <button type="button" onClick={() => handleEditPurchaseReport(item)} style={btnAction} title="Edit">Edit</button>
            <button type="button" onClick={() => handlePurchaseReportPDF(item.id || item._id)} style={{ ...btnAction, background: "#ea580c" }} title="Download PDF">PDF</button>
          </div>
        )
      ],
    ],
    sale: [
      ["date", "Date", (item) => formatLedgerDate(item.date)],
      ["voucher_no", "Voucher No", (item) => item.voucher_no || "-"],
      ["po_no", "P.O No", (item) => item.po_no || "-"],
      ["due_date", "Due Date", (item) => formatLedgerDate(item.due_date)],
      ["buyer", "Buyer", (item) => getBuyerName(item)],
      ["consignee", "Consignee", (item) => item.consignee_name || consignees.find((c) => String(c.id || c._id) === String(item.consignee_id))?.name || "-"],
      ["account", "Account", (item) => getAccountName(item)],
      ["warehouse", "Warehouse", (item) => getWarehouseName(item)],
      ["product", "Product", (item) => getProductName(item)],
      ["against_purchase", "Against Purchase", (item) => item.against_purchase_enabled ? `${item.against_purchase_links?.length || 0} bill` : "-"],
      ["total_quantity", "Total Quantity", (item) => formatDecimal4(item.total_quantity || 0)],
      ["total_amount", "Total Amount", (item) => formatMoney(item.total_amount || 0)],
    ],
    payment: [
      ["date", "Date", (item) => formatLedgerDate(item.date)],
      ["voucher_no", "Voucher No", (item) => item.voucher_no || "-"],
      ["party", "Party", (item) => item.party_name || item.farmer_name || "-"],
      ["account", "Account", (item) => item.company_account_name || getAccountName(item)],
      ["warehouse", "Warehouse", (item) => item.warehouse_name || getWarehouseName(item)],
      ["amount", "Amount", (item) => formatMoney(item.amount || 0)],
      ["adjusted", "Adjusted", (item) => formatMoney((item.adjustments || []).reduce((sum, entry) => sum + toNumber(entry.adjusted_amount), 0))],
      ["reference", "Reference", (item) => item.reference_id || item.reference_type || "-"],
      ["description", "Narration", (item) => item.description || "-"],
    ],
    "purchase-party-ledger": [
      ["date", "Date", (item) => (item.row_type === "closing" ? "" : formatLedgerDate(item.date))],
      ["voucher_type", "Type", (item) => (item.row_type === "closing" ? "" : (item.voucher_type || "-"))],
      ["voucher_no", "Voucher No", (item) => (item.row_type === "closing" ? "" : (item.voucher_no || "-"))],
      ["particulars", "Particulars", (item) => (item.row_type === "closing" ? "" : (item.particulars || "-"))],
      ["adjustment_details", "Adjustment Details", (item) => (item.row_type === "closing" ? "" : (item.adjustment_details || "-"))],
      ["warehouse", "Warehouse", (item) => (item.row_type === "closing" ? "" : getWarehouseName(item))],
      ["debit", "Debit", (item) => formatMoney(item.debit || 0)],
      ["credit", "Credit", (item) => {
        if (item.row_type === "closing") {
          return formatMoney(item.credit || 0);
        }
        const amount = formatMoney(item.credit || 0);
        if (item.voucher_type !== "Purchase") {
          return amount;
        }
        return (
          <button
            type="button"
            onClick={() => showPurchaseReportPreview(item, true)}
            style={{
              border: "none",
              background: "transparent",
              color: "#0f766e",
              cursor: "pointer",
              textDecoration: "underline",
              padding: 0,
              font: "inherit",
            }}
            title="Open purchase details"
          >
            {amount}
          </button>
        );
      }],
      ["balance", "Balance", (item) => {
        return formatMoney(Math.abs(item.balance || 0));
      }],
    ],
    "sale-party-ledger": [
      ["date", "Date", (item) => (item.row_type === "closing" ? "" : formatLedgerDate(item.date))],
      ["party", "Party", (item) => (item.row_type === "closing" ? `Closing Balance (${item.closing_side})` : (item.party_name || item.buyer_name || item.company_name || item.consignee_name || "-"))],
      ["account", "Account", (item) => (item.row_type === "closing" ? "" : getAccountName(item))],
      ["voucher_type", "Type", (item) => (item.row_type === "closing" ? "" : (item.voucher_type || "-"))],
      ["voucher_no", "Voucher No", (item) => (item.row_type === "closing" ? "" : (item.voucher_no || "-"))],
      ["due_date", "Due Date", (item) => (item.row_type === "closing" ? "" : formatLedgerDate(item.due_date || item.unloading_date || ""))],
      ["due_days", "Due Days", (item) => (item.row_type === "closing" ? "" : (item.due_days !== undefined ? item.due_days : ""))],
      ["days_overdue", "Days Overdue", (item) => (item.row_type === "closing" ? "" : (item.days_overdue || ""))],
      ["followup_status_label", "Status", (item) => (item.row_type === "closing" ? "" : (item.followup_status_label || item.followup_status || "-"))],
      ["adjustment_details", "Adjustment Details", (item) => (item.row_type === "closing" ? "" : (item.adjustment_details || "-"))],
      ["warehouse", "Warehouse", (item) => (item.row_type === "closing" ? "" : getWarehouseName(item))],
      ["debit", "Debit", (item) => formatMoney(item.debit || 0)],
      ["credit", "Credit", (item) => formatMoney(item.credit || 0)],
      ["balance", "Balance", (item) => formatMoney(Math.abs(item.balance || 0))],
    ],
    "sale-followup": [
      ["date", "Date", (item) => formatLedgerDate(item.date)],
      ["party", "Buyer", (item) => (item.party_name || item.buyer_name || item.company_name || "-")],
      ["account", "Account", (item) => getAccountName(item)],
      ["voucher_no", "Voucher No", (item) => (item.voucher_no || "-")],
      ["unloading_date", "Unloading Date", (item) => formatLedgerDate(item.unloading_date || "")],
      ["due_date", "Due Date", (item) => formatLedgerDate(item.due_date || item.unloading_date || "")],
      ["due_days", "Due Days", (item) => (item.due_days !== undefined ? item.due_days : diffDays(item.unloading_date, item.due_date))],
      ["days_overdue", "Days Overdue", (item) => (item.days_overdue !== undefined ? item.days_overdue : diffDays(item.due_date, new Date().toISOString().slice(0, 10)))],
      ["followup_status_label", "Status", (item) => (item.followup_status_label || item.followup_status || "-")],
      ["balance", "Balance", (item) => formatMoney(Math.abs(item.balance || item.bill_balance || item.outstanding || 0))],
      ["actions", "Actions", (item) => {
        const email = String(item.contact_email || item.buyer_email || item.consignee_email || "").trim();
        const mobileRaw = String(item.contact_mobile || item.buyer_mobile || item.consignee_mobile || "").trim();
        const mobile = mobileRaw.replace(/\D/g, "");
        const whatsappNumber = mobile.length === 10 ? `91${mobile}` : mobile;
        const dueDate = item.due_date || item.unloading_date || "";
        const body = encodeURIComponent(
          [
            `Dear ${item.party_name || item.buyer_name || item.company_name || "Party"},`,
            "",
            `Your outstanding balance is ${formatMoney(Math.abs(item.balance || 0))}.`,
            dueDate ? `Due Date: ${formatLedgerDate(dueDate)}` : "",
            item.due_days !== undefined ? `Due Days: ${item.due_days}` : "",
            item.days_overdue !== undefined ? `Days Overdue: ${item.days_overdue}` : "",
            "",
            "Please clear the pending amount at the earliest.",
            `Voucher No: ${item.voucher_no || "-"}`,
          ].filter(Boolean).join("\n")
        );
        return (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <a
              href={email ? `mailto:${email}?subject=${encodeURIComponent(`Outstanding follow-up for ${item.voucher_no || ""}`.trim())}&body=${body}` : "#"}
              onClick={(event) => {
                if (!email) event.preventDefault();
              }}
              style={{
                ...btnAction,
                background: email ? "#0f766e" : "#cbd5e1",
                padding: "6px 10px",
                textDecoration: "none",
                color: "#fff",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              Mail
            </a>
            <a
              href={whatsappNumber ? `https://wa.me/${whatsappNumber}?text=${encodeURIComponent([
                `Dear ${item.party_name || item.buyer_name || item.company_name || "Party"},`,
                `Your outstanding balance is ${formatMoney(Math.abs(item.balance || 0))}.`,
                dueDate ? `Due Date: ${formatLedgerDate(dueDate)}` : "",
                item.due_days !== undefined ? `Due Days: ${item.due_days}` : "",
                item.days_overdue !== undefined ? `Days Overdue: ${item.days_overdue}` : "",
                `Voucher No: ${item.voucher_no || "-"}`,
              ].filter(Boolean).join(" "))}` : "#"}
              onClick={(event) => {
                if (!whatsappNumber) event.preventDefault();
              }}
              target="_blank"
              rel="noreferrer"
              style={{
                ...btnAction,
                background: whatsappNumber ? "#15803d" : "#cbd5e1",
                padding: "6px 10px",
                textDecoration: "none",
                color: "#fff",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              WhatsApp
            </a>
          </div>
        );
      }],
    ],
    "warehouse-stock": [
      ["warehouse", "Warehouse", (item) => getWarehouseName(item)],
      ["account", "Account Name", (item) => getAccountName(item)],
      ["product", "Product", (item) => getProductName(item)],
      ["purchase_qty", "Purchase Qty", (item) => (
        <button type="button" onClick={() => openStockDrilldown(item, "purchase")} style={linkButtonStyle}>
          {formatDecimal4(item.purchase_qty || 0)}
        </button>
      )],
      ["sale_qty", "Sale Qty", (item) => (
        <button type="button" onClick={() => openStockDrilldown(item, "sale")} style={linkButtonStyle}>
          {formatDecimal4(item.sale_qty || 0)}
        </button>
      )],
      ["stock_qty", "Stock Qty", (item) => (
        <button type="button" onClick={() => openStockDrilldown(item, "stock")} style={linkButtonStyle}>
          {formatDecimal4(item.stock_qty || 0)}
        </button>
      )],
      ["avg_rate", "Avg Rate", (item) => formatMoney(item.avg_rate || 0)],
      ["stock_amount", "Stock Amount", (item) => formatMoney(item.stock_amount || 0)],
    ],
    "fifo-stock": [
      ["date", "Purchase Date", (item) => item.date || "-"],
      ["voucher_no", "Voucher No", (item) => item.voucher_no || "-"],
      ["warehouse", "Warehouse", (item) => getWarehouseName(item)],
      ["product", "Product", (item) => getProductName(item)],
      ["purchase_qty", "Purchase Qty", (item) => formatDecimal4(item.purchase_qty || 0)],
      ["remaining_qty", "FIFO Balance Qty", (item) => formatDecimal4(item.remaining_qty || 0)],
      ["gross_weight", "Gross Wt", (item) => formatDecimal4(item.gross_weight || 0)],
      ["rate", "FIFO Rate", (item) => formatMoney(item.rate || 0)],
      ["amount", "FIFO Amount", (item) => formatMoney(item.amount || 0)],
    ],
    "profit-loss": [
      ["warehouse", "Warehouse", (item) => item.warehouse_name || getWarehouseName(item)],
      ["sale_amount", "Sale Amount", (item) => formatMoney(item.sale_amount || 0)],
      ["purchase_amount", "Purchase Amount", (item) => formatMoney(item.purchase_amount || 0)],
      ["profit_loss", "Profit/Loss", (item) => (
        <span style={{ color: Number(item.profit_loss || 0) >= 0 ? "#16a34a" : "#dc2626" }}>
          {formatMoney(item.profit_loss || 0)}
        </span>
      )],
    ],
  };

  const activeReportColumns = reportColumns[activeReport] || (activeReport === "sale-journey" ? reportColumns["sale-party-ledger"] : reportColumns.sale);
  const currentReportRows = activeReport === "warehouse-stock" ? warehouseStockReport : reportData;
  const displayReportData = useMemo(() => {
    if (activeReport === "sale-followup") {
      const rows = Array.isArray(reportData) ? reportData : [];
      if (saleFollowupFilter === "all") return rows;
      return rows.filter((row) => String(row.followup_status || "pending").toLowerCase() === saleFollowupFilter);
    }
    if (activeReport !== "purchase-party-ledger" && activeReport !== "sale-party-ledger") return Array.isArray(currentReportRows) ? currentReportRows : [];
    const entries = (Array.isArray(reportData) ? reportData : []).filter((row) => row.row_type !== "closing");
    const ledgerPartyName = (row) => activeReport === "purchase-party-ledger"
      ? (row.farmer_name || getFarmerName(row) || "Unknown Farmer")
      : (row.party_name || row.buyer_name || row.company_name || row.consignee_name || "Unknown Party");
    const ledgerGroupKey = (row) => `${ledgerPartyName(row)}::${row.company_account_id || row.company_account_name || row.account_name || ""}`;
    const sorted = entries.slice().sort((a, b) => {
      const leftParty = ledgerGroupKey(a);
      const rightParty = ledgerGroupKey(b);
      const partyCmp = String(leftParty).localeCompare(String(rightParty));
      if (partyCmp) return partyCmp;
      const dateCmp = String(a.date || "").localeCompare(String(b.date || ""));
      if (dateCmp) return dateCmp;
      return String(a.voucher_no || "").localeCompare(String(b.voucher_no || ""));
    });
    const grouped = [];
    let currentGroup = null;
    let currentParty = null;
    let currentAccount = null;
    let running = 0;
    let farmerDebit = 0;
    let farmerCredit = 0;
    const pushClosing = () => {
      if (!currentGroup) return;
      grouped.push({
        row_type: "closing",
        farmer_name: currentParty,
        party_name: currentParty,
        company_account_name: currentAccount,
        debit: farmerDebit,
        credit: farmerCredit,
        balance: running,
        closing_side: running > 0 ? "DR" : "CR",
      });
    };
    sorted.forEach((row) => {
      const partyName = ledgerPartyName(row);
      const groupKey = ledgerGroupKey(row);
      if (currentGroup && groupKey !== currentGroup) {
        pushClosing();
        running = 0;
        farmerDebit = 0;
        farmerCredit = 0;
      }
      currentGroup = groupKey;
      currentParty = partyName;
      currentAccount = getAccountName(row);
      const debit = toNumber(row.debit || 0);
      const credit = toNumber(row.credit || 0);
      running += debit - credit;
      farmerDebit += debit;
      farmerCredit += credit;
      grouped.push({
        ...row,
        farmer_name: activeReport === "purchase-party-ledger" ? partyName : row.farmer_name,
        party_name: activeReport === "sale-party-ledger" ? partyName : row.party_name,
        balance: Number(running.toFixed(4)),
        row_type: "entry",
      });
    });
    pushClosing();
    return grouped;
  }, [activeReport, currentReportRows, reportData, farmers, buyerNames, companyAccounts, saleFollowupFilter]);
  const saleFollowupRows = activeReport === "sale-followup" ? displayReportData : [];
  const purchasePartyLedgerCompanyAccounts = useMemo(() => {
    if (Array.isArray(reportFilterOptions.accounts) && reportFilterOptions.accounts.length) {
      return reportFilterOptions.accounts;
    }
    const ids = new Set((reportFilterOptions.account_ids || []).map(String));
    return companyAccounts.filter((account) => ids.has(String(account.id || account._id || "")));
  }, [companyAccounts, reportFilterOptions.account_ids, reportFilterOptions.accounts]);

  const purchasePartyLedgerWarehouses = useMemo(() => {
    if (Array.isArray(reportFilterOptions.warehouses) && reportFilterOptions.warehouses.length) {
      return reportFilterOptions.warehouses;
    }
    const ids = new Set((reportFilterOptions.warehouse_ids || []).map(String));
    return warehouses.filter((warehouse) => ids.has(String(warehouse.id || warehouse._id || "")));
  }, [warehouses, reportFilterOptions.warehouse_ids, reportFilterOptions.warehouses]);

  const purchasePartyLedgerFarmers = useMemo(() => {
    if (Array.isArray(reportFilterOptions.farmers) && reportFilterOptions.farmers.length) {
      return reportFilterOptions.farmers;
    }
    const ids = new Set((reportFilterOptions.farmer_ids || []).map(String));
    return farmers.filter((farmer) => ids.has(String(farmer.id || farmer._id || "")));
  }, [farmers, reportFilterOptions.farmer_ids, reportFilterOptions.farmers]);

  const saleReportAccounts = purchasePartyLedgerCompanyAccounts;
  const saleReportWarehouses = purchasePartyLedgerWarehouses;
  const saleReportFarmers = purchasePartyLedgerFarmers;
  const saleReportBuyers = useMemo(() => {
    if (Array.isArray(reportFilterOptions.buyers) && reportFilterOptions.buyers.length) {
      return reportFilterOptions.buyers;
    }
    const ids = new Set((reportFilterOptions.buyer_ids || []).map(String));
    return buyerNames.filter((buyer) => ids.has(String(buyer.id || buyer._id || "")));
  }, [buyerNames, reportFilterOptions.buyer_ids, reportFilterOptions.buyers]);

  const normalizedGlobalSearch = String(globalSearch || "").trim().toLowerCase();
  const matchesGlobalSearch = (value) =>
    !normalizedGlobalSearch || String(value ?? "").toLowerCase().includes(normalizedGlobalSearch);
  const matchesAnyValue = (values) => values.some((value) => matchesGlobalSearch(value));
  // Voucher table data is already filtered, sorted and paginated by MongoDB.
  // Do not run a second client-side filter/sort/slice over the complete dataset.
  const filteredVoucherListAll = list;
  const filteredVoucherList = list;

  const filteredReportDataAll = useMemo(() => {
    const serverPagedReport = activeReport === "sale" || activeReport === "purchase" || activeReport === "warehouse-stock";
    // Sale/Purchase search is already applied in MongoDB before pagination.
    if (serverPagedReport || !normalizedGlobalSearch) return displayReportData;
    return displayReportData.filter((item) =>
      matchesAnyValue([
        item.voucher_no,
        item.bill_no,
        item.date,
        item.party_name,
        item.farmer_name,
        getFarmerName(item),
        item.buyer_name,
        item.company_name,
        item.company_account_name,
        item.warehouse_name,
        getWarehouseName(item),
        item.location_name,
        item.product_name,
        item.description,
        item.reference_id,
        item.lorry_no,
        item.po_no,
        item.due_date,
        item.quantity,
        item.total_qty,
        item.amount,
        item.net_amount,
        item.net_receivable_amount,
        item.outstanding,
      ])
    );
  }, [displayReportData, normalizedGlobalSearch]);
  const filteredReportData = useMemo(() => {
    const serverPagedReport = activeReport === "sale" || activeReport === "purchase" || activeReport === "warehouse-stock";
    if (serverPagedReport) return filteredReportDataAll;
    const start = (reportPage - 1) * PAGE_SIZE;
    return filteredReportDataAll.slice(start, start + PAGE_SIZE);
  }, [filteredReportDataAll, reportPage]);
  useEffect(() => {
    setVoucherPage(1);
  }, [activeVoucherType, normalizedGlobalSearch]);
  useEffect(() => {
    setReportPage(1);
    }, [activeReport, normalizedGlobalSearch, saleFollowupFilter, reportFilters.farmer_id, reportFilters.warehouse_id, reportFilters.company_account_id, reportFilters.sale_buyer_id, reportFilters.sale_company_account_id, reportFilters.sale_journey_token, reportFilters.sale_lorry_no, reportFilters.sale_bill_no]);
  useEffect(() => {
    setVoucherPage((current) => Math.min(current, Math.max(1, Number(voucherPageInfo.totalPages || 1))));
  }, [voucherPageInfo.totalPages]);
  useEffect(() => {
    const serverPagedReport = activeReport === "sale" || activeReport === "purchase" || activeReport === "warehouse-stock";
    const totalPages = serverPagedReport
      ? Math.max(1, Math.ceil(Number(reportPageInfo.total || 0) / Number(reportPageInfo.pageSize || PAGE_SIZE)))
      : Math.max(1, Math.ceil(filteredReportDataAll.length / PAGE_SIZE));
    setReportPage((current) => Math.min(current, totalPages));
  }, [activeReport, reportPageInfo.total, reportPageInfo.pageSize, filteredReportDataAll.length]);
  const saleFollowupCounts = useMemo(() => {
    const counts = { all: filteredReportDataAll.length, payment_done: 0, unloading_pending: 0, pending: 0, overdue: 0 };
    filteredReportDataAll.forEach((row) => {
      const status = String(row.followup_status || "pending").toLowerCase();
      if (counts[status] !== undefined) counts[status] += 1;
    });
    return counts;
  }, [filteredReportData]);

  const purchaseReportRows = useMemo(() => {
    const rows = Array.isArray(filteredReportDataAll) ? filteredReportDataAll : [];
    return rows.filter((row) => row && (row.id || row._id || row.voucher_no));
  }, [filteredReportDataAll]);

  const currentPurchasePreviewIndex = purchasePreviewRow
    ? purchaseReportRows.findIndex((row) => String(getRecordId(row)) === String(getRecordId(purchasePreviewRow)))
    : -1;

  const navigatePurchasePreview = (direction) => {
    if (currentPurchasePreviewIndex < 0) return;
    const targetIndex = currentPurchasePreviewIndex + direction;
    const targetRow = purchaseReportRows[targetIndex];
    if (targetRow) {
      setPurchasePreviewRow(targetRow);
    }
  };
  const totalVoucherPages = Math.max(1, Number(voucherPageInfo.totalPages || 1));
  const totalReportPages = activeReport === "sale" || activeReport === "purchase" || activeReport === "warehouse-stock"
    ? (reportPageInfo.hasMore ? reportPage + 1 : reportPage)
    : Math.max(1, Math.ceil(filteredReportDataAll.length / PAGE_SIZE));
  const renderPaginationBar = (page, totalPages, onPrev, onNext, totalItems, label = "rows") => {
    if (totalPages <= 1) return null;
    const start = totalItems === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const end = Math.min(page * PAGE_SIZE, totalItems);
    return (
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 12, fontSize: 13, color: "#475569", padding: "12px", background: "#f8fafc", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
        <div style={{ fontWeight: 600, color: "#0f172a" }}>
          Total: <span style={{ fontWeight: 700, color: "#1e40af" }}>{totalItems}</span> {label} | Pages: <span style={{ fontWeight: 700, color: "#1e40af" }}>{totalPages}</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" onClick={onPrev} disabled={page <= 1} style={{ ...btnAction, background: page <= 1 ? "#cbd5e1" : "#64748b", color: page <= 1 ? "#64748b" : "#fff", cursor: page <= 1 ? "not-allowed" : "pointer", padding: "6px 12px" }}>
            ← Prev
          </button>
          <div style={{ alignSelf: "center", padding: "0 12px", fontWeight: 700, color: "#0f172a", whiteSpace: "nowrap", background: "#fff", border: "1px solid #cbd5e1", borderRadius: "6px", padding: "6px 12px" }}>
            Showing {totalItems === 0 ? 0 : `${start}-${end}`} | Page {page} / {totalPages}
          </div>
          <button type="button" onClick={onNext} disabled={page >= totalPages} style={{ ...btnAction, background: page >= totalPages ? "#cbd5e1" : "#0f766e", color: page >= totalPages ? "#64748b" : "#fff", cursor: page >= totalPages ? "not-allowed" : "pointer", padding: "6px 12px" }}>
            Next →
          </button>
        </div>
      </div>
    );
  };
  const saleFollowupStatusMeta = {
    all: { label: "All Bills", bg: "#0f172a", color: "#fff" },
    payment_done: { label: "Payment Done", bg: "#dcfce7", color: "#166534" },
    unloading_pending: { label: "Unloading Pending", bg: "#fef3c7", color: "#92400e" },
    pending: { label: "Payment Pending", bg: "#dbeafe", color: "#1d4ed8" },
    overdue: { label: "Overdue", bg: "#fee2e2", color: "#b91c1c" },
  };
  const purchaseBillRows = activeReport === "purchase-party-ledger"
    ? displayReportData.filter((row) => row.row_type === "entry" && row.voucher_type === "Purchase")
    : [];
  const selectedBill = purchaseBillRows.find((row) => String(row.purchase_id || row.voucher_no) === String(selectedLedgerBillId)) || purchaseBillRows[0] || null;
  const saleBillRows = activeReport === "sale-party-ledger"
    ? displayReportData.filter((row) => row.row_type === "entry" && row.voucher_type === "Sale")
    : [];
  const saleJourneyRows = activeReport === "sale-journey"
    ? (Array.isArray(reportData) ? reportData : [])
    : [];
  const selectedSaleBill = saleBillRows.find((row) => String(row.sale_id || row.voucher_no) === String(selectedSaleLedgerBillId)) || saleBillRows[0] || null;
  const selectedSaleJourneySeed = activeReport === "sale-journey" ? (saleJourneyRows[0] || null) : selectedSaleBill;
  const selectedSaleJourneyKey = String(selectedSaleJourneySeed?.journey_token || selectedSaleJourneySeed?.journey_id || selectedSaleJourneySeed?.journey_group_no || "").trim();
  const selectedSaleJourneyRows = activeReport === "sale-journey"
    ? (selectedSaleJourneyKey
      ? saleJourneyRows.filter((row) => String(row.journey_token || row.journey_id || row.journey_group_no || "") === selectedSaleJourneyKey)
      : saleJourneyRows)
    : (selectedSaleJourneyKey
      ? saleBillRows.filter((row) => String(row.journey_token || row.journey_id || row.journey_group_no || "") === selectedSaleJourneyKey)
      : selectedSaleBill
        ? saleBillRows.filter((row) => String(row.lorry_no || "") === String(selectedSaleBill.lorry_no || "") && String(row.date || "") === String(selectedSaleBill.date || ""))
        : []);
  const selectedSaleJourneyTotalQty = selectedSaleJourneyRows.reduce((sum, row) => sum + toNumber(row.quantity || row.total_quantity || row.unloading_qty || 0), 0);
  const selectedSaleJourneyTotalAmount = selectedSaleJourneyRows.reduce((sum, row) => sum + toNumber(row.amount || row.total_amount || row.net_receivable_amount || 0), 0);
  const selectedSaleJourneyBalanceQty = Math.max(
    toNumber(selectedSaleBill?.total_quantity || selectedSaleBill?.quantity || selectedSaleBill?.unloading_qty || 0) - selectedSaleJourneyTotalQty,
    0
  );

  const getAccountDetails = (item) => {
    const accountId = String(item.company_account_id || item.account_id || item.companyAccountId || "");
    return companyAccounts.find((account) => String(account.id || account._id) === accountId) || {};
  };

  const getLedgerPartyDetails = (row, ledgerType = activeReport) => {
    if (row.row_type === "closing") return { name: row.party_name || row.farmer_name || "-", address: "", mobile: "", email: "", gst: "", pan: "" };
    if (ledgerType === "purchase-party-ledger") {
      const farmerId = String(row.farmer_id || "");
      const farmer = farmers.find((item) => String(item.id || item._id) === farmerId) || {};
      return {
        name: row.farmer_name || farmer.name || getFarmerName(row) || "-",
        address: row.farmer_address || farmer.address || "",
        village: row.farmer_village || farmer.village || "",
        city: row.farmer_city || farmer.city || "",
        district: row.farmer_district || farmer.district || "",
        state: row.farmer_state || farmer.state || "",
        pincode: row.farmer_pincode || farmer.pincode || "",
        mobile: row.farmer_mobile || farmer.mobile || "",
        email: row.farmer_email || farmer.email || "",
        gst: row.farmer_gst || farmer.gst_no || farmer.gst || "",
        pan: row.farmer_pan || farmer.pan_no || farmer.pan || "",
      };
    }
    const buyerId = String(row.buyer_id || row.company_id || "");
    const buyer = buyerNames.find((item) => String(item.id || item._id) === buyerId) || {};
    return {
      name: row.party_name || row.buyer_name || row.company_name || buyer.name || "-",
      address: row.buyer_address || row.company_address || buyer.address || buyer.location || "",
      village: row.buyer_village || buyer.village || "",
      city: row.buyer_city || buyer.city || "",
      district: row.buyer_district || buyer.district || "",
      state: row.buyer_state || buyer.state || "",
      pincode: row.buyer_pincode || buyer.pincode || "",
      mobile: row.buyer_mobile || row.company_mobile || buyer.mobile || "",
      email: row.buyer_email || row.company_email || buyer.email || "",
      gst: row.buyer_gst || row.company_gst || buyer.gst_no || buyer.gst || "",
      pan: row.buyer_pan || row.company_pan || buyer.pan_no || buyer.pan || "",
    };
  };

  const getLedgerAccountDetails = (row) => {
    const account = getAccountDetails(row);
    return {
      name: getAccountName(row),
      address: row.company_account_address || row.account_address || account.address || "",
      city: row.company_account_city || account.city || "",
      district: row.company_account_district || account.district || "",
      state: row.company_account_state || account.state || "",
      pincode: row.company_account_pincode || account.pincode || "",
      mobile: row.company_account_mobile || row.account_mobile || account.mobile || "",
      email: row.company_account_email || row.account_email || account.email || "",
      gst: row.company_account_gst || row.account_gst || account.gst_no || account.gst || "",
      pan: row.company_account_pan || row.account_pan || account.pan_no || account.pan || "",
    };
  };

  const formatLedgerContact = ({ address, mobile, email, gst, pan }) =>
    [
      address ? `Address: ${address}` : "",
      mobile ? `Phone: ${mobile}` : "",
      email ? `Mail: ${email}` : "",
      gst ? `GST: ${gst}` : "",
      pan ? `PAN: ${pan}` : "",
    ].filter(Boolean).join(" | ") || "-";

  const buildLedgerPdf = (ledgerType) => {
    const isPurchaseLedger = ledgerType === "purchase-party-ledger";
    const isSaleLedger = ledgerType === "sale-party-ledger";
    const title = isSaleLedger ? "Sale Party Ledger" : "Purchase Party Ledger";
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const firstEntry = (displayReportData || []).find((row) => row.row_type !== "closing") || {};
    const reportParty = getLedgerPartyDetails(firstEntry, ledgerType);
    const reportAccount = getLedgerAccountDetails(firstEntry);

    // Keep the report data readable on mobile PDF viewers: use the full page
    // width, smaller margins and no heavy cell borders.
    const left = 10;
    const right = 10;
    const usableWidth = pageWidth - left - right;

    const joinAddress = (details) => {
      const parts = [
        details.address,
        details.village,
        details.city,
        details.district,
        details.state,
        details.pincode,
      ].map((v) => String(v || "").trim()).filter(Boolean);
      return [...new Set(parts)].join(", ");
    };

    const accountAddress = joinAddress({
      address: reportAccount.address,
      city: reportAccount.city,
      district: reportAccount.district,
      state: reportAccount.state,
      pincode: reportAccount.pincode,
    });
    const farmerAddress = joinAddress({
      address: reportParty.address,
      village: reportParty.village,
      city: reportParty.city,
      district: reportParty.district,
      state: reportParty.state,
      pincode: reportParty.pincode,
    });

    const contactLine = (details, address) => [
      address ? `Address: ${address}` : "",
      details.mobile ? `Phone: ${details.mobile}` : "",
      details.email ? `Email: ${details.email}` : "",
      details.gst ? `GST: ${details.gst}` : "",
      details.pan ? `PAN: ${details.pan}` : "",
    ].filter(Boolean).join("  |  ");

    const drawInfoCard = (x, y, w, label, details, address, accent) => {
      const h = 25;
      doc.setFillColor(248, 250, 252);
      doc.setDrawColor(226, 232, 240);
      doc.roundedRect(x, y, w, h, 2, 2, "FD");
      doc.setFillColor(...accent);
      doc.roundedRect(x, y, 2.5, h, 1.2, 1.2, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(6.8);
      doc.setTextColor(...accent);
      doc.text(label.toUpperCase(), x + 6, y + 5.2);
      doc.setFontSize(9.5);
      doc.setTextColor(15, 23, 42);
      doc.text(String(details.name || "-").slice(0, 100), x + 6, y + 10.2);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.3);
      doc.setTextColor(71, 85, 105);
      const line = contactLine(details, address) || "Address: -";
      const wrapped = doc.splitTextToSize(line, w - 12).slice(0, 3);
      doc.text(wrapped, x + 6, y + 14.2, { lineHeightFactor: 1.15 });
      return y + h;
    };

    // Header
    doc.setFillColor(15, 118, 110);
    doc.rect(0, 0, pageWidth, 7, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.setTextColor(15, 23, 42);
    doc.text(title, left, 17);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(`Generated: ${formatLedgerDate(new Date().toISOString().slice(0, 10))}`, pageWidth - right, 17, { align: "right" });

    let contentStartY = 22;
    if (isPurchaseLedger) {
      const accountBottom = drawInfoCard(left, contentStartY, usableWidth, "Account Details", reportAccount, accountAddress, [15, 118, 110]);
      const farmerBottom = drawInfoCard(left, accountBottom + 3, usableWidth, "Farmer Details", reportParty, farmerAddress, [37, 99, 235]);
      contentStartY = farmerBottom + 5;
    } else if (isSaleLedger) {
      const gap = 4;
      const cardW = (usableWidth - gap) / 2;
      const accountBottom = drawInfoCard(left, contentStartY, cardW, "Account Details", reportAccount, accountAddress, [15, 118, 110]);
      const partyBottom = drawInfoCard(left + cardW + gap, contentStartY, cardW, `${isSaleLedger ? "Party" : "Farmer"} Details`, reportParty, farmerAddress, [37, 99, 235]);
      contentStartY = Math.max(accountBottom, partyBottom) + 5;
    }

    const allRows = Array.isArray(displayReportData) ? displayReportData : [];
    const entryRows = allRows.filter((row) => row.row_type !== "closing");
    const totalDebit = entryRows.reduce((sum, row) => sum + toNumber(row.debit || 0), 0);
    const totalCredit = entryRows.reduce((sum, row) => sum + toNumber(row.credit || 0), 0);
    const closingBalance = Number((totalDebit - totalCredit).toFixed(2));
    const closingSide = closingBalance >= 0 ? "DR" : "CR";
    const closingAmount = Math.abs(closingBalance);

    const summary = [
      ["Entries", String(entryRows.length)],
      ["Debit", `Rs.${formatMoney(totalDebit)}`],
      ["Credit", `Rs.${formatMoney(totalCredit)}`],
      ["Closing Due", `Rs.${formatMoney(closingAmount)}`],
    ];
    const summaryW = (usableWidth - 9) / 4;
    summary.forEach(([label, value], i) => {
      const x = left + i * (summaryW + 3);
      doc.setFillColor(i === 3 ? 239 : 248, i === 3 ? 246 : 250, i === 3 ? 255 : 252);
      doc.setDrawColor(226, 232, 240);
      doc.roundedRect(x, contentStartY, summaryW, 14, 2, 2, "FD");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.5);
      doc.setTextColor(71, 85, 105);
      doc.text(label, x + 4, contentStartY + 5);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(15, 23, 42);
      doc.text(value, x + 4, contentStartY + 10.8);
    });

    const tableStartY = contentStartY + 18;
    const columns = isSaleLedger
      ? ["Date", "Type", "Voucher No", "Adjustment & Details", "Particulars", "Due Date", "Due Days", "Overdue", "Dr", "Cr", "Balance"]
      : ["Date", "Type", "Voucher No", "Particulars", "Adjustment Details", "Warehouse", "Due Date", "Due Days", "Overdue", "Dr", "Cr", "Balance"];

    const bodyRowTypes = entryRows.map((row) => row.row_type || "entry");
    const body = entryRows.map((row) => {
      if (isSaleLedger) {
        const saleDetails = [
          `Qty: ${formatDecimal4(row.quantity || row.unloading_qty || 0)}`,
          `Rate: ${formatMoney(row.rate || 0)}`,
          `Lorry: ${row.lorry_no || row.reference_id || "-"}`,
        ].join("\n");
        return [
          formatLedgerDate(row.date), row.voucher_type || "-", row.voucher_no || "-", saleDetails,
          row.particulars || row.adjustment_details || row.description || "-",
          formatLedgerDate(row.due_date || row.unloading_date || ""), row.due_days ?? "", row.days_overdue ?? "",
          formatMoney(row.debit || 0), formatMoney(row.credit || 0), formatMoney(Math.abs(row.balance || 0)),
        ];
      }
      return [
        formatLedgerDate(row.date), row.voucher_type || "-", row.voucher_no || "-", row.particulars || "-",
        row.adjustment_details || "-", getWarehouseName(row), formatLedgerDate(row.due_date || row.unloading_date || ""),
        row.due_days ?? "", row.days_overdue ?? "", formatMoney(row.debit || 0), formatMoney(row.credit || 0),
        formatMoney(Math.abs(row.balance || 0)),
      ];
    });

    // ONE closing row, always at the absolute end of the ledger.
    body.push([
      "", `Closing (${closingSide})`, "", "", "", "", "", "", "",
      formatMoney(totalDebit), formatMoney(totalCredit), formatMoney(closingAmount),
    ]);

    const purchaseWidths = [17, 18, 25, 37, 40, 31, 20, 12, 15, 20, 20, 22];
    const saleWidths = [17, 18, 25, 40, 40, 20, 13, 15, 22, 22, 25];
    const widths = isSaleLedger ? saleWidths : purchaseWidths;

    autoTable(doc, {
      startY: tableStartY,
      margin: { left, right },
      tableWidth: usableWidth,
      theme: "plain",
      styles: {
        fontSize: 6.2,
        cellPadding: { top: 1.6, right: 1.5, bottom: 1.6, left: 1.5 },
        overflow: "linebreak",
        valign: "middle",
        textColor: [15, 23, 42],
        lineColor: [226, 232, 240],
        lineWidth: 0.15,
      },
      headStyles: {
        fillColor: [15, 118, 110],
        textColor: [255, 255, 255],
        fontStyle: "bold",
        fontSize: 6.1,
        lineWidth: 0,
      },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      head: [columns],
      body,
      columnStyles: Object.fromEntries(widths.map((w, i) => [i, { cellWidth: w }])),
      didParseCell: (data) => {
        // Last row is the single closing row. Make it visually distinct and
        // remove its cell borders while keeping all values aligned.
        if (data.section === "body" && data.row.index === body.length - 1) {
          data.cell.styles.fillColor = [239, 246, 255];
          data.cell.styles.fontStyle = "bold";
          data.cell.styles.textColor = [15, 23, 42];
          data.cell.styles.lineWidth = 0;
        }
        // Amount columns are right aligned for clean accounting presentation.
        if (data.section === "body" && data.column.index >= (isSaleLedger ? 8 : 9)) {
          data.cell.styles.halign = "right";
        }
      },
      didDrawCell: (data) => {
        if (data.section === "body" && data.row.index < body.length - 1) {
          doc.setDrawColor(226, 232, 240);
          doc.setLineWidth(0.12);
          doc.line(data.cell.x, data.cell.y + data.cell.height, data.cell.x + data.cell.width, data.cell.y + data.cell.height);
        }
      },
      didDrawPage: (data) => {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(6.5);
        doc.setTextColor(100, 116, 139);
        doc.text(`Warehouse Trading • ${title}`, left, pageHeight - 6);
        doc.text(`Page ${data.pageNumber} / ${doc.internal.getNumberOfPages()}`, pageWidth - right, pageHeight - 6, { align: "right" });
      },
    });
    return { doc, title };
  };

  const downloadLedgerPdf = (ledgerType = activeReport) => {
    if ((ledgerType !== "purchase-party-ledger" && ledgerType !== "sale-party-ledger") || !displayReportData.length) {
      alert("No ledger data available");
      return;
    }
    const { doc } = buildLedgerPdf(ledgerType);
    doc.save(`${ledgerType}-${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  const downloadPurchaseLedgerPdf = () => downloadLedgerPdf("purchase-party-ledger");
  const downloadSaleLedgerPdf = () => downloadLedgerPdf("sale-party-ledger");

  const shareLedgerWhatsapp = async (ledgerType = activeReport) => {
    if ((ledgerType !== "purchase-party-ledger" && ledgerType !== "sale-party-ledger") || !displayReportData.length) {
      alert("No ledger data available");
      return;
    }
    const title = ledgerType === "sale-party-ledger" ? "Sale Party Ledger" : "Purchase Party Ledger";
    const closingRows = displayReportData.filter((row) => row.row_type === "closing");
    const summary = closingRows
      .map((row) => {
        if (ledgerType === "purchase-party-ledger") {
          return `Closing Balance: ${row.closing_side} ${formatMoney(Math.abs(row.balance || 0))}`;
        }
        const party = getLedgerPartyDetails(row, ledgerType);
        const account = getLedgerAccountDetails(row);
        return `${party.name} | ${account.name}: ${row.closing_side} ${formatMoney(Math.abs(row.balance || 0))}`;
      })
      .join("\n");
    const detailLines = displayReportData
      .filter((row) => row.row_type !== "closing")
      .slice(0, 20)
      .map((row) => {
        if (ledgerType === "purchase-party-ledger") {
          const party = getLedgerPartyDetails(row, ledgerType);
          const account = getLedgerAccountDetails(row);
          return [
            `${formatLedgerDate(row.date)} ${row.voucher_no || ""} ${row.voucher_type || ""}`,
            `Account: ${account.name || "-"}`,
            `Account Address: ${account.address || "-"}`,
            `Farmer: ${party.name || "-"}`,
            `Farmer Address: ${party.address || "-"}`,
            `Warehouse: ${getWarehouseName(row)}`,
            `Adjustment: ${row.adjustment_details || row.particulars || "-"}`,
            `Dr ${formatMoney(row.debit || 0)} Cr ${formatMoney(row.credit || 0)} Bal ${formatMoney(Math.abs(row.balance || 0))}`,
          ].join("\n");
        }
        const party = getLedgerPartyDetails(row, ledgerType);
        const account = getLedgerAccountDetails(row);
        return [
          `${formatLedgerDate(row.date)} ${row.voucher_no || ""} ${row.voucher_type || ""}`,
          `${party.name} (${formatLedgerContact(party)})`,
          `Account: ${account.name} (${formatLedgerContact(account)})`,
          `Dr ${formatMoney(row.debit || 0)} Cr ${formatMoney(row.credit || 0)} Bal ${formatMoney(Math.abs(row.balance || 0))}`,
        ].join("\n");
      })
      .join("\n\n");
    const firstEntryForShare = (displayReportData || []).find((row) => row.row_type !== "closing") || {};
    const shareParty = getLedgerPartyDetails(firstEntryForShare, ledgerType);
    const shareAccount = getLedgerAccountDetails(firstEntryForShare);
    const headerDetails = [
      `Account: ${shareAccount.name || "-"}`,
      `Account Address: ${shareAccount.address || "-"}`,
      `Farmer: ${shareParty.name || "-"}`,
      `Farmer Address: ${shareParty.address || "-"}`,
    ].join("\n");
    const message = `${title}\n\n${headerDetails}\n\nSummary\n${summary || "No closing rows"}\n\nDetails\n${detailLines || "No ledger rows"}`;

    const { doc } = buildLedgerPdf(ledgerType);
    const fileName = `${ledgerType}-${new Date().toISOString().slice(0, 10)}.pdf`;
    const pdfBlob = doc.output("blob");
    const pdfFile = new File([pdfBlob], fileName, { type: "application/pdf" });
    if (navigator.canShare?.({ files: [pdfFile] })) {
      await navigator.share({ title, text: message, files: [pdfFile] });
      return;
    }

    doc.save(fileName);
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, "_blank");
  };

  const sharePurchaseLedgerWhatsapp = () => shareLedgerWhatsapp("purchase-party-ledger");
  const shareSaleLedgerWhatsapp = () => shareLedgerWhatsapp("sale-party-ledger");

  const stockPurchaseRows = useMemo(() => stockDrilldown?.item?.purchase_details || [], [stockDrilldown]);
  const stockSaleRows = useMemo(() => stockDrilldown?.item?.sale_details || [], [stockDrilldown]);
  const stockDrilldownAllRows = useMemo(() => {
    if (!stockDrilldown?.item) return [];

    const rows = [
      ...stockPurchaseRows.map((row) => ({
        ...row,
        type: "Purchase",
        inward_qty: toNumber(row.qty),
        outward_qty: 0,
        inward_rate: toNumber(row.rate),
        outward_rate: 0,
        inward_amount: toNumber(row.amount),
        outward_amount: 0,
      })),
      ...stockSaleRows.map((row) => ({
        ...row,
        type: "Sale",
        inward_qty: 0,
        outward_qty: toNumber(row.qty),
        inward_rate: 0,
        outward_rate: toNumber(row.rate),
        inward_amount: 0,
        outward_amount: toNumber(row.amount),
      })),
    ].sort((a, b) => {
      const dateCmp = String(a.date || "").localeCompare(String(b.date || ""));
      if (dateCmp) return dateCmp;
      const typeCmp = a.type === b.type ? 0 : a.type === "Purchase" ? -1 : 1;
      if (typeCmp) return typeCmp;
      return String(a.voucher_no || "").localeCompare(String(b.voucher_no || ""));
    });

    let runningQty = 0;
    let runningPurchaseQty = 0;
    let runningPurchaseAmount = 0;
    return rows.map((row) => {
      runningQty += toNumber(row.inward_qty) - toNumber(row.outward_qty);
      runningPurchaseQty += toNumber(row.inward_qty);
      runningPurchaseAmount += toNumber(row.inward_amount);
      const avgRate = runningPurchaseQty > 0 ? runningPurchaseAmount / runningPurchaseQty : 0;
      return {
        ...row,
        balance_qty: Number(runningQty.toFixed(4)),
        day_avg_rate: Number(avgRate.toFixed(2)),
        stock_value: Number((runningQty * avgRate).toFixed(2)),
      };
    });
  }, [stockDrilldown, stockPurchaseRows, stockSaleRows]);

  const stockDrilldownRows = stockDrilldownAllRows.filter((row) => {
    if (stockDrilldown?.mode === "purchase" && row.type !== "Purchase") return false;
    if (stockDrilldown?.mode === "sale" && row.type !== "Sale") return false;
    const date = String(row.date || "").slice(0, 10);
    if (stockDrilldownFromDate && date < stockDrilldownFromDate) return false;
    if (stockDrilldownToDate && date > stockDrilldownToDate) return false;
    return true;
  });

  const stockDrilldownTotals = stockDrilldownRows.reduce(
    (acc, row) => {
      acc.inward_qty += toNumber(row.inward_qty);
      acc.outward_qty += toNumber(row.outward_qty);
      acc.inward_amount += toNumber(row.inward_amount);
      acc.outward_amount += toNumber(row.outward_amount);
      acc.balance_qty = toNumber(row.balance_qty);
      acc.avg_rate = toNumber(row.day_avg_rate);
      acc.stock_value = toNumber(row.stock_value);
      return acc;
    },
    { inward_qty: 0, outward_qty: 0, inward_amount: 0, outward_amount: 0, balance_qty: 0, avg_rate: 0, stock_value: 0 }
  );

  const stockDrilldownTitle =
    stockDrilldown?.mode === "purchase"
      ? "Purchase Qty / Inward Details"
      : stockDrilldown?.mode === "sale"
        ? "Sale Qty / Outward Details"
        : "Stock Qty Full Details";
  const isStockDrilldownPurchase = stockDrilldown?.mode === "purchase";
  const isStockDrilldownSale = stockDrilldown?.mode === "sale";
  const isStockDrilldownCombined = !isStockDrilldownPurchase && !isStockDrilldownSale;

  const downloadStockDrilldownPdf = () => {
    if (!stockDrilldown) return;
    const doc = new jsPDF({ orientation: "landscape" });
    const title = stockDrilldownTitle;
    const subtitle = `${getWarehouseName(stockDrilldown.item)} | ${getAccountName(stockDrilldown.item)} | ${getProductName(stockDrilldown.item)}`;
    doc.setFontSize(14);
    doc.text(title, 14, 14);
    doc.setFontSize(9);
    doc.text(subtitle, 14, 20);
    const filterText = [
      stockDrilldownFromDate ? `From: ${formatLedgerDate(stockDrilldownFromDate)}` : "",
      stockDrilldownToDate ? `To: ${formatLedgerDate(stockDrilldownToDate)}` : "",
    ].filter(Boolean).join("  ");
    if (filterText) doc.text(filterText, 14, 26);

    const headRow = [
      "Date",
      "Type",
      "Voucher No",
      "Party",
      ...(isStockDrilldownSale ? [] : ["Inward Qty", "In Rate", "In Value"]),
      ...(isStockDrilldownPurchase ? [] : ["Outward Qty", "Out Rate", "Out Value"]),
      isStockDrilldownCombined ? "Stock Qty" : "Balance Qty",
      "Purchase Avg Rate",
      "Stock Value",
    ];
    const bodyRows = stockDrilldownRows.map((row) => [
      formatLedgerDate(row.date),
      row.type,
      row.voucher_no || "-",
      row.party_name || "-",
      ...(isStockDrilldownSale ? [] : [
        row.inward_qty ? formatDecimal4(row.inward_qty) : "",
        row.inward_rate ? formatMoney(row.inward_rate) : "",
        row.inward_amount ? formatMoney(row.inward_amount) : "",
      ]),
      ...(isStockDrilldownPurchase ? [] : [
        row.outward_qty ? formatDecimal4(row.outward_qty) : "",
        row.outward_rate ? formatMoney(row.outward_rate) : "",
        row.outward_amount ? formatMoney(row.outward_amount) : "",
      ]),
      formatDecimal4(row.balance_qty),
      formatMoney(row.day_avg_rate),
      formatMoney(row.stock_value),
    ]);
    const footRow = [
      "Total",
      "",
      "",
      "",
      ...(isStockDrilldownSale ? [] : [
        formatDecimal4(stockDrilldownTotals.inward_qty),
        "",
        formatMoney(stockDrilldownTotals.inward_amount),
      ]),
      ...(isStockDrilldownPurchase ? [] : [
        formatDecimal4(stockDrilldownTotals.outward_qty),
        "",
        formatMoney(stockDrilldownTotals.outward_amount),
      ]),
      formatDecimal4(stockDrilldownTotals.balance_qty),
      formatMoney(stockDrilldownTotals.avg_rate),
      formatMoney(stockDrilldownTotals.stock_value),
    ];

    autoTable(doc, {
      startY: filterText ? 31 : 26,
      styles: { fontSize: 7, cellPadding: 1.8, overflow: "linebreak" },
      headStyles: { fillColor: [8, 122, 115], textColor: 255 },
      footStyles: { fillColor: [239, 246, 255], textColor: 15, fontStyle: "bold" },
      head: [headRow],
      body: bodyRows,
      foot: [footRow],
      columnStyles: {
        3: { cellWidth: 42 },
      },
    });
    doc.save(`stock-qty-details-${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  return (
    <>
      <style>{paymentResponsiveCss}</style>
      <div ref={arrowNavRootRef} className="warehouse-trading-page" style={{ fontFamily: "Segoe UI, Arial, sans-serif", padding: "16px" }}>
      <style>{`
  .warehouse-trading-page { max-width: 100%; box-sizing: border-box; }
  .payment-mobile-shell { width: 100%; margin: 0 auto 14px; box-sizing: border-box; }
  @media (max-width: 820px) {
    .warehouse-trading-page { padding: 8px !important; }
    .payment-mobile-shell { width: 100%; padding: 11px !important; border-radius: 12px !important; }
    .payment-financial-summary { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
    .payment-selector-grid { grid-template-columns: 1fr !important; }
    .payment-entry-row { grid-template-columns: 1fr !important; }
    .payment-adjustment-action { justify-content: flex-start; }
  }
  @media (max-width: 480px) {
    .payment-financial-summary { grid-template-columns: 1fr 1fr !important; }
    .payment-stat-value { font-size: 11.5px !important; }
    .payment-selected-bar { display: grid !important; grid-template-columns: 1fr !important; }
  }
`}</style>
      <WarehouseTradingHeader
        activeTab={activeTab}
        activeTabStyle={activeTabStyle}
        globalSearch={globalSearch}
        onGlobalSearchChange={setGlobalSearch}
        showMobileTradingTabs={showMobileTradingTabs}
        onToggleTradingTabs={() => setShowMobileTradingTabs((prev) => !prev)}
        onShowVouchers={() => setActiveTab("vouchers")}
        onShowReports={() => setActiveTab("reports")}
        subtitleStyle={subtitleStyle}
        tabRow={tabRow}
        tabStyle={tabStyle}
        titleStyle={titleStyle}
      />

      {activeTab === "vouchers" ? (
        <div ref={voucherPanelRef}>
          <WarehouseVoucherPanel
            navigate={navigate}
            user={user}
            isPurchaseVoucher={isPurchaseVoucher}
            isPaymentVoucher={isPaymentVoucher}
            isReceiptVoucher={isReceiptVoucher}
            activeVoucherType={activeVoucherType}
            allowedVoucherTypes={allowedVoucherTypes}
            activeVoucherButtonStyle={activeVoucherButtonStyle}
            voucherButtonStyle={voucherButtonStyle}
            voucherTypeRow={voucherTypeRow}
            card={card}
            btnAction={btnAction}
            importingPurchase={importingPurchase}
            importingPayment={importingPayment}
            importingReceipt={importingReceipt}
            onDownloadPurchaseTemplate={downloadPurchaseImportTemplate}
            onDownloadPaymentTemplate={downloadPaymentImportTemplate}
            onDownloadReceiptTemplate={downloadReceiptImportTemplate}
            onImportPurchase={handlePurchaseExcelImport}
            onImportPayment={handlePaymentExcelImport}
            onImportReceipt={handleReceiptExcelImport}
            onChangeActiveVoucherType={setActiveVoucherType}
            editId={editId}
          >
            <form onSubmit={handleSubmit} onKeyDown={handleFormKeyDown}>
              {isPurchaseVoucher ? (
                <div className="purchase-voucher-mobile-form" style={erpShell}>
                  <div className="purchase-voucher-titlebar" style={erpTitleBar}>
                    <div className="purchase-voucher-title-left" style={erpTitleLeft}>
                      <span className="purchase-voucher-doc-icon" style={erpDocIcon}>P</span>
                      <span className="purchase-voucher-title" style={erpTitleText}>Purchase</span>
                    </div>
                    <div className="purchase-voucher-meta" style={erpMetaLine}>
                      <span>Subdocument : <strong>Purchase</strong></span>
                      <span>Type : <strong>{editId ? "Regular [ Edit ]" : "Regular [ New ]"}</strong></span>
                      <span>Location</span>
                      <input value={selectedLocationName || ""} readOnly style={{ ...erpInput, width: 120 }} />
                    </div>
                  </div>

                  <div className="purchase-voucher-top-grid" style={erpTopGrid}>
                    <div className="purchase-voucher-panel" style={erpPanelWide}>
                      <div className="purchase-voucher-row" style={erpRow}>
                        <label style={erpLabel}>Name</label>
                        <select name="farmer_id" value={formData.farmer_id} onChange={handleChange} style={{ ...erpInput, ...erpFocusInput }}>
                          <option value="">Select Party</option>
                          {farmers.map((f) => (
                            <option key={f.id || f._id} value={f.id || f._id}>{f.name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="purchase-voucher-row" style={erpRow}>
                        <label style={erpLabel}>Account</label>
                        {renderAccountSelect(erpInput)}
                      </div>
                      <div className="purchase-voucher-row" style={erpRow}>
                        <label style={erpLabel}>GSTIN</label>
                        <input value={selectedFarmerGst} readOnly style={erpInput} />
                        <label style={{ ...erpLabel, width: 42, textAlign: "right" }}>State</label>
                        <input value={selectedFarmerState} readOnly style={{ ...erpInput, width: 90 }} />
                      </div>
                      <div className="purchase-voucher-row" style={erpRow}>
                        <label style={erpLabel}>PAN No.</label>
                        <input value={selectedFarmerPan} readOnly style={erpInput} />
                        <label style={{ ...erpLabel, width: 50, textAlign: "right" }}>Mobile</label>
                        <input value={selectedFarmerMobile} readOnly style={{ ...erpInput, width: 110 }} />
                      </div>
                    </div>

                    <div className="purchase-voucher-panel" style={erpPanelWide}>
                      <div className="purchase-voucher-row" style={erpRow}>
                        <label style={erpLabel}>Warehouse Name</label>
                        <select name="warehouse_id" value={formData.warehouse_id} onChange={handleChange} style={erpInput}>
                          <option value="">Select Warehouse</option>
                          {warehouses.map((w) => (
                            <option key={w.id || w._id} value={w.id || w._id}>{w.name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="purchase-voucher-row" style={erpRow}>
                        <label style={erpLabel}>Employee Name</label>
                        <select name="employee_id" value={formData.employee_id} onChange={handleChange} style={erpInput}>
                          <option value="">Select Employee</option>
                          {employees.map((e) => (
                            <option key={e.id || e._id} value={e.id || e._id}>{e.name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="purchase-voucher-row" style={erpRow}>
                        <label style={erpLabel}>Employee Mobile</label>
                        <input value={selectedEmployeeMobile} readOnly style={erpInput} />
                      </div>
                    </div>

                    <div className="purchase-voucher-panel purchase-voucher-doc-panel" style={erpDocPanel}>
                      <div className="purchase-voucher-row" style={erpRow}>
                        <label style={erpLabel}>Number</label>
                        <input name="voucher_no" value={formData.voucher_no} onChange={handleChange} placeholder="Voucher No *" style={erpInput} required />
                      </div>
                      <div className="purchase-voucher-row" style={erpRow}>
                        <label style={erpLabel}>Date</label>
                        <input name="date" type="date" value={formData.date} onChange={handleChange} style={erpInput} required />
                      </div>
                      <div className="purchase-voucher-row" style={erpRow}>
                        <label style={erpLabel}>R. S. T No</label>
                        <input name="reference_id" value={formData.reference_id} onChange={handleChange} placeholder="R. S. T No" style={erpInput} />
                      </div>
                    </div>
                  </div>

                  <div className="purchase-voucher-section-label" style={erpSectionLabel}>GOODS PURCHASE DETAILS</div>
                  <div className="purchase-voucher-table-wrap" style={erpGridWrap}>
                    <table style={erpItemsTable}>
                      <thead>
                        <tr>
                          <th style={{ ...erpTh, width: 54 }}>S.L No</th>
                          <th style={{ ...erpTh, minWidth: 250 }}>Product</th>
                          <th style={erpTh}>Packet</th>
                          <th style={erpTh}>Gross Wt</th>
                          <th style={erpTh}>Tare Wt</th>
                          <th style={erpTh}>New Wt</th>
                          <th style={erpTh}>Dhalta</th>
                          {purchaseDeductionFields.map((field) => (
                            <th key={field.key} style={erpTh}>{field.label}</th>
                          ))}
                          <th style={erpTh}>Net Qty (Auto)</th>
                          <th style={erpTh}>Rate</th>
                          <th style={erpTh}>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td style={{ ...erpTd, textAlign: "center", fontWeight: 700 }}>1</td>
                          <td style={erpTd}>
                            <select name="product_id" value={formData.product_id} onChange={handleChange} style={erpCellInput}>
                              <option value="">Select Product</option>
                              {products.map((p) => (
                                <option key={p.id || p._id} value={p.id || p._id}>{p.name}</option>
                              ))}
                            </select>
                          </td>
                          <td style={erpTd}><input name="packet" type="number" step="0.0001" value={formData.packet} onChange={handleChange} style={erpCellInput} /></td>
                          <td style={erpTd}><input name="gross_weight" type="number" step="0.0001" value={formData.gross_weight} onChange={handleChange} style={erpCellInput} /></td>
                          <td style={erpTd}><input name="tare_weight" type="number" step="0.0001" value={formData.tare_weight} onChange={handleChange} style={erpCellInput} /></td>
                          <td style={erpTd}><input value={formatDecimal4(safePurchaseNewWeight)} readOnly style={{ ...erpCellInput, ...erpReadOnlyCell }} /></td>
                          <td style={erpTd}><input name="dhalta" type="number" step="0.0001" value={formData.dhalta} onChange={handleChange} style={erpCellInput} /></td>
                          {purchaseDeductionFields.map((field) => (
                            <td key={field.key} style={erpTd}>
                              <input name={field.key} type="number" step="0.0001" value={formData[field.key]} onChange={handleChange} style={erpCellInput} />
                            </td>
                          ))}
                          <td style={erpTd}><input value={formatDecimal4(safePurchaseNetWeight)} readOnly style={{ ...erpCellInput, ...erpReadOnlyCell }} /></td>
                          <td style={erpTd}><input name="rate" type="number" step="0.0001" value={formData.rate} onChange={handleChange} style={erpCellInput} /></td>
                          <td style={erpTd}><input value={formatMoney(purchaseGrossAmount)} readOnly style={{ ...erpCellInput, ...erpReadOnlyCell }} /></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <div className="purchase-voucher-middle-bar" style={erpMiddleBar}>
                      <span></span>
                      <strong>Total Quantity : {formatDecimal4(safePurchaseNetWeight)}</strong>
                  </div>

                  <div className="purchase-voucher-bottom-grid" style={erpBottomGrid}>
                    <div className="purchase-voucher-bottom-panel" style={{ display: "grid", gap: 12 }}>
                      <div style={{ border: "1px solid #dbe4ef", borderRadius: 10, background: "#fff", overflow: "hidden" }}>
                        <div style={{ padding: "10px 12px", background: "#0b2a5b", color: "#fff", fontWeight: 800 }}>Journal / Deduction Details</div>
                        <div style={{ overflowX: "auto" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                            <thead>
                              <tr>
                                <th style={{ ...erpTh, background: "#eef4ff", textAlign: "center" }}>Claim</th>
                                <th style={{ ...erpTh, background: "#eef4ff", textAlign: "center" }}>Labour</th>
                                <th style={{ ...erpTh, background: "#eef4ff", textAlign: "center" }}>Freight</th>
                                <th style={{ ...erpTh, background: "#eef4ff", textAlign: "center" }}>CD %</th>
                                <th style={{ ...erpTh, background: "#eef4ff", textAlign: "center" }}>CD Amount</th>
                                <th style={{ ...erpTh, background: "#eef4ff", textAlign: "center" }}>TDS</th>
                                <th style={{ ...erpTh, background: "#eef4ff", textAlign: "center" }}>Other</th>
                                <th style={{ ...erpTh, background: "#eef4ff", textAlign: "center" }}>Adjustment</th>
                                <th style={{ ...erpTh, background: "#eef4ff", textAlign: "center" }}>Round Off</th>
                                <th style={{ ...erpTh, background: "#eef4ff", textAlign: "center" }}>Total Deduction</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr>
                                <td style={erpTd}><input name="claim_amount" type="number" step="0.01" value={formData.claim_amount || formData.bags_claim} onChange={(e) => { handleChange(e); }} style={{ ...erpInput, width: "100%" }} /></td>
                                <td style={erpTd}><input name="labour" type="number" step="0.01" value={formData.labour} onChange={handleChange} style={{ ...erpInput, width: "100%" }} /></td>
                                <td style={erpTd}><input name="transport_charge" type="number" step="0.01" value={formData.transport_charge} onChange={handleChange} style={{ ...erpInput, width: "100%" }} /></td>
                                <td style={erpTd}><input name="cd_percent" type="number" step="0.01" value={formData.cd_percent} onChange={handleChange} style={{ ...erpInput, width: "100%" }} /></td>
                                <td style={erpTd}><input name="cd_amount" type="number" step="0.01" value={formData.cd_amount} onChange={handleChange} style={{ ...erpInput, width: "100%" }} /></td>
                                <td style={erpTd}><input name="tds_amount" type="number" step="0.01" value={formData.tds_amount} onChange={handleChange} style={{ ...erpInput, width: "100%" }} /></td>
                                <td style={erpTd}><input name="other_deduction" type="number" step="0.01" value={formData.other_deduction} onChange={handleChange} style={{ ...erpInput, width: "100%" }} /></td>
                                <td style={erpTd}><input name="adjustment_amount" type="number" step="0.01" value={formData.adjustment_amount} onChange={handleChange} style={{ ...erpInput, width: "100%" }} /></td>
                                <td style={erpTd}><input name="round_off" type="number" step="0.01" value={formData.round_off} onChange={handleChange} style={{ ...erpInput, width: "100%" }} /></td>
                                <td style={erpTd}><input value={formatMoney(purchaseTotalDeduction)} readOnly style={{ ...erpInput, width: "100%", background: "#f8fafc", fontWeight: 800 }} /></td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </div>

                      <div style={{ border: "1px solid #dbe4ef", borderRadius: 10, background: "#fff", overflow: "hidden" }}>
                        <div style={{ padding: "10px 12px", background: "#f3f4f6", borderBottom: "1px solid #dbe4ef", fontWeight: 800 }}>Payment / Receipt Details</div>
                        <div style={{ padding: 12, display: "grid", gap: 10, color: "#64748b", fontSize: 13 }}>
                          <div>Purchase payment / receipt adjustment can be posted from voucher actions after save.</div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
                            <div style={smartInfoBoxStyle}><span>Gross Amount</span><strong>{formatMoney(purchaseGrossAmount)}</strong></div>
                            <div style={smartInfoBoxStyle}><span>Total Deduction</span><strong>{formatMoney(purchaseTotalDeduction)}</strong></div>
                            <div style={smartInfoBoxStyle}><span>Net Payable</span><strong>{formatMoney(purchaseNetPayable)}</strong></div>
                          </div>
                        </div>
                      </div>

                      <div style={{ border: "1px solid #dbe4ef", borderRadius: 10, background: "#fff", overflow: "hidden" }}>
                        <div style={{ padding: "10px 12px", background: "#f3f4f6", borderBottom: "1px solid #dbe4ef", fontWeight: 800 }}>ERP Summary</div>
                        <div style={{ padding: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
                          <div style={smartInfoBoxStyle}><span>Gross Amount</span><strong>{formatMoney(purchaseGrossAmount)}</strong></div>
                          <div style={smartInfoBoxStyle}><span>Total Deduction</span><strong>{formatMoney(purchaseTotalDeduction)}</strong></div>
                          <div style={smartInfoBoxStyle}><span>Round Off</span><strong>{formatMoney(purchaseRoundOff)}</strong></div>
                          <div style={{ ...smartInfoBoxStyle, background: "#0b2a5b", color: "#fff", borderColor: "#0b2a5b" }}><span>Net Amount Payable</span><strong>{formatMoney(purchaseNetPayable)}</strong></div>
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <button type="button" onClick={resetPurchaseDeductions} style={{ ...btnAction, background: "#64748b" }}>
                          Auto Fill / Reset
                        </button>
                        <button type="button" onClick={capturePurchaseDeductionsAsDefault} style={{ ...btnAction, background: "#0f766e" }}>
                          Save as Current
                        </button>
                      </div>

                      <div className="purchase-voucher-remarks" style={erpRemarksRow}>
                        <label style={erpLabel}>Narration</label>
                        <textarea name="description" value={formData.description} onChange={handleChange} rows={2} style={erpTextarea} />
                      </div>
                    </div>

                    <div className="purchase-voucher-bottom-panel">
                      <table style={erpMiniTable}>
                        <thead>
                          <tr><th style={erpTh}>Purchase Summary</th><th style={erpTh}>Amount</th></tr>
                        </thead>
                        <tbody>
                          <tr><td style={erpTd}>Gross Amount</td><td style={erpTd}>{formatMoney(purchaseGrossAmount)}</td></tr>
                          <tr><td style={erpTd}>Total Deduction</td><td style={erpTd}>{formatMoney(purchaseTotalDeduction)}</td></tr>
                          <tr><td style={erpTd}>Round Off</td><td style={erpTd}>{formatMoney(purchaseRoundOff)}</td></tr>
                          <tr><td style={erpTd}>Net Amount Payable</td><td style={erpTd}>{formatMoney(purchaseNetPayable)}</td></tr>
                        </tbody>
                      </table>

                      <div className="purchase-voucher-total-panel" style={erpTotalPanel}>
                        <span style={erpTotalLabel}>T O T A L</span>
                        <strong style={erpTotalAmount}>{formatMoney(purchaseNetPayable)}</strong>
                      </div>
                    </div>
                  </div>
                </div>
              ) : isSaleVoucher ? (
                <div className="sale-voucher-mobile-form purchase-voucher-mobile-form" style={erpShell}>
                  <div className="purchase-voucher-titlebar sale-voucher-titlebar" style={erpTitleBar}>
                    <div style={erpTitleLeft}>
                      <span style={erpDocIcon}>S</span>
                      <span style={erpTitleText}>Sale</span>
                    </div>
                    <div style={erpMetaLine}>
                      <span>Subdocument : <strong>Sale</strong></span>
                      <span>Type : <strong>{editId ? "Regular [ Edit ]" : "Regular [ New ]"}</strong></span>
                      <span>Location</span>
                      <input value={selectedLocationName || ""} readOnly style={{ ...erpInput, width: 120 }} />
                    </div>
                  </div>

                  <div className="purchase-voucher-top-grid" style={erpTopGrid}>
                    <div style={erpPanelWide}>
                      <div style={erpRow}>
                        <label style={erpLabel}>Buyer Name</label>
                        <select name="buyer_id" value={formData.buyer_id || formData.company_id} onChange={handleChange} style={{ ...erpInput, ...erpFocusInput }}>
                          <option value="">Select Buyer</option>
                          {buyerNames.map((buyer) => (
                            <option key={buyer.id || buyer._id} value={buyer.id || buyer._id}>{buyer.name}</option>
                          ))}
                        </select>
                      </div>
                      <div style={erpRow}>
                        <label style={erpLabel}>Account</label>
                        {renderAccountSelect(erpInput)}
                      </div>
                      <div style={erpRow}>
                        <label style={erpLabel}>Consignee</label>
                        <select name="consignee_id" value={formData.consignee_id} onChange={handleChange} style={erpInput}>
                          <option value="">{formData.buyer_id || formData.company_id ? "Select Consignee" : "Select Buyer First"}</option>
                          {filteredConsignees.map((c) => (
                            <option key={c.id || c._id} value={c.id || c._id}>{c.name}</option>
                          ))}
                        </select>
                      </div>
                      <div style={erpRow}>
                        <label style={erpLabel}>GSTIN</label>
                        <input value={selectedBuyer?.gst_no || selectedConsignee?.gst_no || ""} readOnly style={erpInput} />
                        <label style={{ ...erpLabel, width: 42, textAlign: "right" }}>State</label>
                        <input value={selectedBuyer?.state || selectedConsignee?.state || ""} readOnly style={{ ...erpInput, width: 90 }} />
                      </div>
                      <div style={erpRow}>
                        <label style={erpLabel}>PAN No.</label>
                        <input value={selectedBuyer?.pan_no || selectedConsignee?.pan_no || ""} readOnly style={erpInput} />
                        <label style={{ ...erpLabel, width: 50, textAlign: "right" }}>Mobile</label>
                        <input value={selectedBuyer?.mobile || selectedConsignee?.mobile || ""} readOnly style={{ ...erpInput, width: 110 }} />
                      </div>
                      {formData.sale_type === "direct" && (
                        <>
                          <div style={erpRow}>
                            <label style={erpLabel}>Location</label>
                            <select name="location_id" value={formData.location_id} onChange={handleChange} style={erpInput}>
                              <option value="">Select Location</option>
                              {locations.map((location) => (
                                <option key={location.id || location._id} value={location.id || location._id}>{location.name}</option>
                              ))}
                            </select>
                          </div>
                          <div style={erpRow}>
                            <label style={erpLabel}>Farmer</label>
                            <select name="farmer_id" value={formData.farmer_id} onChange={handleChange} style={erpInput}>
                              <option value="">Select Farmer</option>
                              {farmers.map((farmer) => (
                                <option key={farmer.id || farmer._id} value={farmer.id || farmer._id}>{farmer.name}</option>
                              ))}
                            </select>
                          </div>
                          <div style={erpRow}>
                            <label style={erpLabel}>Purchase Rate</label>
                            <input name="direct_purchase_rate" type="number" step="0.0001" value={formData.direct_purchase_rate} onChange={handleChange} style={erpInput} />
                          </div>
                          <div style={erpRow}>
                            <label style={erpLabel}>Purchase Amount</label>
                            <input value={formatMoney(saleDispatchQtyFromData(formData) * toNumber(formData.direct_purchase_rate))} readOnly style={erpInput} />
                          </div>
                        </>
                      )}
                    </div>

                    <div style={erpPanelWide}>
                      {formData.sale_type !== "direct" && (
                        <div style={erpRow}>
                          <label style={erpLabel}>Warehouse Name</label>
                          <select name="warehouse_id" value={formData.warehouse_id} onChange={handleChange} style={erpInput}>
                            <option value="">Select Warehouse</option>
                            {warehouses.map((w) => (
                              <option key={w.id || w._id} value={w.id || w._id}>{w.name}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div style={erpRow}>
                        <label style={erpLabel}>Employee Name</label>
                        <select name="employee_id" value={formData.employee_id} onChange={handleChange} style={erpInput}>
                          <option value="">Select Employee</option>
                          {employees.map((e) => (
                            <option key={e.id || e._id} value={e.id || e._id}>{e.name}</option>
                          ))}
                        </select>
                      </div>
                      <div style={erpRow}>
                        <label style={erpLabel}>Employee Mobile</label>
                        <input value={selectedEmployeeMobile} readOnly style={erpInput} />
                      </div>
                    </div>

                    <div style={erpDocPanel}>
                      <div style={erpRow}>
                        <label style={erpLabel}>Sale Type</label>
                        <select name="sale_type" value={formData.sale_type || "direct"} onChange={handleChange} style={erpInput}>
                          <option value="direct">Direct Farmer Loading Sale</option>
                          <option value="warehouse">Warehouse Sale</option>
                        </select>
                      </div>
                      <div style={erpRow}>
                        <label style={erpLabel}>Number</label>
                        <input name="voucher_no" value={formData.voucher_no} onChange={handleChange} placeholder="Voucher No *" style={erpInput} required />
                      </div>
                      <div style={erpRow}>
                        <label style={erpLabel}>Date</label>
                        <input name="date" type="date" value={formData.date} onChange={handleChange} style={erpInput} required />
                      </div>
                      <div style={erpRow}>
                        <label style={erpLabel}>Unloading Date</label>
                        <input name="unloading_date" type="date" value={formData.unloading_date} onChange={handleChange} style={erpInput} />
                      </div>
                      <div style={erpRow}>
                        <label style={erpLabel}>Due Days</label>
                        <input name="due_days" type="number" min="0" value={formData.due_days} onChange={handleChange} style={erpInput} />
                      </div>
                      <div style={erpRow}>
                        <label style={erpLabel}>P.O No</label>
                        <input name="po_no" value={formData.po_no} onChange={handleChange} style={erpInput} />
                      </div>
                      <div style={erpRow}>
                        <label style={erpLabel}>Due Date</label>
                        <input name="due_date" type="date" value={formData.due_date} onChange={handleChange} style={erpInput} />
                      </div>
                      <div style={erpRow}>
                        <label style={erpLabel}>R. S. T No</label>
                        <input name="reference_id" value={formData.reference_id} onChange={handleChange} placeholder="R. S. T No" style={erpInput} />
                      </div>
                    </div>
                  </div>

                  <div className="purchase-voucher-section-label" style={erpSectionLabel}>GOODS SALE DETAILS</div>
                  <div className="purchase-voucher-table-wrap" style={erpGridWrap}>
                    <table style={erpItemsTable}>
                      <thead>
                        <tr>
                          <th style={{ ...erpTh, width: 54 }}>S.L No</th>
                          <th style={{ ...erpTh, minWidth: 250 }}>Product</th>
                          <th style={erpTh}>Packet</th>
                          <th style={erpTh}>Gross Wt</th>
                          <th style={erpTh}>Tare Wt</th>
                          <th style={erpTh}>New Wt</th>
                          <th style={erpTh}>Net Qty (Auto)</th>
                          <th style={erpTh}>Rate</th>
                          <th style={erpTh}>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td style={{ ...erpTd, textAlign: "center", fontWeight: 700 }}>1</td>
                          <td style={erpTd}>
                            <select name="product_id" value={formData.product_id} onChange={handleChange} style={erpCellInput}>
                              <option value="">Select Product</option>
                              {products.map((p) => (
                                <option key={p.id || p._id} value={p.id || p._id}>{p.name}</option>
                              ))}
                            </select>
                          </td>
                          <td style={erpTd}><input name="packet" type="number" step="0.0001" value={formData.packet} onChange={handleChange} style={erpCellInput} /></td>
                          <td style={erpTd}><input name="gross_weight" type="number" step="0.0001" value={formData.gross_weight} onChange={handleChange} style={erpCellInput} /></td>
                          <td style={erpTd}><input name="tare_weight" type="number" step="0.0001" value={formData.tare_weight} onChange={handleChange} style={erpCellInput} /></td>
                          <td style={erpTd}><input value={formatDecimal4(toNumber(formData.gross_weight) - toNumber(formData.tare_weight))} readOnly style={{ ...erpCellInput, ...erpReadOnlyCell }} /></td>
                          <td style={erpTd}><input value={formatDecimal4(saleQtyFromData(formData))} readOnly style={{ ...erpCellInput, ...erpReadOnlyCell }} /></td>
                          <td style={erpTd}><input name="rate" type="number" step="0.0001" value={formData.rate} onChange={handleChange} style={erpCellInput} /></td>
                          <td style={erpTd}><input value={formatMoney(saleGrossAmountFromData(formData))} readOnly style={{ ...erpCellInput, ...erpReadOnlyCell }} /></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <div style={erpMiddleBar}>
                      <span></span>
                      <strong>Sale Date : {formData.date || "Not Set"}</strong>
                  </div>

                  <div style={erpBottomGrid}>
                    <div>
                      <table style={erpMiniTable}>
                        <thead>
                          <tr><th style={erpTh}>Particulars</th><th style={erpTh}>Amount</th></tr>
                        </thead>
                        <tbody>
                          <tr><td style={erpTd}>Lorry No</td><td style={erpTd}><input name="lorry_no" value={formData.lorry_no} onChange={handleChange} style={erpCellInput} /></td></tr>
                          <tr><td style={erpTd}>Add Mall Qty</td><td style={erpTd}><input
                            name="add_qty"
                            type="number"
                            step="0.0001"
                            value={formData.add_qty}
                            onChange={handleChange}
                            style={erpCellInput}
                            placeholder="Manual add qty"
                          /></td></tr>
                          <tr><td style={erpTd}>Other Deduction</td><td style={erpTd}><input name="other_deduction" type="number" step="0.0001" value={formData.other_deduction} onChange={handleChange} style={erpCellInput} /></td></tr>
                          <tr>
                            <td style={erpTd}>CD %</td>
                            <td style={erpTd}>
                              <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 6 }}>
                                <input name="cd_percent" type="number" step="0.0001" value={formData.cd_percent} onChange={handleChange} style={erpCellInput} />
                                <input value={formatMoney(saleCashDiscountAmount)} readOnly style={{ ...erpCellInput, ...erpReadOnlyCell }} />
                              </div>
                            </td>
                          </tr>
                          <tr><td style={erpTd}>Claim/TDS</td><td style={erpTd}><input name="claim_amount" type="number" step="0.0001" value={formData.claim_amount} onChange={handleChange} style={erpCellInput} /></td></tr>
                          <tr><td style={{ ...erpTd, fontWeight: 700 }}>Total Deduction</td><td style={{ ...erpTd, fontWeight: 700 }}>{formatMoney(toNumber(formData.other_deduction) + toNumber(formData.claim_amount) + saleCashDiscountAmount)}</td></tr>
                          <tr><td style={erpTd}>Round Off</td><td style={erpTd}><input name="round_off" type="number" step="0.0001" value={formData.round_off} onChange={handleChange} style={erpCellInput} /></td></tr>
                          <tr><td style={erpTd}>F2 Voucher Pass</td><td style={erpTd}><button type="button" onClick={() => setShowSaleDeductionModal(true)} style={{ ...btnAction, background: "#0f766e", width: "100%" }}>F2 Voucher Pass</button></td></tr>
                        </tbody>
                      </table>
                      <div style={erpRemarksRow}>
                        <label style={erpLabel}>Narration</label>
                        <textarea name="description" value={formData.description} onChange={handleChange} rows={2} style={erpTextarea} />
                      </div>
                      {activeVoucherType === "sale" && (
                        <div style={smartInfoGridStyle}>
                          <div style={smartInfoBoxStyle}>
                            <span>Buyer Sale Qty</span>
                            <strong>{formatDecimal4(selectedBuyerSaleQty)}</strong>
                          </div>
                          <div style={smartInfoBoxStyle}>
                            <span>Balance Amount</span>
                            <strong>{formatMoney(selectedBuyerBalanceAmount)}</strong>
                          </div>
                          <div style={smartInfoBoxStyle}>
                            <span>Pending Amount</span>
                            <strong>{formatMoney(selectedBuyerPendingAmount)}</strong>
                          </div>
                          {formData.sale_type !== "direct" && (
                            <div style={smartInfoBoxStyle}>
                              <span>Warehouse Balance Qty</span>
                              <strong>{selectedWarehouseBalanceQty === null ? "-" : formatDecimal4(selectedWarehouseBalanceQty)}</strong>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div>
                      <table style={erpMiniTable}>
                        <thead>
                          <tr><th style={erpTh}>Sale Summary</th><th style={erpTh}>Amount</th></tr>
                        </thead>
                        <tbody>
                          <tr><td style={erpTd}>Gross Amount</td><td style={erpTd}>{formatMoney(saleGrossAmountFromData(formData))}</td></tr>
                          <tr><td style={erpTd}>Cash Discount</td><td style={erpTd}>{formatMoney(saleCashDiscountAmount)}</td></tr>
                          <tr><td style={erpTd}>Total Deduction</td><td style={erpTd}>{formatMoney(toNumber(formData.other_deduction) + toNumber(formData.claim_amount) + saleCashDiscountAmount)}</td></tr>
                          <tr><td style={erpTd}>Round Off</td><td style={erpTd}>{formatMoney(toNumber(formData.round_off))}</td></tr>
                          <tr><td style={erpTd}>Net Amount Payable</td><td style={erpTd}>{formatMoney(saleNetReceivablePreview)}</td></tr>
                        </tbody>
                      </table>

                      <div style={erpTotalPanel}>
                        <span style={erpTotalLabel}>T O T A L</span>
                        <strong style={erpTotalAmount}>{formatMoney(saleNetReceivablePreview)}</strong>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  {activeVoucherType === "payment" && (
                    <div className="payment-mobile-shell" style={paymentHeroCard}>
                      <div style={paymentHeroHeader}>
                        <div>
                          <div style={paymentEyebrow}>PAYMENT VOUCHER</div>
                          <h3 style={paymentHeroTitle}>Smart Payment Entry</h3>
                          <p style={paymentHeroSubtitle}>Select account, warehouse and pending farmer, then adjust purchase bills.</p>
                        </div>
                        <div style={paymentBadge}>⚡ Smart Entry</div>
                      </div>

                      <div style={paymentModeRow}>
                        {paymentModeOptions.map((option) => {
                          const isActive = activePaymentMode === option.value;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() =>
                                handlePaymentModeChange(option.value, {
                                  amount: formData.amount,
                                  farmer_id: formData.farmer_id,
                                  warehouse_id: formData.warehouse_id,
                                  company_account_id: formData.company_account_id,
                                })
                              }
                              style={{
                                ...paymentModeButton,
                                ...(isActive ? paymentModeButtonActive : {}),
                              }}
                            >
                              {option.label}
                            </button>
                          );
                        })}
                      </div>

                      <div style={paymentSelectorGrid}>
                        <SearchableSelect
                          label="Account"
                          value={formData.company_account_id}
                          options={companyAccounts.map((a) => ({
                            value: a.id || a._id,
                            label: a.account_name || a.name,
                          }))}
                          onChange={(value) => handleChange({ target: { name: "company_account_id", value } })}
                          placeholder="Choose account"
                        />
                        <SearchableSelect
                          label="Warehouse"
                          value={formData.warehouse_id}
                          options={paymentWarehouses.map((w) => ({
                            value: w.id || w._id,
                            label: w.name,
                          }))}
                          onChange={(value) => handleChange({ target: { name: "warehouse_id", value } })}
                          placeholder={formData.company_account_id ? "Choose warehouse" : "Choose account first"}
                          disabled={!formData.company_account_id}
                        />
                        <SearchableSelect
                          label="Pending Farmer"
                          value={formData.farmer_id}
                          options={accountFarmers.map((f) => ({
                            value: f.id || f._id,
                            label: `${f.name}${f.outstanding !== undefined ? ` — Due Rs.${formatMoney(f.outstanding)}` : ""}`,
                          }))}
                          onChange={(value) => handleChange({ target: { name: "farmer_id", value } })}
                          placeholder={formData.warehouse_id ? "Choose pending farmer" : "Choose warehouse first"}
                          disabled={!formData.warehouse_id}
                        />
                      </div>

                      <div className="payment-financial-summary" style={paymentFinancialSummary}>
                        <div style={paymentStatCard}>
                          <span style={paymentStatLabel}>Total Bill</span>
                          <strong style={paymentStatValue}>Rs.{formatMoney(paymentTotalBill)}</strong>
                        </div>
                        <div style={paymentStatCard}>
                          <span style={paymentStatLabel}>Total Deduction</span>
                          <strong style={paymentStatValue}>Rs.{formatMoney(paymentTotalDeduction)}</strong>
                        </div>
                        <div style={paymentStatCard}>
                          <span style={paymentStatLabel}>Total Paid</span>
                          <strong style={paymentStatValue}>Rs.{formatMoney(paymentTotalPaid)}</strong>
                        </div>
                        <div style={{ ...paymentStatCard, ...paymentDueCard }}>
                          <span style={paymentStatLabel}>Total Due</span>
                          <strong style={{ ...paymentStatValue, color: "#b91c1c" }}>Rs.{formatMoney(paymentTotalDue)}</strong>
                        </div>
                      </div>

                      <div className="payment-entry-row" style={paymentEntryRow}>
                        <Field label="Payment Amount">
                          <input
                            name="amount"
                            type="number"
                            step="0.0001"
                            value={formData.amount}
                            onChange={(event) => {
                              handleChange(event);
                              setPaymentAdjustments([]);
                            }}
                            style={paymentAmountInput}
                            required
                          />
                        </Field>
                        <div style={paymentAdjustmentAction}>
                          <button
                            type="button"
                            onClick={openPaymentAdjustmentPopup}
                            style={{ ...btnAction, background: "#2563eb", minHeight: 42 }}
                            disabled={
                              !formData.company_account_id ||
                              !formData.warehouse_id ||
                              !formData.farmer_id ||
                              toNumber(formData.amount) <= 0
                            }
                          >
                            Open Adjustment
                          </button>
                          <span style={paymentAdjustedText}>
                            Adjusted: <strong>Rs.{formatMoney(paymentAdjustmentTotal)}</strong>
                          </span>
                        </div>
                      </div>

                      <div style={paymentSelectedBar}>
                        <span><b>Account:</b> {getAccountName(formData) || "Choose account"}</span>
                        <span><b>Warehouse:</b> {getWarehouseName(formData) || "Choose warehouse"}</span>
                        <span><b>Farmer:</b> {farmers.find((f) => String(f.id || f._id) === String(formData.farmer_id))?.name || "Pick the pending farmer"}</span>
                      </div>
                    </div>
                  )}
                  <div style={formGrid}>
                <Field label="Voucher No">
                  <input name="voucher_no" value={formData.voucher_no} onChange={handleChange} placeholder="Voucher No *" style={inp} required />
                </Field>
                <Field label="Date">
                  <input name="date" type="date" value={formData.date} onChange={handleChange} style={inp} required />
                </Field>
                {activeVoucherType === "sale" && (
                  <Field label="Sale Type">
                    <select name="sale_type" value={formData.sale_type || "direct"} onChange={handleChange} style={inp}>
                      <option value="direct">Direct Farmer Loading Sale</option>
                      <option value="warehouse">Warehouse Sale</option>
                    </select>
                  </Field>
                )}
                {(activeVoucherType !== "payment" && (activeVoucherType !== "sale" || formData.sale_type !== "direct")) && (
                  <Field label="Warehouse">
                    <select name="warehouse_id" value={formData.warehouse_id} onChange={handleChange} style={inp}>
                      <option value="">Select Warehouse</option>
                      {warehouses.map((w) => (
                        <option key={w.id || w._id} value={w.id || w._id}>{w.name}</option>
                      ))}
                    </select>
                  </Field>
                )}
                {activeVoucherType !== "payment" && (
                  <>
                    <Field label="Location">
                      <select name="location_id" value={formData.location_id} onChange={handleChange} style={inp}>
                        <option value="">Select Location</option>
                        {locations.map((l) => (
                          <option key={l.id || l._id} value={l.id || l._id}>{l.name}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Employee">
                      <select name="employee_id" value={formData.employee_id} onChange={handleChange} style={inp}>
                        <option value="">Select Employee</option>
                        {employees.map((e) => (
                          <option key={e.id || e._id} value={e.id || e._id}>{e.name}</option>
                        ))}
                      </select>
                    </Field>
                  </>
                )}
                {activeVoucherType !== "payment" && <Field label="Account">
                  {renderAccountSelect(inp)}
                </Field>}
                {activeVoucherType === "sale" && formData.sale_type === "direct" && (
                  <>
                    <Field label="Farmer">
                      <select name="farmer_id" value={formData.farmer_id} onChange={handleChange} style={inp}>
                        <option value="">Select Farmer</option>
                        {farmers.map((farmer) => (
                          <option key={farmer.id || farmer._id} value={farmer.id || farmer._id}>{farmer.name}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Purchase Rate">
                      <input name="direct_purchase_rate" type="number" step="0.0001" value={formData.direct_purchase_rate} onChange={handleChange} style={inp} />
                    </Field>
                    <Field label="Purchase Amount">
                      <input value={formatMoney(saleDispatchQtyFromData(formData) * toNumber(formData.direct_purchase_rate))} readOnly style={readOnlyInp} />
                    </Field>
                  </>
                )}

                {(activeVoucherType === "purchase" || activeVoucherType === "payment") && (
                  <>
                    {activeVoucherType === "payment" && false && (
                      <Field label="Amount">
                        <input
                          name="amount"
                          type="number"
                          step="0.0001"
                          value={formData.amount}
                          onChange={(event) => {
                            handleChange(event);
                            setPaymentAdjustments([]);
                          }}
                          style={inp}
                          required
                        />
                      </Field>
                    )}
                    {activeVoucherType !== "payment" && <Field label="Farmer (Creditor)">
                      <select name="farmer_id" value={formData.farmer_id} onChange={handleChange} style={inp}>
                        <option value="">Select Farmer</option>
                        {(activeVoucherType === "payment" && formData.company_account_id
                          ? accountFarmers
                          : farmers
                        ).map((f) => (
                          <option key={f.id || f._id} value={f.id || f._id}>
                            {f.name}
                            {activeVoucherType === "payment" && formData.company_account_id && f.outstanding !== undefined
                              ? ` (Balance: ${formatMoney(f.outstanding)})`
                              : ""}
                          </option>
                        ))}
                        {activeVoucherType === "payment" && formData.company_account_id && accountFarmers.length === 0 && (
                          <option value="" disabled>
                            No farmers with outstanding balance for this account
                          </option>
                        )}
                      </select>
                    </Field>}
                    {false && partyOutstanding && activeVoucherType === "payment" && (
                      <div style={{ marginTop: 8, fontSize: 13, color: "#444", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span>Party: <strong>{formData.company_account_id ? companyAccounts.find(ca => String(ca.id || ca._id) === String(formData.company_account_id))?.account_name || "-" : "-"}</strong></span>
                        <span>Farmer Bill: <strong>Rs.{formatMoney(partyOutstanding.stats?.total_purchase ?? partyOutstanding.total_purchase ?? 0)}</strong></span>
                        <span>Paid: <strong>Rs.{formatMoney(partyOutstanding.stats?.total_payment ?? partyOutstanding.total_payment ?? 0)}</strong></span>
                        <span>Balance: <strong>Rs.{formatMoney(partyOutstanding.stats?.outstanding ?? partyOutstanding.outstanding ?? 0)}</strong></span>
                        <button type="button" onClick={openPaymentAdjustmentPopup} style={{ ...btnAction, background: "#2563eb" }}>
                          Adjust Bills
                        </button>
                        <span>Adjusted: <strong>Rs.{formatMoney(paymentAdjustmentTotal)}</strong></span>
                      </div>
                    )}
                  </>
                )}

                {(activeVoucherType === "sale" || activeVoucherType === "receipt") && (
                  <>
                    {activeVoucherType === "sale" ? (
                      <Field label="Buyer Name">
                        <select name="buyer_id" value={formData.buyer_id || formData.company_id} onChange={handleChange} style={inp}>
                          <option value="">Select Buyer</option>
                          {buyerNames.map((buyer) => (
                            <option key={buyer.id || buyer._id} value={buyer.id || buyer._id}>{buyer.name}</option>
                          ))}
                        </select>
                      </Field>
                    ) : (
                      <Field label="Buyer (Debtor)">
                        <select name="company_id" value={formData.company_id} onChange={handleChange} style={inp}>
                          <option value="">Select Buyer</option>
                          {buyerNames.map((c) => (
                            <option key={c.id || c._id} value={c.id || c._id}>{c.name}</option>
                          ))}
                        </select>
                      </Field>
                    )}
                    {partyOutstanding && activeVoucherType === "receipt" && (
                      <div style={{ marginTop: 8, fontSize: 13, color: "#444" }}>
                        Current outstanding: Rs.{formatMoney(partyOutstanding.stats?.outstanding ?? partyOutstanding.outstanding ?? 0)}
                      </div>
                    )}
                    <Field label="Consignee">
                      <div style={{ fontSize: 12, color: "#0f766e", fontWeight: 700, marginBottom: 4 }}>
                        {activeVoucherType === "sale" && (formData.buyer_id || formData.company_id)
                          ? `Buyer: ${getCompanyName({ company_id: formData.company_id || formData.buyer_id })}`
                          : "Select a buyer first"}
                      </div>
                      <select name="consignee_id" value={formData.consignee_id} onChange={handleChange} style={inp}>
                        <option value="">{activeVoucherType === "sale" && !(formData.buyer_id || formData.company_id) ? "Select Buyer First" : "Select Consignee"}</option>
                        {(activeVoucherType === "sale" ? filteredConsignees : consignees).map((c) => (
                          <option key={c.id || c._id} value={c.id || c._id}>{c.name}</option>
                        ))}
                      </select>
                    </Field>
                  </>
                )}

                {(activeVoucherType === "purchase" || activeVoucherType === "sale") && (
                  <>
                    <Field label="Product">
                      <select name="product_id" value={formData.product_id} onChange={handleChange} style={inp}>
                        <option value="">Select Product</option>
                        {products.map((p) => (
                          <option key={p.id || p._id} value={p.id || p._id}>{p.name}</option>
                        ))}
                      </select>
                    </Field>
                    {activeVoucherType === "sale" && formData.sale_type !== "direct" && (
                      <div style={{ gridColumn: "1 / -1", border: "1px solid #dbe3ef", borderRadius: 8, padding: 12, background: "#f8fafc" }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, color: "#334155" }}>
                          <input
                            name="against_purchase_enabled"
                            type="checkbox"
                            checked={Boolean(formData.against_purchase_enabled)}
                            onChange={handleChange}
                          />
                          Against Purchase Bill / Farmer Bill
                        </label>
                        {formData.against_purchase_enabled && (
                          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                            <Field label="Farmer">
                              <select name="against_purchase_farmer_id" value={formData.against_purchase_farmer_id} onChange={handleChange} style={inp}>
                                <option value="">Select Farmer</option>
                                {farmers.map((farmer) => (
                                  <option key={farmer.id || farmer._id} value={farmer.id || farmer._id}>{farmer.name}</option>
                                ))}
                              </select>
                            </Field>
                            <div style={{ overflowX: "auto" }}>
                              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, background: "#fff" }}>
                                <thead>
                                  <tr style={reportHeaderRowStyle}>
                                    <th style={th}>Purchase Bill</th>
                                    <th style={th}>Date</th>
                                    <th style={th}>Farmer</th>
                                    <th style={th}>Qty</th>
                                    <th style={th}>Rate</th>
                                    <th style={th}>Against Qty</th>
                                    <th style={th}>Amount</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {againstPurchaseRows.map((purchase) => {
                                    const purchaseId = String(purchase.id || purchase._id || "");
                                    const link = againstPurchaseLinkMap.get(purchaseId) || {};
                                    const qty = toNumber(link.quantity);
                                    return (
                                      <tr key={purchaseId}>
                                        <td style={td}>{purchase.voucher_no || "-"}</td>
                                        <td style={td}>{formatLedgerDate(purchase.date)}</td>
                                        <td style={td}>{getFarmerName(purchase)}</td>
                                        <td style={td}>{formatDecimal4(purchase.total_qty || purchase.net_weight || purchase.quantity || 0)}</td>
                                        <td style={td}>{formatMoney(purchase.rate || 0)}</td>
                                        <td style={td}>
                                          <input
                                            type="number"
                                            step="0.0001"
                                            min="0"
                                            value={qty || ""}
                                            onChange={(event) => updateSalePurchaseLink(purchase, event.target.value)}
                                            style={{ ...inp, minWidth: 110 }}
                                          />
                                        </td>
                                        <td style={td}>{formatMoney(qty * toNumber(purchase.rate))}</td>
                                      </tr>
                                    );
                                  })}
                                  {againstPurchaseRows.length === 0 && (
                                    <tr><td colSpan={7} style={{ ...td, textAlign: "center", padding: 14 }}>No matching purchase bill found.</td></tr>
                                  )}
                                </tbody>
                              </table>
                            </div>
                            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13, color: "#334155" }}>
                              <strong>Against Qty: {formatDecimal4(againstPurchaseTotalQty)}</strong>
                              <strong>Purchase Amount: Rs.{formatMoney(againstPurchaseTotalAmount)}</strong>
                              <strong>Sale Qty: {formatDecimal4(saleDispatchQtyFromData(formData))}</strong>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    <Field label={activeVoucherType === "sale" ? "Loading Date" : "Date"}>
                      <input name="date" type="date" value={formData.date} onChange={handleChange} style={inp} />
                    </Field>
                    {activeVoucherType === "sale" && (
                      <Field label="Unloading Date">
                        <input name="unloading_date" type="date" value={formData.unloading_date} onChange={handleChange} style={inp} />
                      </Field>
                    )}
                    {activeVoucherType === "sale" && (
                      <>
                        <Field label="P.O No">
                          <input name="po_no" value={formData.po_no} onChange={handleChange} style={inp} />
                        </Field>
                        <Field label="Due Days">
                          <input name="due_days" type="number" min="0" value={formData.due_days} onChange={handleChange} style={inp} />
                        </Field>
                        <Field label="Due Date">
                          <input name="due_date" type="date" value={formData.due_date} onChange={handleChange} style={inp} />
                        </Field>
                      </>
                    )}
                    <Field label="Quantity">
                      <input name="quantity" type="number" step="0.0001" value={formData.quantity} onChange={handleChange} style={inp} />
                    </Field>
                    {activeVoucherType === "sale" && (
                      <Field label="Shortage Quantity">
                        <input name="shortage_quantity" type="number" step="0.0001" value={formData.shortage_quantity} onChange={handleChange} style={inp} />
                      </Field>
                    )}
                    <Field label="Rate">
                      <input name="rate" type="number" step="0.0001" value={formData.rate} onChange={handleChange} style={inp} />
                    </Field>
                    <Field label="Amount">
                      <input name="amount" type="number" step="0.0001" value={activeVoucherType === "sale" ? formatMoney(saleGrossAmountFromData(formData)) : formData.amount} onChange={handleChange} style={activeVoucherType === "sale" ? readOnlyInp : inp} readOnly={activeVoucherType === "sale"} />
                    </Field>
                    {activeVoucherType === "sale" && (
                      <>
                        <Field label="Claim Amount">
                          <input name="claim_amount" type="number" step="0.0001" value={formData.claim_amount} onChange={handleChange} style={inp} />
                        </Field>
                        <Field label="Other Deduction">
                          <input name="other_deduction" type="number" step="0.0001" value={formData.other_deduction} onChange={handleChange} style={inp} />
                        </Field>
                        <Field label="CD %">
                          <input name="cd_percent" type="number" step="0.0001" value={formData.cd_percent} onChange={handleChange} style={inp} />
                        </Field>
                        <Field label="CD Amount">
                          <input value={formatMoney(saleCashDiscountAmount)} readOnly style={readOnlyInp} />
                        </Field>
                        <Field label="Adjustment Amount">
                          <input name="adjustment_amount" type="number" step="0.0001" value={formData.adjustment_amount} onChange={handleChange} style={inp} />
                        </Field>
                        <Field label="TDS Amount">
                          <input name="tds_amount" type="number" step="0.0001" value={formData.tds_amount} onChange={handleChange} style={inp} />
                        </Field>
                        <Field label="Unloading Qty">
                          <input name="unloading_qty" type="number" step="0.0001" value={formData.unloading_qty} onChange={handleChange} style={inp} />
                        </Field>
                        <Field label="Net Receivable">
                          <input value={formatMoney(saleNetReceivablePreview)} readOnly style={readOnlyInp} />
                        </Field>
                        <Field label="FIFO Amount">
                          <input value={formatMoney(saleGrossAmountFromData(formData))} readOnly style={readOnlyInp} />
                        </Field>
                        <div style={{ marginTop: 8, fontSize: 13, color: "#444" }}>
                          Outstanding: Rs.{formatMoney(saleNetReceivablePreview)}
                        </div>
                        <div style={smartInfoGridStyle}>
                          <div style={smartInfoBoxStyle}><span>Buyer Sale Qty</span><strong>{formatDecimal4(selectedBuyerSaleQty)}</strong></div>
                          <div style={smartInfoBoxStyle}><span>Balance Amount</span><strong>{formatMoney(selectedBuyerBalanceAmount)}</strong></div>
                          <div style={smartInfoBoxStyle}><span>Pending Amount</span><strong>{formatMoney(selectedBuyerPendingAmount)}</strong></div>
                          {formData.sale_type !== "direct" && (
                            <div style={smartInfoBoxStyle}><span>Warehouse Balance Qty</span><strong>{selectedWarehouseBalanceQty === null ? "-" : formatDecimal4(selectedWarehouseBalanceQty)}</strong></div>
                          )}
                        </div>
                      </>
                    )}
                  </>
                )}

                {activeVoucherType === "payment" && (
                  <>
                    <Field label={activePaymentMode === "against" ? "Reference Bills" : activePaymentMode === "new_reference" ? "Reference / Note" : "Reference Note"}>
                      <input
                        name="reference_id"
                        value={activePaymentMode === "against"
                          ? paymentAdjustments.map((item) => item.voucher_no || item.purchase_voucher_no || item.purchase_id).filter(Boolean).join(", ")
                          : formData.reference_id}
                        onChange={handleChange}
                        style={activePaymentMode === "against" ? readOnlyInp : inp}
                        placeholder={activePaymentMode === "against" ? "Auto from adjusted purchase bill" : activePaymentMode === "new_reference" ? "Optional reference note" : "Optional note"}
                        readOnly={activePaymentMode === "against"}
                      />
                    </Field>
                  </>
                )}
                {activeVoucherType === "receipt" && (
                  <>
                    <Field label="Reference Type">
                      <select
                        name="reference_type"
                        value={formData.reference_type}
                        onChange={handleChange}
                        style={inp}
                      >
                        <option value="">Select Reference</option>
                        <option value="purchase">Purchase Bill</option>
                        <option value="sale">Sale Bill</option>
                        <option value="other">Other</option>
                      </select>
                    </Field>
                    <Field label="Reference ID">
                      <input
                        name="reference_id"
                        value={formData.reference_id}
                        onChange={handleChange}
                        style={inp}
                        placeholder="Optional bill ID"
                      />
                    </Field>
                    <Field label="Amount">
                      <input name="amount" type="number" step="0.0001" value={formData.amount} onChange={handleChange} style={inp} required />
                    </Field>
                  </>
                )}

                {activeVoucherType === "journal" && (
                  <>
                    <Field label="Debit Account">
                      <input name="debit_account" value={formData.debit_account} onChange={handleChange} placeholder="Debit Account" style={inp} />
                    </Field>
                    <Field label="Credit Account">
                      <input name="credit_account" value={formData.credit_account} onChange={handleChange} placeholder="Credit Account" style={inp} />
                    </Field>
                    <Field label="Amount">
                      <input name="amount" type="number" step="0.0001" value={formData.amount} onChange={handleChange} style={inp} required />
                    </Field>
                  </>
                )}

                <div style={{ gridColumn: "1 / -1" }}>
                  <Field label="Description">
                    <textarea name="description" value={formData.description} onChange={handleChange} rows={2} style={{ ...inp, minHeight: 60, resize: "vertical" }} />
                  </Field>
                </div>

                {activeVoucherType === "purchase" && (
                  <div style={{ marginTop: 12, marginBottom: 12 }}>
                    <div style={{ marginBottom: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <h3 style={{ fontSize: 16, margin: 0 }}>Purchase Details</h3>
                      <button type="button" onClick={() => setShowPurchasePreview(true)} style={{ ...btnAction, background: "#0f766e" }}>Preview (F3)</button>
                    </div>
                    <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, background: "#fff" }}>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                          <thead>
                            <tr style={reportHeaderRowStyle}>
                              <th style={th}>Particulars</th>
                              <th style={th}>Value</th>
                              <th style={th}>Particulars</th>
                              <th style={th}>Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td style={td}>Packet</td>
                              <td style={td}>{formData.packet || "-"}</td>
                              <td style={td}>Gross Weight</td>
                              <td style={td}>{formatDecimal4(toNumber(formData.gross_weight))}</td>
                            </tr>
                            <tr>
                              <td style={td}>Tare Weight</td>
                              <td style={td}>{formatDecimal4(toNumber(formData.tare_weight))}</td>
                              <td style={td}>New Weight</td>
                              <td style={td}>{formatDecimal4(Math.max(toNumber(formData.gross_weight) - toNumber(formData.tare_weight), 0))}</td>
                            </tr>
                            <tr>
                              <td style={td}>Net Qty</td>
                              <td style={td}>{formatDecimal4(safePurchaseNetWeight)}</td>
                              <td style={td}>Rate</td>
                              <td style={td}>{formatMoney(toNumber(formData.rate))}</td>
                            </tr>
                            <tr>
                              <td style={td}>Gross Amount</td>
                              <td style={td}>{formatMoney(purchaseGrossAmount)}</td>
                              <td style={td}>Net Payable</td>
                              <td style={td}>{formatMoney(purchaseNetPayable)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div style={{ marginTop: 10, border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, background: "#fff" }}>
                      <div style={{ fontWeight: 800, marginBottom: 8 }}>Deduction Breakdown</div>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                          <thead>
                            <tr style={reportHeaderRowStyle}>
                              <th style={th}>Particulars</th>
                              <th style={th}>Value</th>
                              <th style={th}>Particulars</th>
                              <th style={th}>Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td style={td}>Less Bags Weight</td>
                              <td style={td}>{formatMoney(toNumber(formData.less_bags_weight))}</td>
                              <td style={td}>Moisture</td>
                              <td style={td}>{formatMoney(toNumber(formData.moisture))}</td>
                            </tr>
                            <tr>
                              <td style={td}>Dunki</td>
                              <td style={td}>{formatMoney(toNumber(formData.dunki))}</td>
                              <td style={td}>Fungus</td>
                              <td style={td}>{formatMoney(toNumber(formData.fungus))}</td>
                            </tr>
                            <tr>
                              <td style={td}>Discolour</td>
                              <td style={td}>{formatMoney(toNumber(formData.discolour))}</td>
                              <td style={td}>Others</td>
                              <td style={td}>{formatMoney(toNumber(formData.others))}</td>
                            </tr>
                            <tr>
                              <td style={td}>Bags Claim</td>
                              <td style={td}>{formatMoney(toNumber(formData.bags_claim))}</td>
                              <td style={td}>Labour</td>
                              <td style={td}>{formatMoney(toNumber(formData.labour))}</td>
                            </tr>
                            <tr>
                              <td style={td}>Freight</td>
                              <td style={td}>{formatMoney(toNumber(formData.transport_charge))}</td>
                              <td style={td}><strong>Total Deduction</strong></td>
                              <td style={td}><strong>{formatMoney(purchaseTotalDeduction)}</strong></td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}
                </div>
                </div>
              )}
            <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
                <button type="submit" disabled={loading} style={btnPrimary}>
                  {loading ? "Saving..." : editId ? (activeVoucherType === "sale" ? "Save Deductions" : "Update Voucher") : "Save Voucher"}
                </button>
                {editId && (
                  <button type="button" onClick={() => { setEditId(null); setFormData(defaultForm()); setPaymentAdjustments([]); setReceiptAdjustments([]); setSalePurchaseLinks([]); setPartyOutstanding(null); }} style={{ ...btnPrimary, background: "#64748b" }}>Cancel</button>
                )}
              </div>
            </form>
          </WarehouseVoucherPanel>

          <div style={card}>
            <div className={`mobile-collapsible-header ${showMobileVoucherHeader ? "" : "is-mobile-hidden"}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h3 style={{ marginTop: 0 }}>{activeVoucherType.charAt(0).toUpperCase() + activeVoucherType.slice(1)} Vouchers</h3>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button type="button" onClick={() => setVoucherSortAsc((prev) => !prev)} style={{ ...btnAction, background: voucherSortAsc ? "#0f766e" : "#64748b", padding: "6px 12px", fontSize: 12 }}>
                  📅 {voucherSortAsc ? "Oldest First" : "Newest First"}
                </button>
                {activeVoucherType === "sale" && (
                  <button type="button" onClick={() => setShowSaleAdjustedModal(true)} style={{ ...btnAction, background: "#0f766e" }}>
                    F5 Adjusted Sales
                  </button>
                )}
              </div>
            </div>
            <button
              type="button"
              className="mobile-section-toggle"
              onClick={() => setShowMobileVoucherHeader((prev) => !prev)}
            >
              {showMobileVoucherHeader ? "Hide Voucher Header" : "Show Voucher Header"}
            </button>
            <WarehouseVoucherTable
              activeVoucherType={activeVoucherType}
              filteredVoucherList={filteredVoucherList}
              th={th}
              td={td}
              reportHeaderRowStyle={reportHeaderRowStyle}
              getWarehouseName={getWarehouseName}
              getAccountName={getAccountName}
              getFarmerName={getFarmerName}
              getBuyerName={getBuyerName}
              getProductName={getProductName}
              formatLedgerDate={formatLedgerDate}
              formatDecimal4={formatDecimal4}
              formatMoney={formatMoney}
              consignees={consignees}
              companies={companies}
              selectedPaymentId={selectedPaymentId}
              onEditVoucher={handleEditVoucher}
              onDeleteVoucher={handleDeleteVoucher}
              onSelectPayment={setSelectedPaymentId}
              onGeneratePDF={handleGeneratePDF}
            />
            {activeVoucherType === "purchase" && (
              <div className="purchase-mobile-entry-list">
                {filteredVoucherList.map((item, i) => (
                  <div key={item.id || item._id || i} className="purchase-mobile-entry-card">
                    <div className="purchase-mobile-entry-head">
                      <div>
                        <span>#{i + 1}</span>
                        <strong>{item.voucher_no || "-"}</strong>
                      </div>
                      <em>{formatLedgerDate(item.date)}</em>
                    </div>
                    <div className="purchase-mobile-entry-grid">
                      <div><span>Farmer</span><strong>{getFarmerName(item)}</strong></div>
                      <div><span>Warehouse</span><strong>{getWarehouseName(item)}</strong></div>
                      <div><span>Account</span><strong>{getAccountName(item)}</strong></div>
                      <div><span>Product</span><strong>{getProductName(item)}</strong></div>
                      <div><span>Qty</span><strong>{formatDecimal4(item.total_qty || item.net_weight || item.quantity || 0)}</strong></div>
                      <div><span>Rate</span><strong>{formatMoney(item.rate || 0)}</strong></div>
                      <div className="wide"><span>Amount</span><strong>Rs.{formatMoney(item.net_amount_payable || item.amount || 0)}</strong></div>
                    </div>
                    <div className="purchase-mobile-entry-actions">
                      <button type="button" onClick={() => handleEditVoucher(item.id || item._id)}>Edit</button>
                      <button type="button" className="danger" onClick={() => handleDeleteVoucher(item.id || item._id)}>Delete</button>
                    </div>
                  </div>
                ))}
                {filteredVoucherList.length === 0 && (
                  <div className="purchase-mobile-empty">No vouchers found.</div>
                )}
              </div>
            )}
            {activeVoucherType === "sale" && (
              <div className="purchase-mobile-entry-list">
                {filteredVoucherList.map((item, i) => (
                  <div key={item.id || item._id || i} className="purchase-mobile-entry-card sale-mobile-entry-card">
                    <div className="purchase-mobile-entry-head">
                      <div>
                        <span>#{i + 1}</span>
                        <strong>{item.voucher_no || item.bill_no || "-"}</strong>
                      </div>
                      <em>{formatLedgerDate(item.date)}</em>
                    </div>
                    <div className="purchase-mobile-entry-grid">
                      <div><span>Buyer</span><strong>{getBuyerName(item)}</strong></div>
                      <div><span>Consignee</span><strong>{item.consignee_name || consignees.find((c) => String(c.id || c._id) === String(item.consignee_id))?.name || "-"}</strong></div>
                      <div><span>Account</span><strong>{getAccountName(item)}</strong></div>
                      <div><span>Warehouse</span><strong>{getWarehouseName(item)}</strong></div>
                      <div><span>Product</span><strong>{getProductName(item)}</strong></div>
                      <div><span>Qty</span><strong>{formatDecimal4(item.quantity || item.total_quantity || 0)}</strong></div>
                      <div><span>Rate</span><strong>{formatMoney(item.rate || 0)}</strong></div>
                      <div className="wide"><span>Net Receivable</span><strong>Rs.{formatMoney(item.net_receivable_amount || item.net_amount || item.amount || 0)}</strong></div>
                    </div>
                    <div className="purchase-mobile-entry-actions">
                      <button type="button" onClick={() => handleEditVoucher(item.id || item._id)}>Edit</button>
                      <button type="button" className="danger" onClick={() => handleDeleteVoucher(item.id || item._id)}>Delete</button>
                      <button type="button" className="pdf" onClick={() => handleGeneratePDF(item.id || item._id)}>PDF</button>
                    </div>
                  </div>
                ))}
                {filteredVoucherList.length === 0 && (
                  <div className="purchase-mobile-empty">No vouchers found.</div>
                )}
              </div>
            )}
            {activeVoucherType === "payment" && selectedVoucher && (
              <div style={{ marginTop: 14, padding: 14, border: "1px solid #cbd5e1", borderRadius: 8, background: "#f8fafc" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <strong>Selected Payment Voucher</strong>
                  <span style={{ color: "#0f766e", fontSize: 13 }}>{selectedVoucher.voucher_no || "-"}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: 10, fontSize: 13 }}>
                  <div><strong>Date:</strong> {selectedVoucher.date || "-"}</div>
                  <div><strong>Account:</strong> {getAccountName(selectedVoucher)}</div>
                  <div><strong>Farmer:</strong> {getFarmerName(selectedVoucher)}</div>
                  <div><strong>Amount:</strong> Rs.{formatMoney(selectedVoucher.amount || selectedVoucher.net_amount || selectedVoucher.amount || 0)}</div>
                  <div><strong>Reference:</strong> {selectedVoucher.reference_id || selectedVoucher.reference_type || "-"}</div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <strong>Adjustments</strong>
                  {(selectedVoucher.adjustments || []).length > 0 ? (
                    (selectedVoucher.adjustments || []).map((item, index) => (
                      <div key={`${item.purchase_id || item.voucher_no}-${index}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "8px 0", borderBottom: index < (selectedVoucher.adjustments || []).length - 1 ? "1px solid #e2e8f0" : "none" }}>
                        <span>{item.voucher_no || item.purchase_voucher_no || item.purchase_id}</span>
                        <strong>Rs.{formatMoney(item.adjusted_amount || 0)}</strong>
                      </div>
                    ))
                  ) : (
                    <div style={{ color: "#475569", marginTop: 8 }}>No purchase bill adjustments available.</div>
                  )}
                </div>
              </div>
            )}
            {renderPaginationBar(voucherPage, totalVoucherPages, () => setVoucherPage((prev) => Math.max(1, prev - 1)), () => setVoucherPage((prev) => Math.min(totalVoucherPages, prev + 1)), voucherPageInfo.total, "vouchers")}
          </div>
        </div>
      ) : (
        <div ref={reportPanelRef}>
          <WarehouseReportPanel
            activeReport={activeReport}
            activeVoucherButtonStyle={activeVoucherButtonStyle}
            voucherButtonStyle={voucherButtonStyle}
            voucherTypeRow={voucherTypeRow}
            card={card}
            btnAction={btnAction}
            reportLabels={reportLabels}
            showMobileReportHeader={showMobileReportHeader}
            onToggleReportHeader={() => setShowMobileReportHeader((prev) => !prev)}
            onSetActiveReport={setActiveReport}
            allowedReports={allowedReports}
            onDownloadPurchaseLedgerPdf={downloadPurchaseLedgerPdf}
            onDownloadSaleLedgerPdf={downloadSaleLedgerPdf}
            onSharePurchaseLedgerWhatsapp={sharePurchaseLedgerWhatsapp}
            onShareSaleLedgerWhatsapp={shareSaleLedgerWhatsapp}
          >
            {activeReport === "purchase" && (
              <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap", marginBottom: 14 }}>
                <SearchableSelect
                  label="Account Filter"
                  value={reportFilters.company_account_id}
                  options={purchasePartyLedgerCompanyAccounts.map((account) => ({
                    value: account.id || account._id,
                    label: account.account_name || account.name,
                  }))}
                  onChange={(value) => updateReportFilter("company_account_id", value)}
                  placeholder="Select Account"
                />
                <SearchableSelect
                  label="Warehouse Filter"
                  value={reportFilters.warehouse_id}
                  options={purchasePartyLedgerWarehouses.map((warehouse) => ({
                    value: warehouse.id || warehouse._id,
                    label: warehouse.name,
                  }))}
                  onChange={(value) => updateReportFilter("warehouse_id", value)}
                  placeholder={reportFilters.company_account_id ? "Select Warehouse" : "Select Account First"}
                  disabled={!reportFilters.company_account_id}
                />
                <SearchableSelect
                  label="Farmer Filter"
                  value={reportFilters.farmer_id}
                  options={purchasePartyLedgerFarmers.map((farmer) => ({
                    value: farmer.id || farmer._id,
                    label: farmer.name,
                  }))}
                  onChange={(value) => updateReportFilter("farmer_id", value)}
                  placeholder={reportFilters.warehouse_id ? "Select Farmer" : "Select Warehouse First"}
                  disabled={!reportFilters.company_account_id || !reportFilters.warehouse_id}
                />
                {(reportFilters.farmer_id || reportFilters.warehouse_id || reportFilters.company_account_id || reportFilters.details_of_deduction) && (
                  <button
                    type="button"
                    onClick={() => setReportFilters({ farmer_id: "", warehouse_id: "", company_account_id: "", sale_buyer_id: "", sale_company_account_id: "", sale_journey_token: "", sale_lorry_no: "", sale_bill_no: "", details_of_deduction: false })}
                    style={{ ...btnAction, background: "#64748b", marginBottom: 1 }}
                  >
                    Clear Filters
                  </button>
                )}
              </div>
            )}
            {activeReport === "purchase-party-ledger" && (
              <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap", marginBottom: 14 }}>
                <SearchableSelect
                  label="Account Filter"
                  value={reportFilters.company_account_id}
                  options={purchasePartyLedgerCompanyAccounts.map((account) => ({
                    value: account.id || account._id,
                    label: account.account_name || account.name,
                  }))}
                  onChange={(value) => updateReportFilter("company_account_id", value)}
                  placeholder="Select Account"
                />
                <SearchableSelect
                  label="Warehouse Filter"
                  value={reportFilters.warehouse_id}
                  options={purchasePartyLedgerWarehouses.map((warehouse) => ({
                    value: warehouse.id || warehouse._id,
                    label: warehouse.name,
                  }))}
                  onChange={(value) => updateReportFilter("warehouse_id", value)}
                  placeholder={reportFilters.company_account_id ? "Select Warehouse" : "Select Account First"}
                  disabled={!reportFilters.company_account_id}
                />
                <SearchableSelect
                  label="Farmer Filter"
                  value={reportFilters.farmer_id}
                  options={purchasePartyLedgerFarmers.map((farmer) => ({
                    value: farmer.id || farmer._id,
                    label: farmer.name,
                  }))}
                  onChange={(value) => updateReportFilter("farmer_id", value)}
                  placeholder={reportFilters.warehouse_id ? "Select Farmer" : "Select Warehouse First"}
                  disabled={!reportFilters.company_account_id || !reportFilters.warehouse_id}
                />
                <label style={{ display: "grid", gap: 6, minWidth: 190 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>Journal / Deduction Details</span>
                  <select
                  value={reportFilters.details_of_deduction ? "details" : "all"}
                  onChange={(e) => updateReportFilter("details_of_deduction", e.target.value === "details")}
                  style={{ ...inp, minWidth: 190, height: 42 }}
                  title="Show purchase deduction entries in ledger"
                  >
                    <option value="all">Normal Ledger</option>
                    <option value="details">Details of Deduction</option>
                  </select>
                </label>
                {(reportFilters.farmer_id || reportFilters.warehouse_id || reportFilters.company_account_id || reportFilters.details_of_deduction) && (
                  <button
                    type="button"
                    onClick={() => setReportFilters({ farmer_id: "", warehouse_id: "", company_account_id: "", sale_buyer_id: "", sale_company_account_id: "", sale_journey_token: "", sale_lorry_no: "", sale_bill_no: "", details_of_deduction: false })}
                    style={{ ...btnAction, background: "#64748b", marginBottom: 1 }}
                  >
                    Clear Filters
                  </button>
                )}
              </div>
            )}
            {(activeReport === "sale" || activeReport === "sale-party-ledger") && (
              <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap", marginBottom: 14 }}>
                <SearchableSelect
                  label="Account Filter"
                  value={reportFilters.company_account_id}
                  options={saleReportAccounts.map((account) => ({
                    value: account.id || account._id,
                    label: account.account_name || account.name,
                  }))}
                  onChange={(value) => updateReportFilter("company_account_id", value)}
                  placeholder="All Accounts"
                />
                <SearchableSelect
                  label="Warehouse Filter"
                  value={reportFilters.warehouse_id}
                  options={saleReportWarehouses.map((warehouse) => ({
                    value: warehouse.id || warehouse._id,
                    label: warehouse.name,
                  }))}
                  onChange={(value) => updateReportFilter("warehouse_id", value)}
                  placeholder="All Warehouses"
                  disabled={!reportFilters.company_account_id && saleReportWarehouses.length === 0}
                />
                <SearchableSelect
                  label="Farmer Filter"
                  value={reportFilters.farmer_id}
                  options={saleReportFarmers.map((farmer) => ({
                    value: farmer.id || farmer._id,
                    label: farmer.name,
                  }))}
                  onChange={(value) => updateReportFilter("farmer_id", value)}
                  placeholder="All Farmers"
                  disabled={!reportFilters.company_account_id && !reportFilters.warehouse_id && saleReportFarmers.length === 0}
                />
                <SearchableSelect
                  label="Buyer Filter"
                  value={reportFilters.sale_buyer_id}
                  options={saleReportBuyers.map((buyer) => ({
                    value: buyer.id || buyer._id,
                    label: buyer.name,
                  }))}
                  onChange={(value) => setReportFilters((prev) => ({ ...prev, sale_buyer_id: value }))}
                  placeholder="All Buyers"
                />
                {(reportFilters.farmer_id || reportFilters.warehouse_id || reportFilters.company_account_id || reportFilters.sale_buyer_id) && (
                  <button
                    type="button"
                    onClick={() => setReportFilters((prev) => ({ ...prev, farmer_id: "", warehouse_id: "", company_account_id: "", sale_buyer_id: "" }))}
                    style={{ ...btnAction, background: "#64748b", marginBottom: 1 }}
                  >
                    Clear Filters
                  </button>
                )}
              </div>
            )}
            {activeReport === "sale-followup" && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 14 }}>
                  {[
                    ["all", saleFollowupCounts.all],
                    ["payment_done", saleFollowupCounts.payment_done],
                    ["unloading_pending", saleFollowupCounts.unloading_pending],
                    ["pending", saleFollowupCounts.pending],
                    ["overdue", saleFollowupCounts.overdue],
                  ].map(([key, count]) => {
                    const meta = saleFollowupStatusMeta[key];
                    const active = saleFollowupFilter === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSaleFollowupFilter(key)}
                        style={{
                          border: active ? `1px solid ${meta.color}` : "1px solid #e2e8f0",
                          background: active ? meta.bg : "#fff",
                          borderRadius: 14,
                          padding: "14px 16px",
                          cursor: "pointer",
                          textAlign: "left",
                          boxShadow: active ? "0 10px 24px rgba(15, 23, 42, 0.08)" : "none",
                        }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", marginBottom: 6 }}>{meta.label}</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: meta.color }}>{count}</div>
                      </button>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                  {["all", "payment_done", "unloading_pending", "pending", "overdue"].map((key) => {
                    const meta = saleFollowupStatusMeta[key];
                    const active = saleFollowupFilter === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSaleFollowupFilter(key)}
                        style={{
                          ...btnAction,
                          background: active ? meta.color : "#e2e8f0",
                          color: active ? "#fff" : "#0f172a",
                        }}
                      >
                        {meta.label}
                      </button>
                    );
                  })}
                  {saleFollowupFilter !== "all" && (
                    <button type="button" onClick={() => setSaleFollowupFilter("all")} style={{ ...btnAction, background: "#64748b" }}>
                      Clear Filter
                    </button>
                  )}
                </div>
              </>
            )}
            {activeReport === "purchase-party-ledger" ? (
              <div style={ledgerSplitStyle}>
                <WarehouseReportTable
                  activeReport={activeReport}
                  activeReportColumns={activeReportColumns}
                  filteredReportData={filteredReportData}
                  tableCard={tableCard}
                  reportHeaderRowStyle={reportHeaderRowStyle}
                  th={th}
                  td={td}
                />
                <div className="purchase-mobile-report-list">
                  {filteredReportData.map((item, i) => (
                    <div
                      key={item.id || `${item.voucher_type || item.row_type}-${item.voucher_no || i}-${i}`}
                      className={`purchase-mobile-report-card ${item.row_type === "closing" ? "is-closing" : ""}`}
                    >
                      <div className="purchase-mobile-entry-head">
                        <div>
                          <span>{item.row_type === "closing" ? "Closing" : item.voucher_type || "Entry"}</span>
                          <strong>{item.voucher_no || item.farmer_name || "-"}</strong>
                        </div>
                        <em>{item.row_type === "closing" ? "" : formatLedgerDate(item.date)}</em>
                      </div>
                      <div className="purchase-mobile-entry-grid">
                        <div><span>Warehouse</span><strong>{item.row_type === "closing" ? "-" : getWarehouseName(item)}</strong></div>
                        <div><span>Debit</span><strong>{formatMoney(item.debit || 0)}</strong></div>
                        <div><span>Credit</span><strong>{formatMoney(item.credit || 0)}</strong></div>
                        <div className="wide"><span>Balance</span><strong>Rs.{formatMoney(Math.abs(item.balance || 0))}</strong></div>
                      </div>
                      {item.row_type !== "closing" && item.voucher_type === "Purchase" && (
                        <div className="purchase-mobile-entry-actions">
                          <button type="button" onClick={() => showPurchaseReportPreview(item)}>View</button>
                          <button type="button" onClick={() => handleEditPurchaseReport(item)}>Edit</button>
                          <button type="button" className="pdf" onClick={() => handlePurchaseReportPDF(item.purchase_id || item.id || item._id)}>PDF</button>
                        </div>
                      )}
                    </div>
                  ))}
                  {filteredReportData.length === 0 && (
                    <div className="purchase-mobile-empty">No data available.</div>
                  )}
                </div>
                {showPurchaseBillWise && (
                  <WarehouseBillWisePanel
                    title="Bill Wise Report"
                    onRefresh={loadReport}
                    btnAction={btnAction}
                    tableCard={tableCard}
                    billWisePanelStyle={billWisePanelStyle}
                    reportHeaderRowStyle={reportHeaderRowStyle}
                    th={th}
                    td={td}
                    rows={purchaseBillRows.map((row) => ({
                      key: row.purchase_id || row.voucher_no,
                      voucher_no: row.voucher_no,
                      farmer_name: row.farmer_name || getFarmerName(row) || "-",
                      account_name: getAccountName(row),
                      purchase_amount: formatMoney(row.purchase_amount || row.credit || 0),
                      payment_amount: formatMoney(row.payment_amount || 0),
                      journal_amount: formatMoney(row.journal_amount || 0),
                      receipt_amount: formatMoney(row.receipt_amount || 0),
                      bill_balance: formatMoney(row.bill_balance || 0),
                    }))}
                    selectedRow={selectedBill ? { key: selectedBill.purchase_id || selectedBill.voucher_no } : null}
                    onSelectRow={(rowKey) => setSelectedLedgerBillId(rowKey)}
                    rowColumns={[
                      { key: "bill", label: "Bill", render: (row) => row.voucher_no || "-" },
                      { key: "farmer", label: "Farmer", render: (row) => row.farmer_name },
                      { key: "account", label: "Account", render: (row) => row.account_name },
                      { key: "purchase", label: "Purchase", render: (row) => row.purchase_amount },
                      { key: "payment", label: "Payment", render: (row, rowKey, onSelect) => (
                        <button type="button" onClick={() => onSelect(rowKey)} style={linkButtonStyle}>{row.payment_amount}</button>
                      ) },
                      { key: "journal", label: "Journal", render: (row) => row.journal_amount },
                      { key: "receipt", label: "Receipt", render: (row) => row.receipt_amount },
                      { key: "balance", label: "Balance", render: (row) => row.bill_balance },
                    ]}
                    detailTitle={selectedBill?.voucher_no || "Select a bill"}
                    detailSubtitle="Payment details"
                    detailEmptyText="No payment adjusted against this bill."
                    detailRows={selectedBill?.payment_details || []}
                    detailRenderer={{
                      paymentDetailBoxStyle,
                      renderDetail: (detail, index) => (
                        <div key={`${detail.payment_voucher_no}-${index}`} style={paymentDetailRowStyle}>
                          <span>{detail.payment_date || "-"}</span>
                          <span>{detail.payment_voucher_no || "-"}</span>
                          <strong>Rs.{formatMoney(detail.adjusted_amount || 0)}</strong>
                        </div>
                      ),
                    }}
                  />
                )}
              </div>
            ) : activeReport === "sale-party-ledger" || activeReport === "sale-followup" || activeReport === "sale-journey" ? (
              <div style={ledgerSplitStyle}>
                <WarehouseReportTable
                  activeReport={activeReport}
                  activeReportColumns={activeReportColumns}
                  filteredReportData={filteredReportData}
                  tableCard={tableCard}
                  reportHeaderRowStyle={reportHeaderRowStyle}
                  th={th}
                  td={td}
                />
                {activeReport === "sale-party-ledger" && (
                  <div className="purchase-mobile-report-list">
                    {filteredReportData.map((item, i) => (
                      <div
                        key={item.id || `${item.voucher_type || item.row_type}-${item.voucher_no || i}-${i}`}
                        className={`purchase-mobile-report-card sale-mobile-entry-card ${item.row_type === "closing" ? "is-closing" : ""}`}
                      >
                        <div className="purchase-mobile-entry-head">
                          <div>
                            <span>{item.row_type === "closing" ? "Closing" : item.voucher_type || "Entry"}</span>
                            <strong>{item.voucher_no || item.party_name || item.buyer_name || item.company_name || item.consignee_name || "-"}</strong>
                          </div>
                          <em>{item.row_type === "closing" ? "" : formatLedgerDate(item.date)}</em>
                        </div>
                        <div className="purchase-mobile-entry-grid">
                          <div><span>Party</span><strong>{item.row_type === "closing" ? `Closing (${item.closing_side || ""})` : item.party_name || item.buyer_name || item.company_name || item.consignee_name || "-"}</strong></div>
                          <div><span>Account</span><strong>{item.row_type === "closing" ? "-" : getAccountName(item)}</strong></div>
                          <div><span>Warehouse</span><strong>{item.row_type === "closing" ? "-" : getWarehouseName(item)}</strong></div>
                          <div><span>Debit</span><strong>{formatMoney(item.debit || 0)}</strong></div>
                          <div><span>Credit</span><strong>{formatMoney(item.credit || 0)}</strong></div>
                          <div className="wide"><span>Balance</span><strong>Rs.{formatMoney(Math.abs(item.balance || 0))}</strong></div>
                        </div>
                      </div>
                    ))}
                    {filteredReportData.length === 0 && (
                      <div className="purchase-mobile-empty">No data available.</div>
                    )}
                  </div>
                )}

                {showSaleBillWise && activeReport === "sale-party-ledger" && (
                  <WarehouseBillWisePanel
                    title="Bill Wise Report"
                    onRefresh={loadReport}
                    btnAction={btnAction}
                    tableCard={tableCard}
                    billWisePanelStyle={billWisePanelStyle}
                    reportHeaderRowStyle={reportHeaderRowStyle}
                    th={th}
                    td={td}
                    rows={saleBillRows.map((row) => ({
                      key: row.sale_id || row.voucher_no,
                      voucher_no: row.voucher_no,
                      party_name: row.party_name || row.company_name || "-",
                      sale_amount: formatMoney(row.sale_amount || row.debit || 0),
                      receipt_amount: formatMoney(row.receipt_amount || 0),
                      journal_amount: formatMoney(row.journal_amount || 0),
                      bill_balance: formatMoney(row.bill_balance || 0),
                    }))}
                    selectedRow={selectedSaleBill ? { key: selectedSaleBill.sale_id || selectedSaleBill.voucher_no } : null}
                    onSelectRow={(rowKey) => setSelectedSaleLedgerBillId(rowKey)}
                    rowColumns={[
                      { key: "bill", label: "Bill", render: (row) => row.voucher_no || "-" },
                      { key: "party", label: "Party", render: (row) => row.party_name },
                      { key: "sale", label: "Sale", render: (row) => row.sale_amount },
                      { key: "receipt", label: "Receipt", render: (row, rowKey, onSelect) => (
                        <button type="button" onClick={() => onSelect(rowKey)} style={linkButtonStyle}>{row.receipt_amount}</button>
                      ) },
                      { key: "deduction", label: "Deduction", render: (row) => row.journal_amount },
                      { key: "balance", label: "Balance", render: (row) => row.bill_balance },
                    ]}
                    detailTitle={selectedSaleBill?.voucher_no || "Select a bill"}
                    detailSubtitle="Receipt details"
                    detailEmptyText="No receipt adjusted against this bill."
                    detailRows={selectedSaleBill?.payment_details || []}
                    detailRenderer={{
                      paymentDetailBoxStyle,
                      renderDetail: (detail, index) => (
                        <div key={`${detail.receipt_voucher_no}-${index}`} style={paymentDetailRowStyle}>
                          <span>{detail.receipt_date || "-"}</span>
                          <span>{detail.receipt_voucher_no || "-"}{detail.inferred_adjustment ? " (auto)" : ""}</span>
                          <strong>Rs.{formatMoney(detail.adjusted_amount || 0)}</strong>
                        </div>
                      ),
                    }}
                    footerNode={
                      <>
                        <div style={{ color: "#64748b", fontSize: 12, margin: "10px 0 8px" }}>Deduction details</div>
                        {(selectedSaleBill?.journal_details || []).length > 0 ? (
                          (selectedSaleBill.journal_details || []).map((detail, index) => (
                            <div key={`${detail.voucher_no}-${index}`} style={paymentDetailRowStyle}>
                              <span>{detail.date || "-"}</span>
                              <span>{detail.type || "-"}</span>
                              <strong>Rs.{formatMoney(detail.amount || 0)}</strong>
                            </div>
                          ))
                        ) : (
                          <div style={{ color: "#64748b", fontSize: 13 }}>No deduction posted against this bill.</div>
                        )}
                      </>
                    }
                    showJourney
                    journeySummary={
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 10 }}>
                        <div style={smartInfoBoxStyle}>
                          <span>Leg Count</span>
                          <strong>{selectedSaleJourneyRows.length}</strong>
                        </div>
                        <div style={smartInfoBoxStyle}>
                          <span>Total Qty</span>
                          <strong>{formatDecimal4(selectedSaleJourneyTotalQty)}</strong>
                        </div>
                        <div style={smartInfoBoxStyle}>
                          <span>Total Amount</span>
                          <strong>{formatMoney(selectedSaleJourneyTotalAmount)}</strong>
                        </div>
                        <div style={smartInfoBoxStyle}>
                          <span>Balance Qty</span>
                          <strong>{formatDecimal4(selectedSaleJourneyBalanceQty)}</strong>
                        </div>
                      </div>
                    }
                    journeyRows={selectedSaleJourneyRows}
                    smartInfoBoxStyle={smartInfoBoxStyle}
                    formatMoney={formatMoney}
                    formatDecimal4={formatDecimal4}
                    formatLedgerDate={formatLedgerDate}
                  />
                )}
              </div>
            ) : (
              <>
                <WarehouseReportTable
                  activeReport={activeReport}
                  activeReportColumns={activeReportColumns}
                  filteredReportData={filteredReportData}
                  tableCard={tableCard}
                  reportHeaderRowStyle={reportHeaderRowStyle}
                  th={th}
                  td={td}
                  onSaleRowClick={showSaleReportPreview}
                />
                {activeReport === "purchase" && (
                  <div className="purchase-mobile-report-list">
                    {filteredReportData.map((item, i) => (
                      <div key={item.id || item._id || i} className="purchase-mobile-report-card">
                        <div className="purchase-mobile-entry-head">
                          <div>
                            <span>#{i + 1}</span>
                            <strong>{item.voucher_no || "-"}</strong>
                          </div>
                          <em>{formatLedgerDate(item.date)}</em>
                        </div>
                        <div className="purchase-mobile-entry-grid">
                          <div><span>Farmer</span><strong>{item.farmer_name || getFarmerName(item)}</strong></div>
                          <div><span>Warehouse</span><strong>{getWarehouseName(item)}</strong></div>
                          <div><span>Product</span><strong>{getProductName(item)}</strong></div>
                          <div><span>Net Qty</span><strong>{formatDecimal4(item.total_quantity || item.total_qty || item.net_weight || 0)}</strong></div>
                          <div><span>Rate</span><strong>{formatMoney(item.rate || 0)}</strong></div>
                          <div className="wide"><span>Net Payable</span><strong>Rs.{formatMoney(item.total_amount || item.net_amount_payable || 0)}</strong></div>
                        </div>
                        <div className="purchase-mobile-entry-actions">
                          <button type="button" onClick={() => showPurchaseReportPreview(item)}>View</button>
                          <button type="button" onClick={() => handleEditPurchaseReport(item)}>Edit</button>
                          <button type="button" className="pdf" onClick={() => handlePurchaseReportPDF(item.id || item._id)}>PDF</button>
                        </div>
                      </div>
                    ))}
                    {filteredReportData.length === 0 && (
                      <div className="purchase-mobile-empty">No data available.</div>
                    )}
                  </div>
                )}
                {activeReport === "sale" && (
                  <div className="purchase-mobile-report-list">
                    {filteredReportData.map((item, i) => (
                      <div
                        key={item.id || item._id || i}
                        className="purchase-mobile-report-card sale-mobile-entry-card"
                        style={{ cursor: "pointer" }}
                        onClick={() => showSaleReportPreview(item)}
                      >
                        <div className="purchase-mobile-entry-head">
                          <div>
                            <span>#{i + 1}</span>
                            <strong>{item.voucher_no || item.bill_no || "-"}</strong>
                          </div>
                          <em>{formatLedgerDate(item.date)}</em>
                        </div>
                        <div className="purchase-mobile-entry-grid">
                          <div><span>Buyer</span><strong>{getBuyerName(item)}</strong></div>
                          <div><span>Consignee</span><strong>{item.consignee_name || consignees.find((c) => String(c.id || c._id) === String(item.consignee_id))?.name || "-"}</strong></div>
                          <div><span>Account</span><strong>{getAccountName(item)}</strong></div>
                          <div><span>Warehouse</span><strong>{getWarehouseName(item)}</strong></div>
                          <div><span>Product</span><strong>{getProductName(item)}</strong></div>
                          <div><span>Total Qty</span><strong>{formatDecimal4(item.total_quantity || item.quantity || 0)}</strong></div>
                          <div className="wide"><span>Total Amount</span><strong>Rs.{formatMoney(item.total_amount || item.amount || 0)}</strong></div>
                        </div>
                        <div className="purchase-mobile-entry-actions">
                          <button type="button" onClick={() => showSaleReportPreview(item)}>View</button>
                          <button type="button" onClick={() => handleGeneratePDF(item.id || item._id)} className="pdf">PDF</button>
                        </div>
                      </div>
                    ))}
                    {filteredReportData.length === 0 && (
                      <div className="purchase-mobile-empty">No data available.</div>
                    )}
                  </div>
                )}
              </>
            )}
            {renderPaginationBar(
              reportPage,
              totalReportPages,
              () => setReportPage((prev) => Math.max(1, prev - 1)),
              () => setReportPage((prev) => Math.min(totalReportPages, prev + 1)),
              (activeReport === "sale" || activeReport === "purchase" || activeReport === "warehouse-stock")
                ? Number(reportPageInfo.total || 0)
                : filteredReportDataAll.length,
              "rows"
            )}
          </WarehouseReportPanel>
        </div>
      )}
      {showPaymentAdjustPopup && (
        <div style={modalOverlayStyle}>
          <WarehouseAdjustModal
            title="Payment Adjustment"
            subtitle="Account → Warehouse → Pending Farmer → Purchase Bills"
            actionButton={btnAction}
            controls={
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: 12 }}>
                <SearchableSelect
                  label="Account"
                  value={formData.company_account_id}
                  options={companyAccounts.map((a) => ({ value: a.id || a._id, label: a.account_name || a.name }))}
                  onChange={(value) => handleChange({ target: { name: "company_account_id", value } })}
                  placeholder="Choose account"
                />
                <SearchableSelect
                  label="Warehouse"
                  value={formData.warehouse_id}
                  options={paymentWarehouses.map((w) => ({ value: w.id || w._id, label: w.name }))}
                  onChange={(value) => handleChange({ target: { name: "warehouse_id", value } })}
                  placeholder={formData.company_account_id ? "Choose warehouse" : "Choose account first"}
                  disabled={!formData.company_account_id}
                />
                <SearchableSelect
                  label="Pending Farmer"
                  value={formData.farmer_id}
                  options={accountFarmers.map((f) => ({ value: f.id || f._id, label: `${f.name}${f.outstanding !== undefined ? ` — Pending Rs.${formatMoney(f.outstanding)}` : ""}` }))}
                  onChange={(value) => handleChange({ target: { name: "farmer_id", value } })}
                  placeholder={formData.warehouse_id ? "Choose pending farmer" : "Choose warehouse first"}
                  disabled={!formData.warehouse_id}
                />
              </div>
            }
            tableCard={{ ...paymentAdjustModalStyle, ...tableCard }}
            reportHeaderRowStyle={reportHeaderRowStyle}
            th={th}
            td={td}
            rows={(partyOutstanding?.purchases || []).filter((row) => toNumber(row.pending_amount) > 0).map((row) => ({
              key: row.id || row._id,
              date: row.date || "-",
              voucher_no: row.voucher_no || "-",
              warehouse: getWarehouseName(row),
              amount: formatMoney(row.amount || 0),
              adjusted: formatMoney(row.adjusted_amount || 0),
              pending: formatMoney(row.pending_amount || 0),
              row,
            }))}
            columns={[
              { key: "date", label: "Date", render: (row) => row.date },
              { key: "voucher", label: "Voucher No", render: (row) => row.voucher_no },
              { key: "warehouse", label: "Warehouse", render: (row) => row.warehouse },
              { key: "amount", label: "Bill Amount", render: (row) => row.amount },
              { key: "adjusted", label: "Adjusted", render: (row) => row.adjusted },
              { key: "pending", label: "Pending", render: (row) => row.pending },
              {
                key: "adjAmount",
                label: "Adjustment Amount",
                render: (row) => (
                  <input
                    type="number"
                    step="0.0001"
                    min="0"
                    max={row.row.pending_amount || row.row.amount || 0}
                    value={selectedAdjustmentFor(row.key)}
                    onChange={(event) => setPaymentAdjustmentAmount(row.row, event.target.value)}
                    style={{ ...inp, padding: "7px 8px" }}
                  />
                ),
              },
            ]}
            emptyText="No pending purchase bills found."
            onAutoAdjust={autoFillPaymentAdjustments}
            autoAdjustLabel={`Auto Adjust Rs.${formatMoney(formData.amount)}`}
            onClose={() => setShowPaymentAdjustPopup(false)}
            onClear={() => setPaymentAdjustments([])}
            onConfirm={() => setShowPaymentAdjustPopup(false)}
            confirmDisabled={Math.abs(paymentAdjustmentTotal - toNumber(formData.amount)) > 0.0001}
          />
        </div>
      )}
      {showReceiptAdjustPopup && (
        <div style={modalOverlayStyle}>
          <WarehouseAdjustModal
            title="Receipt Adjustment"
            subtitle="Company and warehouse wise pending sale bills"
            actionButton={btnAction}
            tableCard={{ ...paymentAdjustModalStyle, ...tableCard }}
            reportHeaderRowStyle={reportHeaderRowStyle}
            th={th}
            td={td}
            rows={(partyOutstanding?.sales || []).filter((row) => toNumber(row.pending_amount) > 0).map((row) => ({
              key: row.id || row._id,
              date: row.date || "-",
              voucher_no: row.voucher_no || "-",
              warehouse: getWarehouseName(row),
              amount: formatMoney(row.amount || 0),
              adjusted: formatMoney(row.adjusted_amount || 0),
              pending: formatMoney(row.pending_amount || 0),
              row,
            }))}
            columns={[
              { key: "date", label: "Date", render: (row) => row.date },
              { key: "voucher", label: "Voucher No", render: (row) => row.voucher_no },
              { key: "warehouse", label: "Warehouse", render: (row) => row.warehouse },
              { key: "amount", label: "Bill Amount", render: (row) => row.amount },
              { key: "adjusted", label: "Adjusted", render: (row) => row.adjusted },
              { key: "pending", label: "Pending", render: (row) => row.pending },
              {
                key: "adjAmount",
                label: "Adjustment Amount",
                render: (row) => (
                  <input
                    type="number"
                    step="0.0001"
                    min="0"
                    max={row.row.pending_amount || row.row.amount || 0}
                    value={selectedAdjustmentFor(row.key)}
                    onChange={(event) => setReceiptAdjustmentAmount(row.row, event.target.value)}
                    style={{ ...inp, padding: "7px 8px" }}
                  />
                ),
              },
            ]}
            emptyText="No pending sale bills found."
            onClose={() => setShowReceiptAdjustPopup(false)}
            onClear={() => setReceiptAdjustments([])}
            onConfirm={() => setShowReceiptAdjustPopup(false)}
            confirmDisabled={false}
          />
        </div>
      )}
      {showSaleDeductionModal && (
        <WarehouseSaleDeductionModal
          modalOverlayStyle={modalOverlayStyle}
          paymentAdjustModalStyle={paymentAdjustModalStyle}
          btnAction={btnAction}
          inp={inp}
          lbl={lbl}
          readOnlyInp={readOnlyInp}
          th={th}
          td={td}
          formData={formData}
          warehouses={warehouses}
          employees={employees}
          buyerNames={buyerNames}
          filteredConsignees={filteredConsignees}
          selectedLocationName={selectedLocationName}
          selectedSalePassBill={selectedSalePassBill}
          saleDispatchQty={saleDispatchQty}
          saleUnloadingQty={saleUnloadingQty}
          saleTotalQtyPreview={saleTotalQtyPreview}
          selectedSalePassJourneyRows={selectedSalePassJourneyRows}
          selectedSalePassJourneyRemainingQty={selectedSalePassJourneyRemainingQty}
          saleVoucherPassBills={saleVoucherPassBills}
          saleBillSearch={saleBillSearch}
          setSaleBillSearch={setSaleBillSearch}
          journeyTemplateId={journeyTemplateId}
          setJourneyTemplateId={setJourneyTemplateId}
          editId={editId}
          setShowSaleDeductionModal={setShowSaleDeductionModal}
          handleChange={handleChange}
          renderAccountSelect={renderAccountSelect}
          openSaleJourneyReport={openSaleJourneyReport}
          applyAddQty={applyAddQty}
          applyJourneyTemplate={applyJourneyTemplate}
          getBuyerName={getBuyerName}
          getJourneySourceLabel={getJourneySourceLabel}
          formatLedgerDate={formatLedgerDate}
          formatDecimal4={formatDecimal4}
          formatMoney={formatMoney}
          toNumber={toNumber}
          selectSaleVoucherForPass={selectSaleVoucherForPass}
          saveSaleVoucherPass={saveSaleVoucherPass}
          saveSaleVoucherPassAndNew={saveSaleVoucherPassAndNew}
          saleQualityDeduction={saleQualityDeduction}
          saleCashDiscountAmount={saleCashDiscountAmount}
          saleBillAmountFromData={saleBillAmountFromData}
          tdsEligible={tdsEligible}
          autoTdsAmount={autoTdsAmount}
          saleRemainingQty={saleRemainingQty}
          saleShortageQty={saleShortageQty}
          saleShortageAmount={saleShortageAmount}
          saleNetReceivablePreview={saleNetReceivablePreview}
        />
      )}
      {showSaleAdjustedModal && (
        <div style={modalOverlayStyle}>
          <div style={paymentAdjustModalStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div>
                <h3 style={{ margin: 0 }}>Adjusted Sale Vouchers</h3>
                <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
                  Press F5 to open adjusted sale items or select a row to edit its voucher.
                </div>
              </div>
              <button type="button" onClick={() => setShowSaleAdjustedModal(false)} style={{ ...btnAction, background: "#64748b" }}>
                Close
              </button>
            </div>

            <div style={{ ...tableCard, maxHeight: 420, overflow: "auto", marginTop: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={reportHeaderRowStyle}>
                    <th style={th}>Bill</th>
                    <th style={th}>Date</th>
                    <th style={th}>Lorry</th>
                    <th style={th}>Buyer</th>
                    <th style={th}>Consignee</th>
                    <th style={th}>Qty</th>
                    <th style={th}>Rate</th>
                    <th style={th}>Claim</th>
                    <th style={th}>Deduction</th>
                    <th style={th}>TDS</th>
                    <th style={th}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {saleAdjustedBills.map((row, index) => {
                    const rowId = row.id || row._id;
                    return (
                      <tr key={rowId} style={{ background: index % 2 ? "#f8fafc" : "#fff" }}>
                        <td style={td}>{row.voucher_no || "-"}</td>
                        <td style={td}>{row.date || "-"}</td>
                        <td style={td}>{row.lorry_no || row.reference_id || "-"}</td>
                        <td style={td}>{getBuyerName(row)}</td>
                        <td style={td}>{row.consignee_name || "-"}</td>
                        <td style={td}>{formatDecimal4(row.quantity || row.unloading_qty || 0)}</td>
                        <td style={td}>{formatMoney(row.rate || 0)}</td>
                        <td style={td}>{formatMoney(row.claim_amount || 0)}</td>
                        <td style={td}>{formatMoney(row.other_deduction || row.adjustment_amount || 0)}</td>
                        <td style={td}>{formatMoney(row.tds_amount || 0)}</td>
                        <td style={td}>
                          <button
                            type="button"
                            onClick={() => {
                              setShowSaleAdjustedModal(false);
                              handleEditVoucher(rowId);
                            }}
                            style={{ ...btnAction, background: "#2563eb" }}
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {saleAdjustedBills.length === 0 && (
                    <tr>
                      <td colSpan={11} style={{ ...td, textAlign: "center", padding: 18 }}>
                        No adjusted sale vouchers found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {stockDrilldown && (
        <div style={modalOverlayStyle}>
          <div style={stockDrilldownModalStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 14 }}>
              <div>
                <h3 style={{ margin: 0 }}>{stockDrilldownTitle}</h3>
                <div style={{ color: "#475569", fontSize: 13, marginTop: 5 }}>
                  {getWarehouseName(stockDrilldown.item)} | {getAccountName(stockDrilldown.item)} | {getProductName(stockDrilldown.item)}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <button type="button" onClick={downloadStockDrilldownPdf} style={{ ...btnAction, background: "#0f766e" }}>
                  PDF
                </button>
                <button type="button" onClick={() => setStockDrilldown(null)} style={{ ...btnAction, background: "#64748b" }}>
                  Close
                </button>
              </div>
            </div>

            <div style={stockSummaryGridStyle}>
              {isStockDrilldownSale ? null : (
                <div style={stockMetricStyle}><span>Purchase / Inward Qty</span><strong>{formatDecimal4(stockDrilldownTotals.inward_qty || 0)}</strong></div>
              )}
              {isStockDrilldownPurchase ? null : (
                <div style={stockMetricStyle}><span>Sale / Outward Qty</span><strong>{formatDecimal4(stockDrilldownTotals.outward_qty || 0)}</strong></div>
              )}
              <div style={stockMetricStyle}><span>{isStockDrilldownCombined ? "Stock Qty" : "Balance Qty"}</span><strong>{formatDecimal4(stockDrilldownTotals.balance_qty || 0)}</strong></div>
              <div style={stockMetricStyle}><span>Purchase Avg Rate</span><strong>{formatMoney(stockDrilldownTotals.avg_rate || 0)}</strong></div>
              <div style={stockMetricStyle}><span>Stock Amount</span><strong>{formatMoney(stockDrilldownTotals.stock_value || 0)}</strong></div>
            </div>

            <div style={stockFilterBarStyle}>
              <Field label="From Date">
                <input
                  type="date"
                  value={stockDrilldownFromDate}
                  onChange={(event) => setStockDrilldownFromDate(event.target.value)}
                  style={inp}
                />
              </Field>
              <Field label="To Date">
                <input
                  type="date"
                  value={stockDrilldownToDate}
                  onChange={(event) => setStockDrilldownToDate(event.target.value)}
                  style={inp}
                />
              </Field>
              <button
                type="button"
                onClick={() => {
                  setStockDrilldownFromDate("");
                  setStockDrilldownToDate("");
                }}
                style={{ ...btnAction, background: "#475569", alignSelf: "end", minHeight: 38 }}
              >
                Reset Filter
              </button>
            </div>

            <div style={{ ...tableCard, maxHeight: "66vh", marginTop: 14 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={reportHeaderRowStyle}>
                    <th style={th}>Date</th>
                    <th style={th}>Type</th>
                    <th style={th}>Voucher No</th>
                    <th style={th}>Party</th>
                    {isStockDrilldownSale ? null : (
                      <>
                        <th style={th}>Inward Qty</th>
                        <th style={th}>In Rate</th>
                        <th style={th}>In Value</th>
                      </>
                    )}
                    {isStockDrilldownPurchase ? null : (
                      <>
                        <th style={th}>Outward Qty</th>
                        <th style={th}>Out Rate</th>
                        <th style={th}>Out Value</th>
                      </>
                    )}
                    <th style={th}>{isStockDrilldownCombined ? "Stock Qty" : "Balance Qty"}</th>
                    <th style={th}>Purchase Avg Rate</th>
                    <th style={th}>Stock Value</th>
                  </tr>
                </thead>
                <tbody>
                  {stockDrilldownRows.map((row, index) => (
                    <tr key={`${row.type}-${row.voucher_no || index}-${index}`} style={{ background: index % 2 ? "#f8fafc" : "#fff" }}>
                      <td style={td}>{formatLedgerDate(row.date)}</td>
                      <td style={{ ...td, fontWeight: 700, color: row.type === "Purchase" ? "#0f766e" : "#b45309" }}>{row.type}</td>
                      <td style={td}>{row.voucher_no || "-"}</td>
                      <td style={td}>{row.party_name || "-"}</td>
                      {isStockDrilldownSale ? null : (
                        <>
                          <td style={td}>{row.inward_qty ? formatDecimal4(row.inward_qty) : ""}</td>
                          <td style={td}>{row.inward_rate ? formatMoney(row.inward_rate) : ""}</td>
                          <td style={td}>{row.inward_amount ? formatMoney(row.inward_amount) : ""}</td>
                        </>
                      )}
                      {isStockDrilldownPurchase ? null : (
                        <>
                          <td style={td}>{row.outward_qty ? formatDecimal4(row.outward_qty) : ""}</td>
                          <td style={td}>{row.outward_rate ? formatMoney(row.outward_rate) : ""}</td>
                          <td style={td}>{row.outward_amount ? formatMoney(row.outward_amount) : ""}</td>
                        </>
                      )}
                      <td style={{ ...td, fontWeight: 800 }}>{formatDecimal4(row.balance_qty || 0)}</td>
                      <td style={td}>{formatMoney(row.day_avg_rate || 0)}</td>
                      <td style={{ ...td, fontWeight: 800 }}>{formatMoney(row.stock_value || 0)}</td>
                    </tr>
                  ))}
                  {stockDrilldownRows.length === 0 && (
                    <tr><td colSpan={isStockDrilldownCombined ? 13 : 10} style={{ ...td, textAlign: "center", padding: 20 }}>No stock detail available.</td></tr>
                  )}
                </tbody>
                {stockDrilldownRows.length > 0 && (
                  <tfoot>
                    <tr style={{ background: "#f1f5f9", fontWeight: 800 }}>
                      <td style={td} colSpan={4}>Total</td>
                      {isStockDrilldownSale ? null : (
                        <>
                          <td style={td}>{formatDecimal4(stockDrilldownTotals.inward_qty)}</td>
                          <td style={td}></td>
                          <td style={td}>{formatMoney(stockDrilldownTotals.inward_amount)}</td>
                        </>
                      )}
                      {isStockDrilldownPurchase ? null : (
                        <>
                          <td style={td}>{formatDecimal4(stockDrilldownTotals.outward_qty)}</td>
                          <td style={td}></td>
                          <td style={td}>{formatMoney(stockDrilldownTotals.outward_amount)}</td>
                        </>
                      )}
                      <td style={td}>{formatDecimal4(stockDrilldownTotals.balance_qty)}</td>
                      <td style={td}>{formatMoney(stockDrilldownTotals.avg_rate)}</td>
                      <td style={td}>{formatMoney(stockDrilldownTotals.stock_value)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </div>
      )}      {showPurchasePreview && (isPurchaseVoucher || purchasePreviewRow) && (
        <WarehousePurchasePreviewModal
          modalOverlayStyle={modalOverlayStyle}
          paymentAdjustModalStyle={paymentAdjustModalStyle}
          btnAction={btnAction}
          btnPrimary={btnPrimary}
          reportHeaderRowStyle={reportHeaderRowStyle}
          th={th}
          td={td}
          purchasePreviewRow={purchasePreviewRow}
          purchasePreviewLoading={purchasePreviewLoading}
          purchaseReportRows={purchaseReportRows}
          currentPurchasePreviewIndex={currentPurchasePreviewIndex}
          navigatePurchasePreview={navigatePurchasePreview}
          handleEditPurchaseReport={handleEditPurchaseReport}
          handleDownloadPurchasePdf={handleDownloadPurchasePdfFromPreview}
          setShowPurchasePreview={setShowPurchasePreview}
          setPurchasePreviewRow={setPurchasePreviewRow}
          setPurchasePreviewOpenedFromLedger={setPurchasePreviewOpenedFromLedger}
          loading={loading}
          saveVoucher={saveVoucher}
          getPurchasePreviewData={getPurchasePreviewData}
          getPurchasePreviewDataForRow={getPurchasePreviewDataForRow}
          formData={formData}
          formatMoney={formatMoney}
        />
      )}
      {showSalePreview && salePreviewRow && (
        <WarehouseSalePreviewModal
          modalOverlayStyle={modalOverlayStyle}
          paymentAdjustModalStyle={paymentAdjustModalStyle}
          btnAction={btnAction}
          btnPrimary={btnPrimary}
          reportHeaderRowStyle={reportHeaderRowStyle}
          th={th}
          td={td}
          salePreviewRow={salePreviewRow}
          salePreviewSummary={salePreviewSummary}
          saleTransportMode={saleTransportMode}
          saleTransportManualAmount={saleTransportManualAmount}
          setSaleTransportMode={setSaleTransportMode}
          setSaleTransportManualAmount={setSaleTransportManualAmount}
          setShowSalePreview={setShowSalePreview}
          setSalePreviewRow={setSalePreviewRow}
          setSalePreviewSummary={setSalePreviewSummary}
          setLoading={setLoading}
          loading={loading}
          activeTab={activeTab}
          loadReport={loadReport}
          loadVouchers={loadVouchers}
          formatMoney={formatMoney}
          formatDecimal4={formatDecimal4}
          toNumber={toNumber}
          getSalePreviewDataForRow={getSalePreviewDataForRow}
          axios={axios}
        />
      )}
      </div>
    </>
  );
}

function SearchableSelect({ label, value, options, onChange, placeholder = "Select", disabled = false }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef(null);

  const normalizedOptions = useMemo(
    () =>
      (options || []).map((option) => ({
        ...option,
        value: String(option?.value ?? "").trim(),
        label: String(option?.label ?? "").trim(),
      })),
    [options]
  );

  const selectedOption = useMemo(
    () => normalizedOptions.find((option) => String(option.value) === String(value)),
    [normalizedOptions, value]
  );

  const filteredOptions = useMemo(() => {
    const query = String(search || "").trim().toLowerCase();
    if (!query) return normalizedOptions;
    return normalizedOptions.filter((option) => option.label.toLowerCase().includes(query));
  }, [normalizedOptions, search]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelect = (nextValue) => {
    onChange(nextValue);
    setOpen(false);
    setSearch("");
  };

  return (
    <div ref={rootRef} style={{ position: "relative", minWidth: 260, flex: "1 1 260px" }}>
      <label style={{ marginBottom: 6, display: "block", fontSize: 12, fontWeight: 700, color: "#475569" }}>{label}</label>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((prev) => !prev)}
        style={{
          width: "100%",
          padding: "10px 12px",
          borderRadius: 8,
          border: "1px solid #cbd5e1",
          background: disabled ? "#f8fafc" : "#fff",
          textAlign: "left",
          cursor: disabled ? "not-allowed" : "pointer",
          color: selectedOption ? "#0f172a" : "#64748b",
          fontSize: 14,
          boxSizing: "border-box",
        }}
      >
        {selectedOption ? selectedOption.label : placeholder}
      </button>
      {open && !disabled ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            right: 0,
            zIndex: 30,
            background: "#fff",
            border: "1px solid #dbe4ea",
            borderRadius: 12,
            boxShadow: "0 18px 40px rgba(15, 23, 42, 0.14)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: 10, borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }}>
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Type to filter"
              style={{
                width: "100%",
                padding: "9px 10px",
                border: "1px solid #cbd5e1",
                borderRadius: 8,
                fontSize: 13,
                boxSizing: "border-box",
              }}
            />
          </div>
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {filteredOptions.length ? (
              filteredOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleSelect(option.value)}
                  style={{
                    width: "100%",
                    display: "block",
                    textAlign: "left",
                    padding: "10px 12px",
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    color: "#0f172a",
                  }}
                >
                  {option.label}
                </button>
              ))
            ) : (
              <div style={{ padding: "10px 12px", color: "#64748b", fontSize: 13 }}>No items found</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }) {
  return <div><label style={lbl}>{label}</label>{children}</div>;
}

function SummaryInput({ label, name, value, onChange, readOnly = false }) {
  return (
    <div style={summaryBox}>
      <label style={summaryLabel}>{label}</label>
      <input
        name={name}
        type={readOnly ? "text" : "number"}
        step="0.0001"
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        style={readOnly ? summaryReadOnlyInput : summaryInput}
      />
    </div>
  );
}


const paymentResponsiveCss = `
  .payment-entry-row { grid-template-columns: minmax(0, 230px) auto !important; }
  .payment-entry-row input { width: 230px !important; max-width: 100% !important; }
  @media (max-width: 700px) {
    .payment-entry-row { grid-template-columns: 1fr !important; }
    .payment-entry-row input { width: 100% !important; }
  }
`;

const headerRow = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 18, flexWrap: "wrap", position: "sticky", top: 0, zIndex: 30, background: "#fff", padding: "16px 0" };
const subtitleStyle = { margin: 0, color: "#475569" };
const titleStyle = { margin: 0, fontSize: 22, color: "#0f172a" };
const tabRow = { display: "flex", gap: 10 };
const tabStyle = { border: "1px solid #cbd5e1", background: "#fff", color: "#0f172a", padding: "10px 16px", borderRadius: 8, cursor: "pointer" };
const activeTabStyle = { ...tabStyle, background: "#087a73", color: "#fff", borderColor: "#087a73" };
const voucherTypeRow = { display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" };
const voucherButtonStyle = { background: "#e2e8f0", color: "#0f172a", border: "none", padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 500 };
const activeVoucherButtonStyle = { ...voucherButtonStyle, background: "#087a73", color: "#fff" };
const card = { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 20, marginBottom: 18, boxShadow: "0 4px 14px rgba(15,23,42,0.06)" };
const formGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 };
const paymentHeroCard = { border: "1px solid #dbeafe", borderRadius: 16, padding: 16, background: "linear-gradient(135deg, #eef7ff 0%, #ffffff 100%)", boxShadow: "0 10px 24px rgba(37,99,235,0.08)", marginBottom: 16 };
const paymentHeroHeader = { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" };
const paymentBadge = { display: "inline-flex", alignItems: "center", gap: 8, padding: "7px 11px", borderRadius: 999, background: "#2563eb", color: "#fff", fontWeight: 700, fontSize: 12 };
const paymentQuickGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginTop: 12 };
const paymentQuickBox = { background: "#fff", border: "1px solid #dbeafe", borderRadius: 10, padding: 10 };

const paymentEyebrow = { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.18em", color: "#0f766e", fontWeight: 800, marginBottom: 3 };
const paymentHeroTitle = { margin: "0 0 4px", fontSize: 17, color: "#0f172a" };
const paymentHeroSubtitle = { margin: 0, fontSize: 12, color: "#64748b" };
const paymentModeRow = { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 };
const paymentModeButton = { border: "1px solid #dbe4f0", background: "#fff", color: "#334155", borderRadius: 8, padding: "7px 10px", fontWeight: 700, fontSize: 11, cursor: "pointer" };
const paymentModeButtonActive = { background: "#0f766e", color: "#fff", borderColor: "#0f766e" };
const paymentSelectorGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8, marginTop: 12 };
const paymentFinancialSummary = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))", gap: 7, marginTop: 10 };
const paymentStatCard = { background: "#fff", border: "1px solid #dbe4f0", borderRadius: 9, padding: "8px 9px", minWidth: 0 };
const paymentStatLabel = { display: "block", fontSize: 10, color: "#64748b", marginBottom: 3, fontWeight: 700 };
const paymentStatValue = { display: "block", fontSize: 13, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const paymentDueCard = { borderColor: "#fecaca", background: "#fff7f7" };
const inp = { width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: 14, boxSizing: "border-box" };
const paymentEntryRow = { display: "grid", gridTemplateColumns: "minmax(0, 230px) auto", justifyContent: "start", gap: 12, alignItems: "end", marginTop: 10 };
const paymentAmountInput = { width: "230px", maxWidth: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: 15, fontWeight: 700, boxSizing: "border-box", minHeight: 42 };
const paymentAdjustmentAction = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingBottom: 1 };
const paymentAdjustedText = { fontSize: 11, color: "#475569", whiteSpace: "nowrap" };
const paymentSelectedBar = { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 9, padding: "7px 9px", borderRadius: 8, background: "#f8fafc", border: "1px solid #e2e8f0", fontSize: 10.5, color: "#475569" };
const readOnlyInp = { width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: 14, boxSizing: "border-box", background: "#f8fafc", color: "#475569" };
const btnPrimary = { background: "#2563eb", color: "#fff", border: "none", padding: "10px 18px", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: 14 };
const th = { padding: "10px 8px", textAlign: "left", borderBottom: "1px solid #0d5c56" };
const td = { padding: "8px", borderBottom: "1px solid #e2e8f0" };
const tableCard = { overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff" };
const ledgerSplitStyle = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(360px, 100%), 1fr))", gap: 14, alignItems: "start" };
const billWisePanelStyle = { border: "1px solid #dbe4ef", borderRadius: 10, padding: 12, background: "#f8fafc" };
const linkButtonStyle = { border: "none", background: "transparent", color: "#2563eb", cursor: "pointer", padding: 0, fontWeight: 700, textDecoration: "underline" };
const paymentDetailBoxStyle = { marginTop: 10, border: "1px solid #dbe4ef", borderRadius: 8, background: "#fff", padding: 10, maxWidth: 460 };
const paymentDetailRowStyle = { display: "grid", gridTemplateColumns: "90px 1fr auto", gap: 8, padding: "6px 0", borderBottom: "1px solid #edf2f7", fontSize: 12 };
const modalOverlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.48)",
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
};
const paymentAdjustModalStyle = {
  width: "min(980px, 96vw)",
  maxHeight: "90vh",
  overflow: "auto",
  background: "#fff",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  boxShadow: "0 20px 45px rgba(15, 23, 42, 0.25)",
  padding: 18,
};
const stockDrilldownModalStyle = {
  width: "min(1380px, 98vw)",
  maxHeight: "96vh",
  overflow: "auto",
  background: "#fff",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  boxShadow: "0 20px 45px rgba(15, 23, 42, 0.25)",
  padding: 20,
};
const stockSummaryGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 10,
};
const stockFilterBarStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 12,
  alignItems: "end",
  marginTop: 14,
  padding: 12,
  border: "1px solid #dbe4ef",
  borderRadius: 8,
  background: "#f8fafc",
};
const stockMetricStyle = {
  border: "1px solid #dbe4ef",
  borderRadius: 6,
  background: "#f8fafc",
  padding: "10px 12px",
  display: "grid",
  gap: 5,
};
const smartInfoGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 8,
  marginTop: 10,
};
const smartInfoBoxStyle = {
  border: "1px solid #bbf7d0",
  borderRadius: 8,
  background: "#f0fdf4",
  padding: "8px 10px",
  display: "grid",
  gap: 4,
  color: "#14532d",
  fontSize: 12,
};
const reportHeaderRowStyle = { background: "#087a73", color: "#fff", position: "sticky", top: 0, zIndex: 1 };
const lbl = { display: "block", marginBottom: 6, fontWeight: 600, fontSize: 13, color: "#334155" };
const memoShell = { border: "1px solid #d7dee8", borderRadius: 10, padding: 18, background: "#fbfdff" };
const memoHeader = { display: "flex", justifyContent: "space-between", gap: 18, alignItems: "flex-start", borderBottom: "2px solid #ea580c", paddingBottom: 14, marginBottom: 16, flexWrap: "wrap" };
const memoTitle = { margin: 0, color: "#0b2a5b", fontSize: 28, letterSpacing: 0, fontWeight: 800 };
const memoSubTitle = { marginTop: 8, color: "#334155", fontSize: 14, fontWeight: 600 };
const memoHeaderFields = { display: "grid", gridTemplateColumns: "repeat(2, minmax(150px, 1fr))", gap: 12, minWidth: 320 };
const memoInfoGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginBottom: 16 };
const memoMainGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginBottom: 18 };
const memoPanel = { border: "1px solid #d7dee8", borderRadius: 8, padding: 16, background: "#fff" };
const memoPanelTitle = { background: "#0b2a5b", color: "#fff", fontWeight: 800, textTransform: "uppercase", fontSize: 13, padding: "8px 12px", borderRadius: 6, margin: "-16px -16px 14px -16px" };
const memoTable = { width: "100%", borderCollapse: "collapse", fontSize: 14 };
const memoTh = { background: "#0b2a5b", color: "#fff", padding: "10px 8px", textAlign: "left", border: "1px solid #173a70" };
const memoTd = { padding: "7px 8px", border: "1px solid #e2e8f0", verticalAlign: "middle" };
const tableInput = { width: "100%", border: "1px solid #cbd5e1", borderRadius: 6, padding: "7px 8px", boxSizing: "border-box", fontSize: 13 };
const memoBottomGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 16 };
const summaryBox = { border: "1px solid #d7dee8", borderRadius: 8, background: "#fff", overflow: "hidden" };
const summaryLabel = { display: "block", padding: "9px 10px", color: "#0b2a5b", fontSize: 12, fontWeight: 800, textTransform: "uppercase", borderBottom: "1px solid #e2e8f0" };
const summaryInput = { width: "100%", border: "none", padding: "12px 10px", color: "#ea580c", fontWeight: 800, fontSize: 15, textAlign: "center", boxSizing: "border-box" };
const summaryReadOnlyInput = { ...summaryInput, background: "#f8fafc" };
const memoTotals = { width: "min(100%, 420px)", marginLeft: "auto", border: "1px solid #d7dee8", borderRadius: 8, overflow: "hidden", background: "#fff" };
const totalLine = { display: "flex", justifyContent: "space-between", gap: 12, padding: "12px 16px", borderBottom: "1px solid #e2e8f0", color: "#0f172a", fontWeight: 700 };
const payableLine = { ...totalLine, borderBottom: "none", background: "#0b2a5b", color: "#fff" };
const btnAction = { background: "#2563eb", color: "#fff", border: "none", padding: "6px 10px", borderRadius: 4, cursor: "pointer", fontWeight: 500, fontSize: 12 };

const erpShell = {
  background: "#f5f8f7",
  border: "1px solid #b9d0cc",
  borderRadius: 4,
  padding: 8,
  color: "#111827",
  fontFamily: "Arial, Segoe UI, sans-serif",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.7)",
};
const erpTitleBar = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  marginBottom: 6,
  flexWrap: "wrap",
};
const erpTitleLeft = { display: "flex", alignItems: "center", gap: 6 };
const erpDocIcon = {
  width: 18,
  height: 18,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#087a73",
  color: "#fff",
  fontSize: 14,
  fontWeight: 800,
};
const erpTitleText = { color: "#2f542c", fontSize: 22, fontWeight: 800, lineHeight: 1 };
const erpMetaLine = { display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "#111827", flexWrap: "wrap" };
const erpTopGrid = {
  display: "grid",
  gridTemplateColumns: "minmax(390px, 1.35fr) minmax(320px, 1.05fr) minmax(260px, 0.85fr)",
  gap: 4,
  alignItems: "stretch",
  marginBottom: 6,
};
const erpPanelWide = { border: "1px solid #c8d6d3", background: "#f7f7fb", borderRadius: 4, padding: 8 };
const erpPanelSmall = {
  border: "1px solid #c9c9d5",
  background: "#f2f2f7",
  borderRadius: 4,
  padding: 8,
  display: "grid",
  alignContent: "center",
  gap: 8,
};
const erpDocPanel = { border: "1px solid #c8d6d3", background: "#f7f7fb", borderRadius: 4, padding: 8 };
const erpRow = { display: "flex", alignItems: "center", gap: 6, minHeight: 26, marginBottom: 4 };
const erpLabel = { width: 88, fontSize: 12, color: "#111827", flex: "0 0 auto" };
const erpCheckLabel = { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#111827" };
const erpCheck = { width: 16, height: 16, margin: 0 };
const erpInput = {
  height: 23,
  minWidth: 0,
  flex: 1,
  border: "1px solid #c9c9c9",
  background: "#fff",
  padding: "2px 6px",
  fontSize: 12,
  borderRadius: 0,
  boxSizing: "border-box",
};
const erpFocusInput = { borderColor: "#4d90fe", boxShadow: "inset 0 0 0 1px rgba(77,144,254,0.15)" };
const erpSectionLabel = { fontSize: 12, color: "#111827", margin: "3px 0 2px" };
const erpGridWrap = {
  overflowX: "auto",
  border: "1px solid #c3d8d5",
  background: "#fff",
};
const erpItemsTable = { width: "100%", minWidth: 1320, borderCollapse: "collapse", tableLayout: "fixed", fontSize: 12 };
const erpTh = {
  border: "1px solid #c3d8d5",
  background: "#e8f3f1",
  color: "#111827",
  padding: "2px 4px",
  fontWeight: 500,
  textAlign: "left",
  height: 20,
  whiteSpace: "nowrap",
};
const erpTd = {
  border: "1px solid #c3d8d5",
  background: "#fff",
  color: "#111827",
  padding: 0,
  height: 22,
  lineHeight: "20px",
  verticalAlign: "middle",
};
const erpCellInput = {
  width: "100%",
  height: 21,
  border: "none",
  background: "transparent",
  padding: "1px 4px",
  fontSize: 12,
  boxSizing: "border-box",
  outline: "none",
};
const erpReadOnlyCell = { background: "#f5f7fb", color: "#111827", fontWeight: 700 };
const erpMiddleBar = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  fontSize: 12,
  padding: "5px 2px 3px",
};
const erpBottomGrid = {
  display: "grid",
  gridTemplateColumns: "minmax(420px, 1fr) minmax(420px, 1fr)",
  gap: 10,
  alignItems: "start",
};
const erpMiniTable = { width: "100%", borderCollapse: "collapse", tableLayout: "fixed", fontSize: 12, background: "#fff" };
const erpRemarksRow = { display: "flex", alignItems: "stretch", gap: 6, marginTop: 8 };
const erpTextarea = {
  flex: 1,
  minHeight: 48,
  border: "1px solid #c9c9c9",
  resize: "vertical",
  padding: 6,
  fontSize: 12,
  fontFamily: "Arial, Segoe UI, sans-serif",
};
const erpTotalPanel = {
  marginTop: 8,
  minHeight: 46,
  border: "1px solid #c9c9d5",
  background: "#e8f3f1",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 14px",
  fontWeight: 900,
  fontSize: 18,
};
const erpTotalLabel = { letterSpacing: 8, color: "#2f542c" };
const erpTotalAmount = { letterSpacing: 0, color: "#2f542c", fontSize: 30 };
