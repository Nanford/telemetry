/**
 * INPUT : MySQL warehouse_iot（zones / zone_geofences / sensors / alert_rules / alerts）、
 *         config.slam.area.area_id（当前活跃巡检区域，默认保留）
 * OUTPUT: 删除历史遗留区域行；默认只预演(dry-run)并打印将要删除的行数
 * POS   : 一次性数据清理工具。阶段1(A-1-2)与 GPS 期(A1~A5/warehouse_1f)的区域残留会污染
 *         前端「库区温湿度曲线」下拉与告警页。跑在事务里，失败整体回滚。
 *
 * 用法：
 *   node scripts/cleanup-legacy-zones.js                     # 预演，只看会删什么
 *   node scripts/cleanup-legacy-zones.js --apply             # 真删 zones + zone_geofences
 *   node scripts/cleanup-legacy-zones.js --with-records --apply   # 连 sensors/规则/告警一起删
 *   node scripts/cleanup-legacy-zones.js --keep A-4-1,A-1-2 # 额外保留指定区域
 *
 * ⚠ telemetry_raw 没有指向 zones 的外键，本脚本**不删任何遥测数据**。旧区域名下的历史
 *   读数会保留在库里，只是前端不再有入口——需要彻底清历史请另行评估，别在这里加。
 */
const { pool, query } = require('../src/db');
const config = require('../src/config');

const parseArgs = (argv) => {
  const args = { apply: false, withRecords: false, keep: [config.slam.area.area_id] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--apply') args.apply = true;
    else if (key === '--with-records') args.withRecords = true;
    else if (key === '--keep') {
      args.keep = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else throw new Error(`未知参数: ${key}`);
  }
  return args;
};

/** 统计一张表里挂在待删区域下的行数，表没有 zone_id 列时返回 null。 */
const countByZones = async (table, zoneIds) => {
  const placeholders = zoneIds.map(() => '?').join(',');
  const [rows] = await query(
    `SELECT COUNT(*) AS n FROM ${table} WHERE zone_id IN (${placeholders})`,
    zoneIds
  );
  return Number(rows[0].n);
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));

  const [allZones] = await query('SELECT zone_id, name FROM zones ORDER BY zone_id');
  const doomed = allZones.filter((zone) => !args.keep.includes(zone.zone_id));

  console.log(`保留区域: ${args.keep.join(', ')}`);
  if (!doomed.length) {
    console.log('没有需要清理的历史区域。');
    return;
  }

  const zoneIds = doomed.map((zone) => zone.zone_id);
  console.log(`待删区域 ${doomed.length} 个:`);
  doomed.forEach((zone) => console.log(`  - ${zone.zone_id}  ${zone.name}`));

  // 逐表点清，让人在按下 --apply 之前看清代价。
  const impact = {
    zone_geofences: await countByZones('zone_geofences', zoneIds),
    sensors: await countByZones('sensors', zoneIds),
    alert_rules: await countByZones('alert_rules', zoneIds),
    alerts: await countByZones('alerts', zoneIds),
    telemetry_raw: await countByZones('telemetry_raw', zoneIds)
  };

  console.log('\n关联数据:');
  console.log(`  zone_geofences  ${impact.zone_geofences} 行  → 必删(外键 fk_geofence_zone 挡着)`);
  console.log(`  sensors         ${impact.sensors} 行  → ${args.withRecords ? '删除' : '保留(会成孤儿)'}`);
  console.log(`  alert_rules     ${impact.alert_rules} 行  → ${args.withRecords ? '删除' : '保留(会成孤儿)'}`);
  console.log(`  alerts          ${impact.alerts} 行  → ${args.withRecords ? '删除' : '保留(会成孤儿)'}`);
  console.log(`  telemetry_raw   ${impact.telemetry_raw} 行  → 一律保留，本脚本不碰遥测数据`);

  if (impact.zone_geofences > 0) {
    console.log(
      '\n⚠ 删掉电子围栏后，ingest 将无法按 GPS 把读数落到这些区域，' +
      '仍在上报 GPS 的设备会写入 zone_id=NULL。'
    );
  }

  if (!args.apply) {
    console.log('\n[预演] 未改动任何数据。确认无误后加 --apply 执行。');
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const placeholders = zoneIds.map(() => '?').join(',');

    // 顺序由外键决定：先摘掉引用方，最后删 zones 本身。
    if (args.withRecords) {
      await connection.query(`DELETE FROM alerts WHERE zone_id IN (${placeholders})`, zoneIds);
      await connection.query(`DELETE FROM alert_rules WHERE zone_id IN (${placeholders})`, zoneIds);
      await connection.query(`DELETE FROM sensors WHERE zone_id IN (${placeholders})`, zoneIds);
    }
    await connection.query(`DELETE FROM zone_geofences WHERE zone_id IN (${placeholders})`, zoneIds);
    const [result] = await connection.query(
      `DELETE FROM zones WHERE zone_id IN (${placeholders})`,
      zoneIds
    );
    await connection.commit();
    console.log(`\n[已执行] 删除 zones ${result.affectedRows} 行，事务已提交。`);
  } catch (error) {
    await connection.rollback();
    throw new Error(`清理失败，已回滚: ${error.message}`);
  } finally {
    connection.release();
  }
};

run()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
