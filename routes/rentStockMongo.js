const express = require('express');
const router = express.Router();
const { userHasPermission } = require('../middleware/auth');
const {
  mongoose,
  CompanyOperational,
  CompanyAccountOperational,
  WarehouseOperational,
  LocationOperational,
  ProductOperational,
  EmployeeOperational,
  FarmerOperational,
  InwardOperational,
  AdjustmentOperational,
  OutwardOperational,
  BuyerAdjustmentOperational,
  PurchaseVoucherOperational,
} = require('../mongoOperationalModels');
const { calculateShortageQty } = require('../routes/shortageHelper');

function mongoReady() { return mongoose.connection.readyState === 1; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function dateOnly(v) {
  if (v === undefined || v === null || v === '') return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  if (typeof v === 'object') {
    if (v.$date) return dateOnly(v.$date);
    if (v.date) return dateOnly(v.date);
    if (v.value) return dateOnly(v.value);
  }
  const s = String(v).trim();
  const iso = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) return `${dmy[3]}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}`;
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return '';
}
function monthEnd(month) {
  const [y,m] = String(month || '').split('-').map(Number);
  if (!y || !m) return '';
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0,10);
}
function addMonths(month, delta) {
  const [y,m] = String(month).split('-').map(Number);
  const d = new Date(Date.UTC(y, (m || 1)-1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
}
function monthLabel(month) {
  const [y,m] = String(month).split('-').map(Number);
  if (!y || !m) return '';
  return new Date(Date.UTC(y, m-1, 1)).toLocaleString('en-US', { month:'long', year:'numeric', timeZone:'UTC' });
}
function monthSlab(inwardDate, refDate) {
  const a = new Date(`${dateOnly(inwardDate)}T00:00:00Z`);
  const b = new Date(`${dateOnly(refDate)}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return { daysDiff: 0, monthsDiff: 1 };
  const daysDiff = Math.max(0, Math.floor((b-a)/86400000));
  let monthsDiff = Math.floor((daysDiff <= 0 ? 0 : daysDiff - 1)/30) + 1;
  if (monthsDiff < 1) monthsDiff = 1;
  return { daysDiff, monthsDiff };
}
function availableQty(weight, inwardDate, adjusted, shortagePercent, refDate) {
  const slab = monthSlab(inwardDate, refDate || new Date().toISOString().slice(0,10));
  const gross = num(weight);
  const shortage = calculateShortageQty(gross, slab.monthsDiff, shortagePercent);
  return gross - shortage - num(adjusted);
}
function legacyValue(row, key) {
  const v = row?.[key];
  return v === undefined || v === null || v === '' ? '' : String(v);
}
function perm(req, value) { return userHasPermission(req.user, value) || userHasPermission(req.user, 'all'); }
function reportAccess(req, value) { return perm(req,value) || perm(req,'dashboard.view'); }

function queryValues(values) {
  return Array.from(new Set((values || []).map(v => String(v ?? '').trim()).filter(Boolean)));
}
function masterQuery(ids, names = []) {
  const vals = queryValues(ids);
  const nameVals = queryValues(names).map(v => v.toLowerCase());
  const or = [];
  if (vals.length) {
    or.push({ id: { $in: vals } }, { legacy_id: { $in: vals } });
    const objectIds = vals.filter(v => mongoose.Types.ObjectId.isValid(v)).map(v => new mongoose.Types.ObjectId(v));
    if (objectIds.length) or.push({ _id: { $in: objectIds } });
  }
  if (nameVals.length) {
    or.push({ name: { $in: queryValues(names) } }, { account_name: { $in: queryValues(names) } });
  }
  return or.length ? { $or: or } : { _id: { $exists: false } };
}
function makeMap(rows) {
  const m = new Map();
  (rows || []).forEach(r => {
    [r._id, r.id, r.legacy_id].filter(v => v !== undefined && v !== null && v !== '').forEach(v => m.set(String(v), r));
    if (r.name) m.set(`name:${String(r.name).trim().toLowerCase()}`, r);
    if (r.account_name) m.set(`name:${String(r.account_name).trim().toLowerCase()}`, r);
  });
  return m;
}
async function masterMapsForRows(rows) {
  const pick = (idKey, nameKeys = []) => {
    const ids = [], names = [];
    for (const r of rows || []) {
      if (r?.[idKey] !== undefined && r?.[idKey] !== null && r?.[idKey] !== '') ids.push(r[idKey]);
      for (const k of nameKeys) if (r?.[k]) names.push(r[k]);
    }
    return { ids, names };
  };
  const company = pick('company_id', ['company_name', 'company']);
  const account = pick('company_account_id', ['company_account_name', 'company_account', 'account_name']);
  const warehouse = pick('warehouse_id', ['warehouse_name', 'warehouse']);
  const location = pick('location_id', ['location_name', 'location']);
  const product = pick('product_id', ['product_name', 'product']);
  const employee = pick('employee_id', ['employee_name']);
  const farmer = pick('farmer_id', ['farmer_name', 'farmer']);

  const [companies, accounts, warehouses, locations, products, employees, farmers] = await Promise.all([
    CompanyOperational.find(masterQuery(company.ids, company.names)).select({ name: 1, address: 1, company_address: 1, location: 1, city: 1, district: 1, id: 1, legacy_id: 1 }).lean(),
    CompanyAccountOperational.find(masterQuery(account.ids, account.names)).select({ name: 1, account_name: 1, address: 1, location: 1, id: 1, legacy_id: 1 }).lean(),
    WarehouseOperational.find(masterQuery(warehouse.ids, warehouse.names)).select({ name: 1, address: 1, warehouse_address: 1, location: 1, full_address: 1, city: 1, district: 1, id: 1, legacy_id: 1 }).lean(),
    LocationOperational.find(masterQuery(location.ids, location.names)).select({ name: 1, id: 1, legacy_id: 1 }).lean(),
    ProductOperational.find(masterQuery(product.ids, product.names)).select({ name: 1, id: 1, legacy_id: 1 }).lean(),
    EmployeeOperational.find(masterQuery(employee.ids, employee.names)).select({ name: 1, id: 1, legacy_id: 1 }).lean(),
    FarmerOperational.find(masterQuery(farmer.ids, farmer.names)).select({ name: 1, id: 1, legacy_id: 1 }).lean(),
  ]);
  return { companies: makeMap(companies), accounts: makeMap(accounts), warehouses: makeMap(warehouses), locations: makeMap(locations), products: makeMap(products), employees: makeMap(employees), farmers: makeMap(farmers) };
}
async function masterMaps() {
  return masterMapsForRows([]);
}

function findMaster(map, id, name) { return map.get(String(id || '')) || map.get(`name:${String(name || '').trim().toLowerCase()}`) || null; }
function masterAddress(map, id, name) {
  const master = findMaster(map, id, name);
  return master?.address || master?.warehouse_address || master?.location || master?.full_address || master?.city || master?.district || '';
}
function idsFromQuery(v) { return new Set(String(v || '').split(',').map(s=>s.trim()).filter(Boolean)); }

async function buildInwardRows(filters = {}) {
  const from = dateOnly(filters.from_date), to = dateOnly(filters.to_date);
  const companyIds = idsFromQuery(filters.company_ids || filters.company_id);
  const warehouseIds = idsFromQuery(filters.warehouse_ids || filters.warehouse_id);
  const locationIds = idsFromQuery(filters.location_ids || filters.location_id);
  const productId = String(filters.product_id || '');
  const employeeId = String(filters.employee_id || '');
  const query = {};
  if (companyIds.size) query.company_id = { $in: Array.from(companyIds) };
  if (warehouseIds.size) query.warehouse_id = { $in: Array.from(warehouseIds) };
  if (locationIds.size) query.location_id = { $in: Array.from(locationIds) };
  if (productId) query.product_id = productId;
  if (employeeId) query.employee_id = employeeId;

  // Keep date filtering in JS because this legacy collection contains mixed date types.
  // The projection and other DB-side filters avoid shipping unnecessary document fields.
  const docs = await InwardOperational.find(query).select({
    _id: 1, id: 1, legacy_id: 1, date: 1, inward_date: 1, weight: 1, shortage_percent: 1,
    company_id: 1, company_name: 1, company: 1, company_account_id: 1, company_account_name: 1, company_account: 1,
    warehouse_id: 1, warehouse_name: 1, warehouse: 1, location_id: 1, location_name: 1, location: 1,
    product_id: 1, product_name: 1, product: 1, employee_id: 1, employee_name: 1,
    lorry_no: 1, voucher_no: 1, outward_date: 1, company_address: 1, warehouse_address: 1,
  }).lean();
  const filtered = docs.filter(r => {
    const d = dateOnly(r.inward_date) || dateOnly(r.date);
    if (from && (!d || d < from)) return false;
    if (to && (!d || d > to)) return false;
    return true;
  });
  const maps = await masterMapsForRows(filtered);
  return filtered.map(r => {
    const c = findMaster(maps.companies, r.company_id, r.company_name || r.company);
    const a = findMaster(maps.accounts, r.company_account_id, r.company_account_name || r.company_account || r.account_name);
    const w = findMaster(maps.warehouses, r.warehouse_id, r.warehouse_name || r.warehouse);
    const l = findMaster(maps.locations, r.location_id, r.location_name || r.location);
    const p = findMaster(maps.products, r.product_id, r.product_name || r.product);
    const e = findMaster(maps.employees, r.employee_id, r.employee_name);
    const inwardDate = dateOnly(r.inward_date) || dateOnly(r.date);
    return {
      ...r,
      id: String(r.legacy_id ?? r.id ?? r._id),
      legacy_id: r.legacy_id ?? r.id,
      company_name: c?.name || r.company_name || r.company || '',
      company_address: c?.address || c?.company_address || c?.location || a?.address || r.company_address || r.address || '',
      account_name: a?.account_name || a?.name || r.company_account_name || r.company_account || '',
      warehouse_name: w?.name || r.warehouse_name || r.warehouse || '',
      warehouse_address: masterAddress(maps.warehouses, r.warehouse_id, r.warehouse_name || r.warehouse) || r.warehouse_address || '',
      location_name: l?.name || r.location_name || r.location || '',
      product_name: p?.name || r.product_name || r.product || '',
      employee_name: e?.name || r.employee_name || '',
      date: inwardDate,
      inward_date: inwardDate,
      outward_date: dateOnly(r.outward_date),
    };
  });
}

async function adjustmentMap(inwardIds = null) {
  const ids = inwardIds ? queryValues(inwardIds) : null;
  const query = ids && ids.length ? { inward_id: { $in: ids } } : {};
  const rows = await AdjustmentOperational.find(query).select({
    _id: 1, id: 1, legacy_id: 1, inward_id: 1, outward_id: 1, qty: 1, outward_date: 1, created_at: 1,
  }).lean();
  const m = new Map();
  rows.forEach(r => { const k = String(r.inward_id ?? ''); if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  return m;
}

async function buildRentDetails({ monthList, filters }) {
  const rows = await buildInwardRows(filters);
  const adjByInward = await adjustmentMap();
  const outwards = await OutwardOperational.find({}).lean();
  const buyers = await BuyerAdjustmentOperational.find({}).lean();
  const outById = new Map(outwards.map(r => [String(r.legacy_id ?? r.id ?? r._id), r]));
  const buyerByOutward = new Map();
  buyers.forEach(r => buyerByOutward.set(String(r.outward_id), r));
  const rentRate = 200;
  const detailed = [];
  for (const row of rows) {
    const adjustments = adjByInward.get(String(row.legacy_id ?? row.id)) || [];
    for (const month of monthList) {
      const monthEndDate = monthEnd(month);
      const slab = monthSlab(row.date, monthEndDate);
      let adjustedQty=0, adjustedRentAmount=0, lastDispatchDate=null;
      for (const a of adjustments) {
        const out = outById.get(String(a.outward_id || ''));
        const buyer = buyerByOutward.get(String(a.outward_id || ''));
        const adjustmentDate = dateOnly(buyer?.unloading_date) || dateOnly(out?.date) || dateOnly(a.created_at);
        if (!adjustmentDate || adjustmentDate > monthEndDate) continue;
        const qty=num(a.qty), aSlab=monthSlab(row.date, adjustmentDate);
        adjustedQty += qty; adjustedRentAmount += qty*rentRate*aSlab.monthsDiff;
        if (!lastDispatchDate || adjustmentDate > lastDispatchDate) lastDispatchDate=adjustmentDate;
      }
      const shortageQty = calculateShortageQty(num(row.weight), slab.monthsDiff, row.shortage_percent);
      const balanceQty = num(row.weight)-shortageQty-adjustedQty;
      const balanceRentAmount = Math.max(balanceQty,0)*rentRate*slab.monthsDiff;
      detailed.push({
        id:row.id, month, month_label:monthLabel(month), month_end_date:monthEndDate,
        inward_date:row.date, reference_date: num(row.weight)-adjustedQty>0 ? monthEndDate : (lastDispatchDate || monthEndDate),
        dispatch_date:lastDispatchDate || null, party_name:row.company_name || row.account_name || 'Unknown',
        warehouse_name:row.warehouse_name || 'Unknown', voucher_no:row.voucher_no || '', lorry_no:row.lorry_no || '',
        original_weight:Number(num(row.weight).toFixed(4)), adjusted_qty:Number(adjustedQty.toFixed(4)), shortage_qty:Number(shortageQty.toFixed(4)),
        balance_qty:Number(Math.max(balanceQty,0).toFixed(4)), days_diff:slab.daysDiff, month_slab:slab.monthsDiff, rent_rate:rentRate,
        adjusted_rent_amount:Number(adjustedRentAmount.toFixed(2)), balance_rent_amount:Number(balanceRentAmount.toFixed(2)),
        rent_amount:Number((adjustedRentAmount+balanceRentAmount).toFixed(2)),
      });
    }
  }
  return detailed;
}

router.get('/party-stock', async (req,res,next) => {
  if (!reportAccess(req,'report.partyStock')) return res.status(403).json({error:'Permission denied'});
  if (!mongoReady()) return next();
  try {
    const rows = await buildInwardRows(req.query);
    const adjMap = await adjustmentMap(rows.map(r => r.legacy_id ?? r.id));
    const outwardIds = [];
    for (const list of adjMap.values()) for (const a of list) if (a.outward_id) outwardIds.push(a.outward_id);
    const uniqueOutwardIds = queryValues(outwardIds);
    const [outwards, buyers] = await Promise.all([
      uniqueOutwardIds.length ? OutwardOperational.find({ $or: [
        { id: { $in: uniqueOutwardIds } }, { legacy_id: { $in: uniqueOutwardIds } }, { outward_id: { $in: uniqueOutwardIds } },
        ...(uniqueOutwardIds.filter(v => mongoose.Types.ObjectId.isValid(v)).length ? [{ _id: { $in: uniqueOutwardIds.filter(v => mongoose.Types.ObjectId.isValid(v)).map(v => new mongoose.Types.ObjectId(v)) } }] : [])
      ] }).select({ _id: 1, id: 1, legacy_id: 1, outward_id: 1, date: 1, outward_date: 1 }).lean() : [],
      uniqueOutwardIds.length ? BuyerAdjustmentOperational.find({ outward_id: { $in: uniqueOutwardIds } }).select({ outward_id: 1, unloading_date: 1, outward_date: 1 }).lean() : [],
    ]);
    const outById = new Map();
    outwards.forEach(o => {
      [o._id, o.id, o.legacy_id, o.outward_id].filter(v => v !== undefined && v !== null && v !== '').forEach(v => outById.set(String(v), o));
    });
    const buyerByOutward = new Map();
    buyers.forEach(b => {
      if (b.outward_id !== undefined && b.outward_id !== null && b.outward_id !== '') buyerByOutward.set(String(b.outward_id), b);
    });

    const summaryMap=new Map(); const details=[]; const refDate=dateOnly(req.query.to_date)||new Date().toISOString().slice(0,10);
    for (const r of rows) {
      const adjustments=adjMap.get(String(r.legacy_id ?? r.id))||[];
      let adjusted=0;
      let latestOutwardDate=dateOnly(r.outward_date);
      adjustments.forEach(a => {
        adjusted += num(a.qty);
        const outwardId=String(a.outward_id || '');
        const out=outById.get(outwardId);
        const buyer=buyerByOutward.get(outwardId);
        const candidate=dateOnly(a.outward_date) || dateOnly(buyer?.outward_date) || dateOnly(buyer?.unloading_date) || dateOnly(out?.outward_date) || dateOnly(out?.date) || dateOnly(a.created_at);
        if (candidate && (!latestOutwardDate || candidate > latestOutwardDate)) latestOutwardDate=candidate;
      });
      const avail=availableQty(r.weight,r.date,adjusted,r.shortage_percent,refDate);
      const shortageQty=Math.max(0,num(r.weight)-avail-adjusted);
      const detail={
        ...r,
        gross_qty:num(r.weight),
        shortage_qty:Number(shortageQty.toFixed(4)),
        net_opening_qty:Number((num(r.weight)-shortageQty).toFixed(4)),
        already_adjusted_qty:Number(adjusted.toFixed(4)),
        available_balance_qty:Number(avail.toFixed(4)),
        date:r.date,
        inward_date:r.inward_date || r.date || '',
        outward_date:latestOutwardDate || '',
        warehouse_address:r.warehouse_address || '',
        company_address:r.company_address || '',
      };
      details.push(detail);

      const party=r.company_name||r.account_name||'Unknown';
      const warehouse=r.warehouse_name||'Unknown';
      const key=`${party}::${warehouse}`;
      if (!summaryMap.has(key)) summaryMap.set(key,{
        party_name:party,
        company_address:detail.company_address,
        warehouse_name:warehouse,
        gross_qty:0, shortage_qty:0, net_opening_qty:0, already_adjusted_qty:0, available_balance_qty:0,
      });
      const sum=summaryMap.get(key);
      sum.gross_qty += detail.gross_qty;
      sum.shortage_qty += detail.shortage_qty;
      sum.net_opening_qty += detail.net_opening_qty;
      sum.already_adjusted_qty += detail.already_adjusted_qty;
      sum.available_balance_qty += detail.available_balance_qty;
      if (!sum.company_address && detail.company_address) sum.company_address=detail.company_address;
    }
    const summary=Array.from(summaryMap.values()).map(s => ({
      ...s,
      gross_qty:Number(s.gross_qty.toFixed(4)),
      shortage_qty:Number(s.shortage_qty.toFixed(4)),
      net_opening_qty:Number(s.net_opening_qty.toFixed(4)),
      already_adjusted_qty:Number(s.already_adjusted_qty.toFixed(4)),
      available_balance_qty:Number(s.available_balance_qty.toFixed(4)),
      party:s.party_name,
      stock:Number(s.available_balance_qty.toFixed(4)),
    }));
    res.json({ summary, details });
  } catch(e){ console.error('Mongo party stock failed:',e); return next(); }
});

router.get('/warehouse-stock', async (req,res,next) => {
  if (!reportAccess(req,'report.partyStock')) return res.status(403).json({error:'Permission denied'});
  if (!mongoReady()) return next();
  try {
    const [rows, adjMap] = await Promise.all([buildInwardRows(req.query), adjustmentMap()]);
    const map=new Map(); const refDate=dateOnly(req.query.to_date)||new Date().toISOString().slice(0,10);
    rows.forEach(r=>{ const adjusted=(adjMap.get(String(r.legacy_id ?? r.id))||[]).reduce((s,a)=>s+num(a.qty),0); const avail=availableQty(r.weight,r.date,adjusted,r.shortage_percent,refDate); map.set(r.warehouse_name||'Unknown',(map.get(r.warehouse_name||'Unknown')||0)+avail); });
    res.json(Array.from(map,([warehouse,stock])=>({warehouse,stock:Number(stock.toFixed(4))})));
  } catch(e){ console.error('Mongo warehouse stock failed:',e); return next(); }
});

router.get('/total-stock', async (req,res,next) => {
  if (!reportAccess(req,'report.partyStock')) return res.status(403).json({error:'Permission denied'});
  if (!mongoReady()) return next();
  try {
    const [rows, adjMap] = await Promise.all([buildInwardRows(req.query), adjustmentMap()]);
    const refDate=dateOnly(req.query.to_date)||new Date().toISOString().slice(0,10); let total=0;
    rows.forEach(r=>{ const adjusted=(adjMap.get(String(r.legacy_id ?? r.id))||[]).reduce((s,a)=>s+num(a.qty),0); total+=availableQty(r.weight,r.date,adjusted,r.shortage_percent,refDate); });
    res.json({total:Number(total.toFixed(4))});
  } catch(e){ console.error('Mongo total stock failed:',e); return next(); }
});

router.get('/fifo-stock', async (req,res,next) => {
  if (!reportAccess(req,'report.partyStock')) return res.status(403).json({error:'Permission denied'});
  if (!mongoReady()) return next();
  try {
    const productId=String(req.query.product_id||''); if(!productId) return res.status(400).json({error:'product_id is required'});
    const rows=await buildInwardRows({product_id:productId, warehouse_id:req.query.warehouse_id||''}); const adjMap=await adjustmentMap(); const refDate=new Date().toISOString().slice(0,10);
    const batches=rows.map(r=>{const adj=(adjMap.get(String(r.legacy_id ?? r.id))||[]).reduce((s,a)=>s+num(a.qty),0); return {inward_id:r.id,warehouse_id:r.warehouse_id,inward_date:r.date,gross_qty:num(r.weight),already_adjusted:Number(adj.toFixed(4)),available_qty:Number(Math.max(availableQty(r.weight,r.date,adj,r.shortage_percent,refDate),0).toFixed(4))};}).filter(x=>x.available_qty>0);
    const purchases=await PurchaseVoucherOperational.find({ product_id:productId, ...(req.query.warehouse_id?{warehouse_id:String(req.query.warehouse_id)}:{}) }).lean(); const qty=purchases.reduce((s,r)=>s+num(r.quantity),0); const amt=purchases.reduce((s,r)=>s+num(r.quantity)*num(r.rate),0);
    res.json({batches,avg_rate:qty?Number((amt/qty).toFixed(4)):0});
  } catch(e){ console.error('Mongo FIFO stock failed:',e); return next(); }
});

async function handleRentLedger(req,res,next) {
  if (!reportAccess(req,'report.warehouseRentLedger')) return res.status(403).json({error:'Permission denied'});
  if (!mongoReady()) return next();
  try {
    const page=Math.max(parseInt(req.query.page,10)||1,1); const pageSize=Math.min(Math.max(parseInt(req.query.page_size,10)||100,1),500); const usePaging=req.query.page!==undefined||req.query.page_size!==undefined;
    // For date-range ledgers, expand every month between range endpoints.
    let allMonths=[]; const from=req.query.from_date?String(req.query.from_date).slice(0,7):''; const to=req.query.to_date?String(req.query.to_date).slice(0,7):'';
    if(from&&to){ let cur=from; for(let i=0;i<24&&cur<=to;i++,cur=addMonths(cur,1)) allMonths.push(cur); }
    if(!allMonths.length) allMonths=[new Date().toISOString().slice(0,7)];
    const full=await buildRentDetails({monthList:allMonths,filters:req.query}); const total=full.length; const data=usePaging?full.slice((page-1)*pageSize,page*pageSize):full;
    res.json(usePaging?{data,pagination:{page,pageSize,totalCount:total,totalPages:Math.max(1,Math.ceil(total/pageSize)),hasMore:page*pageSize<total}}:data);
  } catch(e){ console.error('Mongo warehouse rent ledger failed:',e); return next(); }
}
router.get('/warehouse-rent-ledger', handleRentLedger);

router.get('/warehouse-rent-month-end', async (req,res,next)=>{
  if(!reportAccess(req,'report.warehouseRentMonthEnd')) return res.status(403).json({error:'Permission denied'});
  if(!mongoReady()) return next();
  try{
    const month=String(req.query.month||new Date().toISOString().slice(0,7));
    const details=await buildRentDetails({monthList:[month],filters:{company_id:req.query.company_id,warehouse_id:req.query.warehouse_id}});
    const map=new Map(); details.forEach(r=>{const k=`${r.month}__${r.party_name}__${r.warehouse_name}`; if(!map.has(k)) map.set(k,{month:r.month,month_label:r.month_label,month_end_date:r.month_end_date,party_name:r.party_name,warehouse_name:r.warehouse_name,total_weight:0,total_rent:0,total_entries:0}); const s=map.get(k); s.total_weight+=num(r.original_weight); s.total_rent+=num(r.rent_amount); s.total_entries+=1;});
    const summary=Array.from(map.values()).map(r=>({...r,total_weight:Number(r.total_weight.toFixed(4)),total_rent:Number(r.total_rent.toFixed(2))}));
    res.json({month,month_label:monthLabel(month),month_end_date:monthEnd(month),summary,details});
  }catch(e){console.error('Mongo warehouse rent month-end failed:',e);return next();}
});

module.exports = router;
