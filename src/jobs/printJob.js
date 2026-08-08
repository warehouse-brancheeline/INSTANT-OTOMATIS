const orders = require('../jubelio/orders');
const printer = require('../printer');
const db = require('../db');
const logger = require('../logger');

/**
 * Prints one combined shipping-label PDF for a batch of orders (Jubelio generates
 * a single PDF covering all requested ids, mirroring the manual "checklist multiple
 * orders -> Cetak Label Pengiriman" flow) and records the outcome per order.
 *
 * @param {Array<{salesorder_id:number, salesorder_no:string}>} batch
 * @param {string} actionLabel - log action name, e.g. "print" or "print (late entrant)"
 */
async function printBatch(batch, actionLabel = 'print') {
  if (batch.length === 0) return { succeededIds: [], failedIds: [] };

  const ids = batch.map((o) => o.salesorder_id);

  try {
    const label = await orders.getShippingLabelUrl(ids);
    await printer.printLabelFromUrl(label.url, ids.join('-'));

    for (const o of batch) {
      db.markPrinted(o.salesorder_id, true);
      logger.log(o.salesorder_no, actionLabel, true, label.title || 'printed', o.picklist_no);
    }
    return { succeededIds: ids, failedIds: [] };
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    for (const o of batch) {
      db.markPrinted(o.salesorder_id, false);
      logger.log(o.salesorder_no, actionLabel, false, detail, o.picklist_no);
    }
    return { succeededIds: [], failedIds: ids };
  }
}

/**
 * The :00 job — print labels for all packed instant orders not yet printed.
 * Note: does NOT check the feature_enabled toggle itself, so the manual "Trigger
 * Print Now" debug button always works. The toggle only gates the cron schedule
 * (see scheduler.js).
 */
async function runPrintJob() {
  const packed = await orders.getPackedInstantOrders();
  for (const o of packed) {
    db.upsertOrderSeen(o.salesorder_id, o.salesorder_no, o.shipper);
  }

  const unprinted = packed.filter((o) => {
    const row = db.getProcessedOrder(o.salesorder_id);
    return !row || row.print_success !== 1;
  });

  if (unprinted.length === 0) {
    console.log(`[printJob] no orders to print (${packed.length} instant orders currently packed)`);
    return { printed: 0 };
  }

  const result = await printBatch(unprinted, 'print');
  return { printed: result.succeededIds.length, failed: result.failedIds.length };
}

module.exports = { runPrintJob, printBatch };
