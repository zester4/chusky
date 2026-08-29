/**
 * Production PM2 definition for Chusky.
 *
 * Keep exactly one clustered worker on this small Oracle VM. PM2 can still
 * perform a readiness-gated reload: it starts a replacement worker, waits for
 * process.send("ready"), then asks the old worker to drain.
 */
module.exports = {
  apps: [
    {
      name: "chusky",
      cwd: __dirname,
      script: "dist/index.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "cluster",
      wait_ready: true,
      listen_timeout: 30_000,
      kill_timeout: 35_000,
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 3_000,
      exp_backoff_restart_delay: 100,
      max_memory_restart: "420M",
      node_args: "--max-old-space-size=384",
      autorestart: true,
      merge_logs: true,
      time: true,
      env: { NODE_ENV: "production" },
    },
  ],
};
