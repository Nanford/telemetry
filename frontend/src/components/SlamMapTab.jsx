/**
 * 仓间巡检地图。
 *
 * 平面图只投射当前仓间边界内的已配置点位、轨迹和设备位置。越界或无法定位的
 * 原始上报不会扩张画布，也不会被推测到某个库位，确保巡检视图与实际仓间保持一致。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createSlamStream, getSlamLive, getSlamPoints, getSlamReadings } from '../api.js';
import { computeMapGridStep, formatMetric } from '../lib/inspection.js';

const POLL_MS = 5000;
const TRAIL_WINDOW_MS = 60 * 60 * 1000;
const TRAIL_LIMIT = 2000;
const FRESH_WINDOW_MS = 30 * 60 * 1000;
const MAP_PADDING = 0.75;
const TEMP_LIMIT = 32;
const RH_LIMIT = 65;
const BAY_W = 1.28;
const BAY_D = 3.2;
const BAY_OFFSET = 0.25;

const num = (value) => {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};

const timeMs = (timestamp) => {
  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) ? value : 0;
};

const formatAge = (timestamp) => {
  const time = timeMs(timestamp);
  if (!time) return '--';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s 前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m 前`;
  return `${Math.floor(seconds / 3600)}h 前`;
};

const pruneTrail = (items = []) => {
  const cutoff = Date.now() - TRAIL_WINDOW_MS;
  return items.filter((item) => timeMs(item.ts) >= cutoff).slice(-TRAIL_LIMIT);
};

const withinBounds = (x, y, bounds) => {
  const px = num(x);
  const py = num(y);
  return px !== null && py !== null && px >= bounds.minX && px <= bounds.maxX && py >= bounds.minY && py <= bounds.maxY;
};

const SlamMapTab = () => {
  const [area, setArea] = useState(null);
  const [points, setPoints] = useState([]);
  const [devices, setDevices] = useState([]);
  const [trail, setTrail] = useState([]);
  const [readings, setReadings] = useState([]);
  const [streamOnline, setStreamOnline] = useState(false);
  const [showTrail, setShowTrail] = useState(true);
  const [showReadings, setShowReadings] = useState(true);
  const [selectedPointId, setSelectedPointId] = useState(null);
  const [error, setError] = useState('');
  const streamOnlineRef = useRef(false);

  const setStreamState = (online) => {
    streamOnlineRef.current = online;
    setStreamOnline(online);
  };

  const applyLivePoint = (point) => {
    if (!point?.device_id || num(point.pos_x) === null || num(point.pos_y) === null) return;

    setDevices((previous) => {
      const next = new Map(previous.map((item) => [item.device_id, item]));
      const current = next.get(point.device_id);
      if (!current || timeMs(point.ts) >= timeMs(current.ts)) next.set(point.device_id, point);
      return Array.from(next.values());
    });
    setTrail((previous) => pruneTrail([...previous, point]));

    // 仅在巡检设备明确回报点位编号时，将读数写入该已标定点位。
    if (point.point_id && (point.temp_c != null || point.rh != null)) {
      setReadings((previous) => {
        const next = new Map(previous.map((item) => [item.point_id, item]));
        const current = next.get(point.point_id);
        if (!current || timeMs(point.ts) >= timeMs(current.ts)) {
          next.set(point.point_id, {
            point_id: point.point_id,
            temp_c: point.temp_c,
            rh: point.rh,
            ts: point.ts,
            device_id: point.device_id
          });
        }
        return Array.from(next.values());
      });
    }
  };

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [pointData, liveData, readingData] = await Promise.all([
          getSlamPoints(),
          getSlamLive(),
          getSlamReadings()
        ]);
        if (cancelled) return;
        setArea(pointData.area || null);
        setPoints(Array.isArray(pointData.points) ? pointData.points : []);
        setDevices(Array.isArray(liveData.latest) ? liveData.latest : []);
        setTrail(pruneTrail(Array.isArray(liveData.trail) ? liveData.trail : []));
        setReadings(Array.isArray(readingData) ? readingData : []);
        setError('');
      } catch (requestError) {
        if (!cancelled) setError(requestError.message || '巡检地图加载失败');
      }
    };

    const poll = async () => {
      if (streamOnlineRef.current) return;
      try {
        const [liveData, readingData] = await Promise.all([getSlamLive(), getSlamReadings()]);
        if (cancelled) return;
        setDevices(Array.isArray(liveData.latest) ? liveData.latest : []);
        setTrail(pruneTrail(Array.isArray(liveData.trail) ? liveData.trail : []));
        setReadings(Array.isArray(readingData) ? readingData : []);
        setError('');
      } catch (requestError) {
        if (!cancelled) setError(requestError.message || '巡检位置数据加载失败');
      }
    };

    load();
    const timer = setInterval(poll, POLL_MS);
    const stream = createSlamStream();

    stream.addEventListener('open', () => setStreamState(true));
    stream.addEventListener('snapshot', (event) => {
      try {
        const payload = JSON.parse(event.data);
        setStreamState(true);
        setDevices(Array.isArray(payload.latest) ? payload.latest : []);
        setTrail(pruneTrail(Array.isArray(payload.trail) ? payload.trail : []));
        if (Array.isArray(payload.readings)) setReadings(payload.readings);
      } catch {
        setStreamState(false);
      }
    });
    stream.addEventListener('slam', (event) => {
      try {
        setStreamState(true);
        applyLivePoint(JSON.parse(event.data));
      } catch {
        setStreamState(false);
      }
    });
    stream.addEventListener('error', () => setStreamState(false));

    return () => {
      cancelled = true;
      clearInterval(timer);
      stream.close();
    };
  }, []);

  // 画布优先使用已配置仓间尺寸；只有缺失尺寸时，才根据已标定点位推导矩形范围。
  const bounds = useMemo(() => {
    const configuredWidth = num(area?.width);
    const configuredHeight = num(area?.height);
    if (configuredWidth && configuredHeight) {
      return { minX: 0, maxX: configuredWidth, minY: 0, maxY: configuredHeight, configured: true };
    }

    const xs = points.map((point) => num(point.x)).filter((value) => value !== null);
    const ys = points.map((point) => num(point.y)).filter((value) => value !== null);
    if (!xs.length || !ys.length) return null;
    return {
      minX: Math.min(0, Math.min(...xs) - BAY_W / 2 - 0.8),
      maxX: Math.max(...xs) + BAY_W / 2 + 0.8,
      minY: Math.min(0, Math.min(...ys) - BAY_D - BAY_OFFSET - 0.8),
      maxY: Math.max(...ys) + BAY_D + BAY_OFFSET + 0.8,
      configured: false
    };
  }, [area, points]);

  const mappedPoints = useMemo(() => {
    if (!bounds) return [];
    return points.filter((point) => withinBounds(point.x, point.y, bounds));
  }, [bounds, points]);

  const visibleTrail = useMemo(() => (
    bounds ? trail.filter((item) => withinBounds(item.pos_x, item.pos_y, bounds)) : []
  ), [bounds, trail]);

  const visibleDevices = useMemo(() => (
    bounds ? devices.filter((item) => withinBounds(item.pos_x, item.pos_y, bounds)) : []
  ), [bounds, devices]);

  const latestReadings = useMemo(() => {
    const knownIds = new Set(mappedPoints.map((point) => point.id));
    const result = new Map();
    readings.forEach((reading) => {
      if (!knownIds.has(reading.point_id) || !timeMs(reading.ts)) return;
      const previous = result.get(reading.point_id);
      if (!previous || timeMs(reading.ts) > timeMs(previous.ts)) result.set(reading.point_id, reading);
    });
    return result;
  }, [mappedPoints, readings]);

  const freshReadings = useMemo(() => {
    const cutoff = Date.now() - FRESH_WINDOW_MS;
    return new Map(Array.from(latestReadings.entries()).filter(([, reading]) => timeMs(reading.ts) >= cutoff));
  }, [latestReadings]);

  const latestTimestamp = useMemo(() => Math.max(0, ...Array.from(latestReadings.values()).map((reading) => timeMs(reading.ts))), [latestReadings]);

  if (error && !area) return <div className="page-error">{error}</div>;
  if (!area || !bounds) return <div className="card" style={{ padding: 24 }}>加载中…</div>;

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const viewWidth = width + MAP_PADDING * 2;
  const viewHeight = height + MAP_PADDING * 2;
  const fx = (x) => x - bounds.minX + MAP_PADDING;
  const fy = (y) => bounds.maxY - y + MAP_PADDING;
  const gridStep = computeMapGridStep(Math.max(width, height), 32);
  const pointXs = mappedPoints.map((point) => num(point.x)).filter((value) => value !== null);
  const pointYs = mappedPoints.map((point) => num(point.y)).filter((value) => value !== null);
  const southRowY = pointYs.length ? Math.min(...pointYs) : height * 0.42;
  const northRowY = pointYs.length ? Math.max(...pointYs) : height * 0.58;
  const rowMiddle = (southRowY + northRowY) / 2;
  const aisleStart = pointXs.length ? Math.min(...pointXs) - BAY_W / 2 - 0.22 : 0.7;
  const aisleEnd = pointXs.length ? Math.max(...pointXs) + BAY_W / 2 + 0.22 : width - 0.7;
  const trailPath = visibleTrail.map((item) => `${fx(num(item.pos_x))},${fy(num(item.pos_y))}`).join(' ');
  const abnormalCount = Array.from(freshReadings.values()).filter((reading) => num(reading.temp_c) > TEMP_LIMIT || num(reading.rh) > RH_LIMIT).length;
  const selectedPoint = mappedPoints.find((point) => point.id === selectedPointId) || null;
  const selectedReading = selectedPoint ? freshReadings.get(selectedPoint.id) : null;
  const dimensionLabel = bounds.configured
    ? `${formatMetric(area.width)}m × ${formatMetric(area.height)}m`
    : '按已标定点位推导';
  const isStale = latestTimestamp > 0 && Date.now() - latestTimestamp > FRESH_WINDOW_MS;

  const getBay = (point) => {
    const x = num(point.x) || 0;
    const y = num(point.y) || 0;
    const north = y >= rowMiddle;
    return {
      x: fx(x) - BAY_W / 2,
      y: north ? fy(y + BAY_OFFSET + BAY_D) : fy(y - BAY_OFFSET),
      labelY: fy(north ? y + BAY_OFFSET + BAY_D / 2 : y - BAY_OFFSET - BAY_D / 2)
    };
  };

  const activatePoint = (pointId) => setSelectedPointId((current) => (current === pointId ? null : pointId));

  return (
    <section className="card inspection-map-card" aria-label="仓间巡检地图">
      <header className="inspection-map-header">
        <div className="inspection-map-title-group">
          <span className="inspection-map-eyebrow">室内定位巡检</span>
          <div className="card-title">{area.name} 巡检地图</div>
          <div className="card-subtitle">{dimensionLabel} · 轨迹、设备位置与点位读数叠加在同一 CAD 平面</div>
        </div>

        <div className="inspection-map-controls" role="group" aria-label="巡检图层">
          <button type="button" className={showTrail ? 'active' : ''} aria-pressed={showTrail} onClick={() => setShowTrail((value) => !value)}>实际轨迹</button>
          <button type="button" className={showReadings ? 'active' : ''} aria-pressed={showReadings} onClick={() => setShowReadings((value) => !value)}>点位读数</button>
        </div>

        <div className="inspection-map-header-right">
          <span className={`inspection-map-live-status ${streamOnline && !isStale ? '' : 'stale'}`}>
            <i /> {streamOnline ? '实时通道已连接' : latestTimestamp ? `最后更新 ${formatAge(new Date(latestTimestamp).toISOString())}` : '等待巡检数据'}
          </span>
          <span className="inspection-map-status-note">越界位置与未标定读数不显示</span>
        </div>
      </header>

      {error && <div className="inspection-map-error">{error}</div>}

      <div className="inspection-map-stat-strip">
        <span>在线设备 <strong>{visibleDevices.length}</strong></span>
        <span>有效轨迹 <strong>{visibleTrail.length}</strong></span>
        <span>已匹配点位 <strong>{freshReadings.size} / {mappedPoints.length}</strong></span>
        <span className={abnormalCount ? 'inspection-map-bad' : ''}>阈值异常 <strong>{abnormalCount}</strong></span>
        <span className="inspection-map-source-note">坐标范围 {dimensionLabel}</span>
      </div>

      <div className="inspection-map-canvas">
        <div className="inspection-map-floor">
          <svg viewBox={`0 0 ${viewWidth} ${viewHeight}`} preserveAspectRatio="xMidYMid meet">
            <defs>
              <filter id="robotGlow" x="-100%" y="-100%" width="300%" height="300%">
                <feGaussianBlur stdDeviation="0.12" result="blur" />
                <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>

            <rect x={MAP_PADDING} y={MAP_PADDING} width={width} height={height} rx={0.08} fill="#061326" stroke="#80d5ff" strokeOpacity="0.7" strokeWidth={0.06} />
            {Array.from({ length: Math.floor(width / gridStep) + 1 }, (_, index) => (
              <line key={`grid-x-${index}`} x1={MAP_PADDING + index * gridStep} x2={MAP_PADDING + index * gridStep} y1={MAP_PADDING} y2={MAP_PADDING + height} stroke="#65c8ff" strokeOpacity="0.11" strokeWidth={0.025} />
            ))}
            {Array.from({ length: Math.floor(height / gridStep) + 1 }, (_, index) => (
              <line key={`grid-y-${index}`} x1={MAP_PADDING} x2={MAP_PADDING + width} y1={MAP_PADDING + index * gridStep} y2={MAP_PADDING + index * gridStep} stroke="#65c8ff" strokeOpacity="0.11" strokeWidth={0.025} />
            ))}

            <rect x={fx(aisleStart)} y={fy(northRowY + BAY_OFFSET)} width={Math.max(1, aisleEnd - aisleStart)} height={Math.max(0.9, northRowY - southRowY - BAY_OFFSET * 2)} fill="#0d3158" fillOpacity="0.8" stroke="#65c8ff" strokeOpacity="0.27" strokeWidth={0.035} />
            <text x={fx((aisleStart + aisleEnd) / 2)} y={fy(rowMiddle) + 0.15} textAnchor="middle" fontSize={0.34} fill="#91d8ff" fillOpacity="0.62" letterSpacing="0.12em">中央巡检通道</text>

            {mappedPoints.map((point) => {
              const bay = getBay(point);
              const reading = freshReadings.get(point.id);
              const abnormal = reading && (num(reading.temp_c) > TEMP_LIMIT || num(reading.rh) > RH_LIMIT);
              return (
                <g key={`bay-${point.id}`}>
                  <rect x={bay.x} y={bay.y} width={BAY_W} height={BAY_D} rx={0.045} fill={abnormal ? '#57283b' : '#263f61'} fillOpacity="0.88" stroke={abnormal ? '#ff7382' : '#d9bd93'} strokeOpacity={abnormal ? 0.95 : 0.76} strokeWidth={abnormal ? 0.08 : 0.045} />
                  {Array.from({ length: 9 }, (_, index) => (
                    <line key={`shelf-${point.id}-${index}`} x1={bay.x + 0.06} x2={bay.x + BAY_W - 0.06} y1={bay.y + (BAY_D * (index + 1)) / 10} y2={bay.y + (BAY_D * (index + 1)) / 10} stroke="#f1d5a8" strokeOpacity="0.25" strokeWidth={0.022} />
                  ))}
                  <text x={fx(num(point.x))} y={bay.labelY + 0.17} textAnchor="middle" fontSize={0.38} fontWeight="700" fill="#f7e3be">{point.name || point.id}</text>
                  <text x={fx(num(point.x))} y={bay.labelY + 0.53} textAnchor="middle" fontSize={0.19} fill="#c5dcf3" fillOpacity="0.68">{point.id}</text>
                </g>
              );
            })}

            {[0.5, 3.6, 6.8, 10, 13.2, 16.4, width - 0.5].filter((x) => x >= 0 && x <= width).map((x, index) => (
              <g key={`column-${index}`}>
                <rect x={fx(x) - 0.18} y={MAP_PADDING + 0.1} width={0.36} height={0.32} fill="#172533" stroke="#8aa4ba" strokeOpacity="0.45" strokeWidth={0.03} />
                <rect x={fx(x) - 0.18} y={MAP_PADDING + height - 0.42} width={0.36} height={0.32} fill="#172533" stroke="#8aa4ba" strokeOpacity="0.45" strokeWidth={0.03} />
              </g>
            ))}
            <g transform={`translate(${fx(Math.min(width - 0.75, aisleEnd + 0.12))} ${fy(rowMiddle) - 0.43})`}>
              <path d="M0 0.9 V0.18 H0.58 V0.9" fill="none" stroke="#80d5ff" strokeWidth="0.06" />
              <text x="0.29" y="1.17" textAnchor="middle" fontSize="0.24" fill="#8fd9ff">入口</text>
            </g>
            <g transform={`translate(${fx(Math.max(0.7, width * 0.32))} ${MAP_PADDING + 0.45})`}>
              <rect width="0.48" height="0.28" rx="0.03" fill="#b62334" />
              <text x="0.24" y="0.21" textAnchor="middle" fontSize="0.15" fontWeight="700" fill="#fff">消</text>
            </g>
            <g transform={`translate(${fx(Math.min(width - 1.1, width * 0.72))} ${MAP_PADDING + height - 0.75})`}>
              <rect width="0.48" height="0.28" rx="0.03" fill="#b62334" />
              <text x="0.24" y="0.21" textAnchor="middle" fontSize="0.15" fontWeight="700" fill="#fff">消</text>
            </g>

            {showTrail && trailPath && <polyline points={trailPath} fill="none" stroke="#50d4b1" strokeOpacity="0.82" strokeWidth="0.09" strokeLinecap="round" strokeLinejoin="round" />}
            {showTrail && visibleTrail.map((item, index) => index % 3 === 0 && <circle key={`trail-${index}`} cx={fx(num(item.pos_x))} cy={fy(num(item.pos_y))} r="0.055" fill="#b7fff0" />)}

            {mappedPoints.map((point) => {
              const reading = freshReadings.get(point.id);
              const abnormal = reading && (num(reading.temp_c) > TEMP_LIMIT || num(reading.rh) > RH_LIMIT);
              const selected = point.id === selectedPointId;
              return (
                <g key={`point-${point.id}`} className="inspection-map-point" role="button" tabIndex="0" aria-label={`${point.id} ${point.name || ''} ${reading ? `${reading.temp_c}摄氏度 ${reading.rh}%湿度` : '暂无新鲜读数'}`} onClick={() => activatePoint(point.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activatePoint(point.id); } }}>
                  {selected && <circle cx={fx(num(point.x))} cy={fy(num(point.y))} r="0.38" fill="none" stroke="#f5d777" strokeWidth="0.045" />}
                  <circle cx={fx(num(point.x))} cy={fy(num(point.y))} r="0.17" fill={abnormal ? '#ff7382' : '#2f7dff'} stroke="#e9f7ff" strokeWidth="0.04" />
                  {showReadings && reading && <text x={fx(num(point.x))} y={fy(num(point.y)) - 0.3} textAnchor="middle" fontSize="0.25" fontWeight="700" fill={abnormal ? '#ff9aa4' : '#91f2d0'}>{Number(reading.temp_c).toFixed(1)}° / {Number(reading.rh).toFixed(0)}%</text>}
                </g>
              );
            })}

            {visibleDevices.map((device) => {
              const x = num(device.pos_x);
              const y = num(device.pos_y);
              const heading = num(device.yaw) || 0;
              return (
                <g key={`device-${device.device_id}`} filter="url(#robotGlow)">
                  <circle cx={fx(x)} cy={fy(y)} r="0.42" fill="#50d4b1" fillOpacity="0.14">
                    <animate attributeName="r" values="0.28;0.48;0.28" dur="2s" repeatCount="indefinite" />
                    <animate attributeName="opacity" values="0.95;0.25;0.95" dur="2s" repeatCount="indefinite" />
                  </circle>
                  <circle cx={fx(x)} cy={fy(y)} r="0.19" fill="#50d4b1" stroke="#f3fffd" strokeWidth="0.04" />
                  <line x1={fx(x)} y1={fy(y)} x2={fx(x) + Math.cos(heading) * 0.42} y2={fy(y) - Math.sin(heading) * 0.42} stroke="#e7fffa" strokeWidth="0.06" strokeLinecap="round" />
                  <text x={fx(x)} y={fy(y) - 0.48} textAnchor="middle" fontSize="0.25" fontWeight="700" fill="#a8ffe6">{device.device_id}</text>
                </g>
              );
            })}
          </svg>
        </div>

        <div className="inspection-map-legend" aria-label="地图图例">
          <span><i className="legend-path" /> 实际轨迹</span>
          <span><i className="legend-device" /> 巡检设备</span>
          <span><i className="legend-point" /> 正常点位</span>
          <span><i className="legend-alert" /> 阈值异常</span>
        </div>

        <div className="inspection-map-detail">
          {selectedPoint ? (
            <>
              <span>已选点位</span>
              <strong>{selectedPoint.id} · {selectedPoint.name}</strong>
              {selectedReading ? <b>{Number(selectedReading.temp_c).toFixed(1)}℃ <em>/</em> {Number(selectedReading.rh).toFixed(0)}%RH</b> : <small>当前没有该点位的新鲜读数</small>}
              {selectedReading && <small>由 {selectedReading.device_id || '巡检设备'} 在 {formatAge(selectedReading.ts)} 采集</small>}
              <button type="button" onClick={() => setSelectedPointId(null)}>取消选择</button>
            </>
          ) : (
            <><span>点位详情</span><strong>选择平面图中的已标定点位</strong><small>显示该库位的最新温湿度读数与采集时间。</small></>
          )}
        </div>
      </div>

      <footer className="inspection-map-footer">实时轨迹只保留近 1 小时的仓间内位置；现场 CAD 图层可按最终测绘坐标继续校准。</footer>
    </section>
  );
};

export default SlamMapTab;
