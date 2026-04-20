#!/usr/bin/env python3
"""Standalone point matcher test. Works on any platform."""
import sys
import os
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.models import Pose
from app.matcher.point_matcher import PointMatcher


def main():
    parser = argparse.ArgumentParser(description="Debug point matching")
    parser.add_argument(
        "--points",
        default=os.path.join(os.path.dirname(__file__), "..", "app", "config", "points.yaml"),
        help="Path to points.yaml",
    )
    parser.add_argument("--dwell", type=int, default=3, help="Dwell count threshold")
    args = parser.parse_args()

    matcher = PointMatcher(args.points, dwell_count=args.dwell)
    print(f"Loaded {len(matcher.points)} points from {args.points}")
    print(f"Area: {matcher.area_id}, dwell_count={args.dwell}")
    print("Enter x y (space-separated), or 'q' to quit:\n")

    while True:
        try:
            raw = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            break

        if raw.lower() in ("q", "quit", "exit"):
            break

        parts = raw.split()
        if len(parts) != 2:
            print("  Usage: <x> <y>")
            continue

        try:
            x, y = float(parts[0]), float(parts[1])
        except ValueError:
            print("  Invalid numbers")
            continue

        pose = Pose(source="debug", frame="map", fix=True, x=x, y=y, z=0.0, yaw=0.0)
        result = matcher.match(pose)

        if result.matched:
            print(
                f"  -> {result.point_id} (dist={result.distance:.3f}, "
                f"type={result.sample_type}, area={result.area_id})"
            )
        else:
            print(f"  -> No match (area={result.area_id})")


if __name__ == "__main__":
    main()
