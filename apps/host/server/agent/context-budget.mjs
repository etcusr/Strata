/**
 * Token arithmetic for the agent's context, with no I/O (the Harness plugin `plugins/strata-context.mjs` and the host both use it).
 *
 * Why it exists. The Harness prices a conversation with a fixed 4 characters per token. Code, logs and JSON are about twice as dense
 * (2.09 characters per token in the 2026-10-22 hands-on test), so its pressure read 31,794 tokens while the engine had been sent 59,048,
 * and compaction waited until the window was already past full. The engine reports the real prompt size with every answer; this module
 * turns that report into the number compaction decides on, and splits a summarising request that would not fit the window.
 */

/** The Harness's own price of a text: characters over this, plus a fixed cost per block and per message. */
export const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const MESSAGE_OVERHEAD = 4;
/** The most a real token can be worth in the Harness's units (one character per token is the worst a tokenizer does). */
export const MAX_DENSITY = 6;
/** Room kept free in a window for the engine's own framing and the chat template (the engine keeps 64 tokens of slack itself). */
export const WINDOW_SLACK = 1024;

/** The Harness's price (4 characters a token) of one message, the same arithmetic as its token meter. */
export function estimateMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  if (message?.role === 'system') {
    if (!content.length) return 0;
    let chars = 0;
    for (const block of content) chars += block?.type === 'text' ? String(block.text ?? '').length : JSON.stringify(block ?? {}).length;
    return Math.ceil(chars / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD;
  }
  let tokens = MESSAGE_OVERHEAD;
  for (const block of content) {
    if (block?.type === 'text' || block?.type === 'reasoning') tokens += Math.ceil(String(block.text ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
    else if (block?.type === 'tool-call') tokens += Math.ceil(String(block.name ?? '').length / CHARS_PER_TOKEN) + Math.ceil(String(block.arguments ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
    else tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block ?? {}).length / CHARS_PER_TOKEN);
  }
  return tokens;
}

/** The Harness's price of the tool list of a request header. */
export function estimateTools(header) {
  const tools = header?.tools;
  if (!Array.isArray(tools) || !tools.length) return 0;
  return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
}

/**
 * How many real tokens one of the Harness's tokens is worth, from one measured request: the engine said the prompt was `real` tokens,
 * the Harness priced the same prompt at `estimated`. Never below 1 (a conversation of plain prose is priced about right, and a lower
 * number would only delay compaction) and never above MAX_DENSITY (a wild sample must not make every step compact).
 */
export function densityOf(real, estimated) {
  if (!(real > 0) || !(estimated > 0)) return 1;
  return Math.min(MAX_DENSITY, Math.max(1, real / estimated));
}

/**
 * The prompt size compaction decides on. `sample` is the last measured request: `real` tokens for a prompt the Harness priced at
 * `estimated`. `now` is the Harness's price of the conversation now. What was added or removed since the sample is scaled by the sample's
 * density; the measured part is exact. Without a sample, or when the measurement is lower than the Harness's own price, the Harness's
 * price stands (it is never an underestimate that makes this smaller).
 */
export function pressureNow({ sample = null, now }) {
  if (!sample || !(sample.real > 0) || !(sample.estimated > 0)) return Math.max(0, now);
  const density = densityOf(sample.real, sample.estimated);
  return Math.max(Math.round(now), Math.round(sample.real + density * (now - sample.estimated)));
}

/** The usage a finished model request reported, as the prompt side only: input plus the cache's reads and writes (output is not in the prompt). */
export function promptTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const n = value => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0);
  return n(usage.inputTokens) + n(usage.cacheReadTokens) + n(usage.cacheWriteTokens);
}

/** The usage of a settled assistant event (a `usage` on the message, or the last usage chunk of its stream). */
export function usageOfEvent(event) {
  const data = event?.data;
  if (!data) return null;
  if (data.usage && typeof data.usage === 'object') return data.usage;
  const stream = Array.isArray(data.stream) ? data.stream : [];
  for (let i = stream.length - 1; i >= 0; i--) if (stream[i]?.type === 'chunk' && stream[i].chunk?.type === 'usage') return stream[i].chunk.usage ?? null;
  return null;
}

/**
 * A summarising request is: the conversation's system prompt and tools, the messages to condense, then the instruction. This is how many
 * real tokens the messages may take in a window so that all of it, the summary and a safety margin fit.
 */
export function summaryBudget({ window, summaryTokens, toolsTokens = 0, systemTokens = 0, instructionTokens = 900, slack = WINDOW_SLACK }) {
  return Math.floor(window - summaryTokens - toolsTokens - systemTokens - instructionTokens - slack);
}

/** Text blocks of a message, longest first: the ones worth shortening when a single message is bigger than the budget. */
function textBlocks(message) {
  return (Array.isArray(message?.content) ? message.content : []).filter(b => (b?.type === 'text' || b?.type === 'reasoning') && typeof b.text === 'string');
}

/**
 * One message cut down to `maxTokens` (in the Harness's price times `density`): the start and the end of its longest text are kept and
 * the middle is replaced by a line saying how much was left out. Only the copy sent to the summariser is cut; the conversation keeps
 * the whole message until the summary replaces it.
 */
export function clipMessage(message, maxTokens, density = 1, estimated = estimateMessage(message)) {
  if (estimated * density <= maxTokens) return message;
  const blocks = textBlocks(message);
  if (!blocks.length) return message;
  const others = estimateMessage({ ...message, content: (message.content ?? []).filter(b => !blocks.includes(b)) }) * density;
  const room = Math.max(256, maxTokens - others);
  const share = room / blocks.reduce((n, b) => n + b.text.length, 0) / density * CHARS_PER_TOKEN;   // characters kept per character
  const content = (message.content ?? []).map((block) => {
    if (!blocks.includes(block)) return block;
    const keep = Math.max(200, Math.floor(block.text.length * Math.min(1, share) - 120));
    if (block.text.length <= keep) return block;
    const head = Math.ceil(keep * 0.6), tail = keep - head;
    const left = block.text.length - head - tail;
    return { ...block, text: `${block.text.slice(0, head)}\n\n[… ${left.toLocaleString('en-US')} characters from the middle are left out of this summary request …]\n\n${block.text.slice(block.text.length - tail)}` };
  });
  return { ...message, content };
}

/** Precompute the latest balanced boundary in one pass, preserving the old split choices. */
function splitSized(sized, room, density, cost = sized.map(m => estimateMessage(m) * density)) {
  const latest = [0];
  let open = 0;
  for (let i = 0; i < sized.length; i++) {
    const m = sized[i];
    if (m?.role === 'assistant') for (const b of m.content ?? []) if (b?.type === 'tool-call') open++;
    if (m?.role === 'tool') open--;
    latest.push(open <= 0 ? i + 1 : latest[i]);
  }
  const runs = [];
  let start = 0, used = 0;
  for (let i = 0; i < sized.length; i++) {
    if (i > start && used + cost[i] > room) {
      const cut = latest[i] > start ? latest[i] : i;
      runs.push(sized.slice(start, cut));
      start = cut;
      // A carried suffix is visited at most once more: the next cut either passes it or falls at i.
      // Sum in the old order (no prefix subtraction) to preserve floating-point boundary decisions.
      used = 0;
      for (let k = start; k < i; k++) used += cost[k];
    }
    used += cost[i];
  }
  if (start < sized.length) runs.push(sized.slice(start));
  return runs;
}

/** Legacy clipping remains the default; the linear splitter preserves its request boundaries. */
export function splitMessages(messages, budget, density = 1, { preserveOversizedMessages = false } = {}) {
  const room = Math.max(512, budget);
  if (preserveOversizedMessages) return splitSized(losslessMessages(messages, room, density), room, density);
  const cost = [];
  const sized = messages.map(m => {
    const estimated = estimateMessage(m);
    const clipped = clipMessage(m, Math.floor(room * 0.8), density, estimated);
    cost.push((clipped === m ? estimated : estimateMessage(clipped)) * density);
    return clipped;
  });
  // Estimates live only within this synchronous split: mutations and route/template changes cannot reuse stale prices.
  return splitSized(sized, room, density, cost);
}

/**
 * Oversized exchanges become quoted transcript fragments, never executable partial tool calls.
 * Only these exchanges change representation. Source indices are relative to this compaction body.
 * Every character of every text block is sent, in order; atomic non-text blocks fail closed if too big.
 */
function losslessMessages(messages, room, density) {
  const out = [];
  let start = 0, open = 0, cost = 0;
  function flush(end) {
    const group = messages.slice(start, end);
    if (cost <= room) out.push(...group);
    else for (let i = start; i < end; i++) {
      const m = messages[i];
      for (let b = 0; b < (m.content ?? []).length; b++) {
        const block = m.content[b];
        const source = JSON.stringify({ message: i, id: m.id, seq: m.seq, role: m.role, toolCallId: m.toolCallId, block: b, type: block.type });
        const quote = (text, offset) => ({ role: 'user', content: [{ type: 'text', text: `[Quoted conversation fragment ${source}; offset=${offset}]\n${text}` }] });
        if (block.type !== 'text' && block.type !== 'reasoning') {
          const quoted = quote(JSON.stringify(block), 0);
          if (estimateMessage(quoted) * density > room) throw Object.assign(new Error('An indivisible summary block exceeds the context budget; history was not replaced.'), { code: 'COMPACTION_BLOCK_TOO_LARGE' });
          out.push(quoted);
          continue;
        }
        const text = String(block.text ?? '');
        // Reserve framing for the longest offset; avoid breaking UTF-16 surrogate pairs.
        const size = Math.floor((room / density - estimateMessage(quote('', text.length)) - 2) * CHARS_PER_TOKEN);
        if (size < 2) throw new Error('No room for a summary fragment; history was not replaced.');
        for (let offset = 0; offset < text.length || (offset === 0 && !text.length);) {
          let end = Math.min(text.length, offset + size);
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
          out.push(quote(text.slice(offset, end), offset));
          if (end === text.length) break;
          offset = end;
        }
      }
    }
    start = end; cost = 0;
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    cost += estimateMessage(m) * density;
    if (m?.role === 'assistant') for (const b of m.content ?? []) if (b?.type === 'tool-call') open++;
    if (m?.role === 'tool') open--;
    if (open <= 0) flush(i + 1);
  }
  if (start < messages.length) flush(messages.length);
  return out;
}

/** Whether a failure is the model server saying the prompt does not fit its window. */
export function isContextOverflow(error) {
  if (!error) return false;
  if (error.code === 'CONTEXT_WINDOW_EXCEEDED') return true;
  const text = [error.message, error.cause?.message, error.failure?.message, error.failure?.code].filter(Boolean).join(' ');
  return /request exceeds the context window|leaves no room to answer|context[_ ]length|context window|too many tokens|maximum context/i.test(text);
}

/** The Harness asks for "concise English engineering prose", so a Chinese or Russian chat came back summarised in English (#4750). One sentence is added to the
 *  summary request's last message: write it in the language the person used. Paths, commands and identifiers stay exact. Messages are not changed in place. */
export const SUMMARY_LANGUAGE_RULE = 'Write the summary in the language the person used in this conversation (English only when they wrote English). The instruction above is in English; that does not change the language of the summary. Keep file paths, commands, error strings, identifiers and numbers exactly as they appear.';
export const SUMMARY_CHECKPOINT_RULE = 'Use a concise structured checkpoint in the conversation language: user objective and constraints; decisions and their reasons; verified facts with evidence; failed attempts and unresolved errors; unfinished work and next actions. Preserve exact numbers, paths, commands and identifiers. Distinguish direct user instructions, tool observations and model inferences. Carry every still-active constraint forward; explicitly mark a requirement superseded only when the source says so. Keep supplied source-message IDs and archive locators for important claims; never invent citations. Remove repeated prose and routine successful logs before removing facts. Omit empty sections.';
export function withSummaryLanguage(messages, { structured = false } = {}) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return messages;
  const rule = structured ? `${SUMMARY_LANGUAGE_RULE} ${SUMMARY_CHECKPOINT_RULE}` : SUMMARY_LANGUAGE_RULE;
  const content = typeof last.content === 'string' ? last.content + ' ' + rule
    : Array.isArray(last.content) ? [...last.content, { type: 'text', text: rule }] : null;
  return content === null ? messages : [...messages.slice(0, -1), { ...last, content }];
}
