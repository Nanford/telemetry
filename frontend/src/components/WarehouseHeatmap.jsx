/**
 * 仓间温湿度热力图。
 *
 * 只使用已标定到 point_id 的新鲜读数：每条读数必须能对应到库位配置坐标，
 * 且坐标位于当前仓间范围内。未标定、缺失 point_id 或越界的原始 SLAM 数据
 * 不参与平面图绘制，避免把真实但尚未校准的数据错误投射到库位平面图上。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { getSlamPoints, getSlamReadings } from '../api.js';

const POLL_MS = 30000;
const FRESH_WINDOW_MS = 30 * 60 * 1000;
const MAP_PADDING = 0.75;
// 报警上限(红色端)与正常基线(冷色端)：颜色按绝对阈值映射，只有达到上限才红。
const TEMP_LIMIT = 32;
const RH_LIMIT = 65;
const TEMP_FLOOR = 20;
const RH_FLOOR = 45;

// 与后端 A-1-2 点位配置对应：上下两排短垛，中间保持完整主通道。
const BAY_W = 1.28;
const BAY_D = 3.2;
const BAY_OFFSET = 0.25;

const PALETTE = [
  [0, '#2e74ff'],
  [0.23, '#28b7ea'],
  [0.45, '#4ed09a'],
  [0.67, '#f2d45a'],
  [0.84, '#ff9851'],
  [1, '#f24d61']
];

const LEGEND_GRADIENT = `linear-gradient(90deg, ${PALETTE.map(([stop, color]) => `${color} ${stop * 100}%`).join(', ')})`;

const MODES = {
  temp: { key: 'temp_c', label: '温度', unit: '℃', limit: TEMP_LIMIT, floor: TEMP_FLOOR },
  rh: { key: 'rh', label: '湿度', unit: '%RH', limit: RH_LIMIT, floor: RH_FLOOR }
};

const num = (value) => {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
];

const colorAt = (value) => {
  const clamped = Math.max(0, Math.min(1, value));
  let lower = PALETTE[0];
  let upper = PALETTE[PALETTE.length - 1];

  for (let index = 1; index < PALETTE.length; index += 1) {
    if (clamped <= PALETTE[index][0]) {
      lower = PALETTE[index - 1];
      upper = PALETTE[index];
      break;
    }
  }

  const progress = (clamped - lower[0]) / (upper[0] - lower[0] || 1);
  const start = hexToRgb(lower[1]);
  const end = hexToRgb(upper[1]);
  return start.map((channel, index) => Math.round(channel + (end[index] - channel) * progress));
};

const idw = (x, y, samples) => {
  let weightedValue = 0;
  let weightSum = 0;

  samples.forEach((sample) => {
    const distanceSquared = (x - sample.x) ** 2 + (y - sample.y) ** 2;
    if (distanceSquared < 1e-9) {
      weightedValue = sample.v;
      weightSum = 1;
      return;
    }
    const weight = 1 / Math.pow(distanceSquared, 1.35);
    weightedValue += sample.v * weight;
    weightSum += weight;
  });

  return weightSum ? weightedValue / weightSum : 0;
};

// 将 IDW 场离屏渲染为带透明度的位图。SVG 仅负责裁切和叠放 CAD 图层。
const buildHeatUrl = (bounds, samples, domain) => {
  if (!bounds || samples.length < 2) return null;

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const resolution = 28;
  const pixelWidth = Math.max(32, Math.round(width * resolution));
  const pixelHeight = Math.max(32, Math.round(height * resolution));
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return null;

  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const image = context.createImageData(pixelWidth, pixelHeight);
  const [minValue, maxValue] = domain;
  const range = maxValue - minValue || 1;

  for (let row = 0; row < pixelHeight; row += 1) {
    const y = bounds.maxY - ((row + 0.5) / pixelHeight) * height;
    for (let column = 0; column < pixelWidth; column += 1) {
      const x = bounds.minX + ((column + 0.5) / pixelWidth) * width;
      const [red, green, blue] = colorAt((idw(x, y, samples) - minValue) / range);
      const offset = (row * pixelWidth + column) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = 172;
    }
  }

  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
};

const formatAge = (timestamp) => {
  if (!timestamp) return '--';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s 前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m 前`;
  return `${Math.floor(seconds / 3600)}h 前`;
};

const WarehouseHeatmap = () => {
  const [area, setArea] = useState(null);
  const [points, setPoints] = useState([]);
  const [readings, setReadings] = useState([]);
  const [mode, setMode] = useState('temp');
  const [selectedPointId, setSelectedPointId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [pointData, readingData] = await Promise.all([getSlamPoints(), getSlamReadings()]);
        if (cancelled) return;
        setArea(pointData.area || null);
        setPoints(Array.isArray(pointData.points) ? pointData.points : []);
        setReadings(Array.isArray(readingData) ? readingData : []);
        setError('');
      } catch (requestError) {
        if (!cancelled) setError(requestError.message || '热力数据加载失败');
      }
    };

    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const modeMeta = MODES[mode];

  // 优先采用仓间明确配置的尺寸；缺失时再根据已标定点位推导，绝不根据巡检轨迹扩张画布。
  const bounds = useMemo(() => {
    const configuredWidth = num(area?.width);
    const configuredHeight = num(area?.height);
    if (configuredWidth && configuredHeight) {
      return { minX: 0, maxX: configuredWidth, minY: 0, maxY: configuredHeight };
    }
    if (!points.length) return null;

    const xs = points.map((point) => num(point.x)).filter((value) => value !== null);
    const ys = points.map((point) => num(point.y)).filter((value) => value !== null);
    if (!xs.length || !ys.length) return null;

    return {
      minX: Math.min(0, Math.min(...xs) - BAY_W / 2 - 0.8),
      maxX: Math.max(...xs) + BAY_W / 2 + 0.8,
      minY: Math.min(0, Math.min(...ys) - BAY_D - BAY_OFFSET - 0.8),
      maxY: Math.max(...ys) + BAY_D + BAY_OFFSET + 0.8
    };
  }, [area, points]);

  // 越出仓间边界的点位配置不渲染，防止异常配置破坏矩形仓间比例。
  const mappedPoints = useMemo(() => {
    if (!bounds) return [];
    return points.filter((point) => {
      const x = num(point.x);
      const y = num(point.y);
      return x !== null && y !== null && x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
    });
  }, [bounds, points]);

  // 同一 point_id 仅保留最新一条读数；未知 point_id 直接忽略，不会在 CAD 图中被猜测定位。
  const latestReadings = useMemo(() => {
    const knownIds = new Set(mappedPoints.map((point) => point.id));
    const result = new Map();

    readings.forEach((reading) => {
      if (!knownIds.has(reading.point_id)) return;
      const timestamp = new Date(reading.ts).getTime();
      if (!Number.isFinite(timestamp)) return;
      const previous = result.get(reading.point_id);
      if (!previous || timestamp > new Date(previous.ts).getTime()) result.set(reading.point_id, reading);
    });

    return result;
  }, [mappedPoints, readings]);

  const stackSamples = useMemo(() => {
    const freshAfter = Date.now() - FRESH_WINDOW_MS;
    return mappedPoints
      .map((point) => {
        const reading = latestReadings.get(point.id);
        const timestamp = reading ? new Date(reading.ts).getTime() : 0;
        const value = reading ? num(reading[modeMeta.key]) : null;
        if (!reading || timestamp < freshAfter || value === null) return null;
        return { id: point.id, name: point.name, x: num(point.x), y: num(point.y), v: value, ts: reading.ts };
      })
      .filter(Boolean);
  }, [latestReadings, mappedPoints, modeMeta]);

  const sampleByPointId = useMemo(
    () => new Map(stackSamples.map((sample) => [sample.id, sample])),
    [stackSamples]
  );

  // 颜色域按绝对阈值固定：低端=正常基线(冷色)，高端=报警上限(红色)。
  // 超过上限的值经 colorAt 截断为满红，正常读数(如25℃)落在冷色区，不再被相对色阶误染红。
  const domain = useMemo(
    () => [modeMeta.floor, modeMeta.limit],
    [modeMeta]
  );

  const heatmapUrl = useMemo(
    () => buildHeatUrl(bounds, stackSamples, domain),
    [bounds, domain, stackSamples]
  );

  const latestTimestamp = useMemo(() => Array.from(latestReadings.values()).reduce((latest, reading) => {
    const timestamp = new Date(reading.ts).getTime();
    return Number.isFinite(timestamp) && timestamp > latest ? timestamp : latest;
  }, 0), [latestReadings]);

  const isStale = latestTimestamp > 0 && Date.now() - latestTimestamp > FRESH_WINDOW_MS;
  const values = stackSamples.map((sample) => sample.v);
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const highest = stackSamples.reduce((best, sample) => (!best || sample.v > best.v ? sample : best), null);
  const lowest = stackSamples.reduce((best, sample) => (!best || sample.v < best.v ? sample : best), null);
  const abnormalCount = stackSamples.filter((sample) => sample.v > modeMeta.limit).length;

  const formatValue = (value) => `${value.toFixed(1)}${modeMeta.unit}`;

  if (error && !area) return <div className="page-error">{error}</div>;
  // 加载中用同款深色卡片占位，避免白色占位框闪烁/跳动。
  if (!area || !bounds) {
    return (
      <section className="card heatmap-card" aria-label="仓间温湿度平面分析">
        <div className="heatmap-loading">加载中…</div>
      </section>
    );
  }

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const viewWidth = width + MAP_PADDING * 2;
  const viewHeight = height + MAP_PADDING * 2;
  const floorX = MAP_PADDING;
  const floorY = MAP_PADDING;
  const fx = (x) => x - bounds.minX + MAP_PADDING;
  const fy = (y) => bounds.maxY - y + MAP_PADDING;

  const pointYs = mappedPoints.map((point) => num(point.y) || 0);
  const pointXs = mappedPoints.map((point) => num(point.x) || 0);
  const southRowY = pointYs.length ? Math.min(...pointYs) : height * 0.42;
  const northRowY = pointYs.length ? Math.max(...pointYs) : height * 0.58;
  const rowMiddle = (southRowY + northRowY) / 2;
  // 中央走道优先用配置真实 4m 带(area.aisle)；缺失时退回按采集车道推导。
  const aisleBottom = area.aisle ? area.aisle.y0 : southRowY - BAY_OFFSET;
  const aisleTop = area.aisle ? area.aisle.y1 : northRowY + BAY_OFFSET;
  // 走道沿垛体 x 范围铺满：有 bay 几何时取垛体外缘，否则按点位反推。
  const bayRects = mappedPoints.map((point) => point.bay).filter(Boolean);
  const aisleStart = bayRects.length
    ? Math.min(...bayRects.map((b) => b.x0))
    : pointXs.length ? Math.min(...pointXs) - 0.8 : 0.7;
  const aisleEnd = bayRects.length
    ? Math.max(...bayRects.map((b) => b.x1))
    : pointXs.length ? Math.max(...pointXs) + 0.8 : width - 0.7;
  const centerAisleHeight = Math.max(0.8, aisleTop - aisleBottom);
  const selectedSample = selectedPointId ? sampleByPointId.get(selectedPointId) : null;
  // 结构柱：落在成对垛列之间的间隙(北排相邻中心间距 > 4.5m 处)，由真实坐标推导后示意绘制。
  const northCenters = mappedPoints
    .filter((point) => point.row === 'N')
    .map((point) => num(point.x))
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  const columnXs = [];
  for (let index = 0; index < northCenters.length - 1; index += 1) {
    if (northCenters[index + 1] - northCenters[index] > 4.5) {
      columnXs.push((northCenters[index] + northCenters[index + 1]) / 2);
    }
  }

  // 垛体矩形优先用配置真实几何(point.bay)；缺失时按固定尺寸从点位反推。
  const getBayGeometry = (point) => {
    const rect = point.bay;
    if (rect) {
      return { x: fx(rect.x0), y: fy(rect.y1), w: rect.x1 - rect.x0, h: rect.y1 - rect.y0, north: (rect.y0 + rect.y1) / 2 >= rowMiddle };
    }
    const x = num(point.x) || 0;
    const y = num(point.y) || 0;
    const north = y >= rowMiddle;
    return {
      x: fx(x) - BAY_W / 2,
      y: north ? fy(y + BAY_OFFSET + BAY_D) : fy(y - BAY_OFFSET),
      w: BAY_W,
      h: BAY_D,
      north
    };
  };

  return (
    <section className="card heatmap-card" aria-label="仓间温湿度平面分析">
      <header className="heatmap-header">
        <div className="heatmap-title-group">
          <span className="heatmap-eyebrow">环境空间监测</span>
          <div className="card-title">{area.name} 温湿度平面</div>
          <div className="card-subtitle">已标定点位 {stackSamples.length} / {mappedPoints.length} · 未匹配或越界数据不显示</div>
        </div>

        <div className="heatmap-mode-switch" role="group" aria-label="监测指标">
          {Object.entries(MODES).map(([key, meta]) => (
            <button
              key={key}
              type="button"
              className={mode === key ? 'active' : ''}
              aria-pressed={mode === key}
              onClick={() => {
                setMode(key);
                setSelectedPointId(null);
              }}
            >
              {meta.label} ({meta.unit})
            </button>
          ))}
        </div>

        <div className="heatmap-header-right">
          <div className="heatmap-legend" aria-label={`${modeMeta.label}图例`}>
            <span>{domain[0].toFixed(1)}{modeMeta.unit}</span>
            <span className="heatmap-legend-bar" style={{ background: LEGEND_GRADIENT }} />
            <span>{domain[1].toFixed(1)}{modeMeta.unit}</span>
          </div>
          <span className={`heatmap-live-status ${isStale ? 'stale' : ''}`}>
            <i /> {latestTimestamp ? `更新 ${formatAge(new Date(latestTimestamp).toISOString())}` : '等待数据'}
          </span>
        </div>
      </header>

      <div className="heatmap-stat-strip">
        <span>平均 <strong>{average === null ? '--' : formatValue(average)}</strong></span>
        <span>最高 <strong>{highest ? formatValue(highest.v) : '--'}</strong>{highest ? ` · ${highest.name}` : ''}</span>
        <span>最低 <strong>{lowest ? formatValue(lowest.v) : '--'}</strong>{lowest ? ` · ${lowest.name}` : ''}</span>
        <span>超阈 <strong className={abnormalCount ? 'heatmap-bad' : ''}>{abnormalCount} 个</strong></span>
        <span className="heatmap-source-note">数据源：已标定巡检点</span>
      </div>

      <div className="heatmap-canvas">
        <div className="slam-floor heatmap-floor">
          <svg viewBox={`0 0 ${viewWidth} ${viewHeight}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`${area.name}${modeMeta.label}CAD平面图`}>
            <defs>
              <clipPath id="warehouse-floor-clip">
                <rect x={floorX} y={floorY} width={width} height={height} rx="0.08" />
              </clipPath>
              <pattern id="bay-shelf-grid" width="0.32" height="0.48" patternUnits="userSpaceOnUse">
                <path d="M 0 0 L 0.32 0 M 0.16 0 L 0.16 0.48" fill="none" stroke="rgba(214, 188, 138, 0.28)" strokeWidth="0.018" />
              </pattern>
              <linearGradient id="aisle-glow" x1="0" x2="1">
                <stop offset="0" stopColor="rgba(91, 201, 255, 0.02)" />
                <stop offset="0.5" stopColor="rgba(91, 201, 255, 0.13)" />
                <stop offset="1" stopColor="rgba(91, 201, 255, 0.02)" />
              </linearGradient>
            </defs>

            {/* 基础底图与热力位图共用同一裁切边界，热色不会溢出仓间矩形。 */}
            <rect x={floorX} y={floorY} width={width} height={height} rx="0.08" fill="#07162d" />
            {heatmapUrl && (
              <image
                href={heatmapUrl}
                x={floorX}
                y={floorY}
                width={width}
                height={height}
                opacity="0.68"
                preserveAspectRatio="none"
                clipPath="url(#warehouse-floor-clip)"
              />
            )}

            <g clipPath="url(#warehouse-floor-clip)">
              {Array.from({ length: Math.floor(width / 1.5) + 1 }, (_, index) => (
                <line key={`grid-x-${index}`} x1={floorX + index * 1.5} y1={floorY} x2={floorX + index * 1.5} y2={floorY + height}
                  stroke="rgba(132, 199, 255, 0.085)" strokeWidth="0.018" />
              ))}
              {Array.from({ length: Math.floor(height / 1.5) + 1 }, (_, index) => (
                <line key={`grid-y-${index}`} x1={floorX} y1={floorY + index * 1.5} x2={floorX + width} y2={floorY + index * 1.5}
                  stroke="rgba(132, 199, 255, 0.085)" strokeWidth="0.018" />
              ))}

              <rect x={fx(aisleStart)} y={fy(aisleTop)} width={aisleEnd - aisleStart} height={centerAisleHeight}
                fill="url(#aisle-glow)" stroke="rgba(136, 214, 255, 0.3)" strokeWidth="0.028" />
              <line x1={fx(aisleStart)} y1={fy((aisleTop + aisleBottom) / 2)} x2={fx(aisleEnd)} y2={fy((aisleTop + aisleBottom) / 2)}
                stroke="rgba(209, 239, 255, 0.35)" strokeWidth="0.028" strokeDasharray="0.18 0.18" />

              {columnXs.filter((x) => x > 0 && x < width).map((x, index) => (
                <g key={`column-${index}`}>
                  <rect x={fx(x) - 0.17} y={floorY + 0.05} width="0.34" height="0.34" fill="#0b1a32" stroke="rgba(180, 224, 255, 0.46)" strokeWidth="0.035" />
                  <rect x={fx(x) - 0.17} y={floorY + height - 0.39} width="0.34" height="0.34" fill="#0b1a32" stroke="rgba(180, 224, 255, 0.46)" strokeWidth="0.035" />
                </g>
              ))}

              {mappedPoints.filter((point) => point.kind !== 'aisle').map((point) => {
                const bay = getBayGeometry(point);
                const sample = sampleByPointId.get(point.id);
                const relativeValue = sample ? (sample.v - domain[0]) / (domain[1] - domain[0] || 1) : null;
                const [red, green, blue] = relativeValue === null ? [220, 193, 145] : colorAt(relativeValue);
                const isAbnormal = sample && sample.v > modeMeta.limit;
                const bayCode = point.id.replace(/^A-1-/, '');

                return (
                  <g key={`bay-${point.id}`}>
                    <rect x={bay.x} y={bay.y} width={bay.w} height={bay.h} rx="0.045"
                      fill={sample ? `rgba(${red}, ${green}, ${blue}, 0.17)` : 'rgba(212, 186, 139, 0.10)'}
                      stroke={isAbnormal ? 'rgba(255, 110, 122, 0.98)' : 'rgba(224, 203, 165, 0.62)'}
                      strokeWidth={isAbnormal ? '0.07' : '0.038'} />
                    <rect x={bay.x + 0.06} y={bay.y + 0.06} width={bay.w - 0.12} height={bay.h - 0.12}
                      fill="url(#bay-shelf-grid)" stroke="rgba(224, 203, 165, 0.18)" strokeWidth="0.018" />
                    <text x={bay.x + bay.w / 2} y={bay.y + bay.h / 2 + 0.18} textAnchor="middle" fontSize="0.5" fontWeight="700"
                      fill="rgba(235, 222, 198, 0.84)">{bayCode}</text>
                  </g>
                );
              })}

              {area.door && (
                <g aria-hidden="true">
                  <rect x={fx(num(area.door.x)) - (num(area.door.width) || 4) / 2} y={fy(num(area.door.y)) - 0.16} width={num(area.door.width) || 4} height="0.32" rx="0.04"
                    fill="rgba(37, 124, 202, 0.24)" stroke="rgba(122, 215, 255, 0.9)" strokeWidth="0.055" />
                  <text x={fx(num(area.door.x))} y={fy(num(area.door.y)) - 0.32} textAnchor="middle" fontSize="0.34" fill="#bfeaff">南门 · 入口</text>
                </g>
              )}

              {[width * 0.2, width * 0.5, width * 0.8].filter((x) => x < width - 0.4).map((x, index) => (
                <g key={`safety-${index}`}>
                  <rect x={fx(x)} y={floorY + 0.42} width="0.28" height="0.38" rx="0.025" fill="#d94351" />
                  <text x={fx(x) + 0.14} y={floorY + 0.69} textAnchor="middle" fontSize="0.19" fontWeight="700" fill="#fff">消</text>
                </g>
              ))}

              {stackSamples.map((sample) => {
                const x = fx(sample.x);
                const y = fy(sample.y);
                const selected = selectedPointId === sample.id;
                const [red, green, blue] = colorAt((sample.v - domain[0]) / (domain[1] - domain[0] || 1));
                const north = sample.y >= (southRowY + northRowY) / 2;
                const calloutY = north ? y - 0.58 : y + 0.76;
                const calloutX = Math.min(Math.max(x, floorX + 1.05), floorX + width - 1.05);

                return (
                  <g
                    key={`sample-${sample.id}`}
                    className="heatmap-sample"
                    role="button"
                    tabIndex="0"
                    aria-label={`${sample.name}，${formatValue(sample.v)}`}
                    onClick={() => setSelectedPointId(selected ? null : sample.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedPointId(selected ? null : sample.id);
                      }
                    }}
                  >
                    {selected && <circle cx={x} cy={y} r="0.34" fill={`rgba(${red}, ${green}, ${blue}, 0.22)`} />}
                    <circle cx={x} cy={y} r={selected ? '0.16' : '0.12'} fill={`rgb(${red}, ${green}, ${blue})`} stroke="#fff" strokeWidth="0.055" />
                    {selected && (
                      <g>
                        <rect x={calloutX - 0.78} y={calloutY - 0.31} width="1.56" height="0.48" rx="0.08" fill="rgba(3, 12, 28, 0.9)" stroke={`rgba(${red}, ${green}, ${blue}, 0.72)`} strokeWidth="0.03" />
                        <text x={calloutX} y={calloutY} textAnchor="middle" fontSize="0.21" fontWeight="700" fill="#f4f9ff">{sample.name} · {formatValue(sample.v)}</text>
                      </g>
                    )}
                  </g>
                );
              })}
            </g>

            <rect x={floorX} y={floorY} width={width} height={height} rx="0.08" fill="none" stroke="rgba(183, 229, 255, 0.74)" strokeWidth="0.075" />
            <text x={floorX + width / 2} y={fy((aisleTop + aisleBottom) / 2) + 0.1} textAnchor="middle" fontSize="0.26" letterSpacing="0.12" fill="rgba(210, 239, 255, 0.7)">中 央 走 道</text>

            {!heatmapUrl && (
              <g>
                <rect x={floorX + width / 2 - 2.35} y={floorY + height / 2 - 0.45} width="4.7" height="0.9" rx="0.1" fill="rgba(3, 12, 28, 0.82)" stroke="rgba(127, 204, 255, 0.34)" strokeWidth="0.035" />
                <text x={floorX + width / 2} y={floorY + height / 2 - 0.08} textAnchor="middle" fontSize="0.28" fill="#d8edff">等待至少 2 个已标定的新鲜点位读数</text>
                <text x={floorX + width / 2} y={floorY + height / 2 + 0.2} textAnchor="middle" fontSize="0.2" fill="rgba(216, 237, 255, 0.58)">未匹配或越界的巡检数据不会投射到此平面图</text>
              </g>
            )}
          </svg>
        </div>

        <aside className="heatmap-focus-card" aria-live="polite">
          <span className="heatmap-focus-label">{selectedSample ? '当前选中点位' : '点位数据说明'}</span>
          {selectedSample ? (
            <>
              <strong>{selectedSample.name}</strong>
              <b>{formatValue(selectedSample.v)}</b>
              <span>采集时间 {formatAge(selectedSample.ts)}</span>
              <button type="button" onClick={() => setSelectedPointId(null)}>取消选择</button>
            </>
          ) : (
            <>
              <strong>点击图中测点查看读数</strong>
              <span>热力场由已标定点位插值生成；库外、未匹配和过期数据不参与显示。</span>
            </>
          )}
        </aside>
      </div>

      <footer className="heatmap-footer">
        <span>颜色按报警阈值着色（温度 ≥ {TEMP_LIMIT}℃、湿度 ≥ {RH_LIMIT}% 为红）；实测值以点位读数为准。</span>
        <span>{isStale ? `最新标定读数已过期（${formatAge(new Date(latestTimestamp).toISOString())}）` : '每 30 秒自动刷新'}</span>
      </footer>
    </section>
  );
};

export default WarehouseHeatmap;
