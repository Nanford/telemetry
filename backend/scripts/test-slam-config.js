const assert = require('assert');

const { buildSlamArea } = require('../src/slam-config');
const config = require('../src/config');
const cadLayout = require('../../A41_CAD_LAYOUT.json');

assert.deepStrictEqual(
  buildSlamArea({}),
  {
    area_id: 'warehouse_1f',
    name: '一楼仓库'
  },
  '未配置楼层尺寸时不应回退为20×6'
);

assert.deepStrictEqual(
  buildSlamArea({
    SLAM_AREA_ID: 'warehouse_3f',
    SLAM_AREA_NAME: 'A栋3层',
    SLAM_AREA_WIDTH: '38.5',
    SLAM_AREA_HEIGHT: '24'
  }),
  {
    area_id: 'warehouse_3f',
    name: 'A栋3层',
    width: 38.5,
    height: 24
  }
);

assert.deepStrictEqual(
  buildSlamArea({
    SLAM_AREA_WIDTH: 'invalid',
    SLAM_AREA_HEIGHT: '-2'
  }),
  {
    area_id: 'warehouse_1f',
    name: '一楼仓库'
  }
);

assert.deepStrictEqual(
  config.slam.area,
  {
    area_id: 'A-4-1',
    name: 'A-4-1 仓间（A4 左下）',
    description: 'A4 区左下仓间，巡检由东门进入',
    width: 55.99,
    height: 36.35,
    aisle: { y0: 16.85, y1: 20.85 },
    door: { x: 55.99, y: 18.9, width: 4, wall: 'east', label: '东门' },
    orientation: { north: 'top', entrance: 'east' },
    cad: {
      source: '18.9.21-B101、B103醇化加工库（编号图）.dwg',
      version: 'AC1027',
      origin_mm: { x: 734317.54, y: -23871.12 },
      coordinate_system: 'southwest-local-meters'
    }
  },
  '默认巡检区域必须与 A4 左下仓间 CAD 一致'
);

const bayPoints = config.slam.points.filter((point) => point.kind === 'bay');
assert.strictEqual(bayPoints.length, 22, 'A-4-1 CAD 应包含 22 个垛位');
assert.strictEqual(config.slam.points.length, 22, '现场通道采样点将在真实数据到齐后单独补充');

assert.deepStrictEqual(
  [...bayPoints]
    .sort((a, b) => a.patrol_seq - b.patrol_seq)
    .map((point) => point.id),
  [
    'A-4-1-06', 'A-4-1-07', 'A-4-1-08', 'A-4-1-09', 'A-4-1-10', 'A-4-1-11',
    'A-4-1-12', 'A-4-1-13', 'A-4-1-14', 'A-4-1-15', 'A-4-1-16',
    'A-4-1-17', 'A-4-1-18', 'A-4-1-19', 'A-4-1-20', 'A-4-1-21', 'A-4-1-22',
    'A-4-1-01', 'A-4-1-02', 'A-4-1-03', 'A-4-1-04', 'A-4-1-05'
  ],
  'A-4-1 预设路线必须从东门进入，南排东到西、北排西到东（2026-07-23 现场照片真值确认）'
);

const point01 = bayPoints.find((point) => point.id === 'A-4-1-01');
assert.deepStrictEqual(
  point01,
  {
    id: 'A-4-1-01',
    name: '垛位 01',
    x: 33.895,
    y: 19.85,
    radius: 0.9,
    kind: 'bay',
    row: 'N',
    patrol_seq: 18,
    bay: { x0: 32.385, y0: 20.85, x1: 35.405, y1: 35.35 }
  },
  '现场所称 A4-1-1 区必须对应 CAD 中的 A-4-1-01'
);

assert.deepStrictEqual(
  cadLayout.patrol_route,
  [...bayPoints].sort((a, b) => a.patrol_seq - b.patrol_seq).map((point) => point.id),
  'A41_CAD_LAYOUT.json 与后端巡检顺序不能漂移'
);
assert.strictEqual(cadLayout.stacks.length, bayPoints.length, 'CAD 参考文件必须覆盖全部垛位');
assert.deepStrictEqual(
  cadLayout.room.door,
  config.slam.area.door,
  'CAD 参考文件与接口返回的东门配置必须一致'
);

console.log('slam-config: OK');
