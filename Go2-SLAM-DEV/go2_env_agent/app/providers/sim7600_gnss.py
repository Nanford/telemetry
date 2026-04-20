"""GPS fallback provider — wraps original SIM7600GNSS behind PositionProvider."""
import time
from typing import Optional, Dict, Any, Tuple, List

from app.models import Pose
from app.providers.base_position import PositionProvider

try:
    import serial
    _SERIAL_AVAILABLE = True
except ImportError:
    _SERIAL_AVAILABLE = False


def ddmm_to_deg(v: str, is_lon: bool) -> Optional[float]:
    if not v:
        return None
    try:
        if is_lon:
            deg = int(v[0:3])
            minutes = float(v[3:])
        else:
            deg = int(v[0:2])
            minutes = float(v[2:])
        return deg + minutes / 60.0
    except Exception:
        return None


class SIM7600GNSS:
    GSV_CONFIG_MASK = 132164

    def __init__(
        self,
        at_port: str,
        baud: int = 115200,
        timeout: float = 1.5,
        default_lat: float = 30.681732,
        default_lon: float = 114.183271,
    ):
        self.at_port = at_port
        self.baud = baud
        self.serial_timeout = timeout
        self.default_lat = default_lat
        self.default_lon = default_lon
        self.ser = None
        self._open_port()

    def _open_port(self) -> bool:
        if not _SERIAL_AVAILABLE:
            print("GNSS: pyserial not available")
            return False
        if self.ser is not None:
            return True
        try:
            self.ser = serial.Serial(self.at_port, baudrate=self.baud, timeout=self.serial_timeout)
            return True
        except serial.SerialException as e:
            print(f"GNSS: cannot open {self.at_port}: {e}")
            self.ser = None
            return False

    def close(self):
        try:
            if self.ser:
                self.ser.close()
        except Exception:
            pass
        self.ser = None

    def _cmd(self, cmd: str, wait_ok: bool = True, timeout_sec: float = 3.0) -> str:
        if self.ser is None and not self._open_port():
            return ""
        try:
            self.ser.reset_input_buffer()
            self.ser.write((cmd.strip() + "\r\n").encode("ascii", errors="ignore"))
            self.ser.flush()
            lines: List[str] = []
            t0 = time.time()
            while True:
                line = self.ser.readline().decode("utf-8", errors="ignore").strip()
                if line:
                    lines.append(line)
                    if wait_ok and (line == "OK" or line.startswith("ERROR")):
                        break
                if time.time() - t0 > timeout_sec:
                    break
            return "\n".join(lines)
        except Exception as e:
            print(f"GNSS: port lost during command: {e}")
            self.close()
            return ""

    def enable_gnss(self) -> None:
        if self.ser is None and not self._open_port():
            return
        self._cmd("AT+CVAUXS=1", wait_ok=False, timeout_sec=1.5)
        self._cmd("AT+CGPS=1", wait_ok=False, timeout_sec=1.5)

    def disable_gnss(self) -> None:
        self._cmd("AT+CGPS=0", wait_ok=False, timeout_sec=1.5)

    def _collect_nmea_gsv_once(self, listen_sec: float = 2.2) -> List[str]:
        if self.ser is None and not self._open_port():
            return []
        lines: List[str] = []
        try:
            self.ser.reset_input_buffer()
            self.ser.write(f"AT+CGPSINFOCFG=1,{self.GSV_CONFIG_MASK}\r\n".encode("ascii", errors="ignore"))
            self.ser.flush()
            t0 = time.time()
            while time.time() - t0 < listen_sec:
                line = self.ser.readline().decode("utf-8", errors="ignore").strip()
                if line:
                    lines.append(line)
        except Exception as e:
            print(f"GNSS: port lost during GSV collect: {e}")
            self.close()
            return lines
        self._cmd("AT+CGPSINFOCFG=0", wait_ok=False, timeout_sec=1.0)
        return lines

    def _parse_satellite_count(self, lines: List[str]) -> int:
        max_count = 0
        saw_gsv = False
        for raw in lines:
            line = raw.strip()
            if not line.startswith("$") or "GSV" not in line:
                continue
            saw_gsv = True
            parts = line.split(",")
            if len(parts) >= 4:
                try:
                    sv = int(parts[3].split("*")[0])
                    if sv > max_count:
                        max_count = sv
                    continue
                except Exception:
                    pass
            if len(parts) >= 2:
                try:
                    sv = int(parts[1].split("*")[0])
                    if sv > max_count:
                        max_count = sv
                except Exception:
                    pass
        if max_count == 0 and saw_gsv:
            return 1
        return max_count

    def read_satellite_hint(self) -> Dict[str, Any]:
        lines = self._collect_nmea_gsv_once()
        visible = self._parse_satellite_count(lines)
        return {
            "has_signal": visible > 0,
            "visible_satellites": visible,
            "nmea_sample": [l for l in lines if "GSV" in l][:3],
        }

    def read_fix(self) -> Dict[str, Any]:
        out = self._cmd("AT+CGPSINFO", wait_ok=False, timeout_sec=2.0)
        gps_line = None
        for line in out.splitlines():
            if line.startswith("+CGPSINFO:"):
                gps_line = line
                break

        if gps_line:
            data = gps_line.split(":", 1)[1].strip()
            parts = [p.strip() for p in data.split(",")]
            if len(parts) >= 4 and not (parts[0] == "" and parts[2] == ""):
                lat_raw, lat_hemi, lon_raw, lon_hemi = parts[0], parts[1], parts[2], parts[3]
                lat = ddmm_to_deg(lat_raw, is_lon=False)
                lon = ddmm_to_deg(lon_raw, is_lon=True)
                if lat is not None and lat_hemi.upper() == "S":
                    lat = -lat
                if lon is not None and lon_hemi.upper() == "W":
                    lon = -lon
                alt = parts[6] if len(parts) > 6 else ""
                spd = parts[7] if len(parts) > 7 else ""
                crs = parts[8] if len(parts) > 8 else ""
                return {
                    "fix": (lat is not None and lon is not None),
                    "lat": lat, "lon": lon,
                    "alt_m": float(alt) if alt else None,
                    "speed_kmh": float(spd) if spd else None,
                    "course_deg": float(crs) if crs else None,
                    "fallback": False,
                }

        sat = self.read_satellite_hint()
        if sat["has_signal"]:
            return {
                "fix": True,
                "lat": self.default_lat, "lon": self.default_lon,
                "fallback": True,
                "fallback_reason": "visible_satellites_but_no_valid_fix",
                "visible_satellites": sat["visible_satellites"],
            }
        return {"fix": False, "fallback": False, "visible_satellites": 0}


class SIM7600Provider(PositionProvider):
    """Wraps SIM7600GNSS as a PositionProvider."""

    def __init__(self, at_port: str, default_lat: float = 0.0, default_lon: float = 0.0):
        self._gnss = SIM7600GNSS(at_port, default_lat=default_lat, default_lon=default_lon)

    def start(self) -> None:
        self._gnss.enable_gnss()

    def read_pose(self) -> Pose:
        fix_data = self._gnss.read_fix()
        return Pose(
            source="gps",
            frame="wgs84",
            fix=fix_data.get("fix", False),
            x=fix_data.get("lon"),
            y=fix_data.get("lat"),
            z=fix_data.get("alt_m"),
            yaw=fix_data.get("course_deg"),
            error=fix_data.get("fallback_reason"),
        )

    def stop(self) -> None:
        try:
            self._gnss.disable_gnss()
        except Exception:
            pass
        self._gnss.close()
