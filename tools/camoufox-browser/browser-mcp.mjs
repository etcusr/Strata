#!/usr/bin/env node
// Local Camoufox MCP adapter. It starts the browser only on the first browser call.
import { createInterface } from 'node:readline';

const MAX_TEXT = 12_000;
const PAGE_CREATE_TIMEOUT_MS = 15_000;
const CLOUDFLARE_POLL_MS = 400;
const SCREENSHOT_MAX_AGE_MS = 60_000;
const tools = [
  { name: 'navigate', description: 'Open an HTTP(S) page in the active tab. Use this for web search and source pages.', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Full http:// or https:// URL.' }, tabId: { type: 'string', description: 'Existing tab ID; omit for the active tab.' } }, required: ['url'], additionalProperties: false } },
  { name: 'snapshot', description: 'Read the active page as a compact accessibility tree. Usually call this before clicking.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, additionalProperties: false } },
  { name: 'links', description: 'List visible page links with their destination URLs. Useful for search results and source verification.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false } },
  { name: 'cloudflare_status', description: 'Check a Cloudflare verification page. With maxWaitMs, return as soon as verification clears or a visible checkbox appears in any frame; the limit only prevents an endless wait.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, maxWaitMs: { type: 'integer', minimum: 0, maximum: 60_000 } }, additionalProperties: false } },
  { name: 'click', description: 'Click an observed page element by role plus name, text alone, or CSS selector alone, searching visible frames. Do not infer a checkbox from a verification spinner. If role and text are given, text is the role name.', inputSchema: { type: 'object', properties: { role: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' }, selector: { type: 'string' }, exact: { type: 'boolean' }, tabId: { type: 'string' } }, additionalProperties: false } },
  { name: 'click_at', description: 'Click a visible control at a position relative to the latest page screenshot: x=0 is left, x=1 is right, y=0 is top, y=1 is bottom. Use only after observing the control; never click a verification spinner.', inputSchema: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 }, tabId: { type: 'string' } }, required: ['x', 'y'], additionalProperties: false } },
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
const screenshots = new WeakMap();

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
  const methods = Number(Boolean(args.selector)) + Number(Boolean(args.role)) + Number(allowText && !args.role && Boolean(args.text));
  if (methods !== 1) throw new Error('Give exactly one selector, role, or text target.');
  if (args.role) {
    const name = args.name ?? (allowText ? args.text : null);
    if (!name && args.role !== 'checkbox') throw new Error('A role target also needs a name.');
    if (!name) return page.getByRole('checkbox');
    return page.getByRole(args.role, { name, exact: args.exact !== false });
  }
  if (args.selector) return page.locator(args.selector);
  return page.getByText(args.text, { exact: args.exact !== false });
}

async function visibleTarget(page, args) {
  for (const [frameIndex, frame] of page.frames().entries()) {
    try {
      const locator = target(frame, args, true);
      const count = Math.min(await locator.count(), 20);
      for (let index = 0; index < count; index++) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible()) return { locator: candidate, frameIndex };
      }
    } catch (error) {
      // A frame can detach while a challenge refreshes. Invalid target arguments
      // still need to reach the caller instead of being mistaken for a miss.
      if (String(error?.message ?? error).includes('Give exactly one') || String(error?.message ?? error).includes('also needs a name')) throw error;
    }
  }
  return null;
}

async function cloudflareState(page) {
  const title = await page.title().catch(() => '');
  const frames = page.frames();
  const challenge = await page.evaluate(() => {
    const body = document.body?.innerText?.slice(0, 3_000) ?? '';
    return Boolean(
      document.querySelector('#challenge-running, #challenge-stage, #challenge-form, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]')
      || /performing security verification|verifying you are human|verify you are human|checking your browser/i.test(body)
    );
  }).catch(() => false);
  const challengeTitle = /just a moment|security verification|attention required|verify you are human/i.test(title);
  const challengeFrame = frames.some(frame => frame.url().includes('challenges.cloudflare.com'));
  if (!challenge && !challengeTitle && !challengeFrame) return { status: 'clear', checkboxVisible: false, title };
  for (const [frameIndex, frame] of frames.entries()) {
    try {
      const locator = frame.getByRole('checkbox');
      const count = Math.min(await locator.count(), 20);
      for (let index = 0; index < count; index++) {
        const checkbox = locator.nth(index);
        if (await checkbox.isVisible()) {
          return { status: 'checkbox', checkboxVisible: true, frameIndex, title };
        }
      }
    } catch { /* Challenge frame reloaded while being inspected. */ }
  }
  return { status: 'verifying', checkboxVisible: false, title };
}

async function waitForCloudflare(page, maxWaitMs) {
  const limit = maxWaitMs === undefined ? 30_000 : Number(maxWaitMs);
  if (!Number.isInteger(limit) || limit < 0 || limit > 60_000) throw new Error('maxWaitMs must be an integer from 0 to 60000.');
  const start = Date.now();
  let state;
  do {
    state = await cloudflareState(page);
    if (state.status !== 'verifying') break;
    const remaining = limit - (Date.now() - start);
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(CLOUDFLARE_POLL_MS, remaining)));
  } while (true);
  return { ...state, elapsedMs: Date.now() - start, url: page.url(), frameCount: page.frames().length };
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
  if (name === 'cloudflare_status') {
    return { tabId: id, ...await waitForCloudflare(page, args.maxWaitMs) };
  }
  if (name === 'click') {
    const found = await visibleTarget(page, args);
    if (!found) throw new Error('No visible matching element in the page or its frames. Read a fresh cloudflare_status and screenshot. A Cloudflare "Verifying..." spinner is not a checkbox.');
    await found.locator.click({ timeout: 5_000 });
    return { tabId: id, url: page.url(), title: await page.title(), frameIndex: found.frameIndex };
  }
  if (name === 'click_at') {
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw new Error('x and y must be numbers from 0 to 1.');
    const shot = screenshots.get(page);
    if (!shot || shot.url !== page.url() || Date.now() - shot.time > SCREENSHOT_MAX_AGE_MS) throw new Error('Take a fresh screenshot of this tab before using click_at.');
    const size = page.viewportSize();
    if (!size?.width || !size?.height) throw new Error('The page viewport size is unavailable.');
    if (size.width !== shot.viewport.width || size.height !== shot.viewport.height) throw new Error('The page viewport changed. Take a fresh screenshot before using click_at.');
    await page.mouse.click(x * size.width, y * size.height);
    return { tabId: id, url: page.url(), x, y, viewport: size };
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
    const viewport = page.viewportSize();
    screenshots.set(page, { time: Date.now(), url: page.url(), viewport });
    return { image: image.toString('base64'), tabId: id, viewport };
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
          ? [{ type: 'text', text: JSON.stringify({ tabId: result.tabId, viewport: result.viewport, coordinates: 'x and y are fractions of this screenshot, from 0 to 1' }) }, { type: 'image', mimeType: 'image/jpeg', data: result.image }]
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
