const parseTime = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms);
  }
  if (/^\d+$/.test(value)) {
    const num = Number(value);
    const ms = num > 1e12 ? num : num * 1000;
    return new Date(ms);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed;
};

const toMysqlDatetime = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

const startOfHourUtc = (date) => {
  const d = new Date(date.getTime());
  d.setUTCMinutes(0, 0, 0);
  return d;
};

const safeJsonParse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
};

module.exports = {
  parseTime,
  toMysqlDatetime,
  startOfHourUtc,
  safeJsonParse
};
