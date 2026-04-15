# 树莓派 Pi4：温湿度（DHT11）+ GPS（SIM7600CE）+ MQTT 上报 实操记录（不含 PRD）

> 本文整理自本次聊天的所有问答与排障过程，用于后续终端系统维护与复用。**不包含 PRD 需求内容**。

---

## 1. 目标与现状

你使用 **Raspberry Pi 4**，接入：

- 温湿度传感器（DHT11）采集温度/湿度
- Waveshare **SIM7600CE 4G HAT** 获取 GNSS（GPS/北斗等）定位
- 通过 **MQTT** 上报到 IoT 平台（或 Windows 本地 Broker 做联调）

---

## 2. 网络与出口判断（wlan0 + usb0 共存）

你树莓派同时存在：

- `wlan0`：192.168.50.52（Wi-Fi）
- `usb0`：192.168.225.55（SIM7600 RNDIS 网卡）

结论：

- MQTT 默认会走系统默认路由（不需要额外配置）
- 是否会“走错出口”，取决于 **默认路由**
- 若希望“强制某个 Broker 走某个网卡”，建议：
  - **定向路由**：只对 Broker IP 添加 host route
  - 或程序层绑定源地址（更高级）

常用检查：

```bash
ip route
```

---

## 3. Windows 上安装与测试 MQTT（Broker + 订阅/发布）

### 3.1 Mosquitto 端口占用（1883 被占）

你启动：

```powershell
mosquitto.exe -v
```

报错：端口 1883 已被占用（典型原因：系统已有 mosquitto 服务在跑）。

定位占用进程：

```powershell
netstat -ano | findstr :1883
tasklist /FI "PID eq <PID>"
```

如果是服务占用：

```powershell
sc query mosquitto
net stop mosquitto
net start mosquitto
```

### 3.2 “local only mode”（只能 127.0.0.1）

你看到 broker 只监听 `127.0.0.1`，外部（树莓派）无法连接。

解决：编辑 `mosquitto.conf` 增加监听（联调期）：

```conf
listener 1883 0.0.0.0
allow_anonymous true
```

然后重启 mosquitto 服务。

### 3.3 Windows 防火墙放行 1883

需要在 **入站规则** 放行 TCP 1883：

（命令行方式）

```powershell
netsh advfirewall firewall add rule name="MQTT 1883" dir=in action=allow protocol=TCP localport=1883
```

### 3.4 订阅/发布测试

订阅所有 topic（排障很有用）：

```powershell
mosquitto_sub.exe -h 127.0.0.1 -p 1883 -t "#" -v
```

发布一条消息：

```powershell
mosquitto_pub.exe -h 127.0.0.1 -p 1883 -t test/topic -m "hello"
```

树莓派要连 Windows broker：

- Broker host 用 Windows IP，例如：`192.168.50.196`
- topic 订阅建议先用 `#` 全量确认

---

## 4. 树莓派正式采集服务部署（systemd + env）

你使用了一个长期运行的采集程序：

- DHT11 读温湿度
- SIM7600 AT 指令读 GNSS
- MQTT 上报
- SQLite spool（断网缓存）
- systemd 自启动

### 4.1 关键配置文件：/etc/telemetry-agent.env

主要关心：

- `MQTT_HOST` / `MQTT_PORT` / `MQTT_TOPIC`
- `SIM7600_AT_PORT=/dev/ttyUSB2`
- `DHT_GPIO=Dx`（例如 D4）

当 Windows 做 broker：

- `MQTT_HOST=192.168.50.196`

### 4.2 systemd 服务文件：/etc/systemd/system/telemetry-agent.service

你最终状态：服务以 `User=pi` 运行。

常用命令：

```bash
sudo systemctl daemon-reload
sudo systemctl restart telemetry-agent
sudo systemctl status telemetry-agent --no-pager
sudo journalctl -u telemetry-agent -n 80 --no-pager
```

---

## 5. 典型故障与修复

### 5.1 Permission denied: /var/lib/telemetry-agent

现象：

- 服务一直 `exit 1` 重启
- 日志：`PermissionError: [Errno 13] Permission denied: '/var/lib/telemetry-agent'`

原因：

- `User=pi` 无权限创建/写入 spool 目录

修复：

```bash
sudo mkdir -p /var/lib/telemetry-agent
sudo chown -R pi:pi /var/lib/telemetry-agent
sudo chmod 750 /var/lib/telemetry-agent
sudo systemctl restart telemetry-agent
```

### 5.2 /dev/ttyUSB2 Device or resource busy

现象：

- 日志：`SerialException: could not open port /dev/ttyUSB2: [Errno 16] Device or resource busy`

定位：

```bash
sudo lsof /dev/ttyUSB2
sudo fuser -v /dev/ttyUSB2
```

你查到占用者：

- `ModemManager` 占用 `/dev/ttyUSB2`

修复（推荐）：

```bash
sudo systemctl stop ModemManager
sudo systemctl disable ModemManager
sudo lsof /dev/ttyUSB2  # 应无输出
sudo systemctl restart telemetry-agent
```

> 备注：很多情况下 usb0（RNDIS）上网不依赖 ModemManager；但若未来要用它做拨号/短信管理，需要再评估策略（例如 GNSS 走 NMEA 口，避免抢占）。

### 5.3 pi 用户无串口/GPIO 权限（预防性措施）

建议把 pi 加入相关组，并在 service 里声明补充组：

```bash
sudo usermod -aG dialout,gpio pi
```

service 中（可选增强）：

```ini
SupplementaryGroups=dialout gpio
```

检查串口设备：

```bash
ls -l /dev/ttyUSB*
ls -l /dev/ttyUSB2
```

---

## 6. MQTT 订阅不到消息的排障顺序（最有效）

当你订阅窗口无消息时，不用重启电脑，按顺序确认：

1) Windows 本机闭环：`sub` 能否收到 `pub`
2) Windows broker 是否监听在 `0.0.0.0:1883`（不是 127.0.0.1）
3) Windows 防火墙入站是否放行 1883
4) 树莓派到 Windows 端口是否可达：

```bash
nc -vz 192.168.50.196 1883
```

5) 树莓派服务是否在跑、是否报错：

```bash
sudo journalctl -u telemetry-agent -n 80 --no-pager
```

6) Topic 是否一致：建议先用 `#` 全量订阅确认

---

## 7. 已验证的 MQTT 上报消息示例

你成功收到的消息（示例）：

- Topic：`devices/pi4-001/telemetry`

```json
{
  "device_id": "pi4-001",
  "ts": 1769594746,
  "temp_c": 17.4,
  "rh": 45,
  "gps": {
    "fix": true,
    "lat": 30.65900166666667,
    "lon": 114.21378161666667,
    "date": "280126",
    "utc_raw": "100543.0",
    "alt_m": 92.1,
    "speed_kmh": 0.0,
    "course_deg": null
  },
  "errors": []
}
```

---

## 8. DHT11 读数偶发错误：Checksum did not validate

现象：

- 上报出现：`DHT read error: Checksum did not validate. Try again`

原因（高概率）：

- DHT 单总线时序敏感，偶发干扰/调度抖动/线材接触不良导致校验失败

建议（工程化处理）：

- 每轮读取允许重试 2~3 次，成功即用，失败则上报 `temp/rh=null` 且记录 errors
- 采样周期不要过短（DHT11 建议 >=2s）
- 硬件侧：线更短、接触更牢、3.3V 供电、上拉电阻合适、加去耦电容

---

## 9. 维护速查命令

查看服务状态：

```bash
sudo systemctl status telemetry-agent --no-pager
```

查看最近日志：

```bash
sudo journalctl -u telemetry-agent -n 80 --no-pager
```

重启服务：

```bash
sudo systemctl restart telemetry-agent
```

检查端口连通（树莓派->Windows MQTT）：

```bash
nc -vz 192.168.50.196 1883
```

查谁占用 AT 口：

```bash
sudo lsof /dev/ttyUSB2
```

---

## 10. 后续建议（可选）

- 若未来必须同时使用 ModemManager（拨号/短信）与 GNSS，推荐：
  - GNSS 改读 NMEA 输出口（常见 ttyUSB1）
  - 或在程序中对串口 busy 做等待重试，避免服务雪崩重启

---

**完**

