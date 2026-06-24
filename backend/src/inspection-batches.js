const DEFAULT_GAP_MINUTES = 30;
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const DEFAULT_RANGE_HOURS = 24;

const toNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toTimestamp = (value) => {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
};

const toIsoString = (value) => {
  const timestamp = toTimestamp(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
};

const resolveInspectionRange = (query = {}, options = {}) => {
  if (query.range === 'all') return null;

  const nowMs = toTimestamp(options.now ?? Date.now());
  const endMs = query.end ? toTimestamp(query.end) : nowMs;
  const startMs = query.start
    ? toTimestamp(query.start)
    : endMs - DEFAULT_RANGE_HOURS * 60 * 60 * 1000;

  if (startMs === null || endMs === null) {
    throw new Error('开始时间或结束时间格式无效');
  }
  if (startMs > endMs) {
    throw new Error('开始时间不能晚于结束时间');
  }

  return { startMs, endMs };
};

const buildInspectionScanRange = (range, options = {}) => {
  if (!range) return null;
  const gapMinutes = Number(options.gapMinutes || DEFAULT_GAP_MINUTES);
  const offsetHours = Number(options.timeZoneOffsetHours ?? 8);
  const offsetMs = offsetHours * 60 * 60 * 1000;
  const localStart = new Date(range.startMs + offsetMs);
  const localMidnightUtcMs = Date.UTC(
    localStart.getUTCFullYear(),
    localStart.getUTCMonth(),
    localStart.getUTCDate()
  ) - offsetMs;

  return {
    startMs: localMidnightUtcMs - gapMinutes * 60 * 1000,
    endMs: range.endMs
  };
};

const buildInspectionBatchLookupRange = (batchNo, options = {}) => {
  const match = String(batchNo || '').match(
    /^(\d{4})(\d{2})(\d{2})\d{2}$/
  );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const offsetHours = Number(options.timeZoneOffsetHours ?? 8);
  const gapMinutes = Number(options.gapMinutes || DEFAULT_GAP_MINUTES);
  const dayStartMs = Date.UTC(year, month - 1, day) -
    offsetHours * 60 * 60 * 1000;
  const localDate = new Date(dayStartMs + offsetHours * 60 * 60 * 1000);
  if (
    localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() !== month - 1 ||
    localDate.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    startMs: dayStartMs - gapMinutes * 60 * 1000,
    endMs: dayStartMs + 48 * 60 * 60 * 1000
  };
};

const localDateKey = (value, timeZone = DEFAULT_TIME_ZONE) => {
  const timestamp = toTimestamp(value);
  if (timestamp === null) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
};

const average = (values) => {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const metricStats = (rows, field) => {
  const values = rows.map((row) => toNumber(row[field])).filter((value) => value !== null);
  if (!values.length) {
    return { avg: null, min: null, max: null };
  }

  return {
    avg: average(values),
    min: Math.min(...values),
    max: Math.max(...values)
  };
};

const matchInspectionPoint = (measurement, points = []) => {
  if (measurement.point_id) {
    return points.find((point) => point.id === measurement.point_id) || null;
  }

  const x = toNumber(measurement.pos_x);
  const y = toNumber(measurement.pos_y);
  if (x === null || y === null) return null;

  let nearest = null;
  for (const point of points) {
    const pointX = toNumber(point.x);
    const pointY = toNumber(point.y);
    const radius = toNumber(point.radius);
    if (pointX === null || pointY === null || radius === null) continue;

    const distance = Math.hypot(x - pointX, y - pointY);
    if (distance <= radius && (!nearest || distance < nearest.distance)) {
      nearest = { point, distance };
    }
  }

  return nearest?.point || null;
};

const rulesForMeasurement = (measurement, rules) =>
  rules.filter((rule) => (
    (rule.scope_type === 'zone' && measurement.zone_id && rule.zone_id === measurement.zone_id) ||
    (rule.scope_type === 'sensor' && measurement.sensor_id && rule.sensor_id === measurement.sensor_id)
  ));

const isOutOfRange = (value, low, high) => {
  const numericValue = toNumber(value);
  if (numericValue === null) return false;
  const numericLow = toNumber(low);
  const numericHigh = toNumber(high);
  return (
    (numericLow !== null && numericValue < numericLow) ||
    (numericHigh !== null && numericValue > numericHigh)
  );
};

const evaluateMeasurement = (measurement, rules) => {
  const applicableRules = rulesForMeasurement(measurement, rules);
  const tempAbnormal = applicableRules.some((rule) =>
    isOutOfRange(measurement.temp_c, rule.temp_low, rule.temp_high)
  );
  const rhAbnormal = applicableRules.some((rule) =>
    isOutOfRange(measurement.rh, rule.rh_low, rule.rh_high)
  );

  return {
    covered_by_rule: applicableRules.length > 0,
    temp_abnormal: tempAbnormal,
    rh_abnormal: rhAbnormal
  };
};

const enrichMeasurements = (rows, rules, points) =>
  rows.map((row) => {
    const matchedPoint = matchInspectionPoint(row, points);
    const evaluation = evaluateMeasurement(row, rules);
    return {
      ...row,
      ts: toIsoString(row.ts),
      temp_c: toNumber(row.temp_c),
      rh: toNumber(row.rh),
      pos_x: toNumber(row.pos_x),
      pos_y: toNumber(row.pos_y),
      pos_z: toNumber(row.pos_z),
      yaw: toNumber(row.yaw),
      matched_point_id: matchedPoint?.id || null,
      matched_point_name: matchedPoint?.name || null,
      ...evaluation
    };
  });

const summarizeBatch = (rows, rules, points) => {
  const measurements = enrichMeasurements(rows, rules, points);
  const temp = metricStats(measurements, 'temp_c');
  const rh = metricStats(measurements, 'rh');
  const tempAbnormalCount = measurements.filter((row) => row.temp_abnormal).length;
  const rhAbnormalCount = measurements.filter((row) => row.rh_abnormal).length;
  const fullyCovered = measurements.length > 0 && measurements.every((row) => row.covered_by_rule);
  const hasAbnormal = tempAbnormalCount > 0 || rhAbnormalCount > 0;
  const status = hasAbnormal ? 'abnormal' : fullyCovered ? 'normal' : 'undetermined';
  const pointIds = new Set(
    measurements.map((row) => row.matched_point_id).filter(Boolean)
  );
  const actualTrailPoints = measurements.filter(
    (row) =>
      row.pose_source === 'go2_slam' &&
      Number(row.pose_fix) === 1 &&
      row.pos_x !== null &&
      row.pos_y !== null
  ).length;

  const startTimestamp = toTimestamp(measurements[0].ts);
  const endTimestamp = toTimestamp(measurements[measurements.length - 1].ts);

  return {
    device_id: measurements[0].device_id,
    start_time: new Date(startTimestamp).toISOString(),
    end_time: new Date(endTimestamp).toISOString(),
    duration_sec: Math.max(0, Math.round((endTimestamp - startTimestamp) / 1000)),
    sample_count: measurements.length,
    point_count: pointIds.size,
    unmatched_point_count: measurements.length - measurements.filter(
      (row) => row.matched_point_id
    ).length,
    actual_trail_points: actualTrailPoints,
    temp_avg: temp.avg,
    temp_min: temp.min,
    temp_max: temp.max,
    rh_avg: rh.avg,
    rh_min: rh.min,
    rh_max: rh.max,
    temp_abnormal_count: tempAbnormalCount,
    rh_abnormal_count: rhAbnormalCount,
    status,
    status_reason:
      status === 'abnormal'
        ? '存在温湿度越限记录'
        : status === 'normal'
          ? '全部采集记录均在已配置阈值范围内'
          : '缺少适用的点位或传感器阈值规则',
    measurements
  };
};

const buildInspectionBatches = (
  rows,
  rules = [],
  points = [],
  options = {}
) => {
  const gapMinutes = Number(options.gapMinutes || DEFAULT_GAP_MINUTES);
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const gapMs = gapMinutes * 60 * 1000;
  const rowsByDevice = new Map();

  for (const row of rows) {
    const timestamp = toTimestamp(row.ts);
    if (!row.device_id || timestamp === null) continue;
    const deviceRows = rowsByDevice.get(row.device_id) || [];
    deviceRows.push({ ...row, _timestamp: timestamp });
    rowsByDevice.set(row.device_id, deviceRows);
  }

  const rawBatches = [];
  for (const deviceRows of rowsByDevice.values()) {
    deviceRows.sort((a, b) => a._timestamp - b._timestamp || Number(a.id || 0) - Number(b.id || 0));
    let current = [];

    for (const row of deviceRows) {
      const previous = current[current.length - 1];
      if (previous && row._timestamp - previous._timestamp > gapMs) {
        rawBatches.push(current);
        current = [];
      }
      current.push(row);
    }

    if (current.length) rawBatches.push(current);
  }

  rawBatches.sort((a, b) => (
    a[0]._timestamp - b[0]._timestamp ||
    String(a[0].device_id).localeCompare(String(b[0].device_id))
  ));

  const sequenceByDate = new Map();
  return rawBatches.map((batchRows) => {
    const dateKey = localDateKey(batchRows[0]._timestamp, timeZone);
    const sequence = (sequenceByDate.get(dateKey) || 0) + 1;
    sequenceByDate.set(dateKey, sequence);
    const cleanRows = batchRows.map(({ _timestamp, ...row }) => row);

    return {
      batch_no: `${dateKey}${String(sequence).padStart(2, '0')}`,
      ...summarizeBatch(cleanRows, rules, points)
    };
  });
};

const toBatchListItem = ({ measurements, ...batch }) => batch;

const sampleEvenly = (rows, limit) => {
  if (rows.length <= limit) return rows;
  if (limit <= 1) return [rows[0]];

  return Array.from({ length: limit }, (_, index) => {
    const sourceIndex = Math.round(
      (index * (rows.length - 1)) / (limit - 1)
    );
    return rows[sourceIndex];
  });
};

const buildInspectionBatchDetailPayload = (batch, options = {}) => {
  const trendLimit = Number(options.trendLimit || 300);
  const trailLimit = Number(options.trailLimit || 1000);
  const measurementLimit = Number(options.measurementLimit || 100);
  const measurements = batch.measurements || [];
  const latestByPoint = new Map();

  for (const measurement of measurements) {
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

  const trail = measurements
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

  return {
    batch: toBatchListItem(batch),
    trend: sampleEvenly(measurements, trendLimit),
    measurements: measurements.slice(-measurementLimit),
    point_readings: Array.from(latestByPoint.values()),
    actual_trail: sampleEvenly(trail, trailLimit)
  };
};

const summarizeInspectionBatches = (batches, options = {}) => {
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const todayKey = localDateKey(options.now || Date.now(), timeZone);
  const sorted = [...batches].sort(
    (a, b) => toTimestamp(b.start_time) - toTimestamp(a.start_time)
  );

  return {
    total_batches: batches.length,
    total_measurements: batches.reduce((sum, batch) => sum + batch.sample_count, 0),
    today_batches: batches.filter(
      (batch) => localDateKey(batch.start_time, timeZone) === todayKey
    ).length,
    normal_batches: batches.filter((batch) => batch.status === 'normal').length,
    abnormal_batches: batches.filter((batch) => batch.status === 'abnormal').length,
    undetermined_batches: batches.filter((batch) => batch.status === 'undetermined').length,
    temp_abnormal_records: batches.reduce(
      (sum, batch) => sum + batch.temp_abnormal_count,
      0
    ),
    rh_abnormal_records: batches.reduce(
      (sum, batch) => sum + batch.rh_abnormal_count,
      0
    ),
    latest_batch_no: sorted[0]?.batch_no || null
  };
};

module.exports = {
  buildInspectionBatchDetailPayload,
  buildInspectionBatchLookupRange,
  buildInspectionScanRange,
  buildInspectionBatches,
  matchInspectionPoint,
  resolveInspectionRange,
  summarizeInspectionBatches,
  toBatchListItem
};
