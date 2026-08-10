const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const express = require('express');
const cookieParser = require('cookie-parser');
const { jwtVerify, createRemoteJWKSet } = require('jose');
const db = require('./db');
const scheduler = require('./scheduler');
const manualActions = require('./jobs/manualActions');
const auth = require('./auth');
const config = require('./config');
const { QUEUE_DIR } = require('./printer');

// Verifies Firebase Auth ID tokens directly against Google's public keys -
// no firebase-admin / service-account credentials needed, since all we need
// is "is this a genuine, unexpired Firebase ID token for our project, and
// which email does it belong to".
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

async function verifyFirebaseIdToken(idToken) {
  const { payload } = await jwtVerify(idToken, FIREBASE_JWKS, {
    issuer: `https://securetoken.google.com/${config.firebaseProjectId}`,
    audience: config.firebaseProjectId,
  });
  return payload;
}

/** CORS for /api/login-firebase only - it's called cross-origin from the
 * GitHub Pages redirect page (the one stable origin Firebase's sign-in popup
 * is authorized for), unlike every other endpoint in this app. */
function firebaseLoginCors(req, res, next) {
  res.header('Access-Control-Allow-Origin', config.firebaseLoginOrigin);
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PRINT_AGENT_SRC_DIR = path.join(__dirname, '..', 'print-agent');
// Files copied into the downloadable print-agent zip - everything the target
// laptop needs to install and run, minus node_modules/.env (those get
// generated locally / filled in per-agent below).
const PRINT_AGENT_FILES = [
  'agent.js',
  'package.json',
  'ecosystem.config.js',
  'README.md',
  'install.bat',
  '.env.example',
  'scripts/install-startup.ps1',
];

/** Bearer-token auth for remote print agents - separate from the dashboard's
 * cookie session, since agents are unattended scripts, not logged-in staff. */
function requireAgentAuth(req, res, next) {
  const token = (req.get('x-agent-token') || '').trim();
  const agent = token && db.getPrintAgentByToken(token);
  if (!agent) return res.status(401).json({ error: 'invalid agent token' });
  req.printAgent = agent;
  next();
}

function createServer() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // Reachable without logging in: the login page itself, its stylesheet, and
  // the login endpoint.
  app.get('/login.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
  app.get('/style.css', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'style.css')));

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!auth.checkCredentials(username, password)) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    const token = auth.createSessionToken();
    res.cookie(auth.COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: auth.SESSION_DURATION_MS,
    });
    res.json({ status: 'ok' });
  });

  app.options('/api/login-firebase', firebaseLoginCors);
  app.post('/api/login-firebase', firebaseLoginCors, async (req, res) => {
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'idToken is required' });

    let payload;
    try {
      payload = await verifyFirebaseIdToken(idToken);
    } catch (err) {
      return res.status(401).json({ error: 'invalid or expired Google sign-in' });
    }

    if (!payload.email_verified || payload.email !== config.allowedLoginEmail) {
      return res.status(403).json({ error: 'email not allowed' });
    }

    const token = auth.createSessionToken();
    res.cookie(auth.COOKIE_NAME, token, {
      httpOnly: true,
      // Set from a cross-origin fetch (the GitHub Pages page calling this
      // tunnel-domain endpoint), so it needs SameSite=None to be accepted -
      // Lax/Strict would silently get dropped by the browser here. The plain
      // /api/login above doesn't need this since it's always same-origin.
      sameSite: 'none',
      secure: true,
      maxAge: auth.SESSION_DURATION_MS,
    });
    res.json({ status: 'ok' });
  });

  app.post('/api/logout', (req, res) => {
    res.clearCookie(auth.COOKIE_NAME);
    res.json({ status: 'ok' });
  });

  // Remote print agent routes - authenticated by their own per-agent token
  // (header x-agent-token), not the dashboard cookie session, since these are
  // unattended scripts running on other laptops.
  app.get('/api/agent/poll', requireAgentAuth, (req, res) => {
    db.touchPrintAgent(req.printAgent.agent_id);
    res.json(db.getPendingJobsForAgent(req.printAgent.agent_id));
  });

  app.get('/api/agent/jobs/:id/file/:filename', requireAgentAuth, (req, res) => {
    const filename = path.basename(req.params.filename); // no path traversal
    const filePath = path.join(QUEUE_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });
    res.sendFile(filePath);
  });

  app.post('/api/agent/jobs/:id/ack', requireAgentAuth, (req, res) => {
    const { success, detail } = req.body || {};
    db.ackPrintJob(Number(req.params.id), req.printAgent.agent_id, !!success, detail);
    res.json({ status: 'ok' });
  });

  // Everything below this line requires a valid session.
  app.use(auth.requireAuth);
  app.use(express.static(PUBLIC_DIR));

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

  // Printer cabang (remote print agents) - dashboard-side management. Token is
  // only ever returned from the create call; it's not retrievable afterwards.
  app.get('/api/print-agents', (req, res) => {
    res.json(db.listPrintAgents());
  });

  app.post('/api/print-agents', (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const agentId = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString('hex');
    db.createPrintAgent(agentId, name, token);
    res.json({ agent_id: agentId, name, token });
  });

  app.delete('/api/print-agents/:id', (req, res) => {
    db.deletePrintAgent(req.params.id);
    res.json({ status: 'ok' });
  });

  // Ready-to-run download for a specific printer cabang: the print-agent
  // program pre-filled with that agent's token, zipped up so staff just unzip
  // + double-click install.bat on the other laptop. SERVER_URL is left blank -
  // the agent resolves the dashboard's current address itself every cycle (see
  // print-agent/agent.js), so this download stays valid even after the
  // Cloudflare quick tunnel URL rotates later.
  app.get('/api/print-agents/:id/download', (req, res) => {
    const agent = db.getPrintAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: 'agent not found' });

    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-agent-'));
    try {
      for (const rel of PRINT_AGENT_FILES) {
        const dest = path.join(stageDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(PRINT_AGENT_SRC_DIR, rel), dest);
      }
      fs.writeFileSync(
        path.join(stageDir, '.env'),
        `SERVER_URL=\nAGENT_TOKEN=${agent.token}\nPOLL_INTERVAL_SECONDS=8\n`
      );

      const zipPath = path.join(os.tmpdir(), `print-agent-${agent.agent_id}.zip`);
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${zipPath}' -Force`,
      ]);

      const safeName = agent.name.replace(/[^a-z0-9-_]+/gi, '-');
      res.download(zipPath, `print-agent-${safeName}.zip`, (err) => {
        fs.rm(stageDir, { recursive: true, force: true }, () => {});
        fs.unlink(zipPath, () => {});
        if (err) console.error('[server] print-agent zip download failed:', err.message);
      });
    } catch (err) {
      fs.rm(stageDir, { recursive: true, force: true }, () => {});
      console.error('[server] failed to build print-agent zip:', err.message);
      res.status(500).json({ error: 'failed to build print-agent package' });
    }
  });

  return app;
}

module.exports = { createServer };
