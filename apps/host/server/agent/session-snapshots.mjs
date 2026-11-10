/** Disk checkpoints for long local agent chats. The engine validates the model and prompt identity on restore. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const MIN_SNAPSHOT_TOKENS = 32_768;

export function createSessionSnapshots({ root, localInstances, log = () => {}, fetcher = fetch }) {
  const directory = join(root, 'session-files');
  const indexFile = join(root, 'session-snapshots.json');
  let records = {};
  try { records = JSON.parse(readFileSync(indexFile, 'utf8')).records ?? {}; } catch { /* no checkpoints yet */ }
  const pending = new Map();
  const attempted = new Set();
  const discarded = new Set();
  const instanceFor = route => localInstances().find(i => i.id === route?.instanceId && i.snapshotEnabled && (i.slots ?? 1) === 1 && i.loadedAt);
  const filename = chatId => `${createHash('sha256').update(String(chatId)).digest('hex').slice(0, 32)}.bin`;
  const persist = () => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const temp = `${indexFile}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, records }), { mode: 0o600 });
    renameSync(temp, indexFile);
  };
  const transfer = async (inst, action, file) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetcher(new URL(`/slots/0?action=${action}`, inst.baseUrl), {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(inst.key ? { Authorization: `Bearer ${inst.key}` } : {}) },
        body: JSON.stringify({ filename: file }), signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${response.status}: ${String(body?.error?.message ?? body?.error ?? 'checkpoint refused').slice(0, 160)}`);
      return body;
    } finally { clearTimeout(timer); }
  };
  async function restore(chatId, sessionId, route) {
    await pending.get(chatId)?.catch(() => {});
    const inst = instanceFor(route), row = records[chatId];
    if (!inst || !row || row.sessionId !== sessionId || row.modelId !== inst.modelId || row.loadedAt === inst.loadedAt) return false;
    const attempt = `${chatId}:${inst.loadedAt}`;
    if (attempted.has(attempt)) return false;
    attempted.add(attempt);
    if (row.file !== filename(chatId) || !existsSync(join(directory, row.file))) return false;
    try {
      const result = await transfer(inst, 'restore', row.file);
      if (!(Number(result.n_restored) > 0)) return false;
      row.loadedAt = inst.loadedAt;
      persist();
      log(`agent · restored ${result.n_restored} prompt tokens from a local session file`);
      return true;
    } catch (error) {
      log(`agent · session restore unavailable: ${error.message}`);
      return false; // the engine reads the ordinary prompt; no history is lost
    }
  }
  function save(chatId, sessionId, route, tokens) {
    const inst = instanceFor(route);
    if (!inst || !(tokens >= MIN_SNAPSHOT_TOKENS) || pending.has(chatId)) return null;
    try { mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch { return null; }
    discarded.delete(chatId);
    const file = filename(chatId);
    const job = (async () => {
      try {
        const result = await transfer(inst, 'save', file);
        if (!(Number(result.n_saved) > 0)) return false;
        if (discarded.has(chatId)) { rmSync(join(directory, file), { force: true }); return false; }
        try { chmodSync(join(directory, file), 0o600); } catch { /* engine created the file privately */ }
        records[chatId] = { file, sessionId, modelId: inst.modelId, loadedAt: inst.loadedAt, tokens: result.n_saved };
        persist();
        log(`agent · saved ${result.n_saved} prompt tokens for fast local resume`);
        return true;
      } catch (error) {
        log(`agent · session save unavailable: ${error.message}`);
        return false;
      }
    })();
    pending.set(chatId, job);
    void job.finally(() => { if (pending.get(chatId) === job) pending.delete(chatId); });
    return job;
  }
  function forget(chatId) {
    discarded.add(chatId);
    const row = records[chatId];
    delete records[chatId];
    if (row) {
      try { rmSync(join(directory, filename(chatId)), { force: true }); } catch { /* best effort */ }
      try { persist(); } catch { /* best effort */ }
    }
  }
  async function close() { await Promise.allSettled([...pending.values()]); }
  return { restore, save, forget, close, directory };
}
