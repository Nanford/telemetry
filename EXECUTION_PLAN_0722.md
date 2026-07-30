# 执行计划：巡检数据归属 + 轨迹显示修复（2026-07-22）

> 本计划由 7-22 轨迹诊断会话产出，交由执行 AI（Opus 4.8）按顺序实施。
> 执行原则：每个任务完成并验证通过后，再进入下一个任务；涉及 Pi/云端的操作需用户配合执行。
> 云端部署规范见 `DEPLOYMENT_GUIDE.md`（先读再操作）；Pi 端路径/服务见 `Go2-SLAM-DEV/go2_env_agent/DEPLOY_TEST.md`。

---

## 背景与根因（已诊断确认，不需要重查）

7-22 上午实测（device `go2_01`，10:19–10:43 北京时间，231 条）结论：

1. **区域趋势(/zones)一直空白**：Pi 上部署的 `points.yaml` 还是旧版（点位 zone_id=A1/A3 旧命名、area_id=warehouse_1f），真机数据全部归入旧 zone（`A1`/`A3`/`warehouse_1f`）；而页面默认选中 zones 列表第一个 `A-1-2`（只有 7-20 模拟数据）→ 近 24h 查询 0 条。**repo 里的 `Go2-SLAM-DEV/go2_env_agent/app/config/points.yaml` 已经是 A-1-2 新版，只是没有同步部署到 Pi。**
2. **轨迹"90°转弯显示成180°"**：前端把画布(0..20×0..12)外的点静默过滤后，polyline 把洞两端直连（当天 147 个有效点被滤掉 87 个、7 个洞、最长假直线 13.6m）。另：巡检详情页投影非等比（x≈55px/m vs y≈28px/m），二次扭曲角度。
3. **垛位标定未完成**：当天每垛停留大多 ~10s（<15s 判据），只识别出 8/23 停留簇；后端 `backend/src/config.js` 的 `slam.points` 仍是占位坐标。
4. 疑似 Pi 上有**双 agent 进程**（10:39–10:43 两个位姿源逐条交替上报），在任务①现场核实。

zone 归属机制（backend/src/ingest.js:118）：`payload.zone_id || point_id || topic zone || GPS围栏 || area_id`。zone 是**入库时写死**的，后端追溯重匹配只修 point_id、不修 zone —— 所以 Pi 端配置必须先改对。

---

## 任务①：Pi 端统一 zone 命名（先做，立刻见效）

**目标**：真机新数据全部归入 zone `A-1-2`，区域趋势页出真实曲线。

**改动范围**：只改 Pi 上一个配置文件 + 重启服务。不改代码、不改云端。

### 步骤

Pi 登录信息见仓库根目录 `Pi记录.txt`（用户 `pi`，主机名 `xhl`，同网段 ssh）。以下命令可指导用户执行，或经 ssh 执行。

1. **备份 + 核对现状**（Pi 上）：
   ```bash
   # 看当前部署的 points.yaml 是不是旧版（旧版特征：zone_id: A1..A5 或 area_id: warehouse_1f）
   head -20 /opt/go2-env-agent/app/config/points.yaml
   cp /opt/go2-env-agent/app/config/points.yaml /opt/go2-env-agent/app/config/points.yaml.bak-0722
   ```
2. **顺带核实双进程嫌疑**（Pi 上，记录结果）：
   ```bash
   systemctl status go2-env-agent --no-pager
   ps aux | grep -E "app.main|telemetry" | grep -v grep
   # 若出现两个 python -m app.main（或 systemd 服务 + 手动进程并存），杀掉手动进程，只留 systemd
   ```
3. **同步新版 points.yaml**（本地电脑，在仓库根目录执行）：
   ```bash
   scp "Go2-SLAM-DEV/go2_env_agent/app/config/points.yaml" pi@xhl:/opt/go2-env-agent/app/config/points.yaml
   # 主机名解析不了就用 Pi 的局域网 IP
   ```
4. **核对 settings.env 不需要动**（Pi 上确认 `DEVICE_ID=go2_01`、`POINTS_FILE=/opt/go2-env-agent/app/config/points.yaml`，均不改）：
   ```bash
   grep -E "DEVICE_ID|POINTS_FILE|MQTT_TOPIC" /opt/go2-env-agent/config/settings.env
   ```
5. **重启并验证**（Pi 上）：
   ```bash
   sudo systemctl restart go2-env-agent
   sudo journalctl -u go2-env-agent -n 30 --no-pager   # 无报错、正常采样
   ```
6. **端到端验证**（本地电脑）：
   ```bash
   # a) MQTT 层：订阅原始上报，确认 payload 里 area_id=A-1-2（zone_id 未匹配垛位时为 null，正常）
   #    mosquitto_sub 账号密码见 Pi记录.txt
   mosquitto_sub -h windoor.leenf.online -u telemetry_user -P '<见Pi记录.txt>' -t 'devices/go2_01/telemetry' -C 3 -v

   # b) API 层：等 2 分钟后查趋势，A-1-2 应出现新聚合点
   curl -sk "https://windoor.leenf.online/api/v1/telemetry/trend?zone_id=A-1-2&bucket_minutes=30&start=<1小时前ISO>&end=<现在ISO>"

   # c) 页面层：打开 https://windoor.leenf.online/zones，默认选中 A-1-2，曲线应出数
   ```

### 验收标准

- [ ] 新上报 payload 的 `area_id` 为 `A-1-2`
- [ ] `/api/v1/telemetry/trend?zone_id=A-1-2` 近 1h 有聚合点
- [ ] 区域趋势页默认视图出现真实曲线
- [ ] Pi 上确认只有一个 agent 进程（记录第2步结果）

### 回滚

Pi 上恢复备份并重启：`cp points.yaml.bak-0722 points.yaml && sudo systemctl restart go2-env-agent`。

### 明确不做（等用户单独确认）

- **不删除**旧 zone（A1..A5、warehouse_1f）和旧数据——历史数据还挂在旧区，删除属破坏性操作，需用户另行决定。
- 不改后端 ingest 的 zone 归属链。

---

## 任务②：前端轨迹显示修复（治"假 180° 折返"）

**目标**：轨迹只画真实走过的连线；断档/跳变/出画布不再产生虚假直线；详情页角度不失真。

**改动范围**：仅前端 3 个文件。无 API/数据库改动。

### 2.1 新增轨迹分段工具（`frontend/src/lib/inspection.js`）

新增导出函数 `buildTrailSegments(trail, options)`：

- 输入：按时间升序的轨迹点数组（点含 `ts`、`pos_x`、`pos_y`），选项 `{ maxGapMs = 30000, maxSpeedMps = 2, bounds = null }`。
- 输出：`Array<Array<point>>`（若干段，每段内的点可安全连线）。
- **断段条件**（满足任一即在该处断开）：
  1. 相邻点时间差 > `maxGapMs`；
  2. 相邻点移动速度 > `maxSpeedMps`（用距离/时间差算，Go2 遥控巡检不会超过 2 m/s，超过即位姿跳变/里程计复位）；
  3. 传入 `bounds` 时，出界点本身丢弃，且其两侧**不得**跨洞相连（出界点所在位置即断点）。
- 坐标/时间解析复用文件内已有的 `finiteCoordinate` 等工具；无效点（坐标非有限数）按出界同样处理：丢弃并断段。

### 2.2 `SlamMapTab.jsx`：多段 polyline

- 用 `buildTrailSegments(trail, { bounds })` 取代现有 `visibleTrail` 过滤 + 单条 `trailPath` 直连（当前 `:195` 过滤、`:244` 连线）。
- 渲染：每段一条 `<polyline>`；只有 1 个点的段画成单点圆。轨迹取样点（每 3 个画一个小圆）逻辑保留，改为在分段结果上遍历。
- 统计条里的"有效轨迹"数改为分段后实际显示的点数（语义不变）。

### 2.3 `InspectionRouteMap.jsx`：等比投影 + 分段

- **等比投影**：现在 `projectX`/`projectY`（`:35-40`）各自独立缩放。改为统一 `scale = min(plotWidth/coordinateWidth, plotHeight/coordinateHeight)`，x/y 同用该 scale，并把绘图区在画布内居中（计算 offsetX/offsetY）。预设路线、实际轨迹、点位节点全部走同一投影。
- **实际轨迹分段**：`actualTrail` 也过 `buildTrailSegments`（bounds 用该图 layout 的 bounds），替换现有单条 `trailPoints` 直连（`:56-58`）。
- 点位读数卡片、连接线等布局逻辑不动（它们基于投影后的坐标，自动适配）。

### 2.4 验证与部署

1. 本地 `cd frontend && npm run build` 通过（项目无测试/无 lint，构建即门槛）。
2. 本地 dev 起前端连生产 API（`VITE_API_BASE=https://windoor.leenf.online/api/v1 npm run dev`），打开 `/map`：今天的数据下，轨迹应呈**若干短段**，不再有横穿全图的长直线；批次详情页轨迹形状与"任务①诊断图"中的原始轨迹形状一致（可用 webapp-testing 截图对比）。
3. 云端部署按 `DEPLOYMENT_GUIDE.md` §3.1（git pull → 前端重 build → 发布 dist；后端无改动可不重启）。
4. 提交规范：`[fix] 轨迹断档分段渲染 + 详情页等比投影`；按仓库文档规则同步更新涉及文件的头注释。

### 验收标准

- [ ] `/map` 不再出现跨越过滤洞的长直线；无"原路折返"假象
- [ ] 批次详情页轨迹角度与原始数据一致（等比、无压扁）
- [ ] `npm run build` 通过，云端页面正常加载

### 可选顺带小修（各 ≤10 行，Opus 酌情一并提交）

- `backend/src/index.js:624` `/slam/trail` 的 `LIMIT 500` 会截掉长窗口数据：改为按 `minutes` 动态放宽或 `LIMIT 2000`。
- 区域趋势页默认选中"最近有数据的 zone"（现在是列表第一个）。任务①完成后 A-1-2 恰好是对的，此项可不做。

---

## 任务③：现场标定流程（下次到库房执行，人机配合）

**目标**：拿到 23 个垛位的真实 SLAM 坐标，回填 Pi 和后端，完成"数据归垛"。
完整操作规程见 `Go2-SLAM-DEV/go2_env_agent/A1-2_现场测试指南.md`，以下是要点 + 本次诊断补充的纪律：

### 现场纪律（本次诊断的教训，必须遵守）

1. **到库房门口再开机**：狗的开机点=坐标原点、开机朝向=+x 轴。去程路上的位姿数据无效（7-22 阶段A教训）。
2. **开机位姿固定**：门口（右短边）、正对走道，拍照留档，以后每次一致。
3. **中途绝不重启**：重启=坐标系作废（7-22 阶段B教训）。万一重启了，回门口按标准位姿重新开机，之前那段作废重走。
4. **每垛停满 15 秒**：7-22 只停了 ~10s，23 垛只识别出 8 个（判据 ≥15s）。
5. 结束后先停服务再关狗，避免结尾上报静止/异常位姿。

### 标定与回填步骤

1. 巡检走完后，本地执行（`Go2-SLAM-DEV/go2_env_agent/` 目录）：
   ```bash
   python tools/calibrate_from_trail.py --fetch --device go2_01 --out today.png
   # 目标：稳定识别 23 个停留簇。少了/多了按指南 §4 调 --cluster-r / --min-sec，本地重算不用重走
   ```
2. 识别对后生成真坐标：
   ```bash
   python tools/calibrate_from_trail.py --fetch --device go2_01 --emit-yaml app/config/points.A-1-2.yaml
   # 人工核对 D1..D23 编号与实际垛号顺序一致（按 01→23 走则自动一致）
   ```
3. **双端回填（坐标必须同源同值）**：
   - Pi 端：把新 yaml 的真实 x/y/radius 更新进 `app/config/points.yaml`（id/zone_id 不变），scp 到 Pi 同任务①步骤3，重启 agent；
   - 后端：把同一批坐标同步进 `backend/src/config.js` 的 `slam.points`（id 不变只换 x/y/radius），云端 git pull + 重启 `telemetry-api`（按 `DEPLOYMENT_GUIDE.md` §3.1）。
   - 注意：现 repo 里 yaml 占位坐标（x 2.5..30）与 config.js 占位坐标（x 1.5..18）**本来就不一致**，回填后必须以标定值统一两处。
   - 若标定出的实际坐标范围超出 20×12，云端环境变量 `SLAM_AREA_WIDTH/HEIGHT` 同步调整（见 `backend/src/slam-config.js`）。
4. 验收（利用后端追溯重匹配，不用重走）：
   - [ ] 巡检详情页「匹配点位」= 23，每垛有温湿度读数
   - [ ] `/map` 轨迹压在垛位上
   - [ ] 采集明细表「点位」列显示垛号

### 遗留观察项

- 双进程问题若任务①已确认并清除，本次观察结尾是否还有交替上报；
- 纯里程计半小时漂移约 3–5m，垛位半径 0.6–0.8m——本次标定后先跑通业务；若日常巡检匹配率不稳，再立项"重定位/锚点校正"（指南 §9 预留）。

---

## 执行顺序与决策点汇总

| 顺序 | 任务 | 执行环境 | 需用户到场/确认 |
|------|------|----------|----------------|
| 1 | ① Pi 端 points.yaml 同步 + 双进程排查 | Pi（ssh）+ 本地验证 | 需（ssh 操作） |
| 2 | ② 前端分段渲染 + 等比投影 | 本地改码 + 云端发布 | 云端发布时需 |
| 3 | ③ 现场标定 + 双端回填 | 库房现场 + Pi + 云端 | 需（现场走一趟） |

**决策点（执行中遇到必须停下问用户）**：删除旧 zone/旧数据；`SLAM_AREA_WIDTH/HEIGHT` 是否按标定结果调整；标定停留簇数量反复凑不齐 23 时是否补走。
