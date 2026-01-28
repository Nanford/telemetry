import React, { useEffect, useMemo, useState } from 'react';
import { getAlerts } from '../api.js';

const statuses = ['all', 'open', 'acked', 'closed'];

const Alerts = () => {
  const [alerts, setAlerts] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    const load = async () => {
      const data = await getAlerts();
      setAlerts(data);
    };
    load();
  }, []);

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return alerts;
    return alerts.filter((alert) => alert.status === statusFilter);
  }, [alerts, statusFilter]);

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
                {status === 'all' ? '全部' : status}
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
              <span className="table-strong">{alert.message}</span>
              <span>{alert.zone_id || '--'}</span>
              <span>{alert.metric}</span>
              <span className={alert.status === 'closed' ? 'value-ok' : 'value-alert'}>
                {alert.current_value ?? '--'}
              </span>
              <span className={`status-pill ${alert.status === 'open' ? 'warning' : ''}`}>
                {alert.status}
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
