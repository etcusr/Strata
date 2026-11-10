/** Items 1, 2 and 5: the live status line, the reasoning row and the goal state, as the pure logic the page uses. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function load(file) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`../src/lib/${file}`, import.meta.url))], bundle: true, format: 'esm', platform: 'node', write: false, alias: { react: fileURLToPath(new URL('./helpers/react-stub.mjs', import.meta.url)) }, logLevel: 'silent', loader: { '.json': 'json' } });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
globalThis.window ??= globalThis; globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator ??= { language: 'en' };

const status = await load('live-status.ts');
const reasoning = await load('reasoning.ts');
const goal = await load('goal.ts');

test('item 1: only the newest status frame is kept, and idle, a missing phase or done clears it', () => {
  const chat = 'c1';
  assert.equal(status.applyStatusFrame(chat, { seq: 1, phase: 'thinking', code: 'thinking', text: 'Thinking…', tokens: 40, elapsedMs: 100 }, 1000), true);
  assert.equal(status.statusOf(chat).tokens, 40);
  assert.equal(status.applyStatusFrame(chat, { seq: 0, phase: 'tool', code: 'tool', text: 'old' }), false, 'an older frame never replaces a newer one');
  assert.equal(status.statusOf(chat).phase, 'thinking');
  status.applyStatusFrame(chat, { seq: 2, phase: 'preparing', code: 'preparing-tool', text: 'Writing pagoda.html…', args: { verb: 'Writing a file', target: 'pagoda.html' } });
  assert.equal(status.statusOf(chat).phase, 'preparing');
  status.applyStatusFrame(chat, { seq: 3, phase: 'idle', code: 'idle', text: '' });
  assert.equal(status.statusOf(chat), null, 'idle removes the line');
  status.applyStatusFrame(chat, { seq: 4, phase: 'goal', code: 'goal-step', text: 'Working on the goal…', args: { round: 1 } });
  status.clearStatus(chat);
  assert.equal(status.statusOf(chat), null, 'done and error clear it too');
});

test('item 1: the status names observed model and tool work without invented rotating messages', () => {
  const frame = (phase, code, args) => ({ seq: 1, phase, code, text: `${phase}…`, args, elapsedMs: 0, receivedAt: 0 });
  assert.equal(status.statusWords(frame('thinking', 'thinking')), 'Generating reasoning…');
  assert.equal(status.statusWords(frame('waiting', 'model-working')), 'Waiting for model output…');
  assert.equal(status.statusWords(frame('waiting', 'reading-prompt')), 'Reading your message…');
  assert.equal(status.statusWords(frame('waiting', 'reading-prompt'), { phase: 'reading', prompt: { done: 1200, total: 6000 } }), 'Reading prompt · 1,200 / 6,000 tokens');
  assert.equal(status.statusWords(frame('waiting', 'model-working'), { phase: 'busy-other' }), 'Local model busy with another request…');
  assert.equal(status.statusWords(frame('thinking', 'thinking'), { phase: 'reading', prompt: { done: 9000, total: 6000 } }), 'Reading prompt · 6,000 / 6,000 tokens');
  assert.equal(status.statusWords(frame('preparing', 'preparing-tool', { verb: 'Writing a file', target: 'pagoda.html' })), 'Writing a file · pagoda.html…');
  assert.equal(status.statusWords(frame('tool', 'tool', { verb: 'Searching the web' })), 'Searching the web…');
  assert.equal(status.statusWords(frame('goal', 'goal-step', { round: 2 })), 'Working on the goal…');
  assert.equal(status.elapsedText(0, 14_000), '14s'); assert.equal(status.elapsedText(0, 64_000), '1m 04s');
});

test('the status ignores prompt progress from a previous chat or an orphaned request', () => {
  const older = { time: 200, live: { state: 'reading', elapsed_s: 30, prompt_read: 22528, prompt_total: 153641 } };
  assert.deepEqual(status.nativeActivityForTurn(older, 190000), { phase: 'busy-other' });
  assert.deepEqual(status.nativeActivityForTurn(older, 165000), { phase: 'reading', prompt: { done: 22528, total: 153641 }, generated: 0 });
  assert.equal(status.nativeActivityForTurn({ time: 200, live: { state: 'idle' } }, 190000), null);
});

test('item 2: the reasoning row shows what it is thinking about, then how long it took; it sticks to the bottom only while the person has not scrolled up', () => {
  assert.equal(reasoning.lastReasoningLine('First idea.\n\n**Second** idea about `colours`\n'), 'Second idea about colours');
  assert.equal(reasoning.lastReasoningLine(''), '');
  assert.ok(reasoning.lastReasoningLine('x'.repeat(300)).length <= 110);
  assert.equal(reasoning.thoughtDuration(38_400), '38s'); assert.equal(reasoning.thoughtDuration(64_000), '1m 04s');
  assert.equal(reasoning.thoughtDuration(400), null); assert.equal(reasoning.thoughtDuration(undefined), null);
  assert.equal(reasoning.atBottom({ scrollHeight: 500, scrollTop: 340, clientHeight: 160 }), true);
  assert.equal(reasoning.atBottom({ scrollHeight: 500, scrollTop: 100, clientHeight: 160 }), false, 'scrolled up: stop following');
});

test('item 5: the goal object from a frame, an event or a route; anything else is "no goal"', () => {
  assert.equal(goal.readGoal(null), null); assert.equal(goal.readGoal({ objective: '', phase: 'active' }), null); assert.equal(goal.readGoal({ objective: 'x', phase: 'weird' }), null);
  const g = goal.readGoal({ objective: 'Build the page', phase: 'blocked', round: 2, maxRounds: 5, blocked: 'It needs a folder.' });
  assert.deepEqual(g, { objective: 'Build the page', phase: 'blocked', round: 2, maxRounds: 5, blocked: 'It needs a folder.' });
  goal.applyGoalFrame('chat-g', { objective: 'Ship it', phase: 'active', round: 1, maxRounds: 3 });
  assert.equal(goal.goalOf('chat-g').objective, 'Ship it');
  goal.applyGoalFrame('chat-g', null);
  assert.equal(goal.goalOf('chat-g'), null, 'the host clearing the goal removes the bar');
  assert.equal(goal.goalProgress, undefined, 'no step counter is shown for a goal');
});
