export const getInspectionStatusMeta = (status) => {
  if (status === 'normal') return { label: '正常', className: '' };
  if (status === 'abnormal') return { label: '存在异常', className: 'warning' };
  return { label: '未判定', className: 'undetermined' };
};

export const formatDuration = (seconds) => {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return '--';
  const total = Math.max(0, Math.round(Number(seconds)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;

  if (hours > 0) return `${hours}小时${minutes}分`;
  if (minutes > 0) return `${minutes}分${remainingSeconds}秒`;
  return `${remainingSeconds}秒`;
};

export const formatDateTime = (value) => {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
};

export const formatMetric = (value, digits = 1) => {
  if (value === null || value === undefined || value === '') return '--';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : '--';
};

const toShanghaiDateTimeLocal = (value) => {
  const fields = getShanghaiDateTimeFields(value);
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`;
};

const getShanghaiDateTimeFields = (value) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(value);
  const fields = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );
  return fields;
};

const daysInMonth = (year, month) => (
  new Date(Date.UTC(year, month, 0)).getUTCDate()
);

const subtractShanghaiMonths = (value, months = 1) => {
  const fields = getShanghaiDateTimeFields(value);
  const sourceYear = Number(fields.year);
  const sourceMonth = Number(fields.month);
  const sourceDay = Number(fields.day);
  const targetMonthOffset = sourceMonth - 1 - months;
  const targetYear = sourceYear + Math.floor(targetMonthOffset / 12);
  const targetMonthIndex = ((targetMonthOffset % 12) + 12) % 12;
  const targetMonth = targetMonthIndex + 1;
  const targetDay = Math.min(sourceDay, daysInMonth(targetYear, targetMonth));
  const pad = (number) => String(number).padStart(2, '0');

  // Build an explicit Shanghai timestamp so the default range is stable across client time zones.
  return new Date(
    `${targetYear}-${pad(targetMonth)}-${pad(targetDay)}T${fields.hour}:${fields.minute}:00+08:00`
  );
};

export const createDefaultInspectionRange = (now = new Date()) => {
  const end = new Date(now);
  const start = subtractShanghaiMonths(end);
  return {
    start: toShanghaiDateTimeLocal(start),
    end: toShanghaiDateTimeLocal(end)
  };
};

export const sampleMeasurements = (measurements = [], maxPoints = 300) => {
  if (measurements.length <= maxPoints) return measurements;
  if (maxPoints <= 1) return [measurements[0]];

  const sampled = [];
  const lastIndex = measurements.length - 1;
  for (let index = 0; index < maxPoints; index += 1) {
    const sourceIndex = Math.round((index * lastIndex) / (maxPoints - 1));
    sampled.push(measurements[sourceIndex]);
  }
  return sampled;
};

const finiteCoordinate = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * 控制 SLAM 网格密度，避免大尺寸或大坐标范围生成过多 SVG 节点。
 */
export const computeMapGridStep = (span, maxLines = 40) => {
  const numericSpan = Math.max(finiteCoordinate(span) || 0, 0);
  const lineLimit = Math.max(Math.floor(Number(maxLines)) || 40, 1);
  return Math.max(1, Math.ceil(numericSpan / lineLimit));
};

/**
 * 计算巡检地图的真实坐标边界和响应式画布尺寸。
 * 有明确楼层宽高时使用配置；否则从点位和实际轨迹坐标推导边界。
 */
export const computeInspectionMapLayout = ({
  area = {},
  points = [],
  trail = []
} = {}) => {
  const configuredWidth = finiteCoordinate(area.width);
  const configuredHeight = finiteCoordinate(area.height);
  let bounds = null;
  let source = 'empty';

  if (configuredWidth > 0 && configuredHeight > 0) {
    bounds = {
      minX: 0,
      minY: 0,
      maxX: configuredWidth,
      maxY: configuredHeight
    };
    source = 'configured';
  } else {
    const coordinates = [
      ...points.map((point) => ({
        x: finiteCoordinate(point.x),
        y: finiteCoordinate(point.y)
      })),
      ...trail.map((point) => ({
        x: finiteCoordinate(point.pos_x),
        y: finiteCoordinate(point.pos_y)
      }))
    ].filter(({ x, y }) => x !== null && y !== null);

    if (coordinates.length) {
      const valuesX = coordinates.map(({ x }) => x);
      const valuesY = coordinates.map(({ y }) => y);
      const minX = Math.min(...valuesX);
      const maxX = Math.max(...valuesX);
      const minY = Math.min(...valuesY);
      const maxY = Math.max(...valuesY);
      const spanX = Math.max(maxX - minX, 1);
      const spanY = Math.max(maxY - minY, 1);
      const paddingX = Math.max(spanX * 0.08, 1);
      const paddingY = Math.max(spanY * 0.3, 1.5);

      bounds = {
        minX: minX - paddingX,
        minY: minY - paddingY,
        maxX: maxX + paddingX,
        maxY: maxY + paddingY
      };
      source = 'inferred';
    }
  }

  if (!bounds) {
    return {
      source,
      bounds: null,
      canvas: { width: 1280, height: 560 }
    };
  }

  const width = Math.max(bounds.maxX - bounds.minX, 1);
  const height = Math.max(bounds.maxY - bounds.minY, 1);
  const aspectRatio = width / height;

  return {
    source,
    bounds,
    canvas: {
      width: 1280,
      height: Math.round(clamp(1280 / aspectRatio + 180, 450, 700))
    }
  };
};

/**
 * 把一条按时间升序的轨迹拆成若干“可安全连线”的分段，避免断档/位姿跳变/出界处
 * 被 polyline 直连成虚假直线（治 7-22“90°转弯误显示为 180°折返”）。
 *
 * 断段规则（满足任一即在此处断开，各段内部相邻点才可直接连线）：
 *   1. 相邻点时间差 > maxGapMs —— 采集断档；
 *   2. 相邻点速度 > maxSpeedMps —— 位姿跳变/里程计复位（Go2 遥控巡检不会超过 2m/s）；
 *   3. 传入 bounds 时出界，或坐标非有限数 —— 该点丢弃，且其两侧不得跨洞相连。
 *
 * @param {Array} trail 轨迹点数组（元素含 ts / pos_x / pos_y，按时间升序）
 * @param {Object} options { maxGapMs=30000, maxSpeedMps=2, bounds=null }
 * @returns {Array<Array>} 分段结果；仅含 1 个点的段由调用方画成单点
 */
export const buildTrailSegments = (trail = [], options = {}) => {
  const { maxGapMs = 30000, maxSpeedMps = 2, bounds = null } = options;
  const segments = [];
  let current = [];
  let previous = null;

  const flushSegment = () => {
    if (current.length) segments.push(current);
    current = [];
  };

  const isInsideBounds = (x, y) => (
    !bounds ||
    (x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY)
  );

  for (const point of trail) {
    const x = finiteCoordinate(point?.pos_x);
    const y = finiteCoordinate(point?.pos_y);

    // 坐标无效或出界：丢弃该点并断段，防止洞两端被 polyline 直连成假直线。
    if (x === null || y === null || !isInsideBounds(x, y)) {
      flushSegment();
      previous = null;
      continue;
    }

    const parsedTime = new Date(point?.ts).getTime();
    const time = Number.isFinite(parsedTime) ? parsedTime : null;

    if (previous) {
      const gap = time !== null && previous.time !== null ? time - previous.time : null;
      let broken = false;
      if (gap !== null && gap > maxGapMs) broken = true;              // 规则1：采集断档
      if (!broken && gap !== null && gap > 0) {                       // 规则2：位姿跳变（gap>0 防除零）
        const distance = Math.hypot(x - previous.x, y - previous.y);
        if (distance / (gap / 1000) > maxSpeedMps) broken = true;
      }
      if (broken) flushSegment();
    }

    current.push(point);
    previous = { x, y, time };
  }

  flushSegment();
  return segments;
};

/**
 * 等比投影：把真实坐标范围 bounds 映射进屏幕像素矩形 box，x/y 共用同一 scale
 * 并在 box 内居中，避免各轴独立缩放把轨迹/路线角度压扁（治详情页非等比失真）。
 * box 采用屏幕坐标系（y 向下增大），真实坐标 y 向上，投影后自动翻转。
 *
 * @param {Object} bounds { minX, minY, maxX, maxY }
 * @param {Object} box    { x, width, top, bottom } 绘图区像素矩形
 * @returns {{ scale:number, projectX:(v)=>number, projectY:(v)=>number }}
 */
export const computeEqualRatioProjection = (bounds, box) => {
  const coordinateWidth = Math.max(bounds.maxX - bounds.minX, 1);
  const coordinateHeight = Math.max(bounds.maxY - bounds.minY, 1);
  const boxWidth = Math.max(box.width, 1);
  const boxHeight = Math.max(box.bottom - box.top, 1);
  const scale = Math.min(boxWidth / coordinateWidth, boxHeight / coordinateHeight);
  const drawnWidth = coordinateWidth * scale;
  const drawnHeight = coordinateHeight * scale;
  const offsetX = box.x + (boxWidth - drawnWidth) / 2;       // 水平居中
  const bottomY = box.bottom - (boxHeight - drawnHeight) / 2; // 垂直居中后的绘图区底边

  return {
    scale,
    projectX: (value) => offsetX + (Number(value) - bounds.minX) * scale,
    projectY: (value) => bottomY - (Number(value) - bounds.minY) * scale
  };
};
