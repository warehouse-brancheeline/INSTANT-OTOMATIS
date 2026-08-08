const orders = require('../jubelio/orders');
const db = require('../db');
const logger = require('../logger');
const printer = require('../printer');

/**
 * Single-step debug triggers - one Jubelio action each, no cascading into the
 * next stage. Unlike the scheduled jobs (picklistJob/printJob/dispatchJob), these
 * ALWAYS require settings.restrict_order_no to be set and only ever touch those
 * specific orders - they exist for manually walking a test order through the
 * pipeline one click at a time, mirroring the tutorial's individual button clicks.
 */
async function requireRestrictedOrders(actionLabel) {
  const targets = await orders.getRestrictedOrders();
  if (targets.length === 0) {
    console.log(`[manualActions] ${actionLabel}: restrict_order_no is empty or matched nothing, refusing to run`);
    return null;
  }
  return targets;
}

/**
 * "Buat Picklist" - Proses Pesanan (if still in Siap Proses) then create a
 * picklist and immediately mark it complete (qty penuh, tanpa verifikasi fisik).
 */
async function runManualPicklist() {
  const targets = await requireRestrictedOrders('picklist');
  if (!targets) return { skipped: true, reason: 'restrict_order_no_empty' };

  // Manual per-step triggers deliberately bypass the Gojek/Grab-only eligibility
  // filter (unlike the scheduled jobs) - they operate on whatever order(s) are in
  // restrict_order_no regardless of courier, so regular-courier test orders (e.g.
  // SPX) can be walked through too. Attempt the move directly rather than
  // pre-checking against the (eligibility-filtered) ready-to-process listing.
  let moved = 0;
  try {
    await orders.moveToReadyToPick(targets.map((t) => t.salesorder_id));
    for (const t of targets) logger.log(t.salesorder_no, 'proses-pesanan', true, 'moved to ready-to-pick');
    moved = targets.length;
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    for (const t of targets) logger.log(t.salesorder_no, 'proses-pesanan', false, detail);
  }

  const salesorderIds = targets.map((t) => t.salesorder_id);
  const employeeId = db.getSetting('employee_id');

  try {
    const pickItems = await orders.getItemsToPick(salesorderIds);
    const items = (pickItems || []).map((i) => ({
      salesorder_detail_id: i.salesorder_detail_id,
      item_id: i.item_id,
      location_id: i.location_id,
      qty_ordered: i.qty_ordered,
      salesorder_id: i.salesorder_id,
      bundle_item_id: i.bundle_item_id,
    }));

    const result = await orders.createAndCompletePicklist({ items, pickerId: employeeId, salesorderIds });
    const picks = (result && result.data && result.data.picks) || [];

    for (const pick of picks) {
      try {
        const printPicklist = db.getSetting('print_picklist_enabled') !== '0';
        let note = `picking auto-diselesaikan (qty penuh, TANPA verifikasi fisik), picker=${employeeId}`;
        if (printPicklist) {
          const label = await orders.getPicklistPdfUrl(pick.picklist_id);
          await printer.printLabelFromUrl(label.url, `picklist-${pick.picklist_id}`);
        } else {
          note += ' (print picklist dinonaktifkan)';
        }
        for (const t of targets) {
          logger.log(t.salesorder_no, 'selesaikan-picking', true, note, pick.picklist_no);
        }
      } catch (err) {
        const detail = err.response ? JSON.stringify(err.response.data) : err.message;
        for (const t of targets) {
          logger.log(t.salesorder_no, 'selesaikan-picking', false, `picking selesai tapi gagal cetak picklist: ${detail}`, pick.picklist_no);
        }
      }
    }
    return { moved, picklistCreated: picks.length > 0, picks };
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    for (const t of targets) logger.log(t.salesorder_no, 'selesaikan-picking', false, detail);
    return { moved, picklistCreated: false, error: detail };
  }
}

/**
 * "Cetak Label Pengiriman" - print the resi for the test order(s) directly,
 * regardless of Jubelio's own isPrinted bookkeeping (a reused test order that's
 * already been printed many times won't show up in the normal isPrinted=1 listing).
 */
async function runManualPrintResi() {
  const targets = await requireRestrictedOrders('print-resi');
  if (!targets) return { skipped: true, reason: 'restrict_order_no_empty' };

  const ids = targets.map((t) => t.salesorder_id);
  try {
    const label = await orders.getShippingLabelUrl(ids);
    await printer.printLabelFromUrl(label.url, ids.join('-'));
    for (const t of targets) {
      db.upsertOrderSeen(t.salesorder_id, t.salesorder_no, t.shipper);
      db.markPrinted(t.salesorder_id, true);
      logger.log(t.salesorder_no, 'print', true, label.title || 'printed');
    }
    return { printed: targets.length };
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    for (const t of targets) logger.log(t.salesorder_no, 'print', false, detail);
    return { printed: 0, error: detail };
  }
}

/**
 * "Siap Kirim" - generates the AWB for the test order(s). Comes after printing
 * the resi, before "Selesaikan", per the tutorial.
 */
async function runManualSiapKirim() {
  const targets = await requireRestrictedOrders('siap-kirim');
  if (!targets) return { skipped: true, reason: 'restrict_order_no_empty' };

  const ids = targets.map((t) => t.salesorder_id);
  try {
    const result = await orders.getAwbForOrder(ids);
    for (const t of targets) logger.log(t.salesorder_no, 'siap-kirim', true, 'AWB dibuat');
    return { done: targets.length, result };
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    for (const t of targets) logger.log(t.salesorder_no, 'siap-kirim', false, detail);
    return { done: 0, error: detail };
  }
}

/**
 * "Selesaikan" - the final checklist+click in the Packing tab (done packing),
 * moving the order into the Shipping queue.
 */
async function runManualSelesaikan() {
  const targets = await requireRestrictedOrders('selesaikan');
  if (!targets) return { skipped: true, reason: 'restrict_order_no_empty' };

  const ids = targets.map((t) => t.salesorder_id);
  try {
    await orders.markAsComplete(ids);
    for (const t of targets) {
      db.upsertOrderSeen(t.salesorder_id, t.salesorder_no, t.shipper);
      db.markPacked(t.salesorder_id, true);
      logger.log(t.salesorder_no, 'selesaikan', true, 'packing selesai');
    }
    return { done: targets.length };
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    for (const t of targets) logger.log(t.salesorder_no, 'selesaikan', false, detail);
    return { done: 0, error: detail };
  }
}

/**
 * "Buat Pengiriman" for a REGULAR courier (not Gojek/Grab instant) - creates a
 * shipment schedule for the order's own courier and attaches it. Confirmed live
 * against a real SPX Instant order: createRegularShipment returns
 * {shipment_number: "SHP-..."} (not a header id), resolved via
 * getShipmentHeaderId before addOrderToShipment.
 */
async function runManualBuatPengiriman() {
  const targets = await requireRestrictedOrders('buat-pengiriman');
  if (!targets) return { skipped: true, reason: 'restrict_order_no_empty' };

  const employeeId = db.getSetting('employee_id');
  const courierList = await orders.getCouriers();

  let done = 0;
  const errors = [];
  for (const t of targets) {
    // Order shipper is often a specific service level (e.g. "SPX Instant") while
    // /wms/couriers only lists the parent courier ("SPX") - match by prefix.
    const shipperName = String(t.shipper || '').toLowerCase();
    const courier = courierList.find((c) => shipperName.startsWith((c.courier_name || '').toLowerCase()));
    if (!courier) {
      const detail = `courier untuk "${t.shipper}" tidak ditemukan di daftar /wms/couriers`;
      logger.log(t.salesorder_no, 'buat-pengiriman', false, detail);
      errors.push(detail);
      continue;
    }
    try {
      const shipment = await orders.createRegularShipment({
        courierNewId: courier.courier_id,
        locationId: t.location_id || -1,
        courierName: courier.courier_name,
        shipmentType: '2',
      });
      const shipmentNo = shipment && shipment.shipment_number;
      if (!shipmentNo) {
        throw new Error(`shipment created but no shipment_number in response: ${JSON.stringify(shipment)}`);
      }
      const shipmentHeaderId = await orders.getShipmentHeaderId(shipmentNo);
      if (!shipmentHeaderId) {
        throw new Error(`created shipment ${shipmentNo} but could not resolve its header id`);
      }
      await orders.addOrderToShipment(shipmentHeaderId, t.salesorder_id, employeeId);
      db.upsertOrderSeen(t.salesorder_id, t.salesorder_no, t.shipper);
      db.markDispatched(t.salesorder_id, true);
      logger.log(t.salesorder_no, 'buat-pengiriman', true, `${shipmentNo}, courier=${courier.courier_name}`);
      done += 1;
    } catch (err) {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      db.upsertOrderSeen(t.salesorder_id, t.salesorder_no, t.shipper);
      db.markDispatched(t.salesorder_id, false);
      logger.log(t.salesorder_no, 'buat-pengiriman', false, detail);
      errors.push(detail);
    }
  }
  return { done, errors };
}

/**
 * "Panggil Driver" - ONLY for instant couriers (Gojek/Grab). Resolves the
 * configured shipper_nik to an employee_id, same as the "Scan ID Shipper" modal.
 */
async function runManualPanggilDriver() {
  const targets = await requireRestrictedOrders('panggil-driver');
  if (!targets) return { skipped: true, reason: 'restrict_order_no_empty' };

  const shipperNik = db.getSetting('shipper_nik');
  if (!shipperNik) return { skipped: true, reason: 'no_shipper_nik' };

  let employeeId;
  try {
    const employee = await orders.resolveEmployee(shipperNik);
    employeeId = employee && employee.employee_id;
    if (!employeeId) throw new Error('resolveEmployee returned no employee_id');
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    return { skipped: true, reason: 'shipper_nik_not_found', detail };
  }

  const ids = targets.map((t) => t.salesorder_id);
  try {
    const result = await orders.requestInstantCourier(ids, employeeId);
    const items = Array.isArray(result) ? result : [];
    const byId = Object.fromEntries(items.map((i) => [i.salesorder_id, i]));

    let dispatched = 0;
    for (const t of targets) {
      const item = byId[t.salesorder_id];
      const success = !!(item && (item.shipment_header_id || item.shipment_no));
      db.upsertOrderSeen(t.salesorder_id, t.salesorder_no, t.shipper);
      db.markDispatched(t.salesorder_id, success);
      logger.log(
        t.salesorder_no,
        'panggil-driver',
        success,
        success ? `shipment_no=${item.shipment_no}` : JSON.stringify(item || 'no response entry')
      );
      if (success) dispatched += 1;
    }
    return { dispatched };
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    for (const t of targets) {
      db.upsertOrderSeen(t.salesorder_id, t.salesorder_no, t.shipper);
      db.markDispatched(t.salesorder_id, false);
      logger.log(t.salesorder_no, 'panggil-driver', false, detail);
    }
    return { dispatched: 0, error: detail };
  }
}

module.exports = {
  runManualPicklist,
  runManualPrintResi,
  runManualSiapKirim,
  runManualSelesaikan,
  runManualBuatPengiriman,
  runManualPanggilDriver,
};
