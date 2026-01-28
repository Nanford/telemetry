# 烟叶库区温湿度与巡检监控平台部署手册（Debian）

适用于域名 **dht.leenf.online** / IP **45.63.106.43**，含 MQTT Broker。

> 本文默认架构：Nginx + Node API + MySQL + Mosquitto + 前端静态站点
> 后端端口固定为 **8011**。

---

## 0. DNS 与基础环境

### 0.1 DNS 解析
在域名服务商控制台添加 A 记录：
```
dht.leenf.online  ->  45.63.106.43
```

### 0.2 系统更新
```bash
sudo apt update && sudo apt -y upgrade
```

---

## 1. 安装依赖
```bash
sudo apt install -y nginx mysql-server mosquitto mosquitto-clients git ufw
```

### 1.1 安装 Node.js 20 LTS
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v
```

---

## 2. 防火墙（可选）
```bash
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow 1883
sudo ufw enable
sudo ufw status
```

> 后端 API 通过 Nginx 转发，不需要额外开放 8011。

---

## 3. MySQL 初始化

### 3.1 安全初始化
```bash
sudo mysql_secure_installation
```

### 3.2 创建库与账号
```sql
CREATE DATABASE IF NOT EXISTS warehouse_iot DEFAULT CHARSET utf8mb4;
CREATE USER 'telemetry'@'localhost' IDENTIFIED BY 'StrongPasswordHere';
GRANT ALL PRIVILEGES ON warehouse_iot.* TO 'telemetry'@'localhost';
FLUSH PRIVILEGES;
```

### 3.3 导入表结构
```bash
cd /opt
git clone <你的代码仓库地址> telemetry
cd /opt/telemetry
mysql -u telemetry -p warehouse_iot < backend/sql/schema.sql
```

---

## 4. 配置 MQTT Broker（Mosquitto）

默认 Mosquitto 已监听 1883。推荐开启账号认证：

```bash
sudo mosquitto_passwd -c /etc/mosquitto/passwd telemetry_user
```

创建配置：
```bash
sudo nano /etc/mosquitto/conf.d/telemetry.conf
```

内容示例：
```
listener 1883
allow_anonymous false
password_file /etc/mosquitto/passwd
```

重启并启用：
```bash
sudo systemctl restart mosquitto
sudo systemctl enable mosquitto
```

---

## 5. 后端部署（Node API + MQTT 接入）

### 5.1 环境变量
```bash
sudo nano /etc/telemetry-api.env
```

示例：
```
PORT=8011

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=telemetry
MYSQL_PASSWORD=StrongPasswordHere
MYSQL_DATABASE=warehouse_iot

MQTT_URL=mqtt://127.0.0.1:1883
MQTT_USERNAME=telemetry_user
MQTT_PASSWORD=你的MQTT密码
MQTT_TOPIC=devices/+/+/telemetry,devices/+/telemetry
```

### 5.2 安装依赖
```bash
cd /opt/telemetry/backend
npm install
```

### 5.3 systemd 服务
```bash
sudo nano /etc/systemd/system/telemetry-api.service
```

内容：
```
[Unit]
Description=Telemetry API Service
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/telemetry/backend
EnvironmentFile=/etc/telemetry-api.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启动服务：
```bash
sudo systemctl daemon-reload
sudo systemctl enable telemetry-api
sudo systemctl start telemetry-api
sudo systemctl status telemetry-api
```

---

## 6. 前端部署（Nginx 静态站点）

### 6.1 设置 API 地址
创建 `frontend/.env.production`：
```
VITE_API_BASE=https://dht.leenf.online/api/v1
```

### 6.2 构建
```bash
cd /opt/telemetry/frontend
npm install
npm run build
```

### 6.3 发布静态文件
```bash
sudo mkdir -p /var/www/telemetry
sudo cp -r /opt/telemetry/frontend/dist/* /var/www/telemetry/
```

---

## 7. Nginx 配置
```bash
sudo nano /etc/nginx/sites-available/telemetry
```

配置示例：
```
server {
    listen 80;
    server_name dht.leenf.online;

    root /var/www/telemetry;
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8011/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

启用并重启：
```bash
sudo ln -s /etc/nginx/sites-available/telemetry /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

---

## 8. HTTPS（Let’s Encrypt）
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d dht.leenf.online
```

---

## 9. 采集端 MQTT 配置参考
```
MQTT_HOST=dht.leenf.online
MQTT_PORT=1883
MQTT_USERNAME=telemetry_user
MQTT_PASSWORD=你的MQTT密码
MQTT_TOPIC=devices/{device_id}/telemetry   # 或 devices/{device_id}/{zone_id}/telemetry
```

---

## 10. 验证

### 10.1 前端
```
https://dht.leenf.online
```

### 10.2 API 健康检查
```
https://dht.leenf.online/api/v1/health
```

### 10.3 MQTT 测试
```bash
mosquitto_sub -h dht.leenf.online -u telemetry_user -P 你的MQTT密码 -t "devices/+/telemetry" -v
```

---

## 11. 常见问题

- **API 4011 / 8011 不通**：确认 systemd 服务状态 `sudo systemctl status telemetry-api`
- **前端显示 mock 数据**：检查 `VITE_API_BASE` 是否正确，API 是否可访问
- **MQTT 连接失败**：检查账号/密码、`/etc/mosquitto/passwd` 与 `telemetry.conf`

---

如需开启 **MQTT TLS(8883)**、日志监控或数据备份，我可以继续补充。
