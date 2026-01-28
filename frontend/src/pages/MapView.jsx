import React, { useEffect, useState } from 'react';
import MapPanel from '../components/MapPanel.jsx';
import { getGeoLatest, getGeofences, saveGeofence, updateGeofence, deleteGeofence } from '../api.js';

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

const MapView = () => {
  const [devices, setDevices] = useState([]);
  const [geofences, setGeofences] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(false);

  const load = async () => {
    const [deviceData, fenceData] = await Promise.all([getGeoLatest(), getGeofences()]);
    setDevices(deviceData);
    setGeofences(fenceData);
  };

  useEffect(() => {
    load();
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
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

    setForm(emptyForm);
    setEditing(false);
    load();
  };

  const startEdit = (zone) => {
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
    await deleteGeofence(zoneId);
    if (form.zone_id === zoneId) {
      setForm(emptyForm);
      setEditing(false);
    }
    load();
  };

  return (
    <div className="page">
      <MapPanel devices={devices} geofences={geofences} />

      <div className="panel-grid two">
        <div className="card geofence-card">
          <div className="card-header">
            <div>
              <div className="card-title">库区围栏配置</div>
              <div className="card-subtitle">矩形范围 · 进入即归属库区</div>
            </div>
            <button
              className="ghost-button"
              type="button"
              onClick={() => {
                setForm(emptyForm);
                setEditing(false);
              }}
            >
              新建围栏
            </button>
          </div>
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
              <button className="primary-button" type="submit">
                {editing ? '更新围栏' : '保存围栏'}
              </button>
              {editing && (
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => {
                    setForm(emptyForm);
                    setEditing(false);
                  }}
                >
                  取消编辑
                </button>
              )}
            </div>
          </form>
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
                  <button className="ghost-button" onClick={() => startEdit(zone)}>编辑</button>
                  <button className="ghost-button" onClick={() => handleDelete(zone.zone_id)}>删除</button>
                </div>
              </div>
            ))}
            {!geofences.length && <div className="table-empty">暂无围栏配置</div>}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MapView;
