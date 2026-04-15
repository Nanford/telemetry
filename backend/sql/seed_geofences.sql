USE warehouse_iot;
SET NAMES utf8mb4;

-- 区域 A1-A5：烟叶仓库从西到东依次排列
-- 整体覆盖约 120m(东西) × 50m(南北)，中心 30.68173, 114.18327
-- 基于设备 GPS 坐标 30.681732, 114.183271 规划

INSERT INTO zones (zone_id, name, description) VALUES
  ('A1', '原料接收区 A1', '烟叶原料进场、质检区域'),
  ('A2', '初加工区 A2',   '分拣、预处理车间'),
  ('A3', '醇化仓库 A3',   '核心储存区，温湿度重点监控'),
  ('A4', '成品仓库 A4',   '醇化完成品存放区'),
  ('A5', '装卸调度区 A5', '出库装车、物流调度区')
ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description);

INSERT INTO zone_geofences (zone_id, name, description, min_lat, max_lat, min_lon, max_lon, priority) VALUES
  ('A1', '原料接收区 A1', '烟叶原料进场、质检区域',   30.681507, 30.681957, 114.182641, 114.182891, 1),
  ('A2', '初加工区 A2',   '分拣、预处理车间',         30.681507, 30.681957, 114.182891, 114.183141, 1),
  ('A3', '醇化仓库 A3',   '核心储存区，温湿度重点监控', 30.681507, 30.681957, 114.183141, 114.183401, 1),
  ('A4', '成品仓库 A4',   '醇化完成品存放区',         30.681507, 30.681957, 114.183401, 114.183651, 1),
  ('A5', '装卸调度区 A5', '出库装车、物流调度区',     30.681507, 30.681957, 114.183651, 114.183901, 1)
ON DUPLICATE KEY UPDATE
  name=VALUES(name), description=VALUES(description),
  min_lat=VALUES(min_lat), max_lat=VALUES(max_lat),
  min_lon=VALUES(min_lon), max_lon=VALUES(max_lon),
  priority=VALUES(priority);
