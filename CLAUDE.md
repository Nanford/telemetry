# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LeafVault** — a full-stack warehouse temperature/humidity and GPS patrol monitoring platform for tobacco leaf storage. Chinese UI. MQTT ingestion → MySQL → REST API → React dashboard.

## Development Commands

```bash
# Backend (Express, CommonJS)
cd backend
cp .env.example .env   # first time — configure MySQL & MQTT
npm install
npm run dev             # starts API on :8080 + MQTT subscriber

# Frontend (React 18, Vite, ESM)
cd frontend
npm install
npm run dev             # Vite dev server on :5173
npm run build           # production build to dist/
```

### Database

```bash
# Initialize MySQL schema (run once)
mysql -u root < backend/sql/schema.sql
```

Database name: `warehouse_iot`. Additional SQL scripts in `backend/sql/` for geofences and seed data.

## Architecture

### Data Flow

```
IoT Device → MQTT broker → ingest.js (subscribe & parse) → MySQL (telemetry_raw)
                                    ↓
                           evaluateRules() → alerts table
                                    ↓
              React dashboard ← Express REST API ← MySQL
```

### Backend (`backend/src/`)

Single Express server that doubles as MQTT consumer — no separate worker process.

- **index.js** — Express app with all REST routes under `/api/v1/*`. Also calls `startIngest()` at boot.
- **ingest.js** — MQTT subscriber. Parses topic (`devices/{device_id}/[{zone_id}/]telemetry`), resolves zone via GPS geofence lookup, inserts into `telemetry_raw`, then runs the alert rule engine (trigger/recover with configurable duration windows).
- **config.js** — env-based config (MySQL, MQTT). All settings via `.env`.
- **db.js** — mysql2 connection pool. Exports `query(sql, params)` which wraps `pool.execute`.
- **utils.js** — timestamp parsing, MySQL datetime formatting, safe JSON parse.

### Frontend (`frontend/src/`)

- **api.js** — all API calls. Every getter has a try/catch that falls back to mock data (`data/mock.js`) when the backend is unreachable. API base URL configurable via `VITE_API_BASE` env var.
- **App.jsx** — SPA shell with sidebar nav (react-router-dom v6). Routes: `/` Overview, `/zones` ZoneDetail, `/map` MapView, `/alerts` Alerts, `/rules` Rules, `/devices` Devices.
- **pages/** — one page component per route.
- **components/** — shared: `StatCard`, `ZoneCard`, `TrendChart` (recharts), `MapPanel` (react-leaflet).

### Key Database Tables

- `telemetry_raw` — every MQTT reading (temp, humidity, GPS). Indexed by sensor+ts, zone+ts, device+ts.
- `telemetry_hourly` — pre-aggregated hourly stats. Trend API falls back to raw-table aggregation if this is empty.
- `alert_rules` — threshold config per zone or sensor, with trigger/recover duration windows.
- `alerts` — alert instances (open → acked → closed lifecycle).
- `zone_geofences` — rectangular GPS boundaries; ingest uses these for automatic zone assignment.

## Important Conventions

- All timestamps stored in UTC. MySQL pool timezone is `'Z'`.
- MQTT topic parsing supports both `devices/{id}/telemetry` and `devices/{id}/{zone}/telemetry`.
- Frontend mock fallback is automatic — no flag needed. If `fetch` throws, mock data is returned.
- No test suite or linter is configured.
- Backend uses CommonJS (`require`); frontend uses ESM (`import`).
