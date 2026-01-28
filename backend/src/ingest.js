const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { query } = require('./db');
const { safeJsonParse, toMysqlDatetime } = require('./utils');

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

const parseTopic = (topic) => {
  const parts = topic.split('/');
  if (parts[0] !== 'devices') return { device_id: null, zone_id: null };
  if (parts.length === 3) {
    return { device_id: parts[1], zone_id: null };
  }
  if (parts.length >= 4) {
    return { device_id: parts[1], zone_id: parts[2] };
  }
  return { device_id: null, zone_id: null };
};

const resolveZoneByGps = async (lat, lon) => {
  if (lat === null || lat === undefined || lon === null || lon === undefined) return null;
  const [rows] = await query(
    `\n      SELECT zone_id\n      FROM zone_geofences\n      WHERE ? BETWEEN min_lat AND max_lat\n        AND ? BETWEEN min_lon AND max_lon\n      ORDER BY priority DESC, updated_at DESC\n      LIMIT 1\n    `,
    [lat, lon]
  );
  return rows[0]?.zone_id || null;
};

const buildCondition = (metricCol, high, low, type) => {
  const clauses = [];
  const params = [];

  if (type === 'out') {
    if (high !== null && high !== undefined) {
      clauses.push(`${metricCol} > ?`);
      params.push(high);
    }
    if (low !== null && low !== undefined) {
      clauses.push(`${metricCol} < ?`);
      params.push(low);
    }
    return clauses.length
      ? { sql: clauses.join(' OR '), params }
      : { sql: '0', params: [] };
  }

  if (high !== null && high !== undefined) {
    clauses.push(`${metricCol} <= ?`);
    params.push(high);
  }
  if (low !== null && low !== undefined) {
    clauses.push(`${metricCol} >= ?`);
    params.push(low);
  }
  return clauses.length
    ? { sql: clauses.join(' AND '), params }
    : { sql: '1', params: [] };
};

const fetchWindowConsistency = async ({ scope, zone_id, sensor_id, metricCol, high, low, durationSec, type }) => {
  const condition = buildCondition(metricCol, high, low, type);
  const where = [];
  const params = [];

  if (scope === 'zone' && zone_id) {
    where.push('zone_id = ?');
    params.push(zone_id);
  }
  if (scope === 'sensor' && sensor_id) {
    where.push('sensor_id = ?');
    params.push(sensor_id);
  }

  where.push(`ts >= (UTC_TIMESTAMP() - INTERVAL ? SECOND)`);
  params.push(durationSec);

  const sql = `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN ${condition.sql} THEN 1 ELSE 0 END) AS matched
    FROM telemetry_raw
    WHERE ${where.join(' AND ')}
  `;

  const [rows] = await query(sql, [...condition.params, ...params]);
  const row = rows[0] || { total: 0, matched: 0 };
  return { total: Number(row.total), matched: Number(row.matched) };
};

const upsertAlert = async ({ rule, scope, zone_id, sensor_id, metric, currentValue, shouldOpen }) => {
  const [existingRows] = await query(
    `
      SELECT *
      FROM alerts
      WHERE rule_id = ? AND metric = ? AND status IN ('open', 'acked')
      ORDER BY id DESC
      LIMIT 1
    `,
    [rule.id, metric]
  );

  const existing = existingRows[0];
  if (shouldOpen) {
    if (existing) {
      await query(
        `
          UPDATE alerts
          SET last_trigger_at = UTC_TIMESTAMP(), current_value = ?, message = ?
          WHERE id = ?
        `,
        [currentValue, `${metric} 超出阈值`, existing.id]
      );
      return;
    }

    await query(
      `
        INSERT INTO alerts
          (rule_id, zone_id, sensor_id, level, status, first_trigger_at, last_trigger_at, metric, current_value, message)
        VALUES
          (?, ?, ?, 'warning', 'open', UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?, ?, ?)
      `,
      [
        rule.id,
        scope === 'zone' ? zone_id : rule.zone_id,
        scope === 'sensor' ? sensor_id : rule.sensor_id,
        metric,
        currentValue,
        `${metric} 超出阈值`
      ]
    );
    return;
  }

  if (existing) {
    await query(
      `
        UPDATE alerts
        SET status = 'closed', recovered_at = UTC_TIMESTAMP()
        WHERE id = ?
      `,
      [existing.id]
    );
  }
};

const evaluateRules = async (telemetry) => {
  const scope = telemetry.zone_id ? 'zone' : 'sensor';

  const [rules] = await query(
    `
      SELECT * FROM alert_rules
      WHERE enabled = 1 AND (
        (scope_type = 'zone' AND zone_id = ?) OR
        (scope_type = 'sensor' AND sensor_id = ?)
      )
    `,
    [telemetry.zone_id, telemetry.sensor_id]
  );

  if (!rules.length) return;

  for (const rule of rules) {
    const checks = [
      {
        metric: 'temp',
        value: telemetry.temp_c,
        high: rule.temp_high,
        low: rule.temp_low,
        column: 'temp_c'
      },
      {
        metric: 'rh',
        value: telemetry.rh,
        high: rule.rh_high,
        low: rule.rh_low,
        column: 'rh'
      }
    ].filter((check) => check.high !== null || check.low !== null);

    for (const check of checks) {
      if (check.value === null || check.value === undefined) continue;
      const outOfRange =
        (check.high !== null && check.value > check.high) ||
        (check.low !== null && check.value < check.low);

      if (outOfRange) {
        const window = await fetchWindowConsistency({
          scope: rule.scope_type,
          zone_id: telemetry.zone_id,
          sensor_id: telemetry.sensor_id,
          metricCol: check.column,
          high: check.high,
          low: check.low,
          durationSec: rule.trigger_duration_sec,
          type: 'out'
        });

        const sustained = window.total > 0 && window.total === window.matched;
        await upsertAlert({
          rule,
          scope: rule.scope_type,
          zone_id: telemetry.zone_id,
          sensor_id: telemetry.sensor_id,
          metric: check.metric,
          currentValue: check.value,
          shouldOpen: sustained
        });
      } else {
        const window = await fetchWindowConsistency({
          scope: rule.scope_type,
          zone_id: telemetry.zone_id,
          sensor_id: telemetry.sensor_id,
          metricCol: check.column,
          high: check.high,
          low: check.low,
          durationSec: rule.recover_duration_sec,
          type: 'in'
        });

        const sustained = window.total > 0 && window.total === window.matched;
        if (sustained) {
          await upsertAlert({
            rule,
            scope: rule.scope_type,
            zone_id: telemetry.zone_id,
            sensor_id: telemetry.sensor_id,
            metric: check.metric,
            currentValue: check.value,
            shouldOpen: false
          });
        }
      }
    }
  }
};

const startIngest = async () => {
  const client = mqtt.connect(config.mqtt.url, {
    username: config.mqtt.username,
    password: config.mqtt.password,
    clientId: config.mqtt.clientId
  });

  client.on('connect', () => {
    const topics = config.mqtt.topic.split(',').map((item) => item.trim());
    topics.forEach((topic) => client.subscribe(topic));
  });

  client.on('message', async (topic, payloadBuffer) => {
    const payloadRaw = payloadBuffer.toString();
    const payload = safeJsonParse(payloadRaw);
    if (!payload) {
      await logError('JSON parse failed', { topic, payloadRaw });
      return;
    }

    const topicInfo = parseTopic(topic);
    const deviceId = payload.device_id || topicInfo.device_id;
    const gpsLat = payload.gps?.lat ?? null;
    const gpsLon = payload.gps?.lon ?? null;
    const gpsFix = payload.gps?.fix ? 1 : 0;
    const zoneId =
      payload.zone_id || topicInfo.zone_id || (gpsFix ? await resolveZoneByGps(gpsLat, gpsLon) : null) || null;

    if (!deviceId) {
      await logError('Missing device_id', { topic, payload });
      return;
    }

    const sensorId = payload.sensor_id || (zoneId ? `${deviceId}-${zoneId}` : deviceId);
    const tsValue = payload.ts ? Number(payload.ts) : Date.now();
    const tsMs = tsValue > 1e12 ? tsValue : tsValue * 1000;
    const timestamp = new Date(tsMs);

    const telemetry = {
      device_id: deviceId,
      sensor_id: sensorId,
      zone_id: zoneId,
      ts: toMysqlDatetime(timestamp),
      temp_c: payload.temp_c ?? null,
      rh: payload.rh ?? null,
      gps_fix: gpsFix,
      lat: gpsLat,
      lon: gpsLon,
      alt_m: payload.gps?.alt_m ?? null,
      speed_kmh: payload.gps?.speed_kmh ?? null
    };

    try {
      await query(
        `
          INSERT INTO devices (device_id, name, last_seen_at)
          VALUES (?, ?, UTC_TIMESTAMP())
          ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at)
        `,
        [deviceId, deviceId]
      );

      if (zoneId) {
        await query(
          `
            INSERT INTO zones (zone_id, name)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE name = name
          `,
          [zoneId, zoneId]
        );
      }

      await query(
        `
          INSERT INTO sensors (sensor_id, device_id, zone_id)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE zone_id = VALUES(zone_id)
        `,
        [sensorId, deviceId, zoneId]
      );

      await query(
        `
          INSERT INTO telemetry_raw
            (device_id, sensor_id, zone_id, ts, temp_c, rh, gps_fix, lat, lon, alt_m, speed_kmh, payload_json)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          telemetry.device_id,
          telemetry.sensor_id,
          telemetry.zone_id,
          telemetry.ts,
          telemetry.temp_c,
          telemetry.rh,
          telemetry.gps_fix,
          telemetry.lat,
          telemetry.lon,
          telemetry.alt_m,
          telemetry.speed_kmh,
          JSON.stringify(payload)
        ]
      );

      await evaluateRules({
        ...telemetry,
        temp_c: telemetry.temp_c,
        rh: telemetry.rh
      });
    } catch (err) {
      await logError('Database insert failed', { error: err.message, topic, payload });
    }
  });

  client.on('error', async (err) => {
    await logError('MQTT error', { error: err.message });
  });

  return client;
};

module.exports = { startIngest };
