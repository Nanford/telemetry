/**
 * INPUT: backend/src/calibration.js;临时 calibration.json 文件(用 SLAM_CALIBRATION_FILE 指向)
 * OUTPUT: 断言通过则静默退出 0,否则抛错。挂在 npm test 上。
 * POS: 标定变换的回归测试。重点守住三件事:
 *      1) 未标定/坏文件时必须恒等 —— 否则会静默篡改所有历史轨迹
 *      2) 旧版扁平 {theta,tx,ty} 必须行为不变 —— 老部署升级不能翻车
 *      3) 尺度项必须真的生效 —— 用 2026-07-23 现场三张照片的真值锚点做夹具,
 *         这组数据是唯一有现场真值的标定样本,弄丢了就再也复现不了
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAL_PATH = path.join(os.tmpdir(), `cal-test-${process.pid}.json`);
process.env.SLAM_CALIBRATION_FILE = CAL_PATH;

const { loadCalibration, calibrationFor, applyCalibration, IDENTITY } = require('../src/calibration');

const writeCal = (obj) => fs.writeFileSync(CAL_PATH, JSON.stringify(obj), 'utf-8');
const rmCal = () => { try { fs.unlinkSync(CAL_PATH); } catch (_e) { /* 本就不存在 */ } };
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: 实得 ${actual}, 期望 ${expected}±${tol}`);

// ---- 1. 无标定文件 → 恒等,坐标原样返回 ----
rmCal();
{
  const book = loadCalibration();
  assert.deepStrictEqual(book, { default: null, areas: {} }, '缺文件应得空册');
  assert.deepStrictEqual(calibrationFor(book, 'A-4-1'), IDENTITY, '空册应回落恒等');
  assert.deepStrictEqual(applyCalibration(3.5, -2.25, book, 'A-4-1'), [3.5, -2.25], '未标定必须零行为改变');
}

// ---- 2. 坏文件也必须恒等,不能抛 ----
fs.writeFileSync(CAL_PATH, '{ 这不是 json', 'utf-8');
assert.deepStrictEqual(applyCalibration(1, 2, loadCalibration(), 'A-4-1'), [1, 2], '坏文件应退化为恒等');

// ---- 3. 旧版扁平格式:迁到 default,scale 补 1,数值与老实现一致 ----
{
  const theta = 0.5;
  writeCal({ theta, tx: 10, ty: -4 });
  const book = loadCalibration();
  assert.strictEqual(book.default.scale, 1, '旧格式 scale 应补 1');
  const [x, y] = applyCalibration(2, 3, book, 'A-4-1');
  // 老实现: [cosθ·x - sinθ·y + tx, sinθ·x + cosθ·y + ty]
  near(x, Math.cos(theta) * 2 - Math.sin(theta) * 3 + 10, 1e-12, '旧格式 x 必须逐位一致');
  near(y, Math.sin(theta) * 2 + Math.cos(theta) * 3 - 4, 1e-12, '旧格式 y 必须逐位一致');
  // 旧格式无分区概念,任何 area 都应命中同一个 default
  assert.deepStrictEqual(applyCalibration(2, 3, book, 'A-1-2'), [x, y], '旧格式应对所有区域一致');
}

// ---- 4. 按区域取值:各区域互不干扰,未知区域回落 default,无 default 则恒等 ----
{
  writeCal({
    areas: { 'A-4-1': { theta: 0, scale: 2, tx: 1, ty: 1 } },
    default: { theta: 0, scale: 1, tx: 100, ty: 100 }
  });
  const book = loadCalibration();
  assert.deepStrictEqual(applyCalibration(5, 5, book, 'A-4-1'), [11, 11], 'A-4-1 应用自己的变换');
  assert.deepStrictEqual(applyCalibration(5, 5, book, 'A-1-2'), [105, 105], '未知区域应回落 default');

  writeCal({ areas: { 'A-4-1': { theta: 0, scale: 2, tx: 1, ty: 1 } } });
  const noDefault = loadCalibration();
  assert.deepStrictEqual(applyCalibration(5, 5, noDefault, 'A-1-2'), [5, 5], '无 default 应恒等');
}

// ---- 5. 非法条目被剔除,且不牵连同册其他区域 ----
{
  writeCal({
    areas: {
      'A-4-1': { theta: 0, scale: 2, tx: 0, ty: 0 },
      'BAD-scale-0': { theta: 0, scale: 0, tx: 0, ty: 0 },
      'BAD-scale-neg': { theta: 0, scale: -1, tx: 0, ty: 0 },
      'BAD-nan': { theta: 'x', tx: 0, ty: 0 }
    }
  });
  const book = loadCalibration();
  assert.deepStrictEqual(Object.keys(book.areas), ['A-4-1'], '非法条目应被剔除且不影响合法条目');
  assert.deepStrictEqual(applyCalibration(1, 1, book, 'BAD-scale-0'), [1, 1], '非法区域应回落恒等');
}

// ---- 6. 坐标非数时原样返回,不能被静默改写成 0 ----
{
  writeCal({ areas: { 'A-4-1': { theta: 1, scale: 2, tx: 3, ty: 4 } } });
  const book = loadCalibration();
  assert.deepStrictEqual(applyCalibration(null, 5, book, 'A-4-1'), [null, 5], 'null 坐标应原样返回');
  assert.deepStrictEqual(applyCalibration(5, undefined, book, 'A-4-1'), [5, undefined], 'undefined 同理');
}

// ---- 7. 现场真值夹具:2026-07-23 A-4-1 三张照片锚点 ----
// solve_calibration.py 用这三点解出的相似变换;若谁把 scale 项删了,这里立刻炸。
{
  const SOLVED = { theta: 0.907367433, scale: 1.35405854, tx: 37.8488, ty: 39.7158 };
  const ANCHORS = [
    { id: 'A-4-1-17', slam: [-27.711517, 11.649051], cad: [2.210, 19.850] },
    { id: 'A-4-1-18', slam: [-26.126020, 9.575457], cad: [5.990, 19.850] },
    { id: 'A-4-1-20', slam: [-21.795494, 4.068937], cad: [15.295, 19.850] }
  ];

  writeCal({ areas: { 'A-4-1': SOLVED } });
  const book = loadCalibration();
  for (const a of ANCHORS) {
    const [x, y] = applyCalibration(a.slam[0], a.slam[1], book, 'A-4-1');
    const err = Math.hypot(x - a.cad[0], y - a.cad[1]);
    assert.ok(err <= 0.15, `${a.id} 标定后残差应 ≤0.15 m, 实得 ${err.toFixed(3)} m`);
  }

  // 反证:把 scale 锁回 1(纯刚体),同样三点必然对不齐 —— 这就是当初加尺度项的理由
  writeCal({ areas: { 'A-4-1': { ...SOLVED, scale: 1, tx: 29.999941, ty: 34.521297 } } });
  const rigid = loadCalibration();
  const worst = Math.max(...ANCHORS.map((a) => {
    const [x, y] = applyCalibration(a.slam[0], a.slam[1], rigid, 'A-4-1');
    return Math.hypot(x - a.cad[0], y - a.cad[1]);
  }));
  assert.ok(worst > 1.0, `纯刚体对同组锚点最大残差应 >1 m(实测 1.9 m), 实得 ${worst.toFixed(3)} m`);
}

rmCal();
console.log('test-calibration: 全部断言通过');
