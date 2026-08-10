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
    picklist_no TEXT,
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

  CREATE TABLE IF NOT EXISTS print_agents (
    agent_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
  );

  CREATE TABLE IF NOT EXISTS print_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    label TEXT,
    files TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS print_job_acks (
    job_id INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    success INTEGER,
    detail TEXT,
    acked_at TEXT,
    PRIMARY KEY (job_id, agent_id)
  );
`);

// Migrations for databases created before these columns existed.
for (const stmt of [
  'ALTER TABLE activity_log ADD COLUMN picklist_no TEXT',
  'ALTER TABLE processed_orders ADD COLUMN packed_at TEXT',
  'ALTER TABLE processed_orders ADD COLUMN pack_success INTEGER DEFAULT 0',
  'ALTER TABLE processed_orders ADD COLUMN picklist_no TEXT',
  'ALTER TABLE processed_orders ADD COLUMN dispatch_fail_count INTEGER DEFAULT 0',
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

function upsertOrderSeen(salesorderId, salesorderNo, shipper, picklistNo) {
  db.prepare(
    `INSERT INTO processed_orders (salesorder_id, salesorder_no, shipper, picklist_no, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(salesorder_id) DO UPDATE SET
       salesorder_no = excluded.salesorder_no,
       shipper = excluded.shipper,
       picklist_no = COALESCE(excluded.picklist_no, processed_orders.picklist_no),
       updated_at = datetime('now')`
  ).run(salesorderId, salesorderNo, shipper, picklistNo || null);
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

/**
 * dispatch_success: NULL = never tried, 0 = failed (will retry), 1 = done,
 * -1 = gave up after too many consecutive failures (see giveUpOnDispatch) -
 * excluded from retry so a permanently-stuck order (e.g. one Jubelio itself
 * refuses via API, needing manual handling in the marketplace seller center)
 * doesn't get hammered forever.
 */
function markDispatched(salesorderId, success) {
  if (success) {
    db.prepare(
      `UPDATE processed_orders
       SET dispatched_at = datetime('now'), dispatch_success = 1, dispatch_fail_count = 0, updated_at = datetime('now')
       WHERE salesorder_id = ?`
    ).run(salesorderId);
  } else {
    db.prepare(
      `UPDATE processed_orders
       SET dispatched_at = datetime('now'), dispatch_success = 0,
           dispatch_fail_count = dispatch_fail_count + 1, updated_at = datetime('now')
       WHERE salesorder_id = ?`
    ).run(salesorderId);
  }
}

function getDispatchFailCount(salesorderId) {
  const row = db
    .prepare('SELECT dispatch_fail_count FROM processed_orders WHERE salesorder_id = ?')
    .get(salesorderId);
  return row ? row.dispatch_fail_count : 0;
}

function giveUpOnDispatch(salesorderId) {
  db.prepare(
    `UPDATE processed_orders SET dispatch_success = -1, updated_at = datetime('now') WHERE salesorder_id = ?`
  ).run(salesorderId);
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
         AND (dispatch_success IS NULL OR dispatch_success = 0)
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

/**
 * Registers a remote print agent (a laptop with its own printer) and issues it
 * a bearer token. The token is only ever returned here, at creation time - it's
 * shown once in the dashboard for the operator to copy into that laptop's
 * print-agent config.
 */
function createPrintAgent(agentId, name, token) {
  db.prepare(
    `INSERT INTO print_agents (agent_id, name, token, created_at) VALUES (?, ?, ?, datetime('now'))`
  ).run(agentId, name, token);
}

function listPrintAgents() {
  return db
    .prepare('SELECT agent_id, name, created_at, last_seen_at FROM print_agents ORDER BY created_at ASC')
    .all();
}

function getPrintAgentByToken(token) {
  return db.prepare('SELECT * FROM print_agents WHERE token = ?').get(token);
}

function getPrintAgentById(agentId) {
  return db.prepare('SELECT * FROM print_agents WHERE agent_id = ?').get(agentId);
}

function touchPrintAgent(agentId) {
  db.prepare(`UPDATE print_agents SET last_seen_at = datetime('now') WHERE agent_id = ?`).run(agentId);
}

function deletePrintAgent(agentId) {
  db.prepare('DELETE FROM print_agents WHERE agent_id = ?').run(agentId);
  db.prepare('DELETE FROM print_job_acks WHERE agent_id = ?').run(agentId);
}

/** files: array of filenames living in the print_queue directory. */
function createPrintJob(label, files) {
  const result = db
    .prepare(`INSERT INTO print_jobs (created_at, label, files) VALUES (datetime('now'), ?, ?)`)
    .run(label || null, JSON.stringify(files));
  return result.lastInsertRowid;
}

/** Jobs not yet acknowledged (successfully or not) by this specific agent. */
function getPendingJobsForAgent(agentId) {
  const rows = db
    .prepare(
      `SELECT pj.id, pj.created_at, pj.label, pj.files
       FROM print_jobs pj
       LEFT JOIN print_job_acks ack ON ack.job_id = pj.id AND ack.agent_id = ?
       WHERE ack.job_id IS NULL
       ORDER BY pj.id ASC`
    )
    .all(agentId);
  return rows.map((r) => ({ ...r, files: JSON.parse(r.files) }));
}

function ackPrintJob(jobId, agentId, success, detail) {
  db.prepare(
    `INSERT INTO print_job_acks (job_id, agent_id, success, detail, acked_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(job_id, agent_id) DO UPDATE SET
       success = excluded.success, detail = excluded.detail, acked_at = excluded.acked_at`
  ).run(jobId, agentId, success ? 1 : 0, detail || null);
}

/** Print jobs older than the retention window - safe to delete files + rows for. */
function getStalePrintJobs(hoursOld) {
  const rows = db
    .prepare(
      `SELECT id, files FROM print_jobs WHERE created_at <= datetime('now', '-' || ? || ' hours')`
    )
    .all(hoursOld);
  return rows.map((r) => ({ ...r, files: JSON.parse(r.files) }));
}

function deletePrintJob(jobId) {
  db.prepare('DELETE FROM print_jobs WHERE id = ?').run(jobId);
  db.prepare('DELETE FROM print_job_acks WHERE job_id = ?').run(jobId);
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
  getDispatchFailCount,
  giveUpOnDispatch,
  getOrdersReadyForDispatch,
  logActivity,
  getRecentLogs,
  createPrintAgent,
  listPrintAgents,
  getPrintAgentByToken,
  getPrintAgentById,
  touchPrintAgent,
  deletePrintAgent,
  createPrintJob,
  getPendingJobsForAgent,
  ackPrintJob,
  getStalePrintJobs,
  deletePrintJob,
};
