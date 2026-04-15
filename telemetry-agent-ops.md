# 树莓派采集终端运维手册

> 适用设备：Raspberry Pi 4 · 采集程序 `telemetry_agent.py`
> 当前终端编号：`pi4-001`

---

## 1. 系统架构

```
DHT11 (GPIO D4)  ──┐
                    ├──  telemetry_agent.py  ──  MQTT  ──>  后端 API  ──>  MySQL
SIM7600CE (AT口)  ──┘         │
                         SQLite spool
                    (断网缓存, QoS1 补发)
```

| 组件 | 型号/规格 | 接口 |
|------|-----------|------|
| 温湿度传感器 | DHT11 | GPIO D4 (board 引脚) |
| 4G/GNSS 模块 | Waveshare SIM7600CE HAT | AT 串口 `/dev/ttyUSB2`, 波特率 115200 |
| 离线缓冲 | SQLite | `/var/lib/telemetry-agent/spool.db` |

---

## 2. 部署路径与文件

| 路径 | 用途 |
|------|------|
| `/opt/telemetry_agent/` | 程序目录 |
| `/opt/telemetry_agent/telemetry_agent.py` | 主程序 |
| `/etc/telemetry-agent.env` | 环境变量配置 |
| `/etc/systemd/system/telemetry-agent.service` | systemd 服务文件 |
| `/var/lib/telemetry-agent/spool.db` | 离线消息缓冲数据库 |

---

## 3. 配置文件

### 3.1 环境变量 `/etc/telemetry-agent.env`

```bash
DEVICE_ID=pi4-001
DHT_GPIO=D4
SIM7600_AT_PORT=/dev/ttyUSB2

MQTT_HOST=192.168.50.196
MQTT_PORT=1883
MQTT_TOPIC=devices/pi4-001/telemetry
MQTT_USERNAME=
MQTT_PASSWORD=

# TLS 模式（按需启用）
# MQTT_TLS=1
# MQTT_PORT=8883
# MQTT_CA_CERT=/etc/ssl/certs/ca-certificates.crt

INTERVAL_SEC=5
SPOOL_DB=/var/lib/telemetry-agent/spool.db
```

**配置说明**：

| 变量 | 说明 | 修改频率 |
|------|------|----------|
| `DEVICE_ID` | 设备唯一标识，对应后端 devices 表 | 仅新设备时改 |
| `DHT_GPIO` | DHT11 数据引脚，board 库命名 (D4=物理 GPIO4) | 仅换线时改 |
| `SIM7600_AT_PORT` | SIM7600 AT 指令串口 | 通常固定 |
| `MQTT_HOST` | Broker 地址（局域网或公网） | 切换环境时改 |
| `MQTT_TOPIC` | 上报主题，格式 `devices/{id}/telemetry` | 仅新设备时改 |
| `INTERVAL_SEC` | 采样周期(秒)，DHT11 建议 >=2s | 按需调整 |

### 3.2 systemd 服务文件 `/etc/systemd/system/telemetry-agent.service`

```ini
[Unit]
Description=Telemetry Agent (DHT11 + SIM7600 GNSS + MQTT)
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/opt/telemetry_agent
EnvironmentFile=/etc/telemetry-agent.env
ExecStart=/usr/bin/python3 /opt/telemetry_agent/telemetry_agent.py
Restart=always
RestartSec=5
SupplementaryGroups=dialout gpio

[Install]
WantedBy=multi-user.target
```

---

## 4. 日常运维命令

### 4.1 服务管理

```bash
# 查看状态
sudo systemctl status telemetry-agent --no-pager

# 查看日志（最近 100 行）
sudo journalctl -u telemetry-agent -n 100 --no-pager

# 实时跟踪日志
sudo journalctl -u telemetry-agent -f

# 重启服务
sudo systemctl restart telemetry-agent

# 停止 / 启动
sudo systemctl stop telemetry-agent
sudo systemctl start telemetry-agent

# 开机自启
sudo systemctl enable telemetry-agent

# 修改配置后重载
sudo systemctl daemon-reload
sudo systemctl restart telemetry-agent
```

### 4.2 硬件检查

```bash
# 查看 SIM7600 串口设备是否识别
ls -l /dev/ttyUSB*

# 查看谁占用了 AT 串口
sudo lsof /dev/ttyUSB2
sudo fuser -v /dev/ttyUSB2

# 检查 GPIO 权限
groups pi   # 应包含 dialout, gpio
```

### 4.3 网络检查

```bash
# 查看网络接口
ip addr

# 查看默认路由（判断出口走 wlan0 还是 usb0）
ip route

# 测试到 MQTT Broker 连通性
nc -vz 192.168.50.196 1883

# 手动订阅验证上报（在 Broker 所在机器执行）
mosquitto_sub -h 127.0.0.1 -p 1883 -t "devices/pi4-001/#" -v
```

### 4.4 离线缓冲检查

```bash
# 查看 spool 积压量
sqlite3 /var/lib/telemetry-agent/spool.db "SELECT COUNT(1) FROM spool;"

# 查看最旧的未发消息
sqlite3 /var/lib/telemetry-agent/spool.db "SELECT id, ts, payload FROM spool ORDER BY id ASC LIMIT 3;"

# 清空 spool（确认不需要时）
sqlite3 /var/lib/telemetry-agent/spool.db "DELETE FROM spool;"
```

---

## 5. 上报数据格式

### 5.1 MQTT Topic

```
devices/pi4-001/telemetry     # 遥测数据
devices/pi4-001/status        # 设备状态 (LWT: online/offline)
```

### 5.2 Payload 示例

**正常采集（有真实 GPS 定位）**：
```json
{
  "device_id": "pi4-001",
  "ts": 1776233992,
  "temp_c": 22.6,
  "rh": 63,
  "gps": {
    "fix": true,
    "lat": 30.65900166,
    "lon": 114.21378161,
    "alt_m": 92.1,
    "speed_kmh": 0.0,
    "course_deg": null,
    "fallback": false
  },
  "errors": []
}
```

**GPS 回退模式（看到卫星但未锁定）**：
```json
{
  "device_id": "pi4-001",
  "ts": 1776233852,
  "temp_c": 22.7,
  "rh": 62,
  "gps": {
    "fix": true,
    "lat": 30.681732,
    "lon": 114.183271,
    "fallback": true,
    "fallback_reason": "visible_satellites_but_no_valid_fix",
    "visible_satellites": 2
  },
  "errors": []
}
```

> **注意**：`fallback: true` 时坐标为配置的默认值，不是真实定位。后端已做过滤，不会用 fallback 坐标做围栏匹配。

**DHT 读取失败**：
```json
{
  "device_id": "pi4-001",
  "ts": 1776233805,
  "temp_c": null,
  "rh": null,
  "gps": {"fix": false},
  "errors": ["DHT read error: Checksum did not validate. Try again."]
}
```

### 5.3 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `ts` | int | Unix 时间戳（秒），后端自动识别秒/毫秒 |
| `temp_c` | float/null | 温度(°C)，DHT 失败时为 null |
| `rh` | int/null | 相对湿度(%)，DHT 失败时为 null |
| `gps.fix` | bool | 是否有定位（含 fallback 场景） |
| `gps.fallback` | bool | true 表示使用默认坐标，非真实定位 |
| `errors` | string[] | 设备端错误信息，空数组表示正常 |

---

## 6. 常见故障排查

### 6.1 服务反复重启 (exit 1)

```bash
sudo journalctl -u telemetry-agent -n 50 --no-pager
```

| 日志关键词 | 原因 | 修复 |
|------------|------|------|
| `PermissionError: '/var/lib/telemetry-agent'` | spool 目录权限不足 | `sudo chown -R pi:pi /var/lib/telemetry-agent && sudo chmod 750 /var/lib/telemetry-agent` |
| `SerialException: Device or resource busy` | AT 串口被占用 | 见 6.2 |
| `ModuleNotFoundError` | Python 依赖缺失 | `pip3 install adafruit-circuitpython-dht pyserial paho-mqtt` |

### 6.2 串口被 ModemManager 占用

```bash
# 确认占用者
sudo lsof /dev/ttyUSB2

# 如果是 ModemManager
sudo systemctl stop ModemManager
sudo systemctl disable ModemManager

# 验证释放
sudo lsof /dev/ttyUSB2   # 应无输出
sudo systemctl restart telemetry-agent
```

> usb0 (RNDIS) 上网不依赖 ModemManager。如果未来需要用 ModemManager 做拨号/短信，需要把 GNSS 改到 NMEA 口（通常 `/dev/ttyUSB1`）。

### 6.3 DHT11 频繁 Checksum 错误

**现象**：errors 里持续出现 `Checksum did not validate`，temp_c/rh 为 null。

**排查**：
1. 检查杜邦线是否松动、线长是否超过 20cm
2. 确认 3.3V 供电稳定，建议加 10μF 去耦电容
3. DHT11 采样间隔不要低于 2s（当前配置 5s，合理）
4. 偶发 1~2 次属正常，连续失败说明硬件问题

### 6.4 GPS 长时间无法定位（持续 fallback）

**现象**：所有消息都是 `fallback: true`，`visible_satellites` 很少。

**排查**：
1. 天线是否在室外或靠窗，室内基本无法定位
2. SIM7600 GNSS 天线接口是否连接
3. 冷启动首次定位需要 1~5 分钟

```bash
# 手动测试 AT 指令
sudo python3 -c "
import serial
ser = serial.Serial('/dev/ttyUSB2', 115200, timeout=2)
ser.write(b'AT+CGPSINFO\r\n')
import time; time.sleep(1)
print(ser.read(512).decode(errors='ignore'))
ser.close()
"
```

返回 `+CGPSINFO: ,,,,,,,,` 表示无定位；有数字填充表示已锁定。

### 6.5 MQTT 连接失败 / spool 持续积压

```bash
# 检查 spool 积压
sqlite3 /var/lib/telemetry-agent/spool.db "SELECT COUNT(1) FROM spool;"

# 检查 Broker 连通
nc -vz 192.168.50.196 1883
```

| 场景 | 原因 | 修复 |
|------|------|------|
| nc 连不上 | Broker 未启动 / 防火墙 / IP 变了 | 检查 Broker 状态，确认 IP |
| nc 通但 spool 积压 | 认证失败 / topic 被拒 | 检查 MQTT_USERNAME/PASSWORD |
| 服务正常但 Broker 侧收不到 | topic 不匹配 | 用 `#` 全量订阅排查 |

---

## 7. 新增终端部署步骤

为新树莓派部署采集服务：

```bash
# 1. 安装依赖
sudo apt update
sudo apt install -y python3-pip libgpiod2
pip3 install adafruit-circuitpython-dht pyserial paho-mqtt

# 2. 部署程序
sudo mkdir -p /opt/telemetry_agent
sudo cp telemetry_agent.py /opt/telemetry_agent/

# 3. 创建配置（修改 DEVICE_ID 和 MQTT_HOST）
sudo cp /etc/telemetry-agent.env /etc/telemetry-agent.env.bak
sudo nano /etc/telemetry-agent.env

# 4. 创建 spool 目录
sudo mkdir -p /var/lib/telemetry-agent
sudo chown -R pi:pi /var/lib/telemetry-agent
sudo chmod 750 /var/lib/telemetry-agent

# 5. 确保用户权限
sudo usermod -aG dialout,gpio pi

# 6. 禁用 ModemManager（避免串口冲突）
sudo systemctl stop ModemManager
sudo systemctl disable ModemManager

# 7. 安装并启动服务
sudo cp telemetry-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable telemetry-agent
sudo systemctl start telemetry-agent

# 8. 验证
sudo systemctl status telemetry-agent --no-pager
sudo journalctl -u telemetry-agent -n 20 --no-pager
```

---

## 8. 环境切换

### 本地联调（Windows Broker）

```bash
# /etc/telemetry-agent.env
MQTT_HOST=192.168.50.196
MQTT_PORT=1883
MQTT_USERNAME=
MQTT_PASSWORD=
```

Windows 端需确保：
- Mosquitto 监听 `0.0.0.0:1883`（非 127.0.0.1）
- 防火墙入站放行 TCP 1883

### 生产环境（云服务器 Broker）

```bash
# /etc/telemetry-agent.env
MQTT_HOST=dht.leenf.online
MQTT_PORT=1883
MQTT_USERNAME=telemetry_user
MQTT_PASSWORD=<密码>
```

修改后执行：

```bash
sudo systemctl restart telemetry-agent
```
