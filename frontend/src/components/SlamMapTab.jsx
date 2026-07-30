/**
 * 仓间巡检地图。
 *
 * 平面图只投射当前仓间边界内的已配置点位、轨迹和设备位置。越界或无法定位的
 * 原始上报不会扩张画布，也不会被推测到某个库位，确保巡检视图与实际仓间保持一致。
 *
 * 缩放平移由 useSvgZoom 提供（受控 viewBox）。拖拽结束时浏览器补发的 click 在
 * onClick 处被吞掉，避免拖完地图顺手选中一个点位；键盘 Enter/Space 走 onKeyDown
 * 不经过这层判断，否则拖过一次之后键盘就再也选不中点位了。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createSlamStream, getSlamLive, getSlamPoints, getSlamReadings } from '../api.js';
import { buildTrailSegments, computeMapGridStep, formatMetric, takeLatestBatch } from '../lib/inspection.js';
import { useSvgZoom } from '../lib/useSvgZoom.js';
import CadDoor from './CadDoor.jsx';
import MapZoomControls from './MapZoomControls.jsx';

const POLL_MS = 5000;
const TRAIL_WINDOW_MS = 60 * 60 * 1000;
const TRAIL_LIMIT = 2000;
// 与后端 inspection-batches 的批次判据一致：采集间隔超过 30 分钟即算新一轮巡检。
const BATCH_GAP_MINUTES = 30;
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
  // 设备可能停机数天，只给小时数会出现「已停更 128h」这种要心算的文案。
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h 前`;
  return `${Math.floor(seconds / 86400)}天前`;
};

/** 绝对时间文案：陈旧徽标要给出「数据截至什么时候」，光有相对时长不够定位。 */
const formatStamp = (timestamp) => {
  const time = timeMs(timestamp);
  if (!time) return '--';
  return new Date(time).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
};

/**
 * 轨迹裁剪：时间窗兜底 + 收口到最近一次巡检。
 *
 * 时间窗锚在最后一条数据上，不是 Date.now()——与后端 pruneSlamTrail 同一套判据。
 * 锚在墙上时钟时，机器人停机满 1 小时轨迹就被裁空，地图凭空变白；
 * 锚在数据上，巡检中表现不变，停机后保留最后一轮，由 header 徽标说明停更时长。
 */
const pruneTrail = (items = []) => {
  const lastMs = items.length ? timeMs(items[items.length - 1].ts) : 0;
  const cutoff = lastMs > 0 ? lastMs - TRAIL_WINDOW_MS : 0;
  const recent = items.filter((item) => timeMs(item.ts) >= cutoff).slice(-TRAIL_LIMIT);
  return takeLatestBatch(recent, { gapMinutes: BATCH_GAP_MINUTES });
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
  const floorRef = useRef(null);

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

  // 小屏地图采用横向浏览。A-4-1 从东门进仓，首次加载时直接定位到东侧入口，
  // 避免用户先看到西墙、误以为入口未绘制。
  useEffect(() => {
    const floor = floorRef.current;
    if (!floor || area?.door?.wall !== 'east' || !window.matchMedia('(max-width: 720px)').matches) return;
    const frame = window.requestAnimationFrame(() => {
      floor.scrollLeft = floor.scrollWidth;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [area]);

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

  // 断档/位姿跳变/出界处断开，polyline 只连真实走过的段，杜绝跨洞假直线。
  const trailSegments = useMemo(() => (
    bounds ? buildTrailSegments(trail, { bounds }) : []
  ), [bounds, trail]);

  const trailPointCount = useMemo(() => (
    trailSegments.reduce((total, segment) => total + segment.length, 0)
  ), [trailSegments]);

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

  // 直接展示各点位的最新读数，不再按「距今 30 分钟」过滤。
  // 过滤掉的后果是：设备一停机，点位读数、异常计数、详情面板同时清零，
  // 而热力图那边（/slam/readings 取 MAX(ts)，无时间窗）读数还在——同一份数据
  // 两个页面结论相反。新鲜度改由 isStale 徽标统一表达，数据本身始终保留。
  const displayReadings = latestReadings;

  const latestTimestamp = useMemo(() => {
    const readingTimes = Array.from(latestReadings.values()).map((reading) => timeMs(reading.ts));
    // 只有轨迹没有读数的场景（例如遥控走位标定）也要能算出数据时点
    const trailTimes = trail.map((item) => timeMs(item.ts));
    return Math.max(0, ...readingTimes, ...trailTimes);
  }, [latestReadings, trail]);

  // viewBox 基准尺寸必须在「加载中」早退分支之前算出来——Hook 不能条件调用。
  const viewBoxSize = useMemo(() => {
    if (!bounds) return { width: 1, height: 1 };
    return {
      width: bounds.maxX - bounds.minX + MAP_PADDING * 2,
      height: bounds.maxY - bounds.minY + MAP_PADDING * 2
    };
  }, [bounds]);

  const zoom = useSvgZoom({ baseWidth: viewBoxSize.width, baseHeight: viewBoxSize.height });

  if (error && !area) return <div className="page-error">{error}</div>;
  // 加载中用同款深色卡片占位，避免白色占位框闪烁/跳动。
  if (!area || !bounds) {
    return (
      <section className="card inspection-map-card" aria-label="仓间巡检地图">
        <div className="map-card-loading">加载中…</div>
      </section>
    );
  }

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const fx = (x) => x - bounds.minX + MAP_PADDING;
  const fy = (y) => bounds.maxY - y + MAP_PADDING;
  const gridStep = computeMapGridStep(Math.max(width, height), 32);
  const pointXs = mappedPoints.map((point) => num(point.x)).filter((value) => value !== null);
  const pointYs = mappedPoints.map((point) => num(point.y)).filter((value) => value !== null);
  const southRowY = pointYs.length ? Math.min(...pointYs) : height * 0.42;
  const northRowY = pointYs.length ? Math.max(...pointYs) : height * 0.58;
  // 中央走道优先用配置的真实 4m 带(area.aisle)；缺失时退回按采集车道推导。
  const aisleBand = area.aisle || { y0: southRowY - BAY_OFFSET, y1: northRowY + BAY_OFFSET };
  const rowMiddle = (aisleBand.y0 + aisleBand.y1) / 2;
  // 走道沿垛体 x 范围铺满：有 bay 几何时取垛体外缘，否则按点位反推。
  const bayRects = mappedPoints.map((point) => point.bay).filter(Boolean);
  const aisleStart = bayRects.length
    ? Math.min(...bayRects.map((b) => b.x0))
    : pointXs.length ? Math.min(...pointXs) - 0.8 : 0.7;
  const aisleEnd = bayRects.length
    ? Math.max(...bayRects.map((b) => b.x1))
    : pointXs.length ? Math.max(...pointXs) + 0.8 : width - 0.7;
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
  const abnormalCount = Array.from(displayReadings.values()).filter((reading) => num(reading.temp_c) > TEMP_LIMIT || num(reading.rh) > RH_LIMIT).length;
  const selectedPoint = mappedPoints.find((point) => point.id === selectedPointId) || null;
  const selectedReading = selectedPoint ? displayReadings.get(selectedPoint.id) : null;
  const dimensionLabel = bounds.configured
    ? `${formatMetric(area.width)}m × ${formatMetric(area.height)}m`
    : '按已标定点位推导';
  const isStale = latestTimestamp > 0 && Date.now() - latestTimestamp > FRESH_WINDOW_MS;
  const latestIso = latestTimestamp ? new Date(latestTimestamp).toISOString() : null;
  const hasData = latestTimestamp > 0;

  // 垛体矩形优先用配置的真实几何(point.bay，米制 CAD 坐标)；缺失时按固定尺寸从点位反推。
  const getBay = (point) => {
    const rect = point.bay;
    if (rect) {
      return {
        x: fx(rect.x0),
        y: fy(rect.y1),
        w: rect.x1 - rect.x0,
        h: rect.y1 - rect.y0,
        labelY: fy((rect.y0 + rect.y1) / 2)
      };
    }
    const x = num(point.x) || 0;
    const y = num(point.y) || 0;
    const north = y >= rowMiddle;
    return {
      x: fx(x) - BAY_W / 2,
      y: north ? fy(y + BAY_OFFSET + BAY_D) : fy(y - BAY_OFFSET),
      w: BAY_W,
      h: BAY_D,
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
          {/* SSE 连着不等于有数据在流。停更时优先报"最后更新"，
              否则"实时通道已连接"会给出一切正常的错觉。 */}
          <span className={`inspection-map-live-status ${streamOnline && !isStale ? '' : 'stale'}`}>
            <i /> {!hasData ? '等待巡检数据' : isStale ? `最后更新 ${formatAge(latestIso)}` : streamOnline ? '实时通道已连接' : `最后更新 ${formatAge(latestIso)}`}
          </span>
          <span className="inspection-map-status-note">越界位置与未标定读数不显示</span>
        </div>
      </header>

      {error && <div className="inspection-map-error">{error}</div>}

      {/* 停更时展示的是最后一轮巡检的历史快照。必须显式说明数据时点，
          否则一张静止的轨迹图和实时图长得一模一样，会被当成"正在巡检"。 */}
      {isStale && (
        <div className="inspection-map-stale-banner" role="status">
          <strong>历史快照</strong>
          <span>数据截至 {formatStamp(latestIso)} · 已停更 {formatAge(latestIso)} · 非实时</span>
        </div>
      )}

      <div className={`inspection-map-stat-strip${isStale ? ' is-stale' : ''}`}>
        <span>{isStale ? '最后一轮设备' : '在线设备'} <strong>{visibleDevices.length}</strong></span>
        <span>有效轨迹 <strong>{trailPointCount}</strong></span>
        <span>已匹配点位 <strong>{displayReadings.size} / {mappedPoints.length}</strong></span>
        <span className={abnormalCount ? 'inspection-map-bad' : ''}>阈值异常 <strong>{abnormalCount}</strong></span>
        <span className="inspection-map-source-note">坐标范围 {dimensionLabel}</span>
      </div>

      <div className="inspection-map-canvas inspection-map-canvas--slam">
        <div className="inspection-map-mobile-hint">东门为巡检起点 · 左右滑动查看完整仓间</div>
        {/* map-zoom-frame：缩到 1× 以下时按比例收窄这一层，卡片跟着变矮 */}
        <div className="inspection-map-floor map-zoom-frame" ref={floorRef} style={zoom.frameStyle}>
          <svg {...zoom.svgProps} viewBox={zoom.viewBox} preserveAspectRatio="xMidYMid meet">
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

            <rect x={fx(aisleStart)} y={fy(aisleBand.y1)} width={Math.max(1, aisleEnd - aisleStart)} height={Math.max(0.9, aisleBand.y1 - aisleBand.y0)} fill="#0d3158" fillOpacity="0.8" stroke="#65c8ff" strokeOpacity="0.27" strokeWidth={0.035} />
            <text x={fx((aisleStart + aisleEnd) / 2)} y={fy(rowMiddle) + 0.15} textAnchor="middle" fontSize={0.34} fill="#91d8ff" fillOpacity="0.62" letterSpacing="0.12em">中央巡检通道</text>

            {mappedPoints.filter((point) => point.kind !== 'aisle').map((point) => {
              const bay = getBay(point);
              const reading = displayReadings.get(point.id);
              const abnormal = reading && (num(reading.temp_c) > TEMP_LIMIT || num(reading.rh) > RH_LIMIT);
              const shelfCount = Math.max(4, Math.round(bay.h));
              return (
                <g key={`bay-${point.id}`}>
                  <rect x={bay.x} y={bay.y} width={bay.w} height={bay.h} rx={0.045} fill={abnormal ? '#57283b' : '#263f61'} fillOpacity="0.88" stroke={abnormal ? '#ff7382' : '#d9bd93'} strokeOpacity={abnormal ? 0.95 : 0.76} strokeWidth={abnormal ? 0.08 : 0.045} />
                  {Array.from({ length: shelfCount - 1 }, (_, index) => (
                    <line key={`shelf-${point.id}-${index}`} x1={bay.x + 0.06} x2={bay.x + bay.w - 0.06} y1={bay.y + (bay.h * (index + 1)) / shelfCount} y2={bay.y + (bay.h * (index + 1)) / shelfCount} stroke="#f1d5a8" strokeOpacity="0.25" strokeWidth={0.022} />
                  ))}
                  <text x={fx(num(point.x))} y={bay.labelY + 0.02} textAnchor="middle" fontSize={0.52} fontWeight="700" fill="#f7e3be">{point.name || point.id}</text>
                  <text x={fx(num(point.x))} y={bay.labelY + 0.42} textAnchor="middle" fontSize={0.26} fill="#c5dcf3" fillOpacity="0.68">{point.id}</text>
                </g>
              );
            })}

            {columnXs.filter((x) => x >= 0 && x <= width).map((x, index) => (
              <g key={`column-${index}`}>
                <rect x={fx(x) - 0.18} y={MAP_PADDING + 0.1} width={0.36} height={0.32} fill="#172533" stroke="#8aa4ba" strokeOpacity="0.45" strokeWidth={0.03} />
                <rect x={fx(x) - 0.18} y={MAP_PADDING + height - 0.42} width={0.36} height={0.32} fill="#172533" stroke="#8aa4ba" strokeOpacity="0.45" strokeWidth={0.03} />
              </g>
            ))}
            {area.door && (
              <CadDoor door={area.door} fx={fx} fy={fy} />
            )}
            <g transform={`translate(${MAP_PADDING + width - 1.15} ${MAP_PADDING + 1.25})`} aria-label="北向标识">
              <path d="M 0 0.62 L 0 -0.46 M 0 -0.46 l -0.2 0.32 M 0 -0.46 l 0.2 0.32" fill="none" stroke="#9fe6ff" strokeWidth="0.07" strokeLinecap="round" />
              <text x="0" y="-0.66" textAnchor="middle" fontSize="0.3" fontWeight="700" fill="#c8f1ff">N</text>
            </g>
            <g transform={`translate(${fx(Math.max(0.7, width * 0.32))} ${MAP_PADDING + 0.45})`}>
              <rect width="0.48" height="0.28" rx="0.03" fill="#b62334" />
              <text x="0.24" y="0.21" textAnchor="middle" fontSize="0.15" fontWeight="700" fill="#fff">消</text>
            </g>
            <g transform={`translate(${fx(Math.min(width - 1.1, width * 0.72))} ${MAP_PADDING + height - 0.75})`}>
              <rect width="0.48" height="0.28" rx="0.03" fill="#b62334" />
              <text x="0.24" y="0.21" textAnchor="middle" fontSize="0.15" fontWeight="700" fill="#fff">消</text>
            </g>

            {showTrail && trailSegments.map((segment, segIndex) => {
              if (segment.length === 1) {
                const only = segment[0];
                return <circle key={`trail-seg-${segIndex}`} cx={fx(num(only.pos_x))} cy={fy(num(only.pos_y))} r="0.09" fill="#50d4b1" fillOpacity="0.85" />;
              }
              const path = segment.map((item) => `${fx(num(item.pos_x))},${fy(num(item.pos_y))}`).join(' ');
              return <polyline key={`trail-seg-${segIndex}`} points={path} fill="none" stroke="#50d4b1" strokeOpacity="0.82" strokeWidth="0.09" strokeLinecap="round" strokeLinejoin="round" />;
            })}
            {showTrail && trailSegments.flat().map((item, index) => (index % 3 === 0 ? <circle key={`trail-dot-${index}`} cx={fx(num(item.pos_x))} cy={fy(num(item.pos_y))} r="0.055" fill="#b7fff0" /> : null))}

            {mappedPoints.map((point) => {
              const reading = displayReadings.get(point.id);
              const abnormal = reading && (num(reading.temp_c) > TEMP_LIMIT || num(reading.rh) > RH_LIMIT);
              const selected = point.id === selectedPointId;
              return (
                <g key={`point-${point.id}`} className="inspection-map-point" role="button" tabIndex="0" aria-label={`${point.id} ${point.name || ''} ${reading ? `${reading.temp_c}摄氏度 ${reading.rh}%湿度` : '暂无新鲜读数'}`} onClick={() => { if (!zoom.shouldIgnoreClick()) activatePoint(point.id); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activatePoint(point.id); } }}>
                  {selected && <circle cx={fx(num(point.x))} cy={fy(num(point.y))} r="0.38" fill="none" stroke="#f5d777" strokeWidth="0.045" />}
                  <circle cx={fx(num(point.x))} cy={fy(num(point.y))} r={point.kind === 'aisle' ? '0.1' : '0.17'} fill={abnormal ? '#ff7382' : point.kind === 'aisle' ? '#8fb8ff' : '#2f7dff'} stroke="#e9f7ff" strokeWidth="0.04" />
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

        {/* 锚在画布层（尺寸不随缩放变化），按钮位置全程固定 */}
        <MapZoomControls zoom={zoom} className="map-zoom-controls--inset" />

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
              {selectedReading ? <b>{Number(selectedReading.temp_c).toFixed(1)}℃ <em>/</em> {Number(selectedReading.rh).toFixed(0)}%RH</b> : <small>该点位尚无采集读数</small>}
              {selectedReading && <small>由 {selectedReading.device_id || '巡检设备'} 在 {formatAge(selectedReading.ts)} 采集</small>}
              <button type="button" onClick={() => setSelectedPointId(null)}>取消选择</button>
            </>
          ) : (
            <><span>点位详情</span><strong>选择平面图中的已标定点位</strong><small>显示该库位的最新温湿度读数与采集时间。</small></>
          )}
        </div>
      </div>

      <footer className="inspection-map-footer">A-4-1 CAD 基准：东门进出、南排东→西、西端换道、北排西→东；轨迹只显示最近一次巡检（间隔超过 30 分钟即算新一轮），且仅限仓间内位置。设备停机时保留最后一轮，顶部标注数据时点。</footer>
    </section>
  );
};

export default SlamMapTab;
