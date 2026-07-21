#!/usr/bin/env python3
"""
Publish simulated Go2 SLAM pose and temperature/humidity telemetry to MQTT.

The payload mirrors the terminal-side go2_env_agent format consumed by
backend/src/ingest.js:

    devices/{device_id}/telemetry
    {
      "device_id": "Go2",
      "ts": 1782450000,
      "temp_c": 31.2,
      "rh": 62.4,
      "zone_id": "A1",
      "area_id": "warehouse_1f",
      "gps": {"fix": false, "lat": null, "lon": null, "fallback": false},
      "pose": {"source": "go2_slam", "frame": "map", "fix": true, ...},
      "point_id": "A1",
      "sample_type": "point_valid",
      "errors": []
    }
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import signal
import socket
import ssl
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import unquote, urlparse


TEMP_HIGH_LIMIT = 32.0
RH_HIGH_LIMIT = 65.0
DEFAULT_MQTT_URL = "mqtt://127.0.0.1:1883"
DEFAULT_MQTT_USERNAME = None
DEFAULT_MQTT_PASSWORD = None

# A-1-2 库房 23 垛位，按巡检顺序排列(上排东→西 → 下排西→东)，使仿真轨迹呈弓字形。
# zone_id 统一 A-1-2(按房间分组)，point_id 为垛位；坐标同 app/config/points.A-1-2.yaml(示意值)。
_A12_ROUTE = [
    # (垛号, x, y)  —— 上排(北) y=11，东→西
    (18, 30.0, 11), (17, 27.5, 11), (16, 25.0, 11), (15, 22.5, 11), (14, 20.0, 11), (13, 17.5, 11),
    (12, 15.0, 11), (11, 12.5, 11), (10, 10.0, 11), (9, 7.5, 11), (8, 5.0, 11), (7, 2.5, 11),
    # 下排(南) y=9，西→东（y9~11 之间为中央走道）
    (6, 2.5, 9), (5, 5.0, 9), (4, 7.5, 9), (3, 10.0, 9), (2, 12.5, 9), (1, 15.0, 9),
    (23, 20.0, 9), (22, 22.5, 9), (21, 25.0, 9), (20, 27.5, 9), (19, 30.0, 9),
]
# 温湿度基线沿巡检顺序做轻微梯度(均在告警阈值 32°C/65% 以下)，让各垛位读数有差异。
POINTS = [
    {
        "id": f"A-1-2-{bay:02d}", "zone_id": "A-1-2", "x": x, "y": y, "radius": 0.9,
        "temp": round(28.8 + 0.06 * i, 1), "rh": round(60.0 + 0.08 * i, 1),
    }
    for i, (bay, x, y) in enumerate(_A12_ROUTE)
]


def load_env_file(path: Optional[Path]) -> None:
    if not path or not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def find_default_env_file() -> Path:
    cwd_candidate = Path.cwd() / "backend" / ".env"
    if cwd_candidate.exists():
        return cwd_candidate

    for parent in Path(__file__).resolve().parents:
        candidate = parent / "backend" / ".env"
        if candidate.exists():
            return candidate

    return cwd_candidate


def current_unix_ts() -> int:
    # Backend ingest treats second-level Unix timestamps as real-time device time.
    return int(time.time())


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def round_or_none(value: Optional[float], digits: int = 3) -> Optional[float]:
    if value is None:
        return None
    return round(value, digits)


@dataclass
class PointMatch:
    zone_id: Optional[str]
    point_id: Optional[str]
    sample_type: str
    nearest_point: Dict[str, Any]


class PatrolMotion:
    def __init__(self, speed_mps: float, dwell_sec: float, rng: random.Random):
        self.speed_mps = speed_mps
        self.dwell_sec = dwell_sec
        self.rng = rng
        self.route = list(range(len(POINTS))) + list(range(len(POINTS) - 2, 0, -1))
        self.route_index = 0
        self.x = float(POINTS[0]["x"])
        self.y = float(POINTS[0]["y"])
        self.z = 0.32
        self.yaw = 0.0
        self.dwell_elapsed = 0.0

    def step(self, dt: float) -> Dict[str, float]:
        target = POINTS[self.route[self.route_index % len(self.route)]]
        dx = float(target["x"]) - self.x
        dy = float(target["y"]) - self.y
        dist = math.hypot(dx, dy)

        if dist <= 0.03:
            self.x = float(target["x"])
            self.y = float(target["y"])
            self.dwell_elapsed += dt
            if self.dwell_elapsed >= self.dwell_sec:
                self.route_index += 1
                self.dwell_elapsed = 0.0
        else:
            step_dist = min(self.speed_mps * dt, dist)
            self.x += dx / dist * step_dist
            self.y += dy / dist * step_dist
            self.yaw = math.atan2(dy, dx)

        # Small SLAM jitter makes the trail look closer to a real terminal feed.
        return {
            "x": self.x + self.rng.gauss(0, 0.015),
            "y": self.y + self.rng.gauss(0, 0.015),
            "z": self.z,
            "yaw": self.yaw + self.rng.gauss(0, 0.01),
        }


class UdpPoseReceiver:
    def __init__(self, host: str, port: int, stale_sec: float):
        self.stale_sec = stale_sec
        self._latest_pose: Optional[Dict[str, float]] = None
        self._latest_at = 0.0
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._socket.bind((host, port))
        self._socket.settimeout(0.05)

    def close(self) -> None:
        self._socket.close()

    def read_pose(self, timeout_sec: float) -> Dict[str, float]:
        deadline = time.monotonic() + max(0.1, timeout_sec)
        while time.monotonic() < deadline:
            try:
                data, _addr = self._socket.recvfrom(4096)
            except socket.timeout:
                if self._latest_pose and time.monotonic() - self._latest_at <= self.stale_sec:
                    return self._latest_pose
                continue

            pose = self._parse_payload(data)
            if pose:
                self._latest_pose = pose
                self._latest_at = time.monotonic()

        if self._latest_pose and time.monotonic() - self._latest_at <= self.stale_sec:
            return self._latest_pose
        raise TimeoutError("No fresh UDP pose received from sim_go2_dog.py")

    @staticmethod
    def _parse_payload(data: bytes) -> Optional[Dict[str, float]]:
        try:
            payload = json.loads(data.decode("utf-8"))
            position = payload.get("position") or []
            imu_rpy = payload.get("imu_rpy") or []
            return {
                "x": float(position[0]),
                "y": float(position[1]),
                "z": float(position[2]) if len(position) > 2 else 0.32,
                "yaw": float(imu_rpy[2]) if len(imu_rpy) > 2 else 0.0,
            }
        except (ValueError, TypeError, IndexError, json.JSONDecodeError):
            return None


class PointMatcher:
    def __init__(self, dwell_count: int):
        self.dwell_count = max(1, dwell_count)
        self._active_point_id: Optional[str] = None
        self._active_count = 0

    def match(self, x: float, y: float) -> PointMatch:
        nearest = min(POINTS, key=lambda p: math.hypot(float(p["x"]) - x, float(p["y"]) - y))
        distance = math.hypot(float(nearest["x"]) - x, float(nearest["y"]) - y)
        if distance > float(nearest["radius"]):
            self._active_point_id = None
            self._active_count = 0
            return PointMatch(zone_id=None, point_id=None, sample_type="timed", nearest_point=nearest)

        point_id = str(nearest["id"])
        if point_id == self._active_point_id:
            self._active_count += 1
        else:
            self._active_point_id = point_id
            self._active_count = 1

        sample_type = "point_valid" if self._active_count >= self.dwell_count else "timed"
        return PointMatch(
            zone_id=str(nearest["zone_id"]),
            point_id=point_id,
            sample_type=sample_type,
            nearest_point=nearest,
        )


class EnvironmentSimulator:
    def __init__(
        self,
        rng: random.Random,
        interval_sec: float,
        anomaly_rate: float,
        anomaly_min_sec: float,
        anomaly_max_sec: float,
        first_anomaly_after_sec: float,
    ):
        self.rng = rng
        self.interval_sec = max(0.1, interval_sec)
        self.anomaly_rate = clamp(anomaly_rate, 0.0, 1.0)
        self.anomaly_min_sec = max(interval_sec, anomaly_min_sec)
        self.anomaly_max_sec = max(self.anomaly_min_sec, anomaly_max_sec)
        self.first_anomaly_after_sec = first_anomaly_after_sec
        self._anomaly_samples_left = 0
        self._anomaly_kind = "none"
        self._sample_count = 0
        self._first_anomaly_started = False

    def _start_anomaly(self, kind: Optional[str] = None) -> None:
        duration = self.rng.uniform(self.anomaly_min_sec, self.anomaly_max_sec)
        self._anomaly_samples_left = max(1, int(round(duration / self.interval_sec)))
        self._anomaly_kind = kind or self.rng.choices(
            population=["temp", "temp", "temp_rh", "rh"],
            weights=[0.55, 0.2, 0.2, 0.05],
            k=1,
        )[0]

    def _maybe_start_anomaly(self) -> None:
        if self._anomaly_samples_left > 0:
            return

        elapsed = self._sample_count * self.interval_sec
        if (
            self.first_anomaly_after_sec >= 0
            and not self._first_anomaly_started
            and elapsed >= self.first_anomaly_after_sec
        ):
            self._first_anomaly_started = True
            self._start_anomaly(kind="temp_rh")
            return

        if self.rng.random() < self.anomaly_rate:
            self._start_anomaly()

    def read(self, point: Dict[str, Any]) -> Dict[str, Any]:
        self._maybe_start_anomaly()

        day_wave = math.sin(time.time() / 300.0) * 0.35
        temp_c = float(point["temp"]) + day_wave + self.rng.gauss(0, 0.18)
        rh = float(point["rh"]) - day_wave * 0.8 + self.rng.gauss(0, 0.45)
        anomaly = None

        if self._anomaly_samples_left > 0:
            anomaly = self._anomaly_kind
            self._anomaly_samples_left -= 1
            if self._anomaly_kind in ("temp", "temp_rh"):
                temp_c = self.rng.uniform(TEMP_HIGH_LIMIT + 0.3, TEMP_HIGH_LIMIT + 2.8)
            if self._anomaly_kind in ("rh", "temp_rh"):
                rh = self.rng.uniform(RH_HIGH_LIMIT + 0.5, RH_HIGH_LIMIT + 6.5)

        # Normal summer warehouse samples stay below the configured upper limits.
        if anomaly not in ("temp", "temp_rh"):
            temp_c = min(temp_c, TEMP_HIGH_LIMIT - self.rng.uniform(0.2, 0.8))
        if anomaly not in ("rh", "temp_rh"):
            rh = min(rh, RH_HIGH_LIMIT - self.rng.uniform(0.3, 1.2))

        self._sample_count += 1
        return {
            "temp_c": round(temp_c, 1),
            "rh": round(rh, 1),
            "anomaly": anomaly,
        }


@dataclass
class MqttConfig:
    host: str
    port: int
    username: Optional[str]
    password: Optional[str]
    tls: bool


def parse_mqtt_url(url: str, username: Optional[str], password: Optional[str]) -> MqttConfig:
    if "://" not in url:
        url = f"mqtt://{url}"
    parsed = urlparse(url)
    scheme = parsed.scheme.lower() or "mqtt"
    host = parsed.hostname
    if not host:
        raise ValueError(f"Invalid MQTT URL: {url}")

    tls = scheme in ("mqtts", "ssl", "tls")
    port = parsed.port or (8883 if tls else 1883)
    parsed_username = unquote(parsed.username) if parsed.username else None
    parsed_password = unquote(parsed.password) if parsed.password else None
    return MqttConfig(
        host=host,
        port=port,
        username=username if username is not None else parsed_username,
        password=password if password is not None else parsed_password,
        tls=tls,
    )


class MqttPublisher:
    def __init__(self, cfg: MqttConfig, client_id: str, status_topic: str, qos: int):
        try:
            import paho.mqtt.client as mqtt
        except ImportError as exc:
            raise SystemExit(
                "Missing dependency: paho-mqtt. Install it with `pip install paho-mqtt`."
            ) from exc

        self._mqtt = mqtt
        self._client = mqtt.Client(client_id=client_id, clean_session=True)
        self._status_topic = status_topic
        self._qos = qos

        if cfg.username:
            self._client.username_pw_set(cfg.username, cfg.password or "")
        if cfg.tls:
            self._client.tls_set(cert_reqs=ssl.CERT_REQUIRED)

        self._client.will_set(status_topic, payload="offline", qos=1, retain=True)
        self._client.connect(cfg.host, cfg.port, keepalive=60)
        self._client.loop_start()
        self.publish_status("online")

    def publish_status(self, status: str) -> None:
        info = self._client.publish(self._status_topic, payload=status, qos=1, retain=True)
        info.wait_for_publish()

    def publish_json(self, topic: str, payload: Dict[str, Any]) -> None:
        message = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        info = self._client.publish(topic, payload=message, qos=self._qos, retain=False)
        info.wait_for_publish()
        if info.rc != self._mqtt.MQTT_ERR_SUCCESS:
            raise RuntimeError(f"MQTT publish failed with rc={info.rc}")

    def close(self) -> None:
        try:
            self.publish_status("offline")
        finally:
            self._client.loop_stop()
            self._client.disconnect()


def build_payload(
    device_id: str,
    area_id: str,
    ts: int,
    pose: Dict[str, float],
    match: PointMatch,
    env: Dict[str, Any],
) -> Dict[str, Any]:
    return {
        "device_id": device_id,
        "ts": ts,
        "temp_c": env["temp_c"],
        "rh": env["rh"],
        "zone_id": match.zone_id,
        "area_id": area_id,
        "gps": {"fix": False, "lat": None, "lon": None, "fallback": False},
        "pose": {
            "source": "go2_slam",
            "frame": "map",
            "fix": True,
            "x": round_or_none(pose["x"]),
            "y": round_or_none(pose["y"]),
            "z": round_or_none(pose["z"]),
            "yaw": round_or_none(pose["yaw"]),
        },
        "point_id": match.point_id,
        "sample_type": match.sample_type,
        "errors": [],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Simulate Go2 terminal telemetry and publish it to the telemetry MQTT broker."
    )
    parser.add_argument("--device-id", default="Go2", help="Device id reported in MQTT payloads.")
    parser.add_argument("--area-id", default="warehouse_1f", help="SLAM area id.")
    parser.add_argument("--mqtt-url", default=None, help=f"MQTT URL. Defaults to MQTT_URL env or {DEFAULT_MQTT_URL}.")
    parser.add_argument("--username", default=None, help="MQTT username. Defaults to MQTT_USERNAME env.")
    parser.add_argument("--password", default=None, help="MQTT password. Defaults to MQTT_PASSWORD env.")
    parser.add_argument(
        "--topic-template",
        default="devices/{device_id}/telemetry",
        help="MQTT topic template. Supports {device_id} and {zone_id}.",
    )
    parser.add_argument("--status-topic", default=None, help="MQTT status topic.")
    parser.add_argument("--qos", type=int, choices=[0, 1, 2], default=1, help="MQTT publish QoS.")
    parser.add_argument(
        "--pose-source",
        choices=["internal", "udp"],
        default="internal",
        help="internal uses this script's patrol path; udp listens to debug/sim_go2_dog.py.",
    )
    parser.add_argument("--udp-host", default="127.0.0.1", help="UDP bind host for --pose-source udp.")
    parser.add_argument("--udp-port", type=int, default=9870, help="UDP bind port for --pose-source udp.")
    parser.add_argument("--pose-stale-sec", type=float, default=3.0, help="Maximum age of reused UDP pose.")
    parser.add_argument("--interval", type=float, default=2.0, help="Telemetry publish interval in seconds.")
    parser.add_argument("--speed", type=float, default=0.8, help="Patrol movement speed in meters per second.")
    parser.add_argument("--dwell", type=float, default=8.0, help="Seconds to stay near each checkpoint.")
    parser.add_argument("--dwell-count", type=int, default=3, help="Samples required before point_valid.")
    parser.add_argument(
        "--anomaly-rate",
        type=float,
        default=0.01,
        help="Probability of starting an abnormal burst on each sample.",
    )
    parser.add_argument("--anomaly-min-sec", type=float, default=35.0, help="Minimum abnormal burst duration.")
    parser.add_argument("--anomaly-max-sec", type=float, default=60.0, help="Maximum abnormal burst duration.")
    parser.add_argument(
        "--first-anomaly-after",
        type=float,
        default=20.0,
        help="Seconds before the first guaranteed abnormal burst. Use -1 to disable.",
    )
    parser.add_argument("--count", type=int, default=0, help="Stop after N samples. 0 means keep running.")
    parser.add_argument("--seed", type=int, default=None, help="Random seed for repeatable data.")
    parser.add_argument("--dry-run", action="store_true", help="Print payloads instead of publishing to MQTT.")
    parser.add_argument(
        "--env-file",
        default=str(find_default_env_file()),
        help="Optional env file used for MQTT_URL, MQTT_USERNAME and MQTT_PASSWORD.",
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    load_env_file(Path(args.env_file) if args.env_file else None)

    mqtt_url = args.mqtt_url or os.getenv("MQTT_URL") or DEFAULT_MQTT_URL
    username = args.username if args.username is not None else os.getenv("MQTT_USERNAME") or DEFAULT_MQTT_USERNAME
    password = args.password if args.password is not None else os.getenv("MQTT_PASSWORD") or DEFAULT_MQTT_PASSWORD
    status_topic = args.status_topic or f"devices/{args.device_id}/status"

    interval = max(0.2, args.interval)
    rng = random.Random(args.seed)
    motion = PatrolMotion(speed_mps=args.speed, dwell_sec=args.dwell, rng=rng)
    udp_pose_receiver: Optional[UdpPoseReceiver] = None
    if args.pose_source == "udp":
        udp_pose_receiver = UdpPoseReceiver(args.udp_host, args.udp_port, args.pose_stale_sec)
    matcher = PointMatcher(dwell_count=args.dwell_count)
    environment = EnvironmentSimulator(
        rng=rng,
        interval_sec=interval,
        anomaly_rate=args.anomaly_rate,
        anomaly_min_sec=args.anomaly_min_sec,
        anomaly_max_sec=args.anomaly_max_sec,
        first_anomaly_after_sec=args.first_anomaly_after,
    )

    stop = {"value": False}

    def request_stop(*_: Any) -> None:
        stop["value"] = True

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    publisher: Optional[MqttPublisher] = None
    if not args.dry_run:
        mqtt_cfg = parse_mqtt_url(mqtt_url, username=username, password=password)
        publisher = MqttPublisher(
            cfg=mqtt_cfg,
            client_id=f"go2-telemetry-sim-{args.device_id}-{int(time.time())}",
            status_topic=status_topic,
            qos=args.qos,
        )

    limit = args.count if args.count > 0 else (5 if args.dry_run else 0)
    seq = 0
    next_tick = time.monotonic()

    try:
        while not stop["value"] and (limit == 0 or seq < limit):
            if udp_pose_receiver is not None:
                pose = udp_pose_receiver.read_pose(timeout_sec=max(1.0, interval))
            else:
                pose = motion.step(interval)
            match = matcher.match(pose["x"], pose["y"])
            env = environment.read(match.nearest_point)
            payload = build_payload(
                args.device_id,
                args.area_id,
                current_unix_ts(),
                pose,
                match,
                env,
            )
            zone_for_topic = match.zone_id or "unassigned"
            topic = args.topic_template.format(device_id=args.device_id, zone_id=zone_for_topic)

            if args.dry_run:
                print(json.dumps({"topic": topic, "payload": payload}, ensure_ascii=False))
            else:
                assert publisher is not None
                publisher.publish_json(topic, payload)
                flag = " abnormal" if env["anomaly"] else ""
                print(
                    f"[{seq + 1:06d}] {topic} "
                    f"point={payload['point_id'] or '-'} sample={payload['sample_type']} "
                    f"temp={payload['temp_c']:.1f}C rh={payload['rh']:.1f}% "
                    f"x={payload['pose']['x']:.3f} y={payload['pose']['y']:.3f}{flag}",
                    flush=True,
                )

            seq += 1
            next_tick += interval
            sleep_sec = next_tick - time.monotonic()
            if sleep_sec > 0:
                time.sleep(sleep_sec)
            else:
                next_tick = time.monotonic()
    finally:
        if udp_pose_receiver is not None:
            udp_pose_receiver.close()
        if publisher is not None:
            publisher.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
