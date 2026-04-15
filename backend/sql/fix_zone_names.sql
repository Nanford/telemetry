USE warehouse_iot;
SET NAMES utf8mb4;

UPDATE zones SET name='原料接收区 A1', description='烟叶原料进场、质检区域' WHERE zone_id='A1';
UPDATE zones SET name='初加工区 A2',   description='分拣、预处理车间'       WHERE zone_id='A2';
UPDATE zones SET name='醇化仓库 A3',   description='核心储存区，温湿度重点监控' WHERE zone_id='A3';
UPDATE zones SET name='成品仓库 A4',   description='醇化完成品存放区'       WHERE zone_id='A4';
UPDATE zones SET name='装卸调度区 A5', description='出库装车、物流调度区'   WHERE zone_id='A5';

UPDATE zone_geofences SET name='原料接收区 A1', description='烟叶原料进场、质检区域' WHERE zone_id='A1';
UPDATE zone_geofences SET name='初加工区 A2',   description='分拣、预处理车间'       WHERE zone_id='A2';
UPDATE zone_geofences SET name='醇化仓库 A3',   description='核心储存区，温湿度重点监控' WHERE zone_id='A3';
UPDATE zone_geofences SET name='成品仓库 A4',   description='醇化完成品存放区'       WHERE zone_id='A4';
UPDATE zone_geofences SET name='装卸调度区 A5', description='出库装车、物流调度区'   WHERE zone_id='A5';
