import React, { useEffect, useMemo, useState } from 'react';
import TrendChart from '../components/TrendChart.jsx';
import { getZones, getTrend, getSensors } from '../api.js';

const ranges = [
  { label: '1 小时', hours: 1 },
  { label: '24 小时', hours: 24 },
  { label: '7 天', hours: 24 * 7 }
];

const ZoneDetail = () => {
  const [zones, setZones] = useState([]);
  const [sensors, setSensors] = useState([]);
  const [selectedZone, setSelectedZone] = useState('');
  const [range, setRange] = useState(ranges[1]);
  const [trend, setTrend] = useState([]);

  useEffect(() => {
    const load = async () => {
      const zoneData = await getZones();
      setZones(zoneData);
      if (zoneData.length) {
        setSelectedZone(zoneData[0].zone_id);
      }
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
        granularity: range.hours > 24 * 3 ? 'hourly' : 'raw'
      });
      const toNumber = (value) => {
        if (value === null || value === undefined || value === '') return null;
        const num = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(num) ? num : null;
      };
      const series = (trendData.series || []).map((item) => ({
        ts: item.ts,
        temp_c: toNumber(item.temp_c ?? item.temp_avg),
        rh: toNumber(item.rh ?? item.rh_avg)
      }));
      setTrend(series);
    };
    load();
  }, [selectedZone, range]);

  const selectedZoneMeta = useMemo(
    () => zones.find((zone) => zone.zone_id === selectedZone),
    [zones, selectedZone]
  );

  return (
    <div className="page">
      <div className="filter-bar">
        <div className="filter-group">
          <span className="filter-label">区域</span>
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
        </div>
        <div className="filter-group">
          <span className="filter-label">时间范围</span>
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
      </div>

      <div className="panel-grid">
        <TrendChart
          title="库区温湿度曲线"
          subtitle={selectedZoneMeta ? selectedZoneMeta.description : '趋势详情'}
          data={trend}
        />

        <div className="card sensor-card">
          <div className="card-header">
            <div>
              <div className="card-title">巡检终端点位</div>
              <div className="card-subtitle">{sensors.length} 个点位在线</div>
            </div>
            <button className="ghost-button">导出监测记录</button>
          </div>
          <div className="sensor-list">
            {sensors.map((sensor) => (
              <div key={sensor.sensor_id} className="sensor-item">
                <div>
                  <div className="sensor-title">{sensor.sensor_id}</div>
                  <div className="sensor-sub">{sensor.type}</div>
                </div>
                <span className="status-pill">稳定</span>
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
