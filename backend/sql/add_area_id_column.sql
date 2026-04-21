USE warehouse_iot;

ALTER TABLE telemetry_raw
  ADD COLUMN area_id VARCHAR(64) NULL AFTER zone_id;

ALTER TABLE telemetry_raw
  ADD KEY idx_tr_area_ts (area_id, ts);
