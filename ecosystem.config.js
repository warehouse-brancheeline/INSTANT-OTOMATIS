module.exports = {
  apps: [
    {
      name: 'web-instant',
      script: 'src/index.js',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 20,
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      time: true,
    },
    {
      // Wraps cloudflared instead of running it directly - see scripts/tunnel-watcher.js
      // for why (publishes the current quick-tunnel URL to docs/tunnel-url.txt on GitHub
      // so the GitHub Pages redirect page always points somewhere live).
      name: 'web-instant-tunnel',
      script: 'scripts/tunnel-watcher.js',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 20,
      out_file: 'logs/tunnel-out.log',
      error_file: 'logs/tunnel-error.log',
      time: true,
    },
  ],
};
