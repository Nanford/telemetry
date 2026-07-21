import React, { useEffect, useState, useRef } from 'react';
import { createSlamStream, getSlamLive, getSlamPoints } from '../api.js';
import {
  computeInspectionMapLayout,
  computeMapGridStep,
  formatMetric
} from '../lib/inspection.js';

const POLL_MS = 5000;
const PADDING = 1.5;
const TRAIL_WINDOW_MS = 60 * 60 * 1000;
const TRAIL_LIMIT = 2000;
// 告警阈值(与采集端/仿真一致)：超过则该垛位读数标红、垛位描红框。
const TEMP_LIMIT = 32;
const RH_LIMIT = 65;

function formatAge(ts) {
  if (!ts) return '--';
  const sec = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (sec < 60) return `${sec}s 前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m 前`;
  return `${Math.floor(sec / 3600)}h 前`;
}

const timeMs = (ts) => {
  const parsed = new Date(ts).getTime();
  return Number.isNaN(parsed) ? Date.now() : parsed;
};

const pruneTrail = (items) => {
  const cutoff = Date.now() - TRAIL_WINDOW_MS;
  return items
    .filter((item) => timeMs(item.ts) >= cutoff)
    .slice(-TRAIL_LIMIT);
};

const SlamMapTab = () => {
  const [area, setArea] = useState(null);
  const [points, setPoints] = useState([]);
  const [devices, setDevices] = useState([]);
  const [trail, setTrail] = useState([]);
  const [readings, setReadings] = useState([]);
  const [streamOnline, setStreamOnline] = useState(false);
  const [error, setError] = useState('');
  const pollRef = useRef(null);
  const streamRef = useRef(null);
  const streamOnlineRef = useRef(false);

  const updateStreamOnline = (online) => {
    streamOnlineRef.current = online;
    setStreamOnline(online);
  };

  const applyLivePoint = (point) => {
    if (!point?.device_id || point.pos_x == null || point.pos_y == null) return;

    setDevices((prev) => {
      const next = new Map(prev.map((item) => [item.device_id, item]));
      const current = next.get(point.device_id);
      if (!current || timeMs(point.ts) >= timeMs(current.ts)) {
        next.set(point.device_id, point);
      }
      return Array.from(next.values());
    });

    setTrail((prev) => pruneTrail([...prev, point]));

    // Point readings are derived from live MQTT samples when the robot reports a checkpoint.
    if (point.point_id && (point.temp_c != null || point.rh != null)) {
      setReadings((prev) => {
        const next = new Map(prev.map((item) => [item.point_id, item]));
        next.set(point.point_id, {
          point_id: point.point_id,
          temp_c: point.temp_c,
          rh: point.rh,
          ts: point.ts,
          device_id: point.device_id
        });
        return Array.from(next.values());
      });
    }
  };

  const loadAll = async () => {
    try {
      const [ptData, liveData] = await Promise.all([
        getSlamPoints(),
        getSlamLive()
      ]);
      setArea(ptData.area);
      setPoints(ptData.points || []);
      setDevices(Array.isArray(liveData.latest) ? liveData.latest : []);
      setTrail(pruneTrail(Array.isArray(liveData.trail) ? liveData.trail : []));
      setError('');
    } catch (requestError) {
      setError(requestError.message || '巡检地图加载失败');
    }
  };

  const pollDynamic = async () => {
    if (streamOnlineRef.current) return;
    try {
      const liveData = await getSlamLive();
      setDevices(Array.isArray(liveData.latest) ? liveData.latest : []);
      setTrail(pruneTrail(Array.isArray(liveData.trail) ? liveData.trail : []));
      setError('');
    } catch (requestError) {
      setError(requestError.message || '巡检位置数据加载失败');
    }
  };

  useEffect(() => {
    loadAll();
    pollRef.current = setInterval(pollDynamic, POLL_MS);
    streamRef.current = createSlamStream();

    streamRef.current.addEventListener('open', () => updateStreamOnline(true));
    streamRef.current.addEventListener('snapshot', (event) => {
      const payload = JSON.parse(event.data);
      updateStreamOnline(true);
      setDevices(Array.isArray(payload.latest) ? payload.latest : []);
      setTrail(pruneTrail(Array.isArray(payload.trail) ? payload.trail : []));
    });
    streamRef.current.addEventListener('slam', (event) => {
      updateStreamOnline(true);
      applyLivePoint(JSON.parse(event.data));
    });
    streamRef.current.addEventListener('error', () => updateStreamOnline(false));

    return () => {
      clearInterval(pollRef.current);
      streamRef.current?.close();
    };
  }, []);

  if (error && !area) return <div className="page-error">{error}</div>;
  if (!area) return <div className="card" style={{ padding: 24 }}>加载中…</div>;

  const mapLayout = computeInspectionMapLayout({
    area,
    points,
    trail
  });
  if (!mapLayout.bounds) {
    return <div className="card" style={{ padding: 24 }}>暂无可用于绘图的坐标数据</div>;
  }
  const { bounds } = mapLayout;
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const vbW = w + PADDING * 2;
  const vbH = h + PADDING * 2;
  const fy = (y) => bounds.maxY - y + PADDING;
  const fx = (x) => x - bounds.minX + PADDING;
  const gridStep = computeMapGridStep(Math.max(w, h));
  const axisStep = gridStep * 5;
  const dimensionLabel =
    mapLayout.source === 'configured'
      ? `${formatMetric(area.width)}m × ${formatMetric(area.height)}m`
      : '坐标范围自动适配';

  const readingMap = {};
  readings.forEach((r) => { readingMap[r.point_id] = r; });

  const num = (v) => Number(v) || 0;

  // 垛位矩形：采集点在走道侧，矩形向远离走道方向延伸（贴近平面图成对短垛）。
  // 走道中线 = 上下两排采集点 y 的中点。
  const ptYs = points.map((p) => num(p.y));
  const aisleMin = ptYs.length ? Math.min(...ptYs) : 0;
  const aisleMax = ptYs.length ? Math.max(...ptYs) : 0;
  const aisleMid = (aisleMin + aisleMax) / 2;
  // 成对短矩形：宽约列距 1.5m 的 85%，进深 3.2m（不再用 7m 超高条）
  const BAY_W = 1.28;
  const BAY_D = 3.2;
  const BAY_OFF = 0.25;

  // 平面图成对分组：北排 (07,08)…；南排 (06,05)… 与 (23,22)…；(19) 单独
  const PAIR_IDS = [
    ['A-1-2-07', 'A-1-2-08'], ['A-1-2-09', 'A-1-2-10'], ['A-1-2-11', 'A-1-2-12'],
    ['A-1-2-13', 'A-1-2-14'], ['A-1-2-15', 'A-1-2-16'], ['A-1-2-17', 'A-1-2-18'],
    ['A-1-2-06', 'A-1-2-05'], ['A-1-2-04', 'A-1-2-03'], ['A-1-2-02', 'A-1-2-01'],
    ['A-1-2-23', 'A-1-2-22'], ['A-1-2-21', 'A-1-2-20']
  ];
  const pointById = Object.fromEntries(points.map((p) => [p.id, p]));
  const bayGeom = (pt) => {
    const isTop = num(pt.y) >= aisleMid;
    const bayX = fx(pt.x) - BAY_W / 2;
    const bayY = isTop ? fy(num(pt.y) + BAY_OFF + BAY_D) : fy(num(pt.y) - BAY_OFF);
    const labelY = fy(isTop ? num(pt.y) + BAY_OFF + BAY_D / 2 : num(pt.y) - BAY_OFF - BAY_D / 2);
    return { isTop, bayX, bayY, labelY };
  };

  // 走道只画在垛位 x 范围，避免整房横向通栏空白感
  const ptXs = points.map((p) => num(p.x));
  const baySpanMinX = ptXs.length ? Math.min(...ptXs) - BAY_W / 2 - 0.3 : bounds.minX;
  const baySpanMaxX = ptXs.length ? Math.max(...ptXs) + BAY_W / 2 + 0.3 : bounds.maxX;
  const aisleX = fx(baySpanMinX);
  const aisleW = Math.max(baySpanMaxX - baySpanMinX, 1);

  const trailStr = trail.map((t) => `${fx(num(t.pos_x))},${fy(num(t.pos_y))}`).join(' ');

  return (
    <div className="card map-card">
      <div className="card-header">
        <h3>室内定位平面图</h3>
        <span className="card-sub">
          {area.name} · {dimensionLabel}
          {devices.length > 0 && <span className="chip" style={{ marginLeft: 8 }}>{devices.length} 台有位置上报</span>}
          <span className="chip" style={{ marginLeft: 8 }}>
            {streamOnline ? '数据通道已连接' : '等待采集通道'}
          </span>
        </span>
      </div>

      {error && <div className="page-error">{error}</div>}

      <div className="map-body">
        {/* SVG floor plan — A-1-2 单间，上下成对垛位 + 中央走道 */}
        <div className="slam-floor">
          <svg viewBox={`0 0 ${vbW} ${vbH}`} preserveAspectRatio="xMidYMid meet">
            {/* room boundary */}
            <rect x={PADDING} y={PADDING} width={w} height={h} rx={0.12}
              fill="rgba(9,32,72,0.9)" stroke="rgba(101,200,255,0.4)" strokeWidth={0.07} />

            {/* grid lines */}
            {Array.from({ length: Math.floor(w / gridStep) + 1 }, (_, i) => (
              <line key={`gv${i}`} x1={PADDING + i * gridStep} y1={PADDING} x2={PADDING + i * gridStep} y2={PADDING + h}
                stroke="rgba(101,200,255,0.1)" strokeWidth={0.03} />
            ))}
            {Array.from({ length: Math.floor(h / gridStep) + 1 }, (_, i) => (
              <line key={`gh${i}`} x1={PADDING} y1={PADDING + i * gridStep} x2={PADDING + w} y2={PADDING + i * gridStep}
                stroke="rgba(101,200,255,0.1)" strokeWidth={0.03} />
            ))}

            {/* axis labels */}
            {Array.from({ length: Math.floor(w / axisStep) + 1 }, (_, i) => (
              <text key={`lx${i}`} x={PADDING + i * axisStep} y={PADDING + h + 0.55}
                textAnchor="middle" fontSize={0.38} fill="rgba(205,231,255,0.5)">
                {formatMetric(bounds.minX + i * axisStep, 0)}m
              </text>
            ))}

            {/* central aisle band between the two rack rows */}
            {aisleMax > aisleMin && (
              <rect x={aisleX} y={fy(aisleMax)} width={aisleW} height={aisleMax - aisleMin}
                fill="rgba(101,200,255,0.07)" stroke="rgba(101,200,255,0.16)" strokeWidth={0.03} rx={0.08} />
            )}
            {aisleMax > aisleMin && (
              <text x={aisleX + aisleW / 2} y={fy(aisleMid) + 0.12} textAnchor="middle"
                fontSize={0.42} fill="rgba(101,200,255,0.45)">中 央 走 道</text>
            )}

            {/* 门：右短边进仓侧 */}
            <g>
              <rect x={PADDING + w - 0.08} y={fy(aisleMid) - 0.9} width={0.4} height={1.8} rx={0.08}
                fill="rgba(47,125,255,0.2)" stroke="#65c8ff" strokeWidth={0.05} />
              <text x={PADDING + w + 0.18} y={fy(aisleMid) - 1.1} textAnchor="middle"
                fontSize={0.38} fill="#8fd4ff">门</text>
            </g>

            {/* pair frames — 成对外框，贴近平面图双列垛 */}
            {PAIR_IDS.map((pair) => {
              const members = pair.map((id) => pointById[id]).filter(Boolean);
              if (members.length < 2) return null;
              const xs = members.map((p) => num(p.x));
              const isTop = num(members[0].y) >= aisleMid;
              const minX = Math.min(...xs) - BAY_W / 2 - 0.08;
              const maxX = Math.max(...xs) + BAY_W / 2 + 0.08;
              const outerY = isTop
                ? fy(num(members[0].y) + BAY_OFF + BAY_D + 0.08)
                : fy(num(members[0].y) - BAY_OFF + 0.08);
              return (
                <rect key={`pair-${pair.join('_')}`}
                  x={fx(minX)} y={outerY}
                  width={maxX - minX} height={BAY_D + 0.16} rx={0.1}
                  fill="none" stroke="rgba(217,189,147,0.22)" strokeWidth={0.04} />
              );
            })}

            {/* bay stacks — 成对短矩形；编号 A-1 / 2-07；告警红框 */}
            {points.map((pt) => {
              const { bayX, bayY, labelY } = bayGeom(pt);
              const rd = readingMap[pt.id];
              const abn = rd && (num(rd.temp_c) > TEMP_LIMIT || num(rd.rh) > RH_LIMIT);
              const seg = String(pt.id).split('-'); // A-1-2-07 -> [A,1,2,07]
              const line1 = seg.length >= 4 ? `${seg[0]}-${seg[1]}` : pt.id;
              const line2 = seg.length >= 4 ? `${seg[2]}-${seg[3]}` : '';
              return (
                <g key={`bay-${pt.id}`}>
                  <rect x={bayX} y={bayY} width={BAY_W} height={BAY_D} rx={0.08}
                    fill={abn ? 'rgba(248,113,113,0.16)' : 'rgba(217,189,147,0.22)'}
                    stroke={abn ? 'rgba(248,113,113,0.9)' : 'rgba(217,189,147,0.65)'}
                    strokeWidth={abn ? 0.09 : 0.045} />
                  {/* 货架层线，接近平面图格纹 */}
                  {[0.25, 0.5, 0.75].map((t) => (
                    <line key={`sl-${pt.id}-${t}`}
                      x1={bayX + 0.08} x2={bayX + BAY_W - 0.08}
                      y1={bayY + BAY_D * t} y2={bayY + BAY_D * t}
                      stroke="rgba(217,189,147,0.18)" strokeWidth={0.025} />
                  ))}
                  <text x={fx(pt.x)} y={labelY - 0.18} textAnchor="middle"
                    fontSize={0.42} fontWeight="700" fill="rgba(235,214,176,0.95)">
                    {line1}
                  </text>
                  {line2 && (
                    <text x={fx(pt.x)} y={labelY + 0.36} textAnchor="middle"
                      fontSize={0.42} fontWeight="700" fill="rgba(235,214,176,0.95)">
                      {line2}
                    </text>
                  )}
                </g>
              );
            })}

            {/* checkpoint dwell dots + live readings */}
            {points.map((pt) => {
              const rd = readingMap[pt.id];
              const abn = rd && (num(rd.temp_c) > TEMP_LIMIT || num(rd.rh) > RH_LIMIT);
              return (
                <g key={pt.id}>
                  <circle cx={fx(pt.x)} cy={fy(pt.y)} r={0.22}
                    fill="rgba(47,125,255,0.32)" stroke="#65c8ff" strokeWidth={0.045} />
                  {rd && (
                    <text x={fx(pt.x)} y={fy(pt.y) - 0.38}
                      textAnchor="middle" fontSize={0.3} fontWeight="600" fill={abn ? '#f87171' : '#4ade80'}>
                      {rd.temp_c}°/{rd.rh}%
                    </text>
                  )}
                </g>
              );
            })}

            {/* trail */}
            {trailStr && (
              <polyline points={trailStr} fill="none"
                stroke="rgba(101,200,255,0.35)" strokeWidth={0.06}
                strokeDasharray="0.2 0.1" strokeLinejoin="round" />
            )}

            {/* robot positions */}
            {devices.map((dev) => {
              const dx = num(dev.pos_x), dy = num(dev.pos_y);
              return (
              <g key={dev.device_id}>
                <circle cx={fx(dx)} cy={fy(dy)} r={0.25}
                  fill="rgba(78,222,128,0.3)" stroke="none">
                  <animate attributeName="r" values="0.25;0.45;0.25" dur="2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="1;0.3;1" dur="2s" repeatCount="indefinite" />
                </circle>
                <circle cx={fx(dx)} cy={fy(dy)} r={0.18}
                  fill="#4ade80" stroke="#fff" strokeWidth={0.04} />
                <line
                  x1={fx(dx)} y1={fy(dy)}
                  x2={fx(dx) + Math.cos(num(dev.yaw)) * 0.4}
                  y2={fy(dy) - Math.sin(num(dev.yaw)) * 0.4}
                  stroke="#4ade80" strokeWidth={0.06} strokeLinecap="round" />
                <text x={fx(dx)} y={fy(dy) - 0.4}
                  textAnchor="middle" fontSize={0.3} fill="#4ade80" fontWeight="600">
                  {dev.device_id}
                </text>
              </g>
              );
            })}
          </svg>
        </div>

        {/* sidebar */}
        <div className="map-list slam-sidebar">
          <div className="slam-section">
            <div className="slam-section-title">最近位置上报</div>
            {devices.length === 0 && <div className="sensor-empty">当前没有机器狗进仓采集</div>}
            {devices.map((dev) => (
              <div key={dev.device_id} className="slam-device-row">
                <div className="slam-device-name">
                  <span className="health-dot ok" />
                  {dev.device_id}
                </div>
                <div className="slam-device-meta">
                  坐标 ({num(dev.pos_x).toFixed(2)}, {num(dev.pos_y).toFixed(2)})
                  {dev.point_id && <> · 靠近 <strong>{dev.point_id}</strong></>}
                </div>
                <div className="slam-device-meta">
                  {dev.temp_c != null && <>{dev.temp_c}°C / {dev.rh}%</>}
                  <span style={{ marginLeft: 8, opacity: 0.6 }}>{formatAge(dev.ts)}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="slam-section">
            <div className="slam-section-title">巡检点读数</div>
            {points.map((pt) => {
              const rd = readingMap[pt.id];
              return (
                <div key={pt.id} className="slam-reading-row">
                  <div className="slam-reading-label">
                    <strong>{pt.id}</strong> {pt.name}
                  </div>
                  {rd ? (
                    <div className="slam-reading-values">
                      <span>{rd.temp_c}°C</span>
                      <span>{rd.rh}%</span>
                      <span className="slam-reading-age">{formatAge(rd.ts)}</span>
                    </div>
                  ) : (
                    <div className="slam-reading-values" style={{ opacity: 0.4 }}>--</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SlamMapTab;
