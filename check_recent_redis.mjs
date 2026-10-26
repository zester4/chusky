import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DURABLE_STATE_DATABASE_URL });

async function checkRecentRedisMetrics() {
  const res = await pool.query(`
    SELECT route, family, SUM(commands) as total_commands, SUM(duration_ms) as total_duration, COUNT(*) as sample_count
    FROM chusky_redis_route_metric_sample
    WHERE observed_at >= NOW() - INTERVAL '4 hours'
    GROUP BY route, family
    ORDER BY total_commands DESC
    LIMIT 25
  `);
  console.log('Top Redis command sources in the last 4 hours:');
  console.table(res.rows);

  const total = await pool.query(`
    SELECT SUM(commands) as grand_total_commands
    FROM chusky_redis_route_metric_sample
    WHERE observed_at >= NOW() - INTERVAL '4 hours'
  `);
  console.log('Grand total commands recorded in last 4 hours:', total.rows[0].grand_total_commands);

  await pool.end();
}

checkRecentRedisMetrics().catch(e => {
  console.error(e);
  pool.end();
});
