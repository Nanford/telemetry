import ssl
import threading
from typing import Dict, Optional

import paho.mqtt.client as mqtt

from app.storage.spool import Spool


class MqttUploader:
    def __init__(self, cfg: Dict[str, str]):
        self.cfg = cfg
        self.client = mqtt.Client(
            client_id=cfg["MQTT_CLIENT_ID"],
            clean_session=False,
        )
        if cfg.get("MQTT_USERNAME"):
            self.client.username_pw_set(cfg["MQTT_USERNAME"], cfg.get("MQTT_PASSWORD", ""))

        status_topic = cfg["MQTT_STATUS_TOPIC"]
        self.client.will_set(status_topic, payload="offline", qos=1, retain=True)

        if cfg.get("MQTT_TLS", "0") == "1":
            ca = cfg.get("MQTT_CA_CERT", "")
            if ca:
                self.client.tls_set(ca_certs=ca, cert_reqs=ssl.CERT_REQUIRED)
            else:
                self.client.tls_set(cert_reqs=ssl.CERT_REQUIRED)

        self.connected = False
        self._spool: Optional[Spool] = None
        self._inflight: Dict[int, int] = {}
        self._lock = threading.Lock()

        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_publish = self._on_publish

        self.client.reconnect_delay_set(min_delay=1, max_delay=60)

    def _on_connect(self, client, userdata, flags, rc):
        self.connected = rc == 0
        if self.connected:
            client.publish(self.cfg["MQTT_STATUS_TOPIC"], payload="online", qos=1, retain=True)

    def _on_disconnect(self, client, userdata, rc):
        self.connected = False

    def _on_publish(self, client, userdata, mid):
        with self._lock:
            row_id = self._inflight.pop(mid, None)
        if row_id is not None and self._spool is not None:
            try:
                self._spool.delete(row_id)
            except Exception:
                pass

    def start(self):
        self.client.connect(self.cfg["MQTT_HOST"], int(self.cfg["MQTT_PORT"]), keepalive=60)
        self.client.loop_start()

    def stop(self):
        try:
            self.client.loop_stop()
        except Exception:
            pass
        try:
            self.client.disconnect()
        except Exception:
            pass

    def flush(self, spool: Spool) -> int:
        self._spool = spool
        flushed = 0
        if not self.connected:
            return flushed

        while True:
            item = spool.peek()
            if not item:
                break
            sid, pstr = item
            info = self.client.publish(self.cfg["MQTT_TOPIC"], payload=pstr, qos=1, retain=False)
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                break
            with self._lock:
                self._inflight[info.mid] = sid
            flushed += 1

        return flushed
