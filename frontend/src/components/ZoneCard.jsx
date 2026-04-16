import React from 'react';

const statusStyles = {
  ok: 'status-ok',
  alert: 'status-alert',
  offline: 'status-offline'
};

const ZoneCard = ({ zone, onSelect }) => {
  const statusClass = statusStyles[zone.status] || 'status-ok';
  const valueTone = zone.status === 'alert' ? 'value-alert' : zone.status === 'ok' ? 'value-ok' : '';
  return (
    <button className={`card zone-card ${statusClass}`} onClick={() => onSelect?.(zone)}>
      <div className="zone-header">
        <div>
          <div className="zone-title">{zone.name}</div>
          <div className="zone-subtitle">{zone.description || zone.zone_id}</div>
        </div>
        <span className="status-pill">{zone.status_reason}</span>
      </div>
      {zone.latest ? (
        <div className="zone-metrics">
          <div>
            <div className="zone-metric-label">温度</div>
            <div className={`zone-metric-value ${valueTone}`}>{zone.latest.temp_c != null ? `${zone.latest.temp_c}°C` : '--'}</div>
          </div>
          <div>
            <div className="zone-metric-label">湿度</div>
            <div className={`zone-metric-value ${valueTone}`}>{zone.latest.rh != null ? `${zone.latest.rh}%` : '--'}</div>
          </div>
          <div>
            <div className="zone-metric-label">更新</div>
            <div className="zone-metric-value small">{new Date(zone.latest.ts).toLocaleTimeString()}</div>
          </div>
        </div>
      ) : (
        <div className="zone-empty">暂无最新数据</div>
      )}
    </button>
  );
};

export default ZoneCard;
