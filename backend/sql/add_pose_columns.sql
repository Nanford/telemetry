USE warehouse_iot;

-- Add SLAM pose columns to telemetry_raw for Go2 indoor positioning
ALTER TABLE telemetry_raw
  ADD COLUMN pose_source VARCHAR(16) NULL AFTER speed_kmh,
  ADD COLUMN pose_fix TINYINT(1) NULL AFTER pose_source,
  ADD COLUMN pos_x DECIMAL(10,4) NULL AFTER pose_fix,
  ADD COLUMN pos_y DECIMAL(10,4) NULL AFTER pos_x,
  ADD COLUMN pos_z DECIMAL(10,4) NULL AFTER pos_y,
  ADD COLUMN yaw DECIMAL(8,4) NULL AFTER pos_z,
  ADD COLUMN point_id VARCHAR(64) NULL AFTER yaw,
  ADD COLUMN sample_type VARCHAR(16) NULL AFTER point_id;

ALTER TABLE telemetry_raw
  ADD KEY idx_tr_point_ts (point_id, ts);
