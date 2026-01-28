import React from 'react';

const StatCard = ({ label, value, unit, note }) => (
  <div className="card stat-card">
    <div className="stat-label">{label}</div>
    <div className="stat-value">
      <span>{value}</span>
      <span className="stat-unit">{unit}</span>
    </div>
    <div className="stat-note">{note}</div>
  </div>
);

export default StatCard;
