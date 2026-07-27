import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { ackAlert, getAlerts } from '../api.js';

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
  // 正在确认中的告警 id 集合，用于禁用按钮防重复提交
  const [acking, setAcking] = useState(() => new Set());
  const [actionError, setActionError] = useState('');
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

  const openAlerts = useMemo(
    () => filtered.filter((alert) => alert.status === 'open'),
    [filtered]
  );

  /** 逐条提交确认。任一失败都如实报出，已成功的部分保留，随后重新拉取真实状态。 */
  const confirmAlerts = useCallback(async (targets) => {
    if (!targets.length) return;
    setActionError('');
    setAcking((prev) => new Set([...prev, ...targets.map((alert) => alert.id)]));

    const results = await Promise.allSettled(
      targets.map((alert) => ackAlert(alert.id, { acked_by: 'operator' }))
    );
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length) {
      setActionError(
        `${failed.length}/${targets.length} 条确认失败：${failed[0].reason?.message || '请求异常'}`
      );
    }

    setAcking((prev) => {
      const next = new Set(prev);
      targets.forEach((alert) => next.delete(alert.id));
      return next;
    });
    await load(abortRef.current?.signal);
  }, [load]);

  const handleBatchAck = useCallback(() => {
    if (!openAlerts.length) return;
    const confirmed = window.confirm(
      `确认当前筛选范围内的 ${openAlerts.length} 条待处理告警？此操作会写入后端。`
    );
    if (confirmed) confirmAlerts(openAlerts);
  }, [openAlerts, confirmAlerts]);

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

      {actionError && <div className="page-error">{actionError}</div>}

      <div className="card table-card">
        <div className="card-header">
          <div>
            <div className="card-title">告警列表</div>
            <div className="card-subtitle">温湿度异常与处理状态</div>
          </div>
          <button
            className="ghost-button"
            onClick={handleBatchAck}
            disabled={!openAlerts.length || acking.size > 0}
          >
            批量确认{openAlerts.length ? ` (${openAlerts.length})` : ''}
          </button>
        </div>
        <div className="table alerts-table">
          <div className="table-row table-head">
            <span>告警</span>
            <span>区域</span>
            <span>指标</span>
            <span>当前值</span>
            <span>状态</span>
            <span>最近触发</span>
            <span>操作</span>
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
              <span>
                {alert.status === 'open' ? (
                  <button
                    className="ghost-button row-action"
                    onClick={() => confirmAlerts([alert])}
                    disabled={acking.has(alert.id)}
                  >
                    {acking.has(alert.id) ? '提交中' : '确认'}
                  </button>
                ) : (
                  <span className="value-muted">--</span>
                )}
              </span>
            </div>
          ))}
        </div>
        {!filtered.length && <div className="table-empty">暂无告警数据</div>}
      </div>
    </div>
  );
};

export default Alerts;
