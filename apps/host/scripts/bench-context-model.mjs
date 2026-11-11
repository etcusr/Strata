#!/usr/bin/env node
// Synthetic fixtures only. Run against an idle local model; never loads or changes a model.
// --url http://127.0.0.1:PORT/v1 --model ID --window N --baseline /path/to/old/plugins/strata-context.mjs --output result.json
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
const { values } = parseArgs({ options: Object.fromEntries(['url', 'model', 'window', 'baseline', 'output', 'cycles'].map(key => [key, { type: 'string' }])) });
if (!values.url || !values.model || !Number.isInteger(Number(values.window)) || !values.baseline || !values.output) throw new Error('Supply --url, --model, --window, --baseline and --output.');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(values.url).hostname)) throw new Error('This benchmark is for a local model.');
const oldPlugin = await import(pathToFileURL(resolve(values.baseline)));
const newPlugin = await import(new URL('../server/agent/plugins/strata-context.mjs', import.meta.url));
const facts = ['7319', '/tmp/проект/report.txt', 'git status --short', 'Без сетевых запросов'];
const m = (role, text) => ({ role, content: [{ type: 'text', text }] });
const filler = Array.from({ length: 500 }, (_, i) => `test log ${i}: step completed successfully; duration=12ms\n`).join('');
const history = [m('system', 'Ты помощник разработчика. Сохраняй точные требования пользователя.'),
  m('user', filler.slice(0, filler.length / 2) + '\nОбязательные требования: лимит 7319; файл /tmp/проект/report.txt; команда git status --short; Без сетевых запросов.\n' + filler.slice(filler.length / 2)),
  m('assistant', 'Требования приняты. Работа ещё не выполнена.')];
const instruction = m('user', 'Сожми историю в краткую сводку для продолжения работы. Сохрани все обязательные требования пользователя дословно.');
const runs = [];
const cycles = values.cycles === undefined ? 1 : Number(values.cycles);
if (![1, 2, 5, 10].includes(cycles)) throw new Error('--cycles must be 1, 2, 5 or 10');
for (const version of (cycles === 1 ? ['before', 'after', 'after', 'before'] : ['before', 'after'])) {
  const requests = [], metrics = [], handlers = [];
  const llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: Number(values.window) } }),
    async *stream(options) {
      const started = performance.now(); let first = null, usage = {}, timing = {}, finish = null;
      const response = await fetch(values.url.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(600000), headers: { 'content-type': 'application/json', ...(process.env.STRATA_BENCH_API_KEY ? { authorization: `Bearer ${process.env.STRATA_BENCH_API_KEY}` } : {}) },
        body: JSON.stringify({ model: values.model, messages: options.messages.map(x => ({ role: x.role, content: x.content.map(b => b.text ?? '').join('\n') })),
          max_tokens: options.maxTokens, temperature: 0, stream: true, stream_options: { include_usage: true }, chat_template_kwargs: { enable_thinking: false } }),
      });
      if (!response.ok) throw new Error(`Local model HTTP ${response.status}`);
      let buffer = '';
      for await (const part of response.body.pipeThrough(new TextDecoderStream())) {
        buffer += part;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          const event = JSON.parse(line.slice(6));
          const choice = event.choices?.[0], delta = choice?.delta;
          for (const [field, type] of [['content', 'text-delta'], ['reasoning_content', 'reasoning-delta']]) if (delta?.[field]) {
            first ??= performance.now(); yield { type, text: delta[field] };
          }
          if (choice?.finish_reason) finish = choice.finish_reason;
          if (event.usage) usage = event.usage;
          for (const key of ['prompt_ms', 'predicted_ms', 'cache_n', 'prompt_n', 'predicted_n', 'queue_ms']) if (Number.isFinite(event.timings?.[key])) timing[key] = event.timings[key];
        }
      }
      const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
      const counts = { inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached), cacheReadTokens: cached, outputTokens: usage.completion_tokens ?? 0 };
      if (Number.isFinite(usage.completion_tokens_details?.reasoning_tokens)) counts.reasoningTokens = usage.completion_tokens_details.reasoning_tokens;
      requests.push({ purpose: options.purpose ?? 'reply', ms: performance.now() - started, firstDeltaMs: first === null ? null : first - started, finish, ...counts, ...timing });
      yield { type: 'usage', usage: counts };
      yield { type: 'finish', reason: { kind: finish === 'stop' ? 'stop' : finish === 'length' ? 'max-tokens' : 'error' } };
    },
  };
  (version === 'before' ? oldPlugin : newPlugin).apply({ llm, on: (_event, fn) => handlers.push(fn), inject() {}, logger: { info: text => {
    if (text.startsWith('strata-context-metric ')) metrics.push(JSON.parse(text.slice(22)));
  } } }, { diagnostics: true, preserveOversizedMessages: true, structuredSummaries: cycles > 1 && version === 'after' });
  const options = { provider: 'strata-local', model: values.model, sessionId: 'synthetic-benchmark', maxTokens: 768 };
  let summary = '';
  const checkpoints = [];
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const input = cycle === 1 ? history : [history[0], m('user', `<compacted-summary>\n${summary}\n</compacted-summary>`), m('assistant', 'Проверка продолжается. Новых требований нет, прежние остаются в силе.')];
    summary = '';
    for await (const chunk of llm.stream({ ...options, purpose: 'compaction', messages: [...input, instruction] })) if (chunk.type === 'text-delta') summary += chunk.text;
    if ([2, 5, 10].includes(cycle) || cycle === cycles) checkpoints.push({ cycle, retainedFacts: facts.map(f => summary.includes(f)) });
  }
  handlers.forEach(fn => fn({ id: options.sessionId }, { type: 'compaction/end', data: {} }));
  let answer = '';
  for await (const chunk of llm.stream({ ...options, maxTokens: 256, messages: [history[0], m('user', `<compacted-summary>\n${summary}\n</compacted-summary>`), m('user', 'Перечисли дословно обязательные требования: лимит, путь, команду и запрет.')] })) if (chunk.type === 'text-delta') answer += chunk.text;
  runs.push({ version, checkpoints, requests, metrics, summaryFacts: facts.map(f => summary.includes(f)), recalledFacts: facts.map(f => answer.includes(f)), rssBytes: process.memoryUsage().rss });
  await writeFile(values.output, JSON.stringify({ model: values.model, window: Number(values.window), thinking: false, cycles, order: cycles === 1 ? 'ABBA; warm cache is not cleared' : 'before/after; repeated summaries; warm cache is not cleared', adapter: 'minimal OpenAI SSE shim; real Harness integration tested separately', runs }, null, 2));
  console.log(JSON.stringify({ version, requests: requests.length, recalledFacts: runs.at(-1).recalledFacts }));
}
