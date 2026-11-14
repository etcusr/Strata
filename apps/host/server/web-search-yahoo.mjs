/** Parse Yahoo's public web results without returning its tracking redirects. */

const decode = text => String(text).replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp|middot|mdash|ndash|deg|minus|hellip);/gi, (whole, key) => {
  if (key[0] === '#') {
    const value = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : whole;
  }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', deg: '°', minus: '−', hellip: '…' }[key.toLowerCase()] ?? whole;
});
const plain = html => decode(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

export const YAHOO_URL = 'https://search.yahoo.com/search';

export function yahooTarget(href) {
  try {
    const address = new URL(decode(href), YAHOO_URL);
    let target = address;
    if (address.hostname === 'r.search.yahoo.com') {
      const wrapped = /\/RU=([^/]+)(?:\/|$)/.exec(address.pathname)?.[1];
      if (!wrapped) return null;
      target = new URL(decodeURIComponent(wrapped));
    } else if (/(^|\.)yahoo\.com$/i.test(address.hostname)) return null;
    return /^https?:$/.test(target.protocol) ? target.href : null;
  } catch { return null; }
}

export function parseYahooResults(html) {
  const out = [], seen = new Set();
  const text = String(html);
  const blocks = [...text.matchAll(/<div\b[^>]*class="[^"]*\balgo\s[^"]*"[^>]*>/gi)];
  for (let i = 0; i < blocks.length; i++) {
    // Result cards contain nested list items before the title, so the next card is the safe boundary.
    const body = text.slice(blocks[i].index, blocks[i + 1]?.index ?? text.length);
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(body);
    const link = /<div\b[^>]*class="[^"]*\bcompTitle\b[^"]*"[^>]*>[\s\S]*?<a\b([^>]*)>/i.exec(body);
    const href = /\bhref="([^"]*)"/i.exec(link?.[1] ?? '')?.[1];
    const url = href ? yahooTarget(href) : null;
    const title = heading ? plain(heading[1]) : '';
    if (!url || !title || seen.has(url)) continue;
    const snippet = /<div\b[^>]*class="[^"]*\bcompText\b[^"]*"[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(body);
    seen.add(url);
    out.push({ url, title, ...(snippet ? { snippet: plain(snippet[1]) } : {}) });
  }
  return out;
}

export function yahooLooksBlocked(status, html) {
  if ([403, 429, 503].includes(status)) return true;
  const text = String(html).slice(0, 80_000);
  if (/<div\b[^>]*class="[^"]*\balgo\s/.test(text)) return false;
  return /captcha|unusual traffic|verify you are human|robot check|challenge-platform/i.test(text);
}

export function yahooNoResults(html) {
  return /(?:no results found|we did not find results|try different keywords)/i.test(String(html).slice(0, 100_000));
}
