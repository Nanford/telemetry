const mysql = require('mysql2/promise');
const zones = [
  ['A1', '原料区 A1', '烟叶原料堆放区'],
  ['A2', '原料区 A2', '分级暂存区'],
  ['A3', '质检区 A3', '抽检与静置区'],
  ['A4', '包装区 A4', '打包流转通道'],
  ['A5', '原料区 A5', '出入库缓冲区']
];

(async () => {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    password: 'Xhl@1608',
    database: 'warehouse_iot',
    charset: 'utf8mb4'
  });

  for (const [zoneId, name, desc] of zones) {
    await conn.execute('UPDATE zones SET name = ?, description = ? WHERE zone_id = ?', [name, desc, zoneId]);
    await conn.execute('UPDATE zone_geofences SET name = ?, description = ? WHERE zone_id = ?', [name, desc, zoneId]);
  }

  await conn.end();
})();
