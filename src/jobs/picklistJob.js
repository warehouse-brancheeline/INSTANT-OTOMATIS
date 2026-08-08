const orders = require('../jubelio/orders');
const db = require('../db');
const logger = require('../logger');
const printer = require('../printer');
const { printBatch } = require('./printJob');

/**
 * Moves instant orders from "Siap Proses" into Gudang's queue, creates a picklist,
 * and immediately marks it complete (qty_picked = qty_ordered for every item) -
 * then immediately prints the resi and marks packing complete ("Siap Kirim") for
 * the same orders, without waiting for the hourly :00/:15 jobs.
 *
 * IMPORTANT: "selesaikan-picking" here does NOT reflect any real physical check -
 * it claims every item was picked in full with no scan/count verification. This
 * was an explicit choice by the business owner to fully automate the pipeline;
 * every such action is logged clearly as automatic/unverified for audit purposes.
 * Instant-courier dispatch (calling the driver) is deliberately NOT done here -
 * that stays on its own :15 schedule as originally designed.
 */
async function runPicklistJob() {
  let moved = 0;
  let picklistsCreated = 0;
  let failed = 0;
  let printed = 0;
  let packed = 0;

  const readyToProcess = await orders.getReadyToProcessInstantOrders();
  if (readyToProcess.length > 0) {
    const ids = readyToProcess.map((o) => o.salesorder_id);
    try {
      await orders.moveToReadyToPick(ids);
      moved = ids.length;
      for (const o of readyToProcess) {
        logger.log(o.salesorder_no, 'proses-pesanan', true, 'moved to ready-to-pick');
      }
    } catch (err) {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      for (const o of readyToProcess) {
        logger.log(o.salesorder_no, 'proses-pesanan', false, detail);
      }
    }
  }

  const readyToPick = await orders.getReadyToPickInstantOrders();
  if (readyToPick.length === 0) {
    console.log(`[picklistJob] moved=${moved}, no orders ready to pick for picklist creation`);
    return { moved, picklistsCreated: 0, failed: 0, printed: 0, packed: 0 };
  }

  const salesorderIds = readyToPick.map((o) => o.salesorder_id);
  const byId = Object.fromEntries(readyToPick.map((o) => [o.salesorder_id, o]));
  const employeeId = db.getSetting('employee_id');

  // Orders whose picking finished this cycle - candidates to print + pack immediately.
  const completedOrders = [];

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

    const result = await orders.createAndCompletePicklist({
      items,
      pickerId: employeeId,
      salesorderIds,
    });

    const picks = (result && result.data && result.data.picks) || [];
    const ordersByPicklist =
      picks.length > 0
        ? await orders.getPicklistOrderDetails(picks.map((p) => p.picklist_id))
        : {};

    for (const pick of picks) {
      const ordersInPicklist = ordersByPicklist[pick.picklist_id] || [];
      const logTargets =
        ordersInPicklist.length > 0
          ? ordersInPicklist
          : [{ salesorder_no: pick.picklist_no, salesorder_id: null }];

      try {
        const printPicklist = db.getSetting('print_picklist_enabled') !== '0';
        let note = `picking auto-diselesaikan (qty penuh, TANPA verifikasi fisik), picker=${employeeId}`;
        if (printPicklist) {
          const label = await orders.getPicklistPdfUrl(pick.picklist_id);
          await printer.printLabelFromUrl(label.url, `picklist-${pick.picklist_id}`);
        } else {
          note += ' (print picklist dinonaktifkan)';
        }
        for (const o of logTargets) {
          logger.log(o.salesorder_no, 'selesaikan-picking', true, note, pick.picklist_no);
        }
        picklistsCreated += 1;
      } catch (err) {
        const detail = err.response ? JSON.stringify(err.response.data) : err.message;
        for (const o of logTargets) {
          logger.log(
            o.salesorder_no,
            'selesaikan-picking',
            false,
            `picking diselesaikan di Jubelio tapi gagal cetak picklist: ${detail}`,
            pick.picklist_no
          );
        }
        failed += 1;
      }

      // Regardless of whether the picklist itself printed, picking is already
      // complete on Jubelio's side once createAndCompletePicklist succeeded -
      // still eligible to move on to printing the resi and packing.
      for (const o of ordersInPicklist) {
        const seen = byId[o.salesorder_id];
        completedOrders.push({
          salesorder_id: o.salesorder_id,
          salesorder_no: o.salesorder_no,
          picklist_no: pick.picklist_no,
          shipper: seen ? seen.shipper : undefined,
        });
      }
    }

    const invalidSO = (result && result.data && result.data.invalidSO) || [];
    for (const invalid of invalidSO) {
      const o = byId[invalid.salesorder_id || invalid];
      logger.log(o ? o.salesorder_no : String(invalid), 'selesaikan-picking', false, 'invalid salesorder, dilewati');
      failed += 1;
    }
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    for (const o of readyToPick) {
      logger.log(o.salesorder_no, 'selesaikan-picking', false, detail);
    }
    failed += readyToPick.length;
  }

  if (completedOrders.length > 0) {
    for (const o of completedOrders) {
      db.upsertOrderSeen(o.salesorder_id, o.salesorder_no, o.shipper);
    }

    const printResult = await printBatch(completedOrders, 'print');
    printed = printResult.succeededIds.length;

    const packOrders = completedOrders.filter((o) => printResult.succeededIds.includes(o.salesorder_id));
    if (packOrders.length > 0) {
      const packIds = packOrders.map((o) => o.salesorder_id);
      try {
        await orders.markAsComplete(packIds);
        for (const o of packOrders) {
          db.markPacked(o.salesorder_id, true);
          logger.log(o.salesorder_no, 'mark-complete', true, 'siap kirim', o.picklist_no);
        }
        packed = packOrders.length;
      } catch (err) {
        const detail = err.response ? JSON.stringify(err.response.data) : err.message;
        for (const o of packOrders) {
          db.markPacked(o.salesorder_id, false);
          logger.log(o.salesorder_no, 'mark-complete', false, detail, o.picklist_no);
        }
      }
    }
  }

  return { moved, picklistsCreated, failed, printed, packed };
}

module.exports = { runPicklistJob };
