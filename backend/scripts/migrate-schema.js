const { pool, query } = require('../src/db');
const { ensureTelemetrySchema } = require('../src/schema-migrations');

const run = async () => {
  const statements = await ensureTelemetrySchema(query);
  if (statements.length === 0) {
    console.log('telemetry schema: already up to date');
    return;
  }

  console.log(`telemetry schema: applied ${statements.length} change(s)`);
  statements.forEach((statement) => console.log(`- ${statement}`));
};

run()
  .catch((error) => {
    console.error(`telemetry schema migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
