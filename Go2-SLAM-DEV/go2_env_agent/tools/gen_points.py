#!/usr/bin/env python3
"""
INPUT : ROOMS 数据块（每间库房上/下排垛位排布，从现场平面图读取）
OUTPUT: app/config/points.A-1-{1..4}.yaml —— 每间房一份采集点配置
POS   : 采集点配置的"唯一数据源"。改垛位排布只改 ROOMS，重跑本脚本即可，
        保证 4 间房坐标网格/巡检顺序/命名规则完全一致。

命名层级 : area_id=房间(A-1-2)  point_id=垛位(A-1-2-07)  zone_id=房间(A-1-2, 按房间分组, point 下钻)
巡检模型 : 人工遥控, 只走中央走道；上排东→西去程, 下排西→东回程, 每垛停 ≥15s 采样
坐标性质 : 示意网格(拓扑正确), 现场 SLAM 标定后按 id 替换真实 x/y

用法: python tools/gen_points.py
"""
from __future__ import annotations

import os
from typing import List, Optional

# ---- 网格参数(示意坐标, 现场标定替换) ----
# 注意: 本脚本只负责"命名/拓扑/巡检顺序"这套骨架, 坐标是均匀示意网格, 不是真实几何。
# A-1-2 的真实垛位坐标(CAD 实测, 非均匀成对间距)是权威匹配源, 落在
#   backend/src/config.js 的 slam.points —— 后端 matchInspectionPoint 以它为准。
# 设备端 points.A-1-2.yaml 的坐标同为示意值, 现场 SLAM 标定后按 id 替换真实 x/y。
COL_PITCH = 2.5      # 相邻垛位列间距(m); > 2*RADIUS 保证不重叠
Y_TOP = 4.8          # 上排采集点 y(北侧)
Y_BOTTOM = 3.2       # 下排采集点 y(南侧); 与上排相差 1.6m, 靠遥控停到目标侧区分
RADIUS = 0.9         # 匹配半径(m); 与 config.js A12_RADIUS 保持一致

# ---- 每间库房垛位排布(西→东, None=空列/横向消防通道) ----
# confidence: 该排布的可信度。A-1-2 已与用户确认; 其余为平面图读取, 需现场核对。
ROOMS = {
    "A-1-1": {
        "confidence": "低-图上读取待核对(21垛 01-21)",
        "top":    [16, 17, 18, 19, 20, 21, None, 1, 2, 3, 4, 5],
        "bottom": [15, 14, 13, 12, 11, 10, None, 9, 8, 7, 6, None],
    },
    "A-1-2": {
        "confidence": "已与用户确认(23垛 01-23)",
        "top":    [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
        "bottom": [6, 5, 4, 3, 2, 1, None, 23, 22, 21, 20, 19],
    },
    "A-1-3": {
        "confidence": "中-图上读取(23垛 01-23)",
        "top":    [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
        "bottom": [5, 4, 3, 2, 1, None, 23, 22, 21, 20, 19, 18],
    },
    "A-1-4": {
        "confidence": "低-图上读取待核对(18垛 01-18)",
        "top":    [14, 15, 16, 17, 18, None, 1, 2, 3, 4, 5, 6],
        "bottom": [13, 12, 11, 10, 9, None, 8, 7, None, None, None, None],
    },
}

HEADER = """\
# =====================================================================
# 本文件由 tools/gen_points.py 自动生成 —— 请勿手工编辑, 改动改 ROOMS 后重跑。
# INPUT : Go2 SLAM 位姿(x,y), 由 point_matcher.py 按"最近点+半径"匹配
# OUTPUT: 命中垛位 point_id / 归属房间 zone_id, 供采集终端归属温湿度上报
# POS   : {room} 库房真实垛位采集点定义
# 排布可信度: {confidence}
# 坐标为示意值, 现场 SLAM 标定后按 id 替换真实 x/y(id 不变)。
# =====================================================================
"""


def bay_id(room: str, num: int) -> str:
    """垛位号补零成两位, 生成 point_id, 如 A-1-2-07。"""
    return f"{room}-{num:02d}"


def build_points(room: str, top: List[Optional[int]], bottom: List[Optional[int]]):
    """按网格生成点位(垛位 + 巷道点), 并给出巡检顺序(上排东→西, 下排西→东)。"""
    points = {}  # point_id -> dict

    # 上排: x 随列号递增
    for col, num in enumerate(top):
        if num is None:
            continue
        pid = bay_id(room, num)
        points[pid] = {"id": pid, "x": round(COL_PITCH * (col + 1), 2), "y": Y_TOP, "kind": "bay"}
    # 下排
    for col, num in enumerate(bottom):
        if num is None:
            continue
        pid = bay_id(room, num)
        points[pid] = {"id": pid, "x": round(COL_PITCH * (col + 1), 2), "y": Y_BOTTOM, "kind": "bay"}

    # 巡检顺序: 上排从东(大 x)往西, 再下排从西(小 x)往东, 单程无重复
    top_ids = [bay_id(room, n) for n in top if n is not None]
    bottom_ids = [bay_id(room, n) for n in bottom if n is not None]
    order = list(reversed(top_ids)) + bottom_ids  # 东→西 上排, 西→东 下排
    for seq, pid in enumerate(order, start=1):
        points[pid]["patrol_seq"] = seq

    # 巷道采集点: 相邻列中点、落在中央走道中线(上下排 y 均值)。
    # 供狗在走道"在途"采样归属——走道中线离两排垛各约0.8m, 垛点半径盖不到,
    # 没有巷道点这些样本会匹配不上。两侧至少一侧有垛才布点。id 用 C 前缀区分。
    y_aisle = round((Y_TOP + Y_BOTTOM) / 2, 2)
    aisle_seq = 0
    for col in range(len(top) - 1):
        left = (top[col] is not None) or (bottom[col] is not None)
        right = (top[col + 1] is not None) or (bottom[col + 1] is not None)
        if not (left and right):
            continue
        aisle_seq += 1
        pid = f"{room}-C{aisle_seq:02d}"
        points[pid] = {
            "id": pid,
            "x": round(COL_PITCH * (col + 1.5), 2),   # 相邻两列中点
            "y": y_aisle,
            "kind": "aisle",
            "patrol_seq": len(order) + aisle_seq,     # 排在垛位之后
        }

    return points


def _sort_key(pid: str):
    """垛位(数字号)在前、巷道点(C 前缀)在后, 各自按序号排。"""
    tail = pid.split("-")[-1]
    return (1, int(tail[1:])) if tail.startswith("C") else (0, int(tail))


def render_yaml(room: str, confidence: str, points: dict) -> str:
    lines = [HEADER.format(room=room, confidence=confidence)]
    lines.append(f"area_id: {room}")
    lines.append("points:")
    # 垛位数字号在前、巷道点在后, 便于人工核对
    for pid in sorted(points, key=_sort_key):
        p = points[pid]
        label = "巷道" if p.get("kind") == "aisle" else "垛位"
        lines.append(
            f"  - {{ id: {pid}, zone_id: {room}, name: {label} {pid}, "
            f"x: {p['x']}, y: {p['y']}, radius: {RADIUS}, patrol_seq: {p['patrol_seq']} }}"
        )
    return "\n".join(lines) + "\n"


def main() -> None:
    out_dir = os.path.join(os.path.dirname(__file__), "..", "app", "config")
    out_dir = os.path.abspath(out_dir)
    for room, cfg in ROOMS.items():
        points = build_points(room, cfg["top"], cfg["bottom"])
        yaml_text = render_yaml(room, cfg["confidence"], points)
        out_path = os.path.join(out_dir, f"points.{room}.yaml")
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(yaml_text)
        print(f"[OK] {room}: {len(points):2d} 垛 -> {os.path.relpath(out_path, out_dir)}  ({cfg['confidence']})")


if __name__ == "__main__":
    main()
