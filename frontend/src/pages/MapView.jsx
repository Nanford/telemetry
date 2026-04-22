import React, { useState } from 'react';
import GpsMapTab from '../components/GpsMapTab.jsx';
import SlamMapTab from '../components/SlamMapTab.jsx';

const tabs = [
  { key: 'slam', label: 'SLAM 室内定位' },
  { key: 'gps', label: 'GPS 户外巡检' }
];

const MapView = () => {
  const [activeTab, setActiveTab] = useState('slam');

  return (
    <div className="page">
      <div className="mode-switch" style={{ marginBottom: '1rem' }}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`chip ${activeTab === tab.key ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab === 'gps' ? <GpsMapTab /> : <SlamMapTab />}
    </div>
  );
};

export default MapView;
