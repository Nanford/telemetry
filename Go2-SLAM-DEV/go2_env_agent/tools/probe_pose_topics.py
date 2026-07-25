#!/usr/bin/env python3
"""
INPUT : Go2 机器狗的 DDS 域(需与狗同网段)。无需狗端改配置, 全程只订阅不下发。
OUTPUT: 1) discover 模式 —— 列出狗当前实际在发的全部 DDS topic 及其类型
        2) static   模式 —— 狗站着不动, 对比各候选位姿 topic 的到达率/位置噪声/yaw 零漂/突跳
        3) walk     模式 —— 狗直线走一段已知真实距离, 对比各 topic 的里程尺度因子
POS   : 阶段A(换位姿源)的前置探针。当前 go2_pose_sdk.py 订阅的 rt/sportmodestate 是
        足式里程计(非建图位姿), 已实测出 -1.1°/min 零漂 + 突跳 + 约 26% 尺度亏损。
        本脚本用来判定狗端是否存在可用的 map 帧位姿 topic, 决定 A2 怎么实现。
        只读诊断工具, 不进产线, 不写任何文件。

用法(在 Pi 上跑, 需与狗同网段):
    python tools/probe_pose_topics.py --iface eth0 --mode discover
    python tools/probe_pose_topics.py --iface eth0 --mode static --secs 90
    python tools/probe_pose_topics.py --iface eth0 --mode walk --truth 13.085

三步怎么配合:
    1. discover  先看 rt/utlidar/robot_pose 之类的建图位姿 topic 到底存不存在
    2. static    把狗放在地上站好、全程别碰, 90 秒。零漂只有静止时才量得准
    3. walk      从 A-4-1-17 直线走到 A-4-1-20(CAD 实距 13.085 m), 停稳后 Ctrl-C
"""
from __future__ import annotations

import argparse
import math
import statistics
import sys
import threading
import time
from typing import Callable, Dict, List, Optional, Tuple

# Windows 控制台默认 GBK, 打印中文会炸; 强制 UTF-8(Linux 本就 UTF-8, 无副作用)。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- 候选 topic 表
# extractor 名字决定怎么从消息里取 (x, y, z, yaw); 类型解析失败的条目会被自动跳过。
CANDIDATES: List[Tuple[str, str, str]] = [
    ("rt/sportmodestate", "sport", "足式里程计(当前在用, 已知会漂)"),
    ("rt/lf/sportmodestate", "sport", "同上的低频版本"),
    ("rt/utlidar/robot_pose", "pose_stamped", "L1 激光建图位姿(map 帧, 期望的目标)"),
    ("rt/uslam/localization/pose", "pose_stamped", "uSLAM 重定位位姿(新固件)"),
    ("rt/uslam/odometry", "odometry", "uSLAM 里程计"),
    ("rt/utlidar/robot_odom", "odometry", "激光里程计"),
]


def quat_to_yaw(x: float, y: float, z: float, w: float) -> float:
    """四元数取偏航角(绕 z)。ROS 惯例, 返回弧度。"""
    return math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))


def _extract_sport(msg) -> Tuple[float, float, float, float]:
    return (float(msg.position[0]), float(msg.position[1]),
            float(msg.position[2]), float(msg.imu_state.rpy[2]))


def _extract_pose_stamped(msg) -> Tuple[float, float, float, float]:
    p, q = msg.pose.position, msg.pose.orientation
    return (float(p.x), float(p.y), float(p.z),
            quat_to_yaw(float(q.x), float(q.y), float(q.z), float(q.w)))


def _extract_odometry(msg) -> Tuple[float, float, float, float]:
    p, q = msg.pose.pose.position, msg.pose.pose.orientation
    return (float(p.x), float(p.y), float(p.z),
            quat_to_yaw(float(q.x), float(q.y), float(q.z), float(q.w)))


EXTRACTORS: Dict[str, Callable] = {
    "sport": _extract_sport,
    "pose_stamped": _extract_pose_stamped,
    "odometry": _extract_odometry,
}


def resolve_idl(kind: str):
    """按 extractor 类别找对应的 IDL 类型。找不到返回 None, 调用方跳过该 topic。"""
    try:
        if kind == "sport":
            from unitree_sdk2py.idl.unitree_go.msg.dds_ import SportModeState_
            return SportModeState_
        if kind == "pose_stamped":
            from unitree_sdk2py.idl.geometry_msgs.msg.dds_ import PoseStamped_
            return PoseStamped_
        if kind == "odometry":
            from unitree_sdk2py.idl.nav_msgs.msg.dds_ import Odometry_
            return Odometry_
    except Exception:  # noqa: BLE001  类型不在本版本 SDK 里, 属正常
        return None
    return None


# ------------------------------------------------------------------ 采样收集器
class Collector:
    """一个 topic 的采样缓冲。回调线程写, 主线程读, 用锁护住。"""

    def __init__(self, topic: str, extract: Callable):
        self.topic = topic
        self._extract = extract
        self._lock = threading.Lock()
        self.rows: List[Tuple[float, float, float, float, float]] = []  # (t, x, y, z, yaw)
        self.errors = 0

    def on_message(self, msg) -> None:
        try:
            x, y, z, yaw = self._extract(msg)
        except Exception:  # noqa: BLE001  字段不匹配, 记一次不中断
            with self._lock:
                self.errors += 1
            return
        with self._lock:
            self.rows.append((time.time(), x, y, z, yaw))

    def snapshot(self) -> List[Tuple[float, float, float, float, float]]:
        with self._lock:
            return list(self.rows)


def unwrap(seq: List[float]) -> List[float]:
    """把 ±π 处跳变的 yaw 序列展开成连续序列, 否则零漂会被 2π 折叠淹没。"""
    out = [seq[0]] if seq else []
    for v in seq[1:]:
        d = v - out[-1]
        while d > math.pi:
            d -= 2 * math.pi
        while d < -math.pi:
            d += 2 * math.pi
        out.append(out[-1] + d)
    return out


# -------------------------------------------------------------------- 各模式
def mode_discover(iface: str, secs: float) -> None:
    """用 DDS 内建发现读 topic 列表 —— 不猜类型, 狗在发什么就列什么。"""
    print(f"[discover] 在 {iface} 上监听 DDS 发现信息 {secs:.0f} s …\n")
    try:
        from cyclonedds.domain import DomainParticipant
        from cyclonedds.builtin import BuiltinDataReader, BuiltinTopicDcpsPublication
    except Exception as e:  # noqa: BLE001
        print(f"[!] 无法导入 cyclonedds: {e}")
        print("    先跑通 static 模式即可, discover 不是必须的。")
        return

    dp = DomainParticipant(0)
    reader = BuiltinDataReader(dp, BuiltinTopicDcpsPublication)
    seen: Dict[str, str] = {}
    deadline = time.time() + secs
    while time.time() < deadline:
        for sample in reader.take(N=100):
            name = getattr(sample, "topic_name", None)
            if name and not name.startswith("DCPS"):
                seen[name] = getattr(sample, "type_name", "?")
        time.sleep(0.2)

    if not seen:
        print("[!] 一个 topic 都没发现。检查:狗开机了吗?网线/网段对吗?--iface 对吗?")
        return
    print(f"发现 {len(seen)} 个 topic:\n")
    print(f"{'topic':46} {'type'}")
    print("-" * 100)
    for name in sorted(seen):
        mark = "  ←★ 位姿候选" if any(k in name for k in ("pose", "odom", "sportmode", "slam")) else ""
        print(f"{name:46} {seen[name]}{mark}")
    print("\n把上面整段贴回来, 我据此定 A2 订阅哪个 topic。")


def subscribe_all(iface: str) -> Tuple[List[Collector], List]:
    """把所有能解析类型的候选 topic 都订上。返回 (收集器, 订阅者句柄)。"""
    from unitree_sdk2py.core.channel import ChannelFactoryInitialize, ChannelSubscriber

    ChannelFactoryInitialize(0, iface)
    collectors, subs = [], []
    for topic, kind, note in CANDIDATES:
        idl = resolve_idl(kind)
        if idl is None:
            print(f"  [跳过] {topic:34} 本版本 SDK 无对应 IDL 类型")
            continue
        col = Collector(topic, EXTRACTORS[kind])
        try:
            sub = ChannelSubscriber(topic, idl)
            sub.Init(col.on_message, 20)
        except Exception as e:  # noqa: BLE001
            print(f"  [跳过] {topic:34} 订阅失败: {e}")
            continue
        print(f"  [订阅] {topic:34} {note}")
        collectors.append(col)
        subs.append(sub)
    return collectors, subs


def mode_static(iface: str, secs: float) -> None:
    """狗站着不动, 量各 topic 的到达率 / 位置噪声 / yaw 零漂 / 突跳。"""
    print("[static] 订阅候选 topic:")
    collectors, _subs = subscribe_all(iface)
    if not collectors:
        print("\n[!] 没有任何 topic 订阅成功, 无法继续。")
        return

    print(f"\n>>> 现在起 {secs:.0f} 秒内让狗站在地上、完全不要碰它 <<<\n")
    for left in range(int(secs), 0, -5):
        print(f"    剩余 {left:3d} s …", end="\r", flush=True)
        time.sleep(min(5, left))
    print(" " * 30, end="\r")

    print(f"\n{'topic':34} {'样本':>5} {'速率Hz':>7} {'最大间隔s':>9} "
          f"{'位置游走m':>9} {'yaw零漂°/min':>12} {'突跳>15°':>8}")
    print("-" * 96)
    for col in collectors:
        rows = col.snapshot()
        if len(rows) < 5:
            print(f"{col.topic:34} {len(rows):>5} {'—':>7} {'—':>9} {'—':>9} {'—':>12} {'—':>8}  无数据")
            continue
        ts = [r[0] for r in rows]
        span = ts[-1] - ts[0]
        gaps = [ts[i + 1] - ts[i] for i in range(len(ts) - 1)]
        # 静止时位置本应不动; 首末位移即"位置游走", 直接反映估计器有多稳
        walk = math.dist((rows[0][1], rows[0][2]), (rows[-1][1], rows[-1][2]))
        yaws = unwrap([r[4] for r in rows])
        drift = math.degrees(yaws[-1] - yaws[0]) / span * 60 if span > 0 else 0.0
        jumps = sum(1 for i in range(len(yaws) - 1)
                    if abs(math.degrees(yaws[i + 1] - yaws[i])) > 15)
        print(f"{col.topic:34} {len(rows):>5} {len(rows) / span:>7.1f} {max(gaps):>9.2f} "
              f"{walk:>9.3f} {drift:>+12.2f} {jumps:>8}")

    print("\n判读:零漂越接近 0 越好。sportmodestate 实测约 -1.1 °/min;")
    print("      若某个 map 帧 topic 零漂 <0.1 °/min 且突跳为 0, 那就是 A2 要换的目标。")


def mode_walk(iface: str, truth_m: float) -> None:
    """狗直线走一段已知真实距离, 对比各 topic 报出的里程 —— 直接量尺度因子。"""
    print("[walk] 订阅候选 topic:")
    collectors, _subs = subscribe_all(iface)
    if not collectors:
        print("\n[!] 没有任何 topic 订阅成功, 无法继续。")
        return

    print(f"\n>>> 把狗牵到起点站稳, 然后直线走完 {truth_m:.3f} m, 停稳后按 Ctrl-C <<<\n")
    start = {col.topic: (col.snapshot()[-1][1:3] if col.snapshot() else None) for col in collectors}
    try:
        while True:
            time.sleep(1)
            n = min((len(c.snapshot()) for c in collectors), default=0)
            print(f"    采样中… 最少的 topic 已收 {n} 条", end="\r", flush=True)
    except KeyboardInterrupt:
        print(" " * 50, end="\r")

    print(f"\n真实距离 {truth_m:.3f} m\n")
    print(f"{'topic':34} {'直线位移m':>10} {'累计路径m':>10} {'尺度因子':>9} {'需要的c':>8}")
    print("-" * 82)
    for col in collectors:
        rows = col.snapshot()
        if len(rows) < 5 or start.get(col.topic) is None:
            print(f"{col.topic:34} {'—':>10} {'—':>10} {'—':>9} {'—':>8}  数据不足")
            continue
        s = start[col.topic]
        e = (rows[-1][1], rows[-1][2])
        straight = math.dist(s, e)
        path = sum(math.dist((rows[i][1], rows[i][2]), (rows[i + 1][1], rows[i + 1][2]))
                   for i in range(len(rows) - 1))
        ratio = straight / truth_m if truth_m > 0 else 0.0
        print(f"{col.topic:34} {straight:>10.3f} {path:>10.3f} {ratio:>9.3f} "
              f"{(1 / ratio if ratio > 0 else 0):>8.3f}")

    print("\n判读:尺度因子应为 1.000。第2趟照片真值实测 sportmodestate 只有 0.735,")
    print("      即少算 26%。若某 map 帧 topic 接近 1.000, 说明换源即可消掉尺度误差。")


def main() -> None:
    ap = argparse.ArgumentParser(description="Go2 位姿 topic 探针(只读)")
    ap.add_argument("--iface", default="eth0", help="与狗同网段的网卡名, 默认 eth0")
    ap.add_argument("--mode", choices=("discover", "static", "walk"), default="discover")
    ap.add_argument("--secs", type=float, default=90.0, help="discover/static 的采集时长(秒)")
    ap.add_argument("--truth", type=float, default=13.085,
                    help="walk 模式走过的真实距离(米), 默认 A-4-1-17→20 的 CAD 实距")
    args = ap.parse_args()

    if args.mode == "discover":
        mode_discover(args.iface, min(args.secs, 20.0))
    elif args.mode == "static":
        mode_static(args.iface, args.secs)
    else:
        mode_walk(args.iface, args.truth)


if __name__ == "__main__":
    main()
