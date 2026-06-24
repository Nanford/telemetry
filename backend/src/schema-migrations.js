const TELEMETRY_COLUMNS = [
  ['area_id', 'VARCHAR(64) NULL'],
  ['pose_source', 'VARCHAR(16) NULL'],
  ['pose_fix', 'TINYINT(1) NULL'],
  ['pos_x', 'DECIMAL(10,4) NULL'],
  ['pos_y', 'DECIMAL(10,4) NULL'],
  ['pos_z', 'DECIMAL(10,4) NULL'],
  ['yaw', 'DECIMAL(8,4) NULL'],
  ['point_id', 'VARCHAR(64) NULL'],
  ['sample_type', 'VARCHAR(16) NULL']
];

const TELEMETRY_INDEXES = [
  ['idx_tr_area_ts', 'area_id, ts'],
  ['idx_tr_point_ts', 'point_id, ts']
];

const buildTelemetryMigrationStatements = (
  existingColumns = new Set(),
  existingIndexes = new Set()
) => {
  const statements = [];

  for (const [name, definition] of TELEMETRY_COLUMNS) {
    if (!existingColumns.has(name)) {
      statements.push(`ALTER TABLE telemetry_raw ADD COLUMN ${name} ${definition}`);
    }
  }

  for (const [name, columns] of TELEMETRY_INDEXES) {
    if (!existingIndexes.has(name)) {
      statements.push(`ALTER TABLE telemetry_raw ADD KEY ${name} (${columns})`);
    }
  }

  return statements;
};

const ensureTelemetrySchema = async (query) => {
  const [columnRows] = await query(`
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'telemetry_raw'
  `);
  const [indexRows] = await query(`
    SELECT DISTINCT INDEX_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'telemetry_raw'
  `);

  const statements = buildTelemetryMigrationStatements(
    new Set(columnRows.map((row) => row.COLUMN_NAME)),
    new Set(indexRows.map((row) => row.INDEX_NAME))
  );

  for (const statement of statements) {
    await query(statement);
  }

  return statements;
};

module.exports = {
  buildTelemetryMigrationStatements,
  ensureTelemetrySchema
};
