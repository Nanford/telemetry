import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import StatCard from '../components/StatCard.jsx';
import BatchTrendChart from '../components/BatchTrendChart.jsx';
import InspectionStatusPill from '../components/InspectionStatusPill.jsx';
import { getInspectionBatches } from '../api.js';
import { formatDateTime, formatMetric } from '../lib/inspection.js';

const InspectionReports = () => {
  const [data, setData] = useState({ summary: {}, items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    getInspectionBatches({ page: 1, page_size: 100 }, { signal: controller.signal })
      .then(setData)
      .catch((requestError) => {
        if (requestError.name !== 'AbortError') {
          setError(requestError.message || '巡检报表加载失败');
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  if (loading) {
    return <div className="page"><div className="loading-state">正在汇总巡检报表...</div></div>;
  }

  const summary = data.summary || {};
  const statusTotal = summary.total_batches || 1;
  const statusRows = [
    { label: '正常批次', value: summary.normal_batches || 0, tone: 'ok' },
    { label: '异常批次', value: summary.abnormal_batches || 0, tone: 'alert' },
    { label: '未判定批次', value: summary.undetermined_batches || 0, tone: 'muted' }
  ];

  return (
    <div className="page">
      {error && <div className="page-error">{error}</div>}
      <section className="stats-grid">
        <StatCard label="累计巡检批次" value={summary.total_batches ?? '--'} unit="次" note="按30分钟断档自动归组" />
        <StatCard label="累计采集数据" value={summary.total_measurements ?? '--'} unit="条" note="温湿度有效记录" />
        <StatCard label="温度异常记录" value={summary.temp_abnormal_records ?? '--'} unit="条" note="依据已配置阈值" />
        <StatCard label="湿度异常记录" value={summary.rh_abnormal_records ?? '--'} unit="条" note="依据已配置阈值" />
      </section>

      <section className="panel-grid">
        <div className="card chart-card">
          <div className="card-header">
            <div>
              <div className="card-title">各批次温湿度均值趋势</div>
              <div className="card-subtitle">最多展示最近100个巡检批次</div>
            </div>
          </div>
          <BatchTrendChart batches={data.items} />
        </div>

        <div className="card report-status-card">
          <div className="card-header">
            <div>
              <div className="card-title">批次判定分布</div>
              <div className="card-subtitle">无适用规则的批次单独列为未判定</div>
            </div>
          </div>
          <div className="status-distribution">
            {statusRows.map((row) => (
              <div className="status-distribution-row" key={row.label}>
                <div>
                  <span>{row.label}</span>
                  <strong>{row.value}</strong>
                </div>
                <div className="distribution-track">
                  <span
                    className={`distribution-fill ${row.tone}`}
                    style={{ width: `${(row.value / statusTotal) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="card table-card">
        <div className="card-header">
          <div>
            <div className="card-title">巡检汇总明细</div>
            <div className="card-subtitle">展示最近100个批次的关键统计</div>
          </div>
          <Link className="ghost-button link-button" to="/inspections">进入批次查询</Link>
        </div>
        <div className="report-table">
          <div className="report-row report-head">
            <span>批次号</span>
            <span>开始时间</span>
            <span>采集数</span>
            <span>平均温度</span>
            <span>平均湿度</span>
            <span>异常记录</span>
            <span>状态</span>
          </div>
          {data.items.map((batch) => (
            <div className="report-row" key={batch.batch_no}>
              <Link className="table-link" to={`/inspections/${batch.batch_no}`}>{batch.batch_no}</Link>
              <span>{formatDateTime(batch.start_time)}</span>
              <span>{batch.sample_count}</span>
              <span>{formatMetric(batch.temp_avg)}℃</span>
              <span>{formatMetric(batch.rh_avg)}%</span>
              <span>{batch.temp_abnormal_count + batch.rh_abnormal_count}</span>
              <span><InspectionStatusPill status={batch.status} /></span>
            </div>
          ))}
        </div>
        {!data.items.length && <div className="table-empty">暂无巡检报表数据</div>}
      </section>
    </div>
  );
};

export default InspectionReports;
