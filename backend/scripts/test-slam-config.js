const assert = require('assert');

const { buildSlamArea } = require('../src/slam-config');
const config = require('../src/config');

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

const aislePoints = config.slam.points.filter((point) => point.kind === 'aisle');
assert.deepStrictEqual(
  aislePoints.map(({ id, x, y, row, between }) => ({ id, x, y, row, between })),
  [
    { id: 'A-1-2-C01', x: 8.75, y: 28.7, row: 'N', between: ['08', '09'] },
    { id: 'A-1-2-C02', x: 27.35, y: 28.7, row: 'N', between: ['12', '13'] },
    { id: 'A-1-2-C03', x: 36.65, y: 28.7, row: 'N', between: ['14', '15'] },
    { id: 'A-1-2-C04', x: 45.95, y: 28.7, row: 'N', between: ['16', '17'] },
    { id: 'A-1-2-C05', x: 8.75, y: 10.8, row: 'S', between: ['05', '04'] },
    { id: 'A-1-2-C06', x: 18.05, y: 10.8, row: 'S', between: ['03', '02'] },
    { id: 'A-1-2-C07', x: 36.65, y: 10.8, row: 'S', between: ['23', '22'] },
    { id: 'A-1-2-C08', x: 45.95, y: 10.8, row: 'S', between: ['21', '20'] }
  ],
  '垛间通道点必须位于对应上下排垛体纵向中部，不能回到中央走廊'
);

console.log('slam-config: OK');
