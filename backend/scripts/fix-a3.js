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
  await conn.execute('UPDATE zones SET name = ?, description = ? WHERE zone_id = ?', ['质检区 A3', '抽检与静置区', 'A3']);
  const [rows] = await conn.execute('SELECT zone_id, name, HEX(name) hex_name FROM zones WHERE zone_id = ?', ['A3']);
  console.log(rows);
  await conn.end();
})();
