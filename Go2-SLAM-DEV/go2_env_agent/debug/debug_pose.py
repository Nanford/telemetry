#!/usr/bin/env python3
"""Standalone Go2 pose reader test. Run on Pi with Go2 on same network."""
import sys
import os
import time
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.providers.go2_pose_sdk import Go2PoseSDK


def main():
    parser = argparse.ArgumentParser(description="Debug Go2 pose reading")
    parser.add_argument("--iface", default="eth0", help="Network interface for Go2")
    parser.add_argument("--topic", default="rt/sportmodestate", help="DDS topic")
    parser.add_argument("--interval", type=float, default=1.0, help="Print interval (sec)")
    args = parser.parse_args()

    reader = Go2PoseSDK(
        net_iface=args.iface,
        topic=args.topic,
    )

    print(f"Starting Go2PoseSDK on {args.iface}, topic={args.topic}")
    reader.start()

    try:
        while True:
            pose = reader.read_pose()
            if pose.fix:
                print(
                    f"[OK]  x={pose.x:+8.3f}  y={pose.y:+8.3f}  "
                    f"z={pose.z:+8.3f}  yaw={pose.yaw:+6.3f}"
                )
            else:
                print(f"[NO FIX] error={pose.error}")
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        reader.stop()


if __name__ == "__main__":
    main()
