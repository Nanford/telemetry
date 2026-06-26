const assert = require('assert');

const { buildTelemetryMigrationStatements } = require('../src/schema-migrations');

const statements = buildTelemetryMigrationStatements(
  new Set(['area_id', 'pose_source']),
  new Set(['idx_tr_area_ts']),
  new Set()
);

assert.ok(
  statements.some((statement) => statement.includes('ADD COLUMN pose_fix')),
  '缺失的SLAM字段应生成迁移语句'
);
assert.ok(
  statements.some((statement) => statement.includes('ADD KEY idx_tr_point_ts')),
  '缺失的点位索引应生成迁移语句'
);
assert.ok(
  statements.some((statement) => statement.includes('ADD KEY idx_tr_ts')),
  '时间范围查询需要独立ts索引'
);
assert.ok(
  !statements.some((statement) => statement.includes('ADD COLUMN area_id')),
  '已存在字段不应重复迁移'
);
assert.ok(
  !statements.some((statement) => statement.includes('ADD KEY idx_tr_area_ts')),
  '已存在索引不应重复迁移'
);

assert.ok(
  statements.some((statement) => statement.includes('ALTER TABLE alert_rules ADD COLUMN deleted_at')),
  'alert_rules needs deleted_at for archived threshold rules'
);

const existingRuleStatements = buildTelemetryMigrationStatements(
  new Set(['area_id', 'pose_source']),
  new Set(['idx_tr_area_ts']),
  new Set(['deleted_at'])
);

assert.ok(
  !existingRuleStatements.some((statement) => statement.includes('ALTER TABLE alert_rules ADD COLUMN deleted_at')),
  'alert_rules deleted_at migration should not repeat'
);

console.log('schema-migrations: OK');
