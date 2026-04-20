#!/usr/bin/env python3
import os
import sys
import time
import signal
import logging

from app.config import load_cfg
from app.storage.spool import Spool
from app.matcher.point_matcher import PointMatcher
from app.uploader.mqtt_uploader import MqttUploader
from app.services.telemetry_service import TelemetryService

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("go2-env-agent")


def _build_position_provider(cfg):
    source = cfg["POSITION_SOURCE"]
    if source == "go2_slam":
        from app.providers.go2_pose_sdk import Go2PoseSDK
        return Go2PoseSDK(
            net_iface=cfg["GO2_NET_IFACE"],
            topic=cfg["GO2_POSE_TOPIC"],
            frame=cfg["SLAM_FRAME"],
            stale_sec=float(cfg["GO2_POSE_STALE_SEC"]),
        )
    elif source == "gps":
        from app.providers.sim7600_gnss import SIM7600Provider
        return SIM7600Provider(
            at_port=cfg["SIM7600_AT_PORT"],
            default_lat=float(cfg["GNSS_DEFAULT_LAT"]),
            default_lon=float(cfg["GNSS_DEFAULT_LON"]),
        )
    else:
        raise SystemExit(f"Unknown POSITION_SOURCE: {source}")


def _build_dht_reader(cfg):
    from app.providers.dht11_reader import DHTReader
    return DHTReader(cfg["DHT_GPIO"])


def main():
    cfg = load_cfg()
    interval = max(2, int(cfg["INTERVAL_SEC"]))

    os.makedirs(os.path.dirname(cfg["SPOOL_DB"]), exist_ok=True)

    position_provider = _build_position_provider(cfg)
    dht_reader = _build_dht_reader(cfg)
    matcher = PointMatcher(cfg["POINTS_FILE"], dwell_count=int(cfg["DWELL_COUNT"]))
    spool = Spool(cfg["SPOOL_DB"])
    mqtt_uploader = MqttUploader(cfg)

    position_provider.start()
    mqtt_uploader.start()

    service = TelemetryService(
        device_id=cfg["DEVICE_ID"],
        position_provider=position_provider,
        dht_reader=dht_reader,
        point_matcher=matcher,
        spool=spool,
        mqtt_uploader=mqtt_uploader,
    )

    stop_flag = {"stop": False}

    def _stop(*_):
        stop_flag["stop"] = True

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    log.info(
        "started: device=%s source=%s interval=%ds points=%d",
        cfg["DEVICE_ID"],
        cfg["POSITION_SOURCE"],
        interval,
        len(matcher.points),
    )

    try:
        while not stop_flag["stop"]:
            try:
                service.collect_once()
            except Exception as e:
                log.error("collect error: %s", e)
            time.sleep(interval)
    finally:
        position_provider.stop()
        mqtt_uploader.stop()
        log.info("stopped")


if __name__ == "__main__":
    main()
