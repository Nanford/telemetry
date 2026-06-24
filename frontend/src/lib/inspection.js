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
