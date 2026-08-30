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
  if (!v) return '';
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
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

async function masterMaps() {
  const [companies, accounts, warehouses, locations, products, employees, farmers] = await Promise.all([
    CompanyOperational.find({}).lean(),
    CompanyAccountOperational.find({}).lean(),
    WarehouseOperational.find({}).lean(),
    LocationOperational.find({}).lean(),
    ProductOperational.find({}).lean(),
    EmployeeOperational.find({}).lean(),
    FarmerOperational.find({}).lean(),
  ]);
  const makeMap = rows => {
    const m = new Map();
    (rows || []).forEach(r => {
      [r._id, r.id, r.legacy_id].filter(v => v !== undefined && v !== null && v !== '').forEach(v => m.set(String(v), r));
      if (r.name) m.set(`name:${String(r.name).trim().toLowerCase()}`, r);
      if (r.account_name) m.set(`name:${String(r.account_name).trim().toLowerCase()}`, r);
    });
    return m;
  };
  return { companies:makeMap(companies), accounts:makeMap(accounts), warehouses:makeMap(warehouses), locations:makeMap(locations), products:makeMap(products), employees:makeMap(employees), farmers:makeMap(farmers) };
}
function findMaster(map, id, name) { return map.get(String(id || '')) || map.get(`name:${String(name || '').trim().toLowerCase()}`) || null; }
function idsFromQuery(v) { return new Set(String(v || '').split(',').map(s=>s.trim()).filter(Boolean)); }

async function buildInwardRows(filters = {}) {
  const docs = await InwardOperational.find({}).lean();
  const maps = await masterMaps();
  const from = dateOnly(filters.from_date), to = dateOnly(filters.to_date);
  const companyIds = idsFromQuery(filters.company_ids || filters.company_id);
  const warehouseIds = idsFromQuery(filters.warehouse_ids || filters.warehouse_id);
  const locationIds = idsFromQuery(filters.location_ids || filters.location_id);
  const productId = String(filters.product_id || '');
  const employeeId = String(filters.employee_id || '');
  return docs.filter(r => {
    const d = dateOnly(r.date);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (companyIds.size && !companyIds.has(String(r.company_id || ''))) return false;
    if (warehouseIds.size && !warehouseIds.has(String(r.warehouse_id || ''))) return false;
    if (locationIds.size && !locationIds.has(String(r.location_id || ''))) return false;
    if (productId && String(r.product_id || '') !== productId) return false;
    if (employeeId && String(r.employee_id || '') !== employeeId) return false;
    return true;
  }).map(r => {
    const c = findMaster(maps.companies, r.company_id, r.company_name || r.company);
    const a = findMaster(maps.accounts, r.company_account_id, r.company_account_name || r.company_account);
    const w = findMaster(maps.warehouses, r.warehouse_id, r.warehouse_name);
    const l = findMaster(maps.locations, r.location_id, r.location_name || r.location);
    const p = findMaster(maps.products, r.product_id, r.product_name || r.product);
    const e = findMaster(maps.employees, r.employee_id, r.employee_name);
    return { ...r, id:String(r.legacy_id ?? r.id ?? r._id), legacy_id:r.legacy_id ?? r.id, company_name:c?.name || r.company_name || r.company || '', account_name:a?.account_name || a?.name || r.company_account_name || '', warehouse_name:w?.name || r.warehouse_name || '', location_name:l?.name || r.location_name || r.location || '', product_name:p?.name || r.product_name || r.product || '', employee_name:e?.name || r.employee_name || '', date:dateOnly(r.date) };
  });
}

async function adjustmentMap() {
  const rows = await AdjustmentOperational.find({}).lean();
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
    const [rows, adjMap] = await Promise.all([buildInwardRows(req.query), adjustmentMap()]);
    const summaryMap=new Map(); const details=[]; const refDate=dateOnly(req.query.to_date)||new Date().toISOString().slice(0,10);
    for (const r of rows) {
      const adjusted=(adjMap.get(String(r.legacy_id ?? r.id))||[]).reduce((s,a)=>s+num(a.qty),0);
      const avail=availableQty(r.weight,r.date,adjusted,r.shortage_percent,refDate);
      const detail={...r,gross_qty:num(r.weight),shortage_qty:Math.max(0,num(r.weight)-avail-adjusted),net_opening_qty:num(r.weight)-Math.max(0,num(r.weight)-avail-adjusted),already_adjusted_qty:adjusted,available_balance_qty:avail,date:r.date};
      details.push(detail);
      const key=r.company_name||r.account_name||'Unknown';
      summaryMap.set(key,(summaryMap.get(key)||0)+avail);
    }
    res.json({ summary:Array.from(summaryMap,([party,stock])=>({party,stock:Number(stock.toFixed(4)),party_name:party,available_balance_qty:Number(stock.toFixed(4))})), details });
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
    const details=await buildRentDetails({monthList:[...new Set([String(req.query.from_date||'').slice(0,7), String(req.query.to_date||'').slice(0,7)])].filter(Boolean), filters:req.query});
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
