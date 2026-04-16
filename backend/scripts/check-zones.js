require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'warehouse_iot',
    charset: 'utf8mb4'
  });
  const [rows] = await conn.execute('SELECT zone_id, name, HEX(name) as hex_name FROM zones ORDER BY zone_id');
  console.log(rows);
  await conn.end();
})();
