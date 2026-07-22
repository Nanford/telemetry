const dotenv = require('dotenv');
const { buildSlamArea } = require('./slam-config');

dotenv.config();

const toNumber = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

// =====================================================================
// A-1-2 库房真实几何 —— 来源: CAD《18.9.21-B101、B103醇化加工库(编号图)》(AC1027)
// 坐标系: 原点=西墙内表面 × 南墙内表面(西南角); +x 向东(沿走道), +y 向北; 单位米。
// CAD 毫米换算: x=(X-199910)/1000, y=(Y-20879)/1000。
// 房间内净 55.99(东西) × 36.35(南北)。中央走道 4.0m 带 y∈[18.05,22.05](中线 20.05)。
// 上排(北) 12 垛 07→18, 垛体 y∈[22.05,35.35](深 13.3); 下排(南) 11 垛 06→01—门—23→19,
// 垛体 y∈[3.55,18.05](深 14.5); 垛宽 3.02。采集点落在走道内、距垛面 1.0m 的两条车道:
// 北车道 y=21.05, 南车道 y=19.05, 半径 0.9(同排相邻≥3.78m、对面车道 2.0m, 圈不重叠)。
// 南墙正中 4m 门(含门斗) x=30.5, 正对下排 01/23 缺口 —— 巡检唯一进出口。
// 注意: 坐标是 CAD 相对系(真实比例), 尚未与 Go2 SLAM 系标定; 现场标定后按 id 平移+旋转替换。
// =====================================================================
const A12_BAY_W = 3.02;                          // 垛宽(m)
const A12_AISLE = { y0: 18.05, y1: 22.05, mid: 20.05 }; // 中央走道 y 带 + 中线
const A12_BAND = { N: { y0: 22.05, y1: 35.35 }, S: { y0: 3.55, y1: 18.05 } }; // 上/下排垛体 y 带
const A12_LANE = { N: 21.05, S: 19.05 };         // 上/下排采集车道 y
const A12_RADIUS = 0.9;                          // 匹配半径(m)
const A12_DOOR = { x: 30.5, y: 0, width: 4.0, wall: 'south' };

const round2 = (v) => Math.round(v * 100) / 100;

// 垛体矩形由 垛中心 x + 排 推导(垛宽/垛深按排统一) —— 无需逐垛存, 且自动规整脏数据。
const bayRect = (x, row) => {
  const band = A12_BAND[row];
  return { x0: round2(x - A12_BAY_W / 2), y0: band.y0, x1: round2(x + A12_BAY_W / 2), y1: band.y1 };
};

// [垛号, 垛中心 x(m, CAD 实测), 排] —— 排 N=上/北, S=下/南
const A12_BAYS = [
  ['07', 2.21, 'N'], ['08', 5.99, 'N'], ['09', 11.505, 'N'], ['10', 15.295, 'N'],
  ['11', 20.805, 'N'], ['12', 24.595, 'N'], ['13', 30.105, 'N'], ['14', 33.895, 'N'],
  ['15', 39.405, 'N'], ['16', 43.195, 'N'], ['17', 48.705, 'N'], ['18', 52.52, 'N'],
  ['06', 2.21, 'S'], ['05', 5.99, 'S'], ['04', 11.505, 'S'], ['03', 15.295, 'S'],
  ['02', 20.805, 'S'], ['01', 24.595, 'S'],
  ['23', 33.895, 'S'], ['22', 39.405, 'S'], ['21', 43.195, 'S'], ['20', 48.705, 'S'], ['19', 52.52, 'S']
];

// 巡检顺序: 上排东→西(seq 1-12), 下排西→东(seq 13-23) —— 与现场遥控单程路线一致。
const a12PatrolOrder = [
  ...A12_BAYS.filter(([, , r]) => r === 'N').sort((a, b) => b[1] - a[1]),
  ...A12_BAYS.filter(([, , r]) => r === 'S').sort((a, b) => a[1] - b[1])
].map(([num]) => num);

const a12BayPoints = A12_BAYS.map(([num, x, row]) => ({
  id: `A-1-2-${num}`,
  name: `垛${num}`,
  x,
  y: A12_LANE[row],
  radius: A12_RADIUS,
  kind: 'bay',
  row,
  patrol_seq: a12PatrolOrder.indexOf(num) + 1,
  bay: bayRect(x, row)
}));

// 巷道采集点 C01→C11: 相邻上排垛列中点、落在走道中线, 供狗在走道在途采样归属房间。
const a12NorthXs = A12_BAYS.filter(([, , r]) => r === 'N').map(([, x]) => x).sort((a, b) => a - b);
const a12AislePoints = a12NorthXs.slice(0, -1).map((x, index) => {
  const seq = index + 1;
  const tag = String(seq).padStart(2, '0');
  return {
    id: `A-1-2-C${tag}`,
    name: `巷${tag}`,
    x: round2((x + a12NorthXs[index + 1]) / 2),
    y: A12_AISLE.mid,
    radius: A12_RADIUS,
    kind: 'aisle',
    patrol_seq: a12BayPoints.length + seq
  };
});

const config = {
  port: toNumber(process.env.PORT, 8080),
  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: toNumber(process.env.MYSQL_PORT, 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'warehouse_iot',
    connectionLimit: toNumber(process.env.MYSQL_POOL_LIMIT, 10),
    timezone: 'Z'
  },
  mqtt: {
    url: process.env.MQTT_URL || 'mqtt://127.0.0.1:1883',
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    topic: process.env.MQTT_TOPIC || 'devices/+/+/telemetry,devices/+/telemetry',
    clientId: process.env.MQTT_CLIENT_ID || `telemetry-api-${Math.random().toString(16).slice(2)}`
  },
  slam: {
    // A-1-2 一间房(非整层)。默认尺寸=CAD 实测内净; env(SLAM_AREA_WIDTH/HEIGHT) 可覆盖,
    // 但改真实场地务必同步这里, 否则前端画布比例与垛位坐标不一致。
    // door/aisle 供前端画南门与真实 4m 走道带(不再靠点位反推)。
    area: {
      width: 55.99,
      height: 36.35,
      ...buildSlamArea(process.env),
      area_id: 'A-1-2',
      name: 'A-1-2 库房',
      aisle: { y0: A12_AISLE.y0, y1: A12_AISLE.y1 },
      door: A12_DOOR
    },
    // 23 垛位(kind:'bay', 带垛体矩形 bay + 排 row + 巡检序 patrol_seq) + 11 巷道点(kind:'aisle')。
    // 详见上方 A-1-2 几何常量说明。
    points: [...a12BayPoints, ...a12AislePoints]
  },
  ingest: {
    batchSize: toNumber(process.env.INGEST_BATCH_SIZE, 50),
    flushIntervalMs: toNumber(process.env.INGEST_FLUSH_INTERVAL_MS, 2000),
    ruleCacheTtlMs: toNumber(process.env.RULE_CACHE_TTL_MS, 30000)
  }
};

module.exports = config;
