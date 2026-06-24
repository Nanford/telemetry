const mqtt = require('mqtt');
const config = require('../src/config');
const {
  buildDemoInspectionReadings,
  parseDemoArgs
} = require('../src/demo-inspection-data');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const publish = (client, topic, payload) =>
  new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const run = async () => {
  const args = parseDemoArgs(process.argv.slice(2));
  const readings = buildDemoInspectionReadings({
    deviceId: args.deviceId
  });

  if (args.dryRun) {
    console.log(JSON.stringify(readings, null, 2));
    return;
  }

  const topic = `devices/${args.deviceId}/telemetry`;
  const client = mqtt.connect(config.mqtt.url, {
    username: config.mqtt.username,
    password: config.mqtt.password,
    clientId: `inspection-demo-${Date.now()}`
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('连接MQTT Broker超时')),
      10000
    );
    client.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });
    client.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  console.log(`开始发布测试巡检：device=${args.deviceId}`);
  for (const reading of readings) {
    await publish(client, topic, reading);
    console.log(
      `${reading.point_id}: ${reading.temp_c}℃ / ${reading.rh}% ` +
      `@ (${reading.pose.x}, ${reading.pose.y})`
    );
    if (args.intervalMs > 0) await sleep(args.intervalMs);
  }

  await new Promise((resolve) => client.end(false, resolve));
  console.log('测试巡检发布完成，请打开“巡检批次”查看最新批次和点位气泡。');
};

run().catch((error) => {
  console.error(`测试巡检发布失败: ${error.message}`);
  process.exitCode = 1;
});
