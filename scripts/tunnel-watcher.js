const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Wraps `cloudflared tunnel --url ...` (a free "quick tunnel" - no domain/account
// needed) and watches its own log output for the dashboard URL it gets assigned.
// Quick tunnels get a NEW random URL every time the cloudflared process itself
// restarts (crash, PM2 restart, machine reboot) - there's no way to pin it down
// without owning a domain. Instead of chasing that, this publishes whatever the
// current URL is to docs/tunnel-url.txt and pushes it to GitHub, so the
// permanent GitHub Pages redirect page (docs/index.html) always sends people to
// today's real link even though the underlying URL keeps changing.
const REPO_ROOT = path.join(__dirname, '..');
const URL_FILE = path.join(REPO_ROOT, 'docs', 'tunnel-url.txt');
const CLOUDFLARED_PATH = process.env.CLOUDFLARED_PATH || 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
const LOCAL_TARGET = process.env.TUNNEL_TARGET || 'http://localhost:4123';
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let lastKnownUrl = fs.existsSync(URL_FILE) ? fs.readFileSync(URL_FILE, 'utf8').trim() : null;

function publishUrl(url) {
  if (url === lastKnownUrl) return;
  lastKnownUrl = url;
  fs.writeFileSync(URL_FILE, url + '\n');
  console.log(`[tunnel-watcher] link baru: ${url} - mendorong ke GitHub...`);

  const run = (args) =>
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd: REPO_ROOT }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
    });

  run(['add', 'docs/tunnel-url.txt'])
    .then(() => run(['commit', '-m', `chore: update tunnel link (${url})`]))
    .then(() => run(['push']))
    .then(() => console.log('[tunnel-watcher] berhasil didorong ke GitHub'))
    .catch((err) => console.error('[tunnel-watcher] gagal push ke GitHub:', err.message));
}

function handleChunk(chunk) {
  const text = chunk.toString();
  const match = text.match(URL_PATTERN);
  if (match) publishUrl(match[0]);
}

console.log(`[tunnel-watcher] starting cloudflared -> ${LOCAL_TARGET}`);
const child = spawn(CLOUDFLARED_PATH, ['tunnel', '--url', LOCAL_TARGET], { stdio: ['ignore', 'pipe', 'pipe'] });

child.stdout.on('data', handleChunk);
child.stderr.on('data', handleChunk);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

child.on('exit', (code) => {
  console.log(`[tunnel-watcher] cloudflared exited (code ${code})`);
  process.exit(code || 0);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
