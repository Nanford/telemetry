const assert = require('assert');

const {
  buildDemoInspectionReadings,
  parseDemoArgs
} = require('../src/demo-inspection-data');

const readings = buildDemoInspectionReadings({
  deviceId: 'go2-demo-test',
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
assert.ok(readings.every((reading) => reading.device_id === 'go2-demo-test'));
assert.ok(readings[2].rh > 78, 'A3默认生成一条湿度越限数据，用于验证橙色气泡');

const args = parseDemoArgs([
  '--device-id', 'go2-demo-server',
  '--interval-ms', '500',
  '--dry-run'
]);
assert.deepStrictEqual(args, {
  deviceId: 'go2-demo-server',
  intervalMs: 500,
  dryRun: true
});

console.log('demo-inspection-data: OK');
