require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { print } = require('pdf-to-printer');

const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const POLL_INTERVAL_MS = (Number(process.env.POLL_INTERVAL_SECONDS) || 8) * 1000;

// The dashboard runs behind a free Cloudflare quick tunnel, whose URL rotates
// every time that tunnel process restarts - a fixed SERVER_URL in .env goes
// stale sooner or later (ENOTFOUND). Instead, resolve the CURRENT URL on every
// poll from the same GitHub Pages file the dashboard's own permanent link
// redirects through - so this agent keeps working even if it was set up
// months ago and the tunnel has rotated many times since.
//
// SERVER_URL in .env is still honored if set (e.g. once there's a stable
// domain), which skips this lookup entirely and pins to that address.
const STATIC_SERVER_URL = (process.env.SERVER_URL || '').trim().replace(/\/+$/, '');
const TUNNEL_URL_SOURCE =
  process.env.TUNNEL_URL_SOURCE ||
  'https://raw.githubusercontent.com/warehouse-brancheeline/INSTANT-OTOMATIS/main/docs/tunnel-url.txt';

if (!AGENT_TOKEN) {
  console.error('[print-agent] AGENT_TOKEN must be set in .env - see .env.example');
  process.exit(1);
}

let currentServerUrl = STATIC_SERVER_URL || null;

async function resolveServerUrl() {
  if (STATIC_SERVER_URL) return STATIC_SERVER_URL;
  try {
    const res = await axios.get(`${TUNNEL_URL_SOURCE}?t=${Date.now()}`, { timeout: 10000 });
    const url = String(res.data || '').trim().replace(/\/+$/, '');
    if (url && url !== currentServerUrl) {
      console.log(`[print-agent] alamat server terbaru: ${url}`);
      currentServerUrl = url;
    }
  } catch (err) {
    console.error(`[print-agent] gagal ambil alamat server terbaru (${err.message}) - pakai yang lama: ${currentServerUrl || '(belum ada)'}`);
  }
  return currentServerUrl;
}

/**
 * Polls the central WEB INSTANT server for pending print jobs (resi/picklist
 * PDFs that were already printed on the main laptop), downloads each file, and
 * prints it on THIS machine's own Windows default printer - so every
 * registered laptop ends up with its own physical copy, no per-order routing.
 */
async function pollOnce() {
  const serverUrl = await resolveServerUrl();
  if (!serverUrl) {
    console.error('[print-agent] belum ada alamat server yang bisa dipakai, skip cycle ini');
    return;
  }

  const client = axios.create({
    baseURL: serverUrl,
    headers: { 'x-agent-token': AGENT_TOKEN },
    timeout: 30000,
  });

  const { data: jobs } = await client.get('/api/agent/poll');
  if (!Array.isArray(jobs) || jobs.length === 0) return;

  for (const job of jobs) {
    console.log(`[print-agent] job #${job.id} (${job.label || 'tanpa label'}) - ${job.files.length} file(s)`);
    const downloaded = [];

    // An ack (success OR failure) permanently removes this job from future
    // polls for this agent - see db.js's getPendingJobsForAgent. So a
    // download failure (almost always a network/tunnel blip, not a real
    // problem with the job itself) must NOT be acked - leave it unacked so
    // it's retried next cycle instead of silently never printing.
    try {
      for (const filename of job.files) {
        const res = await client.get(`/api/agent/jobs/${job.id}/file/${filename}`, {
          responseType: 'arraybuffer',
        });
        const localPath = path.join(os.tmpdir(), `print-agent-${job.id}-${filename}`);
        fs.writeFileSync(localPath, res.data);
        downloaded.push(localPath);
      }
    } catch (err) {
      console.error(`[print-agent] job #${job.id} gagal download, akan dicoba lagi siklus berikutnya: ${err.message}`);
      for (const localPath of downloaded) fs.unlink(localPath, () => {});
      continue;
    }

    let printed = false;
    try {
      for (const localPath of downloaded) {
        await print(localPath);
      }
      printed = true;
      await client.post(`/api/agent/jobs/${job.id}/ack`, { success: true });
      console.log(`[print-agent] job #${job.id} printed OK`);
    } catch (err) {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      if (printed) {
        // It DID print - only the "success" report failed to reach the
        // server (network blip again). Don't ack failure here (that would
        // be a lie); leaving it unacked means a retry next cycle, which
        // risks a duplicate printout - a wasted label beats a resi that
        // silently never printed anywhere.
        console.error(`[print-agent] job #${job.id} sudah tercetak tapi gagal lapor ke server, akan dicoba lagi (berisiko cetak ulang): ${detail}`);
      } else {
        console.error(`[print-agent] job #${job.id} FAILED: ${detail}`);
        try {
          await client.post(`/api/agent/jobs/${job.id}/ack`, { success: false, detail });
        } catch (ackErr) {
          console.error(`[print-agent] also failed to ack job #${job.id}, akan dicoba lagi: ${ackErr.message}`);
        }
      }
    } finally {
      for (const localPath of downloaded) fs.unlink(localPath, () => {});
    }
  }
}

async function loop() {
  try {
    await pollOnce();
  } catch (err) {
    console.error('[print-agent] poll error:', err.message);
  }
  setTimeout(loop, POLL_INTERVAL_MS);
}

console.log(
  `[print-agent] starting${STATIC_SERVER_URL ? ` - server=${STATIC_SERVER_URL} (dipatok manual)` : ' - alamat server diambil otomatis tiap cycle'}, polling every ${POLL_INTERVAL_MS / 1000}s`
);
loop();
