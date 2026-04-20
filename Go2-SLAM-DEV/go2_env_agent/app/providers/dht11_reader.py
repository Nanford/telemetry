from typing import Tuple, Optional

try:
    import board
    import adafruit_dht

    _HW_AVAILABLE = True
except (ImportError, NotImplementedError):
    _HW_AVAILABLE = False


class DHTReader:
    def __init__(self, gpio_board_pin: str):
        if not _HW_AVAILABLE:
            raise RuntimeError(
                "DHT11 hardware libraries not available. "
                "Install adafruit-circuitpython-dht and board on Raspberry Pi."
            )
        pin = getattr(board, gpio_board_pin)
        self.dht = adafruit_dht.DHT11(pin)

    def read(self) -> Tuple[Optional[int], Optional[int], Optional[str]]:
        try:
            t = self.dht.temperature
            h = self.dht.humidity
            return t, h, None
        except RuntimeError as e:
            return None, None, f"DHT read error: {e}"
        except Exception as e:
            return None, None, f"DHT fatal error: {e}"
