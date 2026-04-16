const { query } = require('./db');

const LATEST_WINDOW_MINUTES = 30;
const MAX_SOURCE_AGE_HOURS = 24;
const MIN_POINTS = 5;
const TRIM_THRESHOLD = 20;
const OUTLIER_PERCENTILE = 0.05;
const DEPTH_METERS = 50;
const HALF_DEPTH_METERS = DEPTH_METERS / 2;
const WIDTH_PADDING_METERS = 2;
const MIN_WIDTH_METERS = 8;
const METERS_PER_LAT_DEGREE = 111320;

const percentile = (sorted, ratio) => {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * ratio;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
};

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

const metersToLatDelta = (meters) => meters / METERS_PER_LAT_DEGREE;

const metersToLonDelta = (meters, centerLat) => {
  const cosLat = Math.cos(toRadians(centerLat));
  const safeCosLat = Math.abs(cosLat) < 1e-6 ? 1e-6 : cosLat;
  return meters / (METERS_PER_LAT_DEGREE * safeCosLat);
};

const metersToAxisDelta = (meters, axis, centerLat) =>
  axis === 'lat' ? metersToLatDelta(meters) : metersToLonDelta(meters, centerLat);

const axisSpanMeters = (minValue, maxValue, axis, centerLat) => {
  const delta = Math.abs(maxValue - minValue);
  return axis === 'lat'
    ? delta * METERS_PER_LAT_DEGREE
    : delta * METERS_PER_LAT_DEGREE * Math.max(Math.abs(Math.cos(toRadians(centerLat))), 1e-6);
};

const roundCoordinate = (value) => Number(value.toFixed(7));

const processPoints = (points) => {
  if (points.length < MIN_POINTS) {
    return {
      valid: false,
      sourceCount: points.length,
      usedCount: 0,
      points: [],
      center: null
    };
  }

  let usablePoints = points;

  if (points.length >= TRIM_THRESHOLD) {
    const sortedLats = points.map((point) => point.lat).sort((a, b) => a - b);
    const sortedLons = points.map((point) => point.lon).sort((a, b) => a - b);
    const latMin = percentile(sortedLats, OUTLIER_PERCENTILE);
    const latMax = percentile(sortedLats, 1 - OUTLIER_PERCENTILE);
    const lonMin = percentile(sortedLons, OUTLIER_PERCENTILE);
    const lonMax = percentile(sortedLons, 1 - OUTLIER_PERCENTILE);

    const filtered = points.filter(
      (point) =>
        point.lat >= latMin &&
        point.lat <= latMax &&
        point.lon >= lonMin &&
        point.lon <= lonMax
    );

    if (filtered.length >= MIN_POINTS) {
      usablePoints = filtered;
    }
  }

  return {
    valid: true,
    sourceCount: points.length,
    usedCount: usablePoints.length,
    points: usablePoints,
    center: {
      lat: mean(usablePoints.map((point) => point.lat)),
      lon: mean(usablePoints.map((point) => point.lon))
    }
  };
};

const inferOrientationFromCenters = (centers) => {
  if (centers.length < 2) {
    return {
      split_axis: 'lon',
      depth_axis: 'lat',
      latest_window_min: LATEST_WINDOW_MINUTES,
      max_source_age_hours: MAX_SOURCE_AGE_HOURS,
      depth_m: DEPTH_METERS
    };
  }

  const latRange =
    Math.max(...centers.map((center) => center.lat)) -
    Math.min(...centers.map((center) => center.lat));
  const lonRange =
    Math.max(...centers.map((center) => center.lon)) -
    Math.min(...centers.map((center) => center.lon));

  return lonRange >= latRange
    ? {
        split_axis: 'lon',
        depth_axis: 'lat',
        latest_window_min: LATEST_WINDOW_MINUTES,
        max_source_age_hours: MAX_SOURCE_AGE_HOURS,
        depth_m: DEPTH_METERS
      }
    : {
        split_axis: 'lat',
        depth_axis: 'lon',
        latest_window_min: LATEST_WINDOW_MINUTES,
        max_source_age_hours: MAX_SOURCE_AGE_HOURS,
        depth_m: DEPTH_METERS
      };
};

const inferOrientation = (geofences) => {
  const centers = geofences.map((zone) => ({
    lat: (Number(zone.min_lat) + Number(zone.max_lat)) / 2,
    lon: (Number(zone.min_lon) + Number(zone.max_lon)) / 2
  }));

  return inferOrientationFromCenters(centers);
};

const buildBounds = (points, orientation) => {
  const centerLat = mean(points.map((point) => point.lat));
  const centerLon = mean(points.map((point) => point.lon));
  const splitValues = points.map((point) => point[orientation.split_axis]);
  const splitMin = Math.min(...splitValues);
  const splitMax = Math.max(...splitValues);
  const splitPadding = metersToAxisDelta(WIDTH_PADDING_METERS, orientation.split_axis, centerLat);

  let widenedMin = splitMin - splitPadding;
  let widenedMax = splitMax + splitPadding;

  const currentWidthMeters = axisSpanMeters(
    widenedMin,
    widenedMax,
    orientation.split_axis,
    centerLat
  );

  if (currentWidthMeters < MIN_WIDTH_METERS) {
    const extraHalfMeters = (MIN_WIDTH_METERS - currentWidthMeters) / 2;
    const extraDelta = metersToAxisDelta(extraHalfMeters, orientation.split_axis, centerLat);
    widenedMin -= extraDelta;
    widenedMax += extraDelta;
  }

  const depthDelta = metersToAxisDelta(HALF_DEPTH_METERS, orientation.depth_axis, centerLat);
  const depthCenter = orientation.depth_axis === 'lat' ? centerLat : centerLon;
  const depthMin = depthCenter - depthDelta;
  const depthMax = depthCenter + depthDelta;

  const latMin = orientation.split_axis === 'lat' ? widenedMin : depthMin;
  const latMax = orientation.split_axis === 'lat' ? widenedMax : depthMax;
  const lonMin = orientation.split_axis === 'lon' ? widenedMin : depthMin;
  const lonMax = orientation.split_axis === 'lon' ? widenedMax : depthMax;

  return {
    min_lat: roundCoordinate(Math.min(latMin, latMax)),
    max_lat: roundCoordinate(Math.max(latMin, latMax)),
    min_lon: roundCoordinate(Math.min(lonMin, lonMax)),
    max_lon: roundCoordinate(Math.max(lonMin, lonMax))
  };
};

const normalizePointRow = (row) => ({
  tsMs: new Date(row.ts).getTime(),
  lat: Number(row.lat),
  lon: Number(row.lon)
});

const buildZoneStats = (zoneIds, groupedPoints) => {
  const nowMs = Date.now();

  return zoneIds.map((zoneId) => {
    const rows = groupedPoints.get(zoneId) || [];
    const points = rows.map(normalizePointRow);
    const latestTsMs = points.length
      ? Math.max(...points.map((point) => point.tsMs))
      : null;
    const latestPoints =
      latestTsMs === null
        ? []
        : points.filter(
            (point) => point.tsMs >= latestTsMs - LATEST_WINDOW_MINUTES * 60 * 1000
          );

    return {
      zone_id: zoneId,
      latestTsMs,
      isFresh:
        latestTsMs !== null &&
        latestTsMs >= nowMs - MAX_SOURCE_AGE_HOURS * 60 * 60 * 1000,
      latest: processPoints(latestPoints)
    };
  });
};

const persistGeofence = async ({ zoneId, bounds }) => {
  await query(
    `
      UPDATE zone_geofences
      SET min_lat = ?, max_lat = ?, min_lon = ?, max_lon = ?
      WHERE zone_id = ?
    `,
    [bounds.min_lat, bounds.max_lat, bounds.min_lon, bounds.max_lon, zoneId]
  );
};

const autoInitGeofences = async (zoneId = null) => {
  const [allGeofences] = await query(
    `
      SELECT zone_id, name, description, priority, min_lat, max_lat, min_lon, max_lon
      FROM zone_geofences
      ORDER BY priority DESC, zone_id
    `
  );

  if (zoneId && !allGeofences.some((zone) => zone.zone_id === zoneId)) {
    const error = new Error(`zone_id 娌℃湁瀵瑰簲鐢靛瓙鍥存爮: ${zoneId}`);
    error.statusCode = 404;
    throw error;
  }

  const targetZones = zoneId
    ? allGeofences.filter((zone) => zone.zone_id === zoneId)
    : allGeofences;

  if (!targetZones.length) {
    return {
      scope: zoneId ? 'single' : 'all',
      orientation: inferOrientation([]),
      results: []
    };
  }

  const allZoneIds = allGeofences.map((zone) => zone.zone_id);
  const placeholders = allZoneIds.map(() => '?').join(', ');

  const [pointRows] = await query(
    `
      SELECT zone_id, ts, lat, lon
      FROM telemetry_raw
      WHERE zone_id IN (${placeholders})
        AND lat IS NOT NULL
        AND lon IS NOT NULL
      ORDER BY zone_id ASC, ts ASC
    `,
    allZoneIds
  );

  const groupedPoints = new Map();
  for (const row of pointRows) {
    if (!groupedPoints.has(row.zone_id)) groupedPoints.set(row.zone_id, []);
    groupedPoints.get(row.zone_id).push(row);
  }

  const zoneStats = buildZoneStats(allZoneIds, groupedPoints);
  const zoneStatsMap = new Map(zoneStats.map((stat) => [stat.zone_id, stat]));
  const orientation = inferOrientation(allGeofences);
  const results = [];

  for (const zone of targetZones) {
    const stats = zoneStatsMap.get(zone.zone_id);

    if (!stats?.latestTsMs) {
      results.push({
        zone_id: zone.zone_id,
        status: 'skipped',
        reason: 'no_position_history',
        latest_source_points: 0,
        latest_used_points: 0
      });
      continue;
    }

    if (!stats.isFresh) {
      results.push({
        zone_id: zone.zone_id,
        status: 'skipped',
        reason: 'stale_latest_points',
        latest_ts: new Date(stats.latestTsMs).toISOString(),
        latest_source_points: stats.latest.sourceCount,
        latest_used_points: stats.latest.usedCount
      });
      continue;
    }

    if (!stats.latest.valid) {
      results.push({
        zone_id: zone.zone_id,
        status: 'skipped',
        reason: 'insufficient_latest_points',
        latest_ts: new Date(stats.latestTsMs).toISOString(),
        latest_source_points: stats.latest.sourceCount,
        latest_used_points: stats.latest.usedCount
      });
      continue;
    }

    const bounds = buildBounds(stats.latest.points, orientation);
    await persistGeofence({ zoneId: zone.zone_id, bounds });

    results.push({
      zone_id: zone.zone_id,
      status: 'updated',
      reason: null,
      latest_ts: new Date(stats.latestTsMs).toISOString(),
      latest_source_points: stats.latest.sourceCount,
      latest_used_points: stats.latest.usedCount,
      ...bounds
    });
  }

  return {
    scope: zoneId ? 'single' : 'all',
    orientation,
    results
  };
};

module.exports = {
  autoInitGeofences
};
