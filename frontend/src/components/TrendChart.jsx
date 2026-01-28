import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid
} from 'recharts';

const formatTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
};

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload || !payload.length) return null;
  const temp = payload.find((item) => item.dataKey === 'temp_c')?.value;
  const rh = payload.find((item) => item.dataKey === 'rh')?.value;
  const formatVal = (val, unit) => (val === null || val === undefined ? '--' : `${val}${unit}`);

  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-title">{new Date(label).toLocaleString()}</div>
      <div className="chart-tooltip-row">
        <span className="legend-dot temp" /> 温度：{formatVal(temp, '℃')}
      </div>
      <div className="chart-tooltip-row">
        <span className="legend-dot rh" /> 湿度：{formatVal(rh, '%')}
      </div>
    </div>
  );
};

const TrendChart = ({ data, title, subtitle }) => (
  <div className="card chart-card">
    <div className="card-header">
      <div>
        <div className="card-title">{title}</div>
        <div className="card-subtitle">{subtitle}</div>
      </div>
      <div className="chart-legend">
        <span><i className="legend-dot temp" /> 温度</span>
        <span><i className="legend-dot rh" /> 湿度</span>
      </div>
    </div>
    <div className="chart-body">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="4 8" stroke="rgba(62,124,219,0.2)" />
          <XAxis dataKey="ts" tickFormatter={formatTime} stroke="#6b8bbf" fontSize={12} />
          <YAxis yAxisId="left" stroke="#3f6bb4" fontSize={12} />
          <YAxis yAxisId="right" orientation="right" stroke="#3fb3ff" fontSize={12} />
          <Tooltip content={<CustomTooltip />} />
          <Line
            type="monotone"
            dataKey="temp_c"
            stroke="#2f7dff"
            strokeWidth={2.2}
            dot={false}
            yAxisId="left"
          />
          <Line
            type="monotone"
            dataKey="rh"
            stroke="#65c8ff"
            strokeWidth={2}
            dot={false}
            yAxisId="right"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  </div>
);

export default TrendChart;
