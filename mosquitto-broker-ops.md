# 云端 MQTT Broker 部署与运维手册（Mosquitto）

> 适用场景：Debian 云服务器部署 Mosquitto，作为烟叶库区温湿度/GPS 巡检平台的 MQTT 消息中枢。
> 本文以 **38.12.141.63** 为例；域名场景（如 `dht.leenf.online`）切 TLS 时另见 §9。

---

## 1. 架构位置

```
┌─────────────────┐        ┌──────────────────┐        ┌──────────────┐
│ 树莓派采集端    │  MQTT  │ 云端 Mosquitto   │  MQTT  │ 后端 API     │
│ (telemetry-agent)│ ─────▶│ (本手册对象)     │ ─────▶│ (ingest.js)  │
│ pub topic:      │  1883  │ 0.0.0.0:1883     │  1883  │ sub topic:   │
│ devices/{id}/…  │        │                  │        │ devices/+/#  │
└─────────────────┘        └──────────────────┘        └──────────────┘
                                    │
                                    ▼ QoS1 持久化
                              /var/lib/mosquitto/
```

- **协议端口**：MQTT TCP 明文 `1883` / TLS `8883`（可选）
- **认证方式**：用户名 + 密码（`password_file`）
- **账号规划**：
  - `telemetry_user` — 采集端（树莓派）用，拥有 `publish` 权限
  - `telemetry_api`  — 后端 API 用，拥有 `subscribe` 权限
- **持久化**：开启，断连/重启不丢 QoS1 消息与 retained 消息

---

## 2. 关键路径

| 路径 | 用途 |
|------|------|
| `/etc/mosquitto/mosquitto.conf` | 主配置（**不动**，用 `conf.d/` 覆盖） |
| `/etc/mosquitto/conf.d/telemetry.conf` | 本项目的自定义配置 |
| `/etc/mosquitto/passwd` | 账号密码文件（二进制散列） |
| `/var/lib/mosquitto/` | 持久化目录（retained + in-flight QoS 消息） |
| `/var/log/mosquitto/mosquitto.log` | 运行日志 |
| `/etc/systemd/system/multi-user.target.wants/mosquitto.service` | systemd 开机自启链接 |

---

## 3. 全新部署流程

### 3.1 安装

```bash
sudo apt update
sudo apt install -y mosquitto mosquitto-clients
```

装完后 Mosquitto 默认行为：**只监听 `127.0.0.1:1883`，允许匿名**。这对公网不可用也不安全，下一步必须覆盖。

### 3.2 建立账号

```bash
# -c 创建新密码文件（只在第一个账号时加 -c！）
sudo mosquitto_passwd -c /etc/mosquitto/passwd telemetry_user

# 追加第二个账号（去掉 -c）
sudo mosquitto_passwd /etc/mosquitto/passwd telemetry_api

# 锁权限
sudo chown mosquitto:mosquitto /etc/mosquitto/passwd
sudo chmod 640 /etc/mosquitto/passwd
```

> 密码建议 20 位以上随机串。本项目密码记录在 1Password / 运维保险柜（本文件不记录明文）。

### 3.3 写配置

```bash
sudo nano /etc/mosquitto/conf.d/telemetry.conf
```

```conf
# ---- 对外监听 ----
# 关键：必须绑 0.0.0.0，默认只绑 localhost 外部连不上
listener 1883 0.0.0.0

# ---- 认证 ----
allow_anonymous false
password_file /etc/mosquitto/passwd

# ---- 日志级别 ----
# 注意：Debian 的 /etc/mosquitto/mosquitto.conf 默认已经设了 persistence、
# persistence_location、log_dest file；在本文件里重复声明会让 Mosquitto
# 启动失败（Error: Duplicate ... value）。这里只追加主配置没设的部分。
log_type error
log_type warning
log_type notice
log_type information
connection_messages true

# ---- 限额 ----
max_connections -1           # 不限；小规模用默认即可
message_size_limit 262144    # 单消息 256KB，防止异常客户端塞爆内存
```

> 如果主配置 `/etc/mosquitto/mosquitto.conf` 里没有 `persistence` / `persistence_location` / `log_dest`（有些发行版默认不带），再把下面几行加进 `telemetry.conf`：
>
> ```conf
> persistence true
> persistence_location /var/lib/mosquitto/
> log_dest file /var/log/mosquitto/mosquitto.log
> ```
>
> 确认方法：`grep -vE '^\s*(#|$)' /etc/mosquitto/mosquitto.conf`

### 3.4 启动并自启

```bash
sudo systemctl restart mosquitto
sudo systemctl enable mosquitto
sudo systemctl status mosquitto --no-pager
```

### 3.5 验证监听地址

```bash
sudo ss -ltnp | grep 1883
```

- ✅ 看到 `0.0.0.0:1883` 或 `*:1883` → 正常
- ❌ 看到 `127.0.0.1:1883` → `listener` 配置没生效，回到 §3.3 检查 conf 文件是否被 include

### 3.6 防火墙放行（两层都要开）

**第一层 —— 系统 ufw**：

```bash
sudo ufw status
# 如果是 active：
sudo ufw allow 1883/tcp
sudo ufw reload
```

**第二层 —— 云厂商安全组**：
登录云控制台（Vultr / 阿里云 / 腾讯云等），**入站规则**添加 TCP `1883`。
⚠️ 这一步最容易漏，连接超时 90% 是卡在这里。

### 3.7 本机自测

```bash
# 终端 A（订阅）
mosquitto_sub -h 127.0.0.1 -p 1883 -u telemetry_user -P '密码' -t 'devices/#' -v

# 终端 B（发布）
mosquitto_pub -h 127.0.0.1 -p 1883 -u telemetry_user -P '密码' \
  -t 'devices/pi4-001/telemetry' \
  -m '{"device_id":"pi4-001","ts":1776233992,"temp_c":22.6,"rh":63}'
```

终端 A 应立即收到这条 JSON，说明 Broker 本身 + 认证 + 配置都 OK。

### 3.8 外部连通测试

在**树莓派**或 Windows 上：

```bash
# 仅测 TCP 通不通
nc -vz 38.12.141.63 1883

# 订阅真实流量
mosquitto_sub -h 38.12.141.63 -p 1883 -u telemetry_user -P '密码' -t 'devices/#' -v
```

能收到树莓派上报的 JSON 即全链路贯通。

---

## 4. 日常运维命令

### 4.1 服务管理

```bash
sudo systemctl status mosquitto --no-pager          # 状态
sudo systemctl restart mosquitto                    # 重启
sudo journalctl -u mosquitto -n 100 --no-pager      # systemd 层日志
sudo tail -f /var/log/mosquitto/mosquitto.log       # Broker 层日志
```

### 4.2 新增 / 修改 / 删除账号

```bash
# 新增（密码文件已存在时不要加 -c！）
sudo mosquitto_passwd /etc/mosquitto/passwd <新用户>

# 改密码
sudo mosquitto_passwd /etc/mosquitto/passwd <已有用户>

# 删除
sudo mosquitto_passwd -D /etc/mosquitto/passwd <用户>

# 重载：Mosquitto 不支持热重载 passwd，需要重启
sudo systemctl restart mosquitto
```

### 4.3 查看当前连接的客户端

```bash
# 订阅内置系统主题即可看到 Broker 指标
mosquitto_sub -h 127.0.0.1 -u telemetry_user -P '密码' -t '$SYS/#' -v
# 关注：$SYS/broker/clients/connected、$SYS/broker/messages/received 等
```

### 4.4 手工窥探某设备当前数据

```bash
# 只订阅某台设备
mosquitto_sub -h 127.0.0.1 -u telemetry_user -P '密码' -t 'devices/pi4-001/#' -v
```

---

## 5. 常见故障排查

### 5.0 启动失败先跑这三条（诊断入口）

`sudo systemctl status mosquitto` 经常只显示 `status=3/NOTIMPLEMENTED` + `Start request repeated too quickly`，**真正的错误原因被 systemd 的重启限流盖掉了**。启动失败时不要停在 `status`，按下面顺序拿原始错误：

```bash
# ① Broker 自己写的日志（最具体，配置/认证/端口类问题都在这里）
sudo tail -n 50 /var/log/mosquitto/mosquitto.log

# ② systemd 层日志（日志文件都没建出来时看这里，能看到每次 start 的行号级报错）
sudo journalctl -u mosquitto -n 80 --no-pager

# ③ 前台试跑（最直接，错误打到终端，不受 systemd 重启限流影响）
sudo mosquitto -c /etc/mosquitto/mosquitto.conf -v
# 看到 "mosquitto version X running" 即配置 OK，Ctrl+C 后再 systemctl restart
```

改完 conf 后**总是先用 ③ 前台试跑验证**，再 `systemctl restart`。这样能省掉一轮"改错→重启→看 status 只看到通用错→再翻 journalctl"的反复。

---

### 5.1 采集端报 `TimeoutError: timed out`

**典型日志**：
```
File ".../paho/mqtt/client.py", line ... in _create_socket_connection
TimeoutError: timed out
```

**说明**：3 次握手阶段就没走通，纯粹是网络层问题，**不是认证问题**。

**排查顺序**（从外到内）：

| 步骤 | 在哪执行 | 命令 | 期望结果 |
|------|----------|------|----------|
| ① Pi 能否解析/连到云 IP | 树莓派 | `nc -vz 38.12.141.63 1883` | `succeeded` |
| ② 云机端口是否监听 0.0.0.0 | 云机 | `sudo ss -ltnp \| grep 1883` | `0.0.0.0:1883` |
| ③ 云机 ufw 有没有放行 | 云机 | `sudo ufw status` | `1883/tcp ALLOW` |
| ④ 云厂商安全组入站规则 | 云控制台 | 查看入站 | 有 `TCP 1883` 的放行项 |

三种 `nc` 结果对应的定位：

| 结果 | 原因 | 处理 |
|------|------|------|
| `Connection timed out` | 中间层防火墙吞包 | 查 ufw + 云安全组 |
| `Connection refused` | 端口没人监听 / 只绑了 127.0.0.1 | 改 listener 或启动 Mosquitto |
| `succeeded` | 网络 OK，问题不在这 | 看认证/topic |

### 5.2 `Connection Refused: not authorised`

账号密码错，或者 `password_file` 路径写错 Mosquitto 读不到。

```bash
# 验证密码文件被正确加载
sudo journalctl -u mosquitto -n 50 --no-pager | grep -i password

# 直接测试账号密码
mosquitto_pub -h 127.0.0.1 -u telemetry_user -P '密码' -t test -m ok
```

如报 `Connection Refused: not authorised`，重置密码：

```bash
sudo mosquitto_passwd /etc/mosquitto/passwd telemetry_user
sudo systemctl restart mosquitto
```

### 5.3 启动失败：`Error: Unable to open log file`

日志目录权限问题：

```bash
sudo mkdir -p /var/log/mosquitto
sudo chown mosquitto:mosquitto /var/log/mosquitto
sudo systemctl restart mosquitto
```

### 5.4 启动失败：`Address already in use`

1883 被别的进程占了：

```bash
sudo ss -ltnp | grep 1883
sudo lsof -i :1883
# 找到占用进程后 kill，或者换端口
```

### 5.5 启动失败：`Duplicate "xxx" value in configuration`

**典型报错**：

```
Error: Duplicate persistence_location value in configuration.
Error found at /etc/mosquitto/conf.d/telemetry.conf:11.
Error found at /etc/mosquitto/mosquitto.conf:13.
```

**原因**：Debian/Ubuntu 发行版的 `/etc/mosquitto/mosquitto.conf` 默认已经声明了 `persistence`、`persistence_location`、`log_dest file` 三项，在 `conf.d/telemetry.conf` 里再写一次就冲突。Mosquitto 对大部分全局配置项**不允许重复**，哪怕值完全相同也不行。

**修法**：

```bash
# ① 先看主配置已经设了什么
grep -vE '^\s*(#|$)' /etc/mosquitto/mosquitto.conf

# ② 把 telemetry.conf 里与主配置同名的项删掉或注释掉
sudo nano /etc/mosquitto/conf.d/telemetry.conf

# ③ 前台验证
sudo mosquitto -c /etc/mosquitto/mosquitto.conf -v
```

常见要删的重复项：`persistence`、`persistence_location`、`log_dest`、`pid_file`。`log_type` 可以多次出现（是追加不是覆盖），不会冲突。

> 本项目 §3.3 的 `telemetry.conf` 模板已经按 Debian 默认主配置裁剪，换发行版前先跑 ① 对照一遍。

### 5.6 消息延迟 / spool 积压但不报错

网络不稳，QoS1 在重传。确认：

```bash
# 看 Broker 侧活跃客户端数
mosquitto_sub -h 127.0.0.1 -u telemetry_user -P '密码' -t '$SYS/broker/clients/active' -C 1

# 看 Pi 侧 spool 积压
sqlite3 /var/lib/telemetry-agent/spool.db "SELECT COUNT(1) FROM spool;"
```

spool 持续增长 = Pi → Broker 方向有问题；spool 稳定 = 上行正常，问题在 Broker → API 方向。

---

## 6. 升级 / 变更操作 SOP

### 6.1 改配置

```bash
sudo nano /etc/mosquitto/conf.d/telemetry.conf
sudo mosquitto -c /etc/mosquitto/mosquitto.conf -v &   # 前台启动试跑（可选）
# 确认无报错后 Ctrl+C，再正式重启
sudo systemctl restart mosquitto
sudo systemctl status mosquitto --no-pager
```

### 6.2 升级 Mosquitto 版本

```bash
sudo apt update
sudo apt install --only-upgrade mosquitto mosquitto-clients
sudo systemctl restart mosquitto
mosquitto -h | head -1   # 确认版本
```

### 6.3 清空 retained / 持久化队列

```bash
sudo systemctl stop mosquitto
sudo rm -f /var/lib/mosquitto/mosquitto.db
sudo systemctl start mosquitto
```

⚠️ 会丢失所有 retained 消息和离线队列，谨慎。

---

## 7. 关闭 / 迁移

### 7.1 临时停

```bash
sudo systemctl stop mosquitto
```

### 7.2 永久下线

```bash
sudo systemctl stop mosquitto
sudo systemctl disable mosquitto
sudo apt purge -y mosquitto
# 配置和数据不会自动删，手动：
sudo rm -rf /etc/mosquitto/conf.d/telemetry.conf /var/lib/mosquitto
```

### 7.3 换服务器

1. 新机执行 §3 全流程
2. 复制 `/etc/mosquitto/passwd` 到新机（保持账号密码一致，避免改 Pi 和后端配置）
3. 更新 DNS（如走域名）或直接在 Pi `/etc/telemetry-agent.env` 改 `MQTT_HOST`
4. 老机保留 24h 作为回滚备份，确认无积压后再关停

---

## 8. 安全加固建议

### 8.1 公网暴露 1883 的风险

- 明文传输：抓包即可拿到账号密码
- 端口暴露：僵尸网络持续扫 1883 做暴力破解

**短期联调可以容忍**，长期至少做以下之一：

| 方案 | 成本 | 保护力度 |
|------|------|----------|
| 云安全组限源 IP | 低 | 中（出口 IP 变就失效） |
| 上 TLS 8883 | 中 | 高 |
| VPN / Tailscale 内网穿透 | 中 | 最高（1883 完全不暴露） |

### 8.2 密码强度

```bash
# 生成 24 字节随机密码
openssl rand -base64 24
```

### 8.3 主题 ACL（按用户限制 topic）

创建 `/etc/mosquitto/acl`：

```
# 采集端只能发 devices/<自己id>/...
user telemetry_user
topic write devices/+/telemetry
topic write devices/+/status
topic write devices/+/+/telemetry

# 后端 API 只能订阅
user telemetry_api
topic read devices/#
topic read $SYS/#
```

在 `telemetry.conf` 追加：

```conf
acl_file /etc/mosquitto/acl
```

然后重启 Mosquitto。

---

## 9. TLS 升级（8883）

前提：已有域名（如 `dht.leenf.online`）解析到本机，且已用 `certbot` 签好证书。

### 9.1 Mosquitto 配置追加

```conf
# 追加到 /etc/mosquitto/conf.d/telemetry.conf
listener 8883 0.0.0.0
cafile   /etc/letsencrypt/live/dht.leenf.online/chain.pem
certfile /etc/letsencrypt/live/dht.leenf.online/cert.pem
keyfile  /etc/letsencrypt/live/dht.leenf.online/privkey.pem
```

### 9.2 证书权限（关键）

Let's Encrypt 私钥默认只有 root 可读，Mosquitto 启动进程读不到会报错。

```bash
sudo chgrp mosquitto /etc/letsencrypt/live/dht.leenf.online/privkey.pem
sudo chmod 640 /etc/letsencrypt/live/dht.leenf.online/privkey.pem
```

### 9.3 证书续签钩子

每次 `certbot renew` 会重置权限，要加续签后的 hook：

```bash
sudo nano /etc/letsencrypt/renewal-hooks/post/mosquitto-reload.sh
```

```bash
#!/bin/bash
chgrp mosquitto /etc/letsencrypt/live/dht.leenf.online/privkey.pem
chmod 640 /etc/letsencrypt/live/dht.leenf.online/privkey.pem
systemctl reload mosquitto
```

```bash
sudo chmod +x /etc/letsencrypt/renewal-hooks/post/mosquitto-reload.sh
```

### 9.4 防火墙开 8883

```bash
sudo ufw allow 8883/tcp
# 云厂商安全组同步放行
```

### 9.5 采集端切 TLS

```bash
# /etc/telemetry-agent.env
MQTT_HOST=dht.leenf.online   # ⚠️ 必须用域名，用 IP 会 TLS 握手失败（SNI/证书名不匹配）
MQTT_PORT=8883
MQTT_TLS=1
MQTT_CA_CERT=/etc/ssl/certs/ca-certificates.crt
```

```bash
sudo systemctl restart telemetry-agent
```

### 9.6 TLS 测试

```bash
mosquitto_sub -h dht.leenf.online -p 8883 \
  --cafile /etc/ssl/certs/ca-certificates.crt \
  -u telemetry_user -P '密码' -t 'devices/#' -v
```

---

## 10. 快速索引：一条命令完成常见事

| 目的 | 命令 |
|------|------|
| 查 Broker 状态 | `sudo systemctl status mosquitto --no-pager` |
| 实时看日志 | `sudo tail -f /var/log/mosquitto/mosquitto.log` |
| 查监听端口 | `sudo ss -ltnp \| grep mosquitto` |
| 查在线客户端 | `mosquitto_sub -u telemetry_user -P '密码' -t '$SYS/broker/clients/connected' -C 1` |
| 窥探某设备数据 | `mosquitto_sub -u telemetry_user -P '密码' -t 'devices/pi4-001/#' -v` |
| 外部连通测试 | `nc -vz 38.12.141.63 1883` |
| 重启 Broker | `sudo systemctl restart mosquitto` |

---

## 11. 和其他手册的关系

- **采集端（树莓派）**：见 `telemetry-agent-ops.md`
- **后端 API + 前端**：见 `DEPLOYMENT_GUIDE.md`（含完整技术栈）
- **本手册**：只聚焦 MQTT Broker 本身
