const express = require('express');
const cors = require('cors');
const config = require('./config');
const { pool, query } = require('./db');
const { autoInitGeofences } = require('./geofence-auto');
const { parseTime, toMysqlDatetime } = require('./utils');
const { startIngest, invalidateRuleCache, flushBuffer, onTelemetry } = require('./ingest');
const {
  buildInspectionBatches,
  summarizeInspectionBatches,
  toBatchListItem
} = require('./inspection-batches');
const { ensureTelemetrySchema } = require('./schema-migrations');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const ok = (res, data) => res.json({ ok: true, data });
const fail = (res, message, status = 400) => res.status(status).json({ ok: false, message });
const toNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
};
let mqttClient = null;

const SLAM_TRAIL_WINDOW_MS = 60 * 60 * 1000;
const SLAM_TRAIL_LIMIT = 2000;
const slamLiveState = {
  latestByDevice: new Map(),
  trail: []
};
const slamStreamClients = new Set();

const loadInspectionBatches = async () => {
  const [telemetryRows] = await query(`
    SELECT id, device_id, sensor_id, zone_id, area_id, ts, temp_c, rh,
           pose_source, pose_fix, pos_x, pos_y, pos_z, yaw, point_id, sample_type
    FROM telemetry_raw
    WHERE temp_c IS NOT NULL OR rh IS NOT NULL
    ORDER BY device_id ASC, ts ASC, id ASC
  `);
  const [rules] = await query(`
    SELECT id, scope_type, zone_id, sensor_id,
           temp_high, temp_low, rh_high, rh_low
    FROM alert_rules
    WHERE enabled = 1
  `);

  return buildInspectionBatches(telemetryRows, rules, config.slam.points, {
    gapMinutes: 30,
    timeZone: 'Asia/Shanghai'
  });
};

const pointReadingsForBatch = (batch) => {
  const latestByPoint = new Map();
  for (const measurement of batch.measurements) {
    if (!measurement.matched_point_id) continue;
    latestByPoint.set(measurement.matched_point_id, {
      point_id: measurement.matched_point_id,
      point_name: measurement.matched_point_name,
      temp_c: measurement.temp_c,
      rh: measurement.rh,
      ts: measurement.ts,
      temp_abnormal: measurement.temp_abnormal,
      rh_abnormal: measurement.rh_abnormal
    });
  }
  return Array.from(latestByPoint.values());
};

const parseTelemetryTimeMs = (value) => {
  if (!value) return Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  if (/^\d+$/.test(String(value))) {
    const num = Number(value);
    return num > 1e12 ? num : num * 1000;
  }

  // Ingest stores UTC as "YYYY-MM-DD HH:mm:ss"; make that explicit for JS parsing.
  const text = String(value).includes('T') ? String(value) : `${String(value).replace(' ', 'T')}Z`;
  const parsed = new Date(text).getTime();
  return Number.isNaN(parsed) ? Date.now() : parsed;
};

const toSlamLivePoint = (telemetry) => {
  if (telemetry.pose_source !== 'go2_slam' || telemetry.pose_fix !== 1) return null;
  if (telemetry.pos_x === null || telemetry.pos_x === undefined || telemetry.pos_y === null || telemetry.pos_y === undefined) {
    return null;
  }

  const tsMs = parseTelemetryTimeMs(telemetry.ts);
  return {
    device_id: telemetry.device_id,
    pos_x: toNumber(telemetry.pos_x),
    pos_y: toNumber(telemetry.pos_y),
    pos_z: toNumber(telemetry.pos_z),
    yaw: toNumber(telemetry.yaw),
    point_id: telemetry.point_id,
    area_id: telemetry.area_id,
    temp_c: telemetry.temp_c,
    rh: telemetry.rh,
    ts: new Date(tsMs).toISOString()
  };
};

const pruneSlamTrail = () => {
  const cutoff = Date.now() - SLAM_TRAIL_WINDOW_MS;
  slamLiveState.trail = slamLiveState.trail
    .filter((point) => parseTelemetryTimeMs(point.ts) >= cutoff)
    .slice(-SLAM_TRAIL_LIMIT);
};

const getSlamLiveSnapshot = () => {
  pruneSlamTrail();
  return {
    latest: Array.from(slamLiveState.latestByDevice.values()),
    trail: slamLiveState.trail
  };
};

const writeSseEvent = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const publishSlamLivePoint = (point) => {
  for (const res of Array.from(slamStreamClients)) {
    try {
      writeSseEvent(res, 'slam', point);
    } catch (_err) {
      slamStreamClients.delete(res);
    }
  }
};

onTelemetry((telemetry) => {
  const point = toSlamLivePoint(telemetry);
  if (!point) return;

  const previous = slamLiveState.latestByDevice.get(point.device_id);
  if (!previous || parseTelemetryTimeMs(point.ts) >= parseTelemetryTimeMs(previous.ts)) {
    slamLiveState.latestByDevice.set(point.device_id, point);
  }

  slamLiveState.trail.push(point);
  pruneSlamTrail();
  publishSlamLivePoint(point);
});

app.get('/api/v1/health', async (_req, res) => {
  ok(res, { status: 'ok', time: new Date().toISOString() });
});

app.get('/api/v1/overview', async (_req, res) => {
  try {
    const [zones] = await query('SELECT zone_id, name, description FROM zones ORDER BY zone_id');
    const [latestRows] = await query(`
      SELECT tr.zone_id, tr.temp_c, tr.rh, tr.ts
      FROM telemetry_raw tr
      INNER JOIN (
        SELECT zone_id, MAX(ts) AS max_ts
        FROM telemetry_raw
        WHERE zone_id IS NOT NULL
          AND ts >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)
          AND (temp_c IS NOT NULL OR rh IS NOT NULL)
        GROUP BY zone_id
      ) latest ON tr.zone_id = latest.zone_id AND tr.ts = latest.max_ts
    `);
    const [rules] = await query(
      `SELECT * FROM alert_rules WHERE scope_type = 'zone' AND enabled = 1`
    );

    const ruleMap = new Map();
    for (const rule of rules) {
      if (!ruleMap.has(rule.zone_id)) ruleMap.set(rule.zone_id, []);
      ruleMap.get(rule.zone_id).push(rule);
    }

    const latestMap = new Map();
    for (const row of latestRows) {
      latestMap.set(row.zone_id, row);
    }

    const zoneCards = zones.map((zone) => {
      const latest = latestMap.get(zone.zone_id);
      let status = 'offline';
      let statusReason = '无最新数据';

      if (latest) {
        status = 'ok';
        statusReason = '运行正常';
        const rulesForZone = ruleMap.get(zone.zone_id) || [];
        const latestTemp = toNumber(latest.temp_c);
        const latestRh = toNumber(latest.rh);
        for (const rule of rulesForZone) {
          const tempHigh = toNumber(rule.temp_high);
          const tempLow = toNumber(rule.temp_low);
          const rhHigh = toNumber(rule.rh_high);
          const rhLow = toNumber(rule.rh_low);
          const tempAlert =
            latestTemp !== null &&
            ((tempHigh !== null && latestTemp > tempHigh) || (tempLow !== null && latestTemp < tempLow));
          const rhAlert =
            latestRh !== null &&
            ((rhHigh !== null && latestRh > rhHigh) || (rhLow !== null && latestRh < rhLow));
          if (tempAlert || rhAlert) {
            status = 'alert';
            statusReason = '超出阈值';
            break;
          }
        }
      }

      return {
        zone_id: zone.zone_id,
        name: zone.name,
        description: zone.description,
        latest: latest
          ? {
              temp_c: latest.temp_c,
              rh: latest.rh,
              ts: latest.ts
            }
          : null,
        status,
        status_reason: statusReason
      };
    });

    const [summaryRows] = await query(`
      SELECT
        AVG(temp_c) AS temp_avg,
        MIN(temp_c) AS temp_min,
        MAX(temp_c) AS temp_max,
        AVG(rh) AS rh_avg,
        MIN(rh) AS rh_min,
        MAX(rh) AS rh_max
      FROM telemetry_raw
      WHERE ts >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)
    `);

    ok(res, {
      zones: zoneCards,
      summary: summaryRows[0] || {}
    });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/insights', async (_req, res) => {
  try {
    const [alertRows] = await query(
      `
        SELECT metric, COUNT(*) AS total
        FROM alerts
        WHERE last_trigger_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY)
        GROUP BY metric
      `
    );

    const alertCounts = { temp: 0, rh: 0 };
    for (const row of alertRows) {
      if (!row?.metric) continue;
      alertCounts[row.metric] = Number(row.total) || 0;
    }

    const [deviceRows] = await query(
      `
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 10 MINUTE) THEN 1 ELSE 0 END) AS active
        FROM devices
      `
    );

    const total = Number(deviceRows[0]?.total || 0);
    const active = Number(deviceRows[0]?.active || 0);
    const stability = total > 0 ? Number(((active / total) * 100).toFixed(1)) : null;

    ok(res, {
      temp_alerts: alertCounts.temp,
      rh_alerts: alertCounts.rh,
      link_stability: stability,
      window_days: 7,
      active_window_min: 10
    });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/health-summary', async (_req, res) => {
  try {
    const mqttStatus = mqttClient ? (mqttClient.connected ? 'online' : 'offline') : 'unknown';

    const [latencyRows] = await query(
      `
        SELECT TIMESTAMPDIFF(SECOND, MAX(ts), UTC_TIMESTAMP()) AS lag_seconds
        FROM telemetry_raw
      `
    );
    const lagSecondsRaw = latencyRows[0]?.lag_seconds;
    const lagSeconds = lagSecondsRaw === null || lagSecondsRaw === undefined ? null : Number(lagSecondsRaw);

    const [alertRows] = await query(
      `
        SELECT COUNT(*) AS total
        FROM alerts
        WHERE status = 'open'
      `
    );
    const pendingAlerts = Number(alertRows[0]?.total || 0);

    ok(res, {
      mqtt_status: mqttStatus,
      write_delay_sec: Number.isFinite(lagSeconds) ? lagSeconds : null,
      pending_alerts: pendingAlerts
    });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/telemetry/trend', async (req, res) => {
  try {
    const { zone_id: zoneId, sensor_id: sensorId } = req.query;
    if (!zoneId && !sensorId) {
      return fail(res, 'zone_id 或 sensor_id 必填');
    }

    const now = new Date();
    const start = parseTime(req.query.start, new Date(now.getTime() - 24 * 3600 * 1000));
    const end = parseTime(req.query.end, now);
    const granularity = req.query.granularity || 'auto';

    const diffMs = end.getTime() - start.getTime();
    const diffDays = diffMs / (1000 * 3600 * 24);
    const useHourly = granularity === 'hourly' || (granularity === 'auto' && diffDays > 7);

    if (useHourly) {
      const [rows] = await query(
        `
          SELECT hour_ts AS ts, temp_avg, temp_min, temp_max, rh_avg, rh_min, rh_max
          FROM telemetry_hourly
          WHERE ${zoneId ? 'zone_id = ?' : 'sensor_id = ?'}
            AND hour_ts BETWEEN ? AND ?
            AND (temp_avg IS NOT NULL OR rh_avg IS NOT NULL)
          ORDER BY hour_ts ASC
        `,
        [zoneId || sensorId, toMysqlDatetime(start), toMysqlDatetime(end)]
      );

      if (rows.length) {
        return ok(res, { granularity: 'hourly', series: rows });
      }

      const [fallback] = await query(
        `
          SELECT
            DATE_FORMAT(ts, '%Y-%m-%d %H:00:00') AS ts,
            AVG(temp_c) AS temp_avg,
            MIN(temp_c) AS temp_min,
            MAX(temp_c) AS temp_max,
            AVG(rh) AS rh_avg,
            MIN(rh) AS rh_min,
            MAX(rh) AS rh_max
          FROM telemetry_raw
          WHERE ${zoneId ? 'zone_id = ?' : 'sensor_id = ?'}
            AND ts BETWEEN ? AND ?
            AND (temp_c IS NOT NULL OR rh IS NOT NULL)
          GROUP BY DATE_FORMAT(ts, '%Y-%m-%d %H')
          ORDER BY ts ASC
        `,
        [zoneId || sensorId, toMysqlDatetime(start), toMysqlDatetime(end)]
      );

      return ok(res, { granularity: 'hourly', series: fallback });
    }

    const [rows] = await query(
      `
        SELECT ts, temp_c, rh
        FROM telemetry_raw
        WHERE ${zoneId ? 'zone_id = ?' : 'sensor_id = ?'}
          AND ts BETWEEN ? AND ?
          AND (temp_c IS NOT NULL OR rh IS NOT NULL)
        ORDER BY ts ASC
        LIMIT 5000
      `,
      [zoneId || sensorId, toMysqlDatetime(start), toMysqlDatetime(end)]
    );

    ok(res, { granularity: 'raw', series: rows });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/geo/latest', async (_req, res) => {
  try {
    const [rows] = await query(`
      SELECT tr.device_id, tr.zone_id, tr.lat, tr.lon, tr.alt_m, tr.speed_kmh, tr.ts, tr.gps_fix
      FROM telemetry_raw tr
      INNER JOIN (
        SELECT device_id, MAX(ts) AS max_ts
        FROM telemetry_raw
        GROUP BY device_id
      ) latest ON tr.device_id = latest.device_id AND tr.ts = latest.max_ts
    `);
    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/geo/trail', async (req, res) => {
  try {
    const deviceId = req.query.device_id;
    const minutes = Number(req.query.minutes || 60);
    if (!deviceId) return fail(res, 'device_id 必填');

    const [rows] = await query(
      `
        SELECT ts, lat, lon
        FROM telemetry_raw
        WHERE device_id = ?
          AND gps_fix = 1
          AND lat IS NOT NULL
          AND lon IS NOT NULL
          AND ts >= (UTC_TIMESTAMP() - INTERVAL ? MINUTE)
        ORDER BY ts ASC
      `,
      [deviceId, minutes]
    );

    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/inspection-batches', async (req, res) => {
  try {
    const allBatches = await loadInspectionBatches();
    const deviceId = req.query.device_id || null;
    const status = req.query.status || null;
    const startMs = req.query.start ? new Date(req.query.start).getTime() : null;
    const endMs = req.query.end ? new Date(req.query.end).getTime() : null;

    const filtered = allBatches.filter((batch) => {
      const batchStart = new Date(batch.start_time).getTime();
      if (deviceId && batch.device_id !== deviceId) return false;
      if (status && batch.status !== status) return false;
      if (Number.isFinite(startMs) && batchStart < startMs) return false;
      if (Number.isFinite(endMs) && batchStart > endMs) return false;
      return true;
    });
    const sorted = filtered.sort(
      (a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
    );
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.page_size || '20', 10))
    );
    const offset = (page - 1) * pageSize;

    ok(res, {
      summary: summarizeInspectionBatches(filtered, {
        timeZone: 'Asia/Shanghai'
      }),
      items: sorted.slice(offset, offset + pageSize).map(toBatchListItem),
      pagination: {
        page,
        page_size: pageSize,
        total: sorted.length,
        total_pages: Math.max(1, Math.ceil(sorted.length / pageSize))
      },
      grouping: {
        gap_minutes: 30,
        time_zone: 'Asia/Shanghai'
      }
    });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/inspection-batches/:batchNo', async (req, res) => {
  try {
    const batches = await loadInspectionBatches();
    const batch = batches.find((item) => item.batch_no === req.params.batchNo);
    if (!batch) return fail(res, '巡检批次不存在', 404);

    const actualTrail = batch.measurements
      .filter(
        (measurement) =>
          measurement.pose_source === 'go2_slam' &&
          Number(measurement.pose_fix) === 1 &&
          measurement.pos_x !== null &&
          measurement.pos_y !== null
      )
      .map((measurement) => ({
        ts: measurement.ts,
        pos_x: measurement.pos_x,
        pos_y: measurement.pos_y,
        pos_z: measurement.pos_z,
        yaw: measurement.yaw,
        point_id: measurement.matched_point_id
      }));

    ok(res, {
      batch,
      area: config.slam.area,
      points: config.slam.points,
      point_readings: pointReadingsForBatch(batch),
      actual_trail: actualTrail
    });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/slam/live', (_req, res) => {
  ok(res, getSlamLiveSnapshot());
});

app.get('/api/v1/slam/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  slamStreamClients.add(res);
  writeSseEvent(res, 'snapshot', getSlamLiveSnapshot());

  const heartbeat = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    slamStreamClients.delete(res);
    res.end();
  });
});

app.get('/api/v1/slam/points', (_req, res) => {
  ok(res, { area: config.slam.area, points: config.slam.points });
});

app.get('/api/v1/slam/latest', async (_req, res) => {
  try {
    const [rows] = await query(`
      SELECT tr.device_id, tr.pos_x, tr.pos_y, tr.pos_z, tr.yaw,
             tr.point_id, tr.area_id, tr.temp_c, tr.rh, tr.ts
      FROM telemetry_raw tr
      INNER JOIN (
        SELECT device_id, MAX(ts) AS max_ts
        FROM telemetry_raw
        WHERE pose_source = 'go2_slam' AND pose_fix = 1
          AND pos_x IS NOT NULL AND pos_y IS NOT NULL
        GROUP BY device_id
      ) latest ON tr.device_id = latest.device_id AND tr.ts = latest.max_ts
      WHERE tr.pose_source = 'go2_slam'
    `);
    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/slam/trail', async (req, res) => {
  try {
    const deviceId = req.query.device_id;
    const minutes = Number(req.query.minutes || 60);

    let sql = `
      SELECT ts, pos_x, pos_y, point_id, device_id
      FROM telemetry_raw
      WHERE pose_source = 'go2_slam'
        AND pose_fix = 1
        AND pos_x IS NOT NULL AND pos_y IS NOT NULL
        AND ts >= (UTC_TIMESTAMP() - INTERVAL ? MINUTE)
    `;
    const params = [minutes];
    if (deviceId) { sql += ' AND device_id = ?'; params.push(deviceId); }
    sql += ' ORDER BY ts ASC LIMIT 500';

    const [rows] = await query(sql, params);
    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/slam/readings', async (_req, res) => {
  try {
    const [rows] = await query(`
      SELECT tr.point_id, tr.temp_c, tr.rh, tr.ts, tr.device_id
      FROM telemetry_raw tr
      INNER JOIN (
        SELECT point_id, MAX(ts) AS max_ts
        FROM telemetry_raw
        WHERE pose_source = 'go2_slam'
          AND point_id IS NOT NULL
          AND (temp_c IS NOT NULL OR rh IS NOT NULL)
        GROUP BY point_id
      ) latest ON tr.point_id = latest.point_id AND tr.ts = latest.max_ts
      WHERE tr.pose_source = 'go2_slam'
    `);
    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/alerts', async (req, res) => {
  try {
    const { zone_id, status, level, start, end } = req.query;
    const where = [];
    const params = [];

    if (zone_id) {
      where.push('zone_id = ?');
      params.push(zone_id);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (level) {
      where.push('level = ?');
      params.push(level);
    }
    if (start) {
      where.push('last_trigger_at >= ?');
      params.push(toMysqlDatetime(parseTime(start, new Date(0))));
    }
    if (end) {
      where.push('last_trigger_at <= ?');
      params.push(toMysqlDatetime(parseTime(end, new Date())));
    }

    const sql = `
      SELECT *
      FROM alerts
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY last_trigger_at DESC
      LIMIT 200
    `;

    const [rows] = await query(sql, params);
    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.post('/api/v1/alerts/:id/ack', async (req, res) => {
  try {
    const id = req.params.id;
    const ackedBy = req.body.acked_by || 'operator';
    const ackNote = req.body.ack_note || '';

    await query(
      `
        UPDATE alerts
        SET status = 'acked', acked_at = UTC_TIMESTAMP(), acked_by = ?, ack_note = ?
        WHERE id = ?
      `,
      [ackedBy, ackNote, id]
    );

    ok(res, { id, status: 'acked' });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/alert-rules', async (_req, res) => {
  try {
    const [rows] = await query('SELECT * FROM alert_rules ORDER BY created_at DESC');
    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.post('/api/v1/alert-rules', async (req, res) => {
  try {
    const rule = req.body;
    if (!rule.name || !rule.scope_type) return fail(res, 'name 与 scope_type 必填');

    const [result] = await query(
      `
        INSERT INTO alert_rules
          (name, scope_type, zone_id, sensor_id, temp_high, temp_low, rh_high, rh_low, trigger_duration_sec, recover_duration_sec, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        rule.name,
        rule.scope_type,
        rule.zone_id || null,
        rule.sensor_id || null,
        rule.temp_high ?? null,
        rule.temp_low ?? null,
        rule.rh_high ?? null,
        rule.rh_low ?? null,
        rule.trigger_duration_sec ?? 30,
        rule.recover_duration_sec ?? 30,
        rule.enabled ?? 1
      ]
    );

    invalidateRuleCache();
    ok(res, { id: result.insertId });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.put('/api/v1/alert-rules/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const rule = req.body;

    await query(
      `
        UPDATE alert_rules
        SET name = ?, scope_type = ?, zone_id = ?, sensor_id = ?,
            temp_high = ?, temp_low = ?, rh_high = ?, rh_low = ?,
            trigger_duration_sec = ?, recover_duration_sec = ?, enabled = ?
        WHERE id = ?
      `,
      [
        rule.name,
        rule.scope_type,
        rule.zone_id || null,
        rule.sensor_id || null,
        rule.temp_high ?? null,
        rule.temp_low ?? null,
        rule.rh_high ?? null,
        rule.rh_low ?? null,
        rule.trigger_duration_sec ?? 30,
        rule.recover_duration_sec ?? 30,
        rule.enabled ?? 1,
        id
      ]
    );

    invalidateRuleCache();
    ok(res, { id });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.delete('/api/v1/alert-rules/:id', async (req, res) => {
  try {
    await query('DELETE FROM alert_rules WHERE id = ?', [req.params.id]);
    invalidateRuleCache();
    ok(res, { id: req.params.id });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/zones', async (_req, res) => {
  try {
    const [rows] = await query(
      `
        SELECT z.zone_id, z.name, z.description, z.created_at,
               g.min_lat, g.max_lat, g.min_lon, g.max_lon, g.priority
        FROM zones z
        LEFT JOIN zone_geofences g ON z.zone_id = g.zone_id
        ORDER BY z.zone_id
      `    );
    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/geofences', async (_req, res) => {
  try {
    const [rows] = await query(
      `
        SELECT g.zone_id, g.name, g.description, g.min_lat, g.max_lat, g.min_lon, g.max_lon, g.priority,
               g.updated_at
        FROM zone_geofences g
        ORDER BY g.priority DESC, g.zone_id
      `
    );
    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.post('/api/v1/geofences/auto-init', async (req, res) => {
  try {
    const zoneId = req.body?.zone_id || null;
    const result = await autoInitGeofences(zoneId);
    ok(res, result);
  } catch (err) {
    fail(res, err.message, err.statusCode || 500);
  }
});

app.post('/api/v1/geofences', async (req, res) => {
  try {
    const data = req.body;
    if (!data.zone_id || !data.name) return fail(res, 'zone_id 与 name 必填');
    if ([data.min_lat, data.max_lat, data.min_lon, data.max_lon].some((v) => v === undefined || v === null)) {
      return fail(res, 'min/max 经度纬度必填');
    }

    await query(
      `
        INSERT INTO zones (zone_id, name, description)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)
      `,
      [data.zone_id, data.name, data.description || null]
    );

    await query(
      `
        INSERT INTO zone_geofences
          (zone_id, name, description, min_lat, max_lat, min_lon, max_lon, priority)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          description = VALUES(description),
          min_lat = VALUES(min_lat),
          max_lat = VALUES(max_lat),
          min_lon = VALUES(min_lon),
          max_lon = VALUES(max_lon),
          priority = VALUES(priority)
      `,
      [
        data.zone_id,
        data.name,
        data.description || null,
        data.min_lat,
        data.max_lat,
        data.min_lon,
        data.max_lon,
        data.priority ?? 0
      ]
    );

    ok(res, { zone_id: data.zone_id });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.put('/api/v1/geofences/:zone_id', async (req, res) => {
  try {
    const data = req.body;
    const zoneId = req.params.zone_id;

    await query(
      `
        UPDATE zones SET name = ?, description = ? WHERE zone_id = ?
      `,
      [data.name, data.description || null, zoneId]
    );

    await query(
      `
        UPDATE zone_geofences
        SET name = ?, description = ?, min_lat = ?, max_lat = ?, min_lon = ?, max_lon = ?, priority = ?
        WHERE zone_id = ?
      `,
      [
        data.name,
        data.description || null,
        data.min_lat,
        data.max_lat,
        data.min_lon,
        data.max_lon,
        data.priority ?? 0,
        zoneId
      ]
    );

    ok(res, { zone_id: zoneId });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.delete('/api/v1/geofences/:zone_id', async (req, res) => {
  try {
    await query('DELETE FROM zone_geofences WHERE zone_id = ?', [req.params.zone_id]);
    ok(res, { zone_id: req.params.zone_id });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.post('/api/v1/zones', async (req, res) => {
  try {
    const { zone_id, name, description } = req.body;
    if (!zone_id || !name) return fail(res, 'zone_id 与 name 必填');

    await query('INSERT INTO zones (zone_id, name, description) VALUES (?, ?, ?)', [zone_id, name, description || null]);
    ok(res, { zone_id });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.put('/api/v1/zones/:zone_id', async (req, res) => {
  try {
    const { name, description } = req.body;
    await query('UPDATE zones SET name = ?, description = ? WHERE zone_id = ?', [name, description || null, req.params.zone_id]);
    ok(res, { zone_id: req.params.zone_id });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.delete('/api/v1/zones/:zone_id', async (req, res) => {
  try {
    await query('DELETE FROM zones WHERE zone_id = ?', [req.params.zone_id]);
    ok(res, { zone_id: req.params.zone_id });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/devices', async (_req, res) => {
  try {
    const [rows] = await query('SELECT device_id, name, status, last_seen_at FROM devices ORDER BY device_id');
    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.post('/api/v1/devices', async (req, res) => {
  try {
    const { device_id, name, status } = req.body;
    if (!device_id) return fail(res, 'device_id 必填');
    await query('INSERT INTO devices (device_id, name, status) VALUES (?, ?, ?)', [device_id, name || null, status || 'active']);
    ok(res, { device_id });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.put('/api/v1/devices/:device_id', async (req, res) => {
  try {
    const { name, status } = req.body;
    await query('UPDATE devices SET name = ?, status = ? WHERE device_id = ?', [name || null, status || 'active', req.params.device_id]);
    ok(res, { device_id: req.params.device_id });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.delete('/api/v1/devices/:device_id', async (req, res) => {
  try {
    await query('DELETE FROM devices WHERE device_id = ?', [req.params.device_id]);
    ok(res, { device_id: req.params.device_id });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.get('/api/v1/sensors', async (req, res) => {
  try {
    const { device_id, zone_id } = req.query;
    const where = [];
    const params = [];

    if (device_id) {
      where.push('device_id = ?');
      params.push(device_id);
    }
    if (zone_id) {
      where.push('zone_id = ?');
      params.push(zone_id);
    }

    const [rows] = await query(
      `SELECT sensor_id, device_id, zone_id, type, created_at FROM sensors ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sensor_id`,
      params
    );

    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

app.post('/api/v1/sensors', async (req, res) => {
  try {
    const { sensor_id, device_id, zone_id, type } = req.body;
    if (!sensor_id || !device_id) return fail(res, 'sensor_id 与 device_id 必填');

    await query(
      'INSERT INTO sensors (sensor_id, device_id, zone_id, type) VALUES (?, ?, ?, ?)',
      [sensor_id, device_id, zone_id || null, type || 'DHT11']
    );

    ok(res, { sensor_id });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

let server;

const bootstrap = async () => {
  const migrations = await ensureTelemetrySchema(query);
  if (migrations.length) {
    console.log(`[schema] applied ${migrations.length} telemetry change(s)`);
  }

  server = app.listen(config.port, () => {
    console.log(`API listening on ${config.port}`);
  });

  try {
    mqttClient = await startIngest();
  } catch (err) {
    console.error('MQTT ingest failed', err);
  }
};

bootstrap().catch((err) => {
  console.error('API bootstrap failed', err);
  process.exitCode = 1;
});

const shutdown = async (signal) => {
  console.log(`\n[${signal}] shutting down...`);
  if (mqttClient) {
    mqttClient.end(false);
    console.log('[shutdown] MQTT disconnected');
  }
  await flushBuffer();
  console.log('[shutdown] buffer flushed');
  if (server) {
    server.close();
    console.log('[shutdown] HTTP server closed');
  }
  await pool.end();
  console.log('[shutdown] DB pool closed');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
