import React, { useMemo, useState } from 'react';
import {
  computeInspectionMapLayout,
  formatDateTime,
  formatMetric
} from '../lib/inspection.js';

const FRAME = { x: 48, y: 34, width: 1184 };
const PLOT = { x: 92, width: 1096, top: 258, bottomPadding: 104 };
const CARD = { width: 170, normalHeight: 94, alertHeight: 118 };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const InspectionRouteMap = ({
  area,
  points = [],
  actualTrail = [],
  pointReadings = []
}) => {
  const [activePointId, setActivePointId] = useState(null);
  const layout = useMemo(
    () => computeInspectionMapLayout({ area, points, trail: actualTrail }),
    [area, points, actualTrail]
  );

  if (!layout.bounds) {
    return <div className="map-empty-state">暂无可用于绘图的点位或轨迹坐标</div>;
  }

  const { bounds, canvas, source } = layout;
  const frameHeight = canvas.height - FRAME.y * 2;
  const plotBottom = canvas.height - PLOT.bottomPadding;
  const coordinateWidth = Math.max(bounds.maxX - bounds.minX, 1);
  const coordinateHeight = Math.max(bounds.maxY - bounds.minY, 1);
  const projectX = (value) =>
    PLOT.x + ((Number(value) - bounds.minX) / coordinateWidth) * PLOT.width;
  const projectY = (value) =>
    plotBottom -
    ((Number(value) - bounds.minY) / coordinateHeight) *
      (plotBottom - PLOT.top);

  // 预设路线按“蛇形”排序连线：上排西→东、下排东→西，避免按数组顺序连出斜穿全图的杂线。
  const routeYs = points.map((point) => Number(point.y));
  const aisleMid = routeYs.length
    ? (Math.min(...routeYs) + Math.max(...routeYs)) / 2
    : 0;
  const orderedRoute = [...points].sort((a, b) => {
    const aTop = Number(a.y) >= aisleMid;
    const bTop = Number(b.y) >= aisleMid;
    if (aTop !== bTop) return aTop ? -1 : 1;           // 上排在前
    return aTop ? Number(a.x) - Number(b.x) : Number(b.x) - Number(a.x);
  });
  const routePoints = orderedRoute
    .map((point) => `${projectX(point.x)},${projectY(point.y)}`)
    .join(' ');
  const trailPoints = actualTrail
    .map((point) => `${projectX(point.pos_x)},${projectY(point.pos_y)}`)
    .join(' ');
  const readingMap = Object.fromEntries(
    pointReadings.map((reading) => [reading.point_id, reading])
  );
  const areaName = area?.name || '未命名楼层';
  const areaMeta =
    source === 'configured'
      ? `${formatMetric(area.width)}m × ${formatMetric(area.height)}m`
      : '坐标范围自动适配';

  return (
    <div className="inspection-map-wrap">
      <div className="inspection-map-toolbar">
        <div className="inspection-map-heading">
          <div>
            <div className="card-title">巡检路线与点位读数</div>
            <div className="card-subtitle">单次进仓巡检的轨迹与环境采样</div>
          </div>
          <span className="inspection-map-divider" />
          <div className="inspection-floor-badge">
            <div>
              <strong>{areaName}</strong>
              <span>{areaMeta}</span>
            </div>
          </div>
        </div>

        <div className="inspection-map-legend" aria-label="地图图例">
          <span><i className="legend-line planned" />预设路线</span>
          <span><i className="legend-line actual" />实际轨迹</span>
          <span><i className="legend-state normal" />正常</span>
          <span><i className="legend-state abnormal" />异常</span>
        </div>
      </div>

      <div
        className="inspection-map-canvas"
        style={{ '--inspection-map-ratio': `${canvas.width} / ${canvas.height}` }}
      >
        <svg
          viewBox={`0 0 ${canvas.width} ${canvas.height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`${areaName}巡检路线与温湿度点位图`}
        >
          <defs>
            <linearGradient id="inspection-floor" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%" stopColor="#082c55" />
              <stop offset="55%" stopColor="#07335f" />
              <stop offset="100%" stopColor="#09294e" />
            </linearGradient>
            <linearGradient id="inspection-normal-card" x1="0" x2="1">
              <stop offset="0%" stopColor="#0b3b45" />
              <stop offset="100%" stopColor="#082f3c" />
            </linearGradient>
            <linearGradient id="inspection-alert-card" x1="0" x2="1">
              <stop offset="0%" stopColor="#59261d" />
              <stop offset="100%" stopColor="#40201d" />
            </linearGradient>
            <filter id="inspection-card-shadow" x="-35%" y="-35%" width="170%" height="190%">
              <feDropShadow
                dx="0"
                dy="10"
                stdDeviation="10"
                floodColor="#020b1f"
                floodOpacity="0.52"
              />
            </filter>
            <filter id="inspection-node-glow" x="-120%" y="-120%" width="340%" height="340%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <pattern
              id="inspection-grid"
              width="44"
              height="44"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M 44 0 L 0 0 0 44"
                fill="none"
                stroke="rgba(74,166,231,0.12)"
                strokeWidth="1"
              />
            </pattern>
          </defs>

          <rect
            x={FRAME.x}
            y={FRAME.y}
            width={FRAME.width}
            height={frameHeight}
            rx="12"
            fill="url(#inspection-floor)"
            stroke="rgba(61,169,226,0.58)"
            strokeWidth="2"
          />
          <rect
            x={FRAME.x}
            y={FRAME.y}
            width={FRAME.width}
            height={frameHeight}
            rx="12"
            fill="url(#inspection-grid)"
          />
          <rect
            x={FRAME.x + 8}
            y={FRAME.y + 8}
            width={FRAME.width - 16}
            height={frameHeight - 16}
            rx="8"
            fill="none"
            stroke="rgba(68,173,230,0.16)"
            strokeWidth="1"
          />

          {routePoints && (
            <polyline
              points={routePoints}
              fill="none"
              stroke="#299ee8"
              strokeWidth="3"
              strokeDasharray="10 9"
              strokeLinejoin="round"
              opacity="0.9"
            />
          )}

          {trailPoints && (
            <>
              <polyline
                points={trailPoints}
                fill="none"
                stroke="rgba(82,255,161,0.16)"
                strokeWidth="13"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <polyline
                points={trailPoints}
                fill="none"
                stroke="#58f59a"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          )}

          {points.map((point) => {
            const nodeX = projectX(point.x);
            const nodeY = projectY(point.y);
            const reading = readingMap[point.id];
            const abnormal = Boolean(reading?.temp_abnormal || reading?.rh_abnormal);
            const active = activePointId === point.id;
            const isTop = Number(point.y) >= aisleMid;
            const cardHeight = abnormal ? CARD.alertHeight : CARD.normalHeight;
            const cardX = clamp(
              nodeX - CARD.width / 2,
              FRAME.x + 18,
              FRAME.x + FRAME.width - CARD.width - 18
            );
            const cardY = clamp(
              nodeY - cardHeight - 92,
              FRAME.y + 28,
              nodeY - cardHeight - 48
            );
            const connectorX = clamp(
              nodeX,
              cardX + 26,
              cardX + CARD.width - 26
            );
            const statusColor = abnormal ? '#ff7138' : '#58f59a';

            return (
              <g
                key={point.id}
                className={`inspection-point ${active ? 'is-active' : ''}`}
                onMouseEnter={() => setActivePointId(point.id)}
                onMouseLeave={() => setActivePointId(null)}
                onFocus={() => setActivePointId(point.id)}
                onBlur={() => setActivePointId(null)}
                tabIndex="0"
                role="button"
                aria-label={`${point.id} ${point.name || ''} ${
                  reading
                    ? `${formatMetric(reading.temp_c)}摄氏度，湿度${formatMetric(reading.rh)}%`
                    : '暂无读数'
                }`}
              >
                {reading && active && (
                  <>
                    <polyline
                      points={`${connectorX},${cardY + cardHeight} ${connectorX},${nodeY - 29} ${nodeX},${nodeY - 15}`}
                      fill="none"
                      stroke={statusColor}
                      strokeWidth="1.5"
                      opacity={active ? 1 : 0.62}
                    />
                    <circle
                      cx={connectorX}
                      cy={cardY + cardHeight}
                      r="3"
                      fill={statusColor}
                    />

                    <g
                      className="inspection-reading-card"
                      filter="url(#inspection-card-shadow)"
                    >
                      <rect
                        x={cardX}
                        y={cardY}
                        width={CARD.width}
                        height={cardHeight}
                        rx="8"
                        fill={abnormal
                          ? 'url(#inspection-alert-card)'
                          : 'url(#inspection-normal-card)'}
                        stroke={abnormal
                          ? 'rgba(255,113,56,0.82)'
                          : 'rgba(88,245,154,0.52)'}
                        strokeWidth="1.5"
                      />
                      <rect
                        x={cardX}
                        y={cardY}
                        width="5"
                        height={cardHeight}
                        rx="6"
                        fill={statusColor}
                      />
                      <line
                        x1={cardX + 18}
                        y1={cardY + 47}
                        x2={cardX + CARD.width - 14}
                        y2={cardY + 47}
                        stroke="rgba(205,231,255,0.16)"
                        strokeWidth="1"
                      />

                      <text
                        x={cardX + 18}
                        y={cardY + 21}
                        fill="rgba(205,231,255,0.62)"
                        fontSize="11"
                      >
                        温度
                      </text>
                      <text
                        x={cardX + CARD.width - 15}
                        y={cardY + 31}
                        textAnchor="end"
                        fill="#ffffff"
                        fontSize="20"
                        fontWeight="700"
                      >
                        {formatMetric(reading.temp_c)}
                        <tspan fontSize="12" fontWeight="500"> ℃</tspan>
                      </text>

                      <text
                        x={cardX + 18}
                        y={cardY + 66}
                        fill="rgba(205,231,255,0.62)"
                        fontSize="11"
                      >
                        湿度
                      </text>
                      <text
                        x={cardX + CARD.width - 15}
                        y={cardY + 78}
                        textAnchor="end"
                        fill="#ffffff"
                        fontSize="20"
                        fontWeight="700"
                      >
                        {formatMetric(reading.rh)}
                        <tspan fontSize="12" fontWeight="500"> %</tspan>
                      </text>

                      {abnormal && (
                        <>
                          <line
                            x1={cardX + 6}
                            y1={cardY + 94}
                            x2={cardX + CARD.width}
                            y2={cardY + 94}
                            stroke="rgba(255,113,56,0.38)"
                            strokeWidth="1"
                          />
                          <circle
                            cx={cardX + 21}
                            cy={cardY + 106}
                            r="7"
                            fill="rgba(255,172,45,0.16)"
                            stroke="#ffad2d"
                            strokeWidth="1.5"
                          />
                          <text
                            x={cardX + 21}
                            y={cardY + 110}
                            textAnchor="middle"
                            fill="#ffba45"
                            fontSize="10"
                            fontWeight="700"
                          >
                            !
                          </text>
                          <text
                            x={cardX + 35}
                            y={cardY + 110}
                            fill="#ffd2bd"
                            fontSize="12"
                            fontWeight="700"
                          >
                            {reading.rh_abnormal ? '湿度超限' : '温度超限'}
                          </text>
                        </>
                      )}
                      <title>
                        {formatDateTime(reading.ts)} · {abnormal ? '存在越限' : '读数正常'}
                      </title>
                    </g>
                  </>
                )}

                <circle
                  cx={nodeX}
                  cy={nodeY}
                  r={active ? 20 : 16}
                  fill="none"
                  stroke={statusColor}
                  strokeWidth="2"
                  opacity={active ? 0.34 : 0.16}
                  filter={active ? 'url(#inspection-node-glow)' : undefined}
                />
                <circle
                  cx={nodeX}
                  cy={nodeY}
                  r="9"
                  fill={reading ? statusColor : '#2f7dff'}
                  stroke="#ffffff"
                  strokeWidth="2.5"
                />
                {/* 紧凑读数：未悬停时贴在节点外侧（上排朝上、下排朝下），温/湿度分两行
                    窄排显示，避免 23 列在水平方向堆叠、下排与走道侧标签相撞 */}
                {reading && !active && (
                  <>
                    <text
                      x={nodeX}
                      y={isTop ? nodeY - 28 : nodeY + 50}
                      textAnchor="middle"
                      fill={statusColor}
                      fontSize="12"
                      fontWeight="700"
                    >
                      {formatMetric(reading.temp_c)}°
                    </text>
                    <text
                      x={nodeX}
                      y={isTop ? nodeY - 15 : nodeY + 63}
                      textAnchor="middle"
                      fill={statusColor}
                      fontSize="12"
                      fontWeight="700"
                    >
                      {formatMetric(reading.rh)}%
                    </text>
                  </>
                )}
                {/* 短编号(垛号)常显；悬停时补全区房号+名称 */}
                <text
                  x={nodeX}
                  y={nodeY + 32}
                  textAnchor="middle"
                  fill="#ffffff"
                  fontSize="13"
                  fontWeight="700"
                >
                  {String(point.id).split('-').pop()}
                </text>
                {active && (
                  <text
                    x={nodeX}
                    y={nodeY + 48}
                    textAnchor="middle"
                    fill="rgba(205,231,255,0.72)"
                    fontSize="11"
                  >
                    {point.id}{point.name ? ` · ${point.name}` : ''}
                  </text>
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
