# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Indoor environment telemetry system using a Unitree Go2 robot's SLAM pose data (replacing GPS) combined with DHT11 temperature/humidity sensors, running on a Raspberry Pi 4B. Data is buffered locally in SQLite and uploaded via MQTT (primary) or HTTP (optional) to a backend display system.

The project is transitioning from GPS-based outdoor positioning (`SIM7600GNSS`) to Go2 SLAM-based indoor positioning (`Go2PoseReader`). The core principle: **replace only the positioning source; preserve the existing DHT11, SQLite spool, and MQTT upload pipeline**.

## Current State

- `telemetry_agent.py` — monolithic working script with GPS-based positioning (the baseline being refactored)
- `go2_slam_dev_manual.md` — full development manual with architecture, data models, and task breakdown
- Target deployment: Raspberry Pi 4B (Debian arm64), Python 3.8+

## Target Architecture

```
Go2 (SLAM/pose) → Pi4B → SQLite spool → MQTT/HTTP → Backend display
                    ↑
              DHT11 sensor
```

Target directory structure under `go2_env_agent/`:
- `app/providers/` — `PositionProvider` interface, `go2_pose_sdk.py` (SDK2), `go2_pose_ros2.py` (ROS2), `dht11_reader.py`
- `app/matcher/` — `point_matcher.py` (maps x/y pose to business point IDs via Euclidean distance + radius)
- `app/storage/` — `spool.py` (SQLite offline buffer)
- `app/uploader/` — `mqtt_uploader.py`, `http_uploader.py`
- `app/services/` — `telemetry_service.py` (orchestrates collect→match→buffer→upload loop)
- `app/config/` — `points.yaml` (point definitions with id/x/y/radius), `settings.env`

## Key Design Decisions

- **Position abstraction**: All positioning goes through a `PositionProvider` interface returning `{source, frame, fix, x, y, z, yaw}`
- **Point mapping**: Raw pose coordinates are mapped to business point IDs (e.g., A1, A2) using nearest-point matching with configurable radius. Business logic should never use raw x/y directly.
- **Dwell filtering**: A point is only considered "matched" after the robot stays within radius for N consecutive readings (anti-jitter)
- **Two sampling modes**: timed sampling (every 5s for trajectory) and point-valid sampling (only when dwelling at a point, for reports)
- **Spool-first**: Every telemetry record hits SQLite before upload; delete from spool only after confirmed delivery
- **Preferred positioning mode**: Python SDK2 (lightweight, suits Pi4B). ROS2 is alternative for environments already running it.

## Telemetry Payload Structure

```json
{
  "device_id": "go2_01",
  "ts": 1776403200,
  "temp_c": 26,
  "rh": 61,
  "pose": {"source": "go2_slam", "frame": "map", "fix": true, "x": 12.34, "y": 5.67, "z": 0.02, "yaw": 1.57},
  "area_id": "warehouse_1f",
  "point_id": "A2",
  "errors": []
}
```

## Dependencies

Core: `adafruit-circuitpython-dht`, `board`, `paho-mqtt`, `pyyaml`, `sqlite-utils`, `requests`, `numpy`
Go2 SDK2: `cyclonedds`, `unitree_sdk2_python`

## Environment Variables

Key vars (full list in manual §9.4): `DEVICE_ID`, `DHT_GPIO`, `POSITION_SOURCE`, `GO2_POSE_MODE`, `GO2_NET_IFACE`, `POINTS_FILE`, `MQTT_HOST`, `MQTT_PORT`, `MQTT_TOPIC`, `SPOOL_DB`, `INTERVAL_SEC`

## Deployment

Target runs as a systemd service (`go2-env-agent.service`) under user `pi` at `/opt/go2-env-agent/`. Pi must be on the same network segment as Go2 (for pose data) and have 4G for upstream connectivity.
