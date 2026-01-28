import React, { useEffect, useState } from 'react';
import { getDevices, getSensors } from '../api.js';

const Devices = () => {
  const [devices, setDevices] = useState([]);
  const [sensors, setSensors] = useState([]);

  useEffect(() => {
    const load = async () => {
      const deviceData = await getDevices();
      const sensorData = await getSensors();
      setDevices(deviceData);
      setSensors(sensorData);
    };
    load();
  }, []);

  return (
    <div className="page">
      <div className="panel-grid two">
        <div className="card table-card">
          <div className="card-header">
            <div>
              <div className="card-title">巡检终端</div>
              <div className="card-subtitle">移动采集设备与最新心跳</div>
            </div>
            <button className="ghost-button">登记终端</button>
          </div>
          <div className="table device-table">
            <div className="table-row table-head">
              <span>设备</span>
              <span>状态</span>
              <span>最后心跳</span>
            </div>
            {devices.map((device) => (
              <div key={device.device_id} className="table-row">
                <span className="table-strong">{device.name || device.device_id}</span>
                <span className={`status-pill ${device.status === 'active' ? '' : 'inactive'}`}>
                  {device.status}
                </span>
                <span>{device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : '--'}</span>
              </div>
            ))}
          </div>
          {!devices.length && <div className="table-empty">暂无终端</div>}
        </div>

        <div className="card table-card">
          <div className="card-header">
            <div>
              <div className="card-title">巡检点位</div>
              <div className="card-subtitle">区域归属与采集类型</div>
            </div>
            <button className="ghost-button">新增点位</button>
          </div>
          <div className="table sensor-table">
            <div className="table-row table-head">
              <span>点位</span>
              <span>设备</span>
              <span>区域</span>
            </div>
            {sensors.map((sensor) => (
              <div key={sensor.sensor_id} className="table-row">
                <span className="table-strong">{sensor.sensor_id}</span>
                <span>{sensor.device_id}</span>
                <span>{sensor.zone_id || '--'}</span>
              </div>
            ))}
          </div>
          {!sensors.length && <div className="table-empty">暂无点位</div>}
        </div>
      </div>
    </div>
  );
};

export default Devices;
