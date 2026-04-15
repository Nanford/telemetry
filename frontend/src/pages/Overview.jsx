import React, { useEffect, useState, useRef, useCallback } from 'react';
import StatCard from '../components/StatCard.jsx';
import ZoneCard from '../components/ZoneCard.jsx';
import TrendChart from '../components/TrendChart.jsx';
import { getOverview, getTrend, getInsights, getHealthSummary } from '../api.js';
import { mockTrend } from '../data/mock.js';

const POLL_INTERVAL = 30_000;

const toNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
};

const Overview = () => {
  const [overview, setOverview] = useState({ zones: [], summary: {} });
  const [trend, setTrend] = useState(mockTrend.series);
  const [insights, setInsights] = useState({ temp_alerts: null, rh_alerts: null, link_stability: null });
  const [health, setHealth] = useState({ mqtt_status: 'unknown', write_delay_sec: null, pending_alerts: null });
  const [loading, setLoading] = useState(true);
  const abortRef = useRef(null);

  const tempAvg = toNumber(overview.summary?.temp_avg);
  const tempMin = toNumber(overview.summary?.temp_min);
  const tempMax = toNumber(overview.summary?.temp_max);
  const rhAvg = toNumber(overview.summary?.rh_avg);
  const rhMin = toNumber(overview.summary?.rh_min);
  const rhMax = toNumber(overview.summary?.rh_max);
  const tempAlerts = toNumber(insights?.temp_alerts);
  const rhAlerts = toNumber(insights?.rh_alerts);
  const linkStability = toNumber(insights?.link_stability);
  const lagSeconds = toNumber(health?.write_delay_sec);
  const pendingAlerts = toNumber(health?.pending_alerts);
  const mqttStatus = health?.mqtt_status;
  const isMqttOk = mqttStatus === 'online';
  const isDelayOk = lagSeconds !== null && lagSeconds <= 300;
  const isPendingOk = pendingAlerts !== null && pendingAlerts === 0;

  const mqttLabel = mqttStatus === 'online' ? '在线' : mqttStatus === 'offline' ? '离线' : '--';
  const lagLabel =
    lagSeconds !== null ? `${lagSeconds < 10 ? lagSeconds.toFixed(1) : lagSeconds.toFixed(0)}s 延迟` : '--';
  const pendingLabel = pendingAlerts !== null ? `${pendingAlerts} 条待处理` : '--';

  const load = useCallback(async (signal) => {
    try {
      const opts = { signal };
      const [data, insightsData, healthData] = await Promise.all([
        getOverview(null, opts),
        getInsights(null, opts),
        getHealthSummary(null, opts)
      ]);
      setOverview(data);
      setInsights(insightsData);
      setHealth(healthData);
      if (data.zones?.length) {
        const trendData = await getTrend({ zone_id: data.zones[0].zone_id, granularity: 'raw' }, opts);
        const series = (trendData.series || []).map((item) => ({
          ts: item.ts,
          temp_c: toNumber(item.temp_c ?? item.temp_avg),
          rh: toNumber(item.rh ?? item.rh_avg)
        }));
        setTrend(series);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    load(ac.signal);

    const timer = setInterval(() => {
      if (!abortRef.current?.signal.aborted) {
        load(abortRef.current.signal);
      }
    }, POLL_INTERVAL);

    return () => {
      ac.abort();
      clearInterval(timer);
    };
  }, [load]);

  if (loading) {
    return <div className="page"><div className="loading-state">加载中...</div></div>;
  }

  return (
    <div className="page">
      <section className="stats-grid">
        <StatCard
          label="24h 库温均值"
          value={tempAvg !== null ? tempAvg.toFixed(1) : '--'}
          unit="°C"
          note={tempAvg !== null ? '最近 24 小时' : '最近 24 小时无有效采样'}
        />
        <StatCard
          label="库温区间"
          value={`${tempMin !== null ? tempMin.toFixed(1) : '--'} ~ ${tempMax !== null ? tempMax.toFixed(1) : '--'}`}
          unit="°C"
          note="最高 / 最低"
        />
        <StatCard
          label="24h 库湿均值"
          value={rhAvg !== null ? rhAvg.toFixed(1) : '--'}
          unit="%"
          note={rhAvg !== null ? '最近 24 小时' : '最近 24 小时无有效采样'}
        />
        <StatCard
          label="库湿区间"
          value={`${rhMin !== null ? rhMin.toFixed(1) : '--'} ~ ${rhMax !== null ? rhMax.toFixed(1) : '--'}`}
          unit="%"
          note="最高 / 最低"
        />
      </section>

      <section className="panel-grid">
        <div className="card zone-panel">
          <div className="card-header">
            <div>
              <div className="card-title">烟叶库区态势</div>
              <div className="card-subtitle">温湿度稳定性与阈值状态</div>
            </div>
            <span className="chip">{overview.zones.length} 个区域</span>
          </div>
          <div className="zone-grid">
            {overview.zones.map((zone) => (
              <ZoneCard key={zone.zone_id} zone={zone} />
            ))}
          </div>
        </div>

        <TrendChart
          title="全库温湿度趋势"
          subtitle="默认区域趋势作为基准曲线"
          data={trend}
        />
      </section>

      <section className="panel-grid two">
        <div className="card health-card">
          <div className="card-header">
            <div>
              <div className="card-title">巡检链路健康</div>
              <div className="card-subtitle">采集 · 传输 · 入库</div>
            </div>
          </div>
          <div className="health-list">
            <div className="health-item">
              <span className={`health-dot ${isMqttOk ? 'ok' : 'warn'}`} /> MQTT 接入
              <span className="health-value">{mqttLabel}</span>
            </div>
            <div className="health-item">
              <span className={`health-dot ${isDelayOk ? 'ok' : 'warn'}`} /> 数据写入
              <span className="health-value">{lagLabel}</span>
            </div>
            <div className="health-item">
              <span className={`health-dot ${isPendingOk ? 'ok' : 'warn'}`} /> 待确认告警
              <span className="health-value">{pendingLabel}</span>
            </div>
          </div>
        </div>

        <div className="card insights-card">
          <div className="card-header">
            <div>
              <div className="card-title">烟叶库区洞察</div>
              <div className="card-subtitle">过去 7 天环境波动</div>
            </div>
          </div>
          <div className="insight-grid">
            <div>
              <div className="insight-value value-alert">{tempAlerts !== null ? tempAlerts : '--'}</div>
              <div className="insight-label">温度异常</div>
            </div>
            <div>
              <div className="insight-value value-alert">{rhAlerts !== null ? rhAlerts : '--'}</div>
              <div className="insight-label">湿度异常</div>
            </div>
            <div>
              <div className="insight-value value-ok">
                {linkStability !== null ? `${linkStability.toFixed(1)}%` : '--'}
              </div>
              <div className="insight-label">链路稳定率</div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Overview;
