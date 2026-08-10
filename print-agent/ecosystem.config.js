module.exports = {
  apps: [
    {
      name: 'web-instant-print-agent',
      script: 'agent.js',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 20,
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      time: true,
    },
  ],
};
