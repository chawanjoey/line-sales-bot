// db.js — Neon PostgreSQL connection pool (shared with Leave System)
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('PostgreSQL pool error:', err.message));

module.exports = pool;
