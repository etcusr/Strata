/**
 * Keep the model-facing tool schemas stable across the whole conversation.
 *
 * The Harness still owns and executes every enabled tool (and its permission
 * checks). The catalog returns schemas in a late tool result, and the model
 * invokes them through one stable dispatcher. Changing the request's tool
 * list would invalidate the engine's cached prompt prefix on a long chat.
 */
export const name = 'strata-on-demand-tools';
export const inject = ['tools', 'llm'];

import { randomUUID } from 'node:crypto';
import { clearApprovedDispatch, markApprovedDispatch } from './strata-gate.mjs';

const CATALOG = 'tool_catalog';
const DISPATCH = 'tool_dispatch';
const wrappedFetch = new WeakSet();
export const CATEGORIES = ['files', 'shell', 'jobs', 'web', 'browser', 'devtools', 'skills', 'helpers', 'goals', 'questions', 'todo', 'present', 'connected'];

export function category(name) {
  if (['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'working_directory'].includes(name)) return 'files';
  if (['bash', 'pwsh'].includes(name)) return 'shell';
  if (name.startsWith('job_')) return 'jobs';
  if (name.startsWith('web_')) return 'web';
  if (name === 'skill') return 'skills';
  if (['subagent', 'subagent_fork', 'list_agents', 'list_subagent_models', 'send_message', 'interrupt_agent', 'workflow'].includes(name)) return 'helpers';
  if (['create_goal', 'get_goal', 'update_goal'].includes(name)) return 'goals';
  if (name === 'ask_user_question') return 'questions';
  if (name === 'todo_write') return 'todo';
  if (name === 'present') return 'present';
  if (name.startsWith('mcp__browser__')) return 'browser';
  if (name.startsWith('mcp__') && /chrome.devtools/i.test(name)) return 'devtools';
  if (name.startsWith('mcp__')) return 'connected';
  return 'connected'; // A new enabled tool remains discoverable instead of silently disappearing.
}

export function visibleTools(_sessionId, tools) {
  if (!Array.isArray(tools)) return tools;
  // Stable on every step: activating a category must not rewrite the first
  // tokens of a prompt whose KV cache is already warm.
  return tools.filter(tool => tool.name === CATALOG || tool.name === DISPATCH || tool.name === 'job_list');
}

export function filteredHeader(sessionId, header) {
  if (!header?.tools) return header;
  const tools = visibleTools(sessionId, header.tools);
  return { ...header, ...(tools.length ? { tools } : { tools: undefined }) };
}

/** Keep structured web responses useful without handing the next model step a whole API dump. */
export function compactJsonBody(body, maxChars = 7800) {
  if (typeof body !== 'string' || body.length <= maxChars) return body;
  let value;
  try { value = JSON.parse(body); } catch { return body; }
  const shrink = (item, arrays, keys, strings) => {
    if (Array.isArray(item)) return item.slice(0, arrays).map(child => shrink(child, arrays, keys, strings));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).slice(0, keys).map(([key, child]) => [key, shrink(child, arrays, keys, strings)]));
    return typeof item === 'string' ? item.slice(0, strings) : item;
  };
  for (const [arrays, keys, strings] of [[3, 35, 200], [2, 25, 160], [1, 16, 120], [1, 8, 80]]) {
    const condensed = JSON.stringify(shrink(value, arrays, keys, strings));
    const note = `Structured JSON condensed: first ${arrays} array items and ${keys} object fields are shown.\n`;
    if (note.length + condensed.length <= maxChars) return note + condensed;
  }
  return `Structured JSON condensed: the response is too large to show in full. Top-level fields: ${Object.keys(value ?? {}).slice(0, 30).join(', ')}.\n${JSON.stringify(shrink(value, 1, 4, 50)).slice(0, maxChars - 200)}`;
}

export function apply(ctx) {
  const wrapFetch = () => {
    let agents;
    try { agents = ctx.get('agents')?.list?.() ?? []; } catch { return; }
    for (const agent of agents) {
      const def = ctx.tools.get('web_fetch', agent);
      if (!def || wrappedFetch.has(def)) continue;
      wrappedFetch.add(def);
      const original = def.execute;
      def.execute = async function execute(args, exec) {
        const result = await original.call(this, args, exec);
        if (result?.body?.kind !== 'text' || typeof result.body.content !== 'string') return result;
        const content = compactJsonBody(result.body.content);
        return content === result.body.content ? result : { ...result, body: { ...result.body, content }, truncated: false };
      };
    }
  };
  ctx.on('tools/change', wrapFetch);
  wrapFetch();
  ctx.tools.register({
    name: CATALOG,
    description: 'Find tools only when needed. Choose groups: files, shell, jobs, web, browser, devtools, skills, helpers, goals, questions, todo, present, connected, or all. If a group is large, call again with names to get full argument schemas. Then call tool_dispatch. A simple reply needs no tool call.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      groups: { type: 'array', minItems: 1, items: { type: 'string', enum: [...CATEGORIES, 'all'] } },
      names: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' }, description: 'Exact tool names whose full argument schemas are needed.' },
    } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      const chosen = Array.isArray(args?.groups) ? args.groups.filter(group => CATEGORIES.includes(group) || group === 'all') : [];
      const available = ctx.tools.schemas(exec.agent).filter(tool => tool.name !== CATALOG && tool.name !== DISPATCH);
      if (Array.isArray(args?.names) && args.names.length) {
        const schemas = available.filter(tool => args.names.includes(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters }));
        if (!schemas.length) return 'No enabled tool with those names.';
        const detail = `Call tool_dispatch with one of these tools: ${JSON.stringify(schemas)}`;
        if (detail.length <= 7000) return detail;
        if (schemas.length > 1) return 'Those schemas are too large together. Call tool_catalog with one name at a time.';
        const tool = schemas[0];
        const fields = Object.fromEntries(Object.entries(tool.parameters?.properties ?? {}).map(([key, value]) =>
          [key, { type: value.type, description: value.description?.slice(0, 140), enum: value.enum, required: value.required }]));
        return `Call tool_dispatch with ${tool.name}. Its required fields are ${JSON.stringify(tool.parameters?.required ?? [])}; argument fields: ${JSON.stringify(fields).slice(0, 6200)}.`;
      }
      if (!chosen.length) return 'Choose a group from the tool_catalog description.';
      const availableGroups = new Set(available.map(tool => category(tool.name)));
      const loaded = chosen.filter(group => group === 'all' ? available.length > 0 : availableGroups.has(group));
      if (!loaded.length) return `No enabled tools in ${chosen.join(', ')}. Available groups: ${[...availableGroups].join(', ') || 'none'}.`;
      const schemas = available.filter(tool => loaded.includes('all') || loaded.includes(category(tool.name)))
        .map(({ name, description, parameters }) => ({ name, description, parameters }));
      const ssh = loaded.includes('shell') || loaded.includes('all')
        ? ' For SSH, use noninteractive authentication (BatchMode=yes), a short ConnectTimeout and one connection attempt. Give long remote commands a bounded timeout or run them as a background job. After Permission denied (publickey), stop retrying the same credentials and diagnose the key or agent once.'
        : '';
      const detailed = `Call tool_dispatch with the exact tool name and arguments from these schemas: ${JSON.stringify(schemas)}${ssh}`;
      if (detailed.length <= 7000) return detailed;
      const brief = schemas.map(({ name, description, parameters }) => ({ name, description: description?.slice(0, 130), required: parameters?.required, arguments: Object.keys(parameters?.properties ?? {}) }));
      const summary = `Available tools: ${JSON.stringify(brief)}. Call tool_catalog with names to get the full schema before tool_dispatch.${ssh}`;
      return summary.length <= 7000 ? summary : `Available tool names: ${schemas.map(tool => tool.name).join(', ')}. Call tool_catalog with names for the schema of the one you need.${ssh}`;
    },
  });
  ctx.tools.register({
    name: DISPATCH,
    description: 'Run one enabled tool by its exact name. Use tool_catalog first if you need its argument schema. The named tool still runs through its normal permissions and safety checks.',
    parameters: { type: 'object', additionalProperties: false, required: ['name', 'arguments'], properties: {
      name: { type: 'string' }, arguments: { type: 'object' },
    } },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: `${value.name}: ${value.isError ? 'failed' : 'finished'}` }, ...(value.content ?? [])],
    },
    async execute(args, exec) {
      const name = args?.name;
      if (typeof name !== 'string' || name === CATALOG || name === DISPATCH || !ctx.tools.get(name, exec.agent)) {
        return { name: String(name), isError: true, content: [{ type: 'text', text: 'Tool is unavailable. Call tool_catalog to see enabled tools.' }] };
      }
      markApprovedDispatch(exec.token, name);
      let result;
      try {
        result = await ctx.tools.execute({
          callId: `${exec.callId}:dispatch:${randomUUID()}`, rootCallId: exec.rootCallId,
          name, arguments: args.arguments, agent: exec.agent, parent: exec.token, signal: exec.signal,
        });
      } finally { clearApprovedDispatch(exec.token); }
      if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').filter(Boolean).join('\n') || result.error?.message || `${name} failed`);
      for (const context of result.additionalContexts ?? []) exec.deferContext(context);
      if (result.concludesTurn) exec.concludeTurn();
      return { name, isError: result.isError, content: result.content };
    },
  });
  if (typeof ctx.llm.prepareCall === 'function') {
    const original = ctx.llm.prepareCall;
    ctx.llm.prepareCall = async function prepareCall(...args) {
      const prepared = await original.apply(this, args);
      if (!prepared?.stream) return prepared;
      const stream = prepared.stream;
      return { ...prepared, stream(options) {
        if (options?.purpose === 'compaction') return stream(options);
        return stream({ ...options, tools: visibleTools(options?.sessionId, options?.tools) });
      } };
    };
  }
}
