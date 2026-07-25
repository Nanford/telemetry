#!/usr/bin/env python3
"""
INPUT : 2~3(或更多)组锚点对应 —— 每组 = "已知CAD坐标(cx,cy) ↔ 现场读到的SLAM坐标(sx,sy)"
OUTPUT: SLAM系→CAD系 相似变换 {theta, scale, tx, ty} + 残差 rms; 可 --out 写成 calibration.json
POS   : 阶段2 现场标定核心。把每次开机会漂的 Go2 SLAM 系锁到 config.js 的 CAD 系上。
        变换定义(与 backend/src/calibration.js 一致): CAD = c·R(theta)·SLAM + t
          [cx]       [cosθ  -sinθ][sx]   [tx]
          [cy] = c · [sinθ   cosθ][sy] + [ty]
        最小二乘(Umeyama, 2 点即可解, 3+ 更稳)。

        为什么解 4 自由度(带缩放 c)而不是 3 自由度刚体:
        2026-07-23 现场用三张带时间戳的照片(A-4-1-17/18/20)做真值实测, Go2 的
        sportmodestate 每走 1 m 只报 0.735 m —— 约 26% 尺度亏损(足式里程计打滑)。
        同组锚点纯刚体拟合 rms 1.44 m, 加 c 后 0.11 m。--rigid 可锁回旧的纯刚体行为。

用法:
  python tools/solve_calibration.py --area A-4-1 \
      --anchor 2.210,19.850:-27.711517,11.649051 \
      --anchor 5.990,19.850:-26.126020,9.575457 \
      --anchor 15.295,19.850:-21.795494,4.068937
  # 追加 --out /opt/telemetry/backend/src/calibration.json 直接写文件(只更新该 area, 不动其他)
每个 --anchor 格式: CADx,CADy:SLAMx,SLAMy
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

# Windows 控制台默认 GBK, 会在打印 emoji/中文时报错; 强制 UTF-8(Linux 本就 UTF-8, 无副作用)。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def parse_anchor(text: str):
    """'cx,cy:sx,sy' -> ((cx,cy),(sx,sy))"""
    try:
        cad_part, slam_part = text.split(":")
        cx, cy = (float(v) for v in cad_part.split(","))
        sx, sy = (float(v) for v in slam_part.split(","))
        return (cx, cy), (sx, sy)
    except Exception as exc:  # noqa: BLE001
        raise argparse.ArgumentTypeError(
            f"锚点格式错误 '{text}', 应为 CADx,CADy:SLAMx,SLAMy"
        ) from exc


def solve(anchors, with_scale=True):
    """解 CAD = c·R(theta)·SLAM + t, 返回 (theta, scale, tx, ty, rms, residuals)。

    with_scale=False 时锁 c=1, 退化为纯刚体(旧行为), 用于对照说明尺度项有没有必要。
    """
    n = len(anchors)
    cad = [a[0] for a in anchors]
    slam = [a[1] for a in anchors]

    # 质心
    cx_bar = sum(p[0] for p in cad) / n
    cy_bar = sum(p[1] for p in cad) / n
    sx_bar = sum(p[0] for p in slam) / n
    sy_bar = sum(p[1] for p in slam) / n

    # 去心后求最优旋转(2D Kabsch): theta = atan2(Σ(s'×c'), Σ(s'·c'))
    num = 0.0  # Σ (sx'*cy' - sy'*cx')  —— 叉积
    den = 0.0  # Σ (sx'*cx' + sy'*cy')  —— 点积
    var_s = 0.0  # Σ |s'|², 求最优缩放的分母
    for (cx, cy), (sx, sy) in anchors:
        sxp, syp = sx - sx_bar, sy - sy_bar
        cxp, cyp = cx - cx_bar, cy - cy_bar
        num += sxp * cyp - syp * cxp
        den += sxp * cxp + syp * cyp
        var_s += sxp * sxp + syp * syp
    theta = math.atan2(num, den)

    # 最优缩放 c = Σ(R·s')·c' / Σ|s'|²; 展开后分子恰为 √(num²+den²)。
    # var_s≈0 说明锚点全挤在一点, 此时缩放无从谈起, 退回 1 并靠 rms 报警。
    if with_scale and var_s > 1e-9:
        scale = math.hypot(num, den) / var_s
    else:
        scale = 1.0

    cos, sin = math.cos(theta), math.sin(theta)
    # t = c_bar - c·R·s_bar
    tx = cx_bar - scale * (cos * sx_bar - sin * sy_bar)
    ty = cy_bar - scale * (sin * sx_bar + cos * sy_bar)

    # 残差
    sq = 0.0
    residuals = []
    for (cx, cy), (sx, sy) in anchors:
        px = scale * (cos * sx - sin * sy) + tx
        py = scale * (sin * sx + cos * sy) + ty
        d = math.hypot(px - cx, py - cy)
        residuals.append(d)
        sq += d * d
    rms = math.sqrt(sq / n)
    return theta, scale, tx, ty, rms, residuals


def merge_into_file(path: str, area_id: str, entry: dict) -> dict:
    """把某区域的变换并入既有 calibration.json, 不动其他区域(标定是分区的)。

    旧版扁平格式 {theta,tx,ty} 会被迁移到 default, 保证老部署升级后行为不变。
    """
    book = {"areas": {}, "default": None}
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            if "areas" in raw or "default" in raw:
                book["areas"] = dict(raw.get("areas") or {})
                book["default"] = raw.get("default")
            elif "theta" in raw:  # 旧版扁平格式 → 迁到 default
                book["default"] = raw
    except (OSError, ValueError):
        pass  # 文件不存在/坏掉 → 从空册开始
    book["areas"][area_id] = entry
    return book


def main() -> int:
    ap = argparse.ArgumentParser(description="解 SLAM→CAD 标定变换(相似: 缩放+旋转+平移)")
    ap.add_argument("--anchor", action="append", type=parse_anchor, required=True,
                    help="CADx,CADy:SLAMx,SLAMy, 至少 2 个, 尽量分得开")
    ap.add_argument("--area", default="A-4-1", help="这组锚点属于哪个区域(写入 areas 下)")
    ap.add_argument("--rigid", action="store_true",
                    help="锁 scale=1 解纯刚体(旧行为)。仅在确认位姿源尺度可信时使用")
    ap.add_argument("--note", default="", help="写进标定文件的备注(建议注明现场日期与锚点来源)")
    ap.add_argument("--out", help="写出 calibration.json 的路径(可选)")
    args = ap.parse_args()

    if len(args.anchor) < 2:
        print("至少需要 2 个锚点(3+ 更稳)", file=sys.stderr)
        return 2

    theta, scale, tx, ty, rms, residuals = solve(args.anchor, with_scale=not args.rigid)

    # 同时解一版纯刚体做对照: 两者 rms 差得越多, 说明位姿源的尺度问题越严重。
    _, _, _, _, rms_rigid, _ = solve(args.anchor, with_scale=False)

    print(f"theta = {theta:.6f} rad  ({math.degrees(theta):.2f}°)")
    print(f"scale = {scale:.6f}   (位姿源每走 1 m 实报 {1 / scale:.3f} m)")
    print(f"tx    = {tx:.4f} m")
    print(f"ty    = {ty:.4f} m")
    print(f"残差 rms = {rms:.3f} m   各点残差: {[round(r, 3) for r in residuals]}")
    if not args.rigid:
        print(f"对照:同组锚点锁 scale=1 时 rms = {rms_rigid:.3f} m")
        if rms_rigid > max(0.3, rms * 3):
            print(f"     → 尺度项贡献显著({rms_rigid:.2f}→{rms:.2f} m), 该位姿源存在真实尺度亏损。")

    if rms > 0.5:
        print("⚠️  rms > 0.5m: 锚点摆位可能不准 / 锚点太近, 建议重采更分得开的点", file=sys.stderr)
    elif rms > 0.3:
        print("⚠️  rms 偏大(>0.3m), 勉强可用, 有条件重采更准", file=sys.stderr)
    else:
        print("✅ rms 良好(<0.3m)")

    entry = {
        "theta": round(theta, 9),
        "scale": round(scale, 9),
        "tx": round(tx, 4),
        "ty": round(ty, 4),
        "anchors": len(args.anchor),
        "rms_m": round(rms, 4),
    }
    if args.note:
        entry["note"] = args.note

    out = args.out or os.path.join(os.path.dirname(__file__), "..", "..", "..",
                                   "backend", "src", "calibration.json")
    book = merge_into_file(out, args.area, entry)
    print(f"\ncalibration.json(区域 {args.area})内容:")
    print(json.dumps(book, ensure_ascii=False, indent=2))

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(book, f, ensure_ascii=False, indent=2)
        print(f"\n已写入 {args.out} —— 重启后端生效: sudo systemctl restart telemetry-api")
    else:
        print("\n未指定 --out, 未落盘。确认无误后加 --out backend/src/calibration.json 再跑一次。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
