import math
from typing import Dict, List, Optional

import yaml

from app.models import Pose, PointMatch


class PointMatcher:
    def __init__(self, points_file: str, dwell_count: int = 3):
        with open(points_file, encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
        self.area_id: str = cfg["area_id"]
        self.points: List[Dict] = cfg["points"]
        self._dwell_count = dwell_count
        self._dwell_tracker: Dict[str, int] = {}

    def match(self, pose: Pose) -> PointMatch:
        if not pose.fix or pose.x is None or pose.y is None:
            self._dwell_tracker.clear()
            return PointMatch(
                matched=False,
                area_id=self.area_id,
                point_id=None,
                distance=None,
                sample_type="timed",
            )

        best_id: Optional[str] = None
        best_dist = float("inf")

        for p in self.points:
            dist = math.sqrt((pose.x - p["x"]) ** 2 + (pose.y - p["y"]) ** 2)
            if dist <= p["radius"] and dist < best_dist:
                best_id = p["id"]
                best_dist = dist

        if best_id is None:
            self._dwell_tracker.clear()
            return PointMatch(
                matched=False,
                area_id=self.area_id,
                point_id=None,
                distance=None,
                sample_type="timed",
            )

        self._dwell_tracker[best_id] = self._dwell_tracker.get(best_id, 0) + 1
        for pid in list(self._dwell_tracker):
            if pid != best_id:
                del self._dwell_tracker[pid]

        sample_type = (
            "point_valid"
            if self._dwell_tracker[best_id] >= self._dwell_count
            else "timed"
        )

        return PointMatch(
            matched=True,
            area_id=self.area_id,
            point_id=best_id,
            distance=round(best_dist, 4),
            sample_type=sample_type,
        )
