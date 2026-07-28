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

/**
 * @param {string} [staleNote] 非空时在图上方挂一条琥珀色横幅，说明画的是历史快照
 *                             而非当前时间窗的数据。曲线本身不做视觉弱化——
 *                             读数是真实的，弱化会让人怀疑数值准确性。
 */
const TrendChart = ({ data, title, subtitle, actions, emptyHint, staleNote }) => (
  <div className="card chart-card">
    <div className="card-header">
      <div>
        <div className="card-title">{title}</div>
        <div className="card-subtitle">{subtitle}</div>
      </div>
      <div className="chart-header-side">
        {actions}
        <div className="chart-legend">
          <span><i className="legend-dot temp" /> 温度 (℃)</span>
          <span><i className="legend-dot rh" /> 湿度 (%)</span>
        </div>
      </div>
    </div>
    {staleNote && (
      <div className="chart-stale-banner" role="status">
        <strong>历史快照</strong>
        <span>{staleNote}</span>
      </div>
    )}
    {/* 没数据时不能照画坐标轴——空网格看起来和"曲线贴着 0"没区别,
        会让人以为读数是 0 而不是没采到。宁可明说这个时间窗是空的。 */}
    {!data?.length ? (
      <div className="chart-empty">{emptyHint || '所选时间窗内没有采集数据'}</div>
    ) : (
    <div className="chart-body">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 24, left: 8, bottom: 18 }}>
          <CartesianGrid strokeDasharray="4 8" stroke="rgba(62,124,219,0.2)" />
          <XAxis
            dataKey="ts"
            tickFormatter={formatTime}
            stroke="#6b8bbf"
            fontSize={12}
            label={{ value: '采集时间', position: 'insideBottom', offset: -10, fill: '#6b8bbf', fontSize: 12 }}
          />
          <YAxis
            yAxisId="left"
            stroke="#3f6bb4"
            fontSize={12}
            width={46}
            label={{ value: '温度 (℃)', angle: -90, position: 'insideLeft', fill: '#3f6bb4', fontSize: 12 }}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            stroke="#3fb3ff"
            fontSize={12}
            width={46}
            label={{ value: '湿度 (%)', angle: 90, position: 'insideRight', fill: '#3fb3ff', fontSize: 12 }}
          />
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
    )}
  </div>
);

export default TrendChart;
