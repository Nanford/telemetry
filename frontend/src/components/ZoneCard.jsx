import React from 'react';

function formatAge(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.floor(hr / 24);
  return `${day}天前`;
}

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
            <div className="zone-metric-value small" title={new Date(zone.latest.ts).toLocaleString()}>{formatAge(zone.latest.ts)}</div>
          </div>
        </div>
      ) : (
        <div className="zone-empty">暂无最新数据</div>
      )}
    </button>
  );
};

export default ZoneCard;
