import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import InspectionStatusPill from '../components/InspectionStatusPill.jsx';
import { getInspectionBatches } from '../api.js';
import {
  createDefaultInspectionRange,
  formatDateTime,
  formatDuration,
  formatMetric
} from '../lib/inspection.js';

const initialRange = createDefaultInspectionRange();

const InspectionBatches = () => {
  const [status, setStatus] = useState('');
  const [start, setStart] = useState(initialRange.start);
  const [end, setEnd] = useState(initialRange.end);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ summary: {}, items: [], pagination: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const params = {
      page,
      page_size: 20,
      status,
      start: start ? `${start}:00+08:00` : '',
      end: end ? `${end}:59+08:00` : ''
    };

    setLoading(true);
    setError('');
    getInspectionBatches(params, { signal: controller.signal })
      .then(setData)
      .catch((requestError) => {
        if (requestError.name !== 'AbortError') {
          setError(requestError.message || '巡检批次加载失败');
        }
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [status, start, end, page]);

  const updateFilter = (setter) => (event) => {
    setter(event.target.value);
    setPage(1);
  };
  const pagination = data.pagination || {};

  return (
    <div className="page">
      <div className="filter-bar inspection-filter">
        <div className="filter-group">
          <span className="filter-label">开始时间</span>
          <input className="select" type="datetime-local" value={start} onChange={updateFilter(setStart)} />
        </div>
        <div className="filter-group">
          <span className="filter-label">结束时间</span>
          <input className="select" type="datetime-local" value={end} onChange={updateFilter(setEnd)} />
        </div>
        <div className="filter-group">
          <span className="filter-label">判定状态</span>
          <select className="select" value={status} onChange={updateFilter(setStatus)}>
            <option value="">全部状态</option>
            <option value="normal">正常</option>
            <option value="abnormal">存在异常</option>
            <option value="undetermined">未判定</option>
          </select>
        </div>
        <div className="filter-note">默认最近24小时 · 同一设备相邻有效采集间隔超过30分钟产生新批次</div>
      </div>

      {error && <div className="page-error">{error}</div>}

      <div className="card table-card">
        <div className="card-header">
          <div>
            <div className="card-title">巡检批次</div>
            <div className="card-subtitle">
              共 {data.summary?.total_batches ?? 0} 个批次，{data.summary?.total_measurements ?? 0} 条有效采集
            </div>
          </div>
        </div>

        {loading ? (
          <div className="loading-state">正在加载巡检批次...</div>
        ) : (
          <>
            <div className="inspection-table">
              <div className="inspection-row inspection-list-row inspection-head">
                <span>批次号</span>
                <span>巡检时间</span>
                <span>时长</span>
                <span>采集数量</span>
                <span>温度</span>
                <span>湿度</span>
                <span>状态</span>
                <span />
              </div>
              {data.items.map((batch) => (
                <div className="inspection-row inspection-list-row" key={batch.batch_no}>
                  <span className="table-strong">{batch.batch_no}</span>
                  <span>{formatDateTime(batch.start_time)}</span>
                  <span>{formatDuration(batch.duration_sec)}</span>
                  <span>{batch.sample_count} 条</span>
                  <span>{formatMetric(batch.temp_min)}～{formatMetric(batch.temp_max)}℃</span>
                  <span>{formatMetric(batch.rh_min)}～{formatMetric(batch.rh_max)}%</span>
                  <span><InspectionStatusPill status={batch.status} /></span>
                  <Link className="table-link" to={`/inspections/${batch.batch_no}`}>详情</Link>
                </div>
              ))}
            </div>
            {!data.items.length && <div className="table-empty">当前筛选条件下暂无巡检批次</div>}
          </>
        )}

        <div className="pagination">
          <span>第 {pagination.page || 1} / {pagination.total_pages || 1} 页</span>
          <div>
            <button
              className="ghost-button"
              disabled={(pagination.page || 1) <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              上一页
            </button>
            <button
              className="ghost-button"
              disabled={(pagination.page || 1) >= (pagination.total_pages || 1)}
              onClick={() => setPage((value) => value + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InspectionBatches;
