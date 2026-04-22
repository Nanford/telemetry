import React, { useEffect, useState, useRef } from 'react';
import { getSlamPoints, getSlamLatest, getSlamTrail, getSlamReadings } from '../api.js';

const POLL_MS = 30000;
const PADDING = 1.5;

function formatAge(ts) {
  if (!ts) return '--';
  const sec = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (sec < 60) return `${sec}s 前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m 前`;
  return `${Math.floor(sec / 3600)}h 前`;
}

const SlamMapTab = () => {
  const [area, setArea] = useState(null);
  const [points, setPoints] = useState([]);
  const [devices, setDevices] = useState([]);
  const [trail, setTrail] = useState([]);
  const [readings, setReadings] = useState([]);
  const pollRef = useRef(null);

  const loadAll = async () => {
    const [ptData, latestData, trailData, readData] = await Promise.all([
      getSlamPoints(),
      getSlamLatest(),
      getSlamTrail({ minutes: 60 }),
      getSlamReadings()
    ]);
    setArea(ptData.area);
    setPoints(ptData.points || []);
    setDevices(Array.isArray(latestData) ? latestData : []);
    setTrail(Array.isArray(trailData) ? trailData : []);
    setReadings(Array.isArray(readData) ? readData : []);
  };

  const pollDynamic = async () => {
    const [latestData, trailData, readData] = await Promise.all([
      getSlamLatest(),
      getSlamTrail({ minutes: 60 }),
      getSlamReadings()
    ]);
    setDevices(Array.isArray(latestData) ? latestData : []);
    setTrail(Array.isArray(trailData) ? trailData : []);
    setReadings(Array.isArray(readData) ? readData : []);
  };

  useEffect(() => {
    loadAll();
    pollRef.current = setInterval(pollDynamic, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, []);

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
          {devices.length > 0 && <span className="chip" style={{ marginLeft: 8 }}>{devices.length} 台在线</span>}
        </span>
      </div>

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
            <div className="slam-section-title">机器人状态</div>
            {devices.length === 0 && <div className="sensor-empty">暂无设备上报</div>}
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
