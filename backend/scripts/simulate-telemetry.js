/**
 * 模拟温湿度数据上报（走真实 MQTT 链路，ingest 会像对待设备数据一样入库/触发告警）
 *
 * 用法：
 *   node scripts/simulate-telemetry.js                          # 默认 30 条、每 5s 一条、温度 22~29.8℃
 *   node scripts/simulate-telemetry.js --count 0                # 持续上报直到 Ctrl+C
 *   node scripts/simulate-telemetry.js --device pi-01 --zone A3 --interval-ms 2000
 *   node scripts/simulate-telemetry.js --min-temp 22 --max-temp 29.8 --dry-run
 */
const mqtt = require('mqtt');
const config = require('../src/config');

const parseArgs = (argv) => {
  const args = {
    deviceId: 'sim-device-01',
    zoneId: null,            // 不给 zone 时带 GPS，由 ingest 按电子围栏自动落区
    count: 30,               // 0 = 持续上报
    intervalMs: 5000,
    minTemp: 22,
    maxTemp: 29.8,
    minRh: 55,
    maxRh: 75,
    lat: 30.681732,          // 真实设备坐标，落在云端 A1 电子围栏内
    lon: 114.183271,
    dryRun: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => argv[++i];
    if (key === '--device') args.deviceId = next();
    else if (key === '--zone') args.zoneId = next();
    else if (key === '--count') args.count = Number(next());
    else if (key === '--interval-ms') args.intervalMs = Number(next());
    else if (key === '--min-temp') args.minTemp = Number(next());
    else if (key === '--max-temp') args.maxTemp = Number(next());
    else if (key === '--min-rh') args.minRh = Number(next());
    else if (key === '--max-rh') args.maxRh = Number(next());
    else if (key === '--lat') args.lat = Number(next());
    else if (key === '--lon') args.lon = Number(next());
    else if (key === '--dry-run') args.dryRun = true;
    else throw new Error(`未知参数: ${key}`);
  }
  return args;
};

const rand = (min, max) => Math.round((min + Math.random() * (max - min)) * 10) / 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const buildPayload = (args) => {
  const payload = {
    device_id: args.deviceId,
    ts: Math.floor(Date.now() / 1000),
    temp_c: rand(args.minTemp, args.maxTemp),
    rh: rand(args.minRh, args.maxRh),
    gps: { fix: true, lat: args.lat, lon: args.lon, fallback: false }
  };
  if (args.zoneId) payload.zone_id = args.zoneId;
  return payload;
};

const publish = (client, topic, payload) =>
  new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  const topic = args.zoneId
    ? `devices/${args.deviceId}/${args.zoneId}/telemetry`
    : `devices/${args.deviceId}/telemetry`;

  if (args.dryRun) {
    console.log(JSON.stringify({ topic, sample: buildPayload(args) }, null, 2));
    return;
  }

  const client = mqtt.connect(config.mqtt.url, {
    username: config.mqtt.username,
    password: config.mqtt.password,
    clientId: `telemetry-sim-${Date.now()}`
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('连接MQTT Broker超时')), 10000);
    client.once('connect', () => { clearTimeout(timeout); resolve(); });
    client.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });

  console.log(
    `开始模拟上报: topic=${topic} 温度=${args.minTemp}~${args.maxTemp}℃ ` +
    `间隔=${args.intervalMs}ms ${args.count === 0 ? '持续上报(Ctrl+C停止)' : `共${args.count}条`}`
  );

  let sent = 0;
  let stopped = false;
  process.on('SIGINT', () => { stopped = true; });

  while (!stopped && (args.count === 0 || sent < args.count)) {
    const payload = buildPayload(args);
    await publish(client, topic, payload);
    sent += 1;
    console.log(`#${sent} ${payload.temp_c}℃ / ${payload.rh}% @ (${payload.gps.lat}, ${payload.gps.lon})`);
    if (args.intervalMs > 0) await sleep(args.intervalMs);
  }

  await new Promise((resolve) => client.end(false, resolve));
  console.log(`模拟上报结束，共发送 ${sent} 条。`);
};

run().catch((error) => {
  console.error(`模拟上报失败: ${error.message}`);
  process.exitCode = 1;
});
