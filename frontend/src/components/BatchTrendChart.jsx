import React from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { formatDateTime, formatMetric } from '../lib/inspection.js';

const BatchTrendChart = ({ batches = [] }) => {
  const data = [...batches]
    .reverse()
    .map((batch) => ({
      batch_no: batch.batch_no,
      time: batch.start_time,
      temp_avg: batch.temp_avg,
      rh_avg: batch.rh_avg
    }));

  if (!data.length) {
    return <div className="chart-empty">暂无批次趋势数据</div>;
  }

  return (
    <div className="chart-body batch-trend-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 18, left: 8, bottom: 20 }}>
          <CartesianGrid stroke="rgba(47,125,255,0.1)" strokeDasharray="4 4" />
          <XAxis
            dataKey="batch_no"
            tick={{ fill: '#5b6f95', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            label={{ value: '巡检批次', position: 'insideBottom', offset: -12, fill: '#5b6f95', fontSize: 11 }}
          />
          <YAxis
            yAxisId="temp"
            tick={{ fill: '#5b6f95', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={48}
            label={{ value: '平均温度 (℃)', angle: -90, position: 'insideLeft', fill: '#5b6f95', fontSize: 11 }}
          />
          <YAxis
            yAxisId="rh"
            orientation="right"
            tick={{ fill: '#5b6f95', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={48}
            label={{ value: '平均湿度 (%)', angle: 90, position: 'insideRight', fill: '#5b6f95', fontSize: 11 }}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0].payload;
              return (
                <div className="chart-tooltip">
                  <div className="chart-tooltip-title">{row.batch_no}</div>
                  <div className="chart-tooltip-row">{formatDateTime(row.time)}</div>
                  <div className="chart-tooltip-row">平均温度：{formatMetric(row.temp_avg)}℃</div>
                  <div className="chart-tooltip-row">平均湿度：{formatMetric(row.rh_avg)}%</div>
                </div>
              );
            }}
          />
          <Legend verticalAlign="top" align="right" height={28} iconType="line" />
          <Line
            yAxisId="temp"
            type="monotone"
            dataKey="temp_avg"
            name="平均温度 (℃)"
            stroke="#ff6b6b"
            strokeWidth={2.2}
            dot={{ r: 3 }}
            connectNulls
          />
          <Line
            yAxisId="rh"
            type="monotone"
            dataKey="rh_avg"
            name="平均湿度 (%)"
            stroke="#2f7dff"
            strokeWidth={2.2}
            dot={{ r: 3 }}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default BatchTrendChart;
