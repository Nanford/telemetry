import logging
from typing import Optional, Dict, Any

from app.utils import now_ts
from app.models import Pose
from app.providers.base_position import PositionProvider
from app.matcher.point_matcher import PointMatcher
from app.storage.spool import Spool

log = logging.getLogger(__name__)


class TelemetryService:
    def __init__(
        self,
        device_id: str,
        position_provider: PositionProvider,
        dht_reader,
        point_matcher: PointMatcher,
        spool: Spool,
        mqtt_uploader,
    ):
        self.device_id = device_id
        self.position_provider = position_provider
        self.dht_reader = dht_reader
        self.point_matcher = point_matcher
        self.spool = spool
        self.mqtt_uploader = mqtt_uploader
        self._cycle_count = 0

    def collect_once(self) -> Dict[str, Any]:
        pose = self.position_provider.read_pose()
        temp_c, rh, dht_err = self.dht_reader.read()
        match = self.point_matcher.match(pose)

        errors = [e for e in [dht_err, pose.error] if e]

        payload = {
            "device_id": self.device_id,
            "ts": now_ts(),
            "temp_c": temp_c,
            "rh": rh,
            "zone_id": match.zone_id,
            "area_id": match.area_id,
            "gps": {"fix": False, "lat": None, "lon": None, "fallback": False},
            "pose": pose.to_dict(),
            "point_id": match.point_id,
            "sample_type": match.sample_type,
            "errors": errors,
        }

        row_id = self.spool.put(payload)
        flushed = self.mqtt_uploader.flush(self.spool)

        self._cycle_count += 1
        if self._cycle_count % 30 == 0:
            log.info(
                "cycle=%d spool=%d flushed=%d mqtt=%s pose_fix=%s point=%s",
                self._cycle_count,
                self.spool.count(),
                flushed,
                self.mqtt_uploader.connected,
                pose.fix,
                match.point_id,
            )

        return payload
