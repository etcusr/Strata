import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseMacSensors, createMacSensorReader } from '../server/macos-sensors.mjs';

test('macmon readings keep CPU, GPU, and whole-system power distinct', () => {
  assert.deepEqual(parseMacSensors(JSON.stringify({
    temp: { cpu_temp_avg: 49.1, gpu_temp_avg: 45.8 },
    cpu_power: 1.8, gpu_power: 0.6, sys_power: 18.5,
    gpu_active_ratio: 0.5, gpu_freq_mhz: 428,
  })), { cpuTempC: 49.1, gpuTempC: 45.8, cpuPowerW: 1.8,
    gpuPowerW: 0.6, systemPowerW: 18.5, gpuLoad: 50, gpuClockMhz: 428 });
  assert.equal(parseMacSensors('not json'), null);
  assert.equal(parseMacSensors('{"gpu_power":-2}').gpuPowerW, null);
});

test('macmon reader handles split lines, stale samples, and closes when Monitor is hidden', () => {
  let time = 1000, starts = 0, killed = false;
  const process = new EventEmitter();
  process.stdout = new EventEmitter();
  process.kill = () => { killed = true; };
  const reader = createMacSensorReader({ path: '/macmon', now: () => time,
    spawnFn: () => { starts++; return process; } });
  assert.equal(reader.read(), null);
  process.stdout.emit('data', '{"temp":{"cpu_temp_avg":49},');
  assert.equal(reader.read(), null);
  process.stdout.emit('data', '"gpu_power":3}\n');
  assert.equal(reader.read().cpuTempC, 49);
  assert.equal(reader.read().gpuPowerW, 3);
  time += 10001;
  assert.equal(reader.read(), null);
  reader.stop();
  assert.equal(killed, true);
  reader.read();
  assert.equal(starts, 2);
});
