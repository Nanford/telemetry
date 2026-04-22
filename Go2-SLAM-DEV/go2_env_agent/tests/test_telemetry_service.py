import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.models import PointMatch, Pose
from app.services.telemetry_service import TelemetryService


class DummyPositionProvider:
    def read_pose(self):
        return Pose(
            source="go2_slam",
            frame="map",
            fix=True,
            x=6.4,
            y=2.0,
            z=0.0,
            yaw=1.57,
        )


class DummyDhtReader:
    def read(self):
        return 26, 61, None


class DummyMatcher:
    def match(self, pose):
        return PointMatch(
            matched=True,
            area_id="warehouse_1f",
            zone_id="A2",
            point_id="A2",
            distance=0.0,
            sample_type="point_valid",
        )


class DummySpool:
    def __init__(self):
        self.payloads = []

    def put(self, payload):
        self.payloads.append(payload)
        return len(self.payloads)

    def count(self):
        return len(self.payloads)


class DummyUploader:
    connected = True

    def flush(self, spool):
        return spool.count()


def test_collect_once_keeps_zone_id_and_area_id_separate():
    spool = DummySpool()
    service = TelemetryService(
        device_id="go2_01",
        position_provider=DummyPositionProvider(),
        dht_reader=DummyDhtReader(),
        point_matcher=DummyMatcher(),
        spool=spool,
        mqtt_uploader=DummyUploader(),
    )

    payload = service.collect_once()

    assert payload["zone_id"] == "A2"
    assert payload["area_id"] == "warehouse_1f"
    assert payload["point_id"] == "A2"
    assert spool.payloads[0]["zone_id"] == "A2"
    assert spool.payloads[0]["area_id"] == "warehouse_1f"
