import {
  mockOverview,
  mockTrend,
  mockAlerts,
  mockRules,
  mockGeoLatest,
  mockGeofences,
  mockDevices,
  mockZones,
  mockSensors
} from './data/mock.js';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8080/api/v1';

const fetchJson = async (path, options = {}) => {
  const response = await fetch(`${API_BASE}/${path}`, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await response.json();
  return payload.data ?? payload;
};

export const getOverview = async () => {
  try {
    return await fetchJson('overview');
  } catch {
    return mockOverview;
  }
};

export const getTrend = async (params) => {
  const query = new URLSearchParams(params).toString();
  try {
    return await fetchJson(`telemetry/trend?${query}`);
  } catch {
    return mockTrend;
  }
};

export const getAlerts = async () => {
  try {
    return await fetchJson('alerts');
  } catch {
    return mockAlerts;
  }
};

export const getRules = async () => {
  try {
    return await fetchJson('alert-rules');
  } catch {
    return mockRules;
  }
};

export const createRule = async (payload) => {
  return fetchJson('alert-rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
};

export const updateRule = async (id, payload) => {
  return fetchJson(`alert-rules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
};

export const deleteRule = async (id) => {
  return fetchJson(`alert-rules/${id}`, {
    method: 'DELETE'
  });
};

export const getGeoLatest = async () => {
  try {
    return await fetchJson('geo/latest');
  } catch {
    return mockGeoLatest;
  }
};

export const getGeofences = async () => {
  try {
    return await fetchJson('geofences');
  } catch {
    return mockGeofences;
  }
};

export const saveGeofence = async (payload) => {
  return fetchJson('geofences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
};

export const updateGeofence = async (zoneId, payload) => {
  return fetchJson(`geofences/${zoneId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
};

export const deleteGeofence = async (zoneId) => {
  return fetchJson(`geofences/${zoneId}`, {
    method: 'DELETE'
  });
};

export const getDevices = async () => {
  try {
    return await fetchJson('devices');
  } catch {
    return mockDevices;
  }
};

export const getZones = async () => {
  try {
    return await fetchJson('zones');
  } catch {
    return mockZones;
  }
};

export const getSensors = async () => {
  try {
    return await fetchJson('sensors');
  } catch {
    return mockSensors;
  }
};
