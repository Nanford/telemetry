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
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`;
};

export const createDefaultInspectionRange = (now = new Date()) => {
  const end = new Date(now);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
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
