# Go2 室内温湿度采集系统 — 部署与测试指南

## 1. 树莓派环境准备

### 1.1 系统要求

- Raspberry Pi 4B（已验证：Raspberry Pi OS 64-bit, kernel 6.12.75）
- Python 3.8+
- Pi 与 Go2 通过网线直连或同交换机（同网段）
- Pi 具备 4G 上网能力（用于 MQTT 上报）

### 1.2 网络拓扑确认

Go2 默认 IP 段为 `192.168.123.x`，Pi 需要在同一子网。

```bash
# 查看 Pi 的网口
ip addr show

# 确认 eth0（或你连 Go2 的网口）在 192.168.123.x 段
# 如果不在，手动设置：
sudo ip addr add 192.168.123.100/24 dev eth0

# 测试与 Go2 的连通性（Go2 默认 IP 通常是 192.168.123.15）
ping 192.168.123.15
```

### 1.3 项目部署

```bash
# 创建部署目录
sudo mkdir -p /opt/go2-env-agent
sudo chown pi:pi /opt/go2-env-agent

# 拷贝项目文件（从开发机拷贝到 Pi）
# 方法一：scp
scp -r go2_env_agent/* pi@<PI_IP>:/opt/go2-env-agent/

# 方法二：U盘拷贝后
cp -r /media/pi/USB/go2_env_agent/* /opt/go2-env-agent/

# 创建 Python 虚拟环境
cd /opt/go2-env-agent
python3 -m venv venv
source venv/bin/activate
```

### 1.4 安装依赖

```bash
# 激活虚拟环境
cd /opt/go2-env-agent
source venv/bin/activate

# 安装基础依赖
pip install paho-mqtt==1.6.1 pyyaml requests numpy pytest

# 安装 DHT11 传感器库（需要 Pi 的 GPIO 支持）
pip install adafruit-circuitpython-dht
sudo apt-get install -y libgpiod2

# 安装 CycloneDDS（Go2 SDK2 的 DDS 通信层）
pip install cyclonedds

# 安装 Unitree SDK2 Python
cd /tmp
git clone https://github.com/unitreerobotics/unitree_sdk2_python.git
cd unitree_sdk2_python
pip install -e .
cd /opt/go2-env-agent
```

### 1.5 验证依赖安装

```bash
source /opt/go2-env-agent/venv/bin/activate

python3 -c "import paho.mqtt.client; print('paho-mqtt OK')"
python3 -c "import yaml; print('pyyaml OK')"
python3 -c "import board; import adafruit_dht; print('DHT11 libs OK')"
python3 -c "import cyclonedds; print('cyclonedds OK')"
python3 -c "from unitree_sdk2py.core.channel import ChannelFactoryInitialize; print('unitree_sdk2py OK')"
```

如果某一行报错，说明对应的库未安装成功，请根据错误信息排查。

---

## 2. 分步测试（按顺序执行）

> **原则：每一步验证通过后再进入下一步。遇到问题先解决，不要跳步。**

---

### 测试 1：Go2 位姿读取（最关键）

这是整个系统的基础。如果这一步跑不通，后面全部无法进行。

#### 前置条件
- Pi 与 Go2 网线直连或同网段
- Go2 已开机并正常站立（SLAM 需要机器人处于运动模式）

#### 执行

```bash
cd /opt/go2-env-agent
source venv/bin/activate

# 默认使用 eth0 网口
python3 debug/debug_pose.py --iface eth0

# 如果你的 Go2 连接在其他网口（如 enp3s0），指定网口：
python3 debug/debug_pose.py --iface enp3s0

# 调整打印间隔（默认1秒，可设为0.5秒看更实时的数据）
python3 debug/debug_pose.py --iface eth0 --interval 0.5
```

#### 预期输出（成功）

```
Starting Go2PoseSDK on eth0, topic=rt/sportmodestate
Go2PoseSDK: subscribed to rt/sportmodestate on eth0
[OK]  x=  +0.012  y=  -0.003  z=  +0.320  yaw= +0.015
[OK]  x=  +0.012  y=  -0.003  z=  +0.320  yaw= +0.015
[OK]  x=  +0.015  y=  -0.001  z=  +0.320  yaw= +0.018
```

让 Go2 走动几步，观察 x/y 值是否随之变化。

#### 预期输出（失败 — 无数据）

```
Starting Go2PoseSDK on eth0, topic=rt/sportmodestate
Go2PoseSDK: subscribed to rt/sportmodestate on eth0
[NO FIX] error=no_pose_received_yet
[NO FIX] error=no_pose_received_yet
[NO FIX] error=no_pose_received_yet
```

#### 故障排查

| 现象 | 可能原因 | 解决方案 |
|------|---------|---------|
| 持续 `no_pose_received_yet` | Pi 与 Go2 不在同网段 | `ip addr show` 检查 IP，确保同一 192.168.123.x 段 |
| 持续 `no_pose_received_yet` | 网口名称不对 | `ip link show` 找到正确的网口名 |
| 持续 `no_pose_received_yet` | Go2 未启动运动模式 | 确保 Go2 站立，运动控制器已启动 |
| 持续 `no_pose_received_yet` | DDS 多播被阻断 | 检查交换机/路由器是否阻挡多播 |
| `ImportError: unitree_sdk2py` | SDK 未安装 | 重新执行 1.4 中的 SDK 安装步骤 |
| x/y/z 不变化 | Go2 静止不动 | 用遥控器控制 Go2 移动，观察坐标变化 |
| 数据有但跳动很大 | SLAM 未初始化 | 让 Go2 在环境中走一圈完成 SLAM 初始化 |

#### 通过标准
- [x] 连续运行 5 分钟无崩溃
- [x] x/y 值随 Go2 移动而变化
- [x] 数值合理（室内尺度，通常在 ±50 米以内）
- [x] Ctrl+C 可正常退出

---

### 测试 2：点位匹配（可在 Pi 或开发机上测试）

#### 执行

```bash
cd /opt/go2-env-agent
source venv/bin/activate

# 交互式测试
python3 debug/debug_matcher.py

# 或指定自定义点位文件
python3 debug/debug_matcher.py --points app/config/points.yaml
```

#### 交互示例

```
Loaded 5 points from app/config/points.yaml
Area: warehouse_1f, dwell_count=3
Enter x y (space-separated), or 'q' to quit:

> 2.1 1.8
  -> A1 (dist=0.000, type=timed, area=warehouse_1f)
> 2.1 1.8
  -> A1 (dist=0.000, type=timed, area=warehouse_1f)
> 2.1 1.8
  -> A1 (dist=0.000, type=point_valid, area=warehouse_1f)
> 100 100
  -> No match (area=warehouse_1f)
> 6.4 2.0
  -> A2 (dist=0.000, type=timed, area=warehouse_1f)
> q
```

#### 通过标准
- [x] 输入点位中心坐标，返回正确 point_id
- [x] 输入远离所有点位的坐标，返回 No match
- [x] 连续输入同一坐标 3 次后，type 从 timed 变为 point_valid
- [x] 切换到其他点位后，dwell 计数重置

#### 运行自动化测试

```bash
cd /opt/go2-env-agent
source venv/bin/activate
python3 -m pytest tests/ -v
```

预期：27 passed。

---

### 测试 3：DHT11 温湿度传感器

#### 前置条件
- DHT11 已接线：VCC → 3.3V, GND → GND, DATA → GPIO4 (即 D4)

#### 执行

```bash
cd /opt/go2-env-agent
source venv/bin/activate

python3 -c "
from app.providers.dht11_reader import DHTReader
import time

reader = DHTReader('D4')
for i in range(10):
    t, h, err = reader.read()
    if err:
        print(f'[{i}] Error: {err}')
    else:
        print(f'[{i}] temp={t}°C  humidity={h}%')
    time.sleep(2)
"
```

#### 预期输出

```
[0] temp=26°C  humidity=61%
[1] Error: DHT read error: A full buffer was not returned. ...
[2] temp=26°C  humidity=60%
[3] temp=26°C  humidity=61%
```

> DHT11 偶尔读取失败是**正常现象**（时序敏感），只要大部分读数成功即可。

#### 故障排查

| 现象 | 可能原因 | 解决方案 |
|------|---------|---------|
| 全部 Error | GPIO 引脚不对 | 确认 DATA 线接的是哪个 GPIO，改为对应的 `D<N>` |
| 全部 Error | 缺少 libgpiod | `sudo apt-get install libgpiod2` |
| ImportError: board | 库未安装 | `pip install adafruit-circuitpython-dht` |
| 温度明显偏高 | 传感器贴近发热元件 | 用延长线将 DHT11 引到通风处 |

#### 通过标准
- [x] 10 次读取中至少 7 次成功
- [x] 温度值在合理范围（0-50°C）
- [x] 湿度值在合理范围（20-90%）

---

### 测试 4：MQTT 连通性

#### 前置条件
- MQTT Broker 可达（Pi 的 4G 网络正常）

#### 执行

```bash
cd /opt/go2-env-agent
source venv/bin/activate

python3 -c "
import paho.mqtt.client as mqtt
import json, time

BROKER = '你的MQTT地址'  # 替换为实际地址
PORT = 1883              # 替换为实际端口

client = mqtt.Client(client_id='go2-test-client')
# 如果需要认证，取消下面这行的注释：
# client.username_pw_set('username', 'password')

connected = {'ok': False}

def on_connect(c, u, f, rc):
    connected['ok'] = (rc == 0)
    print(f'Connected: rc={rc}')

client.on_connect = on_connect
client.connect(BROKER, PORT, keepalive=30)
client.loop_start()
time.sleep(3)

if connected['ok']:
    payload = {
        'device_id': 'go2_test',
        'ts': int(time.time()),
        'temp_c': 25,
        'rh': 60,
        'zone_id': 'A1',
        'gps': {'fix': False, 'lat': None, 'lon': None, 'fallback': False},
        'pose': {'source': 'go2_slam', 'frame': 'map', 'fix': True, 'x': 2.1, 'y': 1.8, 'z': 0.0, 'yaw': 0.0},
        'point_id': 'A1',
        'area_id': 'warehouse_1f',
        'sample_type': 'point_valid',
        'errors': []
    }
    info = client.publish('devices/go2_test/telemetry', json.dumps(payload), qos=1)
    info.wait_for_publish()
    print(f'Published: mid={info.mid}')
    print(f'Payload: {json.dumps(payload, indent=2)}')
else:
    print('MQTT connection failed')

client.loop_stop()
client.disconnect()
"
```

#### 通过标准
- [x] 输出 `Connected: rc=0`
- [x] 输出 `Published: mid=...`
- [x] 后端能收到这条测试消息

#### 后端验证

在后端数据库中确认数据已入库：

```sql
SELECT device_id, zone_id, temp_c, rh, pose_source, pos_x, pos_y, point_id, sample_type
FROM telemetry_raw
WHERE device_id = 'go2_test'
ORDER BY ts DESC
LIMIT 5;
```

> **注意**：如果后端还没执行过 `add_pose_columns.sql`，新字段会缺失。请先执行数据库迁移（见第 3 节）。

---

### 测试 5：主程序完整联调

#### 5.1 配置文件

```bash
# 拷贝配置模板
cp /opt/go2-env-agent/app/config/settings.env /opt/go2-env-agent/config/settings.env

# 编辑配置
nano /opt/go2-env-agent/config/settings.env
```

**必须修改的配置项**：

```env
DEVICE_ID=go2_01            # 你的设备ID
DHT_GPIO=D4                 # DHT11 的 GPIO 引脚
GO2_NET_IFACE=eth0          # 连接 Go2 的网口名
MQTT_HOST=你的MQTT地址       # MQTT Broker 地址
MQTT_PORT=1883              # MQTT Broker 端口
MQTT_TOPIC=devices/go2_01/telemetry
```

#### 5.2 创建数据目录

```bash
sudo mkdir -p /var/lib/go2-env-agent
sudo chown pi:pi /var/lib/go2-env-agent
```

#### 5.3 手动运行

```bash
cd /opt/go2-env-agent
source venv/bin/activate

# 加载环境变量
set -a
source config/settings.env
set +a

# 启动主程序
python3 -m app.main
```

#### 预期输出

```
2026-04-17 16:00:00 INFO go2-env-agent: started: device=go2_01 source=go2_slam interval=5s points=5
Go2PoseSDK: subscribed to rt/sportmodestate on eth0
```

每 5 秒一个采集周期，每 30 个周期打印一次状态日志：

```
2026-04-17 16:02:30 INFO app.services.telemetry_service: cycle=30 spool=0 flushed=1 mqtt=True pose_fix=True point=A2
```

#### 故障排查

| 现象 | 可能原因 | 解决方案 |
|------|---------|---------|
| `Missing env vars: [...]` | 环境变量未加载 | 确保执行了 `set -a; source config/settings.env; set +a` |
| `spool` 持续增长，`flushed=0` | MQTT 连不上 | 检查 MQTT_HOST/PORT 是否正确，4G 网络是否通 |
| `pose_fix=False` | Go2 位姿读不到 | 回到测试 1 排查 |
| `point=None` | 当前坐标不在任何点位范围内 | 正常现象；或需要调整 points.yaml 的坐标和半径 |

#### 通过标准
- [x] 启动无报错
- [x] pose_fix=True（Go2 位姿正常）
- [x] spool 不持续积压（mqtt flush 正常）
- [x] 移动 Go2 到不同点位时 point 值变化
- [x] Ctrl+C 优雅退出

---

### 测试 6：断网缓存补传

```bash
# 1. 正常运行主程序
python3 -m app.main &

# 2. 等待几个周期确认正常上报

# 3. 模拟断网（关闭 4G 网卡或拔 SIM 卡）
sudo ifconfig wwan0 down   # 或你的 4G 网口名

# 4. 观察日志，spool 数量应该持续增长
#    mqtt=False, spool=15, flushed=0 ...

# 5. 恢复网络
sudo ifconfig wwan0 up

# 6. 观察 spool 是否逐渐清空
#    mqtt=True, spool=3, flushed=5 ...
#    mqtt=True, spool=0, flushed=3 ...
```

#### 通过标准
- [x] 断网后数据写入本地 spool，不丢失
- [x] 恢复网络后 spool 自动清空
- [x] 后端收到补传的历史数据

---

### 测试 7：长时间稳定性

```bash
# 以 systemd 服务运行
sudo cp /opt/go2-env-agent/systemd/go2-env-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable go2-env-agent
sudo systemctl start go2-env-agent

# 查看运行状态
sudo systemctl status go2-env-agent

# 查看实时日志
sudo journalctl -u go2-env-agent -f
```

运行 24 小时后检查：

```bash
# 1. 服务是否还活着
sudo systemctl is-active go2-env-agent

# 2. spool 有没有异常积压
source /opt/go2-env-agent/venv/bin/activate
python3 -c "
from app.storage.spool import Spool
s = Spool('/var/lib/go2-env-agent/spool.db')
print(f'Spool size: {s.count()}')
"

# 3. 后端数据是否持续到达
# 在后端执行：
# SELECT COUNT(*) FROM telemetry_raw WHERE device_id='go2_01' AND ts >= NOW() - INTERVAL 24 HOUR;
```

#### 通过标准
- [x] 进程 24 小时无崩溃
- [x] spool 大小稳定在低水位（< 10 条）
- [x] 后端持续收到数据（每 5 秒一条）
- [x] 无内存泄漏（`ps aux | grep python` 查看 RSS 稳定）

---

## 3. 后端数据库迁移

在执行测试 4 的后端验证之前，需要先更新数据库：

```bash
# 在后端服务器上执行
mysql -u root -p warehouse_iot < sql/add_pose_columns.sql
```

验证迁移成功：

```sql
DESCRIBE telemetry_raw;
-- 应该能看到新增的列：
-- pose_source, pose_fix, pos_x, pos_y, pos_z, yaw, point_id, sample_type
```

> 此迁移为纯 ADD COLUMN，不影响现有数据和查询，可以安全执行。

---

## 4. 现场标定流程

当测试 1-7 全部通过后，需要进行现场标定来确定 `points.yaml` 中各点位的真实 SLAM 坐标。

### 标定步骤

```bash
# 1. 启动位姿调试工具
python3 debug/debug_pose.py --iface eth0 --interval 0.5

# 2. 用遥控器控制 Go2 走到 A1 区域中心位置
#    记录此时输出的 x/y 值，例如：
#    [OK]  x=  +3.215  y=  +1.042  ...

# 3. 依次走到 A2、A3、A4、A5 的中心位置，记录 x/y

# 4. 编辑 points.yaml，替换占位坐标
nano /opt/go2-env-agent/app/config/points.yaml
```

### 标定后的 points.yaml 示例

```yaml
area_id: warehouse_1f
points:
  - id: A1
    name: 原料接收区 A1
    x: 3.215       # 实际标定值
    y: 1.042       # 实际标定值
    radius: 1.2    # 根据区域大小调整
  - id: A2
    name: 初加工区 A2
    x: 8.731
    y: 1.185
    radius: 1.2
  # ... 其他点位同理
```

### 标定后验证

```bash
# 重启服务使新配置生效
sudo systemctl restart go2-env-agent

# 控制 Go2 依次走到各点位，观察日志中 point 是否正确切换
sudo journalctl -u go2-env-agent -f
```

---

## 5. 快速参考

### 常用命令

```bash
# 启动/停止/重启服务
sudo systemctl start go2-env-agent
sudo systemctl stop go2-env-agent
sudo systemctl restart go2-env-agent

# 查看日志
sudo journalctl -u go2-env-agent -f          # 实时
sudo journalctl -u go2-env-agent --since today  # 今天的

# 检查 spool 积压
source /opt/go2-env-agent/venv/bin/activate
python3 -c "from app.storage.spool import Spool; print(Spool('/var/lib/go2-env-agent/spool.db').count())"

# 运行测试
cd /opt/go2-env-agent && source venv/bin/activate && python3 -m pytest tests/ -v
```

### 文件位置

| 用途 | 路径 |
|------|------|
| 程序代码 | `/opt/go2-env-agent/app/` |
| 配置文件 | `/opt/go2-env-agent/config/settings.env` |
| 点位配置 | `/opt/go2-env-agent/app/config/points.yaml` |
| 本地缓存 | `/var/lib/go2-env-agent/spool.db` |
| systemd 服务 | `/etc/systemd/system/go2-env-agent.service` |
| 日志 | `journalctl -u go2-env-agent` |
