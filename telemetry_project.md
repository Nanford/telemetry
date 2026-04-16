
## 仓库温湿度与定位监控平台 PRD v1.0

### 1. 背景与目标

本应用用于仓库环境监测：通过多个采集点（不同区域/不同库位）持续采集温度、湿度，并同步采集设备定位信息（GPS）。数据通过 MQTT 上报到平台，平台将数据落库（MySQL），并在 Web 端提供趋势分析、区域对比、阈值告警与告警闭环处理能力。业务目标是让仓库管理员可以在一个页面里看到“当前是否异常、异常在哪里、过去一段时间趋势如何、异常是否被处理”。

### 2. 用户与使用场景

主要用户是仓库管理员/运维人员：日常查看温湿度曲线是否稳定，关键区域是否超阈值；当温湿度异常时收到告警并确认处理；需要回溯某一时段（例如夜间、周末）的环境变化，导出数据用于审计或问题复盘。若设备带 GPS，还可在地图上查看采集设备的当前位置与轨迹，确认设备是否在预期区域内。

### 3. 数据来源与现有消息格式

当前你的设备上报消息示例为：

`devices/pi4-001/telemetry`

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

平台需要完全兼容该格式，并且支持“多区域采集”的扩展。由于当前 payload 里没有 `zone/area` 字段，PRD 给出两种可落地方案：一是通过 Topic 扩展带上区域（推荐），二是在 payload 增加 `zone_id` 字段（更直观）。

### 4. 范围与边界

本期（v1.0）范围包含：数据接入（MQTT 订阅）、数据落库（MySQL）、基础数据管理（设备/区域/传感器）、趋势与地图展示、阈值告警（产生/恢复/确认）、基础权限（可选）。不包含复杂的仓库三维可视化、复杂工单系统、机器学习预测等；这些可以在 v1.1+ 扩展。

---

## 5. 业务流程与系统链路

采集端（树莓派）按固定频率采集温湿度与 GPS，发布到 MQTT；服务端部署一个“接入服务”订阅 Topic，收到消息后做校验与标准化，写入 MySQL；写入成功后由“规则引擎”基于阈值规则判断是否触发告警，触发则写入告警表并推送通知；前端页面通过 REST API 拉取最新值、历史趋势、告警列表与设备位置，并渲染图表与地图。

---

## 6. 功能需求

### 6.1 设备与区域管理

系统需要维护三类主数据：设备（device）、区域（zone）、传感器点位（sensor）。设备代表一个上报主体（如 `pi4-001`），区域代表仓库的物理分区（如 A区/冷链区/出货口），传感器点位用于绑定“一个设备在某个区域的一个采集点”。

为了支持你说的“不同区域温湿度”，平台必须能把上报数据归属到某个区域。推荐方式是把 MQTT Topic 规范化为：
`devices/{device_id}/{zone_id}/telemetry`
这样接入层无需改 payload 就能知道区域归属；你现在已经跑通的 Topic 可以继续兼容（当 Topic 不带 zone 时，平台按设备默认区域或“未分配”区域处理）。

### 6.2 数据展示与分析

前端需要提供“总览”和“详情”两种视角。总览用于快速判断是否异常：显示每个区域的最新温度、湿度、更新时间、是否超阈值；并提供全仓库的温湿度趋势概览（例如最近 24 小时平均/最大/最小）。详情用于诊断：选择一个区域或传感器点位，查看任意时间范围的曲线（温度/湿度），支持按分钟/小时聚合切换，避免原始数据量过大导致页面卡顿。

地图模块用于展示设备最新位置与可选的历史轨迹。v1.0 只要求“最新点位 + 最近 N 分钟轨迹折线”即可；当 `gps.fix=false` 时应明确显示“未定位/无效定位”，不应误画在地图上。

### 6.3 阈值规则与告警

系统需要允许按区域或按传感器配置阈值。规则至少支持：温度上限/下限、湿度上限/下限；触发策略要有“持续时间”参数，用于防止抖动（例如连续 30 秒或连续 3 个采样点超阈才触发）。告警生成后应进入“告警中心”，支持确认（ack）、备注、恢复时间记录。告警恢复逻辑同样建议有“恢复持续时间”，避免瞬间回落就自动关闭。

告警通知 v1.0 可以先做站内通知/页面红点与声音提示；如果你希望外部通知（企业微信/钉钉/短信/邮件），建议作为可插拔通道，在 v1.1 扩展，不影响核心闭环。

---

## 7. 数据库设计（MySQL）

### 7.1 设计原则

温湿度是典型时序数据，读多写多；MySQL 需要通过合理索引与分区支撑查询。建议原始数据表按时间范围分区（按月），并建立 `(sensor_id, ts)` 复合索引；同时提供小时级聚合表用于趋势图默认查询，减少前端每次都扫原始表。

### 7.2 表结构建议（DDL 草案）

你可以直接用下面的 SQL 建库（库名按 `warehouse_iot` 举例）：

```sql
CREATE DATABASE IF NOT EXISTS warehouse_iot DEFAULT CHARSET utf8mb4;
USE warehouse_iot;

-- 设备
CREATE TABLE devices (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  device_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  last_seen_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 区域
CREATE TABLE zones (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  zone_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 传感器点位（一个设备可对应多个区域/多个点位）
CREATE TABLE sensors (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  sensor_id VARCHAR(64) NOT NULL UNIQUE,
  device_id VARCHAR(64) NOT NULL,
  zone_id VARCHAR(64) NULL,
  type VARCHAR(32) NOT NULL DEFAULT 'DHT11',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sensors_device (device_id),
  KEY idx_sensors_zone (zone_id),
  CONSTRAINT fk_sensors_device FOREIGN KEY (device_id) REFERENCES devices(device_id)
) ENGINE=InnoDB;

-- 原始采集数据（建议后续按月分区）
CREATE TABLE telemetry_raw (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  device_id VARCHAR(64) NOT NULL,
  sensor_id VARCHAR(64) NULL,
  zone_id VARCHAR(64) NULL,

  ts DATETIME NOT NULL,          -- 采集时间（建议用 UTC 存）
  temp_c DECIMAL(5,2) NULL,
  rh DECIMAL(5,2) NULL,

  gps_fix TINYINT(1) NULL,
  lat DECIMAL(10,7) NULL,
  lon DECIMAL(10,7) NULL,
  alt_m DECIMAL(8,2) NULL,
  speed_kmh DECIMAL(8,2) NULL,

  payload_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_tr_sensor_ts (sensor_id, ts),
  KEY idx_tr_zone_ts (zone_id, ts),
  KEY idx_tr_device_ts (device_id, ts)
) ENGINE=InnoDB;

-- 小时聚合表（趋势默认走这个）
CREATE TABLE telemetry_hourly (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  sensor_id VARCHAR(64) NOT NULL,
  zone_id VARCHAR(64) NULL,
  hour_ts DATETIME NOT NULL, -- 整点
  temp_avg DECIMAL(5,2) NULL,
  temp_min DECIMAL(5,2) NULL,
  temp_max DECIMAL(5,2) NULL,
  rh_avg DECIMAL(5,2) NULL,
  rh_min DECIMAL(5,2) NULL,
  rh_max DECIMAL(5,2) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_sensor_hour (sensor_id, hour_ts),
  KEY idx_th_zone_hour (zone_id, hour_ts)
) ENGINE=InnoDB;

-- 阈值规则
CREATE TABLE alert_rules (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(128) NOT NULL,
  scope_type VARCHAR(16) NOT NULL,    -- zone / sensor
  zone_id VARCHAR(64) NULL,
  sensor_id VARCHAR(64) NULL,

  temp_high DECIMAL(5,2) NULL,
  temp_low  DECIMAL(5,2) NULL,
  rh_high   DECIMAL(5,2) NULL,
  rh_low    DECIMAL(5,2) NULL,

  trigger_duration_sec INT NOT NULL DEFAULT 30,
  recover_duration_sec INT NOT NULL DEFAULT 30,
  enabled TINYINT(1) NOT NULL DEFAULT 1,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rule_zone (zone_id),
  KEY idx_rule_sensor (sensor_id)
) ENGINE=InnoDB;

-- 告警实例
CREATE TABLE alerts (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  rule_id BIGINT NOT NULL,
  zone_id VARCHAR(64) NULL,
  sensor_id VARCHAR(64) NULL,
  level VARCHAR(16) NOT NULL DEFAULT 'warning',  -- warning/critical
  status VARCHAR(16) NOT NULL DEFAULT 'open',    -- open/closed/acked

  first_trigger_at DATETIME NOT NULL,
  last_trigger_at DATETIME NOT NULL,
  recovered_at DATETIME NULL,

  metric VARCHAR(16) NOT NULL,   -- temp/rh
  current_value DECIMAL(8,2) NULL,
  message VARCHAR(255) NULL,

  acked_at DATETIME NULL,
  acked_by VARCHAR(64) NULL,
  ack_note VARCHAR(255) NULL,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_alert_status_time (status, last_trigger_at),
  CONSTRAINT fk_alert_rule FOREIGN KEY (rule_id) REFERENCES alert_rules(id)
) ENGINE=InnoDB;
```

关于“区域归属”的字段你会看到我在 `telemetry_raw` 里同时保留了 `zone_id` 与 `sensor_id`，是为了兼容两种方案：Topic 带 zone 或 payload 带 zone。v1.0 可以先跑通一种，另一种保留扩展位。

---

## 8. 后端接口设计（REST API）

接口以“读多写少”为主，写入由 MQTT 接入服务完成。前端主要用以下能力：拉取最新值、拉取时间范围曲线、拉取告警列表、规则增删改查。

建议路径规范为 `/api/v1`，响应为 JSON。时间参数统一使用 ISO8601 或 epoch，后端内部统一转成 UTC DATETIME 存库。

典型接口行为是：趋势查询支持 `granularity` 参数，当查询跨度大于阈值（例如 7 天）默认切到 `hourly` 聚合表返回，避免一次扫太多原始点。

---

## 9. 前端页面与交互

总览页要让用户 10 秒内知道仓库是否安全：展示每个区域的当前温度/湿度、最后更新时间、是否超阈；点击区域进入详情页。详情页提供曲线图（温度/湿度双轴或分图），支持选择时间范围（最近 1 小时/24 小时/7 天/自定义），支持导出 CSV。地图页显示设备当前点位与轨迹（可选），当定位无效时给出“未定位”状态而非错误点位。告警中心页提供告警列表、筛选（区域/状态/级别/时间），告警详情支持确认与备注；规则配置页用于创建/编辑阈值与触发/恢复持续时间。

---

## 10. 开发环境配置

你本地 MySQL 连接信息（用于快速联调）：

* host：127.0.0.1
* port：3306
* user：root
* password：见本地 `backend/.env`（不入库）

但 PRD 要求在部署环境必须改为“应用专用账号”，并将账号密码放入 `.env`/systemd EnvironmentFile，避免代码与仓库泄露带来的安全风险。


## 11. 关键非功能需求

平台需要保证数据不丢：MQTT 接入服务要支持断线重连与消息校验；写库要有失败重试与死信记录（至少落本地日志/表）。页面加载要快：默认趋势使用小时聚合表，且对原始数据查询做分页/限点（例如最多返回 5000 个点，超出自动聚合）。告警要可靠：同一规则在 open 状态时不重复刷屏，只有状态变化或间隔更新才记录 `last_trigger_at`，并能正确闭合。
