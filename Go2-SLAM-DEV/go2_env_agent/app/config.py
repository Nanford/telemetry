import os
from typing import Dict


def load_cfg() -> Dict[str, str]:
    position_source = os.getenv("POSITION_SOURCE", "go2_slam").strip()

    required = ["DEVICE_ID", "DHT_GPIO", "MQTT_HOST", "MQTT_PORT", "MQTT_TOPIC"]
    if position_source == "gps":
        required.append("SIM7600_AT_PORT")

    cfg = {k: os.getenv(k, "").strip() for k in required}
    missing = [k for k, v in cfg.items() if not v]
    if missing:
        raise SystemExit(f"Missing env vars: {missing}")

    cfg["POSITION_SOURCE"] = position_source

    # Go2 SLAM settings
    cfg["GO2_POSE_MODE"] = os.getenv("GO2_POSE_MODE", "sdk2_python").strip()
    cfg["GO2_NET_IFACE"] = os.getenv("GO2_NET_IFACE", "eth0").strip()
    cfg["GO2_POSE_TOPIC"] = os.getenv("GO2_POSE_TOPIC", "rt/sportmodestate").strip()
    cfg["SLAM_FRAME"] = os.getenv("SLAM_FRAME", "map").strip()
    cfg["GO2_POSE_STALE_SEC"] = os.getenv("GO2_POSE_STALE_SEC", "2.0").strip()

    # Point matching
    cfg["POINTS_FILE"] = os.getenv(
        "POINTS_FILE",
        os.path.join(os.path.dirname(__file__), "config", "points.yaml"),
    )
    cfg["DWELL_COUNT"] = os.getenv("DWELL_COUNT", "3").strip()

    # MQTT
    cfg["MQTT_USERNAME"] = os.getenv("MQTT_USERNAME", "").strip()
    cfg["MQTT_PASSWORD"] = os.getenv("MQTT_PASSWORD", "").strip()
    cfg["MQTT_TLS"] = os.getenv("MQTT_TLS", "0").strip()
    cfg["MQTT_CA_CERT"] = os.getenv("MQTT_CA_CERT", "").strip()
    cfg["MQTT_CLIENT_ID"] = os.getenv("MQTT_CLIENT_ID", f"go2-env-agent-{cfg['DEVICE_ID']}")
    cfg["MQTT_STATUS_TOPIC"] = os.getenv("MQTT_STATUS_TOPIC", f"devices/{cfg['DEVICE_ID']}/status")

    # Storage
    cfg["SPOOL_DB"] = os.getenv("SPOOL_DB", "/var/lib/go2-env-agent/spool.db")
    cfg["INTERVAL_SEC"] = os.getenv("INTERVAL_SEC", "5").strip()

    # GPS fallback (only when POSITION_SOURCE=gps)
    cfg["SIM7600_AT_PORT"] = os.getenv("SIM7600_AT_PORT", "").strip()
    cfg["GNSS_DEFAULT_LAT"] = os.getenv("GNSS_DEFAULT_LAT", "30.681732").strip()
    cfg["GNSS_DEFAULT_LON"] = os.getenv("GNSS_DEFAULT_LON", "114.183271").strip()

    # HTTP optional channel
    cfg["HTTP_ENABLE"] = os.getenv("HTTP_ENABLE", "0").strip()
    cfg["HTTP_ENDPOINT"] = os.getenv("HTTP_ENDPOINT", "").strip()
    cfg["HTTP_TOKEN"] = os.getenv("HTTP_TOKEN", "").strip()

    return cfg
