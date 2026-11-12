/** Optional Apple Silicon sensors from the user's unprivileged macmon installation. */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const binary = () => ['/opt/homebrew/bin/macmon', '/usr/local/bin/macmon'].find(existsSync) ?? null;
const sane = (value, max) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;

export function parseMacSensors(line) {
  try {
    const data = JSON.parse(line);
    return {
      cpuTempC: sane(data.temp?.cpu_temp_avg, 150),
      gpuTempC: sane(data.temp?.gpu_temp_avg, 150),
      cpuPowerW: sane(data.cpu_power, 1000),
      gpuPowerW: sane(data.gpu_power, 1000),
      systemPowerW: sane(data.sys_power, 2000),
      gpuLoad: sane(data.gpu_active_ratio, 1) === null ? null : data.gpu_active_ratio * 100,
      gpuClockMhz: sane(data.gpu_freq_mhz, 10000),
    };
  } catch { return null; }
}

export function createMacSensorReader({ spawnFn = spawn, path = binary(), now = Date.now } = {}) {
  let child = null, latest = null, sampledAt = 0, retryAt = 0, buffer = '';
  const stop = () => {
    if (child) { const old = child; child = null; old.kill(); }
    latest = null; sampledAt = 0; retryAt = 0; buffer = '';
  };
  return {
    read() {
      if (!path) return null;
      if (!child && now() >= retryAt) {
        retryAt = now() + 60_000;
        try {
          const process = spawnFn(path, ['-i', '2000', 'pipe'], { stdio: ['ignore', 'pipe', 'ignore'] });
          child = process;
          process.stdout.on('data', chunk => {
            if (child !== process) return;
            buffer += String(chunk);
            if (buffer.length > 131072) { buffer = ''; return; }
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) {
              const parsed = parseMacSensors(buffer.slice(0, end));
              buffer = buffer.slice(end + 1);
              if (parsed) { latest = parsed; sampledAt = now(); }
            }
          });
          process.on('error', () => { if (child === process) { child = null; latest = null; } });
          process.on('exit', () => { if (child === process) { child = null; latest = null; } });
        } catch { child = null; }
      }
      return latest && now() - sampledAt < 10_000 ? latest : null;
    },
    stop,
  };
}

const reader = process.platform === 'darwin' ? createMacSensorReader() : null;
export const readMacSensors = () => reader?.read() ?? null;
export const stopMacSensors = () => reader?.stop();
