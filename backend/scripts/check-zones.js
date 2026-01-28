const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    password: 'Xhl@1608',
    database: 'warehouse_iot',
    charset: 'utf8mb4'
  });
  const [rows] = await conn.execute('SELECT zone_id, name, HEX(name) as hex_name FROM zones ORDER BY zone_id');
  console.log(rows);
  await conn.end();
})();
