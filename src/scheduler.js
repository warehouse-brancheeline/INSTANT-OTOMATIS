const cron = require('node-cron');
const db = require('./db');
const { runPicklistJob } = require('./jobs/picklistJob');
const { runPrintJob } = require('./jobs/printJob');
const { runDispatchJob } = require('./jobs/dispatchJob');

const PICKLIST_INTERVAL_MINUTES = 5;
const PRINT_FALLBACK_INTERVAL_MINUTES = 5;
const DISPATCH_CHECK_INTERVAL_MINUTES = 1;

let picklistRunning = false;
let printRunning = false;
let dispatchRunning = false;
let lastPicklistRun = null;
let lastPrintRun = null;
let lastDispatchRun = null;

async function runNow(fn, setRunning, isRunning, label, setLastRun) {
  if (isRunning()) {
    console.log(`[scheduler] ${label} already running, skipping overlap`);
    return { skipped: true, reason: 'already_running' };
  }
  setRunning(true);
  try {
    const result = await fn();
    setLastRun(new Date().toISOString());
    return result;
  } catch (err) {
    console.error(`[scheduler] ${label} crashed:`, err.message);
    return { error: err.message };
  } finally {
    setRunning(false);
  }
}

function runPicklistNow() {
  return runNow(
    runPicklistJob,
    (v) => (picklistRunning = v),
    () => picklistRunning,
    'picklistJob',
    (t) => (lastPicklistRun = t)
  );
}

function runPrintNow() {
  return runNow(
    runPrintJob,
    (v) => (printRunning = v),
    () => printRunning,
    'printJob',
    (t) => (lastPrintRun = t)
  );
}

function runDispatchNow() {
  return runNow(
    runDispatchJob,
    (v) => (dispatchRunning = v),
    () => dispatchRunning,
    'dispatchJob',
    (t) => (lastDispatchRun = t)
  );
}

function isFeatureEnabled() {
  return db.getSetting('feature_enabled') === '1';
}

function start() {
  // Every N minutes - move Siap Proses -> Gudang, create + print draft picklist.
  // Runs more often than the hourly print/dispatch jobs since it's purely
  // administrative (no physical dependency) and staff should get picklists fast.
  cron.schedule(`*/${PICKLIST_INTERVAL_MINUTES} * * * *`, () => {
    if (!isFeatureEnabled()) return;
    console.log(`[scheduler] tick (every ${PICKLIST_INTERVAL_MINUTES}m) - picklist job`);
    runPicklistNow();
  });

  // Fallback safety net (not the primary print path - picklistJob already prints
  // immediately after picking) for orders that reached finish-pick without going
  // through picklistJob, e.g. picking done manually outside this tool.
  cron.schedule(`*/${PRINT_FALLBACK_INTERVAL_MINUTES} * * * *`, () => {
    if (!isFeatureEnabled()) return;
    console.log(`[scheduler] tick (every ${PRINT_FALLBACK_INTERVAL_MINUTES}m) - print fallback job`);
    runPrintNow();
  });

  // Checks every minute for any order whose resi was printed >= dispatch_delay_minutes
  // ago (default 30) and dispatches it then - per order, relative to ITS OWN print
  // time, not a fixed clock slot. Cheap when there's nothing to do (single DB query).
  cron.schedule(`*/${DISPATCH_CHECK_INTERVAL_MINUTES} * * * *`, () => {
    if (!isFeatureEnabled()) return;
    runDispatchNow();
  });

  // Optional short-interval debug schedule, off by default.
  const debugMinutes = Number(db.getSetting('debug_interval_minutes'));
  if (debugMinutes > 0) {
    cron.schedule(`*/${debugMinutes} * * * *`, () => {
      if (!isFeatureEnabled()) return;
      console.log(`[scheduler] debug tick (every ${debugMinutes}m) - picklist + print + dispatch`);
      runPicklistNow().then(() => runPrintNow()).then(() => runDispatchNow());
    });
    console.log(`[scheduler] debug interval active: every ${debugMinutes} minute(s)`);
  }

  console.log(
    `[scheduler] started - picklist every ${PICKLIST_INTERVAL_MINUTES}m, print fallback every ${PRINT_FALLBACK_INTERVAL_MINUTES}m, dispatch check every ${DISPATCH_CHECK_INTERVAL_MINUTES}m (fires ${db.getSetting('dispatch_delay_minutes')}m after each order's print time)`
  );
}

function getStatus() {
  return {
    picklistRunning,
    printRunning,
    dispatchRunning,
    lastPicklistRun,
    lastPrintRun,
    lastDispatchRun,
    featureEnabled: db.getSetting('feature_enabled') === '1',
  };
}

module.exports = { start, runPicklistNow, runPrintNow, runDispatchNow, getStatus };
