from dataclasses import dataclass, field
from typing import Optional, List


@dataclass
class Pose:
    source: str
    frame: str
    fix: bool
    x: Optional[float]
    y: Optional[float]
    z: Optional[float]
    yaw: Optional[float]
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "source": self.source,
            "frame": self.frame,
            "fix": self.fix,
            "x": self.x,
            "y": self.y,
            "z": self.z,
            "yaw": self.yaw,
        }


@dataclass
class PointMatch:
    matched: bool
    area_id: Optional[str]
    zone_id: Optional[str]
    point_id: Optional[str]
    distance: Optional[float]
    sample_type: str = "timed"


@dataclass
class TelemetryRecord:
    device_id: str
    ts: int
    temp_c: Optional[int]
    rh: Optional[int]
    pose: Pose
    zone_id: Optional[str]
    area_id: Optional[str]
    point_id: Optional[str]
    sample_type: str = "timed"
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "device_id": self.device_id,
            "ts": self.ts,
            "temp_c": self.temp_c,
            "rh": self.rh,
            "pose": self.pose.to_dict(),
            "zone_id": self.zone_id if self.zone_id is not None else self.point_id,
            "point_id": self.point_id,
            "area_id": self.area_id,
            "sample_type": self.sample_type,
            "gps": {"fix": False, "lat": None, "lon": None, "fallback": False},
            "errors": self.errors,
        }
