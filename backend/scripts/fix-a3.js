const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    password: 'Xhl@1608',
    database: 'warehouse_iot',
    charset: 'utf8mb4'
  });
  await conn.execute('UPDATE zones SET name = ?, description = ? WHERE zone_id = ?', ['质检区 A3', '抽检与静置区', 'A3']);
  const [rows] = await conn.execute('SELECT zone_id, name, HEX(name) hex_name FROM zones WHERE zone_id = ?', ['A3']);
  console.log(rows);
  await conn.end();
})();
