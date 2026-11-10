/**
 * Keep tool schemas out of a request until the agent needs them.
 *
 * The Harness still owns and executes every enabled tool (and its permission
 * checks). This plugin changes only which schemas the model sees. A small
 * catalog tool activates a group for the rest of the current turn.
 */
export const name = 'strata-on-demand-tools';
export const inject = ['tools', 'llm'];

const groups = new Map();
const CATALOG = 'tool_catalog';
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

export function visibleTools(sessionId, tools) {
  if (!Array.isArray(tools)) return tools;
  const selected = groups.get(String(sessionId)) ?? new Set();
  const hasMore = tools.some(tool => tool.name !== CATALOG);
  return tools.filter(tool => (tool.name === CATALOG && hasMore) || selected.has('all') || selected.has(category(tool.name)));
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
    description: 'Load tools only when needed. Choose groups: files (read, edit, search files), shell (run commands), jobs, web (search or open pages), browser (Strata browser), devtools (connected Chrome DevTools), skills, helpers, goals, questions, todo, present, connected (other MCP servers), or all. Selected tools appear on your next step. For a simple reply, answer without calling this tool.',
    parameters: { type: 'object', additionalProperties: false, required: ['groups'], properties: {
      groups: { type: 'array', minItems: 1, items: { type: 'string', enum: [...CATEGORIES, 'all'] } },
    } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      const id = String(exec.agent.session.id);
      const chosen = Array.isArray(args?.groups) ? args.groups.filter(group => CATEGORIES.includes(group) || group === 'all') : [];
      if (!chosen.length) return 'Choose a group from the tool_catalog description.';
      const available = ctx.tools.schemas(exec.agent).filter(tool => tool.name !== CATALOG);
      const availableGroups = new Set(available.map(tool => category(tool.name)));
      const loaded = chosen.filter(group => group === 'all' ? available.length > 0 : availableGroups.has(group));
      if (!loaded.length) return `No enabled tools in ${chosen.join(', ')}. Available groups: ${[...availableGroups].join(', ') || 'none'}.`;
      const selected = groups.get(id) ?? new Set();
      for (const group of loaded) selected.add(group);
      groups.set(id, selected);
      const names = available.filter(tool => loaded.includes('all') || loaded.includes(category(tool.name))).map(tool => tool.name);
      const ssh = loaded.includes('shell') || loaded.includes('all')
        ? ' For SSH, use noninteractive authentication (BatchMode=yes), a short ConnectTimeout and one connection attempt. Give long remote commands a bounded timeout or run them as a background job. After Permission denied (publickey), stop retrying the same credentials and diagnose the key or agent once.'
        : '';
      return `Loaded ${loaded.join(', ')} tools for this turn: ${names.join(', ')}. Continue the task using the newly available tools.${ssh}`;
    },
  });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') groups.delete(String(session.id));
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
