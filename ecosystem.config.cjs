/**
 * Production PM2 definition for Chusky.
 *
 * Keep one worker on this small Oracle VM. Fork mode avoids PM2's cluster
 * readiness lifecycle, which can interrupt a healthy Chusky process before
 * it finishes serving traffic.
 */
module.exports = {
  apps: [
    {
      name: "chusky",
      cwd: __dirname,
      script: "dist/index.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
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
