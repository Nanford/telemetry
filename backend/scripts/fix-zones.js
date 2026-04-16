require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
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
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'warehouse_iot',
    charset: 'utf8mb4'
  });

  for (const [zoneId, name, desc] of zones) {
    await conn.execute('UPDATE zones SET name = ?, description = ? WHERE zone_id = ?', [name, desc, zoneId]);
    await conn.execute('UPDATE zone_geofences SET name = ?, description = ? WHERE zone_id = ?', [name, desc, zoneId]);
  }

  await conn.end();
})();
