const assert = require('assert');

const { buildSlamArea } = require('../src/slam-config');

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

console.log('slam-config: OK');
