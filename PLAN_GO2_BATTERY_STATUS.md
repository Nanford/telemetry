# Go2 机器狗电池/状态采集 → 网页端实时显示

## 目标

在现有遥测链路（Go2 agent → MQTT → backend ingest → MySQL → REST → React）上新增设备级状态数据：

- 电量百分比 `soc`、整机电压 `voltage_v`、电流 `current_a`、电池循环次数 `cycle`、电池温度 `temp_c`
- 数据来源：unitree_sdk2py 订阅 `rt/lowstate`（`LowState_`：`bms_state.soc/current/cycle` + 顶层 `power_v/power_a/temperature_ntc1`）
- 网页端 `/devices` 页面实时（轮询）显示设备状态详情

## 方案概述（推荐）

电池数据**搭车现有遥测 payload**（不发新 topic）：agent 在现有 `devices/Go2/telemetry` JSON 里加一个 `battery` 字段；backend 解析后写入 `telemetry_raw` 新增列；新增一个 `GET /api/v1/devices/:device_id/status` 接口；前端复活 `/devices` 页做状态详情 + 10s 轮询。

理由：agent 每 5s 本来就要发一帧遥测，电池是低频状态，搭车最省（不改 uploader、不加 topic、不新建表）；`telemetry_raw` 加列走现有 `schema-migrations.js` 启动自动 ALTER 机制，与 pose 列的加法完全一致。

## 改动明细

### 1. Agent（Go2-SLAM-DEV/go2_env_agent）

1.1 **新增 `app/providers/go2_dds.py`**：DDS 通道单例初始化
- `ensure_channel_initialized(net_iface)`：模块级 `_initialized` flag + CycloneDDS XML 环境变量配置（从 `Go2PoseSDK._configure_cyclonedds` 搬过来），保证 `ChannelFactoryInitialize` 全进程只调一次
- 改造 `app/providers/go2_pose_sdk.py` 的 `start()` 复用它（否则两个 provider 重复 init 会崩）

1.2 **新增 `app/providers/go2_lowstate_sdk.py`**：`Go2LowStateSDK`
- 仿 `Go2PoseSDK` 结构：`start()` 里延迟 import `unitree_sdk2py`（保证 Windows/无 SDK 环境能 import 模块跑测试），`ChannelSubscriber("rt/lowstate", LowState_)`
- 回调加锁存最新值 + 时间戳；`read_state() -> dict`：正常返回
  ```python
  {"soc": int, "voltage_v": float, "current_a": float, "cycle": int, "temp_c": int, "stale": False}
  ```
  （`soc=msg.bms_state.soc`，`voltage_v=msg.power_v`，`current_a=msg.power_a`，`cycle=msg.bms_state.cycle`，`temp_c=msg.temperature_ntc1`）
- 未收到/超过 `stale_sec`（默认 5s）返回 `{"stale": True, "error": "..."}`
- `stop()` 释放订阅

1.3 **`app/config.py`**：新增配置项（仿 Go2 SLAM 段写法）
- `GO2_LOWSTATE_ENABLE`（默认 `"true"`，仅 `POSITION_SOURCE=go2_slam` 时生效）
- `GO2_LOWSTATE_TOPIC`（默认 `rt/lowstate`）
- `GO2_LOWSTATE_STALE_SEC`（默认 `5.0`）
- `app/config/settings.env` 同步加示例行

1.4 **`app/main.py`**：`_build_lowstate_provider(cfg)`——`POSITION_SOURCE == "go2_slam"` 且 enable 时构建并 `start()`，注入 `TelemetryService`；退出时 `stop()`

1.5 **`app/services/telemetry_service.py`**：构造函数加可选参数 `battery_provider=None`（默认 None 保证旧测试不炸）；`collect_once()` 里：
- 有 provider 时 `state = battery_provider.read_state()`
- 正常 → `payload["battery"] = state`；stale/异常 → `payload["battery"] = None`，错误字符串并入 `errors[]`
- 无 provider → 不加 `battery` 键

1.6 **`debug/publish_go2_telemetry_sim.py`**：`build_payload()` 加 battery 模拟（SOC 从 100 缓慢线性下降、电压 24~25.2V 随机波动），供无狗端到端验证

1.7 **测试**（`Go2-SLAM-DEV/go2_env_agent/tests/`）：
- `test_telemetry_service.py`：加 `DummyBatteryProvider`，断言 `payload["battery"]["soc"]` 及 stale 时 `battery is None` + errors 包含提示
- 新增 `test_go2_lowstate_sdk.py`：仿 `test_sim_go2_dog.py` 用 Fake dataclass 构造假 `LowState_` 消息，测 `_on_message` 字段提取与 stale 判定（不依赖真 SDK）

### 2. Backend（backend/）

2.1 **`src/schema-migrations.js`**：`TELEMETRY_COLUMNS` 追加 5 列（启动时自动 ALTER，幂等）：
```js
['battery_soc', 'TINYINT NULL'],
['battery_voltage_v', 'DECIMAL(6,2) NULL'],
['battery_current_a', 'DECIMAL(7,2) NULL'],
['battery_cycle', 'SMALLINT NULL'],
['battery_temp_c', 'DECIMAL(5,2) NULL']
```

2.2 **`sql/schema.sql`**：`telemetry_raw` 建表语句同步加这 5 列（保持全新部署一致）

2.3 **`src/ingest.js`**：
- `normalizeIncomingTelemetry`（:98-148）：解析 `payload.battery || {}`，返回对象加 `battery_soc / battery_voltage_v / battery_current_a / battery_cycle / battery_temp_c`（缺省 null）
- `flushBuffer`（:299-305）：columns 数组与 rows 映射各加 5 项
- 无 battery 字段的旧 payload 完全兼容（全 null）

2.4 **`src/index.js`**：新增路由（放在 `/api/v1/devices` 附近）
```js
GET /api/v1/devices/:device_id/status
```
- 查 devices 表基本信息 + `SELECT ... FROM telemetry_raw WHERE device_id=? AND battery_soc IS NOT NULL ORDER BY ts DESC LIMIT 1` 取最新电池数据
- 返回 `{ device: {...}, battery: {soc, voltage_v, current_a, cycle, temp_c, ts} | null, pose: {pos_x, pos_y, yaw, point_id, ts} | null }`
- pose 从同一条（或最近一条 `pose_fix=1`）记录带出，让详情页同时显示运动状态

### 3. Frontend（frontend/）

3.1 **`src/data/mock.js`**：末尾追加 `mockDeviceStatus`（device/battery/pose 结构同上）

3.2 **`src/api.js`**：加 `getDeviceStatus(deviceId, opts)` = `withMockFallback((id, o) => fetchJson(\`devices/${id}/status\`, o), mockDeviceStatus)`；注意文件是 CRLF 行尾

3.3 **`src/pages/Devices.jsx` 改造**：
- 顶部：设备状态详情卡——`.stats-grid` 放 5 个 `StatCard`（电量 %、电压 V、电流 A、循环次数、电池温度 °C）+ 一行数据时间/在线状态（`last_seen_at`，超过 30s 无数据标"离线"）
- 位姿/运动状态一小节：point_id、pos_x/pos_y、yaw（数据来自同一接口）
- 下方保留现有"巡检终端/巡检点位"表格
- 轮询：抄 `Overview.jsx` 的 `AbortController + setInterval` 模板，间隔 10s，组件卸载 cleanup
- 设备选择：`useState` 当前 device_id，默认取 `getDevices()` 列表第一项

3.4 **`src/App.jsx`**：`/devices` 路由由 `<Navigate to="/">` 改为 `<Devices />`；`navItems` 加 `{ to: '/devices', label: '设备状态', icon: ... }`（icon 沿用现有 emoji/字符风格）

3.5 **`src/styles.css`**：仅在现有 class 不够用时补少量样式（如电量数值配色），沿用现有 CSS 变量与命名

### 4. 文档

- 根 `AGENTS.md`：Data Flow / Key Database Tables 小节补一句 battery 列与 `/devices/:id/status` 接口
- `Go2-SLAM-DEV/AGENTS.md`（如有 provider/config 说明处）补 `Go2LowStateSDK` 与新配置项

## 验证步骤

1. `cd Go2-SLAM-DEV/go2_env_agent && python -m pytest tests/ -q` 全绿
2. 无狗端到端：本地 mosquitto + MySQL 起 backend（`npm run dev`，确认启动日志里 5 条 ALTER 成功或已存在）→ `python debug/publish_go2_telemetry_sim.py` 发模拟数据 → `curl http://localhost:8080/api/v1/devices/Go2/status` 确认 battery 字段落库并返回
3. `cd frontend && npm run build` 通过；`npm run dev` 后浏览器访问 `/devices` 截图确认渲染与轮询刷新
4. 真机部分（树莓派 + 真狗订阅 `rt/lowstate`）只给出部署说明，不在本次验证范围

## 不做的事（v1 范围外）

- 不发新 MQTT topic、不新建 device_status 表
- 不做 SSE 实时推送（现有前端页面均为轮询，10s 足够；后续可复用 slam/stream 骨架加）
- 不做 SOC 历史趋势图（telemetry_raw 已有数据，后续可加）
- 不做低电量告警规则（alert_rules 目前只支持 temp/rh 语义，扩展 metric 类型是独立工作）
