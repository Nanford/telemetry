"""
INPUT : 任意 PositionProvider(装饰器模式包住它, 不改其实现)
OUTPUT: 同样的 Pose, 但在检出位姿失效时把原因写进 pose.error;
        stats() 返回累计计数, 供日志/告警使用
POS   : 阶段B 兜底。当前位姿源 rt/sportmodestate 是足式里程计, 2026-07-23 现场实测出两类失效:
          1) yaw 突跳 —— 狗原地不动(位移 <4 cm)但 yaw 单个采样内跳 30~120°。两趟共 8 次,
             累积导致同一次开机内坐标系整体转过约 74°, 一次性标定随即失效。
          2) yaw 零漂 —— 静止时 yaw 单调漂移约 -1.1 °/min。
        这两件事在线上完全静默: 日志里 point 恒为 None, 没有任何字段能看出位姿已经不可信。
        本模块把它们变成显式信号。

        【只检测, 不修正】—— 这是刻意的取舍。
        修正需要一个可信的真值参照, 而我们没有: 突跳后的真实朝向无从得知; 零漂虽然可测
        (15 个静止段实测 -1.12 °/min), 但它随步态/地面变化, 前馈补偿等于再叠一层无法验证的
        修正, 反而让错误更难发现。所以这里只打标, 由下游决定丢弃还是告警。
        根治要换成激光建图位姿(map 帧), 见 tools/probe_pose_topics.py。
"""
import math
import time
from typing import Optional, Tuple

from app.models import Pose
from app.providers.base_position import PositionProvider

# 相邻采样的判据。默认按 INTERVAL_SEC=5 的采样节奏取值。
DEFAULT_JUMP_DEG = 15.0     # 位移极小却转过这么多度 → 判为突跳
DEFAULT_STILL_M = 0.05      # 小于此位移视为"原地未动"
DEFAULT_MAX_GAP_SEC = 15.0  # 采样间隔超过此值就不做判定(中间可能真的转了身)
DEFAULT_DRIFT_DEG_MIN = 0.5  # 静止零漂超过此速率(°/min)则告警


def wrap_pi(angle: float) -> float:
    """把角度差折到 [-π, π)。不折的话 3.09 → -2.68 会被算成 -330° 而不是真实的 +30°。

    恰好 ±π 时统一落到 -π。我们只用它的绝对值与符号做判定, 两者等价, 不影响结果。
    """
    return (angle + math.pi) % (2 * math.pi) - math.pi


class PoseHealthGuard(PositionProvider):
    """装饰任意 PositionProvider, 检出 yaw 突跳与静止零漂并写进 pose.error。"""

    def __init__(
        self,
        inner: PositionProvider,
        jump_deg: float = DEFAULT_JUMP_DEG,
        still_m: float = DEFAULT_STILL_M,
        max_gap_sec: float = DEFAULT_MAX_GAP_SEC,
        drift_deg_min: float = DEFAULT_DRIFT_DEG_MIN,
        clock=time.time,
    ):
        self._inner = inner
        self._jump_deg = jump_deg
        self._still_m = still_m
        self._max_gap_sec = max_gap_sec
        self._drift_deg_min = drift_deg_min
        self._clock = clock
        self._prev: Optional[Tuple[float, float, float, float]] = None  # (x, y, yaw, t)
        # 静止零漂用一段连续静止的首末样本估计, 中途一动就重置
        self._still_anchor: Optional[Tuple[float, float, float]] = None  # (x, y, yaw), t 另存
        self._still_anchor_t: float = 0.0
        self._jump_count = 0
        self._drift_count = 0
        self._sample_count = 0
        self._last_drift_deg_min: Optional[float] = None

    def start(self) -> None:
        self._inner.start()

    def stop(self) -> None:
        self._inner.stop()

    def stats(self) -> dict:
        """累计健康计数。主循环可定期打日志, 让失效在线上可见。"""
        return {
            "samples": self._sample_count,
            "yaw_jumps": self._jump_count,
            "drift_alarms": self._drift_count,
            "last_drift_deg_min": self._last_drift_deg_min,
        }

    def _usable(self, pose: Pose) -> bool:
        """只有定位有效且三个量都在, 才有资格做健康判定。"""
        return bool(pose.fix) and None not in (pose.x, pose.y, pose.yaw)

    def _is_contiguous(self, now: float) -> bool:
        """前一拍是否近到可以做比较。断档期间狗可能真的转了身, 跨洞比较必然误判 ——
        突跳和零漂两个判据都必须服从这一条(零漂曾漏掉它, 断档 600 s 会算出 11°/min 假漂移)。"""
        if self._prev is None:
            return False
        gap = now - self._prev[3]
        return 0 < gap <= self._max_gap_sec

    def _detect_jump(self, x: float, y: float, yaw: float, now: float) -> Optional[str]:
        """相邻两拍: 几乎没动却转了一大角 → 突跳。返回错误串或 None。"""
        px, py, pyaw, pt = self._prev
        gap = now - pt
        moved = math.hypot(x - px, y - py)
        turned = math.degrees(wrap_pi(yaw - pyaw))
        if moved < self._still_m and abs(turned) > self._jump_deg:
            return f"yaw_jump_{turned:+.0f}deg_in_{gap:.0f}s"
        return None

    def _detect_drift(self, x: float, y: float, yaw: float, now: float) -> Optional[str]:
        """一段连续静止内 yaw 的漂移速率。静止被打断就重设锚点。"""
        if self._still_anchor is not None:
            ax, ay, ayaw = self._still_anchor
            if math.hypot(x - ax, y - ay) >= self._still_m:
                self._still_anchor = (x, y, yaw)  # 动了 → 重新起算
                self._still_anchor_t = now
                return None
            held = now - self._still_anchor_t
            if held >= 60.0:  # 不足 1 分钟的样本估速率噪声太大
                rate = math.degrees(wrap_pi(yaw - ayaw)) / held * 60.0
                self._last_drift_deg_min = round(rate, 3)
                if abs(rate) > self._drift_deg_min:
                    return f"yaw_drift_{rate:+.2f}deg_per_min"
            return None
        self._still_anchor = (x, y, yaw)
        self._still_anchor_t = now
        return None

    def read_pose(self) -> Pose:
        pose = self._inner.read_pose()
        if not self._usable(pose):
            self._prev = None          # 定位断了, 前一拍不再可比
            self._still_anchor = None
            return pose

        now = self._clock()
        x, y, yaw = float(pose.x), float(pose.y), float(pose.yaw)
        self._sample_count += 1

        # 首拍或断档后: 没有可比参考, 只重设基准, 本拍不做任何判定
        if not self._is_contiguous(now):
            self._prev = (x, y, yaw, now)
            self._still_anchor = (x, y, yaw)
            self._still_anchor_t = now
            return pose

        jump = self._detect_jump(x, y, yaw, now)
        if jump:
            self._jump_count += 1
            # 突跳后前一拍已无参考价值, 但静止锚点要重设, 免得把突跳当成零漂再报一次
            self._still_anchor = (x, y, yaw)
            self._still_anchor_t = now
            drift = None
        else:
            drift = self._detect_drift(x, y, yaw, now)
            if drift:
                self._drift_count += 1

        self._prev = (x, y, yaw, now)

        problem = jump or drift
        if not problem:
            return pose
        # 保留内层自己的错误(如 pose_stale), 不能被健康标签顶掉
        pose.error = f"{pose.error};{problem}" if pose.error else problem
        return pose
