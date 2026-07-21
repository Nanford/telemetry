import React, { useEffect, useMemo, useState } from 'react';
import { getSlamPoints, getSlamReadings } from '../api.js';
import {
  computeInspectionMapLayout,
  computeMapGridStep,
  formatMetric
} from '../lib/inspection.js';

const POLL_MS = 30000;
const PADDING = 1.5;
// 告警阈值与巡检地图/采集端保持一致
const TEMP_LIMIT = 32;
const RH_LIMIT = 65;

// 蓝→青→绿→黄→橙→红热力色带
const PALETTE = [
  [0, '#2563eb'],
  [0.23, '#23a9e8'],
  [0.45, '#3fcf91'],
  [0.67, '#e6dc48'],
  [0.84, '#ff8f32'],
  [1, '#ef3e42']
];
const LEGEND_GRADIENT = `linear-gradient(90deg, ${PALETTE.map(([t, c]) => `${c} ${t * 100}%`).join(', ')})`;

const MODES = {
  temp: { key: 'temp_c', label: '温度热力图', metric: '温度', unit: '℃', limit: TEMP_LIMIT },
  rh: { key: 'rh', label: '湿度热力图', metric: '湿度', unit: '%', limit: RH_LIMIT }
};

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
];

const colorAt = (t) => {
  const value = Math.max(0, Math.min(1, t));
  let lower = PALETTE[0];
  let upper = PALETTE[PALETTE.length - 1];
  for (let i = 1; i < PALETTE.length; i += 1) {
    if (value <= PALETTE[i][0]) {
      lower = PALETTE[i - 1];
      upper = PALETTE[i];
      break;
    }
  }
  const k = (value - lower[0]) / (upper[0] - lower[0] || 1);
  const ca = hexToRgb(lower[1]);
  const cb = hexToRgb(upper[1]);
  return ca.map((v, i) => Math.round(v + (cb[i] - v) * k));
};

// 反距离加权（IDW）空间插值：离采样点越近，该点读数权重越大
const idw = (mx, my, samples) => {
  let weighted = 0;
  let weightSum = 0;
  for (const s of samples) {
    const dx = mx - s.x;
    const dy = my - s.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-9) return s.v;
    const w = 1 / Math.pow(d2, 1.3);
    weighted += s.v * w;
    weightSum += w;
  }
  return weighted / weightSum;
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const formatAge = (ts) => {
  if (!ts) return '--';
  const sec = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (sec < 60) return `${sec}s 前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m 前`;
  return `${Math.floor(sec / 3600)}h 前`;
};

const WarehouseHeatmap = () => {
  const [area, setArea] = useState(null);
  const [points, setPoints] = useState([]);
  const [readings, setReadings] = useState([]);
  const [mode, setMode] = useState('temp');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [pointData, readingData] = await Promise.all([getSlamPoints(), getSlamReadings()]);
        if (cancelled) return;
        setArea(pointData.area);
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

  const readingMap = useMemo(() => {
    const map = {};
    readings.forEach((r) => { map[r.point_id] = r; });
    return map;
  }, [readings]);

  // 参与插值的采样点：有平面坐标且最新读数有效
  const samples = useMemo(() => (
    points
      .map((pt) => {
        const rd = readingMap[pt.id];
        const v = rd ? num(rd[modeMeta.key]) : null;
        if (v === null) return null;
        return { id: pt.id, name: pt.name, x: Number(pt.x) || 0, y: Number(pt.y) || 0, v };
      })
      .filter(Boolean)
  ), [points, readingMap, modeMeta]);

  // 色带域值跟随当前读数范围，保证仓内微小差异也能分辨
  const domain = useMemo(() => {
    if (!samples.length) return [0, 1];
    const values = samples.map((s) => s.v);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (max - min < 0.5) {
      min -= 0.25;
      max += 0.25;
    }
    return [min, max];
  }, [samples]);

  const layout = useMemo(
    () => computeInspectionMapLayout({ area: area || {}, points, trail: [] }),
    [area, points]
  );

  // 离屏 canvas 逐像素插值生成热力场，再作为图片嵌入 SVG 房间区域
  const heatmapUrl = useMemo(() => {
    if (!layout.bounds || samples.length < 2) return null;
    const { bounds } = layout;
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxY - bounds.minY;
    const px = Math.max(16, Math.round(w * 24));
    const py = Math.max(16, Math.round(h * 24));
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = py;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(px, py);
    const [dMin, dMax] = domain;
    const span = dMax - dMin || 1;
    for (let j = 0; j < py; j += 1) {
      const my = bounds.maxY - ((j + 0.5) / py) * h;
      for (let i = 0; i < px; i += 1) {
        const mx = bounds.minX + ((i + 0.5) / px) * w;
        const [r, g, b] = colorAt((idw(mx, my, samples) - dMin) / span);
        const k = (j * px + i) * 4;
        img.data[k] = r;
        img.data[k + 1] = g;
        img.data[k + 2] = b;
        img.data[k + 3] = 190;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
  }, [layout, samples, domain]);

  if (error && !area) return <div className="page-error">{error}</div>;
  if (!area) return <div className="card" style={{ padding: 24 }}>加载中…</div>;
  if (!layout.bounds) return <div className="card" style={{ padding: 24 }}>暂无库房平面数据</div>;

  const { bounds } = layout;
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const vbW = w + PADDING * 2;
  const vbH = h + PADDING * 2;
  const fx = (x) => x - bounds.minX + PADDING;
  const fy = (y) => bounds.maxY - y + PADDING;
  const gridStep = computeMapGridStep(Math.max(w, h));

  // 垛位与走道几何（与巡检平面图一致：上下两排短垛 + 中央走道）
  const ptYs = points.map((p) => Number(p.y) || 0);
  const aisleMin = ptYs.length ? Math.min(...ptYs) : 0;
  const aisleMax = ptYs.length ? Math.max(...ptYs) : 0;
  const aisleMid = (aisleMin + aisleMax) / 2;
  const BAY_W = 1.28;
  const BAY_D = 3.2;
  const BAY_OFF = 0.25;
  const ptXs = points.map((p) => Number(p.x) || 0);
  const baySpanMinX = ptXs.length ? Math.min(...ptXs) - BAY_W / 2 - 0.3 : bounds.minX;
  const baySpanMaxX = ptXs.length ? Math.max(...ptXs) + BAY_W / 2 + 0.3 : bounds.maxX;
  const aisleX = fx(baySpanMinX);
  const aisleW = Math.max(baySpanMaxX - baySpanMinX, 1);

  const bayGeom = (pt) => {
    const isTop = (Number(pt.y) || 0) >= aisleMid;
    return {
      bayX: fx(Number(pt.x) || 0) - BAY_W / 2,
      bayY: isTop ? fy((Number(pt.y) || 0) + BAY_OFF + BAY_D) : fy((Number(pt.y) || 0) - BAY_OFF)
    };
  };

  // 概览统计
  const values = samples.map((s) => s.v);
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const maxSample = samples.reduce((best, s) => (!best || s.v > best.v ? s : best), null);
  const minSample = samples.reduce((best, s) => (!best || s.v < best.v ? s : best), null);
  const overCount = samples.filter((s) => s.v > modeMeta.limit).length;
  const latestTs = readings.reduce((latest, r) => {
    const t = new Date(r.ts).getTime();
    return Number.isFinite(t) && t > latest ? t : latest;
  }, 0);

  const formatValue = (v) => `${v.toFixed(1)}${modeMeta.unit}`;

  return (
    <div className="card heatmap-card">
      <div className="card-header">
        <div>
          <div className="card-title">仓间{modeMeta.metric}平面分析</div>
          <div className="card-subtitle">
            {area.name} · 基于 {samples.length} 个巡检点位的空间插值分析
          </div>
        </div>
        <div className="heatmap-toolbar">
          <div className="chip-row">
            {Object.entries(MODES).map(([key, meta]) => (
              <button
                key={key}
                className={`chip ${mode === key ? 'active' : ''}`}
                onClick={() => setMode(key)}
              >
                {meta.label}
              </button>
            ))}
          </div>
          <div className="heatmap-legend">
            <span>{formatMetric(domain[0])}{modeMeta.unit}</span>
            <span className="heatmap-legend-bar" style={{ background: LEGEND_GRADIENT }} />
            <span>{formatMetric(domain[1])}{modeMeta.unit}</span>
          </div>
        </div>
      </div>

      <div className="heatmap-stats">
        <span>平均{modeMeta.metric}<strong>{avg === null ? '--' : formatValue(avg)}</strong></span>
        <span>
          最高<strong>{maxSample ? formatValue(maxSample.v) : '--'}</strong>
          {maxSample ? `（${maxSample.name || maxSample.id}）` : ''}
        </span>
        <span>
          最低<strong>{minSample ? formatValue(minSample.v) : '--'}</strong>
          {minSample ? `（${minSample.name || minSample.id}）` : ''}
        </span>
        <span>
          超阈点位<strong className={overCount ? 'heatmap-bad' : ''}>{overCount} 个</strong>
        </span>
        <span>读数更新 {latestTs ? formatAge(new Date(latestTs).toISOString()) : '--'}</span>
      </div>

      <div className="slam-floor heatmap-floor">
        <svg viewBox={`0 0 ${vbW} ${vbH}`} preserveAspectRatio="xMidYMid meet">
          {/* 库房轮廓 */}
          <rect x={PADDING} y={PADDING} width={w} height={h} rx={0.12}
            fill="rgba(9,32,72,0.9)" stroke="rgba(101,200,255,0.4)" strokeWidth={0.07} />

          {/* 热力层 */}
          {heatmapUrl && (
            <image href={heatmapUrl} x={PADDING} y={PADDING} width={w} height={h}
              preserveAspectRatio="none" opacity={0.62} />
          )}

          {/* 网格线 */}
          {Array.from({ length: Math.floor(w / gridStep) + 1 }, (_, i) => (
            <line key={`gv${i}`} x1={PADDING + i * gridStep} y1={PADDING} x2={PADDING + i * gridStep} y2={PADDING + h}
              stroke="rgba(101,200,255,0.1)" strokeWidth={0.03} />
          ))}
          {Array.from({ length: Math.floor(h / gridStep) + 1 }, (_, i) => (
            <line key={`gh${i}`} x1={PADDING} y1={PADDING + i * gridStep} x2={PADDING + w} y2={PADDING + i * gridStep}
              stroke="rgba(101,200,255,0.1)" strokeWidth={0.03} />
          ))}

          {/* 中央走道 */}
          {aisleMax > aisleMin && (
            <rect x={aisleX} y={fy(aisleMax)} width={aisleW} height={aisleMax - aisleMin}
              fill="rgba(101,200,255,0.05)" stroke="rgba(101,200,255,0.16)" strokeWidth={0.03} rx={0.08} />
          )}
          {aisleMax > aisleMin && (
            <text x={aisleX + aisleW / 2} y={fy(aisleMid) + 0.12} textAnchor="middle"
              fontSize={0.42} fill="rgba(205,231,255,0.5)">中 央 走 道</text>
          )}

          {/* 门：右短边进仓侧 */}
          <g>
            <rect x={PADDING + w - 0.08} y={fy(aisleMid) - 0.9} width={0.4} height={1.8} rx={0.08}
              fill="rgba(47,125,255,0.2)" stroke="#65c8ff" strokeWidth={0.05} />
            <text x={PADDING + w + 0.18} y={fy(aisleMid) - 1.1} textAnchor="middle"
              fontSize={0.38} fill="#8fd4ff">门</text>
          </g>

          {/* 垛位（半透明，透出底层热力） */}
          {points.map((pt) => {
            const { bayX, bayY } = bayGeom(pt);
            const rd = readingMap[pt.id];
            const v = rd ? num(rd[modeMeta.key]) : null;
            const abn = v !== null && v > modeMeta.limit;
            return (
              <rect key={`bay-${pt.id}`}
                x={bayX} y={bayY} width={BAY_W} height={BAY_D} rx={0.08}
                fill={abn ? 'rgba(248,113,113,0.18)' : 'rgba(217,189,147,0.14)'}
                stroke={abn ? 'rgba(248,113,113,0.9)' : 'rgba(217,189,147,0.5)'}
                strokeWidth={abn ? 0.09 : 0.045} />
            );
          })}

          {/* 采样点标记 + 读数标签 */}
          {points.map((pt) => {
            const rd = readingMap[pt.id];
            const v = rd ? num(rd[modeMeta.key]) : null;
            const abn = v !== null && v > modeMeta.limit;
            return (
              <g key={`pt-${pt.id}`}>
                <circle cx={fx(Number(pt.x) || 0)} cy={fy(Number(pt.y) || 0)} r={0.2}
                  fill="rgba(47,125,255,0.4)" stroke="#fff" strokeWidth={0.05} />
                <text x={fx(Number(pt.x) || 0)} y={fy(Number(pt.y) || 0) - 0.62} textAnchor="middle"
                  fontSize={0.3} fontWeight="600"
                  fill={abn ? '#f87171' : '#e8f3ff'}
                  stroke="rgba(9,32,72,0.85)" strokeWidth={0.025} paintOrder="stroke">
                  {pt.name || pt.id}
                </text>
                <text x={fx(Number(pt.x) || 0)} y={fy(Number(pt.y) || 0) - 0.26} textAnchor="middle"
                  fontSize={0.32} fontWeight="700"
                  fill={abn ? '#f87171' : '#e8f3ff'}
                  stroke="rgba(9,32,72,0.85)" strokeWidth={0.025} paintOrder="stroke">
                  {v === null ? '--' : formatValue(v)}
                </text>
              </g>
            );
          })}

          {!heatmapUrl && (
            <text x={PADDING + w / 2} y={PADDING + h / 2} textAnchor="middle" fontSize={0.5}
              fill="rgba(205,231,255,0.7)">暂无足够巡检读数，等待机器狗进仓采集后生成热力场</text>
          )}
        </svg>
      </div>

      <div className="heatmap-note">
        热力图根据巡检点位坐标与最新读数进行 IDW 空间插值，用于快速定位局部高{modeMeta.metric}区域；色带范围随当前读数自适应，每 30 秒刷新。
      </div>
    </div>
  );
};

export default WarehouseHeatmap;
