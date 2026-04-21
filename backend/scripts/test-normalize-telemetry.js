const assert = require('assert');

const { normalizeIncomingTelemetry } = require('../src/ingest');

const baseInput = {
  topicInfo: { device_id: 'go2_01', zone_id: null },
  payload: {
    device_id: 'go2_01',
    ts: 1776403200,
    temp_c: 26,
    rh: 61,
    area_id: 'warehouse_1f',
    point_id: 'A2',
    sample_type: 'point_valid',
    pose: {
      source: 'go2_slam',
      fix: true,
      x: 6.4,
      y: 2.0,
      z: 0.0,
      yaw: 1.57
    }
  },
  resolvedGpsZoneId: null
};

const explicitZone = normalizeIncomingTelemetry({
  ...baseInput,
  payload: {
    ...baseInput.payload,
    zone_id: 'A2'
  }
});

assert.strictEqual(explicitZone.zone_id, 'A2');
assert.strictEqual(explicitZone.area_id, 'warehouse_1f');
assert.strictEqual(explicitZone.sensor_id, 'go2_01-A2');
assert.strictEqual(explicitZone.point_id, 'A2');
assert.strictEqual(explicitZone.pose_source, 'go2_slam');

const pointFallback = normalizeIncomingTelemetry(baseInput);

assert.strictEqual(pointFallback.zone_id, 'A2');
assert.strictEqual(pointFallback.area_id, 'warehouse_1f');
assert.strictEqual(pointFallback.sensor_id, 'go2_01-A2');

console.log('normalizeIncomingTelemetry: OK');
