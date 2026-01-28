# Telemetry Platform (v1.0)

仓库温湿度与定位监控平台的全栈实现，包含 MQTT 接入、MySQL 落库、REST API 与科技风格前端仪表盘。

## 目录结构

- `backend/`：Node.js API + MQTT 接入服务
- `frontend/`：React 仪表盘（蓝白科技风）
- `backend/sql/schema.sql`：MySQL 建库脚本
  - 含 `zone_geofences` 围栏表（矩形范围）

## 快速开始

### 1) 初始化数据库

```bash
# 在 MySQL 中执行
source backend/sql/schema.sql
```

### 2) 启动后端

```bash
cd backend
cp .env.example .env
# 修改 .env 中 MySQL 与 MQTT 配置
npm install
npm run dev
```

默认 API：`http://localhost:8080/api/v1`

### 3) 启动前端

```bash
cd frontend
npm install
# 如需指定 API：
# set VITE_API_BASE=http://localhost:8080/api/v1
npm run dev
```

前端默认端口：`http://localhost:5173`

## MQTT Topic 说明

支持两种格式：

- `devices/{device_id}/{zone_id}/telemetry`（推荐）
- `devices/{device_id}/telemetry`

payload 兼容 PRD 中的示例格式，未带 zone 时会归入默认区域或未分配状态。

## 主要接口

- `GET /api/v1/overview`：总览数据
- `GET /api/v1/telemetry/trend`：趋势曲线（支持 `zone_id` 或 `sensor_id`）
- `GET /api/v1/alerts`：告警列表
- `POST /api/v1/alerts/:id/ack`：告警确认
- `GET /api/v1/alert-rules`：阈值规则
- `GET /api/v1/geo/latest`：设备最新定位
- `GET /api/v1/geofences`：围栏列表
- `POST /api/v1/geofences`：新增/更新围栏

## 说明

- 前端内置 mock 数据，当 API 不可用时自动回退。
- 围栏配置支持矩形范围，后端会根据 GPS 自动归属区域。
- 规则引擎实现了触发/恢复持续时间窗口判定；如需更精确的采样连续性策略，可在后续迭代中完善。
- 小时聚合表 `telemetry_hourly` 若尚未填充，趋势查询会自动回退到原始表聚合。
