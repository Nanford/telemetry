/**
 * INPUT: 可选的 calibration.json(标定产物)。支持两种格式:
 *        新版按区域  { "areas": { "A-4-1": {theta,scale,tx,ty}, ... }, "default": {...} }
 *        旧版单变换  { theta, tx, ty }            ← 自动当作 default, scale 补 1
 * OUTPUT: loadCalibration() 读盘(缺省=恒等); calibrationFor(book, areaId) 取某区域生效的变换;
 *         applyCalibration(x, y, book, areaId) 把原始 SLAM 坐标变换到 CAD 系
 * POS: 阶段2 标定核心。config.slam.points 恒为 CAD 系(前端画正矩形/匹配基准); 每次开机 SLAM
 *      原点/朝向会漂, 现场标定只解一个变换存进 calibration.json, 后端在"匹配/画轨迹/热力"
 *      时把进来的原始位姿先过此变换。数据库只存原始 SLAM 位姿 ⇒ 改变换即追溯重匹配, 不用重走。
 *
 *      变换定义(与 tools/solve_calibration.py 一致): CAD = c·R(theta)·SLAM + t
 *        [cx]       [cosθ  -sinθ][sx]   [tx]
 *        [cy] = c · [sinθ   cosθ][sy] + [ty]
 *
 *      为什么带缩放 c(4 自由度相似变换)而不是纯刚体:
 *      2026-07-23 现场用三张带时间戳的照片(A-4-1-17/18/20)做真值实测, Go2 的 sportmodestate
 *      每走 1 m 只报 0.735 m —— 约 26% 尺度亏损(足式里程计在抛光水泥地上打滑)。同一组锚点,
 *      纯刚体拟合残差 RMS 1.44 m, 加上 c 后降到 0.11 m。没有 c 就对不齐。
 *      c 缺省为 1(退化回纯刚体), 旧标定文件行为完全不变。
 *
 *      已知限制: 该尺度因子随步态/地面变化, 不是设备常量, 也不是一次标定长期有效
 *      (同一次开机内实测坐标系已转过约 74°)。换成激光建图位姿(map 帧)后 c 应回到 1,
 *      届时本文件无需改动。详见 tools/probe_pose_topics.py。
 */
const fs = require('fs');
const path = require('path');

const IDENTITY = { theta: 0, scale: 1, tx: 0, ty: 0 };

// 把任意来源的对象规整成合法变换; 任一字段非有限数则判为无效, 返回 null。
// scale 缺省 1(兼容旧版三字段格式), 且必须为正 —— 负数会镜像翻转, 零会把全图压成一点。
const normalize = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const theta = Number(raw.theta);
  const tx = Number(raw.tx);
  const ty = Number(raw.ty);
  const scale = raw.scale === undefined || raw.scale === null ? 1 : Number(raw.scale);
  if (![theta, tx, ty, scale].every(Number.isFinite)) return null;
  if (scale <= 0) return null;
  return { theta, scale, tx, ty };
};

// 载入标定册。优先 SLAM_CALIBRATION_FILE, 否则同目录 calibration.json;
// 缺文件/坏文件 = 空册(所有区域走恒等, 即"未标定"状态, 与阶段1行为一致)。
const loadCalibration = () => {
  const file = process.env.SLAM_CALIBRATION_FILE || path.join(__dirname, 'calibration.json');
  const empty = { default: null, areas: {} };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (_err) {
    return empty; // 无标定文件或格式错误 → 恒等
  }
  if (!raw || typeof raw !== 'object') return empty;

  // 旧版扁平格式: 整个文件就是一个变换, 当作 default 兜住所有区域。
  if (raw.areas === undefined && raw.default === undefined) {
    return { default: normalize(raw), areas: {} };
  }

  const areas = {};
  for (const [areaId, entry] of Object.entries(raw.areas || {})) {
    const t = normalize(entry);
    if (t) areas[areaId] = t; // 单个区域配错只丢它自己, 不牵连其他区域
  }
  return { default: normalize(raw.default), areas };
};

// 取某区域生效的变换。优先该区域自己的标定, 否则 default, 再否则恒等。
// 兼容直接传入单个变换对象的老调用方(此时入参自带 theta 而无 areas/default)。
const calibrationFor = (book, areaId) => {
  if (!book || typeof book !== 'object') return IDENTITY;
  if (book.areas === undefined && book.default === undefined) {
    return normalize(book) || IDENTITY;
  }
  if (areaId && book.areas && book.areas[areaId]) return book.areas[areaId];
  return book.default || IDENTITY;
};

// 转成有限数, 否则返回 null。注意不能直接用 Number(): Number(null) 和 Number('') 都是 0
// 且通过 isFinite —— 那会把"没有位姿"的记录静默变换成 CAD 原点, 在地图上画出一个假点。
const toFiniteNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

// 把一对原始 SLAM 坐标变换到 CAD 系。坐标非数 → 原样返回(保证脏数据不被静默改写)。
const applyCalibration = (x, y, book, areaId) => {
  const px = toFiniteNumber(x);
  const py = toFiniteNumber(y);
  if (px === null || py === null) return [x, y];
  const { theta, scale, tx, ty } = calibrationFor(book, areaId);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return [scale * (cos * px - sin * py) + tx, scale * (sin * px + cos * py) + ty];
};

module.exports = { loadCalibration, calibrationFor, applyCalibration, IDENTITY };
