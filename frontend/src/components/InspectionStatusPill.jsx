import React from 'react';
import { getInspectionStatusMeta } from '../lib/inspection.js';

const InspectionStatusPill = ({ status }) => {
  const meta = getInspectionStatusMeta(status);
  return <span className={`status-pill ${meta.className}`}>{meta.label}</span>;
};

export default InspectionStatusPill;
