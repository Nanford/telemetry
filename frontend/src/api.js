import {
  mockOverview,
  mockTrend,
  mockAlerts,
  mockRules,
  mockGeoLatest,
  mockGeofences,
  mockDevices,
  mockZones,
  mockSensors,
  mockInsights,
  mockHealth
} from './data/mock.js';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8080/api/v1';

/** Tracks whether the last fetch hit the real API or fell back to mock */
let _lastFetchWasMock = false;
const listeners = new Set();

export const onConnectionChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const isUsingMock = () => _lastFetchWasMock;

const notify = (isMock) => {
  if (_lastFetchWasMock !== isMock) {
    _lastFetchWasMock = isMock;
    listeners.forEach((fn) => fn(isMock));
  }
};

const fetchJson = async (path, options = {}) => {
  const response = await fetch(`${API_BASE}/${path}`, {
    ...options,
    signal: options.signal
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  notify(false);
  return payload.data ?? payload;
};

const withMockFallback = (fetcher, mockData) => {
  return async (params, options) => {
    try {
      return await fetcher(params, options);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      notify(true);
      return mockData;
    }
  };
};

export const getOverview = withMockFallback(
  (_, opts) => fetchJson('overview', opts),
  mockOverview
);

export const getTrend = withMockFallback(
  (params, opts) => {
    const query = new URLSearchParams(params).toString();
    return fetchJson(`telemetry/trend?${query}`, opts);
  },
  mockTrend
);

export const getAlerts = withMockFallback(
  (_, opts) => fetchJson('alerts', opts),
  mockAlerts
);

export const getRules = withMockFallback(
  (_, opts) => fetchJson('alert-rules', opts),
  mockRules
);

export const createRule = (payload) =>
  fetchJson('alert-rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

export const updateRule = (id, payload) =>
  fetchJson(`alert-rules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

export const deleteRule = (id) =>
  fetchJson(`alert-rules/${id}`, { method: 'DELETE' });

export const getGeoLatest = withMockFallback(
  (_, opts) => fetchJson('geo/latest', opts),
  mockGeoLatest
);

export const getGeofences = withMockFallback(
  (_, opts) => fetchJson('geofences', opts),
  mockGeofences
);

export const saveGeofence = (payload) =>
  fetchJson('geofences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

export const updateGeofence = (zoneId, payload) =>
  fetchJson(`geofences/${zoneId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

export const deleteGeofence = (zoneId) =>
  fetchJson(`geofences/${zoneId}`, { method: 'DELETE' });

export const autoInitGeofences = (payload = {}) =>
  fetchJson('geofences/auto-init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

export const getDevices = withMockFallback(
  (_, opts) => fetchJson('devices', opts),
  mockDevices
);

export const getZones = withMockFallback(
  (_, opts) => fetchJson('zones', opts),
  mockZones
);

export const getSensors = withMockFallback(
  (_, opts) => fetchJson('sensors', opts),
  mockSensors
);

export const getInsights = withMockFallback(
  (_, opts) => fetchJson('insights', opts),
  mockInsights
);

export const getHealthSummary = withMockFallback(
  (_, opts) => fetchJson('health-summary', opts),
  mockHealth
);
