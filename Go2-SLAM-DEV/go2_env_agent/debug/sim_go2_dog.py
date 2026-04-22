#!/usr/bin/env python3
"""
Go2 机器狗模拟器 — 发布假位姿数据，用于测试 go2-env-agent 全链路。

传输模式:
    --transport dds   原始 DDS 模式（需要 unitree_sdk2py + cyclonedds，Pi 上用）
    --transport udp   JSON-over-UDP 模式（零依赖，Windows / 任何平台通用）

示例 — Windows 本机测试:
    终端1 (模拟器):  python debug/sim_go2_dog.py --transport udp --mode patrol
    终端2 (agent):   set GO2_POSE_MODE=udp && python -m app.main

示例 — Pi 本机测试 (DDS):
    终端1:  python debug/sim_go2_dog.py --iface lo --mode patrol
    终端2:  GO2_NET_IFACE=lo python -m app.main
"""
import argparse
import json
import math
import os
import random
import signal
import socket
import sys
import time

# ── 点位定义（与 points.yaml 一致）────────────────────────────
POINTS = [
    {"id": "A1", "name": "原料接收区", "x": 2.1,  "y": 1.8},
    {"id": "A2", "name": "初加工区",   "x": 6.4,  "y": 2.0},
    {"id": "A3", "name": "醇化仓库",   "x": 10.2, "y": 2.1},
    {"id": "A4", "name": "成品仓库",   "x": 14.0, "y": 2.0},
    {"id": "A5", "name": "装卸调度区", "x": 17.8, "y": 1.9},
]


# ── DDS 传输 ────────────────────────────────────────────────

def configure_dds(iface: str):
    xml = (
        "<CycloneDDS><Domain><General><Interfaces>"
        f'<NetworkInterface name="{iface}"/>'
        "</Interfaces></General></Domain></CycloneDDS>"
    )
    os.environ["CYCLONEDDS_URI"] = xml


def create_dds_publisher(iface: str, topic: str):
    configure_dds(iface)

    from unitree_sdk2py.core.channel import (
        ChannelFactoryInitialize,
        ChannelPublisher,
    )
    from unitree_sdk2py.idl.unitree_go.msg.dds_ import SportModeState_

    ChannelFactoryInitialize(0, iface)
    pub = ChannelPublisher(topic, SportModeState_)
    pub.Init()
    return pub, SportModeState_


def build_dds_msg(
    MsgType,
    x: float,
    y: float,
    z: float,
    yaw: float,
    TimeSpecType=None,
    IMUStateType=None,
    PathPointType=None,
):
    try:
        msg = MsgType()
    except TypeError:
        msg = None

    if msg is not None:
        try:
            msg.position = [x, y, z]
            msg.imu_state.rpy = [0.0, 0.0, yaw]
            return msg
        except (TypeError, AttributeError):
            try:
                msg.position[0] = x
                msg.position[1] = y
                msg.position[2] = z
                msg.imu_state.rpy[0] = 0.0
                msg.imu_state.rpy[1] = 0.0
                msg.imu_state.rpy[2] = yaw
                return msg
            except (TypeError, AttributeError, IndexError):
                pass

    if TimeSpecType is None or IMUStateType is None or PathPointType is None:
        from unitree_sdk2py.idl.unitree_go.msg.dds_ import (
            IMUState_ as IMUStateType,
            PathPoint_ as PathPointType,
            TimeSpec_ as TimeSpecType,
        )

    now_ns = time.time_ns()
    stamp = TimeSpecType(
        sec=now_ns // 1_000_000_000,
        nanosec=now_ns % 1_000_000_000,
    )
    imu_state = IMUStateType(
        quaternion=[0.0, 0.0, 0.0, 1.0],
        gyroscope=[0.0, 0.0, 0.0],
        accelerometer=[0.0, 0.0, 9.81],
        rpy=[0.0, 0.0, yaw],
        temperature=0,
    )
    path_point = [
        PathPointType(
            t_from_start=idx * 0.1,
            x=x,
            y=y,
            yaw=yaw,
            vx=0.0,
            vy=0.0,
            vyaw=0.0,
        )
        for idx in range(10)
    ]

    return MsgType(
        stamp=stamp,
        error_code=0,
        imu_state=imu_state,
        mode=0,
        progress=0.0,
        gait_type=0,
        foot_raise_height=0.0,
        position=[x, y, z],
        body_height=z,
        velocity=[0.0, 0.0, 0.0],
        yaw_speed=0.0,
        range_obstacle=[0.0, 0.0, 0.0, 0.0],
        foot_force=[0, 0, 0, 0],
        foot_position_body=[0.0] * 12,
        foot_speed_body=[0.0] * 12,
        path_point=path_point,
    )


# ── UDP 传输 ────────────────────────────────────────────────

class UDPPublisher:
    def __init__(self, host: str, port: int):
        self._addr = (host, port)
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def send(self, x: float, y: float, z: float, yaw: float):
        payload = json.dumps({
            "position": [x, y, z],
            "imu_rpy": [0.0, 0.0, yaw],
        }).encode()
        self._sock.sendto(payload, self._addr)


# ── 运动模式 ─────────────────────────────────────────────────

class RandomWalk:
    """随机漫步：在点位区域范围内随机移动"""

    def __init__(self):
        self.x = POINTS[0]["x"]
        self.y = POINTS[0]["y"]
        self.yaw = 0.0
        self.vx = 0.0
        self.vy = 0.0

    def step(self, dt: float):
        self.vx += random.uniform(-0.3, 0.3)
        self.vy += random.uniform(-0.1, 0.1)
        self.vx = max(-0.5, min(0.5, self.vx))
        self.vy = max(-0.3, min(0.3, self.vy))

        self.x += self.vx * dt
        self.y += self.vy * dt
        self.yaw += random.uniform(-0.1, 0.1)

        self.x = max(0.0, min(20.0, self.x))
        self.y = max(0.0, min(5.0, self.y))
        self.yaw = self.yaw % (2 * math.pi)

        return self.x, self.y, 0.32, self.yaw


class PatrolWalk:
    """巡逻模式：依次在 A1→A2→A3→A4→A5→A4→...→A1 之间移动，每个点位停留 dwell_sec"""

    def __init__(self, speed: float = 0.8, dwell_sec: float = 10.0):
        self.speed = speed
        self.dwell_sec = dwell_sec
        self.path = list(range(len(POINTS))) + list(range(len(POINTS) - 2, 0, -1))
        self.idx = 0
        self.x = POINTS[0]["x"]
        self.y = POINTS[0]["y"]
        self.yaw = 0.0
        self.dwelling = 0.0
        self.arrived = False

    def step(self, dt: float):
        target = POINTS[self.path[self.idx % len(self.path)]]
        tx, ty = target["x"], target["y"]

        dx = tx - self.x
        dy = ty - self.y
        dist = math.sqrt(dx * dx + dy * dy)

        if dist < 0.05:
            self.x, self.y = tx, ty
            if not self.arrived:
                self.arrived = True
                self.dwelling = 0.0
            self.dwelling += dt
            if self.dwelling >= self.dwell_sec:
                self.idx += 1
                self.arrived = False
                self.dwelling = 0.0
        else:
            step_dist = min(self.speed * dt, dist)
            self.x += dx / dist * step_dist
            self.y += dy / dist * step_dist
            self.yaw = math.atan2(dy, dx)

        noise_x = random.gauss(0, 0.01)
        noise_y = random.gauss(0, 0.01)
        return self.x + noise_x, self.y + noise_y, 0.32, self.yaw


def main():
    parser = argparse.ArgumentParser(description="Go2 机器狗模拟器")
    parser.add_argument("--transport", choices=["dds", "udp"], default="udp",
                        help="传输模式: dds=DDS(需unitree_sdk2py), udp=JSON-over-UDP(零依赖，默认)")
    parser.add_argument("--iface", default="lo",
                        help='DDS 模式网口名。Pi 用 lo，Windows 用"以太网"')
    parser.add_argument("--topic", default="rt/sportmodestate",
                        help="DDS topic 名称")
    parser.add_argument("--udp-host", default="127.0.0.1",
                        help="UDP 目标地址（默认 127.0.0.1）")
    parser.add_argument("--udp-port", type=int, default=9870,
                        help="UDP 目标端口（默认 9870）")
    parser.add_argument("--hz", type=float, default=10.0,
                        help="发布频率 Hz（默认 10）")
    parser.add_argument("--mode", choices=["random", "patrol"], default="random",
                        help="运动模式: random=随机漫步, patrol=依次巡逻各点位")
    parser.add_argument("--dwell", type=float, default=10.0,
                        help="patrol 模式在每个点位停留秒数（默认 10）")
    args = parser.parse_args()

    print("=== Go2 模拟器 ===")
    print(f"传输: {args.transport.upper()}", end="  ")
    if args.transport == "dds":
        print(f"网口: {args.iface}  Topic: {args.topic}")
    else:
        print(f"目标: {args.udp_host}:{args.udp_port}")
    print(f"频率: {args.hz}Hz  模式: {args.mode}")
    if args.mode == "patrol":
        route = " → ".join(p["id"] for p in POINTS)
        print(f"巡逻路线: {route}（往返），每点停留 {args.dwell}s")
    print("Ctrl+C 停止\n")

    # 初始化发布器
    if args.transport == "dds":
        dds_pub, MsgType = create_dds_publisher(args.iface, args.topic)
    else:
        udp_pub = UDPPublisher(args.udp_host, args.udp_port)

    if args.mode == "patrol":
        walker = PatrolWalk(speed=0.8, dwell_sec=args.dwell)
    else:
        walker = RandomWalk()

    dt = 1.0 / args.hz
    stop = {"flag": False}

    def _stop(*_):
        stop["flag"] = True

    signal.signal(signal.SIGINT, _stop)

    seq = 0
    while not stop["flag"]:
        x, y, z, yaw = walker.step(dt)

        if args.transport == "dds":
            msg = build_dds_msg(MsgType, x, y, z, yaw)
            dds_pub.Write(msg)
        else:
            udp_pub.send(x, y, z, yaw)

        seq += 1
        if seq % int(args.hz * 2) == 0:
            nearest = min(POINTS, key=lambda p: math.hypot(p["x"] - x, p["y"] - y))
            dist = math.hypot(nearest["x"] - x, nearest["y"] - y)
            print(f"[seq={seq:>6d}]  x={x:+7.3f}  y={y:+7.3f}  z={z:+5.2f}  "
                  f"yaw={yaw:+6.3f}  nearest={nearest['id']}(d={dist:.2f}m)")

        time.sleep(dt)

    print("\n模拟器已停止")


if __name__ == "__main__":
    main()
