# Go2 + 树莓派 Pi4B 室内 SLAM 空间温湿度采集系统开发任务手册

## 1. 文档目的

本文档用于指导当前项目从“GPS + DHT11 + MQTT 的室外/通用数采方案”，升级为“Go2 室内 SLAM 位姿 + DHT11 温湿度 + MQTT/HTTP 上报 + 室内点位展示”的完整开发实施方案。

本文档重点覆盖以下内容：

1. 项目目标与边界
2. 现状分析与改造思路
3. 系统总体架构
4. 环境与依赖配置
5. 代码结构设计
6. 模块级功能说明
7. 数据结构与接口设计
8. 详细开发步骤与任务计划
9. 测试验证方案
10. 部署与运维建议
11. 后续优化方向

---

## 2. 项目背景与目标

### 2.1 当前背景

当前系统已经具备以下能力：

- 树莓派 Pi4B 作为边缘采集终端运行 Python 采集脚本
- DHT11 温湿度采集功能已经跑通
- 本地 SQLite 缓存（spool）已经实现
- MQTT 上报链路已经实现
- 原有定位方式依赖 SIM7600 的 GNSS / GPS 信息

当前问题在于：

- GPS 在室内基本无法稳定定位
- 室内温湿度采集需要的是“空间位置”而不是“经纬度”
- 现有 GPS 坐标无法支撑仓库/楼层/室内区域级点位展示

### 2.2 本次改造目标

本次改造的核心目标是：

**将定位来源从 GPS 切换为 Go2 的 SLAM / 位姿数据，用于室内空间温湿度采集、点位映射与展示。**

具体目标包括：

1. 在树莓派上接入 Go2 的位姿数据读取能力
2. 用 Go2 的室内坐标（x, y, z, yaw）替代原 GPS 数据
3. 将温湿度数据与室内位姿进行绑定
4. 实现“定时采集 + 定点归属”的业务逻辑
5. 将融合后的数据推送到现有数采展示系统
6. 支持历史查询、点位展示、轨迹回放等后续扩展

### 2.3 1.0 版本范围

1.0 版本建议只覆盖以下范围：

- 读取 Go2 位姿
- 读取 DHT11 温湿度
- 建立室内点位映射逻辑
- 通过 MQTT/HTTP 上送融合数据
- 展示当前点位与历史温湿度数据

### 2.4 暂不纳入 1.0 的内容

以下内容建议放到 2.0 及以后版本：

- 多传感器融合定位
- 高精度温湿度校准与补偿
- 多机器人协同采集
- 自动建图与自动点位标定
- 三维可视化与空间热力图引擎
- 实时告警策略引擎

---

## 3. 现状代码分析与改造原则

### 3.1 现有代码能力总结

现有 `telemetry_agent.py` 已经具备良好的边缘采集基础架构：

- `Spool`：本地 SQLite 缓冲机制
- `DHTReader`：DHT11 采集模块
- `SIM7600GNSS`：GPS 定位模块
- `MQTTPub`：MQTT 推送模块
- `main()`：统一采集与上报主循环

### 3.2 改造原则

本次改造遵循以下原则：

1. **尽量保留现有稳定模块**
   - DHT11 读取逻辑保留
   - 本地缓存保留
   - MQTT 发布机制保留

2. **只替换定位来源模块**
   - 删除或停用 `SIM7600GNSS`
   - 新增 `Go2PoseReader`

3. **在不破坏主循环的前提下实现升级**
   - 保持“读取数据 -> 组包 -> 缓存 -> 上报”的基本流程不变

4. **定位抽象化**
   - 不把 Go2 逻辑直接写死在主循环中
   - 用统一的 `PositionProvider` 接口封装定位数据来源

5. **业务语义从 GPS 转换为室内点位坐标**
   - 不再依赖经纬度
   - 使用 `x / y / z / yaw + point_id / area_id` 作为业务主坐标

---

## 4. 总体技术架构

### 4.1 架构目标

构建一个以树莓派为边缘采集节点的室内移动环境采集系统。

### 4.2 总体架构说明

```text
Go2 机器人（SLAM/位姿）
        │
        │ 同网段通信（SDK2 / ROS2）
        ▼
树莓派 Pi4B
  ├─ Go2 位姿读取模块
  ├─ DHT11 温湿度读取模块
  ├─ 点位匹配模块
  ├─ 数据融合模块
  ├─ 本地缓存模块（SQLite）
  └─ 数据上传模块（MQTT / HTTP）
        │
        │ 4G 上网
        ▼
现有数采展示系统（windoor / Warehouse Telemetry）
  ├─ 数据接收接口
  ├─ 室内点位展示
  ├─ 历史数据查询
  └─ 后续轨迹回放 / 热力图展示
```

### 4.3 数据链路说明

1. Go2 在室内运行并输出当前位置 / 位姿
2. 树莓派通过 SDK2 或 ROS2 读取 Go2 位姿
3. 树莓派同时读取 DHT11 温湿度值
4. 通过点位匹配算法，将当前位姿映射为业务点位（如 A1、A2、A3）
5. 树莓派将位姿 + 点位 + 温湿度封装为统一 telemetry 数据
6. 数据先写入本地 SQLite 缓存
7. 网络正常时通过 MQTT 或 HTTP 推送到后端系统
8. 前端系统根据 `point_id` 或 `x/y` 进行展示

---

## 5. 定位方案设计

### 5.1 为什么不能继续用 GPS

GPS 的问题不在于“偶尔不准”，而在于室内环境中根本不具备稳定定位条件。

对当前项目而言，GPS 存在以下缺点：

- 室内无信号或信号极弱
- 不能支撑仓内、楼层内、走廊内等空间级位置表达
- 经度纬度不适合用于室内点位业务
- 与温湿度空间采集业务不匹配

### 5.2 为什么使用 Go2 的 SLAM / 位姿数据

Go2 的位姿数据本质上是室内地图坐标系下的位移结果，更适合当前需求。

使用 Go2 的位姿数据有以下优点：

- 适合室内环境
- 与机器人运动路径天然一致
- 可以直接表达 `x/y/z/yaw`
- 可以映射成业务点位
- 可以支持轨迹回放与室内空间可视化

### 5.3 推荐的定位数据形态

1.0 版本推荐统一使用如下结构：

```json
{
  "source": "go2_slam",
  "frame": "map",
  "fix": true,
  "x": 12.34,
  "y": 5.67,
  "z": 0.02,
  "yaw": 1.57
}
```

字段说明：

- `source`：定位来源，固定为 `go2_slam`
- `frame`：坐标系，建议为 `map`
- `fix`：是否获得有效位姿
- `x, y, z`：三维空间位置
- `yaw`：航向角

### 5.4 业务层不要直接使用原始位姿

建议业务层不要直接把实时 `x/y` 当作最终业务点位，而是做一层映射：

**实时位姿 -> 业务点位**

例如：

- `(2.1, 1.8)` -> A1
- `(6.4, 2.0)` -> A2
- `(10.2, 2.1)` -> A3

这样做的好处：

- 抗抖动
- 易展示
- 易统计
- 易与业务人员沟通
- 后续可接入告警与报表

---

## 6. 点位映射与空间采集设计

### 6.1 点位概念定义

本项目中的“定点采集”并不是 GPS 意义上的固定经纬度，而是：

**机器人位于某个业务采集点的空间范围内时，将当前温湿度归属到该点位。**

### 6.2 点位配置结构

建议用 YAML 管理点位配置，例如：

```yaml
area_id: warehouse_1f
points:
  - id: A1
    name: 入口区
    x: 2.1
    y: 1.8
    radius: 0.8
  - id: A2
    name: 通道中段
    x: 6.4
    y: 2.0
    radius: 0.8
  - id: A3
    name: 末端货位区
    x: 10.2
    y: 2.1
    radius: 0.8
```

### 6.3 点位匹配逻辑

建议采用如下逻辑：

1. 获取当前位姿 `(x, y)`
2. 遍历所有配置点位
3. 计算当前位置与点位中心的欧氏距离
4. 若距离小于点位半径，则视为命中该点位
5. 若多个点位都命中，取最近点
6. 若都未命中，则 `point_id = null`

### 6.4 推荐增加停留判断

为了避免机器人经过点位边缘时误采集，建议增加停留判定：

- 当机器人进入点位范围后，不立即采样
- 只有连续 N 次（如 2~3 次）都仍在该点位范围内，才判定为有效采样

这样可以降低误判率。

### 6.5 推荐增加采样策略

建议支持两类采样策略：

#### 策略 A：定时采样

- 每 5 秒采一条
- 用于轨迹过程展示

#### 策略 B：定点有效采样

- 仅在命中点位且停留时间满足条件时记录有效样本
- 用于报表统计和点位环境展示

建议 1.0 阶段同时保留这两类数据能力。

---

## 7. 代码结构设计

### 7.1 推荐代码目录

```text
go2_env_agent/
├─ app/
│  ├─ main.py
│  ├─ config.py
│  ├─ models.py
│  ├─ utils.py
│  ├─ providers/
│  │  ├─ base_position.py
│  │  ├─ go2_pose_sdk.py
│  │  ├─ go2_pose_ros2.py
│  │  └─ dht11_reader.py
│  ├─ matcher/
│  │  └─ point_matcher.py
│  ├─ storage/
│  │  └─ spool.py
│  ├─ uploader/
│  │  ├─ mqtt_uploader.py
│  │  └─ http_uploader.py
│  ├─ services/
│  │  ├─ telemetry_service.py
│  │  └─ health_service.py
│  └─ config/
│     ├─ points.yaml
│     └─ settings.env
├─ requirements.txt
├─ systemd/
│  └─ go2-env-agent.service
└─ README.md
```

### 7.2 各模块职责说明

#### `providers/base_position.py`

定义统一的定位接口：

```python
class PositionProvider:
    def read_pose(self) -> dict:
        raise NotImplementedError
```

作用：

- 屏蔽底层定位来源差异
- 后续可同时支持 GPS / Go2 / 融合定位

#### `providers/go2_pose_sdk.py`

作用：

- 基于 Unitree SDK2 Python 读取 Go2 位姿
- 推荐作为默认实现

#### `providers/go2_pose_ros2.py`

作用：

- 基于 ROS2 订阅 `/sportmodestate`
- 适合已经运行 ROS2 生态的场景

#### `providers/dht11_reader.py`

作用：

- 读取 DHT11 的温度与湿度
- 提供统一错误处理

#### `matcher/point_matcher.py`

作用：

- 读取点位配置文件
- 根据 `(x, y)` 匹配最近点位
- 输出 `point_id`、`area_id`、距离等信息

#### `storage/spool.py`

作用：

- 本地 SQLite 缓存
- 网络断开时保底存储
- 断网恢复后补传

#### `uploader/mqtt_uploader.py`

作用：

- MQTT 上报
- 建议保留 QoS1
- 支持离线重连

#### `uploader/http_uploader.py`

作用：

- 可选 HTTP 上报通道
- 便于接入自定义后端接口

#### `services/telemetry_service.py`

作用：

- 统一调度采集流程
- 组装 payload
- 控制缓存与上报

#### `services/health_service.py`

作用：

- 输出运行状态
- 可记录 CPU、内存、缓存量、上次成功发送时间等指标

---

## 8. 关键功能设计说明

## 8.1 功能一：Go2 位姿读取

### 功能目标

从 Go2 获取当前位姿信息，作为室内位置来源。

### 输入

- 树莓派与 Go2 同网段通信
- 指定网卡名称
- 指定定位模式（SDK2 / ROS2）

### 输出

```json
{
  "source": "go2_slam",
  "frame": "map",
  "fix": true,
  "x": 12.34,
  "y": 5.67,
  "z": 0.02,
  "yaw": 1.57,
  "ts": 1776403200
}
```

### 设计要求

- 无位姿时返回 `fix=false`
- 不要因位姿读失败导致主循环崩溃
- 要支持异常重连
- 要记录错误原因

---

## 8.2 功能二：温湿度采集

### 功能目标

周期读取 DHT11 数据。

### 输入

- GPIO 引脚编号，例如 `D4`

### 输出

```json
{
  "temp_c": 26,
  "rh": 61,
  "error": null
}
```

### 设计要求

- RuntimeError 不应导致程序退出
- 允许偶发空值
- 可扩展为 DHT22 / AHT20 / SHT31

---

## 8.3 功能三：点位映射

### 功能目标

将当前位姿映射为业务点位。

### 输入

- 当前位姿 `(x, y)`
- 点位配置文件

### 输出

```json
{
  "area_id": "warehouse_1f",
  "point_id": "A2",
  "distance": 0.31,
  "matched": true
}
```

### 设计要求

- 支持最近点匹配
- 支持半径范围过滤
- 支持“无匹配”结果
- 支持未来增加多区域地图

---

## 8.4 功能四：Telemetry 组包

### 功能目标

将位姿、点位、温湿度、错误信息组装成统一数据。

### 推荐结构

```json
{
  "device_id": "go2_01",
  "ts": 1776403200,
  "temp_c": 26,
  "rh": 61,
  "pose": {
    "source": "go2_slam",
    "frame": "map",
    "fix": true,
    "x": 12.34,
    "y": 5.67,
    "z": 0.02,
    "yaw": 1.57
  },
  "area_id": "warehouse_1f",
  "point_id": "A2",
  "errors": []
}
```

### 设计要求

- 字段命名统一
- 容易被后端解析
- 兼容未来扩展传感器
- 能区分“无定位”“无点位”“无温湿度”三类情况

---

## 8.5 功能五：本地缓存与补传

### 功能目标

保证 4G 网络不稳定时数据不丢失。

### 建议策略

1. 每条数据先写入 SQLite
2. 发布成功后再删除缓存
3. 程序重启后从缓存继续补传
4. 支持查看缓存积压量

### 重要说明

当前已有脚本是“publish 请求成功后即删除 spool”，正式版本建议升级为：

- 收到 `on_publish` 回调后再删除对应缓存记录

这样更稳。

---

## 8.6 功能六：上传通道

### 方案 A：MQTT

适用于当前已有链路。

优点：

- 轻量
- 实时性好
- 适合边缘端上报

建议：

- QoS = 1
- clean_session = false
- 设置在线状态 topic
- 支持重连退避

### 方案 B：HTTP

适用于你的后端系统更偏 REST 接口风格。

优点：

- 易调试
- 易与 Web 后端整合
- 更容易加鉴权、签名与审计

建议 1.0 版本：

- MQTT 保留为主通道
- HTTP 作为可选通道或调试通道

---

## 9. 环境与依赖配置

## 9.1 硬件环境

- 树莓派 Pi4B
- 16G SD 卡
- 4G 扩展板
- DHT11 温湿度传感器
- Go2 机器人
- Go2 具备可读取位姿的运行环境

## 9.2 操作系统建议

推荐：

- Raspberry Pi OS 64-bit
- 或 Debian / Ubuntu arm64

要求：

- Python 3.8+
- 支持 pip 安装依赖
- 支持与 Go2 同网段通信

## 9.3 Python 依赖建议

建议 `requirements.txt` 如下：

```txt
adafruit-circuitpython-dht
board
paho-mqtt
pyyaml
sqlite-utils
requests
numpy
opencv-python
```

如果使用 Unitree SDK2 Python，则还需要：

- `cyclonedds`
- `unitree_sdk2_python` 项目安装

## 9.4 环境变量设计

建议 `.env` 或 `settings.env` 中包含：

```env
DEVICE_ID=go2_01
DHT_GPIO=D4
SPOOL_DB=/var/lib/go2-env-agent/spool.db
INTERVAL_SEC=5

POSITION_SOURCE=go2_slam
GO2_POSE_MODE=sdk2_python
GO2_NET_IFACE=eth0
GO2_POSE_TOPIC=rt/sportmodestate
SLAM_FRAME=map
POINTS_FILE=/opt/go2-env-agent/config/points.yaml

MQTT_HOST=broker.example.com
MQTT_PORT=1883
MQTT_TOPIC=devices/go2_01/telemetry
MQTT_STATUS_TOPIC=devices/go2_01/status
MQTT_USERNAME=
MQTT_PASSWORD=
MQTT_TLS=0
MQTT_CLIENT_ID=go2-env-agent-go2_01

HTTP_ENABLE=0
HTTP_ENDPOINT=https://your-api.example.com/api/telemetry
HTTP_TOKEN=
```

---

## 10. 开发模式选择

## 10.1 模式一：Python SDK2 模式（推荐）

适用场景：

- 你希望系统轻量
- 你主要是做边缘采集，不需要完整 ROS2 生态
- 你只需要读取位姿，而不是复杂控制

优点：

- 轻量
- 部署简单
- 适合 Pi4B

缺点：

- 生态丰富度不如 ROS2

## 10.2 模式二：ROS2 模式

适用场景：

- 现场已经有 ROS2 环境
- 需要更多 topic / message 联动
- 后续要接运动控制、建图、导航等完整流程

优点：

- 生态成熟
- topic 更清晰
- 便于联调

缺点：

- 环境更重
- 对部署与维护要求更高

## 10.3 当前项目推荐方案

当前项目建议先采用：

**Python SDK2 读取位姿 + 现有 Python 边缘采集框架改造**

原因：

- 改动最小
- 与当前代码风格一致
- 树莓派更容易跑起来
- 可以快速验证业务价值

---

## 11. 详细开发任务分解

## 11.1 阶段 0：前置确认

### 任务 0.1：确认 Go2 位姿获取方式

目标：

- 明确当前 Go2 现场环境是否可以直接读取位姿
- 明确是走 SDK2 还是 ROS2

输出：

- 一份接入方式结论
- 可运行的最小位姿读取 Demo

### 任务 0.2：确认网络拓扑

目标：

- 树莓派与 Go2 处于同一网段
- 树莓派同时具备 4G 出网能力

输出：

- 网卡分工说明
- 路由策略说明

### 任务 0.3：确认现有展示系统接入方式

目标：

- 明确后端是收 MQTT 还是 HTTP
- 明确展示层是否支持室内点位坐标

输出：

- 一份上报接口字段说明
- 一份前端点位展示改造说明

---

## 11.2 阶段 1：位姿接入开发

### 任务 1.1：新增 PositionProvider 抽象接口

输出：

- `base_position.py`

### 任务 1.2：开发 `go2_pose_sdk.py`

功能：

- 初始化 SDK2
- 绑定网卡
- 读取位姿
- 处理异常

输出：

- 可直接返回统一 pose dict 的模块

### 任务 1.3：编写位姿读取调试脚本

输出：

- `debug_pose.py`

验证目标：

- 可稳定打印 x/y/z/yaw
- 无位姿时返回明确错误

---

## 11.3 阶段 2：点位映射开发

### 任务 2.1：设计 `points.yaml`

输出：

- 点位配置文件模板

### 任务 2.2：开发 `point_matcher.py`

功能：

- 加载点位配置
- 最近点匹配
- 半径判断
- 无匹配处理

### 任务 2.3：编写点位调试脚本

输出：

- `debug_matcher.py`

验证目标：

- 输入 `(x, y)` 后正确返回 `point_id`

---

## 11.4 阶段 3：主采集流程改造

### 任务 3.1：替换原 GPS 读取逻辑

从：

- `SIM7600GNSS.read_fix()`

替换为：

- `Go2PoseReader.read_pose()`

### 任务 3.2：升级 payload 结构

从原来的：

```json
{
  "temp_c": 26,
  "rh": 61,
  "gps": {...}
}
```

升级为：

```json
{
  "temp_c": 26,
  "rh": 61,
  "pose": {...},
  "point_id": "A2",
  "area_id": "warehouse_1f"
}
```

### 任务 3.3：整合点位匹配

在主循环中：

1. 先读 pose
2. 再读温湿度
3. 通过 pose 匹配 point_id
4. 组装统一 payload

---

## 11.5 阶段 4：上传链路验证

### 任务 4.1：保持 MQTT 链路可用

验证：

- 现有 broker 仍可接收数据
- 订阅端可看到新增 `pose / point_id` 字段

### 任务 4.2：增加 HTTP 通道（可选）

适用于后端若更适合 HTTP 接收。

### 任务 4.3：本地缓存补传验证

验证：

- 断网后缓存积压
- 恢复网络后正常补传
- 不丢数据

---

## 11.6 阶段 5：前端展示改造

### 任务 5.1：新增室内地图模式

前端建议支持：

- 楼层底图
- 点位标注
- 当前点位状态
- 温湿度数值显示

### 任务 5.2：历史查询

支持：

- 按点位查询历史温湿度
- 按时间范围查询

### 任务 5.3：轨迹展示（可选）

支持：

- 轨迹线
- 轨迹点温湿度值

---

## 12. 建议的数据模型设计

## 12.1 实时数据模型

```json
{
  "device_id": "go2_01",
  "ts": 1776403200,
  "temp_c": 26,
  "rh": 61,
  "pose": {
    "source": "go2_slam",
    "frame": "map",
    "fix": true,
    "x": 12.34,
    "y": 5.67,
    "z": 0.02,
    "yaw": 1.57
  },
  "area_id": "warehouse_1f",
  "point_id": "A2",
  "errors": []
}
```

## 12.2 数据库存储建议

后端建议至少保存以下字段：

- id
- device_id
- ts
- area_id
- point_id
- x
- y
- z
- yaw
- temp_c
- rh
- pose_source
- pose_frame
- has_pose_fix
- raw_payload

这样后续做回放与统计都方便。

---

## 13. 主循环逻辑框架

推荐的主循环逻辑如下：

```python
while running:
    pose = position_provider.read_pose()
    temp_c, rh, sensor_err = dht_reader.read()

    match = point_matcher.match(pose)

    payload = build_payload(
        device_id=device_id,
        ts=now_ts(),
        pose=pose,
        temp_c=temp_c,
        rh=rh,
        area_id=match.area_id,
        point_id=match.point_id,
        errors=[sensor_err, pose.get("error")]
    )

    spool.put(payload)
    uploader.flush(spool)

    sleep(interval)
```

### 建议补充能力

- 日志级别控制
- 健康检查信息
- 上次成功上报时间
- 当前缓存条数
- 重连次数统计

---

## 14. 关键代码逻辑建议

## 14.1 `PositionProvider` 抽象

```python
class PositionProvider:
    def read_pose(self) -> dict:
        return {
            "source": "unknown",
            "frame": "map",
            "fix": False,
            "x": None,
            "y": None,
            "z": None,
            "yaw": None,
            "error": "not_implemented"
        }
```

## 14.2 `PointMatcher` 核心逻辑

```python
def match(self, pose: dict) -> dict:
    if not pose.get("fix"):
        return {"matched": False, "area_id": None, "point_id": None, "distance": None}

    x = pose["x"]
    y = pose["y"]

    best = None
    for p in self.points:
        dist = calc_dist(x, y, p["x"], p["y"])
        if dist <= p["radius"]:
            if best is None or dist < best["distance"]:
                best = {
                    "matched": True,
                    "area_id": self.area_id,
                    "point_id": p["id"],
                    "distance": dist,
                }

    return best or {"matched": False, "area_id": self.area_id, "point_id": None, "distance": None}
```

## 14.3 `build_payload()` 建议

```python
def build_payload(device_id, ts, pose, temp_c, rh, area_id, point_id, errors):
    return {
        "device_id": device_id,
        "ts": ts,
        "temp_c": temp_c,
        "rh": rh,
        "pose": pose,
        "area_id": area_id,
        "point_id": point_id,
        "errors": [e for e in errors if e],
    }
```

---

## 15. 测试方案

## 15.1 单元测试建议

至少覆盖：

- DHT11 读数异常处理
- 位姿为空时处理
- 点位匹配正确性
- payload 结构正确性
- spool 入库 / 出库 / 删除逻辑

## 15.2 联调测试建议

### 测试 1：位姿读取测试

目标：

- Go2 位姿数据稳定可获取

通过标准：

- 连续 5 分钟无崩溃
- x/y 值变化合理

### 测试 2：点位映射测试

目标：

- 机器人到达 A1、A2、A3 时正确映射

通过标准：

- 命中点位率达到预期
- 无明显误判

### 测试 3：温湿度融合测试

目标：

- 采样结果能随点位展示

通过标准：

- 数据结构完整
- 后端显示正常

### 测试 4：断网补传测试

目标：

- 4G 中断后不丢数据

通过标准：

- 缓存可积压
- 恢复网络后补传成功

### 测试 5：长稳测试

目标：

- 连续运行 24 小时以上稳定

通过标准：

- 进程不崩溃
- 缓存无异常膨胀
- 数据持续可达

---

## 16. 部署与运维建议

## 16.1 目录建议

```text
/opt/go2-env-agent/
├─ app/
├─ config/
├─ logs/
└─ venv/
```

## 16.2 网络配置

树莓派需要同时连接 Go2（位姿数据）和外网（MQTT 上传），网卡分工如下：

| 网卡 | 用途 | IP 配置 |
|------|------|---------|
| eth0 | 网线直连 Go2 | 静态 `192.168.123.100/24` |
| wlan0 / usb0(4G) | 外网上行（MQTT/HTTP） | DHCP 或运营商分配 |

### 配置 eth0 静态 IP（NetworkManager）

```bash
sudo nmcli con add type ethernet ifname eth0 con-name go2-link \
  ip4 192.168.123.100/24 gw4 192.168.123.161
sudo nmcli con up go2-link
```

验证连通性：

```bash
ping -c 2 192.168.123.161
```

### 备选：systemd-networkd 方式

如未安装 NetworkManager，使用 systemd-networkd：

```bash
sudo tee /etc/systemd/network/10-eth0-go2.network <<'EOF'
[Match]
Name=eth0

[Network]
Address=192.168.123.100/24
EOF

sudo systemctl restart systemd-networkd
```

### 注意事项

- Go2 默认 IP 为 `192.168.123.161`，网段 `192.168.123.0/24`
- 不要给 eth0 配默认网关（避免外网流量走 Go2），上面的 `gw4` 参数仅用于该子网路由；如果发现外网不通，删掉默认路由：`sudo ip route del default via 192.168.123.161`
- `settings.env` 中 `GO2_NET_IFACE=eth0` 与此处网卡对应，如改用 WiFi AP 连接 Go2 则改为 `wlan0`
- 该配置持久化，重启后自动生效

## 16.3 systemd 服务配置

### 创建服务文件

```bash
sudo tee /etc/systemd/system/go2-env-agent.service <<'EOF'
[Unit]
Description=Go2 Environment Telemetry Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/go2-env-agent
EnvironmentFile=/opt/go2-env-agent/config/settings.env
ExecStart=/opt/go2-env-agent/venv/bin/python -m app.main
Restart=always
RestartSec=5
User=pi

[Install]
WantedBy=multi-user.target
EOF
```

### 启用并启动

```bash
sudo systemctl daemon-reload
sudo systemctl enable go2-env-agent    # 开机自启
sudo systemctl start go2-env-agent     # 立即启动
```

### 日常运维命令

```bash
sudo systemctl status go2-env-agent    # 查看状态
sudo systemctl stop go2-env-agent      # 停止
sudo systemctl restart go2-env-agent   # 重启
sudo systemctl disable go2-env-agent   # 取消开机自启
journalctl -u go2-env-agent -f         # 实时日志
journalctl -u go2-env-agent -n 50      # 最近50条日志
```

### 注销旧服务（telemetry-agent）

如果之前部署过 GPS 版本的 `telemetry-agent.service`，需要先注销：

```bash
sudo systemctl stop telemetry-agent.service
sudo systemctl disable telemetry-agent.service
sudo rm /etc/systemd/system/telemetry-agent.service
sudo systemctl daemon-reload
```

### 验证 MQTT 数据上报

在 Pi 上另开终端，订阅 MQTT topic 查看实时数据：

```bash
sudo apt install -y mosquitto-clients

mosquitto_sub -h <MQTT_HOST> -p <MQTT_PORT> \
  -u <MQTT_USERNAME> -P <MQTT_PASSWORD> \
  -t "devices/go2_01/#" -v
```

## 16.4 日志建议

建议记录以下日志：

- 程序启动 / 停止
- Go2 位姿异常
- DHT11 读取异常
- MQTT 连接状态
- 缓存队列长度
- 最后一次成功上报时间

---

## 17. 风险点与规避策略

## 17.1 风险一：Go2 位姿不是业务想象中的“最终坐标”

规避：

- 先做标定点配置
- 用“位姿 -> 点位”的方式落地
- 不直接拿原始坐标做最终报表口径

## 17.2 风险二：DHT11 精度不足

规避：

- 1.0 版本先验证链路
- 2.0 升级 DHT22 / AHT20 / SHT31

## 17.3 风险三：4G 网络不稳

规避：

- 本地 SQLite 缓存
- 发布确认后删除缓存
- 支持补传

## 17.4 风险四：传感器安装位置导致温度偏高

规避：

- 不要把 DHT11 紧贴树莓派或 4G 模块
- 使用延长线将传感器引到通风位置

---

## 18. 推荐实施计划（建议 5~7 天）

## 第 1 天：定位链路打通

- 确认 Go2 位姿获取方式
- 跑通最小位姿 Demo
- 输出 `x/y/z/yaw`

## 第 2 天：代码框架改造

- 新增 `PositionProvider`
- 开发 `Go2PoseReader`
- 替换原 `SIM7600GNSS`

## 第 3 天：点位映射开发

- 设计 `points.yaml`
- 开发 `point_matcher.py`
- 完成调试

## 第 4 天：主流程联调

- 融合位姿 + 温湿度 + 点位
- 保持 MQTT 上报
- 后端收到完整 payload

## 第 5 天：前端与断网验证

- 室内点位展示
- 断网缓存补传验证
- 修复问题

## 第 6~7 天：长稳测试与文档完善

- 长时间运行测试
- 参数调优
- 整理部署文档

---

## 19. 1.0 验收标准

满足以下条件即可认为 1.0 可交付：

1. 树莓派能够稳定读取 Go2 位姿
2. 温湿度数据可稳定采集
3. 数据能够映射到预设业务点位
4. 融合数据可正常写入缓存并上送
5. 前端可展示当前点位温湿度
6. 断网后恢复可自动补传
7. 连续运行 24 小时无严重异常

---

## 20. 后续 2.0 演进建议

后续建议重点优化以下方向：

1. 传感器升级
   - DHT11 -> DHT22 / AHT20 / SHT31

2. 室内地图展示升级
   - 二维点位图 -> 轨迹图 -> 热力图

3. 告警能力
   - 点位超温 / 超湿告警

4. 自动采样策略
   - 到点自动停留采样
   - 路径规划式巡检

5. 多维环境采集
   - PM2.5
   - CO2
   - VOC
   - 光照

---

## 21. 最终建议

当前项目不建议重写整套系统。

最优路径是：

**保留现有温湿度采集、缓存、MQTT 上报框架，只替换定位来源，并增加点位映射与室内展示逻辑。**

这样开发成本最低，验证最快，最符合当前项目状态。

从实施角度看，当前最关键的第一步不是前端，也不是地图，而是：

**先在树莓派上把 Go2 位姿读出来，并输出稳定的 `pose` 数据结构。**

只要这一步打通，后面的点位映射、数据融合、系统展示，都是标准工程问题。

---

## 22. 附：推荐最小配置文件模板

### `settings.env`

```env
DEVICE_ID=go2_01
DHT_GPIO=D4
INTERVAL_SEC=5
SPOOL_DB=/var/lib/go2-env-agent/spool.db
POSITION_SOURCE=go2_slam
GO2_POSE_MODE=sdk2_python
GO2_NET_IFACE=eth0
SLAM_FRAME=map
POINTS_FILE=/opt/go2-env-agent/config/points.yaml
MQTT_HOST=127.0.0.1
MQTT_PORT=1883
MQTT_TOPIC=devices/go2_01/telemetry
MQTT_STATUS_TOPIC=devices/go2_01/status
MQTT_CLIENT_ID=go2-env-agent-go2_01
MQTT_TLS=0
```

### `points.yaml`

```yaml
area_id: warehouse_1f
points:
  - id: A1
    name: 入口区
    x: 2.1
    y: 1.8
    radius: 0.8
  - id: A2
    name: 通道中段
    x: 6.4
    y: 2.0
    radius: 0.8
  - id: A3
    name: 末端货位区
    x: 10.2
    y: 2.1
    radius: 0.8
```

---

## 23. 附：推荐最小主程序伪代码

```python
from providers.go2_pose_sdk import Go2PoseReader
from providers.dht11_reader import DHTReader
from matcher.point_matcher import PointMatcher
from storage.spool import Spool
from uploader.mqtt_uploader import MqttUploader
from services.telemetry_service import build_payload

pose_reader = Go2PoseReader(...)
dht_reader = DHTReader(...)
matcher = PointMatcher(...)
spool = Spool(...)
uploader = MqttUploader(...)

while True:
    pose = pose_reader.read_pose()
    temp_c, rh, dht_err = dht_reader.read()
    match = matcher.match(pose)

    payload = build_payload(
        device_id="go2_01",
        ts=int(time.time()),
        pose=pose,
        temp_c=temp_c,
        rh=rh,
        area_id=match.get("area_id"),
        point_id=match.get("point_id"),
        errors=[dht_err, pose.get("error")],
    )

    spool.put(payload)
    uploader.flush(spool)
    time.sleep(5)
```

---

如果后续要继续推进，建议下一步直接进入：

**基于现有 telemetry_agent.py，输出一版可运行的 SLAM 改造版代码。**
