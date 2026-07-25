"""
INPUT : app/providers/pose_health.py
OUTPUT: pytest 断言
POS   : 突跳/零漂检测的回归测试。夹具 REAL_JUMPS 是 2026-07-23 A-4-1 现场两趟实测日志里
        全部 8 次真实突跳的前后相邻样本(原始 SLAM 坐标, 未经任何加工)。
        这批数据是唯一一份能复现该失效的现场记录, 固化在这里以免丢失。
"""
import math
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.models import Pose
from app.providers.base_position import PositionProvider
from app.providers.pose_health import PoseHealthGuard, wrap_pi


# 2026-07-23 现场实测的 8 次 yaw 突跳, 每项 = (前一样本, 突跳样本), 样本 = (x, y, yaw, ts)
REAL_JUMPS = [
    # 趟1 ts=1784773249 位移0.030m Δyaw=-28.6°
    ((-35.123149872, -10.085177422, 0.504713297, 1784773243), (-35.127666473, -10.114875793, 0.006162095, 1784773249)),
    # 趟1 ts=1784773609 位移0.013m Δyaw=-116.7°
    ((-9.483201981, -7.948895454, -0.105307944, 1784773604), (-9.471286774, -7.943356514, -2.141829967, 1784773609)),
    # 趟1 ts=1784773679 位移0.010m Δyaw=-124.3°
    ((-15.965234756, -20.064949036, -1.624531269, 1784773674), (-15.962144852, -20.055570602, 2.488859653, 1784773679)),
    # 趟1 ts=1784774078 位移0.026m Δyaw=-46.5°
    ((1.497326255, -11.413979530, -0.500990093, 1784774073), (1.521646261, -11.404772758, -1.311871171, 1784774078)),
    # 趟2 ts=1784774751 位移0.028m Δyaw=-34.5°
    ((-27.696239471, 11.625238419, -0.278075367, 1784774746), (-27.711517334, 11.649050713, -0.879807115, 1784774751)),
    # 趟2 ts=1784775063 位移0.039m Δyaw=-63.1°
    ((-6.524417400, -20.254812241, -1.023796797, 1784775058), (-6.488107204, -20.270029068, -2.125669479, 1784775063)),
    # 趟2 ts=1784775074 位移0.007m Δyaw=-60.5°
    ((-6.561771393, -22.114990234, 3.135632992, 1784775069), (-6.559910774, -22.108425140, 2.079869747, 1784775074)),
    # 趟2 ts=1784775198 位移0.022m Δyaw=+29.6°  ← 3.088→-2.678, 不折角会算成 -330°
    ((1.214454889, -4.895729065, 3.087952137, 1784775192), (1.236009240, -4.898807049, -2.678363323, 1784775198)),
]


class FakeProvider(PositionProvider):
    """按脚本吐 Pose 的假位姿源。脚本项 = (x, y, yaw) 或 Pose。"""

    def __init__(self, script):
        self._script = list(script)
        self._i = 0
        self.started = False
        self.stopped = False

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True

    def read_pose(self):
        item = self._script[min(self._i, len(self._script) - 1)]
        self._i += 1
        if isinstance(item, Pose):
            return item
        x, y, yaw = item
        return Pose(source="fake", frame="odom", fix=True, x=x, y=y, z=0.0, yaw=yaw)


class FakeClock:
    """可控时钟。真实时间会让"静止多久"不可复现。"""

    def __init__(self, start=0.0):
        self.now = start

    def __call__(self):
        return self.now


def test_wrap_pi_handles_pi_crossing():
    # 3.088 → -2.678 真实是 +29.6°, 不是 -330°
    assert math.degrees(wrap_pi(-2.678363323 - 3.087952137)) == pytest.approx(29.6, abs=0.2)
    assert wrap_pi(0.0) == 0.0
    # 区间为 [-π, π): 恰好 ±π 统一落到 -π。只用绝对值判定, 两者等价。
    assert abs(wrap_pi(math.pi)) == pytest.approx(math.pi)
    assert wrap_pi(math.radians(350)) == pytest.approx(math.radians(-10))


@pytest.mark.parametrize("prev,cur", REAL_JUMPS, ids=[f"jump{i}" for i in range(len(REAL_JUMPS))])
def test_detects_every_real_field_jump(prev, cur):
    """8 次现场突跳必须一次不漏地检出。"""
    px, py, pyaw, pt = prev
    cx, cy, cyaw, ct = cur
    clock = FakeClock(float(pt))
    guard = PoseHealthGuard(FakeProvider([(px, py, pyaw), (cx, cy, cyaw)]), clock=clock)

    first = guard.read_pose()
    assert first.error is None, "第一拍没有参考, 不该报错"

    clock.now = float(ct)
    second = guard.read_pose()
    assert second.error is not None and "yaw_jump" in second.error, f"漏检突跳: {prev}→{cur}"
    assert guard.stats()["yaw_jumps"] == 1


def test_normal_walking_is_not_flagged():
    """正常行走: 位移明显、转向平缓 —— 一次都不该误报。"""
    clock = FakeClock(0.0)
    script = [(i * 0.9, 0.0, 0.02 * i) for i in range(12)]  # 每拍走 0.9 m, 转 ~1.1°
    guard = PoseHealthGuard(FakeProvider(script), clock=clock)
    for _ in script:
        assert guard.read_pose().error is None
        clock.now += 5.0
    assert guard.stats()["yaw_jumps"] == 0


def test_turning_in_place_over_long_gap_is_not_flagged():
    """采样断档超过 max_gap_sec 时不判定 —— 断档期间狗可能真的转了身。"""
    clock = FakeClock(0.0)
    guard = PoseHealthGuard(FakeProvider([(0.0, 0.0, 0.0), (0.0, 0.0, 2.0)]), clock=clock)
    guard.read_pose()
    clock.now = 600.0  # 10 分钟断档
    assert guard.read_pose().error is None
    assert guard.stats()["yaw_jumps"] == 0


def test_detects_stationary_yaw_drift():
    """静止零漂: 现场实测 -1.12 °/min, 用同量级速率必须报出来。"""
    clock = FakeClock(0.0)
    rate_rad_per_sec = math.radians(-1.12) / 60.0
    script = [(0.0, 0.0, rate_rad_per_sec * (i * 5)) for i in range(30)]  # 静止 145 s
    guard = PoseHealthGuard(FakeProvider(script), clock=clock)
    errors = []
    for _ in script:
        errors.append(guard.read_pose().error)
        clock.now += 5.0
    flagged = [e for e in errors if e and "yaw_drift" in e]
    assert flagged, "静止 145 s 漂 -1.12°/min 必须报零漂"
    assert guard.stats()["last_drift_deg_min"] == pytest.approx(-1.12, abs=0.05)


def test_inner_error_is_preserved():
    """内层自己的错误(如 pose_stale)不能被健康标签顶掉。"""
    px, py, pyaw, pt = REAL_JUMPS[1][0]
    cx, cy, cyaw, ct = REAL_JUMPS[1][1]
    stale = Pose(source="fake", frame="odom", fix=True, x=cx, y=cy, z=0.0, yaw=cyaw,
                 error="pose_stale_3.0s")
    clock = FakeClock(float(pt))
    guard = PoseHealthGuard(FakeProvider([(px, py, pyaw), stale]), clock=clock)
    guard.read_pose()
    clock.now = float(ct)
    out = guard.read_pose()
    assert "pose_stale_3.0s" in out.error and "yaw_jump" in out.error


def test_no_fix_resets_reference_and_passes_through():
    """定位失效时原样透传, 且不能拿失效前后的样本硬比。"""
    clock = FakeClock(0.0)
    nofix = Pose(source="fake", frame="odom", fix=False, x=None, y=None, z=None, yaw=None,
                 error="no_pose_received_yet")
    guard = PoseHealthGuard(FakeProvider([(0.0, 0.0, 0.0), nofix, (0.0, 0.0, 2.0)]), clock=clock)
    guard.read_pose()
    clock.now += 5.0
    assert guard.read_pose().error == "no_pose_received_yet"
    clock.now += 5.0
    assert guard.read_pose().error is None, "断档后第一拍没有可比参考, 不该报突跳"


def test_start_stop_delegate_to_inner():
    inner = FakeProvider([(0.0, 0.0, 0.0)])
    guard = PoseHealthGuard(inner)
    guard.start()
    guard.stop()
    assert inner.started and inner.stopped
