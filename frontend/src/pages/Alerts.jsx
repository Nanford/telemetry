import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { getAlerts } from '../api.js';

const POLL_INTERVAL = 15_000;
const statuses = ['all', 'open', 'acked', 'closed'];
const statusLabels = {
  all: '全部',
  open: '待处理',
  acked: '已确认',
  closed: '已关闭'
};

const metricLabels = {
  temp: '温度',
  temp_c: '温度',
  rh: '湿度'
};

const metricUnits = {
  temp: '℃',
  temp_c: '℃',
  rh: '%'
};

const getMetricLabel = (metric) => {
  if (!metric) return '--';
  return metricLabels[metric] || metric;
};

const getStatusLabel = (status) => statusLabels[status] || status || '--';
const getStatusClass = (status) => {
  if (status === 'open') return 'warning';
  if (status === 'acked') return 'undetermined';
  return '';
};

const formatCurrentValue = (alert) => {
  if (alert?.current_value === null || alert?.current_value === undefined || alert?.current_value === '') {
    return '--';
  }
  return `${alert.current_value}${metricUnits[alert.metric] || ''}`;
};

const formatAlertMessage = (alert) => {
  if (!alert) return '--';
  if (!alert.message) {
    if (!alert.metric) return '--';
    return `${getMetricLabel(alert.metric)}超出阈值`;
  }

  let formatted = alert.message;
  Object.entries(metricLabels).forEach(([raw, label]) => {
    const regex = new RegExp(`\\b${raw}\\b`, 'gi');
    formatted = formatted.replace(regex, label);
  });

  if (formatted === alert.message && alert.metric) {
    const label = metricLabels[alert.metric];
    if (label && !formatted.includes(label)) {
      formatted = `${label}${formatted}`;
    }
  }

  return formatted;
};

const Alerts = () => {
  const [alerts, setAlerts] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const abortRef = useRef(null);

  const load = useCallback(async (signal) => {
    try {
      const data = await getAlerts(null, { signal });
      setAlerts(data);
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
      if (!ac.signal.aborted) load(ac.signal);
    }, POLL_INTERVAL);

    return () => {
      ac.abort();
      clearInterval(timer);
    };
  }, [load]);

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return alerts;
    return alerts.filter((alert) => alert.status === statusFilter);
  }, [alerts, statusFilter]);

  if (loading) {
    return <div className="page"><div className="loading-state">加载中...</div></div>;
  }

  return (
    <div className="page">
      <div className="filter-bar">
        <div className="filter-group">
          <span className="filter-label">状态</span>
          <div className="chip-row">
            {statuses.map((status) => (
              <button
                key={status}
                className={`chip ${statusFilter === status ? 'active' : ''}`}
                onClick={() => setStatusFilter(status)}
              >
                {getStatusLabel(status)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="card table-card">
        <div className="card-header">
          <div>
            <div className="card-title">告警列表</div>
            <div className="card-subtitle">温湿度异常与处理状态</div>
          </div>
          <button className="ghost-button">批量确认</button>
        </div>
        <div className="table alerts-table">
          <div className="table-row table-head">
            <span>告警</span>
            <span>区域</span>
            <span>指标</span>
            <span>当前值</span>
            <span>状态</span>
            <span>最近触发</span>
          </div>
          {filtered.map((alert) => (
            <div key={alert.id} className="table-row">
              <span className="table-strong">{formatAlertMessage(alert)}</span>
              <span>{alert.zone_id || '--'}</span>
              <span>{getMetricLabel(alert.metric)}</span>
              <span className={alert.status === 'closed' ? 'value-ok' : 'value-alert'}>
                {formatCurrentValue(alert)}
              </span>
              <span className={`status-pill ${getStatusClass(alert.status)}`}>
                {getStatusLabel(alert.status)}
              </span>
              <span>{new Date(alert.last_trigger_at).toLocaleString()}</span>
            </div>
          ))}
        </div>
        {!filtered.length && <div className="table-empty">暂无告警数据</div>}
      </div>
    </div>
  );
};

export default Alerts;
