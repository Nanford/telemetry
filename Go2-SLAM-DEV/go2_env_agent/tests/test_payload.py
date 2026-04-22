import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.models import Pose, PointMatch, TelemetryRecord


class TestPoseDict:
    def test_full_pose(self):
        p = Pose(source="go2_slam", frame="map", fix=True, x=1.0, y=2.0, z=0.1, yaw=1.57)
        d = p.to_dict()
        assert d["source"] == "go2_slam"
        assert d["fix"] is True
        assert d["x"] == 1.0
        assert "error" not in d

    def test_no_fix_pose(self):
        p = Pose(source="go2_slam", frame="map", fix=False, x=None, y=None, z=None, yaw=None, error="stale")
        d = p.to_dict()
        assert d["fix"] is False
        assert d["x"] is None


class TestTelemetryRecord:
    def test_full_record(self):
        pose = Pose(source="go2_slam", frame="map", fix=True, x=6.4, y=2.0, z=0.0, yaw=1.57)
        rec = TelemetryRecord(
            device_id="go2_01",
            ts=1776403200,
            temp_c=26,
            rh=61,
            pose=pose,
            zone_id="A2",
            area_id="warehouse_1f",
            point_id="A2",
            sample_type="point_valid",
            errors=[],
        )
        d = rec.to_dict()
        assert d["device_id"] == "go2_01"
        assert d["zone_id"] == "A2"
        assert d["point_id"] == "A2"
        assert d["pose"]["source"] == "go2_slam"
        assert d["gps"]["fix"] is False
        assert d["sample_type"] == "point_valid"
        assert d["temp_c"] == 26

    def test_no_match_record(self):
        pose = Pose(source="go2_slam", frame="map", fix=True, x=99.0, y=99.0, z=0.0, yaw=0.0)
        rec = TelemetryRecord(
            device_id="go2_01",
            ts=1776403200,
            temp_c=None,
            rh=None,
            pose=pose,
            zone_id=None,
            area_id="warehouse_1f",
            point_id=None,
            errors=["DHT read error: checksum"],
        )
        d = rec.to_dict()
        assert d["zone_id"] is None
        assert d["point_id"] is None
        assert d["temp_c"] is None
        assert len(d["errors"]) == 1

    def test_no_fix_record(self):
        pose = Pose(source="go2_slam", frame="map", fix=False, x=None, y=None, z=None, yaw=None, error="no_pose")
        rec = TelemetryRecord(
            device_id="go2_01",
            ts=1776403200,
            temp_c=25,
            rh=55,
            pose=pose,
            zone_id=None,
            area_id=None,
            point_id=None,
            errors=["no_pose"],
        )
        d = rec.to_dict()
        assert d["pose"]["fix"] is False
        assert d["zone_id"] is None
