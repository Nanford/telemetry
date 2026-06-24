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
    area: buildSlamArea(process.env),
    points: [
      { id: 'A1', name: 'A1区', x: 2.1, y: 1.8, radius: 0.8 },
      { id: 'A2', name: 'A2区', x: 6.4, y: 2.0, radius: 0.8 },
      { id: 'A3', name: 'A3区', x: 10.2, y: 2.1, radius: 0.8 },
      { id: 'A4', name: 'A4区', x: 14.0, y: 2.0, radius: 0.8 },
      { id: 'A5', name: 'A5区', x: 17.8, y: 1.9, radius: 0.8 }
    ]
  },
  ingest: {
    batchSize: toNumber(process.env.INGEST_BATCH_SIZE, 50),
    flushIntervalMs: toNumber(process.env.INGEST_FLUSH_INTERVAL_MS, 2000),
    ruleCacheTtlMs: toNumber(process.env.RULE_CACHE_TTL_MS, 30000)
  }
};

module.exports = config;
