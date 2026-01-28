import React, { useEffect, useState } from 'react';
import { getRules, createRule, updateRule, deleteRule, getZones, getSensors } from '../api.js';

const emptyForm = {
  name: '',
  scope_type: 'zone',
  zone_id: '',
  sensor_id: '',
  temp_high: '',
  temp_low: '',
  rh_high: '',
  rh_low: '',
  trigger_duration_sec: 60,
  recover_duration_sec: 60,
  enabled: true
};

const Rules = () => {
  const [rules, setRules] = useState([]);
  const [zones, setZones] = useState([]);
  const [sensors, setSensors] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [actionId, setActionId] = useState(null);

  const isEditing = editingId !== null;

  const toNumberOrNull = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const toInt = (value, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  };

  const toEnabled = (value, fallback = true) => {
    if (value === '' || value === null || value === undefined) return fallback;
    const num = Number(value);
    if (Number.isFinite(num)) return num === 1;
    if (typeof value === 'boolean') return value;
    return Boolean(value);
  };

  const buildPayloadFromRule = (rule, overrides = {}) => {
    const scope = overrides.scope_type ?? rule.scope_type ?? 'zone';
    const zoneId = overrides.zone_id ?? rule.zone_id ?? null;
    const sensorId = overrides.sensor_id ?? rule.sensor_id ?? null;

    return {
      name: overrides.name ?? rule.name ?? '',
      scope_type: scope,
      zone_id: scope === 'zone' ? zoneId : null,
      sensor_id: scope === 'sensor' ? sensorId : null,
      temp_high: toNumberOrNull(overrides.temp_high ?? rule.temp_high),
      temp_low: toNumberOrNull(overrides.temp_low ?? rule.temp_low),
      rh_high: toNumberOrNull(overrides.rh_high ?? rule.rh_high),
      rh_low: toNumberOrNull(overrides.rh_low ?? rule.rh_low),
      trigger_duration_sec: toInt(overrides.trigger_duration_sec ?? rule.trigger_duration_sec, 60),
      recover_duration_sec: toInt(overrides.recover_duration_sec ?? rule.recover_duration_sec, 60),
      enabled: toEnabled(overrides.enabled ?? rule.enabled) ? 1 : 0
    };
  };

  const load = async () => {
    const [ruleData, zoneData, sensorData] = await Promise.all([getRules(), getZones(), getSensors()]);
    setRules(ruleData);
    setZones(zoneData);
    setSensors(sensorData);
    if (!form.zone_id && zoneData.length) {
      setForm((prev) => ({ ...prev, zone_id: zoneData[0].zone_id }));
    }
    if (!form.sensor_id && sensorData.length) {
      setForm((prev) => ({ ...prev, sensor_id: sensorData[0].sensor_id }));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const resetForm = () => {
    setForm((prev) => ({
      ...emptyForm,
      zone_id: prev.zone_id,
      sensor_id: prev.sensor_id
    }));
  };

  const startEdit = (rule) => {
    setEditingId(rule.id);
    setForm({
      name: rule.name || '',
      scope_type: rule.scope_type || 'zone',
      zone_id: rule.zone_id || form.zone_id,
      sensor_id: rule.sensor_id || form.sensor_id,
      temp_high: rule.temp_high ?? '',
      temp_low: rule.temp_low ?? '',
      rh_high: rule.rh_high ?? '',
      rh_low: rule.rh_low ?? '',
      trigger_duration_sec: rule.trigger_duration_sec ?? 60,
      recover_duration_sec: rule.recover_duration_sec ?? 60,
      enabled: toEnabled(rule.enabled)
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    resetForm();
  };

  const startCopy = (rule) => {
    setEditingId(null);
    setForm({
      name: rule.name ? `${rule.name}（复制）` : '规则复制',
      scope_type: rule.scope_type || 'zone',
      zone_id: rule.zone_id || form.zone_id,
      sensor_id: rule.sensor_id || form.sensor_id,
      temp_high: rule.temp_high ?? '',
      temp_low: rule.temp_low ?? '',
      rh_high: rule.rh_high ?? '',
      rh_low: rule.rh_low ?? '',
      trigger_duration_sec: rule.trigger_duration_sec ?? 60,
      recover_duration_sec: rule.recover_duration_sec ?? 60,
      enabled: toEnabled(rule.enabled)
    });
  };

  const handleToggleEnabled = async (rule) => {
    if (actionId) return;
    setActionId(rule.id);
    try {
      const payload = buildPayloadFromRule(rule, { enabled: !toEnabled(rule.enabled) });
      await updateRule(rule.id, payload);
      await load();
      if (editingId === rule.id) {
        startEdit({ ...rule, ...payload, enabled: payload.enabled });
      }
    } finally {
      setActionId(null);
    }
  };

  const handleDelete = async (rule) => {
    if (actionId) return;
    const ok = window.confirm(`确认删除规则「${rule.name || rule.id}」？`);
    if (!ok) return;
    setActionId(rule.id);
    try {
      await deleteRule(rule.id);
      if (editingId === rule.id) cancelEdit();
      await load();
    } finally {
      setActionId(null);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);

    const payload = {
      name: form.name,
      scope_type: form.scope_type,
      zone_id: form.scope_type === 'zone' ? form.zone_id : null,
      sensor_id: form.scope_type === 'sensor' ? form.sensor_id : null,
      temp_high: toNumberOrNull(form.temp_high),
      temp_low: toNumberOrNull(form.temp_low),
      rh_high: toNumberOrNull(form.rh_high),
      rh_low: toNumberOrNull(form.rh_low),
      trigger_duration_sec: toInt(form.trigger_duration_sec || 60, 60),
      recover_duration_sec: toInt(form.recover_duration_sec || 60, 60),
      enabled: form.enabled ? 1 : 0
    };

    if (isEditing) {
      await updateRule(editingId, payload);
      setEditingId(null);
    } else {
      await createRule(payload);
    }

    resetForm();
    setSaving(false);
    load();
  };

  return (
    <div className="page">
      <div className="card rule-form">
        <div className="card-header">
          <div>
            <div className="card-title">{isEditing ? '编辑阈值规则' : '新建阈值规则'}</div>
            <div className="card-subtitle">用于烟叶库区温湿度稳定控制</div>
          </div>
          {isEditing && (
            <button className="ghost-button" type="button" onClick={cancelEdit}>
              取消编辑
            </button>
          )}
        </div>
        <form className="rule-form-body" onSubmit={handleSubmit}>
          <div className="form-row">
            <label>
              规则名称
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="原料区温湿度控制"
                required
              />
            </label>
            <label>
              作用范围
              <select
                className="select"
                value={form.scope_type}
                onChange={(e) => {
                  const scope = e.target.value;
                  setForm((prev) => ({
                    ...prev,
                    scope_type: scope,
                    zone_id: scope === 'zone' ? prev.zone_id || zones[0]?.zone_id || '' : prev.zone_id,
                    sensor_id: scope === 'sensor' ? prev.sensor_id || sensors[0]?.sensor_id || '' : prev.sensor_id
                  }));
                }}
              >
                <option value="zone">按区域</option>
                <option value="sensor">按传感器</option>
              </select>
            </label>
          </div>

          {form.scope_type === 'zone' ? (
            <label>
              选择区域
              <select
                className="select"
                value={form.zone_id}
                onChange={(e) => setForm({ ...form, zone_id: e.target.value })}
                required
              >
                {zones.map((zone) => (
                  <option key={zone.zone_id} value={zone.zone_id}>
                    {zone.name || zone.zone_id}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              选择传感器
              <select
                className="select"
                value={form.sensor_id}
                onChange={(e) => setForm({ ...form, sensor_id: e.target.value })}
                required
              >
                {sensors.map((sensor) => (
                  <option key={sensor.sensor_id} value={sensor.sensor_id}>
                    {sensor.sensor_id}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="form-row">
            <label>
              温度下限 (℃)
              <input
                type="number"
                step="0.1"
                value={form.temp_low}
                onChange={(e) => setForm({ ...form, temp_low: e.target.value })}
              />
            </label>
            <label>
              温度上限 (℃)
              <input
                type="number"
                step="0.1"
                value={form.temp_high}
                onChange={(e) => setForm({ ...form, temp_high: e.target.value })}
              />
            </label>
          </div>

          <div className="form-row">
            <label>
              湿度下限 (%)
              <input
                type="number"
                step="1"
                value={form.rh_low}
                onChange={(e) => setForm({ ...form, rh_low: e.target.value })}
              />
            </label>
            <label>
              湿度上限 (%)
              <input
                type="number"
                step="1"
                value={form.rh_high}
                onChange={(e) => setForm({ ...form, rh_high: e.target.value })}
              />
            </label>
          </div>

          <div className="form-row">
            <label>
              触发持续 (秒)
              <input
                type="number"
                value={form.trigger_duration_sec}
                onChange={(e) => setForm({ ...form, trigger_duration_sec: e.target.value })}
              />
            </label>
            <label>
              恢复持续 (秒)
              <input
                type="number"
                value={form.recover_duration_sec}
                onChange={(e) => setForm({ ...form, recover_duration_sec: e.target.value })}
              />
            </label>
          </div>

          <label className="toggle">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <span>启用规则</span>
          </label>

          <div className="form-actions">
            <button className="primary-button" type="submit" disabled={saving}>
              {saving ? '保存中...' : isEditing ? '更新规则' : '保存规则'}
            </button>
          </div>
        </form>
      </div>

      <div className="panel-grid two">
        {rules.map((rule) => {
          const enabled = toEnabled(rule.enabled);
          return (
            <div key={rule.id} className="card rule-card">
              <div className="rule-header">
                <div>
                  <div className="rule-title">{rule.name}</div>
                  <div className="rule-subtitle">
                    {rule.scope_type === 'zone' ? `区域 ${rule.zone_id}` : `传感器 ${rule.sensor_id}`}
                  </div>
                </div>
                <span className={`status-pill ${enabled ? '' : 'inactive'}`}>
                  {enabled ? '启用' : '停用'}
                </span>
              </div>
              <div className="rule-body">
                <div>
                  <div className="rule-label">温度</div>
                  <div className="rule-value">
                    {rule.temp_low ?? '--'}°C ~ {rule.temp_high ?? '--'}°C
                  </div>
                </div>
                <div>
                  <div className="rule-label">湿度</div>
                  <div className="rule-value">
                    {rule.rh_low ?? '--'}% ~ {rule.rh_high ?? '--'}%
                  </div>
                </div>
                <div>
                  <div className="rule-label">触发持续</div>
                  <div className="rule-value">{rule.trigger_duration_sec}s</div>
                </div>
                <div>
                  <div className="rule-label">恢复持续</div>
                  <div className="rule-value">{rule.recover_duration_sec}s</div>
                </div>
              </div>
              <div className="rule-actions">
                <button className="ghost-button" onClick={() => startEdit(rule)} disabled={actionId === rule.id}>
                  编辑
                </button>
                <button className="ghost-button" onClick={() => startCopy(rule)} disabled={actionId === rule.id}>
                  复制
                </button>
                <button
                  className="ghost-button"
                  onClick={() => handleToggleEnabled(rule)}
                  disabled={actionId === rule.id}
                >
                  {enabled ? '停用' : '启用'}
                </button>
                <button
                  className="ghost-button danger"
                  onClick={() => handleDelete(rule)}
                  disabled={actionId === rule.id}
                >
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {!rules.length && <div className="empty-state">暂无规则，请先新建。</div>}
    </div>
  );
};

export default Rules;
