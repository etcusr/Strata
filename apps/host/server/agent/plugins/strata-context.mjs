import { archiveSummaryAnchor } from '../tool-archive.mjs';
/**
 * Strata's context plugin for the Harness (plain ESM, loaded by absolute path from the profile, like strata-gate and strata-models).
 *
 * What it fixes (2026-10-22 hands-on test, Gyro-S at 64K):
 *   1. Compaction decided from the Harness's own price of the conversation, 4 characters a token. Code, logs and JSON are about twice as
 *      dense, so a chat the engine had read as 59,048 tokens was priced at 31,794 and compaction started far too late. Here the token meter
 *      is calibrated by what the model server reports for each answer (its real prompt size): the measured size is exact, and what was
 *      added since is priced with the density that measurement showed. Automatic compaction and the manual /compact both measure through
 *      the token meter, so both read the same number as the context meter in the app.
 *   2. The summarising request itself could be bigger than the window ("/compact" sent a 66,507-token prompt to a 65,536 window). The
 *      summary is now asked for in pieces that fit: a message bigger than a piece is cut for the request (the conversation keeps it until
 *      the summary replaces it; lossless mode instead sends all text fragments). Pieces are summarised in order, each building on a
 *      complete prior summary. Size refusals and incomplete summaries have bounded retries; failure leaves the original history intact.
 *
 * How. It wraps `tokenMeter.measure` and `llm.stream` in place, once each (the same way strata-models wraps the subagent tools). Only a
 * request the Harness marks `purpose: 'compaction'` is touched in `llm.stream`. Nothing in the Harness is rewritten: a Harness update
 * that renames either leaves compaction as it was, and the test that runs the real Harness fails.
 */
import { replyCap } from '../reply-cut.mjs';
import { densityOf, estimateMessage, estimateTools, isContextOverflow, MAX_DENSITY, pressureNow, promptTokensOf, splitMessages, summaryBudget, usageOfEvent, WINDOW_SLACK, withSummaryLanguage } from '../context-budget.mjs';
import { filteredHeader } from './strata-on-demand-tools.mjs';

export const name = 'strata-context';

/** The routes the host writes for models on this computer (profile.mjs): `strata-local`, `strata-local-<id>`, and their `~s<budget>` copies. */
const isLocalRoute = provider => typeof provider === 'string' && provider.startsWith('strata-local');
export const inject = ['tokenMeter', 'llm'];

/** Real prompt measurements per session: { real, estimated } for the last answer the model server reported. */
const samples = new WeakMap();
const bySessionId = new Map();
const wrapped = new WeakSet();
/** Densities that made a summary request fail on this server, per session id (the next request starts from a more careful one). */
const careful = new Map();

export function apply(ctx, config = {}) {
  const diagnostic = config.diagnostics === true;
  const preserveOversizedMessages = config.preserveOversizedMessages === true;
  const retries = Number.isInteger(config.summaryRetries) ? Math.max(0, Math.min(3, config.summaryRetries)) : 2;
  const afterCompaction = new Map();
  const activeCompactions = new Map();
  let diagnosticId = 0;
  const emit = (phase, data) => {
    if (!diagnostic) return;
    try { ctx.logger?.info?.(`strata-context-metric ${JSON.stringify({ phase, ...data })}`); } catch { /* diagnostics cannot affect a request */ }
  };
  const timed = (phase, fn) => {
    if (!diagnostic) return fn();
    const start = performance.now();
    try { return fn(); } finally { emit(phase, { ms: performance.now() - start }); }
  };
  ctx.on('session/event', (session, event) => {
    if (!diagnostic || !session.id) return;
    if (event.type === 'compaction/end') {
      const key = String(session.id), id = activeCompactions.get(key);
      activeCompactions.delete(key);
      if (!event.data?.error && id !== undefined) afterCompaction.set(key, id);
      if (afterCompaction.size > 256) afterCompaction.delete(afterCompaction.keys().next().value);
    }
  });
  const meter = ctx.tokenMeter;
  const llm = ctx.llm;
  const log = (level, text) => { try { ctx.logger?.[level]?.(`strata-context: ${text}`); } catch { /* logging never blocks */ } };
  const offeredHeader = (session, header) => config.onDemandTools
    ? filteredHeader(session.id, header ?? session.requestHeader?.())
    : header;

  // 1. The measured size of the prompt, from the model server's own report for each answer.
  if (meter && typeof meter.measure === 'function' && !wrapped.has(meter)) {
    wrapped.add(meter);
    const original = meter.measure;
    meter.measure = function measure(session, requestHeader) {
      const offered = offeredHeader(session, requestHeader);
      const m = timed('token-meter', () => original.call(this, session, offered));
      const sample = samples.get(session);
      if (!sample) return m;
      const now = m.surfaceTokens + estimateTools(offered ?? session.requestHeader?.());
      const total = Math.max(m.totalTokens, pressureNow({ sample, now }));
      if (total <= m.totalTokens) return m;
      const density = densityOf(sample.real, sample.estimated);
      return { ...m, totalTokens: total, nodes: m.nodes.map(n => ({ ...n, tokens: Math.ceil(n.tokens * density) })) };
    };
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return;
      const real = promptTokensOf(usageOfEvent(event));
      if (!(real > 0)) return;
      try {
        // The request that was just answered saw the conversation without this answer: its price is the surface before the answer's node.
        const offered = offeredHeader(session);
        const m = original.call(meter, session, offered);
        const heuristic = m.nodes.reduce((n, x) => n + (x.seq === event.seq ? 0 : x.heuristicTokens), 0);
        const estimated = heuristic + estimateTools(offered ?? session.requestHeader?.());
        if (!(estimated > 0)) return;
        const sample = { real, estimated };
        samples.set(session, sample);
        if (session.id) bySessionId.set(String(session.id), sample);
      } catch (e) { log('warn', `could not record a measurement: ${e.message}`); }
    });
  }

  // 2. A summary request that fits the window.
  if (llm && typeof llm.stream === 'function' && !wrapped.has(llm)) {
    wrapped.add(llm);
    const original = llm.stream;
    llm.stream = function stream(options) {
      if (options?.purpose !== 'compaction') {
        if (typeof llm.prepareCall !== 'function' && afterCompaction.has(String(options?.sessionId)))
          return observeReply(original.call(this, options), options);
        return original.call(this, options);
      }
      return summaryStream.call(this, options, original);
    };
  }

  // 3. A reply that has room to finish (AGENT-LOST, 11-01). The output budget in the profile is what the Harness's compaction sets aside for a
  // reply (20 percent of the window; it reads it from the request header), and the same number was also the ceiling of every request: a thinking
  // model that wrote a 15K-token file after 9K tokens of thinking was cut inside the tool call at 19,660, the unfinished call was dropped and the
  // turn ended with no file and no word. The request that goes to the model server may produce up
  // to half the window, at most 64K tokens (replyCap), and pi-ai still clamps it to what the window has left after the prompt. The agent loop
  // dispatches through the adapter's `streamWithSnapshot`, after the loop has checked the request against its header, so that is where the ceiling
  // is raised, once per adapter, the first time a local route is prepared. A Harness that renames it leaves the ceiling as it was (the test that
  // runs the real Harness fails).
  if (llm && typeof llm.prepareCall === 'function' && !wrapped.has(llm.prepareCall)) {
    const original = llm.prepareCall;
    const raised = new WeakSet();
    const prepare = async function prepareCall(config, signal, configure) {
      try { raiseReplyCeiling(config?.provider, raised); } catch (e) { log('warn', `could not raise the reply ceiling: ${e.message}`); }
      return original.call(this, config, signal, configure);
    };
    wrapped.add(prepare);
    llm.prepareCall = prepare;
  }
  function raiseReplyCeiling(provider, raised) {
    if (!isLocalRoute(provider)) return;
    const adapter = llm.adapters?.get?.(provider)?.adapter;
    if (!adapter || raised.has(adapter) || typeof adapter.streamWithSnapshot !== 'function' || typeof adapter.modelOf !== 'function') return;
    raised.add(adapter);
    const stream = adapter.streamWithSnapshot;
    adapter.streamWithSnapshot = function streamWithSnapshot(options, snapshot) {
      let next = options;
      try {
        if (isLocalRoute(options?.provider)) {
          const model = this.modelOf(snapshot, options.provider, options.model);
          const asked = options.maxTokens ?? model.maxTokens ?? 0;
          // Only the agent's own reply budget is raised: a summary or a title asks for far less and keeps what it asked.
          if (options?.purpose !== 'compaction' && model.contextWindow > 0 && asked >= model.maxTokens) {
            const cap = replyCap(model.contextWindow, asked);
            if (cap > asked) next = { ...options, maxTokens: cap };
          }
        }
      } catch { next = options; }
      const result = stream.call(this, next, snapshot);
      return options?.purpose !== 'compaction' && afterCompaction.has(String(options?.sessionId))
        ? observeReply(result, options) : result;
    };
  }

  // The host asks, with /strata-context, how much of the window the chat holds right now: the same measured number compaction decides on
  // (JSON in the command's text: { tokens, window }). Before a message goes out, and after /compact, so the person is told true figures.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'strata-context',
      name: 'strata-context',
      description: 'Reports how many tokens the conversation holds now and the size of the model window',
      handler: async (invocation) => {
        try {
          const session = invocation.agent.session;
          const tokens = meter.measure(session).totalTokens;
          const config = session.requestHeader?.()?.config;
          let window = 0;
          if (config) window = (await llm.resolveModelInfo(config.provider, config.model))?.context?.contextWindow ?? 0;
          return { kind: 'success', text: JSON.stringify({ tokens, window }) };
        } catch (e) { return { kind: 'error', text: `strata-context: ${e.message}` }; }
      },
    });
  });

  /** Numeric allowlist only: never log messages, prompts, tool arguments or provider errors. */
  function observeReply(iterable, options) {
    const key = String(options?.sessionId), compaction = afterCompaction.get(key);
    afterCompaction.delete(key);
    return observe(iterable, 'first-reply', { compaction });
  }
  async function* observe(iterable, phase, metadata = {}) {
    if (!diagnostic) { yield* iterable; return; }
    const start = performance.now();
    let first = null, usage = {}, finish = null;
    try {
      for await (const chunk of iterable) {
        if (first === null && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')) first = performance.now();
        if (chunk.type === 'usage') for (const key of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens']) {
          if (Number.isFinite(chunk.usage?.[key])) usage[key] = chunk.usage[key];
        }
        if (chunk.type === 'finish') finish = ['stop', 'max-tokens', 'tool-calls', 'error', 'aborted'].includes(chunk.reason?.kind) ? chunk.reason.kind : 'unknown';
        yield chunk;
      }
    } finally {
      const end = performance.now();
      emit(phase, { ...metadata, ms: end - start, firstDeltaMs: first === null ? null : first - start,
        afterFirstDeltaMs: first === null ? null : end - first, finish, ...usage,
        queueMs: null, prefillMs: null, generationMs: null, rssBytes: process.memoryUsage().rss });
    }
  }
  async function drain(iterable, metadata) {
    let text = '', finish = null;
    const chunks = [];
    for await (const chunk of observe(iterable, 'summary-request', metadata)) {
      chunks.push(chunk);
      if (chunk.type === 'text-delta') text += chunk.text ?? '';
      else if (chunk.type === 'finish') finish = chunk.reason;
    }
    return { text, finish, chunks };
  }
  const refusedForSize = finish => finish?.kind === 'error' && isContextOverflow(finish.failure ?? finish);
  const incomplete = result => result.finish?.kind === 'max-tokens' || result.finish?.kind === 'stop' && !result.text.trim();
  const summaryError = () => Object.assign(new Error('Compaction did not produce a complete, non-empty summary; original history was not replaced.'), { code: 'COMPACTION_INCOMPLETE' });

  async function* summaryStream(options, original) {
    options = timed('prepare-history', () => ({ ...options, messages: withSummaryLanguage(options.messages, { structured: config.structuredSummaries === true }), ...(isLocalRoute(options.provider) ? { reasoningEffort: 'off' } : {}) }));
    let window = 0;
    try { window = (await llm.resolveModelInfo(options.provider, options.model, options.signal))?.context?.contextWindow ?? 0; } catch { window = 0; }
    const messages = options.messages ?? [];
    const key = String(options.sessionId ?? '');
    const archiveAnchor = config.archiveToolResults ? archiveSummaryAnchor(config.archiveRoot, key) : '';
    function* completed(chunks) {
      for (const chunk of chunks) {
        if (chunk.type === 'finish' && chunk.reason?.kind === 'stop' && archiveAnchor) yield { type: 'text-delta', text: archiveAnchor };
        yield chunk;
      }
    }
    const compaction = ++diagnosticId;
    let requestNumber = 0;
    if (diagnostic) {
      activeCompactions.set(key, compaction);
      if (activeCompactions.size > 256) activeCompactions.delete(activeCompactions.keys().next().value);
    }
    const summaryTokens = options.maxTokens ?? 4096;
    const own = bySessionId.get(key);
    let density = Math.max(careful.get(key) ?? 1, own ? densityOf(own.real, own.estimated) : 1);
    const price = list => timed('estimate-tokens', () => list.reduce((n, m) => n + estimateMessage(m), 0) * density);
    const toolsPrice = tools => timed('estimate-tools', () => estimateTools({ tools }) * density);
    const fits = (request, cap) => !(window > 0) || price(request.messages) + toolsPrice(request.tools) + cap + WINDOW_SLACK <= window;
    const ask = async request => {
      let next = request;
      for (let retry = 0; ; retry++) {
        options.signal?.throwIfAborted?.();
        const result = await drain(original.call(this, next), { compaction, request: ++requestNumber });
        options.signal?.throwIfAborted?.();
        if (!incomplete(result)) {
          if (!['stop', 'error', 'aborted'].includes(result.finish?.kind)) throw summaryError();
          return result;
        }
        if (retry >= retries) throw summaryError();
        const cap = (next.maxTokens ?? summaryTokens) * 2;
        // Unknown windows cannot justify a larger output budget. Repartition instead.
        if (result.finish?.kind === 'max-tokens') {
          if (!(window > 0) || !fits(next, cap)) throw summaryError();
          next = { ...next, maxTokens: cap };
        }
        emit('summary-retry', { retry: retry + 1, maxTokens: next.maxTokens ?? summaryTokens });
      }
    };
    if (!(window > 0) || messages.length < 2) {
      const result = await ask(options);
      yield* completed(result.chunks);
      return;
    }
    let incompleteWhole = false;
    if (fits(options, summaryTokens)) {
      try {
        const first = await ask(options);
        if (!refusedForSize(first.finish)) { yield* completed(first.chunks); return; }
        density = Math.min(MAX_DENSITY, density * 1.6);
        careful.set(key, density);
      } catch (error) {
        if (error.code !== 'COMPACTION_INCOMPLETE' || retries === 0) throw error;
        incompleteWhole = true;
      }
      log('warn', 'the summary needs smaller pieces');
    }
    const instruction = messages[messages.length - 1];
    const system = messages[0]?.role === 'system' ? messages[0] : null;
    const body = messages.slice(system ? 1 : 0, -1);
    let tools = options.tools;
    if (tools && toolsPrice(tools) > window / 3) tools = undefined;
    const fixed = (system ? price([system]) : 0) + toolsPrice(tools) + price([instruction]);
    let budget = summaryBudget({ window, summaryTokens: summaryTokens * 2, systemTokens: fixed, instructionTokens: 0 });
    if (incompleteWhole) budget /= 2;
    for (let attempt = 0; ; attempt++) {
      if (budget < 512 || !body.length) throw summaryError();
      const runs = timed('split-history', () => splitMessages(body, budget, density, { preserveOversizedMessages }));
      emit('summary-pieces', { messages: body.length, pieces: runs.length, window, density, budget });
      let failed = null, summary = '';
      for (let i = 0; i < runs.length; i++) {
        options.signal?.throwIfAborted?.();
        const carried = summary ? [{ role: 'user', content: [{ type: 'text', text: `<compacted-summary>\n${summary}\n</compacted-summary>` }] }] : [];
        const { tools: _drop, ...rest } = options;
        const piece = { ...rest, ...(tools ? { tools } : {}), messages: [...(system ? [system] : []), ...carried, ...runs[i], instruction] };
        if (!fits(piece, summaryTokens)) { failed = 'size'; break; }
        let result;
        try { result = await ask(piece); }
        catch (error) { if (error.code !== 'COMPACTION_INCOMPLETE') throw error; failed = 'incomplete'; break; }
        const { text, finish, chunks } = result;
        if (refusedForSize(finish)) { failed = 'size'; break; }
        if (finish?.kind === 'error' || finish?.kind === 'aborted') { for (const chunk of chunks) yield chunk; return; }
        if (i === runs.length - 1) { yield* completed(chunks); return; }
        summary = text;
      }
      if (!failed || attempt >= retries) throw summaryError();
      if (failed === 'size') {
        density = Math.min(MAX_DENSITY, density * 1.6);
        careful.set(key, density);
      }
      budget /= 2;
      log('warn', 'retrying compaction with smaller pieces; original history is retained');
    }
  }
}
