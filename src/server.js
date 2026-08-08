const path = require('path');
const express = require('express');
const db = require('./db');
const scheduler = require('./scheduler');
const manualActions = require('./jobs/manualActions');

function createServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/status', (req, res) => {
    res.json(scheduler.getStatus());
  });

  app.get('/api/settings', (req, res) => {
    res.json(db.getAllSettings());
  });

  app.post('/api/settings', (req, res) => {
    const { feature_enabled, employee_id, shipper_nik, print_picklist_enabled, dispatch_delay_minutes, restrict_order_no } = req.body || {};
    if (feature_enabled !== undefined) {
      const wasEnabled = db.getSetting('feature_enabled') === '1';
      const nowEnabled = !!feature_enabled;
      db.setSetting('feature_enabled', nowEnabled ? '1' : '0');
      if (nowEnabled && !wasEnabled) {
        console.log('[server] Proses Instant diaktifkan - menjalankan picklist & dispatch job sekarang');
        scheduler
          .runPicklistNow()
          .then(() => scheduler.runDispatchNow())
          .catch((err) => console.error('[server] immediate run on activation failed:', err.message));
      }
    }
    if (employee_id !== undefined && String(employee_id).trim() !== '') {
      db.setSetting('employee_id', String(employee_id).trim());
    }
    if (shipper_nik !== undefined && String(shipper_nik).trim() !== '') {
      db.setSetting('shipper_nik', String(shipper_nik).trim());
    }
    if (print_picklist_enabled !== undefined) {
      db.setSetting('print_picklist_enabled', print_picklist_enabled ? '1' : '0');
    }
    if (dispatch_delay_minutes !== undefined && Number(dispatch_delay_minutes) > 0) {
      db.setSetting('dispatch_delay_minutes', String(Number(dispatch_delay_minutes)));
    }
    if (restrict_order_no !== undefined) {
      db.setSetting('restrict_order_no', String(restrict_order_no).trim());
    }
    res.json(db.getAllSettings());
  });

  app.get('/api/logs', (req, res) => {
    const limit = Number(req.query.limit) || 100;
    res.json(db.getRecentLogs(limit));
  });

  app.post('/api/debug/run-picklist-now', async (req, res) => {
    const result = await scheduler.runPicklistNow();
    res.json(result);
  });

  app.post('/api/debug/run-print-now', async (req, res) => {
    const result = await scheduler.runPrintNow();
    res.json(result);
  });

  app.post('/api/debug/run-dispatch-now', async (req, res) => {
    const result = await scheduler.runDispatchNow();
    res.json(result);
  });

  // Single-step manual triggers - always scoped to settings.restrict_order_no,
  // for walking one test order through the pipeline click by click.
  app.post('/api/debug/manual/picklist', async (req, res) => {
    res.json(await manualActions.runManualPicklist());
  });
  app.post('/api/debug/manual/print-resi', async (req, res) => {
    res.json(await manualActions.runManualPrintResi());
  });
  app.post('/api/debug/manual/siap-kirim', async (req, res) => {
    res.json(await manualActions.runManualSiapKirim());
  });
  app.post('/api/debug/manual/selesaikan', async (req, res) => {
    res.json(await manualActions.runManualSelesaikan());
  });
  app.post('/api/debug/manual/buat-pengiriman', async (req, res) => {
    res.json(await manualActions.runManualBuatPengiriman());
  });
  app.post('/api/debug/manual/panggil-driver', async (req, res) => {
    res.json(await manualActions.runManualPanggilDriver());
  });

  return app;
}

module.exports = { createServer };
