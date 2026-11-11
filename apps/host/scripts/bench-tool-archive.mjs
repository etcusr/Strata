#!/usr/bin/env node
// Synthetic data only. Reports disk/JS cost separately from reduced model-visible characters.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ToolArchive, previewArchived } from '../server/agent/tool-archive.mjs';
const root = mkdtempSync(join(tmpdir(), 'strata-archive-bench-'));
try {
  const archive = new ToolArchive(root), count = 32, data = [];
  for (let i = 0; i < count; i++) data.push([{ type: 'text', text: `${i}: start\n` + 'log line with routine data\n'.repeat(1000) + `\nrequired: fact-${i}; port 7319\n` + 'log line with routine data\n'.repeat(1000) }]);
  const start = performance.now();
  const receipts = data.map((c, i) => archive.save('bench', `call-${i}`, 'shell', c));
  const saved = performance.now();
  const previews = data.map((c, i) => previewArchived(c, receipts[i]));
  const previewed = performance.now();
  const allFactsRecoverable = receipts.every((r, i) => readFileSync(r.textPath, 'utf8') === data[i][0].text);
  const result = { results: count, sourceChars: data.reduce((n, c) => n + c[0].text.length, 0), inlineChars: previews.reduce((n, c) => n + c[0].text.length, 0), archiveWriteMs: saved - start, previewMs: previewed - saved, integrityReadMs: performance.now() - previewed, allFactsRecoverable, rssBytes: process.memoryUsage().rss };
  console.log(JSON.stringify(result, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
