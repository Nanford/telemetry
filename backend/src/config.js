const dotenv = require('dotenv');
const { loadCalibration } = require('./calibration');
const a41Layout = require('./a41-layout');

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
    // A-4-1（A4 左下仓间）按 CAD 固化为默认巡检区域；面积、东门、垛位和路线严格同系。
    // 现场 SLAM 原始坐标仍通过 calibration 转换到该 CAD 局部坐标系。
    area: a41Layout.area,
    points: a41Layout.points,
    // 现场 SLAM 系→CAD 系相似变换册(阶段2标定产物, 存 calibration.json; 缺省=恒等/未标定)。
    // 按 area_id 分区取值, 避免一个区域的标定污染其他区域的历史数据。
    // 后端匹配/画轨迹/热力前用它把原始位姿变换到 CAD 系; 详见 calibration.js。
    calibration: loadCalibration()
  },
  ingest: {
    batchSize: toNumber(process.env.INGEST_BATCH_SIZE, 50),
    flushIntervalMs: toNumber(process.env.INGEST_FLUSH_INTERVAL_MS, 2000),
    ruleCacheTtlMs: toNumber(process.env.RULE_CACHE_TTL_MS, 30000)
  }
};

module.exports = config;
