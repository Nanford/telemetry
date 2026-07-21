#!/usr/bin/env python3
"""
INPUT : 一条 SLAM 轨迹(trail.json, 后端 /api/v1/slam/trail 的返回, 或任意 [{ts,pos_x,pos_y}] 列表)
OUTPUT: 1) 识别出的"停留簇"(dwell)列表, 每簇=机器狗在某垛位长时间停留的真实 SLAM 坐标质心
        2) 一张可视化 PNG(轨迹 + 停留点 + 按巡检顺序分配的垛位标注)
        3) 可选: 按巡检顺序把停留簇映射成 points.A-1-2.yaml(真实标定坐标, 替换示意网格)
POS   : "序列法标定"的核心工具 —— 不依赖开机朝向/绝对坐标是否对齐, 只靠"遥控单程 + 每垛停留"
        这个既定事实, 把真实轨迹反推成真实垛位坐标。明天现场走一趟即完成标定。

用法:
    # 只看识别结果 + 出图(先验证机制)
    python tools/calibrate_from_trail.py --trail trail.json --out dwells.png

    # 顺带按巡检顺序生成真实坐标配置(明天标定走完后用)
    python tools/calibrate_from_trail.py --trail trail.json --out dwells.png \
        --emit-yaml ../app/config/points.A-1-2.yaml --area A-1-2

判据(可调):
    --cluster-r   0.5   同一停留簇内, 样本离簇质心的最大半径(m)
    --min-sec     12    一簇算"有效停留"的最短持续秒数(现场每垛停≥15s, 留余量)
    --interval    5     采样间隔(s), 用于把秒数换算成样本数
"""
from __future__ import annotations

import argparse
import json
import math
import ssl
import urllib.request
from typing import Dict, List, Optional

DEFAULT_BASE_URL = "https://windoor.leenf.online/api/v1"


def fetch_trail(base_url: str, device: str, minutes: int, save_to: Optional[str] = None) -> List[Dict]:
    """直接从后端 /slam/trail 拉一条轨迹, 免手动 curl。可选存一份本地副本备查。"""
    url = f"{base_url.rstrip('/')}/slam/trail?device_id={device}&minutes={minutes}"
    # 证书异常时退化为不校验(内网/自签场景常见), 只为把数据拿回来
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(url, timeout=25, context=ctx) as resp:
            body = resp.read().decode("utf-8")
    except ssl.SSLError:
        ctx = ssl._create_unverified_context()
        with urllib.request.urlopen(url, timeout=25, context=ctx) as resp:
            body = resp.read().decode("utf-8")
    if save_to:
        with open(save_to, "w", encoding="utf-8") as f:
            f.write(body)
    return _rows_from_raw(json.loads(body))


def _rows_from_raw(raw) -> List[Dict]:
    """把后端 {ok,data:[...]} 或裸列表统一成 [{ts,x,y}](字段转 float)。"""
    rows = raw["data"] if isinstance(raw, dict) and "data" in raw else raw
    return [{"ts": r.get("ts"), "x": float(r["pos_x"]), "y": float(r["pos_y"])} for r in rows]


def load_trail(path: str) -> List[Dict]:
    """读入本地 trail.json。兼容 {ok,data:[...]} 或直接的 [...] 列表。"""
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    rows = raw["data"] if isinstance(raw, dict) and "data" in raw else raw
    out = []
    for r in rows:
        # 后端字段是字符串, 这里统一转 float
        out.append({
            "ts": r.get("ts"),
            "x": float(r["pos_x"]),
            "y": float(r["pos_y"]),
        })
    return out


def detect_dwells(samples: List[Dict], cluster_r: float, min_samples: int) -> List[Dict]:
    """
    顺序扫描轨迹, 把"连续且都落在当前簇质心 cluster_r 内"的样本聚成一簇。
    一旦某样本跳出半径, 当前簇结束、开新簇。最后只保留样本数 ≥ min_samples 的簇(=有效停留),
    过滤掉路过时一闪而过的单点。返回按时间先后排列的停留簇。
    """
    dwells: List[Dict] = []
    cx = cy = 0.0
    n = 0
    i_start = 0

    def flush(i_end: int) -> None:
        # 收尾: 把累积的簇落成一条记录(若够长)
        nonlocal n
        if n >= min_samples:
            dwells.append({
                "cx": round(cx / n, 4), "cy": round(cy / n, 4), "n": n,
                "i_start": i_start, "i_end": i_end,
                "ts_start": samples[i_start]["ts"], "ts_end": samples[i_end]["ts"],
            })

    for i, s in enumerate(samples):
        if n == 0:
            cx, cy, n, i_start = s["x"], s["y"], 1, i
            continue
        # 与当前簇质心的距离
        dist = math.hypot(s["x"] - cx / n, s["y"] - cy / n)
        if dist <= cluster_r:
            cx += s["x"]; cy += s["y"]; n += 1
        else:
            flush(i - 1)
            cx, cy, n, i_start = s["x"], s["y"], 1, i
    flush(len(samples) - 1)
    return dwells


def plot(samples: List[Dict], dwells: List[Dict], out_png: str,
         bay_labels: Optional[List[str]] = None) -> None:
    """画: 轨迹(时间渐变) + 门口原点 + 停留簇(大点, 标 D#/垛号 + 停留时长)。"""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    try:
        plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
        plt.rcParams["axes.unicode_minus"] = False
    except Exception:
        pass

    xs = [s["x"] for s in samples]; ys = [s["y"] for s in samples]
    fig, ax = plt.subplots(figsize=(10, 8))
    ax.plot(xs, ys, "-", color="#9bb7e0", lw=0.8, alpha=0.6, zorder=1)
    ax.scatter(xs, ys, c=range(len(samples)), cmap="viridis", s=10, zorder=2)
    ax.scatter([0], [0], marker="*", s=360, color="red", edgecolor="k", zorder=6,
               label="门口原点(0,0)")

    for k, d in enumerate(dwells):
        label = bay_labels[k] if bay_labels and k < len(bay_labels) else f"D{k+1}"
        secs = d["n"] * 5  # 近似: 样本数 × 采样间隔
        ax.scatter([d["cx"]], [d["cy"]], s=260, facecolor="none",
                   edgecolor="crimson", linewidth=2.2, zorder=5)
        ax.annotate(f"{label}\n{d['cx']:.2f},{d['cy']:.2f}\n~{secs}s",
                    (d["cx"], d["cy"]), textcoords="offset points", xytext=(8, 8),
                    fontsize=8, color="crimson",
                    bbox=dict(boxstyle="round,pad=0.2", fc="white", ec="crimson", alpha=0.85))

    ax.axhline(0, color="gray", lw=0.5, ls="--"); ax.axvline(0, color="gray", lw=0.5, ls="--")
    ax.set_aspect("equal"); ax.grid(alpha=0.25)
    ax.set_xlabel("SLAM x (m)  →前方(走道)"); ax.set_ylabel("SLAM y (m)  →左侧")
    ax.set_title(f"轨迹停留识别: 共 {len(dwells)} 个有效停留簇", fontsize=12)
    ax.legend(loc="best", fontsize=9)
    fig.tight_layout(); fig.savefig(out_png, dpi=110)
    print(f"[OK] 图已保存 -> {out_png}")


def emit_yaml(dwells: List[Dict], bay_labels: List[str], area: str,
              radius: float, out_yaml: str) -> None:
    """把按顺序分配好的停留簇写成真实坐标的 points 配置。"""
    lines = [
        "# 由 tools/calibrate_from_trail.py 从真实轨迹标定生成 —— 坐标为现场实测 SLAM 值。",
        f"area_id: {area}",
        "points:",
    ]
    for k, d in enumerate(dwells):
        pid = bay_labels[k] if k < len(bay_labels) else f"{area}-{k+1:02d}"
        lines.append(
            f"  - {{ id: {pid}, zone_id: {area}, name: 垛位 {pid}, "
            f"x: {d['cx']}, y: {d['cy']}, radius: {radius}, patrol_seq: {k+1} }}"
        )
    with open(out_yaml, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[OK] 标定配置已写 -> {out_yaml}  ({len(dwells)} 个垛位)")


def main() -> None:
    ap = argparse.ArgumentParser(description="从真实 SLAM 轨迹识别停留点并标定垛位坐标")
    ap.add_argument("--trail", default=None, help="本地 trail.json 路径(与 --fetch 二选一)")
    ap.add_argument("--fetch", action="store_true", help="直接从后端拉轨迹(免手动 curl)")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL, help="后端 API 基址")
    ap.add_argument("--device", default="go2_01", help="--fetch 时的 device_id")
    ap.add_argument("--minutes", type=int, default=1440, help="--fetch 时回溯的分钟数")
    ap.add_argument("--out", default="dwells.png", help="可视化 PNG 输出路径")
    ap.add_argument("--cluster-r", type=float, default=0.5, help="停留簇半径(m)")
    ap.add_argument("--min-sec", type=float, default=12.0, help="有效停留最短秒数")
    ap.add_argument("--interval", type=float, default=5.0, help="采样间隔(s)")
    ap.add_argument("--emit-yaml", default=None, help="可选: 输出 points 配置路径")
    ap.add_argument("--area", default="A-1-2", help="库房 area_id")
    ap.add_argument("--radius", type=float, default=0.6, help="生成配置的匹配半径(m)")
    args = ap.parse_args()

    if args.fetch:
        save_copy = args.trail  # 若也给了 --trail, 顺便存一份本地副本
        samples = fetch_trail(args.base_url, args.device, args.minutes, save_to=save_copy)
        print(f"[fetch] {args.base_url}/slam/trail device={args.device} minutes={args.minutes} -> {len(samples)} 点")
    elif args.trail:
        samples = load_trail(args.trail)
    else:
        ap.error("需要 --trail <文件> 或 --fetch 其一")

    min_samples = max(2, int(round(args.min_sec / args.interval)))
    dwells = detect_dwells(samples, cluster_r=args.cluster_r, min_samples=min_samples)

    print(f"轨迹样本数={len(samples)}  有效停留判据: 半径≤{args.cluster_r}m 且 ≥{min_samples}个样本(~{args.min_sec}s)")
    print(f"识别到 {len(dwells)} 个停留簇(按时间先后):")
    for k, d in enumerate(dwells):
        print(f"  D{k+1}: 质心=({d['cx']:.3f},{d['cy']:.3f})  样本={d['n']}(~{d['n']*args.interval:.0f}s)")

    plot(samples, dwells, args.out)

    if args.emit_yaml:
        # 明天标定走完后, 按巡检顺序给每个停留簇分配垛号(此处按 D1..Dn 顺序落号, 现场核对)
        bay_labels = [f"{args.area}-{k+1:02d}" for k in range(len(dwells))]
        emit_yaml(dwells, bay_labels, args.area, args.radius, args.emit_yaml)


if __name__ == "__main__":
    main()
