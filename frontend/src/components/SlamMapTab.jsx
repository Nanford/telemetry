import React, { useEffect, useState, useRef } from 'react';
import { createSlamStream, getSlamLive, getSlamPoints } from '../api.js';

const POLL_MS = 5000;
const PADDING = 1.5;
const TRAIL_WINDOW_MS = 60 * 60 * 1000;
const TRAIL_LIMIT = 2000;

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

  const w = area.width;
  const h = area.height;
  const vbW = w + PADDING * 2;
  const vbH = h + PADDING * 2;
  const fy = (y) => h - y + PADDING;
  const fx = (x) => x + PADDING;

  const readingMap = {};
  readings.forEach((r) => { readingMap[r.point_id] = r; });

  const num = (v) => Number(v) || 0;

  const trailStr = trail.map((t) => `${fx(num(t.pos_x))},${fy(num(t.pos_y))}`).join(' ');

  return (
    <div className="card map-card">
      <div className="card-header">
        <h3>室内定位平面图</h3>
        <span className="card-sub">
          {area.name} · {w}m × {h}m
          {devices.length > 0 && <span className="chip" style={{ marginLeft: 8 }}>{devices.length} 台有位置上报</span>}
          <span className="chip" style={{ marginLeft: 8 }}>
            {streamOnline ? '数据通道已连接' : '等待采集通道'}
          </span>
        </span>
      </div>

      {error && <div className="page-error">{error}</div>}

      <div className="map-body">
        {/* SVG floor plan */}
        <div className="slam-floor">
          <svg viewBox={`0 0 ${vbW} ${vbH}`} preserveAspectRatio="xMidYMid meet">
            {/* warehouse boundary */}
            <rect x={PADDING} y={PADDING} width={w} height={h} rx={0.15}
              fill="rgba(9,32,72,0.85)" stroke="rgba(101,200,255,0.35)" strokeWidth={0.06} />

            {/* grid lines */}
            {Array.from({ length: w + 1 }, (_, i) => (
              <line key={`gv${i}`} x1={fx(i)} y1={PADDING} x2={fx(i)} y2={PADDING + h}
                stroke="rgba(101,200,255,0.1)" strokeWidth={0.03} />
            ))}
            {Array.from({ length: h + 1 }, (_, i) => (
              <line key={`gh${i}`} x1={PADDING} y1={PADDING + i} x2={PADDING + w} y2={PADDING + i}
                stroke="rgba(101,200,255,0.1)" strokeWidth={0.03} />
            ))}

            {/* axis labels */}
            {Array.from({ length: Math.floor(w / 5) + 1 }, (_, i) => (
              <text key={`lx${i}`} x={fx(i * 5)} y={PADDING + h + 0.6}
                textAnchor="middle" fontSize={0.4} fill="rgba(205,231,255,0.5)">
                {i * 5}m
              </text>
            ))}

            {/* checkpoint zones */}
            {points.map((pt) => {
              const rd = readingMap[pt.id];
              return (
                <g key={pt.id}>
                  <circle cx={fx(pt.x)} cy={fy(pt.y)} r={pt.radius}
                    fill="rgba(47,125,255,0.12)" stroke="rgba(47,125,255,0.5)" strokeWidth={0.05}
                    strokeDasharray="0.15 0.08" />
                  <text x={fx(pt.x)} y={fy(pt.y) - pt.radius - 0.25}
                    textAnchor="middle" fontSize={0.38} fontWeight="600" fill="#65c8ff">
                    {pt.id}
                  </text>
                  <text x={fx(pt.x)} y={fy(pt.y) + 0.05}
                    textAnchor="middle" fontSize={0.28} fill="rgba(205,231,255,0.7)">
                    {pt.name}
                  </text>
                  {rd && (
                    <text x={fx(pt.x)} y={fy(pt.y) + 0.45}
                      textAnchor="middle" fontSize={0.3} fill="#4ade80">
                      {rd.temp_c}° / {rd.rh}%
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
