import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionSnapshots, MIN_SNAPSHOT_TOKENS } from '../server/agent/session-snapshots.mjs';

test('a long chat restores its saved engine state after a model reload', async t => {
  const root = mkdtempSync(join(tmpdir(), 'strata-session-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let loadedAt = 'first-load';
  const localInstances = () => [{ id: 'local', loadedAt, snapshotEnabled: true, slots: 1, modelId: 'qwen', baseUrl: 'http://127.0.0.1:18500/v1', key: 'test-key' }];
  const fetcher = async (url, options) => {
    const action = new URL(url).searchParams.get('action');
    const file = JSON.parse(options.body).filename;
    calls.push({ action, file, authorization: options.headers.Authorization });
    if (action === 'save') {
      mkdirSync(join(root, 'session-files'), { recursive: true });
      writeFileSync(join(root, 'session-files', file), 'checkpoint');
    }
    return { ok: true, json: async () => action === 'save' ? { n_saved: 96_000 } : { n_restored: 96_000 } };
  };
  const route = { instanceId: 'local' };
  const before = createSessionSnapshots({ root, localInstances, fetcher });
  assert.equal(before.save('chat', 'session', route, MIN_SNAPSHOT_TOKENS - 1), null);
  assert.equal(await before.save('chat', 'session', route, 105_000), true);
  await before.close();
  assert.deepEqual(calls.map(c => c.action), ['save']);
  assert.equal(calls[0].authorization, 'Bearer test-key');
  loadedAt = 'second-load';
  const after = createSessionSnapshots({ root, localInstances, fetcher });
  assert.equal(await after.restore('chat', 'wrong-session', route), false);
  assert.equal(await after.restore('chat', 'session', route), true);
  assert.equal(await after.restore('chat', 'session', route), false, 'the same engine load is restored only once');
  assert.deepEqual(calls.map(c => c.action), ['save', 'restore']);
  assert.equal(JSON.parse(readFileSync(join(root, 'session-snapshots.json'), 'utf8')).records.chat.loadedAt, loadedAt);
});

test('a refused restore falls back without changing the saved chat', async t => {
  const root = mkdtempSync(join(tmpdir(), 'strata-session-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let loadedAt = 'first-load', restores = 0;
  const localInstances = () => [{ id: 'local', loadedAt, snapshotEnabled: true, slots: 1, modelId: 'qwen', baseUrl: 'http://127.0.0.1:18500/v1' }];
  const fetcher = async (url, options) => {
    const file = JSON.parse(options.body).filename;
    if (new URL(url).searchParams.get('action') === 'save') {
      mkdirSync(join(root, 'session-files'), { recursive: true });
      writeFileSync(join(root, 'session-files', file), 'checkpoint');
      return { ok: true, json: async () => ({ n_saved: 50_000 }) };
    }
    restores++;
    return { ok: false, status: 503, json: async () => ({ error: { message: 'not enough free RAM' } }) };
  };
  const route = { instanceId: 'local' };
  const snapshots = createSessionSnapshots({ root, localInstances, fetcher });
  await snapshots.save('chat', 'session', route, 50_000);
  loadedAt = 'second-load';
  assert.equal(await snapshots.restore('chat', 'session', route), false);
  assert.equal(await snapshots.restore('chat', 'session', route), false);
  assert.equal(restores, 1, 'a failed restore does not delay every later turn');
});
