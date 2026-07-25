/**
 * A-4-1 仓间 CAD 基准布局。
 *
 * INPUT : CAD《18.9.21-B101、B103醇化加工库（编号图）》中的 A-4-1 图元。
 * OUTPUT: 后端点位匹配和前端平面图共用的米制仓间、垛位、入口与巡检顺序。
 * POS   : 现场真实 SLAM 点位整理前的几何权威源；后续只替换采集点坐标，不改变垛号和仓间结构。
 */

const AREA_ID = 'A-4-1';
const AREA_WIDTH = 55.99;
const AREA_HEIGHT = 36.35;
const BAY_WIDTH = 3.02;
const MATCH_RADIUS = 0.9;

// CAD 局部坐标：原点为西墙内表面 × 南墙内表面，+x 向东，+y 向北，单位米。
// 南北两排之间保留 4m 中央巡检通道，东门中心与通道中线对齐。
const AISLE = { y0: 16.85, y1: 20.85, mid: 18.85 };
const BANDS = {
  N: { y0: 20.85, y1: 35.35 },
  S: { y0: 3.55, y1: 16.85 }
};
const LANES = {
  N: 19.85,
  S: 17.85
};

// [垛号, CAD 局部中心 x, 排]。A-4-1 共 22 垛，北排和南排各 11 垛。
const BAYS = [
  ['17', 2.21, 'N'],
  ['18', 5.99, 'N'],
  ['19', 11.505, 'N'],
  ['20', 15.295, 'N'],
  ['21', 20.805, 'N'],
  ['22', 24.595, 'N'],
  ['01', 33.895, 'N'],
  ['02', 39.405, 'N'],
  ['03', 43.195, 'N'],
  ['04', 48.705, 'N'],
  ['05', 52.302, 'N'],
  ['16', 2.21, 'S'],
  ['15', 5.99, 'S'],
  ['14', 11.505, 'S'],
  ['13', 15.295, 'S'],
  ['12', 20.805, 'S'],
  ['11', 24.595, 'S'],
  ['10', 30.105, 'S'],
  ['09', 33.895, 'S'],
  ['08', 39.405, 'S'],
  ['07', 43.195, 'S'],
  ['06', 48.705, 'S']
];

// 从东门进入后先巡南排（东→西），西端换到北道，再巡北排（西→东），最后回到东门。
// 2026-07-23 现场照片真值确认了这个方向：10:45:54 狗在 A-4-1-17、10:46:18 在 A-4-1-18、
// 10:47:11 在 A-4-1-20 —— 北排是西→东走的。原配置写的“北排东→西”与现场相反，已按现场纠正。
const PATROL_ORDER = [
  ...BAYS.filter(([, , row]) => row === 'S').sort((a, b) => b[1] - a[1]),
  ...BAYS.filter(([, , row]) => row === 'N').sort((a, b) => a[1] - b[1])
].map(([number]) => number);

const round3 = (value) => Math.round(value * 1000) / 1000;

const bayRect = (x, row) => {
  const band = BANDS[row];
  return {
    x0: round3(x - BAY_WIDTH / 2),
    y0: band.y0,
    x1: round3(x + BAY_WIDTH / 2),
    y1: band.y1
  };
};

const points = BAYS.map(([number, x, row]) => ({
  id: `${AREA_ID}-${number}`,
  name: `垛位 ${number}`,
  x,
  y: LANES[row],
  radius: MATCH_RADIUS,
  kind: 'bay',
  row,
  patrol_seq: PATROL_ORDER.indexOf(number) + 1,
  bay: bayRect(x, row)
}));

const area = {
  area_id: AREA_ID,
  name: 'A-4-1 仓间（A4 左下）',
  description: 'A4 区左下仓间，巡检由东门进入',
  width: AREA_WIDTH,
  height: AREA_HEIGHT,
  aisle: { y0: AISLE.y0, y1: AISLE.y1 },
  door: {
    x: AREA_WIDTH,
    y: 18.9,
    width: 4,
    wall: 'east',
    label: '东门'
  },
  orientation: {
    north: 'top',
    entrance: 'east'
  },
  cad: {
    source: '18.9.21-B101、B103醇化加工库（编号图）.dwg',
    version: 'AC1027',
    origin_mm: { x: 734317.54, y: -23871.12 },
    coordinate_system: 'southwest-local-meters'
  }
};

module.exports = {
  area,
  points,
  patrolOrder: PATROL_ORDER,
  geometry: {
    aisle: AISLE,
    bands: BANDS,
    lanes: LANES,
    bayWidth: BAY_WIDTH,
    matchRadius: MATCH_RADIUS
  }
};
