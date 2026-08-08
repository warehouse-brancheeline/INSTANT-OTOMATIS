const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '..', 'web-instant.db');

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS processed_orders (
    salesorder_id INTEGER PRIMARY KEY,
    salesorder_no TEXT,
    shipper TEXT,
    printed_at TEXT,
    print_success INTEGER DEFAULT 0,
    packed_at TEXT,
    pack_success INTEGER DEFAULT 0,
    dispatched_at TEXT,
    dispatch_success INTEGER DEFAULT 0,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    salesorder_no TEXT,
    picklist_no TEXT,
    action TEXT NOT NULL,
    success INTEGER NOT NULL,
    detail TEXT
  );
`);

// Migrations for databases created before these columns existed.
for (const stmt of [
  'ALTER TABLE activity_log ADD COLUMN picklist_no TEXT',
  'ALTER TABLE processed_orders ADD COLUMN packed_at TEXT',
  'ALTER TABLE processed_orders ADD COLUMN pack_success INTEGER DEFAULT 0',
]) {
  try {
    db.exec(stmt);
  } catch (err) {
    // already exists - fine
  }
}

const DEFAULT_SETTINGS = {
  feature_enabled: '0',
  // Picker assigned to auto-created picklists (accepts email directly).
  employee_id: 'headwarehouse.brancheeline@gmail.com',
  // "Scan ID Shipper" in Jubelio's Panggil Driver modal - a NIK or email, resolved
  // via /wms/employee/{id} before requesting the instant courier. Different from
  // employee_id above (that one's for the picker, this one's for the shipper/admin
  // that requests the driver).
  shipper_nik: 'Admin-MP',
  // Whether creating/completing a picklist also prints its PDF to the printer.
  print_picklist_enabled: '1',
  // Minutes to wait after an order's resi is printed before requesting the
  // courier/driver for it - measured per order, not against a fixed clock time.
  dispatch_delay_minutes: '30',
  debug_interval_minutes: '',
  // Comma-separated salesorder_no list. When non-empty, every job (picklist,
  // print, dispatch) ignores every other live instant order and only touches
  // these - for safely trial-and-error testing against real orders.
  restrict_order_no: '',
};

function seedDefaults() {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insert.run(key, value);
  }
}
seedDefaults();

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

function getProcessedOrder(salesorderId) {
  return db
    .prepare('SELECT * FROM processed_orders WHERE salesorder_id = ?')
    .get(salesorderId);
}

function upsertOrderSeen(salesorderId, salesorderNo, shipper) {
  db.prepare(
    `INSERT INTO processed_orders (salesorder_id, salesorder_no, shipper, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(salesorder_id) DO UPDATE SET
       salesorder_no = excluded.salesorder_no,
       shipper = excluded.shipper,
       updated_at = datetime('now')`
  ).run(salesorderId, salesorderNo, shipper);
}

function markPrinted(salesorderId, success) {
  db.prepare(
    `UPDATE processed_orders
     SET printed_at = datetime('now'), print_success = ?, updated_at = datetime('now')
     WHERE salesorder_id = ?`
  ).run(success ? 1 : 0, salesorderId);
}

function markPacked(salesorderId, success) {
  db.prepare(
    `UPDATE processed_orders
     SET packed_at = datetime('now'), pack_success = ?, updated_at = datetime('now')
     WHERE salesorder_id = ?`
  ).run(success ? 1 : 0, salesorderId);
}

function markDispatched(salesorderId, success) {
  db.prepare(
    `UPDATE processed_orders
     SET dispatched_at = datetime('now'), dispatch_success = ?, updated_at = datetime('now')
     WHERE salesorder_id = ?`
  ).run(success ? 1 : 0, salesorderId);
}

/**
 * Orders whose resi was printed at least delayMinutes ago and haven't been
 * dispatched (courier requested) yet - the per-order-relative-time equivalent
 * of "30 minutes after printing, call the courier", instead of a fixed clock time.
 */
function getOrdersReadyForDispatch(delayMinutes) {
  return db
    .prepare(
      `SELECT * FROM processed_orders
       WHERE print_success = 1
         AND (dispatch_success IS NULL OR dispatch_success != 1)
         AND printed_at IS NOT NULL
         AND printed_at <= datetime('now', '-' || ? || ' minutes')`
    )
    .all(delayMinutes);
}

function logActivity(salesorderNo, action, success, detail, picklistNo) {
  db.prepare(
    `INSERT INTO activity_log (ts, salesorder_no, picklist_no, action, success, detail)
     VALUES (datetime('now'), ?, ?, ?, ?, ?)`
  ).run(salesorderNo || null, picklistNo || null, action, success ? 1 : 0, detail || null);
}

function getRecentLogs(limit = 200) {
  return db
    .prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT ?')
    .all(limit);
}

module.exports = {
  db,
  getSetting,
  setSetting,
  getAllSettings,
  getProcessedOrder,
  upsertOrderSeen,
  markPrinted,
  markPacked,
  markDispatched,
  getOrdersReadyForDispatch,
  logActivity,
  getRecentLogs,
};
