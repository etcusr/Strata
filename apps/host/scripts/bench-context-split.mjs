#!/usr/bin/env node
// Run each version in a separate process with --expose-gc. No model or conversation data is read.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
const source = process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : new URL('../server/agent/context-budget.mjs', import.meta.url).href;
const { splitMessages } = await import(source);
const text = (role, value, extra = {}) => ({ role, ...extra, content: [{ type: 'text', text: value }] });
const workloads = {
  'many-short': () => Array.from({ length: 30000 }, (_, i) => text(i % 2 ? 'assistant' : 'user', 'message '.repeat(16))),
  'many-tools': () => Array.from({ length: 6000 }, (_, i) => [
    { role: 'assistant', content: [{ type: 'tool-call', id: String(i), name: 'read', arguments: '{}' }] },
    text('tool', 'log '.repeat(64), { toolCallId: String(i) }),
  ]).flat(),
  'large-results': () => Array.from({ length: 200 }, (_, i) => text('tool', `result ${i}\n` + 'log '.repeat(25000), { toolCallId: String(i) })),
};
const results = [];
for (const [name, make] of Object.entries(workloads)) {
  const messages = make(), budget = name === 'large-results' ? 32768 : 1024;
  splitMessages(messages, budget, 1.5);
  const times = []; let runs;
  global.gc?.();
  const before = process.memoryUsage();
  for (let i = 0; i < 5; i++) {
    const start = performance.now(); runs = splitMessages(messages, budget, 1.5); times.push(performance.now() - start);
  }
  const after = process.memoryUsage();
  const digest = createHash('sha256').update(JSON.stringify(runs)).digest('hex');
  results.push({ name, messages: messages.length, runs: runs.length, medianMs: times.sort((a, b) => a - b)[2], timesMs: times,
    rssBefore: before.rss, rssAfter: after.rss, heapBefore: before.heapUsed, heapAfter: after.heapUsed, digest });
}
console.log(JSON.stringify({ node: process.version, cpu: cpus()[0].model, source, maxRssKiB: process.resourceUsage().maxRSS, results }, null, 2));
