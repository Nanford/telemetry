#!/usr/bin/env python3
"""
A-4-1 仓间巡检遥测模拟器 —— 全部经验参数由 2026-07-23 现场两趟真实抓包标定。

INPUT :
  - app/config/points.A-4-1.yaml        22 个垛位的 CAD 米制坐标与巡检顺序
  - 本文件顶部 CALIBRATION 常数块        从桌面两份 MQTT 抓包(趟1/趟2)拟合出的经验值
  - debug/publish_go2_telemetry_sim.py  复用其 MQTT 发布层与 .env 装载

OUTPUT:
  MQTT devices/{device_id}/telemetry，payload 格式与终端侧 go2_env_agent 一致，
  由 backend/src/ingest.js 消费。

POS   :
  现场已撤、手上没有机器狗时的唯一数据源。设计成"干净真值 + 两层可开关的污染"：

      CAD 真值(22垛/PATROL_ORDER) → 运动模型 → 环境温湿度场(22~29.8℃)
                                        ↓                    ↓
                          [--pose-mode raw_odom]     [--sensor-selfheat]
                          逆变换+26%尺度亏损           +6.4℃ 一阶自热
                          +yaw漂移+突跳                (湿度按实测斜率反相关)
                                        ↓                    ↓
                                  MQTT devices/go2_01/telemetry

  全部开关关闭 = 干净数据，22 垛全点亮，供前端演示与回放；
  打开 = 复现现场脏数据，供 backend/scripts/test-calibration.js 与 pose_health 做测试夹具。

  ⚠ 重要背景：真实抓包里的温度读数**不是库房温度**，是探头自热曲线。
  趟1 温度 25 分钟从 26.8 单调爬到 31.7，拟合 T(t)=26.60+6.40*(1-e^(-t/870s)) 的 RMSE 仅 0.095℃；
  趟2 紧接趟1 开机、起点就是 31.6℃ 且全程平坦，正是自热饱和的表现。
  故环境真值取现场实测的空间分布(见下)，自热作为可选污染层叠加，绝不能照抄抓包读数。

  **热场按现场实况建模**：南墙是落地窗，阳光是库房里最强的热源，因此温度呈西南高、东北低的
  对角梯度——读数区间 22.0~29.8℃（2026-07-27 起按用户要求，正午峰值时最凉/最热垛位恰好顶满）。
  南排垛体(y 3.55~16.85)紧贴落地窗，北排(y 20.85~35.35)
  背阴，两排均温相差约 4.1℃。读数按**垛体中心**求值而非狗的站位，否则两条相距 2m 的巡检道
  会把南北排温差抹平到 0.46℃，热力图就失去结构。

  ⚠ 两处**故意不对齐**实测统计，避免重蹈"循环论证"覆辙：

  1. 行走速度。抓包观测到的里程计速度中位 0.44 m/s，但趟2 的轨迹包围盒换算后是 42×46m，
     而巡检走廊只有 2m 宽——位移被 yaw 突跳造成的坐标系旋转抹开了，0.44 是被污染撑大的值。
     本模拟器按 0.44×1.354=0.60 m/s 设定真实步速，因此用同一套探针去量 clean 模式的输出，
     会读到约 0.26 m/s（低于抓包的 0.44）。这是预期行为，不要为了凑数去调大速度常数。

  2. 温度变化率。抓包的温度动态几乎全部由自热贡献（探头一直在升温），空间梯度被完全淹没，
     所以它的"变化率中位 0.00 ℃/min"无法用来约束热场的空间梯度。本模拟器的 clean 模式因为
     狗在真实梯度中移动，变化率会略高于抓包，属正常。
"""

from __future__ import annotations

import argparse
import math
import os
import random
import signal
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

# 复用同目录 A-1-2 模拟器已经写好的 MQTT 发布层与 .env 装载，避免重复实现。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from publish_go2_telemetry_sim import (  # noqa: E402
    MqttPublisher,
    clamp,
    current_unix_ts,
    find_default_env_file,
    load_env_file,
    parse_mqtt_url,
    round_or_none,
)


# =====================================================================
# CALIBRATION —— 全部数值来自 2026-07-23 桌面两份抓包的统计/拟合，改动前请先复算
# 趟1: 新建 文本文档 (2).txt  277 条  10:10:56~10:35:43
# 趟2: 新建 文本文档 (3).txt  213 条  10:36:10~10:55:11
# =====================================================================

# —— 采样节拍：实测 dt 中位 5s、p10 5s、p90 6s、max 6s ——
SAMPLE_DT_BASE_SEC = 5
SAMPLE_DT_JITTER_PROB = 0.22          # 约 22% 的样本间隔为 6s

# —— 温湿度缺值：实测有值率 55%/53%，连续有值段中位 2 条、连续缺值段中位 1~2 条、最长 6 条 ——
# 两态马尔可夫，稳态有值率 = P(缺→有)/(P(有→缺)+P(缺→有)) = 0.55/1.05 ≈ 52%
GAP_P_OK_TO_MISSING = 0.50            # 平均连续有值 1/0.50 = 2 条
GAP_P_MISSING_TO_OK = 0.55            # 平均连续缺值 1/0.55 ≈ 1.8 条
GAP_MAX_RUN = 6                       # 实测最长缺值段 6 条，超过则强制恢复

# —— 行走：实测里程计速度中位 0.44、p90 0.84 m/s，×尺度 1.354 → 真实中位 0.60、p90 1.14 ——
# 真实狗是变速的（p90/中位 ≈ 1.9），恒定速度会让分布形状明显失真，故每段航路独立抽取。
# 对数正态：median=exp(mu)，p90=exp(mu+1.2816*sigma)，由 p90/median=1.9 反解 sigma≈0.50。
WALK_SPEED_MEDIAN_MPS = 0.60
WALK_SPEED_LOG_SIGMA = 0.50
WALK_SPEED_MIN_MPS, WALK_SPEED_MAX_MPS = 0.25, 1.40
# —— 驻留：趟2(正常巡检)中位 16s、p90 43s，是明显的右偏分布，用对数正态而非均匀分布 ——
# 趟1 有 188s 的卡死段，属异常不纳入正常模型。sigma = ln(43/16)/1.2816 ≈ 0.77。
DWELL_MEDIAN_SEC = 16.0
DWELL_LOG_SIGMA = 0.77
DWELL_MIN_SEC, DWELL_MAX_SEC = 8.0, 90.0
STAND_JITTER_M = 0.01                 # 站立微晃，实测静止帧位移普遍 <2cm

# —— 环境温度场：南墙是落地窗，日照是库房里最强的热源 ——
# 2026-07-27 用户要求：上报读数要实际覆盖 22.0~29.8℃（替代此前按现场描述标定的 25.0~29.5℃）。
# 热场维持**西南→东北的对角梯度**结构，日照(南↔北)为主、东西向为辅，增益比 S:W=2:1。
# 增益不是按房间四角、而是按**垛体 sensing 包络**反解，使正午日照峰值时读数恰好顶满区间：
#   南排垛体中心 y=10.2 → 日照项 0.7194；北排 y=28.1 → 0.2270
#   垛位 x∈[2.21, 52.3] → 西墙项 ∈ [0.0659, 0.9605]
#   最热垛(南排最西) = F + 0.7194S + 0.9605W = 29.8
#   最凉垛(北排最东) = F + 0.2270S + 0.0659W = 22.0
#   联立 S=2W 解得 W=4.15、S=8.30、F≈19.84。
# F 低于输出下限是有意的：房间东北角的"理论气温"约 19.8℃，读数经钳制后不会落出 22℃。
#
# ⚠ 早期版本假设"东门开门热扰动使东侧最热"——与现场描述的东北最凉正相反，已废弃。
# 东门在东墙 y=18.9，若它真是热源，东侧就不该是全库最凉的地方。
TEMP_NE_MIN_C = 19.84                 # 东北角(背阴)理论基准，低于输出下限 22℃，靠钳制兜底
TEMP_SUN_GAIN_C = 8.30                # 南墙落地窗日照贡献(贴南墙 → 贴北墙)
TEMP_WEST_GAIN_C = 4.15               # 西→东贡献，与日照叠加后西南角最热
TEMP_CEILING_C = 29.8                 # 输出上限，用户要求
TEMP_OUT_MIN_C = 22.0                 # 输出下限，用户要求；夜间最凉垛会贴到该值（饱和式读数）
# 日照强度的日变化：正午后最强。做成对日照项的**乘性**因子，
# 夜间最热垛读数回落到约 28.0℃，正午顶到 29.8℃ 上限，不会冲破区间。
SUN_FACTOR_MIN = 0.7
SUN_PEAK_HOUR = 14.0                  # 南向采光的辐照峰值时刻
TEMP_NOISE_C = 0.12                   # 采样噪声幅度
# 噪声必须是低通的，不能是白噪声：实测相邻样本的温度变化率中位为 0.00 ℃/min，
# 驻留时连续多条读数完全相同（环境稳定 + 探头内部平滑）。白噪声会让读数每 5s 乱跳一次。
# AR(1) 系数 0.92 对应约 60s 的噪声相关时间。
NOISE_AR_ALPHA = 0.92

# —— 环境湿度：库房绝对含湿量近似恒定，RH 与温度反相关。实测区间 44~54% ——
RH_AT_TEMP_FLOOR = 54.0               # 最凉处(22.0℃)的相对湿度
# 斜率反算自实测：温度跨度 22.0~29.8℃ 要对应实测湿度区间 54%~44%，即 10/7.8 ≈ 1.28 %/℃
RH_PER_DEG = 1.28
RH_NOISE = 0.7                        # 同样走 AR(1) 低通；实测湿度变化率中位也是 0.00 %/min
RH_MIN, RH_MAX = 43.0, 56.0

# —— 探头自热(--sensor-selfheat)：趟1 全程温度曲线拟合，RMSE 0.095℃ ——
SELFHEAT_AMPLITUDE_C = 6.40           # 饱和偏置
SELFHEAT_TAU_SEC = 870.0              # 时间常数 14.5 min
# 湿度随自热下降的斜率取实测标定值 −1.47 %/℃（趟1 起终点：26.7℃/53.3% → 31.65℃/46.0%）。
# 不用等绝对含湿量的 Magnus 理论值(−2.55 %/℃)：探头非密封、狗行走时有气流交换，理论值会明显偏低。
SELFHEAT_RH_SLOPE_PER_DEG = -1.47

# —— 里程计退化(--pose-mode raw_odom)：趟2 三个照片锚点解出的相似变换 ——
# 正变换 odom→CAD: X = scale*R(theta)*x + t，模拟器走它的逆过程。
SOLVED_THETA_RAD = 0.907367433
SOLVED_SCALE = 1.35405854
SOLVED_TX = 37.8488
SOLVED_TY = 39.7158
ODOM_SCALE_LOSS = 1.0 / SOLVED_SCALE  # ≈0.7385，即真实走 1m 里程计只报 0.735m（抛光水泥地打滑）
YAW_DRIFT_DEG_PER_MIN = -2.0          # 实测 趟1 −2.95 / 趟2 +1.08，取中间偏趟1
YAW_JUMPS_PER_MIN = 0.15              # 实测每趟约 3 次 / 20 分钟
YAW_JUMP_MIN_DEG, YAW_JUMP_MAX_DEG = 30.0, 120.0

# —— 告警注入(--anomaly)：22~29.8℃ 全程低于 32℃ 阈值，不注入则告警链路一次都不触发 ——
# 热点是**空间**属性：以指定垛位为中心的高斯热羽，狗走远了读数自然回落。
# 早期版本用"命中后持续 N 秒"实现，结果热点跟着狗跑，把沿途垛位全染成异常——已废弃。
ANOMALY_TEMP_C = 32.5
ANOMALY_SIGMA_M = 2.5                 # 热羽的空间尺度，约一个垛位宽度

DEFAULT_MQTT_URL = "mqtt://127.0.0.1:1883"
DEFAULT_DEVICE_ID = "go2_01"
AREA_ID = "A-4-1"
AREA_WIDTH_M = 55.99                  # CAD 实测，与 backend/src/a41-layout.js 保持一致
AREA_HEIGHT_M = 36.35
DOOR_X, DOOR_Y = 55.99, 18.9          # 东门中心，巡检起点与终点
AISLE_MID_Y = 18.85                   # 中央通道中线，用来判断垛位属南排还是北排
# 垛体所占区间的中心 y（与 backend/src/a41-layout.js 的 BANDS 一致）：
# 南排 (3.55+16.85)/2、北排 (20.85+35.35)/2。南排紧贴落地窗，北排背阴。
BAND_CENTROID_Y = {"S": 10.2, "N": 28.1}
# 垛体所占的完整 y 区间（与 backend/src/a41-layout.js 的 BANDS 一致），用于算探入深度。
BAND_RANGE_Y = {"S": (3.55, 16.85), "N": (20.85, 35.35)}

# —— 梳齿路线：拐进可通行的垛间通道（2026-07-28 按用户手绘路径图新增）——
# CAD 里相邻垛的中心距只有两档：约 3.6~3.8m（垛宽 3.02 → 净缝 0.58~0.77m，狗进不去）
# 和 5.5m 以上（净宽 ≥2.49m，可通行；22↔01 之间那条净宽 6.28m）。阈值 4.5m 把两档分开。
GAP_MIN_CENTER_SPACING_M = 4.5
# 探入深度占垛体进深的比例。0.5 = 走到垛体中线，正好落在 BAND_CENTROID_Y 上，
# 于是通道探入点的读数位置与该排垛位的取值位置同深度，热场结构不会被压平。
GAP_PROBE_DEPTH_RATIO = 0.5
GAP_PROBE_RADIUS_M = 0.9              # 与垛位判定半径一致；通道净宽 ≥2.49m，不会误匹配到邻垛

# —— 转弯：圆角 + 减速 ——
# 采样固定 5s 一条，按中位步速 0.6m/s 算，相邻两条采样间隔 3m 以上，而通道净宽只有 2.5m。
# 若按巡航速度直接拐进通道，一个步长就会从中央通道跨到通道深处，轨迹连线便斜着切过垛体
# （2026-07-28 用户实测截图确认）。真实四足机器人进窄道本来就要减速、近乎原地转向，
# 因此转弯段单独给一个低速，让至少 1~2 条采样落在圆角上，画出来才贴着通道走。
TURN_RADIUS_M = 0.8                   # 转弯圆角半径，小于通道净宽的一半(1.245m)
TURN_SPEED_MPS = 0.25                 # 圆角段速度：0.25×5s = 1.25m，与圆角弧长 1.26m 相当
TURN_ARC_POINTS = 3                   # 每个圆角展开成几个航点（不含首尾直线段端点）


# =====================================================================
# 点位装载
# =====================================================================

def load_points(path: Path) -> List[Dict[str, Any]]:
    """读取 A-4-1 点位 yaml，按 patrol_seq 升序返回，即东门进入后的实际行走顺序。"""
    if not path.exists():
        raise SystemExit(f"点位配置不存在: {path}")

    with path.open("r", encoding="utf-8") as handle:
        cfg = yaml.safe_load(handle)

    points = cfg.get("points") or []
    if not points:
        raise SystemExit(f"点位配置为空: {path}")

    missing = [p.get("id") for p in points if p.get("patrol_seq") is None]
    if missing:
        raise SystemExit(f"以下点位缺少 patrol_seq，无法排出巡检顺序: {missing}")

    return sorted(points, key=lambda p: int(p["patrol_seq"]))


def row_of(point: Dict[str, Any]) -> str:
    """按 y 判断点位属北排还是南排。"""
    return "N" if float(point["y"]) > AISLE_MID_Y else "S"


def _fillet(
    corner_x: float, corner_y: float,
    dir_in: float, dir_out: float,
    radius: float = TURN_RADIUS_M,
    count: int = TURN_ARC_POINTS,
) -> List[Dict[str, Any]]:
    """
    把一个 90° 直角拐点展开成一段圆弧航点。

    dir_in  : 进入拐点时沿 x 的行进方向（+1 向东 / -1 向西）
    dir_out : 离开拐点时沿 y 的行进方向（+1 向北 / -1 向南）

    圆心取在拐角内侧：沿 x 回退 radius、沿 y 前进 radius。圆弧从直线段切点扫到另一个切点，
    即 (corner_x - dir_in*r, corner_y) → (corner_x, corner_y + dir_out*r)。
    """
    cx = corner_x - dir_in * radius
    cy = corner_y + dir_out * radius
    start_angle = math.atan2(-dir_out, 0.0)     # 圆心指向进入侧切点
    end_angle = math.atan2(0.0, dir_in)         # 圆心指向离开侧切点
    # 取劣弧（|Δ|=90°），方向由 dir_in×dir_out 决定
    sweep = end_angle - start_angle
    while sweep > math.pi:
        sweep -= 2 * math.pi
    while sweep < -math.pi:
        sweep += 2 * math.pi

    arc: List[Dict[str, Any]] = []
    for step in range(count + 1):
        angle = start_angle + sweep * step / count
        arc.append({
            "id": None,
            "x": round(cx + radius * math.cos(angle), 3),
            "y": round(cy + radius * math.sin(angle), 3),
            "kind": "turn",
        })
    return arc


def build_patrol_route(
    points: List[Dict[str, Any]],
    depth_ratio: float = GAP_PROBE_DEPTH_RATIO,
) -> List[Dict[str, Any]]:
    """
    在 22 垛的原巡检顺序上插入垛间通道探入点，形成"梳齿"路线。

    points 已按 patrol_seq 排好（东门进 → 南排东到西 → 西端换道 → 北排西到东）。
    逐对检查相邻两垛：同排、且中心距 ≥ GAP_MIN_CENTER_SPACING_M 时，说明中间那条垛间
    通道是可通行的，就在两垛之间插一个探入点——狗从中央通道拐进去、走到垛体进深的
    depth_ratio 处采集，再退出来奔下一垛。南北各 5 条可通行通道，共 10 个探入点。

    探入点 id 用 `A-4-1-G{nn}` 前缀，与垛位号（两位数字）区分开，避免以后加垛时撞号。
    ⚠ 这 10 个 id 目前只存在于模拟器：backend/src/a41-layout.js 的 points 里没有它们，
    所以数据会正常入库，但前端热力图（只画已知 point_id）暂时不显示。要显示需同步布局。
    """
    if not points:
        return []

    route: List[Dict[str, Any]] = []
    probe_seq = 0

    for left, right in zip(points, points[1:]):
        route.append(left)

        if row_of(left) != row_of(right):
            continue  # 西端换道，不是垛间通道
        spacing = abs(float(right["x"]) - float(left["x"]))
        if spacing < GAP_MIN_CENTER_SPACING_M:
            continue  # 净缝不足 1m，狗进不去

        probe_seq += 1
        row = row_of(left)
        band_y0, band_y1 = BAND_RANGE_Y[row]
        depth = (band_y1 - band_y0) * depth_ratio
        gap_x = round((float(left["x"]) + float(right["x"])) / 2, 3)
        lane_y = float(left["y"])
        dir_in = 1.0 if float(right["x"]) > float(left["x"]) else -1.0   # 沿中央通道的行进方向
        dir_out = 1.0 if row == "N" else -1.0                            # 拐进通道后的朝向

        # 进弯圆角 → 通道深处探入点 → 出弯圆角。狗始终待在中央通道或垛间通道里；
        # 少了这两段圆角，轨迹会从垛位斜着拉向通道深处，等于**从垛体上穿过去**。
        # 圆角本身也是真实的：四足机器人做不出零半径的 90° 转向。
        route.extend(_fillet(gap_x, lane_y, dir_in, dir_out))
        route.append({
            "id": f"{AREA_ID}-G{probe_seq:02d}",
            "zone_id": left["zone_id"],
            "name": f"垛间通道 {str(left['id'])[-2:]}↔{str(right['id'])[-2:]}",
            "x": gap_x,
            "y": round(band_y0 + depth if row == "N" else band_y1 - depth, 3),
            "radius": GAP_PROBE_RADIUS_M,
            "kind": "gap",
            "row": row,
        })
        # 出弯：从通道里回到中央通道，进入方向与出去方向对调，圆角镜像回来
        route.extend(reversed(_fillet(gap_x, lane_y, -dir_in, dir_out)))

    route.append(points[-1])
    return route


# =====================================================================
# 环境温湿度场
# =====================================================================

class ThermalField:
    """
    库房二维稳态热场：西南最热、东北最凉的对角梯度。

    现场实况（2026-07-27 用户描述）：**南墙是落地窗，阳光是库房里最强的热源**，
    东北区域背阴最凉，西南区域最热。所以主梯度沿南北向（日照），东西向为辅。
    读数区间按用户要求定为 22.0~29.8℃，正午峰值时最凉垛(北排最东)触及 22.0℃、
    最热垛(南排最西)触及 29.8℃；房间东北角理论气温更低(约 19.8℃)，由钳制兜底。

    日照强度按钟点做乘性调制（南向采光正午后最强），夜间最热垛回落到约 28.0℃。
    """

    def __init__(self, rng: random.Random, hour_of_day: Optional[float] = None):
        self._rng = rng
        # 南向采光的辐照因子：SUN_PEAK_HOUR 达峰，夜间衰减到 SUN_FACTOR_MIN。
        hour = hour_of_day if hour_of_day is not None else time.localtime().tm_hour
        phase = math.cos(2.0 * math.pi * (hour - SUN_PEAK_HOUR) / 24.0)
        self._sun_factor = SUN_FACTOR_MIN + (1.0 - SUN_FACTOR_MIN) * max(0.0, phase)
        # AR(1) 噪声状态：读数在驻留期间应保持稳定，而不是每 5s 独立抖一次
        self._temp_noise = 0.0
        self._rh_noise = 0.0

    def _next_noise(self, previous: float, sigma: float) -> float:
        """一阶自回归噪声：n_t = a*n_{t-1} + sqrt(1-a^2)*sigma*e，稳态标准差仍为 sigma。"""
        innovation = math.sqrt(1.0 - NOISE_AR_ALPHA ** 2) * self._rng.gauss(0.0, sigma)
        return NOISE_AR_ALPHA * previous + innovation

    @staticmethod
    def _south_term(y: float) -> float:
        """贴南墙(落地窗)为 1、贴北墙为 0 的归一化项。"""
        return clamp(1.0 - y / AREA_HEIGHT_M, 0.0, 1.0)

    @staticmethod
    def _west_term(x: float) -> float:
        """贴西墙为 1、贴东墙为 0 的归一化项。"""
        return clamp(1.0 - x / AREA_WIDTH_M, 0.0, 1.0)

    def temperature_at(self, x: float, y: float) -> float:
        """该坐标处的环境温度真值(℃)，不含探头自热。每调用一次推进一步噪声。"""
        self._temp_noise = self._next_noise(self._temp_noise, TEMP_NOISE_C)
        base = (
            TEMP_NE_MIN_C
            + TEMP_SUN_GAIN_C * self._sun_factor * self._south_term(y)
            + TEMP_WEST_GAIN_C * self._west_term(x)
            + self._temp_noise
        )
        # 场基准 19.84℃ 低于输出下限，钳制保证读数落在用户要求的 22.0~29.8℃ 区间。
        return clamp(base, TEMP_OUT_MIN_C, TEMP_CEILING_C)

    def humidity_at(self, temp_c: float) -> float:
        """相对湿度真值(%)。绝对含湿量近似恒定，故与温度线性反相关。"""
        self._rh_noise = self._next_noise(self._rh_noise, RH_NOISE)
        base = (
            RH_AT_TEMP_FLOOR
            - RH_PER_DEG * (temp_c - TEMP_OUT_MIN_C)
            + self._rh_noise
        )
        return clamp(base, RH_MIN, RH_MAX)


class SelfHeatModel:
    """
    探头自热污染层。开机后读数按一阶惯性偏离环境真值，14.5 分钟时间常数、饱和 +6.4℃。

    模型直接来自趟1 全程拟合（RMSE 0.095℃）。湿度按实测斜率跟随下降，而非理论 Magnus 换算。
    """

    def __init__(self, amplitude_c: float, tau_sec: float):
        self._amplitude_c = amplitude_c
        self._tau_sec = max(1.0, tau_sec)

    def bias_at(self, elapsed_sec: float) -> float:
        """开机 elapsed_sec 秒后的温度偏置(℃)。"""
        return self._amplitude_c * (1.0 - math.exp(-elapsed_sec / self._tau_sec))

    def apply(self, temp_c: float, rh: float, elapsed_sec: float) -> Tuple[float, float]:
        bias = self.bias_at(elapsed_sec)
        return temp_c + bias, rh + SELFHEAT_RH_SLOPE_PER_DEG * bias


class SensorGapModel:
    """
    温湿度缺值层。实测约一半样本的 temp/rh 为 None，且成段丢失而非独立随机丢。

    两态马尔可夫复现这个结构：平均连续有值 2 条、连续缺值 1.8 条，缺值段超过 6 条强制恢复。
    """

    def __init__(self, rng: random.Random):
        self._rng = rng
        self._has_value = True
        self._run_length = 0

    def next_has_value(self) -> bool:
        self._run_length += 1
        if not self._has_value and self._run_length >= GAP_MAX_RUN:
            # 实测最长缺值段就是 6 条，不让模拟数据出现更长的空窗。
            self._has_value = True
            self._run_length = 0
            return True

        transition = GAP_P_OK_TO_MISSING if self._has_value else GAP_P_MISSING_TO_OK
        if self._rng.random() < transition:
            self._has_value = not self._has_value
            self._run_length = 0
        return self._has_value


# =====================================================================
# 运动模型
# =====================================================================

@dataclass
class MotionState:
    x: float
    y: float
    yaw: float
    moving: bool
    lap: int          # 已完成的巡检轮次
    finished: bool    # 是否走完了请求的全部轮次


class PatrolMotion:
    """
    沿 PATROL_ORDER 巡检：东门进入 → 南排东到西 → 西端换道 → 北排西到东 → 返回东门。

    路线为点位间的直线段。行走速度与驻留时长都按实测分布逐段抽取，而不是取固定值——
    真实狗的速度 p90/中位 ≈ 1.9、驻留时长明显右偏，写死常数会让统计特征失真。
    驻留期间位置只做 ±1cm 微晃，与实测静止帧一致。
    """

    def __init__(self, points: List[Dict[str, Any]], rng: random.Random, laps: int,
                 dwell_min_sec: float = DWELL_MIN_SEC):
        self._rng = rng
        self._laps = laps
        self._dwell_min_sec = dwell_min_sec
        # 航点序列：东门 → 22 个垛位 → 东门。首尾同为东门，故一轮结束可无缝接下一轮。
        # 航点为 (x, y, point_id, kind)。id 为 None 的是纯转向点（圆角上的采样位置），
        # 只改变行走折线，不驻留也不采集；kind='turn' 的段按 TURN_SPEED_MPS 减速通过。
        self._waypoints: List[Tuple[float, float, Optional[str], str]] = [
            (DOOR_X, DOOR_Y, None, "door")
        ]
        self._waypoints += [
            (
                float(p["x"]), float(p["y"]),
                None if p.get("id") is None else str(p["id"]),
                str(p.get("kind") or "bay"),
            )
            for p in points
        ]
        self._waypoints.append((DOOR_X, DOOR_Y, None, "door"))

        self._index = 0                    # 当前所在航点
        self._x, self._y = self._waypoints[0][0], self._waypoints[0][1]
        self._yaw = math.pi                # 东门朝西，准备进库
        self._dwell_left = 0.0
        self._lap = 0
        self._finished = False
        self._speed = self._speed_for(self._waypoints[1])

    def _speed_for(self, target: Tuple[float, float, Optional[str], str]) -> float:
        """朝转向点走时用转弯低速，其余按实测分布抽取巡航速度。"""
        return TURN_SPEED_MPS if target[3] == "turn" else self._pick_speed()

    def _pick_dwell(self) -> float:
        """
        对数正态驻留时长，中位 16s、p90 43s，与趟2 实测分布一致。

        注意：终端侧判定 point_valid 需要连续 DWELL_COUNT=3 条、INTERVAL_SEC=5s，即至少站满 15s。
        而实测驻留中位仅 16s，所以按真实分布跑，约有三成垛位达不到 point_valid——这是现场的
        真实约束，不是模拟器缺陷。要让 22 垛全部点亮，请抬高 dwell_min_sec（见 --dwell-min）。
        """
        value = math.exp(math.log(DWELL_MEDIAN_SEC) + self._rng.gauss(0.0, DWELL_LOG_SIGMA))
        return clamp(value, self._dwell_min_sec, DWELL_MAX_SEC)

    def _pick_speed(self) -> float:
        """对数正态行走速度，中位 0.60 m/s、p90 约 1.14 m/s，逐段重抽。"""
        value = math.exp(math.log(WALK_SPEED_MEDIAN_MPS) + self._rng.gauss(0.0, WALK_SPEED_LOG_SIGMA))
        return clamp(value, WALK_SPEED_MIN_MPS, WALK_SPEED_MAX_MPS)

    def step(self, dt: float) -> MotionState:
        """推进 dt 秒。先消耗驻留时间，剩余时间用于向下一个航点行走。"""
        if self._finished:
            return MotionState(self._x, self._y, self._yaw, False, self._lap, True)

        remaining = dt
        moved = False

        # 1) 驻留：站在垛位前采集，位置只做微晃
        if self._dwell_left > 0.0:
            consumed = min(remaining, self._dwell_left)
            self._dwell_left -= consumed
            remaining -= consumed
            self._x += self._rng.gauss(0.0, STAND_JITTER_M)
            self._y += self._rng.gauss(0.0, STAND_JITTER_M)

        # 2) 行走：把剩余时间换算成沿直线段前进的距离，可跨越多个航点
        while remaining > 1e-6 and not self._finished:
            target = self._waypoints[self._index + 1]
            dx, dy = target[0] - self._x, target[1] - self._y
            distance = math.hypot(dx, dy)

            if distance > 1e-6:
                self._yaw = math.atan2(dy, dx)

            budget = self._speed * remaining
            if budget < distance:
                self._x += dx * (budget / distance)
                self._y += dy * (budget / distance)
                moved = True
                break

            # 抵达该航点，按下一段的性质重取速度（转向段减速）
            self._x, self._y = target[0], target[1]
            moved = moved or distance > 1e-6
            remaining -= distance / self._speed
            self._index += 1
            if self._index < len(self._waypoints) - 1:
                self._speed = self._speed_for(self._waypoints[self._index + 1])

            if self._index >= len(self._waypoints) - 1:
                # 回到东门，一轮巡检完成
                self._lap += 1
                if self._laps > 0 and self._lap >= self._laps:
                    self._finished = True
                    break
                self._index = 0
                self._x, self._y = self._waypoints[0][0], self._waypoints[0][1]
                continue

            if target[2] is not None:
                # 停在垛位前采集，本次 step 的剩余时间转入驻留
                self._dwell_left = self._pick_dwell()
                consumed = min(remaining, self._dwell_left)
                self._dwell_left -= consumed
                remaining -= consumed
                moved = False

        return MotionState(self._x, self._y, self._yaw, moved, self._lap, self._finished)


class PointMatcher:
    """按 radius 就近匹配垛位。连续命中同一垛达到 dwell_count 条后升级为 point_valid。"""

    def __init__(self, points: List[Dict[str, Any]], dwell_count: int):
        # 纯转向点（id=None）不参与匹配，否则狗路过通道口就会被算成"命中了某个点位"。
        self._points = [p for p in points if p.get("id") is not None]
        self._dwell_count = max(1, dwell_count)
        self._active_id: Optional[str] = None
        self._active_count = 0

    def match(self, x: float, y: float) -> Tuple[Optional[str], Optional[str], str, Optional[Dict[str, Any]]]:
        """
        返回 (zone_id, point_id, sample_type, point)。未命中任何垛位时为 (None, None, 'timed', None)。

        第四项是命中的垛位配置，供热场按垛体中心（而非狗的站位）求值使用。
        """
        nearest = min(self._points, key=lambda p: math.hypot(float(p["x"]) - x, float(p["y"]) - y))
        distance = math.hypot(float(nearest["x"]) - x, float(nearest["y"]) - y)

        if distance > float(nearest["radius"]):
            self._active_id = None
            self._active_count = 0
            return None, None, "timed", None

        point_id = str(nearest["id"])
        if point_id == self._active_id:
            self._active_count += 1
        else:
            self._active_id = point_id
            self._active_count = 1

        sample_type = "point_valid" if self._active_count >= self._dwell_count else "timed"
        return str(nearest["zone_id"]), point_id, sample_type, nearest


def reading_position(dog_x: float, dog_y: float, point: Optional[Dict[str, Any]]) -> Tuple[float, float]:
    """
    读数所代表的位置。

    狗站在中央通道采集，但一条读数描述的是它面对的那一排**垛体**的储存状况，
    而不是通道里的空气。两条巡检道只相距 2m，若按站位求温度，南北排的温差会被压到
    0.16℃，热力图将完全看不出"南排贴落地窗、北排背阴"的结构。
    因此命中垛位时按该排垛体中心求值，途中未命中时才用狗的实际站位。
    """
    if point is None:
        return dog_x, dog_y
    row = "N" if float(point["y"]) > AISLE_MID_Y else "S"
    return float(point["x"]), BAND_CENTROID_Y[row]


# =====================================================================
# 里程计退化层
# =====================================================================

class OdometryDegrader:
    """
    把 CAD 米制真值退化成现场那种"足式里程计"读数，复现三个叠加的失效。

    1) 尺度亏损：真实走 1m 只报 0.735m（抛光水泥地打滑）
    2) yaw 零漂：静止时 yaw 单调漂移
    3) yaw 突跳：驻留期间位移 <4cm 却跳 30~120°，累积导致同一次开机内坐标系整体转向

    位移在**漂移后的坐标系**里累加，所以突跳之后的整段轨迹会整体歪掉——这正是现场
    一次性静态标定必然失效的原因，也是 calibration.json 至今故意不写的原因。

    把 drift/jump 都设为 0 时，输出与 SOLVED 相似变换严格互逆，可作为标定算法的
    精确恢复夹具：solve_calibration.py 应能解回 theta/scale/tx/ty 原值。
    """

    def __init__(self, rng: random.Random, drift_deg_per_min: float, jumps_per_min: float):
        self._rng = rng
        self._drift_rad_per_sec = math.radians(drift_deg_per_min) / 60.0
        self._jumps_per_min = jumps_per_min
        self._frame_rot = -SOLVED_THETA_RAD   # 正变换的逆旋转；drift/jump 在此基础上累加
        self._last_true: Optional[Tuple[float, float]] = None
        self._odom_x = 0.0
        self._odom_y = 0.0
        self.jump_count = 0

    def _seed_origin(self, true_x: float, true_y: float) -> None:
        """起点按 SOLVED 的逆变换落位，使无漂移时正变换能原样解回 tx/ty。"""
        cos_t, sin_t = math.cos(-SOLVED_THETA_RAD), math.sin(-SOLVED_THETA_RAD)
        shifted_x, shifted_y = true_x - SOLVED_TX, true_y - SOLVED_TY
        self._odom_x = (cos_t * shifted_x - sin_t * shifted_y) / SOLVED_SCALE
        self._odom_y = (sin_t * shifted_x + cos_t * shifted_y) / SOLVED_SCALE

    def degrade(self, true_x: float, true_y: float, true_yaw: float, dt: float, moving: bool
                ) -> Tuple[float, float, float]:
        """输入 CAD 真值，返回退化后的 (x, y, yaw) 里程计读数。"""
        if self._last_true is None:
            self._seed_origin(true_x, true_y)
            self._last_true = (true_x, true_y)
            return self._odom_x, self._odom_y, self._wrap(true_yaw + self._frame_rot)

        # yaw 零漂：持续累积，行走与静止都在漂
        self._frame_rot += self._drift_rad_per_sec * dt

        # yaw 突跳：实测只在几乎不动时发生
        if not moving and self._rng.random() < self._jumps_per_min * dt / 60.0:
            magnitude = self._rng.uniform(YAW_JUMP_MIN_DEG, YAW_JUMP_MAX_DEG)
            self._frame_rot += math.radians(magnitude) * self._rng.choice([-1.0, 1.0])
            self.jump_count += 1

        # 真实位移旋进当前漂移坐标系，并按尺度亏损缩短
        dx = true_x - self._last_true[0]
        dy = true_y - self._last_true[1]
        self._last_true = (true_x, true_y)

        cos_r, sin_r = math.cos(self._frame_rot), math.sin(self._frame_rot)
        self._odom_x += (cos_r * dx - sin_r * dy) * ODOM_SCALE_LOSS
        self._odom_y += (sin_r * dx + cos_r * dy) * ODOM_SCALE_LOSS

        return self._odom_x, self._odom_y, self._wrap(true_yaw + self._frame_rot)

    @staticmethod
    def _wrap(angle: float) -> float:
        """把角度规整到 (-pi, pi]，与真实上报一致。"""
        while angle > math.pi:
            angle -= 2.0 * math.pi
        while angle <= -math.pi:
            angle += 2.0 * math.pi
        return angle


# =====================================================================
# Payload
# =====================================================================

def build_payload(
    device_id: str,
    ts: int,
    pose: Tuple[float, float, float],
    pose_frame: str,
    zone_id: Optional[str],
    point_id: Optional[str],
    sample_type: str,
    temp_c: Optional[float],
    rh: Optional[float],
) -> Dict[str, Any]:
    """与终端侧 go2_env_agent 上报格式保持一致，供 backend/src/ingest.js 直接消费。"""
    x, y, yaw = pose
    return {
        "device_id": device_id,
        "ts": ts,
        "temp_c": temp_c,
        "rh": rh,
        # 未命中垛位时 zone_id 回落到 area_id，ingest 才不会把样本归到空 zone。
        "zone_id": zone_id or AREA_ID,
        "area_id": AREA_ID,
        "gps": {"fix": False, "lat": None, "lon": None, "fallback": False},
        "pose": {
            "source": "go2_slam",
            "frame": pose_frame,
            "fix": True,
            "x": round_or_none(x),
            "y": round_or_none(y),
            "z": 0.0,
            "yaw": round_or_none(yaw),
        },
        "point_id": point_id,
        "sample_type": sample_type,
        "errors": [],
    }


# =====================================================================
# CLI
# =====================================================================

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="A-4-1 巡检遥测模拟器（经验参数由 2026-07-23 现场两趟真实抓包标定）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
常用组合：
  # 干净数据，前端演示/回放（默认）
  python debug/sim_a41_patrol.py --mqtt-url mqtt://127.0.0.1:1883

  # 20 倍速跑 1 轮，快速灌一批演示数据
  python debug/sim_a41_patrol.py --laps 1 --time-scale 20

  # 复现现场脏数据，测标定与 pose_health
  python debug/sim_a41_patrol.py --pose-mode raw_odom --sensor-selfheat

  # 标定算法的精确恢复夹具：应能解回 theta/scale/tx/ty 原值
  python debug/sim_a41_patrol.py --pose-mode raw_odom --yaw-drift 0 --yaw-jumps 0 --dry-run

  # 演示告警链路
  python debug/sim_a41_patrol.py --anomaly A-4-1-15
""",
    )
    parser.add_argument("--device-id", default=DEFAULT_DEVICE_ID, help="上报的设备 id。")
    parser.add_argument("--points-file", default=None, help="点位 yaml 路径，默认 app/config/points.A-4-1.yaml。")
    parser.add_argument("--mqtt-url", default=None, help=f"MQTT 地址，默认取 MQTT_URL 环境变量或 {DEFAULT_MQTT_URL}。")
    parser.add_argument("--username", default=None, help="MQTT 用户名，默认取 MQTT_USERNAME。")
    parser.add_argument("--password", default=None, help="MQTT 密码，默认取 MQTT_PASSWORD。")
    parser.add_argument("--topic", default=None, help="遥测 topic，默认 devices/{device_id}/telemetry。")
    parser.add_argument("--status-topic", default=None, help="状态 topic，默认 devices/{device_id}/status。")
    parser.add_argument("--qos", type=int, choices=[0, 1, 2], default=1, help="发布 QoS。")
    parser.add_argument("--env-file", default=None, help=".env 路径，默认自动向上寻找 backend/.env。")

    parser.add_argument("--laps", type=int, default=0, help="巡检轮数，0 表示一直跑。")
    parser.add_argument("--count", type=int, default=0, help="发够 N 条后停止，0 表示不限。")
    parser.add_argument("--dwell-count", type=int, default=3,
                        help="连续命中几条后判定为 point_valid，与终端侧 DWELL_COUNT 一致。")
    parser.add_argument(
        "--dwell-min", type=float, default=DWELL_MIN_SEC,
        help="每垛最短驻留秒数。默认 8s 沿用实测分布，此时约三成垛位达不到 point_valid"
             "（现场真实约束：判定需站满 dwell_count×5s）。演示要求 22 垛全点亮时设为 18 以上。",
    )
    parser.add_argument(
        "--time-scale", type=float, default=1.0,
        help="回放倍速，只压缩真实等待时间。ts 始终按仿真时间推进，所以高倍速下"
             "样本间隔仍是 5~6s，不会挤在同一秒里。",
    )
    parser.add_argument(
        "--start-offset-min", type=float, default=0.0,
        help="把起始 ts 往前挪 N 分钟。高倍速回放时用它把数据落到过去的时间窗内，"
             "否则 ts 会跑到未来（例如 --time-scale 20 --start-offset-min 15）。",
    )

    parser.add_argument(
        "--no-comb", action="store_true",
        help="退回旧路线：只沿中央通道直走 22 垛，不拐进垛间通道。",
    )
    parser.add_argument(
        "--probe-depth", type=float, default=GAP_PROBE_DEPTH_RATIO,
        help="梳齿路线探入垛间通道的深度，占垛体进深的比例。"
             f"默认 {GAP_PROBE_DEPTH_RATIO}（走一半，正好到垛体中线）。",
    )

    parser.add_argument(
        "--pose-mode", choices=["clean", "raw_odom"], default="clean",
        help="clean=直接输出 CAD 米制真值(frame=map)；raw_odom=叠加尺度亏损与 yaw 漂移/突跳(frame=odom)。",
    )
    parser.add_argument("--yaw-drift", type=float, default=YAW_DRIFT_DEG_PER_MIN,
                        help="raw_odom 下的 yaw 零漂速率(°/min)，实测 趟1 −2.95、趟2 +1.08。")
    parser.add_argument("--yaw-jumps", type=float, default=YAW_JUMPS_PER_MIN,
                        help="raw_odom 下的 yaw 突跳频率(次/min)，实测约 0.15。")

    parser.add_argument("--sensor-selfheat", action="store_true",
                        help="叠加探头自热污染层，复现抓包里 26.8→31.7℃ 的假升温。")
    parser.add_argument("--selfheat-amplitude", type=float, default=SELFHEAT_AMPLITUDE_C,
                        help="自热饱和偏置(℃)，趟1 拟合值 6.40。")
    parser.add_argument("--selfheat-tau", type=float, default=SELFHEAT_TAU_SEC,
                        help="自热时间常数(秒)，趟1 拟合值 870。")
    parser.add_argument("--no-gaps", action="store_true",
                        help="关闭温湿度缺值层，每条样本都带读数（实测有值率约 54%%）。")

    parser.add_argument(
        "--anomaly", default=None,
        help="注入告警：在指定垛位（如 A-4-1-15）放一个 32.5℃ 的固定热点，狗走近才读到高温。"
             "注意告警能否触发取决于 alert_rules 的 trigger 时长窗口——单次驻留只有几十秒，"
             "窗口更长时需要多跑几轮（--laps）才会开出告警。",
    )
    parser.add_argument("--anomaly-temp", type=float, default=ANOMALY_TEMP_C, help="热点中心温度(℃)。")
    parser.add_argument("--anomaly-sigma", type=float, default=ANOMALY_SIGMA_M,
                        help="热羽的空间尺度(米)，读数随距离按高斯衰减回落到环境温度。")

    parser.add_argument("--seed", type=int, default=None, help="随机种子，用于复现同一批数据。")
    parser.add_argument("--dry-run", action="store_true", help="只打印 payload，不连 MQTT。")
    return parser


def resolve_points_file(explicit: Optional[str]) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    return Path(__file__).resolve().parents[1] / "app" / "config" / "points.A-4-1.yaml"


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    env_file = Path(args.env_file).expanduser().resolve() if args.env_file else find_default_env_file()
    load_env_file(env_file)

    if args.time_scale <= 0:
        raise SystemExit("--time-scale 必须大于 0")

    points = load_points(resolve_points_file(args.points_file))

    anomaly_point: Optional[Dict[str, Any]] = None
    if args.anomaly:
        anomaly_point = next((p for p in points if str(p["id"]) == args.anomaly), None)
        if anomaly_point is None:
            raise SystemExit(f"--anomaly 指定的垛位不存在: {args.anomaly}")

    rng = random.Random(args.seed)
    # 默认走梳齿路线（拐进垛间通道）；--no-comb 退回原来的"只沿中央通道直走"。
    route = points if args.no_comb else build_patrol_route(points, args.probe_depth)
    probe_count = len(route) - len(points)
    motion = PatrolMotion(route, rng, laps=max(0, args.laps), dwell_min_sec=args.dwell_min)
    matcher = PointMatcher(route, dwell_count=args.dwell_count)
    thermal = ThermalField(rng)
    gaps = SensorGapModel(rng)
    selfheat = SelfHeatModel(args.selfheat_amplitude, args.selfheat_tau) if args.sensor_selfheat else None
    degrader = (
        OdometryDegrader(rng, args.yaw_drift, args.yaw_jumps)
        if args.pose_mode == "raw_odom" else None
    )

    topic = args.topic or f"devices/{args.device_id}/telemetry"
    status_topic = args.status_topic or f"devices/{args.device_id}/status"

    publisher: Optional[MqttPublisher] = None
    if not args.dry_run:
        # 三个凭据都按 命令行 > 环境变量(含 .env) > 默认值 回落，与 publish_go2_telemetry_sim 保持一致。
        mqtt_url = args.mqtt_url or os.environ.get("MQTT_URL") or DEFAULT_MQTT_URL
        username = args.username if args.username is not None else os.environ.get("MQTT_USERNAME")
        password = args.password if args.password is not None else os.environ.get("MQTT_PASSWORD")
        cfg = parse_mqtt_url(mqtt_url, username, password)
        publisher = MqttPublisher(
            cfg,
            client_id=f"sim-a41-{args.device_id}-{os.getpid()}",
            status_topic=status_topic,
            qos=args.qos,
        )
        print(f"[已连接] {cfg.host}:{cfg.port}  发布到 {topic}")
    else:
        print(f"[dry-run] 不连 MQTT，仅打印 {topic} 的 payload")

    pose_frame = "map" if args.pose_mode == "clean" else "odom"
    print(
        f"[配置] 位姿={args.pose_mode}(frame={pose_frame})  自热={'开' if selfheat else '关'}  "
        f"缺值={'关' if args.no_gaps else '开'}  倍速={args.time_scale}x  "
        f"轮数={args.laps or '不限'}  垛位={len(points)}  "
        f"路线={'直走' if args.no_comb else f'梳齿(垛间通道探入点 {probe_count} 个, 深度 {args.probe_depth:.0%})'}"
    )
    if degrader is not None:
        # 打印真值变换，标定算法解出的结果应与之对齐（漂移和突跳会让它随时间失配，这正是现场的情况）。
        print(
            f"[真值变换] odom→CAD  theta={SOLVED_THETA_RAD:.9f}rad  scale={SOLVED_SCALE:.8f}  "
            f"tx={SOLVED_TX}  ty={SOLVED_TY}  (尺度亏损 {(1 - ODOM_SCALE_LOSS) * 100:.1f}%)"
        )

    stop = {"flag": False}

    def handle_signal(_signum: int, _frame: Any) -> None:
        stop["flag"] = True

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    if anomaly_point is not None:
        print(f"[注入] 热点 {args.anomaly} @({anomaly_point['x']}, {anomaly_point['y']})  "
              f"中心 {args.anomaly_temp}℃  热羽尺度 {args.anomaly_sigma}m")

    sent = 0
    sim_elapsed = 0.0          # 仿真经过的秒数，自热曲线与 ts 都按它计时
    # ts 锚定在起始时刻后按仿真时间推进，而不是每条都取系统时间：
    # 否则 --time-scale 20 会把上百条样本压进同一秒，趋势图与告警窗口都会失真。
    start_ts = current_unix_ts() - int(args.start_offset_min * 60)

    try:
        while not stop["flag"]:
            dt = float(SAMPLE_DT_BASE_SEC + (1 if rng.random() < SAMPLE_DT_JITTER_PROB else 0))
            state = motion.step(dt)
            if state.finished:
                print(f"[完成] 已跑完 {state.lap} 轮巡检")
                break

            sim_elapsed += dt

            zone_id, point_id, sample_type, matched_point = matcher.match(state.x, state.y)

            # —— 温湿度：环境真值 → 可选异常热点 → 湿度跟随 → 可选自热污染 → 可选缺值 ——
            # 顺序不能乱：humidity_at 每调用一次就推进一步 AR(1) 噪声，每个样本只能调一次。
            sense_x, sense_y = reading_position(state.x, state.y, matched_point)
            temp_c = thermal.temperature_at(sense_x, sense_y)

            if anomaly_point is not None:
                # 固定热点：读数按到热点中心的距离做高斯插值，走远了自然回落到环境温度
                distance = math.hypot(state.x - float(anomaly_point["x"]), state.y - float(anomaly_point["y"]))
                weight = math.exp(-(distance ** 2) / (2.0 * args.anomaly_sigma ** 2))
                temp_c += (args.anomaly_temp - temp_c) * weight

            rh = thermal.humidity_at(temp_c)

            if selfheat is not None:
                temp_c, rh = selfheat.apply(temp_c, rh, sim_elapsed)

            # 传感器分辨率：实测温度 0.1℃ 步进、湿度为整数
            reported_temp: Optional[float] = round(temp_c, 1)
            reported_rh: Optional[float] = float(round(rh))
            if not args.no_gaps and not gaps.next_has_value():
                reported_temp, reported_rh = None, None

            # —— 位姿：干净真值 或 退化里程计 ——
            if degrader is not None:
                pose = degrader.degrade(state.x, state.y, state.yaw, dt, state.moving)
            else:
                pose = (state.x, state.y, state.yaw)

            payload = build_payload(
                device_id=args.device_id,
                ts=start_ts + int(sim_elapsed),
                pose=pose,
                pose_frame=pose_frame,
                zone_id=zone_id,
                point_id=point_id,
                sample_type=sample_type,
                temp_c=reported_temp,
                rh=reported_rh,
            )

            if publisher is not None:
                publisher.publish_json(topic, payload)
            else:
                temp_text = f"{reported_temp}℃" if reported_temp is not None else "None℃"
                rh_text = f"{reported_rh:.0f}%" if reported_rh is not None else "None%"
                print(
                    f"{topic}  temp={temp_text} rh={rh_text}  "
                    f"pos=({pose[0]:.3f},{pose[1]:.3f}) yaw={pose[2]:.3f}  "
                    f"point={point_id} type={sample_type}  ts={payload['ts']}"
                )

            sent += 1
            if args.count > 0 and sent >= args.count:
                print(f"[完成] 已发送 {sent} 条")
                break

            time.sleep(dt / args.time_scale)
    finally:
        if degrader is not None:
            print(f"[统计] yaw 突跳 {degrader.jump_count} 次  累计发送 {sent} 条")
        if publisher is not None:
            publisher.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
