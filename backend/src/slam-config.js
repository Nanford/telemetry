const positiveNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const buildSlamArea = (env = process.env) => {
  const area = {
    area_id: env.SLAM_AREA_ID || 'warehouse_1f',
    name: env.SLAM_AREA_NAME || '一楼仓库'
  };
  const width = positiveNumber(env.SLAM_AREA_WIDTH);
  const height = positiveNumber(env.SLAM_AREA_HEIGHT);

  if (width !== null && height !== null) {
    area.width = width;
    area.height = height;
  }

  return area;
};

module.exports = { buildSlamArea };
