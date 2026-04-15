import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import Overview from './pages/Overview.jsx';
import ZoneDetail from './pages/ZoneDetail.jsx';
import MapView from './pages/MapView.jsx';
import Alerts from './pages/Alerts.jsx';
import Rules from './pages/Rules.jsx';
import Devices from './pages/Devices.jsx';
import { onConnectionChange, isUsingMock } from './api.js';

const navItems = [
  { to: '/', label: '库区总览', icon: '◎' },
  { to: '/zones', label: '区域趋势', icon: '◍' },
  { to: '/map', label: '巡检地图', icon: '⟡' },
  { to: '/alerts', label: '告警中心', icon: '⬡' },
  { to: '/rules', label: '阈值规则', icon: '⟠' },
  { to: '/devices', label: '采集终端', icon: '◌' }
];

const AppShell = () => {
  const [isMock, setIsMock] = useState(isUsingMock());
  useEffect(() => onConnectionChange(setIsMock), []);

  return (
  <div className="app">
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <span className="brand-pulse" />
        </div>
        <div>
          <div className="brand-title">LeafVault</div>
          <div className="brand-subtitle">烟叶原料库温湿度与巡检监控</div>
        </div>
      </div>
      <nav className="nav">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `nav-item ${isActive ? 'active' : ''}`
            }
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="signal">
          <span className={`signal-dot ${isMock ? 'signal-dot-warn' : ''}`} />
          <div>
            <div className="signal-title">{isMock ? '模拟数据' : '数据链路'}</div>
            <div className="signal-subtitle">{isMock ? 'API 不可用' : 'MQTT · REST'}</div>
          </div>
        </div>
        <div className="sidebar-note">v1.0 · Telemetry Console</div>
      </div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div>
          <div className="topbar-title">烟叶库区实时态势</div>
          <div className="topbar-subtitle">最后同步 · <span className="topbar-time">{new Date().toLocaleString()}</span></div>
        </div>
        <div className="topbar-actions">
          <button className="ghost-button">导出巡检报告</button>
          <NavLink className="primary-button link-button" to="/rules">
            新建阈值
          </NavLink>
        </div>
      </header>
      <section className="content">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/zones" element={<ZoneDetail />} />
          <Route path="/map" element={<MapView />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/devices" element={<Devices />} />
        </Routes>
      </section>
    </main>
  </div>
  );
};

const App = () => (
  <BrowserRouter>
    <AppShell />
  </BrowserRouter>
);

export default App;
