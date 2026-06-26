const assert = require('assert');

const {
  buildInspectionBatchDetailPayload,
  buildInspectionBatchLookupRange,
  buildInspectionScanRange,
  buildInspectionBatches,
  matchInspectionPoint,
  resolveInspectionRange,
  summarizeInspectionBatches
} = require('../src/inspection-batches');

const points = [
  { id: 'A1', name: 'A1区', x: 2, y: 2, radius: 0.8 },
  { id: 'A2', name: 'A2区', x: 6, y: 2, radius: 0.8 }
];

const rules = [
  {
    id: 1,
    scope_type: 'zone',
    zone_id: 'A1',
    sensor_id: null,
    temp_high: 30,
    temp_low: 10,
    rh_high: 70,
    rh_low: 30
  }
];

const rows = [
  {
    id: 1,
    device_id: 'go2-01',
    sensor_id: 'go2-01-A1',
    zone_id: 'A1',
    ts: '2026-04-16T00:00:00.000Z',
    temp_c: 24,
    rh: 60,
    point_id: 'A1',
    pos_x: 2,
    pos_y: 2
  },
  {
    id: 2,
    device_id: 'go2-01',
    sensor_id: 'go2-01-A1',
    zone_id: 'A1',
    ts: '2026-04-16T00:30:00.000Z',
    temp_c: 25,
    rh: 61,
    point_id: null,
    pos_x: 2.2,
    pos_y: 2.1
  },
  {
    id: 3,
    device_id: 'go2-01',
    sensor_id: 'go2-01-A1',
    zone_id: 'A1',
    ts: '2026-04-16T01:00:01.000Z',
    temp_c: 31,
    rh: 60,
    point_id: null,
    pos_x: 6.1,
    pos_y: 2
  },
  {
    id: 4,
    device_id: 'go2-02',
    sensor_id: 'go2-02',
    zone_id: null,
    ts: '2026-04-16T01:05:00.000Z',
    temp_c: 23,
    rh: 58,
    point_id: null,
    pos_x: null,
    pos_y: null
  }
];

const batches = buildInspectionBatches(rows, rules, points, {
  gapMinutes: 30,
  timeZone: 'Asia/Shanghai'
});

assert.strictEqual(batches.length, 3, '超过30分钟或切换设备时应产生新批次');
assert.strictEqual(batches[0].batch_no, '2026041601');
assert.strictEqual(batches[1].batch_no, '2026041602');
assert.strictEqual(batches[2].batch_no, '2026041603');

assert.strictEqual(batches[0].sample_count, 2);
assert.strictEqual(batches[0].status, 'normal');
assert.strictEqual(batches[0].point_count, 1);
assert.strictEqual(batches[0].measurements[1].matched_point_id, 'A1');
assert.strictEqual(
  batches[0].actual_trail_points,
  0,
  '只有普通坐标但没有有效go2_slam定位时不能计为实际轨迹'
);

assert.strictEqual(batches[1].status, 'abnormal');
assert.strictEqual(batches[1].temp_abnormal_count, 1);
assert.strictEqual(batches[1].measurements[0].matched_point_id, 'A2');

assert.strictEqual(
  batches[2].status,
  'undetermined',
  '没有适用阈值规则时不能判定为正常'
);

assert.strictEqual(
  matchInspectionPoint({ point_id: 'A2', pos_x: 2, pos_y: 2 }, points).id,
  'A2',
  '上报point_id应优先于坐标匹配'
);
assert.strictEqual(
  matchInspectionPoint({ point_id: null, pos_x: 20, pos_y: 20 }, points),
  null,
  '超出全部点位半径时不应强行匹配'
);

const summary = summarizeInspectionBatches(batches, {
  now: '2026-04-16T10:00:00.000Z',
  timeZone: 'Asia/Shanghai'
});
assert.deepStrictEqual(summary, {
  total_batches: 3,
  total_measurements: 4,
  today_batches: 3,
  normal_batches: 1,
  abnormal_batches: 1,
  undetermined_batches: 1,
  temp_abnormal_records: 1,
  rh_abnormal_records: 0,
  latest_batch_no: '2026041603'
});

const defaultRange = resolveInspectionRange({}, {
  now: '2026-06-24T12:00:00.000Z'
});
assert.deepStrictEqual(defaultRange, {
  startMs: Date.parse('2026-05-24T12:00:00.000Z'),
  endMs: Date.parse('2026-06-24T12:00:00.000Z')
});

assert.strictEqual(
  resolveInspectionRange({ range: 'all' }, {
    now: '2026-06-24T12:00:00.000Z'
  }),
  null,
  '显式全量查询不应套用默认24小时范围'
);

assert.deepStrictEqual(
  buildInspectionScanRange(defaultRange, {
    gapMinutes: 30,
    timeZoneOffsetHours: 8
  }),
  {
    startMs: Date.parse('2026-05-23T15:30:00.000Z'),
    endMs: Date.parse('2026-06-24T12:00:00.000Z')
  },
  '扫描起点应回退到开始日期的上海零点前30分钟，以保持批次号稳定'
);
assert.deepStrictEqual(
  buildInspectionBatchLookupRange('2026042001'),
  {
    startMs: Date.parse('2026-04-19T15:30:00.000Z'),
    endMs: Date.parse('2026-04-21T16:00:00.000Z')
  },
  '批次详情只应扫描批次日期附近的数据'
);
assert.strictEqual(buildInspectionBatchLookupRange('invalid'), null);

const largeMeasurements = Array.from({ length: 1200 }, (_, index) => ({
  id: index + 1,
  device_id: 'go2-large',
  ts: new Date(Date.parse('2026-04-20T07:00:00.000Z') + index * 1000).toISOString(),
  temp_c: 24 + (index % 10) / 10,
  rh: 60 + (index % 5),
  pose_source: 'go2_slam',
  pose_fix: 1,
  pos_x: index / 10,
  pos_y: 2,
  pos_z: 0,
  yaw: 0,
  matched_point_id: index % 2 === 0 ? 'A1' : 'A2',
  matched_point_name: index % 2 === 0 ? 'A1区' : 'A2区',
  temp_abnormal: false,
  rh_abnormal: false,
  covered_by_rule: true
}));
const detailPayload = buildInspectionBatchDetailPayload({
  batch_no: '2026042001',
  sample_count: largeMeasurements.length,
  measurements: largeMeasurements
}, {
  points,
  trendLimit: 300,
  trailLimit: 500,
  measurementLimit: 100
});
assert.strictEqual(detailPayload.batch.measurements, undefined);
assert.strictEqual(detailPayload.trend.length, 300);
assert.strictEqual(detailPayload.measurements.length, 100);
assert.strictEqual(detailPayload.actual_trail.length, 500);
assert.strictEqual(detailPayload.point_readings.length, 2);
assert.strictEqual(detailPayload.measurements[0].id, 1101);
assert.strictEqual(detailPayload.measurements.at(-1).id, 1200);

console.log('inspection-batches: OK');
