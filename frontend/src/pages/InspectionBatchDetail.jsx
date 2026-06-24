import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import StatCard from '../components/StatCard.jsx';
import TrendChart from '../components/TrendChart.jsx';
import InspectionRouteMap from '../components/InspectionRouteMap.jsx';
import InspectionStatusPill from '../components/InspectionStatusPill.jsx';
import { getInspectionBatch } from '../api.js';
import {
  formatDateTime,
  formatDuration,
  formatMetric,
  sampleMeasurements
} from '../lib/inspection.js';

const InspectionBatchDetail = () => {
  const { batchNo } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    getInspectionBatch(batchNo, { signal: controller.signal })
      .then(setData)
      .catch((requestError) => {
        if (requestError.name !== 'AbortError') {
          setError(requestError.message || '批次详情加载失败');
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [batchNo]);

  if (loading) {
    return <div className="page"><div className="loading-state">正在加载批次详情...</div></div>;
  }

  if (error || !data?.batch) {
    return (
      <div className="page">
        <div className="page-error">{error || '批次详情不存在'}</div>
        <Link className="ghost-button link-button" to="/inspections">返回批次列表</Link>
      </div>
    );
  }

  const {
    batch,
    area,
    points,
    trend: trendMeasurements = [],
    measurements = [],
    point_readings: pointReadings,
    actual_trail: actualTrail
  } = data;
  const trend = sampleMeasurements(
    trendMeasurements.length ? trendMeasurements : batch.measurements || measurements,
    300
  );
  const recentMeasurements = [
    ...(measurements.length ? measurements : batch.measurements || [])
  ].slice(-100).reverse();

  return (
    <div className="page">
      <div className="detail-heading card">
        <div>
          <div className="eyebrow">巡检批次</div>
          <div className="detail-title-row">
            <h2>{batch.batch_no}</h2>
            <InspectionStatusPill status={batch.status} />
          </div>
          <p>{formatDateTime(batch.start_time)} · {batch.device_id} · {formatDuration(batch.duration_sec)}</p>
        </div>
        <Link className="ghost-button link-button" to="/inspections">返回批次列表</Link>
      </div>

      <section className="stats-grid">
        <StatCard label="有效采集" value={batch.sample_count} unit="条" note="温度或湿度至少一项有效" />
        <StatCard label="平均温度" value={formatMetric(batch.temp_avg)} unit="℃" note={`${formatMetric(batch.temp_min)}～${formatMetric(batch.temp_max)}℃`} />
        <StatCard label="平均湿度" value={formatMetric(batch.rh_avg)} unit="%" note={`${formatMetric(batch.rh_min)}～${formatMetric(batch.rh_max)}%`} />
        <StatCard label="匹配点位" value={batch.point_count} unit="个" note={`${batch.actual_trail_points} 个有效轨迹坐标`} />
      </section>

      <section className="panel-grid">
        <TrendChart
          title="本次巡检温湿度曲线"
          subtitle={`最多展示300个采样节点 · 原始记录 ${batch.sample_count} 条`}
          data={trend}
        />
        <div className="card batch-judgement-card">
          <div className="card-header">
            <div>
              <div className="card-title">批次判定</div>
              <div className="card-subtitle">按点位或传感器已配置阈值计算</div>
            </div>
            <InspectionStatusPill status={batch.status} />
          </div>
          <div className="judgement-summary">
            <p>{batch.status_reason}</p>
            <div>
              <span>温度异常记录<strong>{batch.temp_abnormal_count}</strong></span>
              <span>湿度异常记录<strong>{batch.rh_abnormal_count}</strong></span>
              <span>未匹配点位<strong>{batch.unmatched_point_count ?? '--'}</strong></span>
            </div>
          </div>
        </div>
      </section>

      <section className="card inspection-map-card">
        <InspectionRouteMap
          area={area}
          points={points}
          actualTrail={actualTrail}
          pointReadings={pointReadings}
        />
      </section>

      <section className="card table-card">
        <div className="card-header">
          <div>
            <div className="card-title">采集明细</div>
            <div className="card-subtitle">按时间倒序展示最近100条记录</div>
          </div>
        </div>
        <div className="measurement-table">
          <div className="measurement-row measurement-head">
            <span>采集时间</span>
            <span>点位</span>
            <span>温度</span>
            <span>湿度</span>
            <span>坐标</span>
            <span>判定</span>
          </div>
          {recentMeasurements.map((measurement) => {
            const abnormal = measurement.temp_abnormal || measurement.rh_abnormal;
            return (
              <div className="measurement-row" key={measurement.id}>
                <span>{formatDateTime(measurement.ts)}</span>
                <span>{measurement.matched_point_id || '未匹配'}</span>
                <span>{formatMetric(measurement.temp_c)}℃</span>
                <span>{formatMetric(measurement.rh)}%</span>
                <span>
                  {measurement.pos_x !== null && measurement.pos_y !== null
                    ? `${formatMetric(measurement.pos_x, 2)}, ${formatMetric(measurement.pos_y, 2)}`
                    : '--'}
                </span>
                <span className={abnormal ? 'value-alert' : measurement.covered_by_rule ? 'value-ok' : 'value-muted'}>
                  {abnormal ? '越限' : measurement.covered_by_rule ? '正常' : '未判定'}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};

export default InspectionBatchDetail;
