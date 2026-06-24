import assert from 'node:assert/strict';

import {
  formatDuration,
  getInspectionStatusMeta,
  sampleMeasurements
} from '../src/lib/inspection.js';

assert.equal(formatDuration(76), '1分16秒');
assert.equal(formatDuration(0), '0秒');
assert.equal(formatDuration(null), '--');

assert.deepEqual(getInspectionStatusMeta('undetermined'), {
  label: '未判定',
  className: 'undetermined'
});
assert.deepEqual(getInspectionStatusMeta('abnormal'), {
  label: '存在异常',
  className: 'warning'
});

const sampled = sampleMeasurements(
  Array.from({ length: 10 }, (_, index) => ({ id: index })),
  4
);
assert.equal(sampled.length, 4);
assert.equal(sampled[0].id, 0);
assert.equal(sampled.at(-1).id, 9);

console.log('inspection-utils: OK');
