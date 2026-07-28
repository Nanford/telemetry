# debug/ — 无狗环境下的调试与模拟工具

**这个目录是干什么的**：现场撤场后手上没有机器狗，靠这些脚本在本机造出可信的数据，
驱动 `backend` + `frontend` 全链路，并给标定算法提供测试夹具。

**依赖**：`paho-mqtt`、`pyyaml`（见上级 `requirements.txt`）。DDS 相关脚本另需 `unitree_sdk2py`，仅 Pi 上可用。

**产出**：MQTT `devices/{device_id}/telemetry`，格式与终端侧 `app/` 上报一致，由 `backend/src/ingest.js` 消费。

---

## 两个模拟器，别用混了

| 脚本 | 仓间 | 坐标来源 | 参数来源 | 用途 |
|---|---|---|---|---|
| **`sim_a41_patrol.py`** | A-4-1 | `app/config/points.A-4-1.yaml`（CAD 实测） | **2026-07-23 现场两趟真实抓包标定** | 当前主力。演示回放 + 标定/健康检测夹具 |
| `publish_go2_telemetry_sim.py` | A-1-2 | 文件内硬编码**示意值** | 手工设定 | 早期链路联通性验证 |

> A-1-2 那份的坐标和温湿度基线都是示意值，**不要拿它的数据下任何现场结论**。
> `sim_a41_patrol.py` 复用了它的 MQTT 发布层（`MqttPublisher` / `parse_mqtt_url` / `load_env_file`）。

### 巡检路线：梳齿式（2026-07-28 起为默认）

```
东门进 → 南排东→西，沿途拐进 5 条垛间通道 → 西端换道 → 北排西→东，再拐进 5 条通道 → 回东门
```

沿中央通道行进时，每遇到一条**可通行**的垛间通道就拐进去、走到垛体进深一半处采集，再退出来。
可通行的判据来自 CAD：相邻垛中心距只有两档——约 3.6~3.8m（垛宽 3.02 → 净缝 0.58~0.77m，
狗进不去）和 ≥5.5m（净宽 ≥2.49m）。阈值 `GAP_MIN_CENTER_SPACING_M=4.5` 把两档分开，
于是南北各 5 条、共 10 条通道，其中 22↔01 之间那条净宽 6.28m。

每条通道插 3 个航点：**通道口 → 深处探入点 → 通道口**。两个通道口是纯转向点（`id=None`，
不驻留不采集），少了它们轨迹会从垛位斜着拉向通道深处，等于从垛体上穿过去。

探入点 id 为 `A-4-1-G01`~`G10`，深度默认 0.5（走一半），此时正好落在该排垛体中线
（南 y=10.2 / 北 y=28.1），与垛位读数取值同深度，热场结构不会被压平。

> ⚠ 这 10 个 id **目前只存在于模拟器**：`backend/src/a41-layout.js` 的 points 里没有它们，
> 所以数据能正常入库、能画进轨迹，但前端热力图（只画已知 point_id）不显示这 10 个点。
> 要显示需同步后端布局。用 `--no-comb` 可退回旧的"只沿中央通道直走"路线。

一轮代价：22 垛 → 32 个采集点，路径 101m → 213m，仿真时长 11.7min → 21.8min。

### `sim_a41_patrol.py` 常用姿势

```bash
# 干净数据，前端演示/回放（22 垛全点亮需抬高最短驻留，见下方"已知约束"）
python debug/sim_a41_patrol.py --dwell-min 18

# 退回旧路线：不拐进垛间通道
python debug/sim_a41_patrol.py --no-comb --dwell-min 18

# 探入浅一点（占垛体进深 25%）
python debug/sim_a41_patrol.py --probe-depth 0.25 --dwell-min 18

# 20 倍速灌一轮演示数据。梳齿路线一轮 21.8 分钟，start-offset 要大于它，
# 否则 ts 会落到未来
python debug/sim_a41_patrol.py --laps 1 --time-scale 20 --start-offset-min 28 --dwell-min 18

# 复现现场脏数据：26% 尺度亏损 + yaw 漂移/突跳 + 探头自热
python debug/sim_a41_patrol.py --pose-mode raw_odom --sensor-selfheat

# 标定算法的精确恢复夹具：应能解回 theta/scale/tx/ty 原值
python debug/sim_a41_patrol.py --pose-mode raw_odom --yaw-drift 0 --yaw-jumps 0 --dry-run

# 演示告警链路（在 A-4-1-15 放一个 32.5℃ 固定热点）
python debug/sim_a41_patrol.py --anomaly A-4-1-15
```

### 已知约束（都是现场真实约束，不是脚本缺陷）

1. **默认跑不满 22 个 `point_valid`**。终端侧判定需连续 `DWELL_COUNT=3` 条 × `INTERVAL_SEC=5s`
   = 站满 15s，而趟2 实测驻留中位仅 16s。演示要求全点亮时加 `--dwell-min 18`。
2. **温度绝不能照抄抓包读数**。抓包里的 26.8→31.7℃ 是**探头自热曲线**（拟合 RMSE 0.095℃），
   不是库房温度。自热是 `--sensor-selfheat` 才叠加的污染层。
   环境真值按现场实况建模：**南墙落地窗日照**造成西南高、东北低的对角梯度，日照(南↔北)为主、
   东西向为辅，增益比 S:W=2:1。增益按**垛体 sensing 包络**反解，使正午日照峰值时读数恰好顶满
   区间：最热垛（南排最西）**29.8℃**、最凉垛（北排最东）**22.0℃**；按垛体中心求值时，南排
   （贴落地窗）与北排（背阴）均温相差约 **4.1℃**。2026-07-28 实跑一轮（`--seed 20260728`）
   的 22 个垛位均温落在 22.0~28.8℃。
3. **clean 模式的观测速度低于抓包**。抓包的 0.44 m/s 被 yaw 突跳抹开的位移撑大了，
   不是真实步速。详见脚本头部注释"两处故意不对齐实测统计"。

参数标定的完整依据写在 `sim_a41_patrol.py` 顶部的 `CALIBRATION` 常数块，每个数值都注明出处。
回归测试见 `tests/test_sim_a41_patrol.py`（含照片真值的独立验证）。

---

## 其它脚本

| 脚本 | 用途 |
|---|---|
| `sim_go2_dog.py` | 机器狗**位姿源**模拟器，发假位姿给 `app/`。`--transport dds`（Pi）/ `--transport udp`（跨平台零依赖） |
| `debug_pose.py` | 位姿读取自测，需在 Pi 上、与 Go2 同网段运行 |
| `debug_matcher.py` | 点位匹配器独立自测，任意平台可跑 |
| `setup_wsl2_sim.sh` | WSL2 一键部署模拟环境 |
| `cmd.txt` | 随手记的命令片段 |
