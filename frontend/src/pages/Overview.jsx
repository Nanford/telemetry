import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import StatCard from '../components/StatCard.jsx';
import TrendChart from '../components/TrendChart.jsx';
import InspectionStatusPill from '../components/InspectionStatusPill.jsx';
import { getInspectionBatch, getInspectionBatches } from '../api.js';
import {
  formatDateTime,
  formatDuration,
  formatMetric,
  sampleMeasurements
} from '../lib/inspection.js';

const POLL_INTERVAL = 30_000;

const Overview = () => {
  const [data, setData] = useState({ summary: {}, items: [] });
  const [latestDetail, setLatestDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (signal) => {
    try {
      setError('');
      const batches = await getInspectionBatches({ page: 1, page_size: 5 }, { signal });
      setData(batches);
      const latestBatchNo = batches.summary?.latest_batch_no;
      if (latestBatchNo) {
        setLatestDetail(await getInspectionBatch(latestBatchNo, { signal }));
      } else {
        setLatestDetail(null);
      }
    } catch (requestError) {
      if (requestError.name !== 'AbortError') {
        setError(requestError.message || '巡检数据加载失败');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    const timer = setInterval(() => load(controller.signal), POLL_INTERVAL);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);

  if (loading) {
    return <div className="page"><div className="loading-state">正在加载巡检数据...</div></div>;
  }

  const summary = data.summary || {};
  const latestBatch = latestDetail?.batch;
  const trend = sampleMeasurements(
    latestDetail?.trend || latestDetail?.measurements || latestBatch?.measurements || [],
    240
  );

  return (
    <div className="page">
      {error && <div className="page-error">{error}</div>}

      <section className="stats-grid">
        <StatCard
          label="今日巡检批次"
          value={summary.today_batches ?? '--'}
          unit="次"
          note="按上海时区统计"
        />
        <StatCard
          label="有效采集数据"
          value={summary.total_measurements ?? '--'}
          unit="条"
          note="仅统计温度或湿度有效记录"
        />
        <StatCard
          label="累计巡检批次"
          value={summary.total_batches ?? '--'}
          unit="次"
          note="相邻采集间隔超过30分钟自动分批"
        />
        <StatCard
          label="异常批次"
          value={summary.abnormal_batches ?? '--'}
          unit="次"
          note={`${summary.undetermined_batches ?? 0} 个批次尚未判定`}
        />
      </section>

      <section className="panel-grid">
        <div className="card latest-inspection-card">
          <div className="card-header">
            <div>
              <div className="card-title">最近一次巡检</div>
              <div className="card-subtitle">机器狗完成单次进仓采集后形成独立批次</div>
            </div>
            {latestBatch && <InspectionStatusPill status={latestBatch.status} />}
          </div>

          {latestBatch ? (
            <>
              <div className="latest-inspection-main">
                <div>
                  <span className="eyebrow">批次号</span>
                  <strong className="latest-batch-no">{latestBatch.batch_no}</strong>
                </div>
                <div className="latest-inspection-time">
                  <span>{formatDateTime(latestBatch.start_time)}</span>
                  <small>{formatDuration(latestBatch.duration_sec)} · {latestBatch.sample_count} 条采集</small>
                </div>
              </div>
              <div className="latest-metric-grid">
                <div>
                  <span>温度范围</span>
                  <strong>{formatMetric(latestBatch.temp_min)}～{formatMetric(latestBatch.temp_max)}℃</strong>
                </div>
                <div>
                  <span>平均温度</span>
                  <strong>{formatMetric(latestBatch.temp_avg)}℃</strong>
                </div>
                <div>
                  <span>湿度范围</span>
                  <strong>{formatMetric(latestBatch.rh_min)}～{formatMetric(latestBatch.rh_max)}%</strong>
                </div>
                <div>
                  <span>已匹配点位</span>
                  <strong>{latestBatch.point_count} 个</strong>
                </div>
              </div>
              <div className="card-actions">
                <Link className="primary-button link-button" to={`/inspections/${latestBatch.batch_no}`}>
                  查看批次详情
                </Link>
                <Link className="ghost-button link-button" to="/inspections">
                  查看全部批次
                </Link>
              </div>
            </>
          ) : (
            <div className="empty-state">暂无有效温湿度采集批次</div>
          )}
        </div>

        <TrendChart
          title="最近批次温湿度曲线"
          subtitle={latestBatch ? `${latestBatch.batch_no} · 按采集时间展示` : '暂无批次数据'}
          data={trend}
        />
      </section>

      <section className="card table-card">
        <div className="card-header">
          <div>
            <div className="card-title">最近巡检批次</div>
            <div className="card-subtitle">批次号采用年月日加当日流水号</div>
          </div>
          <Link className="ghost-button link-button" to="/reports">查看巡检报表</Link>
        </div>
        <div className="inspection-table">
          <div className="inspection-row inspection-head">
            <span>批次号</span>
            <span>开始时间</span>
            <span>持续时长</span>
            <span>采集数量</span>
            <span>温湿度均值</span>
            <span>状态</span>
            <span />
          </div>
          {data.items.map((batch) => (
            <div className="inspection-row" key={batch.batch_no}>
              <span className="table-strong">{batch.batch_no}</span>
              <span>{formatDateTime(batch.start_time)}</span>
              <span>{formatDuration(batch.duration_sec)}</span>
              <span>{batch.sample_count} 条</span>
              <span>{formatMetric(batch.temp_avg)}℃ / {formatMetric(batch.rh_avg)}%</span>
              <span><InspectionStatusPill status={batch.status} /></span>
              <Link to={`/inspections/${batch.batch_no}`} className="table-link">查看</Link>
            </div>
          ))}
        </div>
        {!data.items.length && <div className="table-empty">暂无巡检批次</div>}
      </section>
    </div>
  );
};

export default Overview;
