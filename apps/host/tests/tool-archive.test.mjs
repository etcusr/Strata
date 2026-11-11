import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolArchive, previewArchived, pruneArchivedResults, archiveSummaryAnchor } from '../server/agent/tool-archive.mjs';
import { apply as archivePlugin } from '../server/agent/plugins/strata-tool-archive.mjs';
import { apply as contextPlugin } from '../server/agent/plugins/strata-context.mjs';
import { buildProfile, localContextBudgets, contextPolicyFromFile } from '../server/agent/profile.mjs';
import { shouldCompactStoppedTurn } from '../server/agent/stopped-compaction.mjs';
import { startScriptedWorker } from './helpers/scripted-worker.mjs';
import { createAgentBridge } from '../server/agent/agent-bridge.mjs';
const text = value => [{ type: 'text', text: value }];
function temp(t) { const dir = mkdtempSync(join(tmpdir(), 'strata-archive-')); t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 })); return dir; }

test('full content survives previewing, restart and session isolation; permissions are private', t => {
  const root = join(temp(t), 'archive'), archive = new ToolArchive(root);
  const full = text('HEAD\n' + 'x😀'.repeat(6000) + '\nТРЕБОВАНИЕ: port 7319; path /tmp/важное\n' + 'tail'.repeat(6000));
  full.push({ type: 'image', url: 'data:image/png;base64,example' });
  const receipt = archive.save('session/../one', 'call-7', 'read', full);
  assert.deepEqual(JSON.parse(readFileSync(receipt.jsonPath, 'utf8')).content, full);
  assert.equal(readFileSync(receipt.textPath, 'utf8'), full[0].text);
  assert.equal(statSync(receipt.jsonPath).mode & 0o777, 0o600);
  assert.equal(statSync(archive.directory('session/../one')).mode & 0o777, 0o700);
  const preview = previewArchived(full, receipt, 6000);
  assert.ok(preview[0].text.length <= 6000);
  assert.ok(preview[0].text.isWellFormed());
  assert.match(preview[0].text, /ТРЕБОВАНИЕ: port 7319/);
  assert.deepEqual(preview[1], full[1]);
  assert.deepEqual(new ToolArchive(root).receipt('session/../one', 'call-7'), receipt);
  assert.equal(archive.receipt('another', 'call-7'), null);
  assert.deepEqual(archive.save('session/../one', 'call-7', 'read', full), receipt);
  writeFileSync(receipt.textPath, 'corrupt');
  assert.equal(archive.receipt('session/../one', 'call-7'), null);
});

test('a tiny preview budget never duplicates the full tail or splits Unicode', t => {
  const a = new ToolArchive(temp(t)), c = text('😀'.repeat(10000)), r = a.save('s', 'c', 'read', c);
  for (const n of [1, 1000, 2048, 6000]) { const p = previewArchived(c, r, n)[0].text; assert.ok(p.length < 6500); assert.ok(p.isWellFormed()); }
});

function fakeSession(archive, count = 14) {
  const events = new Map(), session = { id: 's', surface: { nodes: [] }, eventAt: seq => events.get(seq), deriveEventMessage: e => e.data.message, append(type, data, options) {
    const seq = events.size + 1, event = { seq, type, data }; events.set(seq, event);
    if (options?.surfaceOp) this.surface.nodes[this.surface.nodes.indexOf(options.surfaceOp.startSeq)] = seq;
    return event;
  } };
  for (let i = 0; i < count; i++) {
    const content = text('x'.repeat(6000) + `\nFACT-${i}`), callId = `c${i}`;
    archive.save('s', callId, 'read', content);
    const event = session.append('tool/result', { message: { role: 'tool', source: { callId }, content, isError: i === 1 } }); session.surface.nodes.push(event.seq);
  }
  return session;
}
const meter = { estimateMessage: m => Math.ceil(JSON.stringify(m).length / 4) };
test('pressure batch keeps recent results/errors and only commits when substantial savings exist', t => {
  const archive = new ToolArchive(temp(t)), session = fakeSession(archive);
  const before = [...session.surface.nodes];
  assert.equal(pruneArchivedResults(session, meter, archive, { minPruneTokens: 999999 }).pruned.length, 0);
  assert.deepEqual(session.surface.nodes, before);
  const result = pruneArchivedResults(session, meter, archive);
  assert.equal(result.pruned.length, 5);
  assert.deepEqual(session.surface.nodes.slice(-8), before.slice(-8));
  assert.equal(session.surface.nodes[1], before[1]);
  for (const item of result.pruned) assert.ok(readFileSync(archive.receipt('s', item.callId).textPath, 'utf8').includes('FACT-'));
  assert.equal(pruneArchivedResults(session, meter, archive).pruned.length, 0);
});

test('missing or corrupted archives cannot justify removing inline evidence', t => {
  const archive = new ToolArchive(temp(t)), session = fakeSession(archive, 3);
  for (const id of ['c0', 'c2']) rmSync(archive.receipt('s', id).jsonPath);
  assert.equal(pruneArchivedResults(session, meter, archive, { keepRecent: 0, minPruneTokens: 1 }).pruned.length, 0);
});

test('archive failure preserves inline text; downstream blocks and edits retain authority', async t => {
  const dir = temp(t), root = join(dir, 'blocked'); writeFileSync(root, 'not a directory');
  let post;
  const ctx = { on(name, fn) { if (name === 'tools/post-execute') post = fn; }, toolResultPruner: { pruneSession() {} }, tokenMeter: meter };
  archivePlugin(ctx, { root });
  const result = { content: text('FACT'.repeat(10000)), isError: false }, exec = { agent: { session: { id: 's' } }, callId: 'c', name: 'read', arguments: {} };
  assert.deepEqual(await post(exec, result, async () => ({ kind: 'accept' })), { kind: 'accept' });
  assert.equal(result.content[0].text.length, 40000);
  assert.deepEqual(await post(exec, result, async () => ({ kind: 'block', feedback: 'policy' })), { kind: 'block', feedback: 'policy' });
  assert.deepEqual(await post(exec, result, async () => ({ kind: 'accept', content: text('redacted') })), { kind: 'accept', content: text('redacted') });
});

test('a reused call id cannot prune a different result using an older receipt', t => {
  const archive = new ToolArchive(temp(t)), session = fakeSession(archive, 3);
  const event = session.eventAt(session.surface.nodes[0]);
  event.data.message.content = text('NEW_FACT'.repeat(2000));
  assert.throws(() => archive.save('s', 'c0', 'read', event.data.message.content));
  const result = pruneArchivedResults(session, meter, archive, { keepRecent: 0, minPruneTokens: 1 });
  assert.ok(!result.pruned.some(p => p.callId === 'c0'));
  assert.ok(event.data.message.content[0].text.includes('NEW_FACT'));
});

test('an accepted redaction is what is archived, not the raw pre-policy value', async t => {
  const root = temp(t); let post;
  archivePlugin({ on(n, f) { if (n === 'tools/post-execute') post = f; }, toolResultPruner: { pruneSession() {} }, tokenMeter: meter }, { root });
  await post({ agent: { session: { id: 's' } }, callId: 'c', name: 'read' }, { content: text('private raw value') }, async () => ({ kind: 'accept', content: text('redacted') }));
  const receipt = new ToolArchive(root).receipt('s', 'c');
  assert.equal(readFileSync(receipt.textPath, 'utf8'), 'redacted');
});

test('symlink archives are rejected without writing through them', t => {
  const dir = temp(t), root = join(dir, 'link'), destination = join(dir, 'elsewhere'); mkdirSync(destination); symlinkSync(destination, root);
  assert.throws(() => new ToolArchive(root).save('s', 'c', 'read', text('secret')));
  assert.deepEqual(readdirSync(destination), []);
});

test('archive locator is deterministic through ten summaries even when the model omits it', async t => {
  const root = temp(t), archive = new ToolArchive(root), r = archive.save('s', 'c', 'read', text('MIDDLE_FACT_7319'));
  const llm = { resolveModelInfo: async () => ({ context: { contextWindow: 8192 } }), async *stream() { yield { type: 'text-delta', text: 'Task summary without any paths' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  contextPlugin({ llm, on() {}, inject() {} }, { archiveToolResults: true, archiveRoot: root });
  let summary = 'initial history';
  for (let i = 0; i < 10; i++) {
    const chunks = []; for await (const chunk of llm.stream({ purpose: 'compaction', sessionId: 's', maxTokens: 512, messages: [{ role: 'user', content: text(summary) }] })) chunks.push(chunk);
    summary = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
    assert.ok(summary.includes(archive.directory('s')));
    assert.equal(summary.match(/Tool archive retained/g).length, 1);
    assert.equal(readFileSync(r.textPath, 'utf8'), 'MIDDLE_FACT_7319');
  }
  assert.equal(archiveSummaryAnchor(root, 'missing'), '');
});

test('guard stops need actual pressure; budget controls remain independent and clamped', t => {
  for (const tokens of [undefined, NaN, 0, 4000]) assert.equal(shouldCompactStoppedTurn({ tokens, threshold: 9000 }), false);
  assert.equal(shouldCompactStoppedTurn({ tokens: 9000, threshold: 9000 }), true);
  const old = localContextBudgets(131072), tuned = localContextBudgets(131072, { replyReserveTokens: 8192, thresholdRatio: 0.85, summaryTokens: 4096, retainTokens: 12000 });
  assert.equal(old.threshold, 98304); assert.equal(tuned.threshold, 111411); assert.equal(tuned.summary, 4096); assert.equal(tuned.retainTokens, 12000);
  const file = join(temp(t), 'policy.json'); writeFileSync(file, JSON.stringify({ archiveToolResults: true, skipLowPressureCompaction: true, archiveKeepRecent: 8, summaryTokens: 4096 }));
  assert.equal(contextPolicyFromFile(file, {}).archiveToolResults, true);
  writeFileSync(file, '{"archiveKeepRecent":0}'); assert.throws(() => contextPolicyFromFile(file, {}), /Invalid/);
  const base = buildProfile({ local: [{ id: 'i', modelId: 'm', context: 131072, baseUrl: 'http://localhost' }] });
  assert.ok(!base.patch.includes('strata-tool-archive'));
  const profile = buildProfile({ local: [{ id: 'i', modelId: 'm', context: 131072, baseUrl: 'http://localhost' }], proxyBase: 'http://localhost/shape', contextPolicy: { thresholdRatio: 0.85, replyReserveTokens: 8192, summaryTokens: 4096, retainTokens: 12000 } });
  const rows = JSON.parse(profile.patch.split('\n').slice(1).join('\n'));
  const policies = rows.find(r => r.id === 'preset-standard').config.plugins.find(r => r.id === 'compaction').config.find(r => r.id === 'compaction-basic').config.modelPolicies;
  assert.ok(policies.length > 1);
  assert.ok(policies.every(p => p.thresholdRatio === 0.85 && p.maxTokens === 4096 && p.retainTokens === 12000));
});

const HARNESS = process.env.STRATA_HARNESS_DIR;
for (const onDemand of [false, true]) test(`real Harness archives and retrieves tool results (onDemand=${onDemand})`, { skip: !HARNESS }, async t => {
  const dir = temp(t), ws = join(dir, 'ws'); mkdirSync(ws); mkdirSync(join(dir, 'agent'));
  writeFileSync(join(dir, 'agent', 'context-policy.json'), JSON.stringify({ archiveToolResults: true, skipLowPressureCompaction: true }));
  const fixture = join(ws, 'evidence.txt'); writeFileSync(fixture, 'start\n' + ('a'.repeat(99) + '\n').repeat(60) + '\nMIDDLE_FACT_7319\n' + ('z'.repeat(99) + '\n').repeat(60) + '\nend');
  const worker = await startScriptedWorker({ window: 65536 });
  const logs = [];
  const bridge = createAgentBridge({ log: s => logs.push(s), tools: () => ({ off: new Set(), search: { provider: 'builtin', key: '' }, servers: {}, onDemand }), dataDir: dir, localInstances: () => [{ id: 'i', baseUrl: worker.url, modelId: 'scripted-model', context: 65536, slots: 2 }], connections: () => [], env: process.env, startTimeoutMs: 90000 });
  t.after(async () => { await bridge.close(); await worker.close(); });
  const send = async message => { const frames = []; await bridge.runTurn({ chatId: 'archive', message, workspacePath: ws, mode: 'bypass', onFrame: f => frames.push(f) }); assert.ok(!frames.some(f => f.type === 'error'), JSON.stringify(frames)); };
  const call = (name, args) => onDemand ? `SCRIPT:call tool_dispatch ${JSON.stringify({ name, arguments: args })}` : `SCRIPT:call ${name} ${JSON.stringify(args)}`;
  await send(call('read', { file_path: fixture }));
  const root = join(dir, 'agent', 'tool-results');
  const owners = readdirSync(root).filter(n => /^[a-f0-9]{64}$/.test(n)); assert.equal(owners.length, 1);
  const receipts = readdirSync(join(root, owners[0])).filter(n => n.startsWith('call-'));
  assert.equal(receipts.length, onDemand ? 2 : 1);
  const receipt = receipts.map(n => JSON.parse(readFileSync(join(root, owners[0], n), 'utf8'))).find(r => r.tool === 'read');
  assert.match(readFileSync(receipt.textPath, 'utf8'), /MIDDLE_FACT_7319/);
  const requests = JSON.stringify(worker.requests); assert.ok(requests.includes('Full tool result archived'), 'tool preview contains its archive locator');
  const toolMessages = worker.requests.flatMap(q => JSON.parse(q.raw).messages).filter(m => m.role === 'tool');
  assert.ok(toolMessages.some(m => String(m.content).length <= 6000 && String(m.content).includes('archived')));
  if (!onDemand) await bridge.close(); // Resume the same persisted session in a fresh Harness process.
  await send(call('grep', { pattern: 'MIDDLE_FACT_7319', path: receipt.textPath }));
  const lastResult = JSON.parse(worker.requests.at(-1).raw).messages.filter(m => m.role === 'tool').at(-1);
  assert.ok(String(lastResult.content).includes('MIDDLE_FACT_7319'));
  assert.ok(!String(lastResult.content).includes('Error'));
  assert.deepEqual(worker.requests.at(-1).toolNames, worker.requests[0].toolNames, 'archive retrieval keeps the offered tool schemas stable');
  await send(call('read', { file_path: receipt.textPath, offset: 1, limit: 200 }));
  const retrieved = JSON.parse(worker.requests.at(-1).raw).messages.filter(m => m.role === 'tool').at(-1);
  assert.ok(String(retrieved.content).length > 6000, 'an explicit archive read is not recursively previewed, including through tool_dispatch');
  assert.ok(String(retrieved.content).includes('MIDDLE_FACT_7319'));
  assert.ok(!/could not preserve|failed to activate/i.test(logs.join('\n')), logs.slice(-10).join('\n'));
});

test('real Harness clears archived old observations under pressure without an LLM summary', { skip: !HARNESS }, async t => {
  const dir = temp(t), ws = join(dir, 'ws'); mkdirSync(ws); mkdirSync(join(dir, 'agent'));
  writeFileSync(join(dir, 'agent', 'context-policy.json'), JSON.stringify({ archiveToolResults: true, archiveKeepRecent: 4, archiveMinPruneTokens: 512, thresholdRatio: 0.5, skipLowPressureCompaction: true }));
  const file = join(ws, 'result.txt'); writeFileSync(file, ('line with evidence ' + 'x'.repeat(80) + '\n').repeat(120) + 'MIDDLE_FACT_7319');
  const worker = await startScriptedWorker({ window: 32768, charsPerToken: 4 });
  const bridge = createAgentBridge({ dataDir: dir, localInstances: () => [{ id: 'i', baseUrl: worker.url, modelId: 'scripted-model', context: 32768, slots: 2 }], connections: () => [], env: process.env });
  t.after(async () => { await bridge.close(); await worker.close(); });
  const frames = [];
  await bridge.runTurn({ chatId: 'batch', message: 'SCRIPT:multi ' + JSON.stringify({ calls: Array.from({ length: 14 }, () => ['read', { file_path: file }]), say: 'batch done' }), workspacePath: ws, mode: 'bypass', onFrame: f => frames.push(f) });
  assert.ok(!frames.some(f => f.type === 'error'));
  const results = JSON.parse(worker.requests.at(-1).raw).messages.filter(m => m.role === 'tool');
  assert.equal(results.length, 14, 'all tool-call/result pairs remain valid');
  assert.ok(results.some(m => String(m.content).includes('Full tool result archived') && String(m.content).length < 1500), 'old observations became verified retrieval pointers: ' + JSON.stringify({ lengths: results.map(m => String(m.content).length), requests: worker.requests.map(q => ({ chars: q.promptChars, summary: q.summary })) }));
  assert.ok(results.slice(-4).every(m => String(m.content).length > 1500), 'recent observations remain inline');
  assert.equal(worker.requests.filter(q => q.summary).length, 0, 'batch clearing avoided an LLM summary');
  const root = join(dir, 'agent', 'tool-results');
  const owner = readdirSync(root).find(n => /^[a-f0-9]{64}$/.test(n));
  const receipts = readdirSync(join(root, owner)).filter(n => n.startsWith('call-'));
  assert.equal(receipts.length, 14);
  for (const name of receipts) { const receipt = JSON.parse(readFileSync(join(root, owner, name), 'utf8')); assert.match(readFileSync(receipt.textPath, 'utf8'), /MIDDLE_FACT_7319/); }
});
