import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../server/agent/plugins/strata-context.mjs';
import { clipMessage, estimateMessage, splitMessages } from '../server/agent/context-budget.mjs';
import { buildProfile, contextPolicyFromEnv, contextPolicyFromFile } from '../server/agent/profile.mjs';

const msg = text => ({ role: 'user', content: [{ type: 'text', text }] });
const collect = async stream => { const out = []; for await (const c of stream) out.push(c); return out; };
function rig(reply, { window = 8192, config = {} } = {}) {
  const calls = [], logs = [], handlers = [];
  const llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: window } }),
    async *stream(options) {
      calls.push(options);
      const result = reply(options, calls.length);
      if (result.throw) throw result.throw;
      yield { type: 'text-delta', text: result.text ?? 'complete summary' };
      yield { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 40, outputTokens: 12, reasoningTokens: 2, secret: 'DO_NOT_LOG' } };
      if (result.kind !== 'missing') yield { type: 'finish', reason: { kind: result.kind ?? 'stop' } };
    },
  };
  apply({ llm, on: (_name, fn) => handlers.push(fn), inject() {}, logger: { info: s => logs.push(s), warn: s => logs.push(s) } }, config);
  const options = { purpose: 'compaction', provider: 'strata-local', model: 'unchanged', sessionId: 'test', maxTokens: 128,
    messages: [msg('x'.repeat(12000)), msg('y'.repeat(12000)), msg('z'.repeat(12000)), msg('summarize')] };
  return { llm, calls, logs, options, event: event => handlers.forEach(fn => fn({ id: 'test' }, event)) };
}

test('a truncated intermediate summary is retried before processing the next piece', async () => {
  const r = rig((_o, n) => n === 1 ? { kind: 'max-tokens', text: 'CUT_MARKER' } : {});
  const before = structuredClone(r.options.messages);
  const chunks = await collect(r.llm.stream(r.options));
  assert.equal(r.calls[1].maxTokens, 256);
  assert.deepEqual(r.calls[1].messages, r.calls[0].messages);
  assert.ok(r.calls.length >= 3);
  assert.ok(r.calls.slice(1).every(c => !JSON.stringify(c.messages).includes('CUT_MARKER')));
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.deepEqual(r.options.messages, before);
});

test('persistent truncation fails without yielding a successful replacement or mutating history', async () => {
  const r = rig(() => ({ kind: 'max-tokens', text: 'CUT' }), { config: { summaryRetries: 1 } });
  const before = structuredClone(r.options);
  const yielded = [];
  await assert.rejects(async () => { for await (const c of r.llm.stream(r.options)) yielded.push(c); }, { code: 'COMPACTION_INCOMPLETE' });
  assert.deepEqual(yielded, []);
  assert.deepEqual(r.options, before);
  assert.ok(r.calls.length <= 4);
});

for (const kind of ['stop', 'missing', 'tool-calls']) test(`empty or invalid summary (${kind}) cannot succeed`, async () => {
  const r = rig(() => ({ kind, text: '  ' }), { window: 0, config: { summaryRetries: 1 } });
  await assert.rejects(collect(r.llm.stream(r.options)), { code: 'COMPACTION_INCOMPLETE' });
});

test('a final truncated piece also fails; abort and transport failures do not retry', async () => {
  const r = rig((_o, n) => ({ kind: n === 1 ? 'stop' : 'max-tokens' }), { config: { summaryRetries: 0 } });
  await assert.rejects(collect(r.llm.stream(r.options)), { code: 'COMPACTION_INCOMPLETE' });
  for (const kind of ['aborted', 'error']) {
    const r = rig(() => ({ kind }));
    assert.equal((await collect(r.llm.stream(r.options))).at(-1).reason.kind, kind);
    assert.equal(r.calls.length, 1);
  }
  const broken = rig(() => ({ throw: new Error('transport') }));
  await assert.rejects(collect(broken.llm.stream(broken.options)), /transport/);
  assert.equal(broken.calls.length, 1);
});

test('lossless mode preserves every character, including middle requirements and surrogate pairs', () => {
  const text = 'a😀'.repeat(4000) + 'ТРЕБОВАНИЕ: /tmp/проект, лимит 7319, команда git status' + 'z'.repeat(15000);
  const original = msg(text);
  const fragments = splitMessages([original], 1024, 2, { preserveOversizedMessages: true }).flat();
  const recovered = fragments.map(m => m.content[0].text.split('\n').slice(1).join('\n')).join('');
  assert.equal(recovered, text);
  assert.ok(fragments.every(m => estimateMessage(m) * 2 <= 1024));
  assert.ok(fragments.every(m => !/[\uD800-\uDBFF]$/.test(m.content[0].text)));
  assert.equal(original.content[0].text, text);
});

test('oversized file/log results retain call provenance and valid, whole JSON arguments', () => {
  for (const name of ['read_file', 'shell']) {
    const call = { role: 'assistant', content: [{ type: 'tool-call', id: 'call-7', name, arguments: '{"path":"/tmp/log"}' }] };
    const result = { role: 'tool', toolCallId: 'call-7', content: [{ type: 'text', text: 'begin\n' + 'line\n'.repeat(3000) + 'MIDDLE_FACT' + 'tail\n'.repeat(3000) }] };
    const all = splitMessages([call, result], 1024, 1, { preserveOversizedMessages: true }).flat();
    assert.ok(all.every(m => m.role === 'user'));
    const quoted = JSON.parse(all[0].content[0].text.split('\n').slice(1).join('\n'));
    assert.deepEqual(quoted, call.content[0]);
    assert.deepEqual(JSON.parse(quoted.arguments), { path: '/tmp/log' });
    assert.ok(all.slice(1).every(m => m.content[0].text.includes('"toolCallId":"call-7"')));
    assert.equal(all.slice(1).map(m => m.content[0].text.split('\n').slice(1).join('\n')).join(''), result.content[0].text);
  }
});

test('oversized atomic arguments fail closed; small exchanges keep their exact representation', () => {
  const call = { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'run', arguments: JSON.stringify({ body: 'x'.repeat(10000) }) }] };
  assert.throws(() => splitMessages([call], 1024, 1, { preserveOversizedMessages: true }), { code: 'COMPACTION_BLOCK_TOO_LARGE' });
  const small = [msg('hello'), msg('world')];
  assert.deepEqual(splitMessages(small, 1024, 1, { preserveOversizedMessages: true }), [small]);
});

test('diagnostics emit numeric timing/usage only and track first response after committed compaction', async () => {
  const r = rig(() => ({ text: 'DO_NOT_LOG' }), { config: { diagnostics: true } });
  await collect(r.llm.stream(r.options));
  r.event({ type: 'compaction/end', data: {} });
  await collect(r.llm.stream({ ...r.options, purpose: 'agent' }));
  await collect(r.llm.stream({ ...r.options, purpose: 'agent' }));
  assert.ok(!r.logs.join('\n').includes('DO_NOT_LOG'));
  const metrics = r.logs.filter(s => s.startsWith('strata-context-metric ')).map(s => JSON.parse(s.slice(22)));
  assert.equal(metrics.filter(m => m.phase === 'first-reply').length, 1);
  const request = metrics.find(m => m.phase === 'summary-request');
  assert.equal(request.cacheReadTokens, 40);
  assert.equal(request.reasoningTokens, 2);
  assert.equal(request.prefillMs, null);
  assert.ok(request.ms >= 0 && request.rssBytes > 0);
  const quiet = rig(() => ({}));
  await collect(quiet.llm.stream(quiet.options));
  assert.equal(quiet.logs.length, 0);
});

test('context experiments are opt-in and configurable through the host profile', () => {
  assert.deepEqual(contextPolicyFromEnv({}), {});
  assert.deepEqual(contextPolicyFromEnv({ STRATA_CONTEXT_LOSSLESS: '1', STRATA_CONTEXT_DIAGNOSTICS: '1', STRATA_CONTEXT_SUMMARY_RETRIES: '1' }), { preserveOversizedMessages: true, diagnostics: true, summaryRetries: 1 });
  assert.deepEqual(contextPolicyFromEnv({ STRATA_CONTEXT_SUMMARY_RETRIES: '-1' }), {});
  assert.match(buildProfile({ contextPolicy: { preserveOversizedMessages: true } }).patch, /"preserveOversizedMessages": true/);
});

// Frozen pre-change algorithm, used only as a compatibility oracle.
function legacySplit(messages, budget, density) {
  const room = Math.max(512, budget);
  const sized = messages.map(m => clipMessage(m, Math.floor(room * 0.8), density));
  const cost = sized.map(m => estimateMessage(m) * density);
  const balanced = i => {
    let open = 0;
    for (let k = 0; k < i; k++) {
      const m = sized[k];
      if (m.role === 'assistant') open += m.content.filter(b => b.type === 'tool-call').length;
      else if (m.role === 'tool') open--;
    }
    return open <= 0;
  };
  const runs = [];
  let start = 0, used = 0;
  for (let i = 0; i < sized.length; i++) {
    if (i > start && used + cost[i] > room) {
      let cut = i;
      while (cut > start + 1 && !balanced(cut)) cut--;
      if (!balanced(cut)) cut = i;
      runs.push(sized.slice(start, cut)); start = cut;
      used = cost.slice(start, i).reduce((n, x) => n + x, 0);
    }
    used += cost[i];
  }
  if (start < sized.length) runs.push(sized.slice(start));
  return runs;
}

test('linear splitter preserves old boundaries and request bodies, including unmatched tools and mutated messages', () => {
  let seed = 7491;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let run = 0; run < 80; run++) {
    const messages = Array.from({ length: 80 }, (_, i) => {
      const r = random();
      if (r < 0.2) return { role: 'assistant', content: [{ type: 'tool-call', id: String(i), name: 'run', arguments: '{}' }] };
      if (r < 0.4) return { role: 'tool', toolCallId: String(i - 1), content: [{ type: 'text', text: 'log'.repeat(Math.floor(random() * 1000)) }] };
      return msg('text'.repeat(Math.floor(random() * 1000)));
    });
    const budget = 512 + Math.floor(random() * 4000), density = 1 + random() * 4;
    assert.deepEqual(splitMessages(messages, budget, density), legacySplit(messages, budget, density));
    messages[0] = msg('changed'.repeat(2000));
    assert.deepEqual(splitMessages(messages, budget, density), legacySplit(messages, budget, density));
  }
});

test('first reply telemetry follows the actual prepareCall/streamWithSnapshot path', async () => {
  const logs = [], handlers = [];
  async function* answer() { yield { type: 'text-delta', text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } }; }
  const adapter = { modelOf: () => ({ contextWindow: 8192, maxTokens: 128 }), streamWithSnapshot: answer };
  const llm = { adapters: new Map([['strata-local', { adapter }]]), prepareCall: async () => ({ stream: options => adapter.streamWithSnapshot(options, {}) }), stream: answer,
    resolveModelInfo: async () => ({ context: { contextWindow: 8192 } }) };
  apply({ llm, on: (_event, fn) => handlers.push(fn), inject() {}, logger: { info: line => logs.push(line) } }, { diagnostics: true });
  const options = { provider: 'strata-local', model: 'same', sessionId: 'same', maxTokens: 128, messages: [msg('data'), msg('summarize')] };
  await collect(llm.stream({ ...options, purpose: 'compaction' }));
  handlers.forEach(fn => fn({ id: 'same' }, { type: 'compaction/end', data: {} }));
  const prepared = await llm.prepareCall(options);
  await collect(prepared.stream(options));
  await collect(prepared.stream(options));
  const replies = logs.filter(s => s.includes('"phase":"first-reply"'));
  assert.equal(replies.length, 1);
  assert.ok(replies[0].includes('"compaction":1'));
});

test('a middle fact reaches the final summary through the sequential carry path', async () => {
  const fact = 'ТРЕБОВАНИЕ_7319';
  const r = rig(options => ({ text: JSON.stringify(options.messages).includes(fact) ? fact : 'no fact yet' }), { config: { preserveOversizedMessages: true } });
  r.options.messages = [msg('start '.repeat(9000) + fact + ' end'.repeat(12000)), msg('summarize')];
  const chunks = await collect(r.llm.stream(r.options));
  assert.ok(r.calls.length > 2);
  assert.ok(chunks.some(c => c.text === fact));
});

test('cancellation before a summary sends no request and preserves input', async () => {
  const r = rig(() => ({}));
  const controller = new AbortController(); controller.abort();
  r.options.signal = controller.signal;
  await assert.rejects(collect(r.llm.stream(r.options)), { name: 'AbortError' });
  assert.equal(r.calls.length, 0);
});


test('zero configured retries makes an incomplete whole request fail after one attempt', async () => {
  const r = rig(() => ({ kind: 'max-tokens' }), { window: 65536, config: { summaryRetries: 0 } });
  await assert.rejects(collect(r.llm.stream(r.options)), { code: 'COMPACTION_INCOMPLETE' });
  assert.equal(r.calls.length, 1);
});


test('persistent desktop policy survives launches, validates fields and permits explicit env overrides', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'context-policy-')), file = join(dir, 'policy.json');
  try {
    assert.deepEqual(contextPolicyFromFile(file, {}), {});
    writeFileSync(file, JSON.stringify({ preserveOversizedMessages: true, diagnostics: true, summaryRetries: 1 }));
    assert.deepEqual(contextPolicyFromFile(file, { STRATA_CONTEXT_DIAGNOSTICS: '0' }), { preserveOversizedMessages: true, diagnostics: false, summaryRetries: 1 });
    const before = buildProfile({ contextPolicy: {} }), after = buildProfile({ contextPolicy: contextPolicyFromFile(file, {}) });
    assert.notEqual(before.toolsSignature, after.toolsSignature, 'idle Harness reloads a changed policy');
    for (const text of ['{', '[]', '{"summaryRetries":99}', '{"diagnostics":"true"}', '{"unknown":true}']) {
      writeFileSync(file, text); assert.throws(() => contextPolicyFromFile(file, {}));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('structured checkpoints explicitly preserve constraints, provenance and superseded facts without mutating history', async () => {
  const r = rig(() => ({}), { config: { structuredSummaries: true } });
  const before = structuredClone(r.options.messages);
  await collect(r.llm.stream(r.options));
  for (const call of r.calls) {
    const instruction = JSON.stringify(call.messages.at(-1));
    assert.match(instruction, /Distinguish direct user instructions/);
    assert.match(instruction, /superseded only when the source says so/);
    assert.match(instruction, /never invent citations/);
  }
  assert.deepEqual(r.options.messages, before);
});
