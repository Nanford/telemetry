const dotenv = require('dotenv');
const { buildSlamArea } = require('./slam-config');

dotenv.config();

const toNumber = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const config = {
  port: toNumber(process.env.PORT, 8080),
  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: toNumber(process.env.MYSQL_PORT, 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'warehouse_iot',
    connectionLimit: toNumber(process.env.MYSQL_POOL_LIMIT, 10),
    timezone: 'Z'
  },
  mqtt: {
    url: process.env.MQTT_URL || 'mqtt://127.0.0.1:1883',
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    topic: process.env.MQTT_TOPIC || 'devices/+/+/telemetry,devices/+/telemetry',
    clientId: process.env.MQTT_CLIENT_ID || `telemetry-api-${Math.random().toString(16).slice(2)}`
  },
  slam: {
    // 只做平面图左上角 A-1-2 一间房（非整层）。默认 20m × 12m，env 可覆盖；
    // 缺宽高的部署会让前端退化为按点位推导边界，垛位矩形会被画布裁掉。
    area: { width: 20, height: 12, ...buildSlamArea(process.env), area_id: 'A-1-2', name: 'A-1-2 库房' },
    // A-1-2 库房 23 垛位 + 11 巷道采集点，驱动室内定位平面图(SlamMapTab)。
    // 坐标为布局占位：原点在左下角，+x 沿走道朝门(右短边)，+y 朝北墙。
    // 上排(北) 07→18 成对；下排(南) 06→01 —缺口— 23→19 成对；两排夹中央走道。
    // 巷道点 C01→C11：相邻垛列中点、落在走道中线 y=6.0，供走道在途采样归属。
    // kind: 'bay'=垛位(画货架方框)  'aisle'=巷道点(只画走道小圆点)。
    // 现场 SLAM 标定后与 Go2-SLAM-DEV/.../points.A-1-2.yaml 同步替换真坐标(id 不变)。
    // 走道中线 y≈6.0；上排采集 y=7.0(垛位向 +y)；下排采集 y=5.0(垛位向 -y)；列距 1.5m。
    points: [
      // 上排(北) y=7.0 —— 07(左) → 18(近门/右)
      ['A-1-2-07', 1.5, 7.0], ['A-1-2-08', 3.0, 7.0], ['A-1-2-09', 4.5, 7.0], ['A-1-2-10', 6.0, 7.0],
      ['A-1-2-11', 7.5, 7.0], ['A-1-2-12', 9.0, 7.0], ['A-1-2-13', 10.5, 7.0], ['A-1-2-14', 12.0, 7.0],
      ['A-1-2-15', 13.5, 7.0], ['A-1-2-16', 15.0, 7.0], ['A-1-2-17', 16.5, 7.0], ['A-1-2-18', 18.0, 7.0],
      // 下排(南) y=5.0 —— 06(左) → 01 —缺口— 23 → 19(近门/右)
      ['A-1-2-06', 1.5, 5.0], ['A-1-2-05', 3.0, 5.0], ['A-1-2-04', 4.5, 5.0], ['A-1-2-03', 6.0, 5.0],
      ['A-1-2-02', 7.5, 5.0], ['A-1-2-01', 9.0, 5.0],
      ['A-1-2-23', 12.0, 5.0], ['A-1-2-22', 13.5, 5.0], ['A-1-2-21', 15.0, 5.0], ['A-1-2-20', 16.5, 5.0],
      ['A-1-2-19', 18.0, 5.0]
    ].map(([id, x, y]) => ({ id, name: `垛${id.slice(-2)}`, x, y, radius: 0.6, kind: 'bay' }))
      .concat([
        // 巷道采集点 C01→C11 —— 相邻垛列中点、走道中线 y=6.0
        ['A-1-2-C01', 2.25, 6.0], ['A-1-2-C02', 3.75, 6.0], ['A-1-2-C03', 5.25, 6.0], ['A-1-2-C04', 6.75, 6.0],
        ['A-1-2-C05', 8.25, 6.0], ['A-1-2-C06', 9.75, 6.0], ['A-1-2-C07', 11.25, 6.0], ['A-1-2-C08', 12.75, 6.0],
        ['A-1-2-C09', 14.25, 6.0], ['A-1-2-C10', 15.75, 6.0], ['A-1-2-C11', 17.25, 6.0]
      ].map(([id, x, y]) => ({ id, name: `巷${id.slice(-2)}`, x, y, radius: 0.6, kind: 'aisle' })))
  },
  ingest: {
    batchSize: toNumber(process.env.INGEST_BATCH_SIZE, 50),
    flushIntervalMs: toNumber(process.env.INGEST_FLUSH_INTERVAL_MS, 2000),
    ruleCacheTtlMs: toNumber(process.env.RULE_CACHE_TTL_MS, 30000)
  }
};

module.exports = config;
