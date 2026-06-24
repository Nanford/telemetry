const DEMO_POINTS = [
  { id: 'A1', x: 2.1, y: 1.8, temp_c: 24.2, rh: 61.0 },
  { id: 'A2', x: 6.4, y: 2.0, temp_c: 24.8, rh: 63.0 },
  // A3湿度高于当前规则上限，用于验证异常批次和橙色数据气泡。
  { id: 'A3', x: 10.2, y: 2.1, temp_c: 25.1, rh: 82.0 },
  { id: 'A4', x: 14.0, y: 2.0, temp_c: 24.6, rh: 64.0 },
  { id: 'A5', x: 17.8, y: 1.9, temp_c: 24.4, rh: 62.0 }
];

const buildDemoInspectionReadings = ({
  deviceId,
  startedAtMs = Date.now()
}) => DEMO_POINTS.map((point, index) => ({
  device_id: deviceId,
  sensor_id: `${deviceId}-${point.id}`,
  zone_id: point.id,
  area_id: 'warehouse_1f',
  ts: Math.floor((startedAtMs + index * 1000) / 1000),
  temp_c: point.temp_c,
  rh: point.rh,
  gps: {
    fix: false,
    lat: null,
    lon: null,
    fallback: false
  },
  pose: {
    source: 'go2_slam',
    frame: 'map',
    fix: true,
    x: point.x,
    y: point.y,
    z: 0,
    yaw: 0
  },
  point_id: point.id,
  sample_type: 'point_valid',
  errors: []
}));

const parseDemoArgs = (argv) => {
  const result = {
    deviceId: `go2-demo-${Date.now()}`,
    intervalMs: 1000,
    dryRun: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--device-id' && argv[index + 1]) {
      result.deviceId = argv[index + 1];
      index += 1;
    } else if (arg === '--interval-ms' && argv[index + 1]) {
      const interval = Number(argv[index + 1]);
      if (!Number.isFinite(interval) || interval < 0) {
        throw new Error('--interval-ms 必须是大于等于0的数字');
      }
      result.intervalMs = interval;
      index += 1;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else {
      throw new Error(`不支持的参数: ${arg}`);
    }
  }

  return result;
};

module.exports = {
  buildDemoInspectionReadings,
  parseDemoArgs
};
