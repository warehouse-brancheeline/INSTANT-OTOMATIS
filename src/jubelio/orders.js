const client = require('./client');
const db = require('../db');

/**
 * Paginates a GET list endpoint (shape { data: [...], totalCount }) until fully fetched.
 */
async function fetchAllPages(path, baseParams) {
  const pageSize = 100;
  let page = 1;
  let all = [];

  while (true) {
    const res = await client.get(path, { ...baseParams, page, pageSize });
    const data = res.data || [];
    all = all.concat(data);

    const totalCount = res.totalCount || 0;
    if (all.length >= totalCount || data.length === 0) break;
    page += 1;
  }

  return all;
}

// Two separate concerns that used to be conflated into one regex:
//
// 1. PIPELINE ELIGIBILITY (isInstant/isEligible below): should this order go
//    through the automated picklist->print->pack pipeline at all? Scoped to
//    "instant"-type couriers only (same-day, time-sensitive) - any courier
//    branded "instant" qualifies, Gojek/Grab or otherwise. Genuinely regular
//    couriers (SPX Hemat/Standard, J&T Reg, etc.) are deliberately left out.
//
// 2. DISPATCH ACTION ROUTING (isGojekGrabShipper/isOtherInstantShipper): once
//    an order IS in the pipeline, which specific action does the 30-min-later
//    dispatch step take?
//     - Gojek/Grab -> "Panggil Driver" (separate explicit courier request call)
//     - any OTHER "instant"-branded courier (SPX Instant, and any other
//       provider's own instant/sameday service) -> "Siap Kirim" only -
//       generating the AWB alone already triggers that provider's own courier
//       pickup, confirmed live for SPX and expected to hold for others branded
//       the same way
//     - anything not "instant"-branded at all -> "Buat Pengiriman"
//
// `is_instant_courier` turns out to be unreliable in practice (empirically
// false on a real live "Gosend Instant" order), so match on the shipper name
// as the primary signal, with the boolean flag as a belt-and-suspenders fallback.
const GOJEK_GRAB_PATTERN = /gojek|gosend|grab/i;
const INSTANT_WORD_PATTERN = /instant|sameday|same day/i;

function isGojekGrabShipper(shipper) {
  return GOJEK_GRAB_PATTERN.test(shipper || '');
}

/** Any "instant"-branded courier that ISN'T Gojek/Grab - SPX Instant, or any other provider's own instant/sameday service. */
function isOtherInstantShipper(shipper) {
  return !isGojekGrabShipper(shipper) && INSTANT_WORD_PATTERN.test(shipper || '');
}

function isInstantShipper(shipper) {
  return isGojekGrabShipper(shipper) || isOtherInstantShipper(shipper);
}

const isInstant = (o) => o.is_instant_courier === true || isInstantShipper(o.shipper);

/**
 * When settings.restrict_order_no is set (comma-separated salesorder_no list),
 * every job ignores all other live instant orders and only touches these - lets
 * trial-and-error testing happen against real orders without sweeping up
 * unrelated live customer orders.
 */
function matchesRestriction(o) {
  const raw = db.getSetting('restrict_order_no');
  if (!raw || !raw.trim()) return true;
  const allowed = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return allowed.includes(String(o.salesorder_no || '').toUpperCase());
}

/**
 * When settings.exclude_order_no is set (comma-separated salesorder_no list),
 * every job always skips these specific orders regardless of anything else -
 * a manual blacklist for orders known to be broken (cancelled on the
 * marketplace side, etc.) that should never be touched by automation.
 */
function matchesExclusion(o) {
  const raw = db.getSetting('exclude_order_no');
  if (!raw || !raw.trim()) return false;
  const excluded = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return excluded.includes(String(o.salesorder_no || '').toUpperCase());
}

const isEligible = (o) => isInstant(o) && matchesRestriction(o) && !matchesExclusion(o);

/**
 * Orders sitting in "Siap Proses" (Penjualan tab), filtered to instant-courier orders only.
 */
async function getReadyToProcessInstantOrders() {
  const all = await fetchAllPages('/wms/sales/orders/ready-to-process/');
  return all.filter(isEligible);
}

/**
 * Moves orders from "Siap Proses" into the Gudang "ready to pick" queue.
 * This is the "Proses Pesanan" button action.
 */
async function moveToReadyToPick(salesorderIds) {
  return client.post('/wms/sales/ready-to-pick', { salesorder_ids: salesorderIds });
}

/**
 * Orders sitting in Gudang's "ready to pick" queue (finished moving from Siap Proses,
 * no picklist created yet), filtered to instant-courier orders only.
 */
async function getReadyToPickInstantOrders() {
  const all = await fetchAllPages('/wms/sales/orders/ready-to-pick/');
  return all.filter(isEligible);
}

/**
 * Item-level detail (SKU, qty, location, bundle info) needed to build a picklist
 * for the given salesorder ids.
 */
async function getItemsToPick(salesorderIds) {
  return client.post('/sales/picklists/items-to-pick/', { ids: salesorderIds });
}

/**
 * Creates a DRAFT picklist (is_completed: false) assigning the given items/orders
 * to a picker. This does NOT claim any physical picking has happened - it only
 * generates the work order for staff to act on. Returns { status, data: { picks: [...] } }.
 */
async function createDraftPicklist({ items, pickerId, salesorderIds }) {
  return client.post('/wms/sales/picklists/', {
    picklist_id: 0,
    picklist_no: '[auto]',
    is_completed: false,
    items,
    picker_id: pickerId,
    salesorderIds,
    is_warehouse: true,
  });
}

/**
 * Creates a picklist AND immediately marks it complete, setting qty_picked equal
 * to qty_ordered for every item - i.e. it claims full picking happened without any
 * real physical scan/count. This is an explicit operator choice (confirmed with
 * the business owner) to fully automate the instant-order pipeline; there is no
 * technical verification that the items were actually retrieved.
 */
async function createAndCompletePicklist({ items, pickerId, salesorderIds }) {
  return client.post('/wms/sales/picklists/', {
    picklist_id: 0,
    picklist_no: '[auto]',
    is_completed: true,
    is_warehouse: true,
    merge_location: false,
    picker_id: pickerId,
    salesorderIds,
    items: items.map((i) => ({ ...i, qty_picked: i.qty_ordered })),
  });
}

/**
 * Generates/fetches the printable picklist PDF url for a given picklist id.
 */
async function getPicklistPdfUrl(picklistId) {
  return client.get('/reports/wms/pick-list/', { 'ids[0]': picklistId });
}

/**
 * Maps picklist_id -> the orders (salesorder_id, salesorder_no) it contains, by
 * scanning the "orders on picking process" listing. Used right after creating a
 * picklist to log each individual order under the right picklist for grouping,
 * since the create-picklist response itself only returns picklist ids/numbers.
 */
async function getPicklistOrderDetails(picklistIds) {
  const idSet = new Set(picklistIds.map(String));
  const all = await fetchAllPages('/wms/sales/picklists/confirm-pick/');
  const map = {};
  for (const row of all) {
    if (!idSet.has(String(row.picklist_id))) continue;
    if (!map[row.picklist_id]) map[row.picklist_id] = [];
    map[row.picklist_id].push({
      salesorder_id: row.salesorder_id,
      salesorder_no: row.salesorder_no,
    });
  }
  return map;
}

/**
 * Orders that finished picking and are awaiting a printed shipping label
 * (Jubelio's "Packing - Belum Mulai" tab), filtered to instant-courier orders only.
 *
 * - isPrinted=1 -> label not yet printed (excludes historical/already-shipped orders,
 *   which this endpoint otherwise includes going back a long way).
 * - is_instant_courier is an explicit boolean field on each order, more reliable
 *   than pattern-matching the shipper name.
 */
async function getPackedInstantOrders() {
  const all = await fetchAllPages('/wms/sales/orders/finish-pick/', { isPrinted: '1' });
  return all.filter(isEligible);
}

/**
 * Generates/fetches the printable shipping label (resi) PDF url for the given order ids.
 */
async function getShippingLabelUrl(ids) {
  const res = await client.get('/reports/shipping-label/', { 'ids[]': ids });
  return res; // { status, url, title }
}

/**
 * Marks orders as "Selesaikan" (done packing) - the final checkbox+click in the
 * Packing tab, done AFTER "Siap Kirim" (getAwbForOrder) per the tutorial flow.
 */
async function markAsComplete(ids) {
  return client.post('/wms/sales/packlist/mark-as-complete/', { ids });
}

/**
 * "Siap Kirim" - generates/fetches the AWB (Airway Bill) for the given orders.
 * This is the click right after printing the resi, before "Selesaikan".
 */
async function getAwbForOrder(ids) {
  return client.post('/wms/sales/shipments/orders/', { ids });
}

/**
 * Resolves the current restrict_order_no setting (comma-separated salesorder_no
 * list) into full order records via search. Used by the single-action debug
 * triggers so each one operates only on the designated test order(s), never
 * sweeping in live customer orders regardless of what stage they're in.
 */
async function getRestrictedOrders() {
  const raw = db.getSetting('restrict_order_no');
  if (!raw || !raw.trim()) return [];
  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);

  const found = [];
  for (const no of wanted) {
    const res = await client.get('/sales/orders/', { page: 1, pageSize: 5, q: no });
    const match = (res.data || []).find(
      (o) => String(o.salesorder_no).toUpperCase() === no.toUpperCase()
    );
    if (match) {
      found.push({
        salesorder_id: match.salesorder_id,
        salesorder_no: match.salesorder_no,
        shipper: match.shipper,
      });
    }
  }
  return found;
}

/**
 * Courier list ({courier_id, courier_name} per entry) - needed to create a
 * regular (non-instant) shipment schedule, which identifies the courier by
 * courier_id (passed as courier_new_id in the create-shipment call).
 */
async function getCouriers() {
  const res = await client.get('/wms/couriers');
  return Array.isArray(res) ? res : res.data || [];
}

/**
 * Creates a shipment schedule for a REGULAR (non-instant, i.e. not Gojek/Grab)
 * courier - "Buat Pengiriman" in the Shipping tab for ordinary couriers. Unlike
 * the instant-courier endpoint, this only creates the shipment header; orders
 * must be attached separately via addOrderToShipment.
 *
 * Confirmed live: response is actually {shipment_number: "SHP-000031157"} (NOT
 * {status} as documented, and no shipment_header_id) - use getShipmentHeaderId
 * to resolve the number to the header id addOrderToShipment needs.
 */
async function createRegularShipment({ courierNewId, locationId, courierName, shipmentType }) {
  return client.post('/wms/shipments/', {
    courier_new_id: courierNewId,
    location_id: locationId,
    shipment_type: shipmentType,
    shipment_header_id: 0,
    shipment_no: '[auto]',
    courier_name: courierName,
    shipment_date: new Date().toISOString(),
  });
}

/**
 * Resolves a shipment_no (e.g. "SHP-000031157") to its shipment_header_id by
 * searching the shipments listing - needed right after createRegularShipment,
 * which doesn't return the header id directly.
 */
async function getShipmentHeaderId(shipmentNo) {
  const res = await client.get('/wms/sales/shipments/all', { page: 1, pageSize: 5, q: shipmentNo });
  for (const day of res.data || []) {
    const match = (day.shipments || []).find((s) => s.shipment_no === shipmentNo);
    if (match) return match.shipment_header_id;
  }
  return null;
}

/**
 * Attaches an order to a shipment schedule created by createRegularShipment.
 */
async function addOrderToShipment(shipmentHeaderId, salesorderId, employeeId) {
  return client.post('/wms/shipment-detail/', {
    shipment_header_id: shipmentHeaderId,
    salesorder_id: salesorderId,
    employee_id: employeeId,
  });
}

/**
 * Resolves a NIK or email to the employee record (name, nik, employee_id/email).
 * Mirrors the "Scan ID Shipper" box in Jubelio's Panggil Driver modal - you type a
 * NIK (e.g. "Admin-MP") or email, it resolves to a display name before submitting.
 */
async function resolveEmployee(nikOrEmail) {
  return client.get(`/wms/employee/${encodeURIComponent(nikOrEmail)}`);
}

/**
 * Requests an instant courier (driver) for the given orders. This is the action
 * that actually dispatches the request to the marketplace's instant-courier network.
 * `employeeId` should be the resolved employee_id (email) - see resolveEmployee -
 * matching what the "Panggil Driver" modal actually submits after resolving the
 * NIK/email you scan/type in.
 */
async function requestInstantCourier(ids, employeeId) {
  return client.post('/wms/shipments/instant-courier/', {
    ids,
    employee_id: employeeId,
  });
}

module.exports = {
  isGojekGrabShipper,
  isOtherInstantShipper,
  isInstantShipper,
  matchesRestriction,
  matchesExclusion,
  getReadyToProcessInstantOrders,
  moveToReadyToPick,
  getReadyToPickInstantOrders,
  getItemsToPick,
  createDraftPicklist,
  createAndCompletePicklist,
  getPicklistPdfUrl,
  getPicklistOrderDetails,
  getPackedInstantOrders,
  getShippingLabelUrl,
  markAsComplete,
  getAwbForOrder,
  getRestrictedOrders,
  getCouriers,
  createRegularShipment,
  getShipmentHeaderId,
  addOrderToShipment,
  resolveEmployee,
  requestInstantCourier,
};
