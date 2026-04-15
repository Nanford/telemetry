const now = new Date();

const makeSeries = (count, baseTemp = 18, baseRh = 45) =>
  Array.from({ length: count }, (_, idx) => {
    const t = new Date(now.getTime() - (count - 1 - idx) * 60 * 60 * 1000);
    const wave = Math.sin(idx / 3) * 1.2;
    return {
      ts: t.toISOString(),
      temp_c: Number((baseTemp + wave + Math.random() * 0.6).toFixed(2)),
      rh: Number((baseRh + wave * 2 + Math.random() * 1.2).toFixed(2))
    };
  });

const makeHourly = () =>
  makeSeries(24).map((item) => ({
    ts: item.ts,
    temp_avg: item.temp_c,
    temp_min: item.temp_c - 0.6,
    temp_max: item.temp_c + 0.8,
    rh_avg: item.rh,
    rh_min: item.rh - 1.2,
    rh_max: item.rh + 1.3
  }));

export const mockOverview = {
  summary: {
    temp_avg: 18.6,
    temp_min: 16.9,
    temp_max: 20.4,
    rh_avg: 46.8,
    rh_min: 42.2,
    rh_max: 52.7
  },
  zones: [
    {
      zone_id: 'A1',
      name: '原料接收区 A1',
      description: '烟叶原料进场、质检区域',
      latest: { temp_c: 18.4, rh: 62, ts: now.toISOString() },
      status: 'ok',
      status_reason: '稳定'
    },
    {
      zone_id: 'A2',
      name: '初加工区 A2',
      description: '分拣、预处理车间',
      latest: { temp_c: 20.7, rh: 68, ts: now.toISOString() },
      status: 'alert',
      status_reason: '湿度偏高'
    },
    {
      zone_id: 'A3',
      name: '醇化仓库 A3',
      description: '核心储存区，温湿度重点监控',
      latest: { temp_c: 19.2, rh: 58, ts: now.toISOString() },
      status: 'ok',
      status_reason: '运行正常'
    },
    {
      zone_id: 'A4',
      name: '成品仓库 A4',
      description: '醇化完成品存放区',
      latest: { temp_c: 17.8, rh: 55, ts: now.toISOString() },
      status: 'ok',
      status_reason: '运行正常'
    },
    {
      zone_id: 'A5',
      name: '装卸调度区 A5',
      description: '出库装车、物流调度区',
      latest: null,
      status: 'offline',
      status_reason: '无最新数据'
    }
  ]
};

export const mockInsights = {
  temp_alerts: 5,
  rh_alerts: 2,
  link_stability: 96.4
};

export const mockHealth = {
  mqtt_status: 'online',
  write_delay_sec: 0.3,
  pending_alerts: 2
};

export const mockTrend = {
  granularity: 'raw',
  series: makeSeries(36)
};

export const mockAlerts = [
  {
    id: 301,
    rule_id: 12,
    zone_id: 'A2',
    sensor_id: 'pi4-001-A2',
    level: 'warning',
    status: 'open',
    first_trigger_at: new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
    last_trigger_at: now.toISOString(),
    metric: 'rh',
    current_value: 68,
    message: '湿度超上限'
  },
  {
    id: 288,
    rule_id: 7,
    zone_id: 'A1',
    sensor_id: 'pi4-001-A1',
    level: 'critical',
    status: 'acked',
    first_trigger_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    last_trigger_at: new Date(now.getTime() - 65 * 60 * 1000).toISOString(),
    metric: 'temp',
    current_value: 22,
    message: '温度持续偏高'
  }
];

export const mockRules = [
  {
    id: 12,
    name: '原料区湿度上限',
    scope_type: 'zone',
    zone_id: 'A2',
    temp_high: 24,
    temp_low: null,
    rh_high: 65,
    rh_low: null,
    trigger_duration_sec: 60,
    recover_duration_sec: 60,
    enabled: 1
  },
  {
    id: 7,
    name: '原料区温湿度阈值',
    scope_type: 'zone',
    zone_id: 'A1',
    temp_high: 24,
    temp_low: 16,
    rh_high: 62,
    rh_low: 45,
    trigger_duration_sec: 120,
    recover_duration_sec: 120,
    enabled: 1
  }
];

export const mockGeoLatest = [
  {
    device_id: 'pi4-001',
    zone_id: 'A3',
    lat: 30.681732,
    lon: 114.183271,
    alt_m: 92.1,
    speed_kmh: 0,
    ts: now.toISOString(),
    gps_fix: 1
  },
  {
    device_id: 'pi4-002',
    zone_id: null,
    lat: 30.681850,
    lon: 114.183500,
    alt_m: 91.5,
    speed_kmh: 0.4,
    ts: now.toISOString(),
    gps_fix: 1
  }
];

export const mockGeofences = [
  {
    zone_id: 'A1',
    name: '原料接收区 A1',
    description: '烟叶原料进场、质检区域',
    min_lat: 30.681507,
    max_lat: 30.681957,
    min_lon: 114.182641,
    max_lon: 114.182891,
    priority: 1
  },
  {
    zone_id: 'A2',
    name: '初加工区 A2',
    description: '分拣、预处理车间',
    min_lat: 30.681507,
    max_lat: 30.681957,
    min_lon: 114.182891,
    max_lon: 114.183141,
    priority: 1
  },
  {
    zone_id: 'A3',
    name: '醇化仓库 A3',
    description: '核心储存区，温湿度重点监控',
    min_lat: 30.681507,
    max_lat: 30.681957,
    min_lon: 114.183141,
    max_lon: 114.183401,
    priority: 1
  },
  {
    zone_id: 'A4',
    name: '成品仓库 A4',
    description: '醇化完成品存放区',
    min_lat: 30.681507,
    max_lat: 30.681957,
    min_lon: 114.183401,
    max_lon: 114.183651,
    priority: 1
  },
  {
    zone_id: 'A5',
    name: '装卸调度区 A5',
    description: '出库装车、物流调度区',
    min_lat: 30.681507,
    max_lat: 30.681957,
    min_lon: 114.183651,
    max_lon: 114.183901,
    priority: 1
  }
];

export const mockDevices = [
  {
    device_id: 'pi4-001',
    name: '机动巡检终端',
    status: 'active',
    last_seen_at: now.toISOString()
  },
  {
    device_id: 'pi4-002',
    name: '备用巡检终端',
    status: 'active',
    last_seen_at: now.toISOString()
  }
];

export const mockZones = [
  { zone_id: 'A1', name: '原料接收区 A1', description: '烟叶原料进场、质检区域' },
  { zone_id: 'A2', name: '初加工区 A2', description: '分拣、预处理车间' },
  { zone_id: 'A3', name: '醇化仓库 A3', description: '核心储存区，温湿度重点监控' },
  { zone_id: 'A4', name: '成品仓库 A4', description: '醇化完成品存放区' },
  { zone_id: 'A5', name: '装卸调度区 A5', description: '出库装车、物流调度区' }
];

export const mockSensors = [
  { sensor_id: 'pi4-001-A1', device_id: 'pi4-001', zone_id: 'A1', type: 'DHT11' },
  { sensor_id: 'pi4-001-B2', device_id: 'pi4-001', zone_id: 'B2', type: 'DHT11' }
];

export const mockHourlySeries = makeHourly();
