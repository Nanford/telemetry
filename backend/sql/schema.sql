CREATE DATABASE IF NOT EXISTS warehouse_iot DEFAULT CHARSET utf8mb4;
USE warehouse_iot;

-- 设备
CREATE TABLE IF NOT EXISTS devices (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  device_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  last_seen_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 区域
CREATE TABLE IF NOT EXISTS zones (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  zone_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 传感器点位（一个设备可对应多个区域/多个点位）
CREATE TABLE IF NOT EXISTS sensors (
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
CREATE TABLE IF NOT EXISTS telemetry_raw (
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
CREATE TABLE IF NOT EXISTS telemetry_hourly (
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
CREATE TABLE IF NOT EXISTS alert_rules (
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
CREATE TABLE IF NOT EXISTS alerts (
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

-- 区域围栏（矩形）
CREATE TABLE IF NOT EXISTS zone_geofences (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  zone_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(255) NULL,
  min_lat DECIMAL(10,7) NOT NULL,
  max_lat DECIMAL(10,7) NOT NULL,
  min_lon DECIMAL(10,7) NOT NULL,
  max_lon DECIMAL(10,7) NOT NULL,
  priority INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_geofence_zone FOREIGN KEY (zone_id) REFERENCES zones(zone_id)
) ENGINE=InnoDB;
