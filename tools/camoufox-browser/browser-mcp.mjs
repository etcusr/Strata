#!/usr/bin/env node
// Local Camoufox MCP adapter. It starts the browser only on the first browser call.
import { createInterface } from 'node:readline';

const MAX_TEXT = 12_000;
const PAGE_CREATE_TIMEOUT_MS = 15_000;
const tools = [
  { name: 'navigate', description: 'Open an HTTP(S) page in the active tab. Use this for web search and source pages.', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Full http:// or https:// URL.' }, tabId: { type: 'string', description: 'Existing tab ID; omit for the active tab.' } }, required: ['url'], additionalProperties: false } },
  { name: 'snapshot', description: 'Read the active page as a compact accessibility tree. Usually call this before clicking.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, additionalProperties: false } },
  { name: 'links', description: 'List visible page links with their destination URLs. Useful for search results and source verification.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false } },
  { name: 'click', description: 'Click one page element by accessible role and name, text, or CSS selector.', inputSchema: { type: 'object', properties: { role: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' }, selector: { type: 'string' }, exact: { type: 'boolean' }, tabId: { type: 'string' } }, additionalProperties: false } },
  { name: 'fill', description: 'Fill an input by accessible role and name or CSS selector.', inputSchema: { type: 'object', properties: { value: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' }, selector: { type: 'string' }, tabId: { type: 'string' } }, required: ['value'], additionalProperties: false } },
  { name: 'press', description: 'Press a key such as Enter, Escape, or Tab, optionally in a CSS-selected element.', inputSchema: { type: 'object', properties: { key: { type: 'string' }, selector: { type: 'string' }, tabId: { type: 'string' } }, required: ['key'], additionalProperties: false } },
  { name: 'scroll', description: 'Scroll the page by a number of pixels.', inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, pixels: { type: 'integer', minimum: 1, maximum: 5000 }, tabId: { type: 'string' } }, required: ['direction'], additionalProperties: false } },
  { name: 'screenshot', description: 'Capture the visible tab as a JPEG image. Use when page layout or a visual challenge matters.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, additionalProperties: false } },
  { name: 'evaluate', description: 'Run JavaScript in the active page for targeted extraction or inspection. Keep results small.', inputSchema: { type: 'object', properties: { script: { type: 'string' }, tabId: { type: 'string' } }, required: ['script'], additionalProperties: false } },
  { name: 'tabs', description: 'List, select, create, or close browser tabs. The browser is private to this MCP process.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'select', 'new', 'close'] }, tabId: { type: 'string' }, url: { type: 'string' } }, additionalProperties: false } },
];

let browser;
let context;
let launchPromise;
let activeTabId;
let nextTabId = 1;
const tabs = new Map();
const ids = new WeakMap();

function register(page) {
  let id = ids.get(page);
  if (!id) {
    id = `tab-${nextTabId++}`;
    ids.set(page, id);
    tabs.set(id, page);
    page.once('close', () => {
      tabs.delete(id);
      if (activeTabId === id) activeTabId = tabs.keys().next().value;
    });
  }
  activeTabId = id;
  return id;
}

async function ensureBrowser() {
  if (context) return;
  if (!launchPromise) {
    launchPromise = (async () => {
      const { Camoufox, NewContext } = await import('camoufox');
      const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
      const launched = await Camoufox({ headless: process.env.STRATA_CAMOUFOX_HEADLESS === '1', os, timeout: 30_000 });
      try {
        const created = await NewContext(launched, { viewport: { width: 1280, height: 900 } });
        created.on('page', page => {
          // A timed-out newPage may complete after this context was discarded.
          // Do not put that late page back into the active tab registry.
          if (context === created) register(page);
          else void page.close().catch(() => {});
        });
        browser = launched;
        context = created;
      } catch (error) {
        await launched.close();
        throw error;
      }
    })().catch(error => { launchPromise = undefined; throw error; });
  }
  await launchPromise;
}

async function openPage() {
  let timer;
  try {
    return await Promise.race([
      context.newPage(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Camoufox page creation timed out after ${PAGE_CREATE_TIMEOUT_MS}ms`)), PAGE_CREATE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function discardBrowser() {
  const failedBrowser = browser;
  const failedContext = context;
  browser = undefined;
  context = undefined;
  launchPromise = undefined;
  activeTabId = undefined;
  await failedContext?.close().catch(() => {});
  await failedBrowser?.close().catch(() => {});
  tabs.clear();
}

async function createPage() {
  try {
    return await openPage();
  } catch (firstError) {
    // A fresh Camoufox instance can occasionally have no browser window when
    // Juggler receives Browser.newPage. Preserve existing tabs if this is a
    // later-page failure; only the first page may restart the browser once.
    if (tabs.size) throw firstError;
    try {
      await discardBrowser();
      await ensureBrowser();
      return await openPage();
    } catch (retryError) {
      await discardBrowser();
      throw new Error(`Camoufox could not open its first tab. First attempt: ${String(firstError?.message ?? firstError)}. Retry after a fresh browser: ${String(retryError?.message ?? retryError)}`, { cause: retryError });
    }
  }
}

async function pageFor(tabId) {
  await ensureBrowser();
  const id = tabId ?? activeTabId;
  if (id && tabs.has(id)) return [id, tabs.get(id)];
  if (tabId) throw new Error(`Unknown tab ID: ${tabId}`);
  const page = await createPage();
  return [register(page), page];
}

function safeUrl(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { throw new Error('Use a full HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are supported.');
  return parsed.href;
}

function short(value, limit = MAX_TEXT) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]`;
}

function target(page, args, allowText = false) {
  const methods = Number(Boolean(args.selector)) + Number(Boolean(args.role)) + Number(allowText && Boolean(args.text));
  if (methods !== 1) throw new Error('Give exactly one selector, role, or text target.');
  if (args.role) {
    if (!args.name) throw new Error('A role target also needs a name.');
    return page.getByRole(args.role, { name: args.name, exact: args.exact !== false });
  }
  if (args.selector) return page.locator(args.selector);
  return page.getByText(args.text, { exact: args.exact !== false });
}

async function tabList() {
  const rows = await Promise.all([...tabs].map(async ([id, page]) => ({
    id, active: id === activeTabId, url: page.url(), title: await page.title().catch(() => ''),
  })));
  return rows;
}

async function call(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  if (name === 'tabs') {
    await ensureBrowser();
    const action = args.action ?? 'list';
    if (action === 'list') return tabList();
    if (action === 'new') {
      const page = await createPage();
      const id = register(page);
      if (args.url) await page.goto(safeUrl(args.url), { waitUntil: 'domcontentloaded', timeout: 25_000 });
      return { id, url: page.url(), title: await page.title() };
    }
    const page = tabs.get(args.tabId);
    if (!page) throw new Error(`Unknown tab ID: ${args.tabId}`);
    if (action === 'select') { activeTabId = args.tabId; return tabList(); }
    if (action === 'close') { await page.close(); return tabList(); }
    throw new Error(`Unknown tab action: ${action}`);
  }

  const [id, page] = await pageFor(args.tabId);
  if (name === 'navigate') {
    await page.goto(safeUrl(args.url), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    return { tabId: id, url: page.url(), title: await page.title() };
  }
  if (name === 'snapshot') {
    const tree = await page.locator('body').ariaSnapshot({ timeout: 10_000 });
    return short(`Tab: ${id}\nURL: ${page.url()}\nTitle: ${await page.title()}\n${tree}`);
  }
  if (name === 'links') {
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 50));
    const links = await page.locator('a[href]').evaluateAll((nodes, max) => nodes
      .filter(node => node.getClientRects().length > 0)
      .map(node => ({ text: (node.innerText || node.getAttribute('aria-label') || '').trim().slice(0, 160), url: node.href }))
      .filter(link => link.url.startsWith('http'))
      .slice(0, max), limit);
    return links;
  }
  if (name === 'click') {
    await target(page, args, true).click({ timeout: 10_000 });
    return { tabId: id, url: page.url(), title: await page.title() };
  }
  if (name === 'fill') {
    await target(page, args).fill(String(args.value), { timeout: 10_000 });
    return { tabId: id, filled: true };
  }
  if (name === 'press') {
    if (args.selector) await page.locator(args.selector).press(String(args.key), { timeout: 10_000 });
    else await page.keyboard.press(String(args.key));
    return { tabId: id, url: page.url() };
  }
  if (name === 'scroll') {
    const pixels = Math.min(5000, Math.max(1, Number(args.pixels) || 650));
    const vector = { up: [0, -pixels], down: [0, pixels], left: [-pixels, 0], right: [pixels, 0] }[args.direction];
    if (!vector) throw new Error('Direction must be up, down, left, or right.');
    await page.mouse.wheel(...vector);
    return { tabId: id, scrolled: `${args.direction} ${pixels}px` };
  }
  if (name === 'screenshot') {
    const image = await page.screenshot({ type: 'jpeg', quality: 68, fullPage: false, timeout: 15_000 });
    return { image: image.toString('base64') };
  }
  if (name === 'evaluate') {
    const result = await page.evaluate(String(args.script));
    return short(result);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); }
let queue = Promise.resolve();

async function handle(line) {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  const { id, method, params } = request;
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'camoufox-local', version: '1.0.0' } } });
  } else if (method === 'ping') {
    send({ id, result: {} });
  } else if (method === 'tools/list') {
    send({ id, result: { tools } });
  } else if (method === 'tools/call') {
    queue = queue.catch(() => {}).then(async () => {
      try {
        const result = await call(String(params?.name), params?.arguments ?? {});
        const content = result?.image
          ? [{ type: 'image', mimeType: 'image/jpeg', data: result.image }]
          : [{ type: 'text', text: short(result) }];
        send({ id, result: { content } });
      } catch (error) {
        send({ id, result: { isError: true, content: [{ type: 'text', text: String(error?.message ?? error).slice(0, 1200) }] } });
      }
    });
  } else {
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

createInterface({ input: process.stdin }).on('line', line => { void handle(line); }).on('close', () => {
  queue.finally(async () => { await browser?.close().catch(() => {}); process.exit(0); });
});
