import os
import time
import threading
from typing import Optional

from app.models import Pose
from app.providers.base_position import PositionProvider


class Go2PoseSDK(PositionProvider):
    """Read Go2 pose via Unitree SDK2 Python (DDS subscriber)."""

    def __init__(
        self,
        net_iface: str = "eth0",
        topic: str = "rt/sportmodestate",
        frame: str = "map",
        stale_sec: float = 2.0,
    ):
        self._net_iface = net_iface
        self._topic = topic
        self._frame = frame
        self._stale_sec = stale_sec
        self._lock = threading.Lock()
        self._latest_pose: Optional[Pose] = None
        self._last_update_ts: float = 0.0
        self._sub = None

    def start(self) -> None:
        self._configure_cyclonedds()

        from unitree_sdk2py.core.channel import (
            ChannelFactoryInitialize,
            ChannelSubscriber,
        )
        from unitree_sdk2py.idl.unitree_go.msg.dds_ import SportModeState_

        ChannelFactoryInitialize(0, self._net_iface)
        self._sub = ChannelSubscriber(self._topic, SportModeState_)
        self._sub.Init(self._on_message, 10)
        print(f"Go2PoseSDK: subscribed to {self._topic} on {self._net_iface}")

    def _configure_cyclonedds(self) -> None:
        xml = (
            "<CycloneDDS><Domain><General><Interfaces>"
            f'<NetworkInterface name="{self._net_iface}"/>'
            "</Interfaces></General></Domain></CycloneDDS>"
        )
        os.environ.setdefault("CYCLONEDDS_URI", xml)

    def _on_message(self, msg) -> None:
        try:
            pose = Pose(
                source="go2_slam",
                frame=self._frame,
                fix=True,
                x=float(msg.position[0]),
                y=float(msg.position[1]),
                z=float(msg.position[2]),
                yaw=float(msg.imu_state.rpy[2]),
            )
            with self._lock:
                self._latest_pose = pose
                self._last_update_ts = time.time()
        except Exception as e:
            print(f"Go2PoseSDK: callback error: {e}")

    def read_pose(self) -> Pose:
        with self._lock:
            if self._latest_pose is None:
                return Pose(
                    source="go2_slam",
                    frame=self._frame,
                    fix=False,
                    x=None,
                    y=None,
                    z=None,
                    yaw=None,
                    error="no_pose_received_yet",
                )

            age = time.time() - self._last_update_ts
            if age > self._stale_sec:
                return Pose(
                    source="go2_slam",
                    frame=self._frame,
                    fix=False,
                    x=self._latest_pose.x,
                    y=self._latest_pose.y,
                    z=self._latest_pose.z,
                    yaw=self._latest_pose.yaw,
                    error=f"pose_stale_{age:.1f}s",
                )
            return self._latest_pose

    def stop(self) -> None:
        self._sub = None
        print("Go2PoseSDK: stopped")
