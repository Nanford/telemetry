import assert from 'node:assert/strict';

import {
  buildTrailSegments,
  computeEqualRatioProjection,
  computeInspectionMapLayout,
  computeMapGridStep,
  createDefaultInspectionRange,
  formatDuration,
  getInspectionStatusMeta,
  sampleMeasurements
} from '../src/lib/inspection.js';

assert.equal(formatDuration(76), '1分16秒');
assert.equal(formatDuration(0), '0秒');
assert.equal(formatDuration(null), '--');

assert.deepEqual(
  createDefaultInspectionRange(new Date('2026-06-24T12:00:00+08:00')),
  {
    start: '2026-05-24T12:00',
    end: '2026-06-24T12:00'
  }
);

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

const inferredLayout = computeInspectionMapLayout({
  area: { name: '未配置尺寸楼层' },
  points: [
    { id: 'A1', x: 120, y: 42 },
    { id: 'A2', x: 180, y: 58 }
  ],
  trail: [
    { pos_x: 110, pos_y: 40 },
    { pos_x: 196, pos_y: 62 }
  ]
});
assert.equal(inferredLayout.source, 'inferred');
assert.ok(inferredLayout.bounds.minX < 110);
assert.ok(inferredLayout.bounds.maxX > 196);
assert.ok(inferredLayout.bounds.minY < 40);
assert.ok(inferredLayout.bounds.maxY > 62);
assert.ok(inferredLayout.canvas.height >= 450);
assert.ok(inferredLayout.canvas.height <= 700);

const horizontalLayout = computeInspectionMapLayout({
  points: [
    { id: 'A1', x: 2, y: 1.8 },
    { id: 'A5', x: 18, y: 2 }
  ]
});
assert.equal(horizontalLayout.canvas.height, 450);
assert.equal(computeMapGridStep(20), 1);
assert.equal(computeMapGridStep(1000), 25);

const configuredLayout = computeInspectionMapLayout({
  area: { width: 38, height: 24 },
  points: [{ id: 'A1', x: 2, y: 2 }],
  trail: []
});
assert.equal(configuredLayout.source, 'configured');
assert.deepEqual(configuredLayout.bounds, {
  minX: 0,
  minY: 0,
  maxX: 38,
  maxY: 24
});

const emptyLayout = computeInspectionMapLayout({
  area: {},
  points: [],
  trail: []
});
assert.equal(emptyLayout.source, 'empty');
assert.equal(emptyLayout.bounds, null);

// buildTrailSegments —— 连续、平稳的一段不断开
const secondsApart = (base, seconds) =>
  new Date(base.getTime() + seconds * 1000).toISOString();
const trailBase = new Date('2026-07-22T02:19:00Z');
const smoothTrail = [
  { ts: secondsApart(trailBase, 0), pos_x: 1, pos_y: 1 },
  { ts: secondsApart(trailBase, 6), pos_x: 1.5, pos_y: 1 },
  { ts: secondsApart(trailBase, 12), pos_x: 2, pos_y: 1.2 }
];
const smoothSegments = buildTrailSegments(smoothTrail);
assert.equal(smoothSegments.length, 1);
assert.equal(smoothSegments[0].length, 3);

// 规则1：时间差 > maxGapMs（默认 30s）断档
const gappedTrail = [
  { ts: secondsApart(trailBase, 0), pos_x: 1, pos_y: 1 },
  { ts: secondsApart(trailBase, 6), pos_x: 1.5, pos_y: 1 },
  { ts: secondsApart(trailBase, 120), pos_x: 2, pos_y: 1 },
  { ts: secondsApart(trailBase, 126), pos_x: 2.5, pos_y: 1 }
];
const gappedSegments = buildTrailSegments(gappedTrail);
assert.equal(gappedSegments.length, 2);
assert.equal(gappedSegments[0].length, 2);
assert.equal(gappedSegments[1].length, 2);

// 规则2：速度 > maxSpeedMps（默认 2m/s）断开位姿跳变
const jumpTrail = [
  { ts: secondsApart(trailBase, 0), pos_x: 1, pos_y: 1 },
  { ts: secondsApart(trailBase, 2), pos_x: 1.2, pos_y: 1 },   // 0.1 m/s，正常
  { ts: secondsApart(trailBase, 4), pos_x: 15, pos_y: 1 },    // 6.9 m/s，跳变
  { ts: secondsApart(trailBase, 6), pos_x: 15.2, pos_y: 1 }
];
const jumpSegments = buildTrailSegments(jumpTrail);
assert.equal(jumpSegments.length, 2);
assert.equal(jumpSegments[0].length, 2);
assert.equal(jumpSegments[1].length, 2);

// 规则3：出界点丢弃且两侧不跨洞相连；无效坐标同理
const boundedTrail = [
  { ts: secondsApart(trailBase, 0), pos_x: 1, pos_y: 1 },
  { ts: secondsApart(trailBase, 6), pos_x: 50, pos_y: 50 },   // 出界，丢弃并断段
  { ts: secondsApart(trailBase, 12), pos_x: 2, pos_y: 1 },
  { ts: secondsApart(trailBase, 18), pos_x: NaN, pos_y: 1 },  // 无效坐标，丢弃并断段
  { ts: secondsApart(trailBase, 24), pos_x: 3, pos_y: 1 }
];
const boundedSegments = buildTrailSegments(boundedTrail, {
  bounds: { minX: 0, minY: 0, maxX: 20, maxY: 12 }
});
assert.equal(boundedSegments.length, 3);
assert.equal(boundedSegments.flat().length, 3);
assert.deepEqual(boundedSegments.map((segment) => segment.length), [1, 1, 1]);

assert.deepEqual(buildTrailSegments([]), []);

// computeEqualRatioProjection —— 单位正方形投影到 100×100 屏幕方块
const squareProjection = computeEqualRatioProjection(
  { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  { x: 0, width: 100, top: 0, bottom: 100 }
);
assert.equal(squareProjection.scale, 100);
assert.equal(squareProjection.projectX(0), 0);
assert.equal(squareProjection.projectX(1), 100);
assert.equal(squareProjection.projectY(0), 100);   // 真实 y 最小 → 屏幕底部
assert.equal(squareProjection.projectY(1), 0);     // 真实 y 最大 → 屏幕顶部

// 宽扁坐标投影到方块：受高度限制取小 scale，并在竖直方向居中（等比、不拉伸）
const wideProjection = computeEqualRatioProjection(
  { minX: 0, minY: 0, maxX: 2, maxY: 1 },
  { x: 0, width: 100, top: 0, bottom: 100 }
);
assert.equal(wideProjection.scale, 50);
assert.equal(wideProjection.projectX(0), 0);
assert.equal(wideProjection.projectX(2), 100);
assert.equal(wideProjection.projectY(0), 75);      // 底边居中上移 (100-50)/2
assert.equal(wideProjection.projectY(1), 25);

console.log('inspection-utils: OK');
