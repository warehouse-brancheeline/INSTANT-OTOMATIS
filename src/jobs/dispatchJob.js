const orders = require('../jubelio/orders');
const db = require('../db');
const logger = require('../logger');

/**
 * Dispatches the courier for any order whose resi was printed at least
 * dispatch_delay_minutes ago and hasn't been dispatched yet - measured per
 * order from its own print time, not against a fixed clock slot. Meant to run
 * frequently (every few minutes; see scheduler.js) so each order gets picked
 * up close to its own N-minute mark instead of waiting for a fixed hour.
 *
 * Branches by courier:
 *  - Gojek/Grab -> "Panggil Driver" (instant courier request)
 *  - any other "instant"-branded courier (SPX Instant, or any other provider's
 *    own instant/sameday service) -> "Siap Kirim" (getAwbForOrder) ONLY -
 *    generating the AWB already triggers that provider's own courier pickup,
 *    no separate "Buat Pengiriman" needed
 *  - everyone else (not "instant"-branded at all) -> "Buat Pengiriman"
 */
async function runDispatchJob() {
  const delayMinutes = Number(db.getSetting('dispatch_delay_minutes')) || 30;
  const rawCandidates = db.getOrdersReadyForDispatch(delayMinutes);

  // SAFETY: getOrdersReadyForDispatch reads local DB state that can predate the
  // current restrict_order_no value (e.g. an order seen before restriction was
  // set, or before it was narrowed to a different order) - re-check current
  // restriction here too, not just at the time each order was first seen/printed,
  // or a stale local row can slip a real dispatch action through unrestricted.
  const skippedByRestriction = rawCandidates.filter((o) => !orders.matchesRestriction(o));
  for (const o of skippedByRestriction) {
    console.log(`[dispatchJob] skipping ${o.salesorder_no} - outside current restrict_order_no`);
  }
  const candidates = rawCandidates.filter((o) => orders.matchesRestriction(o));

  if (candidates.length === 0) {
    console.log(`[dispatchJob] no orders printed >= ${delayMinutes}m ago awaiting dispatch`);
    return { dispatched: 0, failed: 0 };
  }

  // picklistJob normally marks packing complete right after printing, but an
  // order printed via printJob's straggler fallback may not have gone through
  // that step yet - do it now before dispatching.
  const needsPack = candidates.filter((o) => o.pack_success !== 1);
  for (const o of needsPack) {
    try {
      await orders.markAsComplete([o.salesorder_id]);
      db.markPacked(o.salesorder_id, true);
      logger.log(o.salesorder_no, 'mark-complete', true, 'siap kirim (late)');
    } catch (err) {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      db.markPacked(o.salesorder_id, false);
      logger.log(o.salesorder_no, 'mark-complete', false, detail);
    }
  }

  const gojekGrab = candidates.filter((o) => orders.isGojekGrabShipper(o.shipper));
  const otherInstant = candidates.filter((o) => orders.isOtherInstantShipper(o.shipper));
  const regular = candidates.filter(
    (o) => !orders.isGojekGrabShipper(o.shipper) && !orders.isOtherInstantShipper(o.shipper)
  );

  const a = gojekGrab.length > 0 ? await dispatchGojekGrab(gojekGrab) : { dispatched: 0, failed: 0 };
  const b = otherInstant.length > 0 ? await dispatchOtherInstant(otherInstant) : { dispatched: 0, failed: 0 };
  const c = regular.length > 0 ? await dispatchRegular(regular) : { dispatched: 0, failed: 0 };

  return {
    dispatched: a.dispatched + b.dispatched + c.dispatched,
    failed: a.failed + b.failed + c.failed,
  };
}

/** "Panggil Driver" - Gojek/Grab instant courier. */
async function dispatchGojekGrab(targets) {
  const shipperNik = db.getSetting('shipper_nik');
  if (!shipperNik) {
    console.error('[dispatchJob] no shipper_nik configured, skipping Gojek/Grab orders');
    return { dispatched: 0, failed: 0 };
  }

  let employeeId;
  try {
    const employee = await orders.resolveEmployee(shipperNik);
    employeeId = employee && employee.employee_id;
    if (!employeeId) throw new Error('resolveEmployee returned no employee_id');
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error(`[dispatchJob] failed to resolve shipper_nik "${shipperNik}": ${detail}`);
    for (const o of targets) logger.log(o.salesorder_no, 'panggil-driver', false, detail);
    return { dispatched: 0, failed: targets.length };
  }

  const ids = targets.map((o) => o.salesorder_id);

  try {
    const result = await orders.requestInstantCourier(ids, employeeId);
    const items = Array.isArray(result) ? result : [];
    const byResultId = Object.fromEntries(items.map((i) => [i.salesorder_id, i]));

    let dispatched = 0;
    let failed = 0;
    for (const o of targets) {
      const item = byResultId[o.salesorder_id];
      const success = !!(item && (item.shipment_header_id || item.shipment_no));
      db.markDispatched(o.salesorder_id, success);
      logger.log(
        o.salesorder_no,
        'panggil-driver',
        success,
        success ? `shipment_no=${item.shipment_no}` : JSON.stringify(item || 'no response entry')
      );
      if (success) dispatched += 1;
      else failed += 1;
    }
    return { dispatched, failed };
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    for (const o of targets) {
      db.markDispatched(o.salesorder_id, false);
      logger.log(o.salesorder_no, 'panggil-driver', false, detail);
    }
    return { dispatched: 0, failed: targets.length };
  }
}

/**
 * "Siap Kirim" (AWB generation) for any "instant"-branded courier other than
 * Gojek/Grab (SPX Instant, or any other provider's own instant/sameday
 * service) - this alone triggers that provider's own courier pickup, so no
 * separate "Buat Pengiriman" call is made.
 */
async function dispatchOtherInstant(targets) {
  const ids = targets.map((o) => o.salesorder_id);

  try {
    const result = await orders.getAwbForOrder(ids);
    const items = Array.isArray(result) ? result : [];
    const byResultId = Object.fromEntries(items.map((i) => [i.salesorder_id, i]));

    let dispatched = 0;
    let failed = 0;
    for (const o of targets) {
      const item = byResultId[o.salesorder_id];
      const success = !!(item && item.shipment_no);
      db.markDispatched(o.salesorder_id, success);
      logger.log(
        o.salesorder_no,
        'siap-kirim',
        success,
        success
          ? `AWB dibuat, shipment_no=${item.shipment_no}`
          : `AWB gagal/tidak dapat tracking: ${JSON.stringify(item || 'no response entry')}`
      );
      if (success) dispatched += 1;
      else failed += 1;
    }
    return { dispatched, failed };
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    for (const o of targets) {
      db.markDispatched(o.salesorder_id, false);
      logger.log(o.salesorder_no, 'siap-kirim', false, detail);
    }
    return { dispatched: 0, failed: targets.length };
  }
}

/** "Buat Pengiriman" - regular (non-Gojek/Grab) courier shipment schedule. */
async function dispatchRegular(targets) {
  const employeeId = db.getSetting('employee_id');
  const courierList = await orders.getCouriers();

  let dispatched = 0;
  let failed = 0;
  for (const o of targets) {
    const shipperName = String(o.shipper || '').toLowerCase();
    const courier = courierList.find((c) => shipperName.startsWith((c.courier_name || '').toLowerCase()));
    if (!courier) {
      const detail = `courier untuk "${o.shipper}" tidak ditemukan di daftar /wms/couriers`;
      db.markDispatched(o.salesorder_id, false);
      logger.log(o.salesorder_no, 'buat-pengiriman', false, detail);
      failed += 1;
      continue;
    }
    try {
      const shipment = await orders.createRegularShipment({
        courierNewId: courier.courier_id,
        locationId: -1,
        courierName: courier.courier_name,
        shipmentType: '2',
      });
      const shipmentNo = shipment && shipment.shipment_number;
      if (!shipmentNo) throw new Error(`no shipment_number in response: ${JSON.stringify(shipment)}`);
      const shipmentHeaderId = await orders.getShipmentHeaderId(shipmentNo);
      if (!shipmentHeaderId) throw new Error(`could not resolve header id for ${shipmentNo}`);
      await orders.addOrderToShipment(shipmentHeaderId, o.salesorder_id, employeeId);
      db.markDispatched(o.salesorder_id, true);
      logger.log(o.salesorder_no, 'buat-pengiriman', true, `${shipmentNo}, courier=${courier.courier_name}`);
      dispatched += 1;
    } catch (err) {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      db.markDispatched(o.salesorder_id, false);
      logger.log(o.salesorder_no, 'buat-pengiriman', false, detail);
      failed += 1;
    }
  }
  return { dispatched, failed };
}

module.exports = { runDispatchJob };
