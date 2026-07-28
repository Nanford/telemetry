import React, { useCallback, useEffect, useMemo, useState } from 'react';
import TrendChart from '../components/TrendChart.jsx';
import WarehouseHeatmap from '../components/WarehouseHeatmap.jsx';
import { getZones, getTrend, getSensors, getSlamPoints } from '../api.js';

const ranges = [
  { label: '12 小时', hours: 12 },
  { label: '24 小时', hours: 24 },
  { label: '7 天', hours: 24 * 7 }
];

const ZoneDetail = () => {
  const [zones, setZones] = useState([]);
  const [sensors, setSensors] = useState([]);
  const [selectedZone, setSelectedZone] = useState('');
  const [range, setRange] = useState(ranges[1]);
  const [trend, setTrend] = useState([]);
  // 当前时间窗为空时，这个库区最近一条数据的时间（null = 还没查/近 30 天一条都没有）
  const [lastSampleAt, setLastSampleAt] = useState(null);
  // 曲线画的是不是"回落到最后一批数据"的历史快照（null = 画的是当前时间窗）
  const [snapshotEndAt, setSnapshotEndAt] = useState(null);

  useEffect(() => {
    const load = async () => {
      // 默认库区必须跟随后端的「当前巡检区域」(config.slam.area)，不能取列表首项：
      // /zones 是按 zone_id 字典序返回的，首项永远是已停用的 A-1-2，而活跃区是 A-4-1。
      // 走接口而非硬编码，后端换仓间时前端自动跟随。
      const [zoneData, slamConfig] = await Promise.all([getZones(), getSlamPoints()]);
      setZones(zoneData);
      if (!zoneData.length) return;

      const activeAreaId = slamConfig?.area?.area_id;
      const hasActiveArea = activeAreaId && zoneData.some((zone) => zone.zone_id === activeAreaId);
      setSelectedZone(hasActiveArea ? activeAreaId : zoneData[0].zone_id);
    };
    load();
  }, []);

  useEffect(() => {
    if (!selectedZone) return;
    const load = async () => {
      const sensorData = await getSensors();
      setSensors(sensorData.filter((sensor) => sensor.zone_id === selectedZone));
      const end = new Date();
      const start = new Date(end.getTime() - range.hours * 3600 * 1000);
      const trendData = await getTrend({
        zone_id: selectedZone,
        start: start.toISOString(),
        end: end.toISOString(),
        bucket_minutes: 5
      });
      const toNumber = (value) => {
        if (value === null || value === undefined || value === '') return null;
        const num = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(num) ? num : null;
      };
      const toSeries = (raw) => (raw || []).map((item) => ({
        ts: item.ts,
        temp_c: toNumber(item.temp_c ?? item.temp_avg),
        rh: toNumber(item.rh ?? item.rh_avg)
      }));

      const series = toSeries(trendData.series);
      if (series.length) {
        setTrend(series);
        setLastSampleAt(null);
        setSnapshotEndAt(null);
        return;
      }

      // 当前窗口为空 = 采集停了，不是没有数据。先回查近 30 天定位最后一条的时间，
      // 再以那个时间为终点重取同样长度的窗口，把最后一段真实曲线画出来。
      // 早先只做到"探针"这一步，拿到时间只用于写一句提示，图仍然是空的——
      // 停机期间整页看起来像坏了。
      const probeStart = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
      const probe = await getTrend({
        zone_id: selectedZone,
        start: probeStart.toISOString(),
        end: end.toISOString(),
        bucket_minutes: 60
      });
      const probeSeries = probe.series || [];
      const lastTs = probeSeries.length ? probeSeries[probeSeries.length - 1].ts : null;
      setLastSampleAt(lastTs);

      if (!lastTs) {
        setTrend([]);
        setSnapshotEndAt(null);
        return;
      }

      // 探针是 60 分钟桶，末桶起点早于真实末条数据，向后放宽一个桶避免截断尾部
      const snapshotEnd = new Date(new Date(lastTs).getTime() + 3600 * 1000);
      const snapshotStart = new Date(snapshotEnd.getTime() - range.hours * 3600 * 1000);
      const snapshot = await getTrend({
        zone_id: selectedZone,
        start: snapshotStart.toISOString(),
        end: snapshotEnd.toISOString(),
        bucket_minutes: 5
      });
      const snapshotSeries = toSeries(snapshot.series);
      setTrend(snapshotSeries);
      setSnapshotEndAt(snapshotSeries.length ? lastTs : null);
    };
    load();
  }, [selectedZone, range]);

  const selectedZoneMeta = useMemo(
    () => zones.find((zone) => zone.zone_id === selectedZone),
    [zones, selectedZone]
  );

  /** 空图上的说明文字。走到这里意味着连历史快照都取不到，即库区完全没数据。 */
  const emptyHint = useMemo(() => {
    if (!lastSampleAt) return `近 30 天内 ${selectedZone || '该库区'} 没有任何采集数据`;
    const last = new Date(lastSampleAt);
    return `最近一条数据在 ${last.toLocaleString('zh-CN')}，但该时段聚合结果为空`;
  }, [lastSampleAt, selectedZone]);

  /** 历史快照横幅文案：说清数据截至何时、停更多久，避免旧曲线被当成实时。 */
  const staleNote = useMemo(() => {
    if (!snapshotEndAt) return '';
    const last = new Date(snapshotEndAt);
    const hoursAgo = Math.round((Date.now() - last.getTime()) / 3600000);
    const ago = hoursAgo >= 48 ? `${Math.round(hoursAgo / 24)} 天` : `${hoursAgo} 小时`;
    return `近 ${range.label}内无新数据 · 下方为最后一段实测曲线，数据截至 ${last.toLocaleString('zh-CN')}（已停更约 ${ago}）`;
  }, [snapshotEndAt, range]);

  /**
   * 导出当前库区、当前时间窗的趋势序列为 CSV。
   * 加 UTF-8 BOM，否则 Excel 打开中文表头会乱码。
   */
  const handleExportTrend = useCallback(() => {
    if (!trend.length) return;
    const rows = [
      '采集时间,温度(℃),湿度(%)',
      ...trend.map((point) => [
        new Date(point.ts).toLocaleString('zh-CN'),
        point.temp_c ?? '',
        point.rh ?? ''
      ].join(','))
    ];
    const blob = new Blob([`﻿${rows.join('\n')}`], {
      type: 'text/csv;charset=utf-8;'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    // 导出的是历史快照时，把截止日期写进文件名，避免下载后分不清是哪一段
    const suffix = snapshotEndAt
      ? `快照截至${new Date(snapshotEndAt).toISOString().slice(0, 10)}`
      : '趋势';
    link.download = `${selectedZone || 'zone'}_${range.hours}h_${suffix}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [trend, selectedZone, range, snapshotEndAt]);

  return (
    <div className="page">
      <WarehouseHeatmap />

      <div className="panel-grid">
        <TrendChart
          title="库区温湿度曲线"
          subtitle={
            trend.length
              ? `${selectedZoneMeta?.description || '趋势详情'} · 5 分钟聚合 · ${trend.length} 个数据点${snapshotEndAt ? ' · 历史快照' : ''}`
              : `${selectedZoneMeta?.description || '趋势详情'} · 5 分钟聚合`
          }
          data={trend}
          emptyHint={emptyHint}
          staleNote={staleNote}
          actions={(
            <div className="chart-controls">
              <select
                className="select"
                value={selectedZone}
                onChange={(event) => setSelectedZone(event.target.value)}
              >
                {zones.map((zone) => (
                  <option key={zone.zone_id} value={zone.zone_id}>
                    {zone.name}
                  </option>
                ))}
              </select>
              <div className="chip-row">
                {ranges.map((item) => (
                  <button
                    key={item.label}
                    className={`chip ${item.label === range.label ? 'active' : ''}`}
                    onClick={() => setRange(item)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        />

        <div className="card sensor-card">
          <div className="card-header">
            <div>
              <div className="card-title">巡检终端点位</div>
              <div className="card-subtitle">{sensors.length} 个已登记采集点位</div>
            </div>
            <button
              className="ghost-button"
              onClick={handleExportTrend}
              disabled={!trend.length}
            >
              导出趋势 CSV
            </button>
          </div>
          <div className="sensor-list">
            {/* 点位状态需要 last_seen_at，当前 /sensors 接口未返回，
                故不展示状态标签——宁可留空也不显示编造的「稳定」。 */}
            {sensors.map((sensor) => (
              <div key={sensor.sensor_id} className="sensor-item">
                <div>
                  <div className="sensor-title">{sensor.sensor_id}</div>
                  <div className="sensor-sub">{sensor.type}</div>
                </div>
                <span className="sensor-zone">{sensor.zone_id}</span>
              </div>
            ))}
            {!sensors.length && <div className="sensor-empty">暂无巡检点位</div>}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ZoneDetail;
