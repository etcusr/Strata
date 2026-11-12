/**
 * The agent's tools in the app: the inventory, a tool from each family, and Manual mode's one approval card.
 *
 * Pure tests (the gate's rules, the preset list, the profile) always run. The rest need a built Harness
 * (STRATA_HARNESS_DIR) and skip loudly without it. The model is scripted (tests/helpers/scripted-worker.mjs): what is real is
 * the Harness, its tool executor, its sandbox, its approval service, the Strata gate plugin and the bridge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startScriptedWorker } from './helpers/scripted-worker.mjs';
import { createAgentBridge } from '../server/agent/agent-bridge.mjs';
import { agentExecutablePath, resolveHarness } from '../server/agent/harness-runtime.mjs';
import { buildProfile, GATE_PLUGIN } from '../server/agent/profile.mjs';
import { STANDARD_PLUGIN_IDS, REMOVED_PLUGIN_IDS, standardPreset } from '../server/agent/preset.mjs';
import { isReadOnlyShell, manualDecision, maskQuotes, READ_ONLY_TOOLS } from '../server/agent/plugins/strata-gate.mjs';
import { plainToolError, withPlain } from '../server/agent/events.mjs';
import { apply as applyOnDemand, category, compactJsonBody, visibleTools } from '../server/agent/plugins/strata-on-demand-tools.mjs';
import { GROUP_IDS } from '../server/agent/tools-catalog.mjs';

const HARNESS = process.env.STRATA_HARNESS_DIR;
const skip = !HARNESS || !resolveHarness({ env: process.env }).ok ? 'STRATA_HARNESS_DIR is not set to a built Harness' : false;
const cleanup = dir => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the Harness sandbox leaves access entries; best effort */ } };
const fwd = p => p.replaceAll('\\', '/');
const shellTool = process.platform === 'win32' ? 'pwsh' : 'bash';
const compactNames = [shellTool, 'job_list', 'tool_catalog', 'tool_dispatch'].sort();

test('a Finder launch still makes the bundled ripgrep available to the agent shell', () => {
  const bundled = '/bundle/node_modules/@vscode/ripgrep-darwin-arm64/bin';
  const path = agentExecutablePath('/usr/bin:/bin', '/bundle', { platform: 'darwin', arch: 'arm64',
    exists: file => file === `${bundled}/rg` });
  assert.equal(path, `${bundled}:/usr/bin:/bin`);
  assert.equal(agentExecutablePath(path, '/bundle', { platform: 'darwin', arch: 'arm64', exists: file => file === `${bundled}/rg` }), path);
  assert.equal(agentExecutablePath('/usr/bin:/bin', '/bundle', { platform: 'linux' }), '/usr/bin:/bin');
});

// ---------------------------------------------------------------------------------------------------------- pure

test('the gate: only commands that provably just look are allowed without a question', () => {
  for (const ok of ['Get-ChildItem', 'Get-ChildItem -Recurse src | Select-Object -First 5', 'git status', 'git log --oneline -5', 'git diff', 'cat notes.txt', 'ls -la', 'node --version', 'Get-Content a.txt | Select-String needle', 'git branch', 'git remote -v']) {
    assert.equal(isReadOnlyShell(ok), true, ok);
  }
  for (const bad of ['', 'Set-Content a.txt x', 'echo hi > a.txt', 'Get-ChildItem; Remove-Item a.txt', 'rm -rf x', 'git commit -m x', 'git push', 'git branch -D x', 'git config user.name x', 'git remote add o u', 'curl http://x', 'Get-ChildItem | ForEach-Object { $_ }', 'Start-Process explorer.exe', 'explorer.exe C:/Users/x/Downloads', 'ii ~/Downloads', 'Invoke-Item $env:USERPROFILE/Downloads', 'start .', 'open .', 'xdg-open .', 'notepad a.txt', 'powershell -Command x', 'node script.js', 'python x.py', 'ls && rm a', 'find . -delete', 'echo $(whoami)', 'Invoke-WebRequest u', 'Start-Process x', 'New-Item a', 'cat a | tee b']) {
    assert.equal(isReadOnlyShell(bad), false, bad);
  }
  assert.equal(isReadOnlyShell('x'.repeat(700)), false, 'a long command is never trusted');
});

test('the gate: quoted text is data, so an & ( ) ; { } in a quoted path does not make a look-only command ask (2026-10-22)', () => {
  for (const ok of [
    'Get-ChildItem "C:\\Users\\AI-Server\\Downloads\\GUI Q&A" | Select-Object -First 5 Name',
    'Get-Content "C:\\Users\\AI-Server\\Downloads\\GUI Q&A\\a.txt"',
    "Get-ChildItem 'C:\\Users\\x\\Notes (old) {draft}; v2'",
    'Select-String -Path a.txt "a|b"',
    'Select-String needle "C:\\x\\a & b.txt" | Measure-Object',
    'git log --oneline "docs/Q&A.md"',
    'cat "my file (1).txt"',
    "Get-ChildItem 'it''s here'",
  ]) assert.equal(isReadOnlyShell(ok), true, ok);
  // Quoting does not hide anything that acts: outside the quotes the same characters still ask, and inside double quotes an expansion does.
  for (const bad of [
    'Get-ChildItem C:\\Q&A',
    'Get-ChildItem "C:\\a" ; Remove-Item x',
    'Get-ChildItem "C:\\a" & calc',
    'Get-ChildItem "C:\\a" > out.txt',
    'Get-ChildItem "$env:USERPROFILE"',
    'Get-ChildItem "$(whoami)"',
    'Get-ChildItem "a`b"',
    "Get-ChildItem 'unterminated",
    'Get-ChildItem "unterminated',
    'git diff "--output=out.txt"',
    'git diff --out"put"=out.txt',
    'git diff --"output"=out.txt',
    'Get-Content "a"b',
    '"Remove-Item" x',
    'Set-Content "a.txt" "x"',
    'Get-ChildItem "a" | Remove-Item',
    'curl "http://x"',
  ]) assert.equal(isReadOnlyShell(bad), false, bad);
  assert.equal(maskQuotes('Get-ChildItem "C:\\Q&A" | Select-Object Name'), 'Get-ChildItem "_" | Select-Object Name');
  assert.equal(maskQuotes("echo 'a' \"b\""), 'echo "_" "_"');
  assert.equal(maskQuotes('echo "$HOME"'), null);
});

test('the gate: every tool outside the read-only list asks, including unknown and connected ones', () => {
  for (const name of READ_ONLY_TOOLS) assert.equal(manualDecision({ name, arguments: {} }), null, name);
  for (const name of ['write', 'edit', 'job_kill', 'mcp__github__create_issue', 'something_new']) assert.equal(manualDecision({ name, arguments: {} })?.kind, 'ask', name);
  assert.equal(manualDecision({ name: 'pwsh', arguments: { command: 'Get-ChildItem' } }), null);
  assert.match(manualDecision({ name: 'pwsh', arguments: { command: 'Remove-Item x', description: 'Delete x' } }).reason, /Delete x/);
  assert.match(manualDecision({ name: 'write', arguments: { file_path: 'C:/a/b.txt' } }).reason, /b\.txt/);
  assert.equal(manualDecision({ name: 'pwsh', arguments: {} }).kind, 'ask', 'no command is not a read-only command');
});

test('the preset: our list is the Harness standard list minus exactly what the app replaces', () => {
  const ids = standardPreset({ platform: 'win32' }).plugins.map(p => p.id);
  assert.deepEqual(ids, STANDARD_PLUGIN_IDS.filter(id => !REMOVED_PLUGIN_IDS.includes(id) && id !== 'tool-bash'));
  assert.ok(standardPreset({ platform: 'linux' }).plugins.some(p => p.id === 'tool-bash') && !standardPreset({ platform: 'linux' }).plugins.some(p => p.id === 'tool-pwsh'));
  const web = standardPreset().plugins.find(p => p.id === 'tool-web').config;
  assert.equal(web.fetch, true); assert.equal(web.search, false, 'the preset alone leaves search to the profile, which switches it on (DuckDuckGo needs no key)');
  assert.equal(web.fetchMaxOutputChars, 8000, 'a fetched page cannot consume most of the next model request');
  assert.equal(standardPreset({ search: true }).plugins.find(p => p.id === 'tool-web').config.search, true);
  const jobs = standardPreset().plugins.find(p => p.id === 'tool-jobs').config;
  assert.ok(jobs.waitTimeoutMs <= jobs.maxWaitTimeoutMs && jobs.maxWaitTimeoutMs <= 15_000,
    'a background job read must release the agent promptly for added task messages');
  assert.ok(!ids.includes('tool-schedule'), 'Tasks is the only scheduler');
});

test('a long job_output request releases the agent within the configured wait cap', { skip: skip || process.platform === 'win32' }, async t => {
  const r = await rig(t);
  const started = await r.call('job-wait-cap', 'bash', {
    description: 'Start a delayed background command', command: 'sleep 40', run_in_background: true,
  }, { mode: 'bypass' });
  const id = /started background job (bash-[a-z0-9]+)/i.exec(last(started)?.result ?? '')?.[1];
  assert.ok(id, 'the background command returned a job id');
  try {
    const at = Date.now();
    const read = await r.call('job-wait-cap', 'job_output', { job_id: id, wait: true, timeout_ms: 600_000 }, { mode: 'bypass' });
    assert.ok(Date.now() - at < 22_000, 'the 10-minute request returned within the 15-second cap');
    assert.match(last(read)?.result ?? '', /status: running/i, 'the job keeps running after the read');
  } finally {
    await r.call('job-wait-cap', 'job_kill', { job_id: id }, { mode: 'bypass' });
  }
});

test('on-demand categories separate browser backends and hide unrequested schemas', () => {
  assert.equal(category('mcp__browser__navigate'), 'browser');
  assert.equal(category('mcp__custom-chrome-devtools__list_pages'), 'devtools');
  assert.equal(category('mcp__github__create_issue'), 'connected');
  assert.deepEqual(visibleTools('unopened', [{ name: 'tool_catalog' }, { name: 'tool_dispatch' }, { name: 'bash' }, { name: 'web_search' }, { name: 'job_list' }]).map(t => t.name), ['tool_catalog', 'tool_dispatch', 'bash', 'job_list']);
});

test('large JSON web results are condensed before the model sees them', async () => {
  const raw = JSON.stringify({ current_condition: [{ temp_C: '5', weatherDesc: 'Overcast' }], weather: Array.from({ length: 20 }, (_, i) => ({ date: `day-${i}`, hourly: Array.from({ length: 8 }, () => ({ detail: 'x'.repeat(500) })) })) });
  assert.ok(raw.length > 40000);
  const agent = { session: { id: 'test' } };
  const fetch = { execute: async () => ({ url: 'https://example.test/weather', statusCode: 200, body: { kind: 'text', content: raw }, truncated: false }) };
  const ctx = { get: () => ({ list: () => [agent] }), tools: { get: () => fetch, register: () => {} }, on: () => {}, llm: {} };
  applyOnDemand(ctx);
  const result = await fetch.execute({ url: 'https://example.test/weather' }, { agent });
  assert.ok(result.body.content.length <= 7800);
  assert.equal(result.truncated, false);
  assert.match(result.body.content, /"temp_C":"5"/);
  assert.match(result.body.content, /Structured JSON condensed/);
  assert.equal(compactJsonBody('plain text'.repeat(1000)), 'plain text'.repeat(1000), 'ordinary pages keep the web tool’s normal cap');
});

test('a profile with every tool disabled does not mention an unavailable catalog', () => {
  const tools = { onDemand: true, off: new Set(GROUP_IDS), search: { provider: 'builtin', key: '' } };
  const profile = buildProfile({ local: [{ id: 'a', baseUrl: 'http://127.0.0.1:1/v1', modelId: 'm' }], tools });
  assert.ok(!profile.patch.includes('strata-on-demand-tools.mjs'));
  assert.ok(!profile.patch.includes('Call tool_catalog'));
});

test('the profile loads the gate by path, sizes helper agents to the engine slots and keeps no secret', () => {
  const p = buildProfile({ local: [{ id: 'a', baseUrl: 'http://127.0.0.1:1/v1', modelId: 'm', context: 32768, slots: 2, key: 'sekret-key-123' }] });
  const entries = JSON.parse(p.patch.split('\n').slice(1).join('\n'));
  assert.deepEqual(entries.find(e => e.insert)?.insert, [{ id: 'strata-gate', name: GATE_PLUGIN, config: { web: { provider: 'DuckDuckGo, or Bing when DuckDuckGo is busy', skipAsk: false } } }]);
  assert.ok(existsSync(GATE_PLUGIN));
  assert.equal(entries.find(e => e.id === 'subagent').config.maxActiveSubagents, 4, 'at least the 4 helpers; more only with more slots');
  assert.equal(entries.find(e => e.id === 'preset-standard').config.plugins.some(x => x.id === 'tool-schedule'), false);
  assert.ok(!p.patch.includes('sekret-key-123'));
  const api = buildProfile({ local: [], connections: [{ id: 'c1', name: 'C', baseUrl: 'https://x/v1', protocol: 'openai-chat', models: [{ id: 'm' }] }] });
  assert.equal(JSON.parse(api.patch.split('\n').slice(1).join('\n')).find(e => e.id === 'subagent').config.maxActiveSubagents, 8, 'API models take the Harness limit');
});

test('tool failures are said in plain words with the original text kept after them', () => {
  assert.match(plainToolError('Error: URL hostname "127.0.0.1" resolves to a non-public IP address'), /web page could not be opened/);
  assert.match(plainToolError('Error: invalid arguments: missing required property "files"'), /wrong way/);
  assert.equal(plainToolError('something unusual'), null);
  const text = withPlain('Error: web fetch failed: Error: getaddrinfo ENOTFOUND example.invalid');
  assert.match(text, /^That web page could not be opened/);
  assert.match(text, /Details: web fetch failed/);
});

// ------------------------------------------------------------------------------------------------- real Harness

async function rig(t, { onDemand = false, mcpServers = {}, searchMock = null, webWithoutAsking = true } = {}) {
  const worker = await startScriptedWorker(onDemand ? { charsPerToken: 4 } : {});
  const dir = mkdtempSync(join(tmpdir(), 'strata-tools-'));
  const ws = join(dir, 'ws'); mkdirSync(ws, { recursive: true });
  const local = [{ id: 'inst-1', label: 'Scripted', baseUrl: worker.url, modelId: 'scripted-model', context: 32768, slots: 4, mcpServers }];
  const bridge = createAgentBridge({ dataDir: dir, localInstances: () => local, connections: () => [],
    ...(onDemand ? { tools: () => ({ onDemand: true, off: new Set(), search: { provider: 'builtin', key: '' }, webWithoutAsking, browserEnabled: false, servers: {}, hasInstructionTools: false, hasCommandTools: false }) } : {}),
    env: process.env, startTimeoutMs: 90_000, searchMock });
  t.after(async () => { await bridge.close(); await worker.close(); cleanup(dir); });
  const run = async (chatId, message, { mode = 'bypass', answer } = {}) => {
    const frames = [];
    await bridge.runTurn({
      chatId, message, workspacePath: ws, mode,
      onFrame: f => {
        frames.push(f);
        if (answer && f.type === 'agent-tool' && f.tool.state === 'proposed') void bridge.approve({ chatId, callId: f.tool.id, decision: answer }).catch(e => frames.push({ type: 'test-error', message: e.message }));
      },
    });
    return frames;
  };
  const call = (chatId, tool, args, options) => run(chatId, `SCRIPT:call ${tool} ${JSON.stringify(args)}`, options);
  return { worker, bridge, dir, ws, run, call };
}
const cards = frames => frames.filter(f => f.type === 'agent-tool').map(f => f.tool);
const last = frames => cards(frames).at(-1);

test('on-demand tool schemas stay stable after catalog and on a later greeting', { skip }, async (t) => {
  const r = await rig(t, { onDemand: true });
  const frames = await r.run('catalog', 'SCRIPT:call tool_catalog {"groups":["files","shell"]}');
  assert.match(last(frames).result, /BatchMode=yes/);
  const first = r.worker.requests.at(-2), loaded = r.worker.requests.at(-1);
  assert.deepEqual(first.toolNames, compactNames);
  assert.deepEqual(loaded.toolNames, first.toolNames, 'catalog does not invalidate the cached prompt prefix');
  assert.deepEqual(JSON.parse(first.raw).tools, JSON.parse(loaded.raw).tools, 'complete schemas stay byte-identical after catalog');
  assert.match(last(frames).result, /"name":"read"/);
  assert.match(last(frames).result, /"name":"bash"/);
  await r.run('catalog', 'SCRIPT:hello');
  const greeting = r.worker.requests.at(-1);
  assert.deepEqual(greeting.toolNames, first.toolNames);
  const fresh = await r.run('fresh-hello', 'SCRIPT:hello');
  assert.ok(r.worker.requests.at(-1).promptChars < 7000, 'a fresh short reply does not carry the full tool catalog');
  const shown = fresh.filter(f => f.type === 'context').at(-1)?.contextTokens;
  assert.ok(shown > 0 && shown < 2000, `the context meter reads the compact request (${shown})`);
});

test('on-demand tools can be dispatched on a later turn without changing request schemas', { skip }, async (t) => {
  const r = await rig(t, { onDemand: true });
  await r.run('jobs-resume', 'SCRIPT:call job_list {}');
  const first = r.worker.requests.at(-2);
  assert.deepEqual(first.toolNames, compactNames);
  const frames = await r.call('jobs-resume', 'tool_dispatch', { name: 'job_list', arguments: {} });
  assert.match(last(frames).result, /job_list/);
  const resumed = r.worker.requests.at(-1);
  assert.deepEqual(resumed.toolNames, first.toolNames);
});

test('the direct shell runs rg without a catalog step or an approval for read-only search', { skip: skip || process.platform === 'win32' }, async (t) => {
  const r = await rig(t, { onDemand: true });
  writeFileSync(join(r.ws, 'needle.txt'), 'needle');
  const frames = await r.call('direct-search', 'bash', { command: 'rg --files', description: 'Find files' }, { mode: 'manual' });
  assert.match(last(frames)?.result ?? '', /needle\.txt/);
  assert.ok(!cards(frames).some(card => card.state === 'proposed'), 'read-only rg never asks for permission');
  assert.deepEqual(r.worker.requests[0].toolNames, compactNames);
  assert.equal(cards(frames).filter(card => card.name === 'tool_catalog' || card.name === 'tool_dispatch').length, 0);
  const denied = await r.call('direct-change', 'bash', { command: 'touch should-not-exist', description: 'Create a marker' }, { mode: 'manual', answer: 'deny' });
  assert.ok(cards(denied).some(card => card.state === 'proposed'), 'a direct mutating shell call still asks');
  assert.equal(existsSync(join(r.ws, 'should-not-exist')), false);
});

test('an incomplete dispatcher argument cannot run a command', { skip: skip || process.platform === 'win32' }, async (t) => {
  const r = await rig(t, { onDemand: true });
  const frames = await r.call('broken-dispatch', 'tool_dispatch', {
    name: 'bash', arguments: '{"command":"touch should-not-exist","timeout":',
  }, { mode: 'bypass' });
  assert.ok(cards(frames).some(card => card.state === 'error'));
  assert.equal(existsSync(join(r.ws, 'should-not-exist')), false);
});

test('on-demand dispatch keeps the named tool permission check', { skip }, async (t) => {
  const r = await rig(t, { onDemand: true });
  const file = join(r.ws, 'dispatch-denied.txt');
  const frames = await r.call('dispatch-gate', 'tool_dispatch', {
    name: 'write', arguments: { file_path: fwd(file), content: 'should not be written' },
  }, { mode: 'manual', answer: 'deny' });
  assert.ok(cards(frames).some(card => card.state === 'proposed'), 'the inner write still asks in Manual mode');
  assert.ok(cards(frames).some(card => card.name === 'write'), 'the card names the actual tool');
  assert.equal(existsSync(file), false, 'denying the inner tool prevents the change');
});

test('on-demand web dispatch asks on the outer card and shows the web tool', { skip }, async (t) => {
  const r = await rig(t, { onDemand: true, searchMock: 'offline', webWithoutAsking: false });
  const frames = await r.call('dispatch-web-gate', 'tool_dispatch', {
    name: 'web_search', arguments: { queries: ['weather Moscow'] },
  }, { mode: 'manual', answer: 'deny' });
  assert.ok(cards(frames).some(card => card.state === 'proposed' && card.name === 'web_search'));
  assert.ok(cards(frames).some(card => card.state === 'denied'));
});

test('on-demand connected tools stay hidden until the model requests them', { skip }, async (t) => {
  const mcpServers = { demo: { command: process.execPath, args: [fwd(join(import.meta.dirname, 'helpers', 'mini-mcp.mjs'))] } };
  const r = await rig(t, { onDemand: true, mcpServers });
  await r.run('mcp-catalog', 'SCRIPT:call tool_catalog {"groups":["connected"]}');
  assert.deepEqual(r.worker.requests.at(-2).toolNames, compactNames);
  const loaded = r.worker.requests.at(-1).toolNames;
  assert.deepEqual(loaded, r.worker.requests.at(-2).toolNames);
  const result = await r.call('mcp-catalog', 'tool_dispatch', { name: 'mcp__demo__shout', arguments: { text: 'hello' } }, { mode: 'bypass' });
  assert.match(last(result).result, /HELLO/);
});

test('a short web task sends small requests even after loading web tools', { skip }, async (t) => {
  const r = await rig(t, { onDemand: true, searchMock: 'offline' });
  await r.run('weather', 'SCRIPT:weather');
  const requests = r.worker.requests;
  assert.equal(requests.length, 4, 'catalog, search, fetch, answer');
  assert.deepEqual(requests[0].toolNames, compactNames);
  assert.ok(requests.slice(1).every(q => JSON.stringify(q.toolNames) === JSON.stringify(requests[0].toolNames)));
  assert.ok(requests.every(q => q.promptChars < 9000), `the fixed direct-shell schema stays compact: ${requests.map(q => q.promptChars).join(', ')}`);
  assert.ok(requests.every(q => JSON.stringify(JSON.parse(q.raw).tools).length < 4500), 'the whole built-in tool inventory is never sent');
  assert.ok(requests.reduce((sum, q) => sum + q.promptChars, 0) < 33_000, `the four-step request remains bounded with direct shell: ${requests.map(q => q.promptChars).join(', ')}`);
});

test('the agent is offered exactly these tools: everything useful including web search (no key needed), no scheduler, and the question tool the app can answer', { skip }, async (t) => {
  const r = await rig(t);
  await r.run('inv', 'SCRIPT:echo hi');
  const offered = [...r.worker.requests].reverse().find(q => q.toolNames.length)?.toolNames.sort();
  assert.deepEqual(offered, ['ask_user_question', 'create_goal', 'edit', 'get_goal', 'glob', 'grep', 'interrupt_agent', 'job_kill', 'job_list', 'job_output', 'list_agents', 'list_subagent_models', 'present', shellTool, 'read', 'read_image', 'send_message', 'skill', 'subagent', 'subagent_fork', 'todo_write', 'update_goal', 'web_fetch', 'web_search', 'workflow', 'working_directory', 'write'].sort());
  assert.ok(!offered.some(n => n.startsWith('schedule_')) && offered.includes('web_search') && offered.includes('ask_user_question') && !offered.includes('exit_plan_mode'));
});

test('a tool from each family runs and shows a card the page can render', { skip }, async (t) => {
  const r = await rig(t);
  const file = join(r.ws, 'notes.txt');
  writeFileSync(file, 'alpha\nneedle here\nomega\n');
  const f = fwd(file);
  // read-only family
  assert.match(last(await r.call('fam-r', 'read', { file_path: f })).result, /needle here/);
  assert.match(last(await r.call('fam-g', 'glob', { pattern: '*.txt' })).result, /notes\.txt/);
  assert.match(last(await r.call('fam-s', 'grep', { pattern: 'needle' })).result, /Line 2/);
  assert.equal(last(await r.call('fam-w', 'working_directory', {})).state, 'done');
  assert.equal(last(await r.call('fam-j', 'job_list', {})).state, 'done');
  // plan / list family
  assert.equal(last(await r.call('fam-t', 'todo_write', { todos: [{ content: 'check the build', status: 'pending' }] })).state, 'done');
  const goal = last(await r.call('fam-goal', 'create_goal', { objective: 'finish the notes' }));
  assert.equal(goal.state, 'done'); assert.equal(goal.effect, 'Sets a goal to work towards.');
  // write family (Bypass: no card asks)
  const wrote = await r.call('fam-fs', 'write', { file_path: fwd(join(r.ws, 'new.txt')), content: 'made\n' });
  assert.equal(last(wrote).state, 'done'); assert.equal(readFileSync(join(r.ws, 'new.txt'), 'utf8').trim(), 'made');
  await r.call('fam-fs', 'read', { file_path: f });
  const edited = await r.call('fam-fs', 'edit', { file_path: f, old_string: 'alpha', new_string: 'ALPHA' });
  assert.equal(last(edited).state, 'done'); assert.match(readFileSync(file, 'utf8'), /^ALPHA/);
  // shell family
  assert.match(last(await r.call('fam-sh', shellTool, { command: shellTool === 'pwsh' ? 'Get-ChildItem' : 'ls', description: 'list files' })).result, /notes\.txt/);
  // web family: offline, loopback is refused by the Harness itself; the failure is plain with Details after it
  const web = last(await r.call('fam-web', 'web_fetch', { url: 'http://127.0.0.1:9/' }));
  assert.equal(web.state, 'error'); assert.match(web.result, /^That web page could not be opened/); assert.match(web.result, /Details: /);
  assert.equal(web.effect, 'Opens a web page.'); assert.equal(web.preview, 'http://127.0.0.1:9/');
  // no card shows raw JSON as its explanation
  for (const c of [last(await r.call('fam-t2', 'todo_write', { todos: [{ content: 'x', status: 'pending' }] }))]) assert.ok(!c.preview.startsWith('{'));
});

test('Manual: one change is one card. Nothing ran when it appeared, and no sandbox or PowerShell error was ever shown', { skip }, async (t) => {
  const r = await rig(t);
  const a = join(r.ws, 'a.txt'), b = join(r.ws, 'b.txt'), c = join(r.ws, 'c.txt');
  // approve a file write
  let frames = await r.call('man1', 'write', { file_path: fwd(a), content: 'hello\n' }, { mode: 'manual', answer: 'approve' });
  assert.deepEqual(cards(frames).map(x => x.state), ['running', 'proposed', 'running', 'done']);
  assert.equal(new Set(cards(frames).map(x => x.id)).size, 1, 'one card, updated in place');
  assert.equal(readFileSync(a, 'utf8').trim(), 'hello');
  // deny a file write
  frames = await r.call('man2', 'write', { file_path: fwd(b), content: 'no\n' }, { mode: 'manual', answer: 'deny' });
  assert.deepEqual(cards(frames).map(x => x.state), ['running', 'proposed', 'denied', 'denied']);
  assert.equal(last(frames).result, 'Denied. Nothing ran.', 'the card says it in plain words, not the model-facing error');
  assert.equal(existsSync(b), false);
  // a shell command that changes things
  frames = await r.call('man3', shellTool, { command: shellTool === 'pwsh' ? `Set-Content -Path '${c}' -Value x` : `printf x > '${c}'`, description: 'Make c.txt' }, { mode: 'manual', answer: 'approve' });
  assert.deepEqual(cards(frames).map(x => x.state), ['running', 'proposed', 'running', 'done']);
  assert.ok(existsSync(c));
  // a shell command that only looks needs no question
  frames = await r.call('man4', shellTool, { command: shellTool === 'pwsh' ? 'Get-ChildItem' : 'ls', description: 'List files' }, { mode: 'manual' });
  assert.deepEqual(cards(frames).map(x => x.state), ['running', 'done']);
  // nowhere in any of it does the person see the sandbox talking
  const all = JSON.stringify([...cards(frames), ...cards(await r.call('man5', 'write', { file_path: fwd(join(r.ws, 'd.txt')), content: 'd' }, { mode: 'manual', answer: 'approve' }))]);
  assert.ok(!/sandbox|Constrained|language mode|access denied/i.test(all), all.slice(0, 300));
});

test('Plan stays read-only and Bypass asks nothing', { skip }, async (t) => {
  const r = await rig(t);
  const p = join(r.ws, 'p.txt'), q = join(r.ws, 'q.txt');
  const planned = await r.call('pl', 'write', { file_path: fwd(p), content: 'x' }, { mode: 'plan' });
  assert.equal(existsSync(p), false);
  assert.ok(!cards(planned).some(x => x.state === 'proposed'));
  const free = await r.call('bp', 'write', { file_path: fwd(q), content: 'x' }, { mode: 'bypass' });
  assert.equal(existsSync(q), true);
  assert.ok(!cards(free).some(x => x.state === 'proposed'));
});

test('Manual refuses to start when the gate is not loaded (it would be an open sandbox that nobody asks about)', { skip }, async (t) => {
  // A Harness started without the gate plugin (the bridge's `gate: false`).
  const worker = await startScriptedWorker({});
  const dir = mkdtempSync(join(tmpdir(), 'strata-nogate-'));
  mkdirSync(join(dir, 'ws'), { recursive: true });
  const local = [{ id: 'i', baseUrl: worker.url, modelId: 'scripted-model', context: 32768 }];
  const bridge = createAgentBridge({ dataDir: dir, localInstances: () => local, connections: () => [], env: process.env, gate: false, startTimeoutMs: 90_000 });
  t.after(async () => { await bridge.close(); await worker.close(); cleanup(dir); });
  await assert.rejects(bridge.runTurn({ chatId: 'x', message: 'SCRIPT:echo hi', workspacePath: join(dir, 'ws'), mode: 'manual', onFrame: () => {} }), error => error.code === 'mode-unavailable' && /asks before changing/.test(error.message) && !/sandbox/i.test(error.message));
});

test('a tool server set up for the model is connected to the agent: its tools are offered, Manual asks before using them, and its secret never reaches a file', { skip }, async (t) => {
  const worker = await startScriptedWorker({});
  const dir = mkdtempSync(join(tmpdir(), 'strata-mcp-'));
  const ws = join(dir, 'ws'); mkdirSync(ws, { recursive: true });
  const mcpServers = { demo: { command: process.execPath, args: [fwd(join(import.meta.dirname, 'helpers', 'mini-mcp.mjs'))], env: { DEMO_TOKEN: 'tok-123456-secret' } }, off: { command: 'x', disabled: true } };
  const local = [{ id: 'i', baseUrl: worker.url, modelId: 'scripted-model', context: 32768, slots: 2, mcpServers }];
  const bridge = createAgentBridge({ dataDir: dir, localInstances: () => local, connections: () => [], env: process.env, startTimeoutMs: 90_000 });
  t.after(async () => { await bridge.close(); await worker.close(); cleanup(dir); });
  const frames = [];
  await bridge.runTurn({ chatId: 'mcp-bypass', message: `SCRIPT:call mcp__demo__shout ${JSON.stringify({ text: 'hello' })}`, workspacePath: ws, mode: 'bypass', onFrame: f => frames.push(f) });
  assert.ok([...worker.requests].reverse().find(q => q.toolNames.length).toolNames.includes('mcp__demo__shout'));
  assert.ok(![...worker.requests].some(q => q.toolNames.some(n => n.startsWith('mcp__off'))), 'a disabled server is not connected');
  const card = cards(frames).at(-1);
  assert.equal(card.state, 'done'); assert.match(card.result, /HELLO\|token:set/, 'the secret reached the server through the environment');
  assert.equal(card.scope, 'connected');
  // Manual: a connected tool has unknown effects, so it asks first
  const manual = [];
  await bridge.runTurn({
    chatId: 'mcp-manual', message: `SCRIPT:call mcp__demo__shout ${JSON.stringify({ text: 'ask me' })}`, workspacePath: ws, mode: 'manual',
    onFrame: f => { manual.push(f); if (f.type === 'agent-tool' && f.tool.state === 'proposed') void bridge.approve({ chatId: 'mcp-manual', callId: f.tool.id, decision: 'approve' }); },
  });
  assert.deepEqual(cards(manual).map(c => c.state), ['running', 'proposed', 'running', 'done']);
  assert.match(cards(manual)[1].effect, /Use the connected tool demo \/ shout/);
  // the secret is in the environment of the agent only: never in the profile file
  const files = JSON.stringify(readdirDeep(join(dir, 'agent')).filter(f => f.endsWith('.yml')).map(f => readFileSync(f, 'utf8')));
  assert.ok(files.includes('process.env.STRATA_MCP_0_E_DEMO_TOKEN') && !files.includes('tok-123456-secret'));
});

function readdirDeep(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) out.push(...readdirDeep(p)); else out.push(p); }
  return out;
}

test('the output budget is not the old 8192, and the Reasoning menu reaches the request (off sends enable_thinking false)', { skip }, async (t) => {
  const worker = await startScriptedWorker({});
  const dir = mkdtempSync(join(tmpdir(), 'strata-think-'));
  const ws = join(dir, 'ws'); mkdirSync(ws, { recursive: true });
  const local = [{ id: 'i', baseUrl: worker.url, modelId: 'scripted-model', context: 65536 }];
  const bridge = createAgentBridge({ dataDir: dir, localInstances: () => local, connections: () => [], env: process.env, startTimeoutMs: 90_000 });
  t.after(async () => { await bridge.close(); await worker.close(); cleanup(dir); });
  const ask = async (chatId, thinking) => {
    worker.requests.length = 0;
    await bridge.runTurn({ chatId, message: 'SCRIPT:echo hi', workspacePath: ws, mode: 'bypass', thinking, onFrame: () => {} });
    return worker.requests.find(r => r.toolNames.length).params;
  };
  const ctk = p => p.chat_template_kwargs ?? {};
  const off = await ask('think-off', 'Off');
  assert.equal(ctk(off).enable_thinking, false); assert.equal(ctk(off).reasoning_effort, undefined);
  assert.equal(off.enable_thinking, undefined, 'a top-level enable_thinking is the field the Strata server ignores');
  // The profile's budget (13,107 at 64K: what compaction sets aside for a reply) is the header the Harness reads; the request itself may produce half the window (AGENT-LOST).
  assert.ok(off.max_completion_tokens === 32768, `ceiling ${off.max_completion_tokens} (half the window, at most 64K: never the old 8192, and a file written in one call is not cut at the 20 percent compaction reserves)`);
  const high = await ask('think-high', 'High');
  assert.equal(ctk(high).enable_thinking, true); assert.equal(ctk(high).reasoning_effort, 'high');
  const low = await ask('think-low', 'Low');
  assert.equal(ctk(low).enable_thinking, true); assert.equal(ctk(low).reasoning_effort, 'low');
  const max = await ask('think-max', 'Max');
  assert.equal(ctk(max).enable_thinking, true); assert.equal(ctk(max).reasoning_effort, 'high');
  // the same chat switching its level between turns
  assert.equal(ctk(await ask('think-off', 'High')).enable_thinking, true);
  assert.equal(ctk(await ask('think-off', 'Off')).enable_thinking, false);
});
