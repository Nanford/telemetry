const assert = require('assert');

const {
  buildDemoInspectionReadings,
  parseDemoArgs
} = require('../src/demo-inspection-data');

const readings = buildDemoInspectionReadings({
  deviceId: 'Go2',
  startedAtMs: 1776403200000
});

assert.strictEqual(readings.length, 5);
assert.deepStrictEqual(
  readings.map((reading) => reading.point_id),
  ['A1', 'A2', 'A3', 'A4', 'A5']
);
assert.ok(readings.every((reading) => reading.pose.source === 'go2_slam'));
assert.ok(readings.every((reading) => reading.pose.fix === true));
assert.ok(readings.every((reading) => reading.sample_type === 'point_valid'));
assert.ok(readings.every((reading) => reading.device_id === 'Go2'));
assert.ok(readings.every((reading) => reading.sensor_id.startsWith('Go2-')));
assert.ok(readings[2].rh > 78, 'A3默认生成一条湿度越限数据，用于验证橙色气泡');

assert.deepStrictEqual(parseDemoArgs([]), {
  deviceId: 'Go2',
  intervalMs: 1000,
  dryRun: false
});

const args = parseDemoArgs([
  '--device-id', 'Go2',
  '--interval-ms', '500',
  '--dry-run'
]);
assert.deepStrictEqual(args, {
  deviceId: 'Go2',
  intervalMs: 500,
  dryRun: true
});

console.log('demo-inspection-data: OK');
