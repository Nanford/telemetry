const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { pool, query } = require('./db');
const { safeJsonParse, toMysqlDatetime } = require('./utils');

/* ---------- logging ---------- */

const logDir = path.join(__dirname, '..', 'logs');
const logFile = path.join(logDir, 'ingest-errors.log');

const ensureLogDir = async () => {
  await fs.promises.mkdir(logDir, { recursive: true });
};

const logError = async (message, payload) => {
  await ensureLogDir();
  const entry = `[${new Date().toISOString()}] ${message} ${payload ? JSON.stringify(payload) : ''}\n`;
  await fs.promises.appendFile(logFile, entry, 'utf8');
};

/* ---------- alert helpers ---------- */

const metricLabels = { temp: '温度', rh: '湿度' };

const formatAlertMessage = (metric) => {
  if (!metric) return '指标超出阈值';
  return `${metricLabels[metric] || metric}超出阈值`;
};

/* ---------- rule cache ---------- */

let ruleCache = [];       // all enabled rules
let ruleCacheTs = 0;      // last refresh timestamp

const refreshRuleCache = async () => {
  const [rows] = await query('SELECT * FROM alert_rules WHERE enabled = 1');
  ruleCache = rows;
  ruleCacheTs = Date.now();
};

const getRulesFor = (zoneId, sensorId) => {
  return ruleCache.filter(
    (r) =>
      (r.scope_type === 'zone' && r.zone_id === zoneId) ||
      (r.scope_type === 'sensor' && r.sensor_id === sensorId)
  );
};

/** Call this after alert_rules CRUD to force a reload */
const invalidateRuleCache = () => {
  ruleCacheTs = 0;
};

const ensureRuleCacheFresh = async () => {
  if (Date.now() - ruleCacheTs > config.ingest.ruleCacheTtlMs) {
    await refreshRuleCache();
  }
};

/* ---------- topic parsing ---------- */

const parseTopic = (topic) => {
  const parts = topic.split('/');
  if (parts[0] !== 'devices') return { device_id: null, zone_id: null };
  if (parts.length === 3) return { device_id: parts[1], zone_id: null };
  if (parts.length >= 4) return { device_id: parts[1], zone_id: parts[2] };
  return { device_id: null, zone_id: null };
};

const resolveZoneByGps = async (lat, lon) => {
  if (lat === null || lat === undefined || lon === null || lon === undefined) return null;
  const [rows] = await query(
    `SELECT zone_id FROM zone_geofences
     WHERE ? BETWEEN min_lat AND max_lat AND ? BETWEEN min_lon AND max_lon
     ORDER BY priority DESC, updated_at DESC LIMIT 1`,
    [lat, lon]
  );
  return rows[0]?.zone_id || null;
};

const normalizeIncomingTelemetry = ({ topicInfo, payload, resolvedGpsZoneId = null }) => {
  const deviceId = payload.device_id || topicInfo.device_id || null;

  const gps = payload.gps || {};
  const isFallback = !!gps.fallback;
  const hasRealFix = gps.fix && !isFallback;
  const gpsLat = gps.lat ?? null;
  const gpsLon = gps.lon ?? null;
  const gpsFix = hasRealFix ? 1 : 0;

  const pose = payload.pose || {};
  const poseSource = pose.source || null;
  const poseFix = pose.fix ? 1 : 0;
  const posX = pose.x ?? null;
  const posY = pose.y ?? null;
  const posZ = pose.z ?? null;
  const yaw = pose.yaw ?? null;
  const pointId = payload.point_id || null;
  const sampleType = payload.sample_type || null;
  const areaId = payload.area_id || null;
  const zoneId = payload.area_id || payload.zone_id || topicInfo.zone_id || resolvedGpsZoneId || null;

  const sensorId = payload.sensor_id || (zoneId ? `${deviceId}-${zoneId}` : deviceId);
  const tsValue = payload.ts ? Number(payload.ts) : Date.now();
  const tsMs = tsValue > 1e12 ? tsValue : tsValue * 1000;
  const timestamp = new Date(tsMs);

  return {
    device_id: deviceId,
    sensor_id: sensorId,
    zone_id: zoneId,
    area_id: areaId,
    ts: toMysqlDatetime(timestamp),
    temp_c: payload.temp_c ?? null,
    rh: payload.rh ?? null,
    gps_fix: gpsFix,
    lat: gpsLat,
    lon: gpsLon,
    alt_m: gps.alt_m ?? null,
    speed_kmh: gps.speed_kmh ?? null,
    pose_source: poseSource,
    pose_fix: poseFix,
    pos_x: posX,
    pos_y: posY,
    pos_z: posZ,
    yaw: yaw,
    point_id: pointId,
    sample_type: sampleType,
    payload_json: JSON.stringify(payload)
  };
};

/* ---------- alert rule evaluation ---------- */

const buildCondition = (metricCol, high, low, type) => {
  const clauses = [];
  const params = [];

  if (type === 'out') {
    if (high !== null && high !== undefined) { clauses.push(`${metricCol} > ?`); params.push(high); }
    if (low !== null && low !== undefined) { clauses.push(`${metricCol} < ?`); params.push(low); }
    return clauses.length ? { sql: clauses.join(' OR '), params } : { sql: '0', params: [] };
  }

  if (high !== null && high !== undefined) { clauses.push(`${metricCol} <= ?`); params.push(high); }
  if (low !== null && low !== undefined) { clauses.push(`${metricCol} >= ?`); params.push(low); }
  return clauses.length ? { sql: clauses.join(' AND '), params } : { sql: '1', params: [] };
};

const fetchWindowConsistency = async ({ scope, zone_id, sensor_id, metricCol, high, low, durationSec, type }) => {
  const condition = buildCondition(metricCol, high, low, type);
  const where = [];
  const params = [];

  if (scope === 'zone' && zone_id) { where.push('zone_id = ?'); params.push(zone_id); }
  if (scope === 'sensor' && sensor_id) { where.push('sensor_id = ?'); params.push(sensor_id); }
  where.push('ts >= (UTC_TIMESTAMP() - INTERVAL ? SECOND)');
  params.push(durationSec);

  const sql = `
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN ${condition.sql} THEN 1 ELSE 0 END) AS matched
    FROM telemetry_raw WHERE ${where.join(' AND ')}`;

  const [rows] = await query(sql, [...condition.params, ...params]);
  const row = rows[0] || { total: 0, matched: 0 };
  return { total: Number(row.total), matched: Number(row.matched) };
};

const upsertAlert = async ({ rule, scope, zone_id, sensor_id, metric, currentValue, shouldOpen }) => {
  const [existingRows] = await query(
    `SELECT * FROM alerts WHERE rule_id = ? AND metric = ? AND status IN ('open','acked')
     ORDER BY id DESC LIMIT 1`,
    [rule.id, metric]
  );
  const existing = existingRows[0];

  if (shouldOpen) {
    if (existing) {
      await query(
        `UPDATE alerts SET last_trigger_at = UTC_TIMESTAMP(), current_value = ?, message = ? WHERE id = ?`,
        [currentValue, formatAlertMessage(metric), existing.id]
      );
    } else {
      await query(
        `INSERT INTO alerts (rule_id, zone_id, sensor_id, level, status, first_trigger_at, last_trigger_at, metric, current_value, message)
         VALUES (?, ?, ?, 'warning', 'open', UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?, ?, ?)`,
        [rule.id, scope === 'zone' ? zone_id : rule.zone_id, scope === 'sensor' ? sensor_id : rule.sensor_id, metric, currentValue, formatAlertMessage(metric)]
      );
    }
  } else if (existing) {
    await query(`UPDATE alerts SET status = 'closed', recovered_at = UTC_TIMESTAMP() WHERE id = ?`, [existing.id]);
  }
};

const evaluateRulesForTelemetry = async (telemetry) => {
  const rules = getRulesFor(telemetry.zone_id, telemetry.sensor_id);
  if (!rules.length) return;

  for (const rule of rules) {
    const checks = [
      { metric: 'temp', value: telemetry.temp_c, high: rule.temp_high, low: rule.temp_low, column: 'temp_c' },
      { metric: 'rh', value: telemetry.rh, high: rule.rh_high, low: rule.rh_low, column: 'rh' }
    ].filter((c) => c.high !== null || c.low !== null);

    for (const check of checks) {
      if (check.value === null || check.value === undefined) continue;
      const outOfRange =
        (check.high !== null && check.value > check.high) ||
        (check.low !== null && check.value < check.low);

      if (outOfRange) {
        const w = await fetchWindowConsistency({
          scope: rule.scope_type, zone_id: telemetry.zone_id, sensor_id: telemetry.sensor_id,
          metricCol: check.column, high: check.high, low: check.low,
          durationSec: rule.trigger_duration_sec, type: 'out'
        });
        await upsertAlert({ rule, scope: rule.scope_type, zone_id: telemetry.zone_id, sensor_id: telemetry.sensor_id, metric: check.metric, currentValue: check.value, shouldOpen: w.total > 0 && w.total === w.matched });
      } else {
        const w = await fetchWindowConsistency({
          scope: rule.scope_type, zone_id: telemetry.zone_id, sensor_id: telemetry.sensor_id,
          metricCol: check.column, high: check.high, low: check.low,
          durationSec: rule.recover_duration_sec, type: 'in'
        });
        if (w.total > 0 && w.total === w.matched) {
          await upsertAlert({ rule, scope: rule.scope_type, zone_id: telemetry.zone_id, sensor_id: telemetry.sensor_id, metric: check.metric, currentValue: check.value, shouldOpen: false });
        }
      }
    }
  }
};

/* ---------- batch buffer ---------- */

let buffer = [];
let flushTimer = null;

const buildBulkInsertSql = (table, columns, rows) => {
  const placeholders = rows.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
  const flat = rows.flat();
  return { sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`, params: flat };
};

const flushBuffer = async () => {
  if (!buffer.length) return;
  const batch = buffer.splice(0);

  try {
    // 1) bulk upsert devices
    const deviceIds = [...new Set(batch.map((t) => t.device_id))];
    for (const did of deviceIds) {
      await pool.query(
        `INSERT INTO devices (device_id, name, last_seen_at) VALUES (?, ?, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at)`,
        [did, did]
      );
    }

    // 2) bulk upsert zones
    const zoneIds = [...new Set(batch.map((t) => t.zone_id).filter(Boolean))];
    for (const zid of zoneIds) {
      await pool.query(
        `INSERT INTO zones (zone_id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = name`,
        [zid, zid]
      );
    }

    // 3) bulk upsert sensors
    const sensorMap = new Map();
    for (const t of batch) {
      sensorMap.set(t.sensor_id, t);
    }
    for (const t of sensorMap.values()) {
      await pool.query(
        `INSERT INTO sensors (sensor_id, device_id, zone_id) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE zone_id = VALUES(zone_id)`,
        [t.sensor_id, t.device_id, t.zone_id]
      );
    }

    // 4) bulk insert telemetry_raw (single multi-row INSERT via pool.query)
    const columns = ['device_id', 'sensor_id', 'zone_id', 'area_id', 'ts', 'temp_c', 'rh', 'gps_fix', 'lat', 'lon', 'alt_m', 'speed_kmh', 'pose_source', 'pose_fix', 'pos_x', 'pos_y', 'pos_z', 'yaw', 'point_id', 'sample_type', 'payload_json'];
    const rows = batch.map((t) => [
      t.device_id, t.sensor_id, t.zone_id, t.area_id, t.ts,
      t.temp_c, t.rh, t.gps_fix, t.lat, t.lon, t.alt_m, t.speed_kmh,
      t.pose_source, t.pose_fix, t.pos_x, t.pos_y, t.pos_z, t.yaw, t.point_id, t.sample_type,
      t.payload_json
    ]);
    const bulk = buildBulkInsertSql('telemetry_raw', columns, rows);
    await pool.query(bulk.sql, bulk.params);

    // 5) evaluate rules only for the latest reading per zone/sensor
    await ensureRuleCacheFresh();
    const latestByKey = new Map();
    for (const t of batch) {
      const key = t.zone_id || t.sensor_id;
      const existing = latestByKey.get(key);
      if (!existing || t.ts > existing.ts) {
        latestByKey.set(key, t);
      }
    }
    for (const t of latestByKey.values()) {
      await evaluateRulesForTelemetry(t);
    }
  } catch (err) {
    await logError('Batch flush failed', { error: err.message, batchSize: batch.length });
  }
};

const scheduleFlush = () => {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushBuffer();
  }, config.ingest.flushIntervalMs);
};

const enqueue = async (telemetry) => {
  buffer.push(telemetry);
  if (buffer.length >= config.ingest.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await flushBuffer();
  } else {
    scheduleFlush();
  }
};

/* ---------- MQTT entry point ---------- */

const startIngest = async () => {
  await refreshRuleCache();

  const client = mqtt.connect(config.mqtt.url, {
    username: config.mqtt.username,
    password: config.mqtt.password,
    clientId: config.mqtt.clientId
  });

  const subscribeAll = () => {
    const topics = config.mqtt.topic.split(',').map((s) => s.trim());
    topics.forEach((t) => client.subscribe(t));
    console.log('[MQTT] subscribed:', topics.join(', '));
  };

  client.on('connect', () => {
    console.log('[MQTT] connected');
    subscribeAll();
  });

  client.on('reconnect', () => console.log('[MQTT] reconnecting...'));
  client.on('offline', () => console.log('[MQTT] offline'));

  client.on('message', async (topic, payloadBuffer) => {
    const payloadRaw = payloadBuffer.toString();
    const payload = safeJsonParse(payloadRaw);
    if (!payload) {
      await logError('JSON parse failed', { topic, payloadRaw });
      return;
    }

    const topicInfo = parseTopic(topic);
    const deviceId = payload.device_id || topicInfo.device_id;
    if (!deviceId) {
      await logError('Missing device_id', { topic, payload });
      return;
    }

    // Log device-reported errors (e.g. DHT checksum failures)
    const deviceErrors = payload.errors;
    if (Array.isArray(deviceErrors) && deviceErrors.length) {
      await logError('Device reported errors', { device_id: deviceId, errors: deviceErrors });
    }

    const gps = payload.gps || {};
    const isFallback = !!gps.fallback;
    const hasRealFix = gps.fix && !isFallback;
    const resolvedGpsZoneId = hasRealFix ? await resolveZoneByGps(gps.lat ?? null, gps.lon ?? null) : null;

    await enqueue(
      normalizeIncomingTelemetry({
        topicInfo,
        payload,
        resolvedGpsZoneId
      })
    );
  });

  client.on('error', async (err) => {
    await logError('MQTT error', { error: err.message });
  });

  return client;
};

module.exports = { startIngest, invalidateRuleCache, flushBuffer, normalizeIncomingTelemetry };
