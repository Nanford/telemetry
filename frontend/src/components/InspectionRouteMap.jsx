import React from 'react';
import { formatDateTime, formatMetric } from '../lib/inspection.js';

const PADDING = 1.4;

const InspectionRouteMap = ({ area, points = [], actualTrail = [], pointReadings = [] }) => {
  if (!area) {
    return <div className="map-empty-state">暂无场地图配置</div>;
  }

  const width = Number(area.width) || 20;
  const height = Number(area.height) || 6;
  const viewWidth = width + PADDING * 2;
  const viewHeight = height + PADDING * 2;
  const x = (value) => Number(value) + PADDING;
  const y = (value) => height - Number(value) + PADDING;
  const routePoints = points.map((point) => `${x(point.x)},${y(point.y)}`).join(' ');
  const trailPoints = actualTrail.map((point) => `${x(point.pos_x)},${y(point.pos_y)}`).join(' ');
  const readingMap = Object.fromEntries(pointReadings.map((reading) => [reading.point_id, reading]));

  return (
    <div className="inspection-map-wrap">
      <div className="inspection-map-toolbar">
        <div>
          <div className="card-title">巡检路线与点位读数</div>
          <div className="card-subtitle">{area.name} · {width}m × {height}m</div>
        </div>
        <div className="inspection-map-legend">
          <span><i className="legend-line planned" />预设路线</span>
          <span><i className="legend-line actual" />实际轨迹</span>
          <span><i className="legend-bubble" />温湿度读数</span>
        </div>
      </div>

      <div className="inspection-map-canvas">
        <svg viewBox={`0 0 ${viewWidth} ${viewHeight}`} preserveAspectRatio="xMidYMid meet">
          <defs>
            <linearGradient id="inspection-floor" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%" stopColor="#0b2550" />
              <stop offset="100%" stopColor="#102f63" />
            </linearGradient>
            <filter id="bubble-shadow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="0.08" stdDeviation="0.12" floodColor="#020b1f" floodOpacity="0.45" />
            </filter>
          </defs>

          <rect
            x={PADDING}
            y={PADDING}
            width={width}
            height={height}
            rx={0.18}
            fill="url(#inspection-floor)"
            stroke="rgba(101,200,255,0.42)"
            strokeWidth={0.06}
          />

          {Array.from({ length: Math.floor(width) + 1 }, (_, index) => (
            <line
              key={`vertical-${index}`}
              x1={x(index)}
              x2={x(index)}
              y1={PADDING}
              y2={PADDING + height}
              stroke="rgba(101,200,255,0.09)"
              strokeWidth={0.025}
            />
          ))}
          {Array.from({ length: Math.floor(height) + 1 }, (_, index) => (
            <line
              key={`horizontal-${index}`}
              x1={PADDING}
              x2={PADDING + width}
              y1={PADDING + index}
              y2={PADDING + index}
              stroke="rgba(101,200,255,0.09)"
              strokeWidth={0.025}
            />
          ))}

          {routePoints && (
            <polyline
              points={routePoints}
              fill="none"
              stroke="rgba(101,200,255,0.6)"
              strokeWidth={0.08}
              strokeDasharray="0.22 0.13"
              strokeLinejoin="round"
            />
          )}

          {trailPoints && (
            <polyline
              points={trailPoints}
              fill="none"
              stroke="#6dff9c"
              strokeWidth={0.11}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {points.map((point, index) => {
            const reading = readingMap[point.id];
            const abnormal = reading?.temp_abnormal || reading?.rh_abnormal;
            return (
              <g key={point.id}>
                <circle
                  cx={x(point.x)}
                  cy={y(point.y)}
                  r={Number(point.radius) || 0.8}
                  fill="rgba(47,125,255,0.12)"
                  stroke="rgba(101,200,255,0.55)"
                  strokeWidth={0.05}
                  strokeDasharray="0.16 0.08"
                />
                <circle
                  cx={x(point.x)}
                  cy={y(point.y)}
                  r={0.18}
                  fill={reading ? (abnormal ? '#ff8c42' : '#6dff9c') : '#2f7dff'}
                  stroke="#ffffff"
                  strokeWidth={0.04}
                />
                <text
                  x={x(point.x)}
                  y={y(point.y) - (Number(point.radius) || 0.8) - 0.18}
                  textAnchor="middle"
                  fontSize={0.34}
                  fontWeight="700"
                  fill="#dcecff"
                >
                  {index + 1}. {point.id}
                </text>
                {reading && (
                  <g filter="url(#bubble-shadow)">
                    <rect
                      x={x(point.x) - 0.82}
                      y={y(point.y) + 0.3}
                      width={1.64}
                      height={0.72}
                      rx={0.18}
                      fill={abnormal ? '#a84e24' : '#176a52'}
                      stroke="rgba(255,255,255,0.35)"
                      strokeWidth={0.025}
                    >
                      <title>{formatDateTime(reading.ts)}</title>
                    </rect>
                    <text
                      x={x(point.x)}
                      y={y(point.y) + 0.62}
                      textAnchor="middle"
                      fontSize={0.28}
                      fontWeight="700"
                      fill="#ffffff"
                    >
                      {formatMetric(reading.temp_c)}℃ / {formatMetric(reading.rh)}%
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>

        {actualTrail.length === 0 && (
          <div className="inspection-map-empty">
            <strong>暂无本批次实际轨迹</strong>
            <span>当前仅显示系统配置的预设巡检路线</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default InspectionRouteMap;
