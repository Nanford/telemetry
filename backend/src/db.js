const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  host: config.mysql.host,
  port: config.mysql.port,
  user: config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database,
  waitForConnections: true,
  connectionLimit: config.mysql.connectionLimit,
  timezone: config.mysql.timezone
});

const query = (sql, params = []) => pool.execute(sql, params);

module.exports = { pool, query };
