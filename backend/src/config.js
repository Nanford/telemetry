const dotenv = require('dotenv');

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
  ingest: {
    batchSize: toNumber(process.env.INGEST_BATCH_SIZE, 50),
    flushIntervalMs: toNumber(process.env.INGEST_FLUSH_INTERVAL_MS, 2000),
    ruleCacheTtlMs: toNumber(process.env.RULE_CACHE_TTL_MS, 30000)
  }
};

module.exports = config;
