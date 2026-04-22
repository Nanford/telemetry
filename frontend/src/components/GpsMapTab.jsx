import React, { useEffect, useState } from 'react';
import MapPanel from './MapPanel.jsx';
import {
  getGeoLatest,
  getGeofences,
  saveGeofence,
  updateGeofence,
  deleteGeofence,
  autoInitGeofences
} from '../api.js';

const emptyForm = {
  zone_id: '',
  name: '',
  description: '',
  min_lat: '',
  max_lat: '',
  min_lon: '',
  max_lon: '',
  priority: 0
};

const modeLabels = {
  manual: '手动模式',
  auto: '自动模式'
};

const GpsMapTab = () => {
  const [devices, setDevices] = useState([]);
  const [geofences, setGeofences] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState('manual');
  const [autoScope, setAutoScope] = useState('all');
  const [autoZoneId, setAutoZoneId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deletingZoneId, setDeletingZoneId] = useState(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoSuccess, setAutoSuccess] = useState('');
  const [autoError, setAutoError] = useState('');

  const load = async () => {
    const [deviceData, fenceData] = await Promise.all([getGeoLatest(), getGeofences()]);
    setDevices(deviceData);
    setGeofences(fenceData);

    if (!autoZoneId && fenceData.length) {
      setAutoZoneId(fenceData[0].zone_id);
    } else if (autoZoneId && !fenceData.some((zone) => zone.zone_id === autoZoneId)) {
      setAutoZoneId(fenceData[0]?.zone_id || '');
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!autoSuccess) return undefined;
    const timer = window.setTimeout(() => setAutoSuccess(''), 3000);
    return () => window.clearTimeout(timer);
  }, [autoSuccess]);

  const resetManualForm = () => {
    setForm(emptyForm);
    setEditing(false);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setAutoError('');
    setAutoSuccess('');

    try {
      const payload = {
        ...form,
        min_lat: Number(form.min_lat),
        max_lat: Number(form.max_lat),
        min_lon: Number(form.min_lon),
        max_lon: Number(form.max_lon),
        priority: Number(form.priority || 0)
      };

      if (editing) {
        await updateGeofence(form.zone_id, payload);
      } else {
        await saveGeofence(payload);
      }

      resetManualForm();
      await load();
    } catch (err) {
      setAutoError(err.message || '围栏保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (zone) => {
    setMode('manual');
    setAutoError('');
    setAutoSuccess('');
    setForm({
      zone_id: zone.zone_id,
      name: zone.name,
      description: zone.description || '',
      min_lat: zone.min_lat,
      max_lat: zone.max_lat,
      min_lon: zone.min_lon,
      max_lon: zone.max_lon,
      priority: zone.priority || 0
    });
    setEditing(true);
  };

  const handleDelete = async (zoneId) => {
    setDeletingZoneId(zoneId);
    setAutoError('');
    setAutoSuccess('');

    try {
      await deleteGeofence(zoneId);
      if (form.zone_id === zoneId) {
        resetManualForm();
      }
      await load();
    } catch (err) {
      setAutoError(err.message || '围栏删除失败');
    } finally {
      setDeletingZoneId(null);
    }
  };

  const handleAutoInit = async () => {
    setAutoRunning(true);
    setAutoError('');
    setAutoSuccess('');

    try {
      const payload = autoScope === 'single' ? { zone_id: autoZoneId } : {};
      const result = await autoInitGeofences(payload);
      const results = Array.isArray(result?.results) ? result.results : [];
      const updatedCount = results.filter((item) => item.status === 'updated').length;
      const skippedCount = results.filter((item) => item.status === 'skipped').length;
      const scopeLabel = autoScope === 'single' ? `标签 ${autoZoneId}` : '全部标签';
      let message = `${scopeLabel}自动重算完成`;

      if (updatedCount > 0) {
        message += `，已更新 ${updatedCount} 个围栏`;
      }
      if (skippedCount > 0) {
        message += `，跳过 ${skippedCount} 个没有当前定位的标签`;
      }
      if (!results.length) {
        message += '，当前没有可处理的围栏';
      }

      setAutoSuccess(message);
      await load();
    } catch (err) {
      setAutoError(err.message || '自动初始化失败');
    } finally {
      setAutoRunning(false);
    }
  };

  return (
    <>
      <MapPanel devices={devices} geofences={geofences} />

      <div className="panel-grid two">
        <div className="card geofence-card">
          <div className="card-header">
            <div>
              <div className="card-title">库区围栏配置</div>
              <div className="card-subtitle">矩形范围，支持手动维护和按当前定位自动重算</div>
            </div>
            <button
              className="ghost-button"
              type="button"
              onClick={() => {
                setAutoError('');
                setAutoSuccess('');
                setMode('manual');
                resetManualForm();
              }}
            >
              新建围栏
            </button>
          </div>

          <div className="mode-switch">
            {Object.entries(modeLabels).map(([value, label]) => (
              <button
                key={value}
                className={`chip ${mode === value ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  setAutoError('');
                  setAutoSuccess('');
                  setMode(value);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === 'manual' ? (
            <form className="geofence-form" onSubmit={handleSubmit}>
              <div className="form-row">
                <label>
                  区域编号
                  <input
                    value={form.zone_id}
                    onChange={(e) => setForm({ ...form, zone_id: e.target.value })}
                    placeholder="A1"
                    required
                    disabled={editing}
                  />
                </label>
                <label>
                  区域名称
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="原料区 A1"
                    required
                  />
                </label>
              </div>

              <label>
                说明
                <input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="北侧原料通道"
                />
              </label>

              <div className="form-row">
                <label>
                  最小纬度
                  <input
                    type="number"
                    step="0.000001"
                    value={form.min_lat}
                    onChange={(e) => setForm({ ...form, min_lat: e.target.value })}
                    required
                  />
                </label>
                <label>
                  最大纬度
                  <input
                    type="number"
                    step="0.000001"
                    value={form.max_lat}
                    onChange={(e) => setForm({ ...form, max_lat: e.target.value })}
                    required
                  />
                </label>
              </div>

              <div className="form-row">
                <label>
                  最小经度
                  <input
                    type="number"
                    step="0.000001"
                    value={form.min_lon}
                    onChange={(e) => setForm({ ...form, min_lon: e.target.value })}
                    required
                  />
                </label>
                <label>
                  最大经度
                  <input
                    type="number"
                    step="0.000001"
                    value={form.max_lon}
                    onChange={(e) => setForm({ ...form, max_lon: e.target.value })}
                    required
                  />
                </label>
              </div>

              <label>
                优先级（数字越大优先）
                <input
                  type="number"
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                />
              </label>

              <div className="form-actions">
                <button className="primary-button" type="submit" disabled={submitting}>
                  {submitting ? '保存中...' : editing ? '更新围栏' : '保存围栏'}
                </button>
                {editing && (
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={resetManualForm}
                  >
                    取消编辑
                  </button>
                )}
              </div>
            </form>
          ) : (
            <div className="auto-init-panel">
              <div className="auto-init-note">
                基于当前标签最近一批定位点重算已有围栏；没有当前定位的标签会直接跳过，不会新增标签。
              </div>

              <div className="filter-group">
                <span className="filter-label">初始化范围</span>
                <div className="chip-row">
                  <button
                    className={`chip ${autoScope === 'all' ? 'active' : ''}`}
                    type="button"
                    onClick={() => setAutoScope('all')}
                  >
                    全部标签
                  </button>
                  <button
                    className={`chip ${autoScope === 'single' ? 'active' : ''}`}
                    type="button"
                    onClick={() => setAutoScope('single')}
                  >
                    单个标签
                  </button>
                </div>
              </div>

              {autoScope === 'single' && (
                <label className="auto-init-field">
                  标签
                  <select
                    className="select"
                    value={autoZoneId}
                    onChange={(e) => setAutoZoneId(e.target.value)}
                  >
                    {geofences.map((zone) => (
                      <option key={zone.zone_id} value={zone.zone_id}>
                        {zone.name || zone.zone_id}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="form-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={handleAutoInit}
                  disabled={autoRunning || (autoScope === 'single' && !autoZoneId)}
                >
                  {autoRunning
                    ? '初始化中...'
                    : autoScope === 'single'
                      ? '重算当前标签围栏'
                      : '重算全部围栏'}
                </button>
              </div>
            </div>
          )}

          {autoError && <div className="auto-init-error">{autoError}</div>}
          {autoSuccess && <div className="auto-init-success">{autoSuccess}</div>}
        </div>

        <div className="card geofence-list">
          <div className="card-header">
            <div>
              <div className="card-title">已配置库区</div>
              <div className="card-subtitle">{geofences.length} 个围栏</div>
            </div>
          </div>

          <div className="geofence-items">
            {geofences.map((zone) => (
              <div key={zone.zone_id} className="geofence-item">
                <div>
                  <div className="geofence-title">{zone.name}</div>
                  <div className="geofence-sub">{zone.zone_id} · {zone.description || '无说明'}</div>
                  <div className="geofence-range">
                    [{zone.min_lat}, {zone.min_lon}] → [{zone.max_lat}, {zone.max_lon}]
                  </div>
                </div>
                <div className="geofence-actions">
                  <button className="ghost-button" type="button" onClick={() => startEdit(zone)}>
                    编辑
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => handleDelete(zone.zone_id)}
                    disabled={deletingZoneId === zone.zone_id}
                  >
                    {deletingZoneId === zone.zone_id ? '删除中...' : '删除'}
                  </button>
                </div>
              </div>
            ))}
            {!geofences.length && <div className="table-empty">暂无围栏配置</div>}
          </div>
        </div>
      </div>
    </>
  );
};

export default GpsMapTab;
