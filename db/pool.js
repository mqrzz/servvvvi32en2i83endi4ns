const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Неожиданная ошибка подключения к БД:', err);
});

module.exports = pool;
