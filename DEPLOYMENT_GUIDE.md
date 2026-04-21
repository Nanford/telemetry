# LeafVault 云端部署手册（Debian 单机）

> 适用场景：Debian 云服务器，Mosquitto + MySQL + Node API + Nginx + React 前端**全栈同机**部署。
> 域名：`windoor.leenf.online`（替换为你自己的域名）。
> MQTT Broker 本身的配置/排障见 [`mosquitto-broker-ops.md`](./mosquitto-broker-ops.md)，本文不重复。

---

## 1. 架构与端口规划

```
                ┌──────────────────────────────────────────────────┐
                │  Debian 云机 (windoor.leenf.online)                 │
                │                                                  │
   采集端 ──►  │   :1883  Mosquitto  ◄──┐                        │
   (Pi4)       │                         │                        │
                │                         │ (mqtt://127.0.0.1)     │
                │                         ▼                        │
   浏览器 ──►  │   :443  Nginx  ──►  :8011  Node API  ──►  :3306  MySQL │
                │    (HTTPS)           (localhost)            (localhost)    │
                │        │                                                   │
                │        └─► /  静态文件 (/var/www/telemetry)              │
                └──────────────────────────────────────────────────┘
```

| 组件 | 端口 | 对外？ | 备注 |
|------|------|--------|------|
| Nginx | 80 / 443 | ✅ | 80 只做 HTTP→HTTPS 跳转 |
| Mosquitto | 1883 | ✅ | 采集端接入；后续可切 TLS 8883 |
| Node API | 8011 | ❌ | 只监听 127.0.0.1，由 Nginx 反代 |
| MySQL | 3306 | ❌ | 只监听 127.0.0.1 |

**原则**：除了 Nginx 和 Mosquitto，其他服务都绑本地，不走公网。

---

## 2. 初次部署流程

### 2.1 DNS 与系统依赖

```bash
# DNS（在域名服务商控制台操作）
# 添加 A 记录：windoor.leenf.online → <云机公网 IP>

# 系统更新 + 基础软件
sudo apt update && sudo apt -y upgrade
sudo apt install -y nginx git ufw curl

# 数据库：本项目代码用 mysql2 驱动，MariaDB 与 MySQL 完全兼容。
# 若云机已安装 MariaDB（debian 12 默认仓库即 MariaDB 10.11），跳过安装；
# 没装过再装：  sudo apt install -y mariadb-server
mysql --version        # 期望看到 mariadb/mysql 客户端版本

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v      # 期望 v20.x / 10.x
```

> 本项目的 `backend/sql/schema.sql` 用到的特性（InnoDB / JSON / DATETIME / AUTO_INCREMENT / FOREIGN KEY）在 MariaDB 10.11 全部原生支持，**不需要改脚本**。

### 2.2 防火墙

```bash
sudo ufw allow 22           # SSH
sudo ufw allow 80/tcp       # HTTP（certbot 验证 + 跳 HTTPS）
sudo ufw allow 443/tcp      # HTTPS
sudo ufw allow 1883/tcp     # MQTT（无 TLS 阶段）
sudo ufw enable
sudo ufw status
```

> 云厂商**安全组入站规则**同步放行 22/80/443/1883，这一步经常漏。

### 2.3 MariaDB / MySQL 初始化

**如果是全新装的数据库**，先跑一次安全初始化（已有其他业务库共用这台实例的，**跳过这步**，避免改动现有配置）：

```bash
sudo mysql_secure_installation
```

建库与**专用应用账号**（不要让 API 用 root，尤其这台实例上还有 `image_gallery`、`sales_data`、`wms_platform` 等其它业务库，必须做到最小权限隔离）：

```bash
sudo mysql -uroot -p
```

```sql
CREATE DATABASE IF NOT EXISTS warehouse_iot DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 生成一个强密码：openssl rand -base64 24
CREATE USER 'telemetry'@'localhost' IDENTIFIED BY '<替换成强密码>';

-- DDL 权限（脚本导入期暂时需要 CREATE/INDEX/REFERENCES）
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, REFERENCES, ALTER
  ON warehouse_iot.* TO 'telemetry'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

> 初次导完 schema 之后，可以回收 DDL 权限，只留运行期需要的 4 个：
> ```sql
> REVOKE CREATE, INDEX, REFERENCES, ALTER ON warehouse_iot.* FROM 'telemetry'@'localhost';
> FLUSH PRIVILEGES;
> ```

### 2.4 拉代码 + 导表结构

```bash
sudo mkdir -p /opt && cd /opt
sudo git clone https://github.com/Nanford/telemetry.git
sudo chown -R $USER:$USER /opt/telemetry
cd /opt/telemetry

mysql -u telemetry -p warehouse_iot < backend/sql/schema.sql
# 如有种子数据
mysql -u telemetry -p warehouse_iot < backend/sql/seed_geofences.sql
```

### 2.5 MQTT Broker

Mosquitto 的账号 / 监听 / 防火墙 / TLS 已在 [`mosquitto-broker-ops.md`](./mosquitto-broker-ops.md) 详述，此处不重复。**部署时按那份文档的 §3 完成**，然后验证：

```bash
sudo ss -ltnp | grep 1883   # 期望 0.0.0.0:1883
sudo systemctl status mosquitto --no-pager
```

### 2.6 后端 API

**环境变量文件**（systemd 加载，而不是 `.env`，避免进程工作目录切换踩坑）：

```bash
sudo nano /etc/telemetry-api.env
```

```ini
PORT=8011

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=telemetry
MYSQL_PASSWORD=<2.3 里设的应用密码>
MYSQL_DATABASE=warehouse_iot

MQTT_URL=mqtt://127.0.0.1:1883
MQTT_USERNAME=telemetry_api
MQTT_PASSWORD=<MQTT 订阅账号密码>
MQTT_TOPIC=devices/+/+/telemetry,devices/+/telemetry
MQTT_CLIENT_ID=telemetry-api-prod
```

```bash
sudo chmod 640 /etc/telemetry-api.env
sudo chown root:root /etc/telemetry-api.env
```

**安装依赖**：

```bash
cd /opt/telemetry/backend
npm ci --omit=dev   # 如果是第一次没 lock 也可以 npm install
```

**systemd 服务**：

```bash
sudo nano /etc/systemd/system/telemetry-api.service
```

```ini
[Unit]
Description=LeafVault Telemetry API
After=network.target mysql.service mosquitto.service
Wants=mysql.service mosquitto.service

[Service]
Type=simple
WorkingDirectory=/opt/telemetry/backend
EnvironmentFile=/etc/telemetry-api.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
StandardOutput=append:/var/log/telemetry-api.log
StandardError=append:/var/log/telemetry-api.err

[Install]
WantedBy=multi-user.target
```

```bash
sudo touch /var/log/telemetry-api.{log,err}
sudo chown www-data:www-data /var/log/telemetry-api.{log,err}   # 或 nobody
sudo systemctl daemon-reload
sudo systemctl enable --now telemetry-api
sudo systemctl status telemetry-api --no-pager
```

**本地冒烟测试**：

```bash
curl http://127.0.0.1:8011/api/v1/health    # 期望 200 + JSON
```

### 2.7 前端构建 + 发布

前端是**构建期**注入 API 地址，所以 `VITE_API_BASE` 必须在 `npm run build` 之前设好：

```bash
cd /opt/telemetry/frontend

# 构建期环境变量
cat > .env.production <<'EOF'
VITE_API_BASE=https://windoor.leenf.online/api/v1
EOF

npm ci
npm run build

# 发布到 nginx 根目录
sudo mkdir -p /var/www/telemetry
sudo rm -rf /var/www/telemetry/*
sudo cp -r dist/* /var/www/telemetry/
sudo chown -R www-data:www-data /var/www/telemetry
```

> 改了 `VITE_API_BASE` 后**必须重新 `npm run build` + 同步静态文件**，否则旧的 URL 还会被老的 JS bundle 里硬编码使用。

### 2.8 Nginx 反向代理

```bash
sudo nano /etc/nginx/sites-available/telemetry
```

```nginx
server {
    listen 80;
    server_name windoor.leenf.online;
    # 80 的流量 certbot 会接管并加上跳转，这里先留空即可

    root /var/www/telemetry;
    index index.html;

    # SPA fallback：前端路由交给 index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API 反代（注意末尾斜杠对 URL 拼接的影响）
    location /api/ {
        proxy_pass http://127.0.0.1:8011/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # 静态资源缓存
    location ~* \.(js|css|png|jpg|svg|ico|woff2?)$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
}
```

启用：

```bash
sudo ln -s /etc/nginx/sites-available/telemetry /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

### 2.9 HTTPS（Let's Encrypt）

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d windoor.leenf.online
# 按提示输入邮箱；选 2 (Redirect HTTP→HTTPS)

# 自动续期（系统默认已开 certbot.timer，验证一下）
sudo systemctl status certbot.timer --no-pager
sudo certbot renew --dry-run
```

### 2.10 最终验证清单

| 项目 | 命令 | 期望 |
|------|------|------|
| Mosquitto 监听 | `sudo ss -ltnp \| grep 1883` | `0.0.0.0:1883` |
| API 本地可通 | `curl http://127.0.0.1:8011/api/v1/health` | 200 + JSON |
| API 经 Nginx 可通 | `curl https://windoor.leenf.online/api/v1/health` | 200 + JSON |
| 前端站点 | 浏览器打开 `https://windoor.leenf.online` | 能进 dashboard |
| 前端不走 mock | 浏览器 Network 面板 | 看到 `/api/v1/*` 请求且返回真实数据 |
| MQTT 订阅 | `mosquitto_sub -h 127.0.0.1 -u telemetry_api -P '密码' -t 'devices/#' -v` | 有实时消息 |
| HTTPS 证书 | `curl -I https://windoor.leenf.online` | `HTTP/2 200`、证书有效 |

---

## 3. 日常运维

### 3.1 更新版本（热更新）

```bash
cd /opt/telemetry
git pull --ff-only

# 后端依赖有变动时才需要 npm ci
cd backend && npm ci --omit=dev
sudo systemctl restart telemetry-api

# 前端每次都要重构 + 发布（因为 .env.production 编译期注入）
cd ../frontend
npm ci
npm run build
sudo rm -rf /var/www/telemetry/*
sudo cp -r dist/* /var/www/telemetry/
sudo chown -R www-data:www-data /var/www/telemetry

# Nginx 配置没改不用 reload
```

### 3.2 查日志

```bash
# 后端 API 日志
sudo tail -f /var/log/telemetry-api.log
sudo tail -f /var/log/telemetry-api.err
sudo journalctl -u telemetry-api -n 100 --no-pager

# Nginx
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# Mosquitto
sudo tail -f /var/log/mosquitto/mosquitto.log

# MySQL 慢/错误日志
sudo tail -f /var/log/mysql/error.log
```

### 3.3 数据库备份

```bash
# 单次
mysqldump -u telemetry -p warehouse_iot | gzip > /tmp/warehouse_iot_$(date +%Y%m%d).sql.gz

# 定时（每天 03:00，保留 7 天）
sudo nano /etc/cron.d/telemetry-backup
```

```
0 3 * * * root mysqldump -u telemetry -p'<密码>' warehouse_iot | gzip > /var/backups/warehouse_iot_$(date +\%F).sql.gz && find /var/backups -name 'warehouse_iot_*.sql.gz' -mtime +7 -delete
```

---

## 4. 常见问题

| 现象 | 最可能原因 | 处理 |
|------|------------|------|
| 浏览器打开显示 mock 数据 | `VITE_API_BASE` 没设 / dist 没重发 | 查 `frontend/.env.production`，重 `build` 再 `cp` |
| `/api/v1/health` 502 | Node API 没起来 | `systemctl status telemetry-api` + 看日志 |
| `/api/v1/*` 404 但 `/` 正常 | Nginx `proxy_pass` 末尾斜杠问题 | 按 §2.8 写法：`proxy_pass http://127.0.0.1:8011/api/;` |
| 证书签不下来 | DNS 没生效 / 80 被挡 | `dig windoor.leenf.online` + 放行 80 |
| MQTT 收不到消息 | 见 `mosquitto-broker-ops.md` §5 | 按那份文档排查 |
| API 日志 `ER_ACCESS_DENIED_ERROR` | `/etc/telemetry-api.env` 里 MYSQL_PASSWORD 错 | 重置后 `systemctl restart telemetry-api` |
| API 日志 `ECONNREFUSED 127.0.0.1:1883` | Mosquitto 没起 / 端口变了 | `systemctl status mosquitto` |
| `npm run build` OOM | 小内存机（<1G）编译卡死 | `NODE_OPTIONS=--max-old-space-size=1024 npm run build`，或本地构建后 rsync dist/ |

---

## 5. 环境变量速查

### 5.1 后端 `/etc/telemetry-api.env`

| 变量 | 作用 | 示例 |
|------|------|------|
| `PORT` | API 监听端口 | `8011` |
| `MYSQL_*` | 连接 MySQL | 见 §2.6 |
| `MQTT_URL` | Broker 地址 | `mqtt://127.0.0.1:1883` |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | 订阅账号（用 `telemetry_api`，不是采集端账号） | — |
| `MQTT_TOPIC` | 订阅 topic | `devices/+/+/telemetry,devices/+/telemetry` |
| `INGEST_BATCH_SIZE` | 批量写库条数 | 默认 50 |
| `INGEST_FLUSH_INTERVAL_MS` | 批量刷盘间隔 | 默认 2000 |

### 5.2 前端 `frontend/.env.production`

| 变量 | 作用 | 示例 |
|------|------|------|
| `VITE_API_BASE` | 前端调用的 API 根路径 | `https://windoor.leenf.online/api/v1` |

⚠️ Vite 在**构建期**把这些变量内联到 JS bundle，运行期改不了 —— 改完必须重 `npm run build`。

---

## 6. 采集端（Pi4）对接参考

采集端 `/etc/telemetry-agent.env` 指向云端 Broker：

```ini
MQTT_HOST=windoor.leenf.online
MQTT_PORT=1883
MQTT_USERNAME=telemetry_user        # publish 账号
MQTT_PASSWORD=<采集端密码>
MQTT_TOPIC=devices/{device_id}/telemetry
# 或带 zone：devices/{device_id}/{zone_id}/telemetry
```

采集端部署细节见 [`telemetry-agent-ops.md`](./telemetry-agent-ops.md)；切换到 TLS(8883) 的流程见 `mosquitto-broker-ops.md` §9。

---

## 7. 相关文档

- **MQTT Broker 运维**：`mosquitto-broker-ops.md`
- **采集端（树莓派）运维**：`telemetry-agent-ops.md`
- **项目总览 / PRD**：`telemetry_project.md`
- **给 AI 助手的项目指南**：`CLAUDE.md` / `AGENTS.md`
