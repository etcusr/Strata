import { ToolArchive, previewArchived, pruneArchivedResults } from '../tool-archive.mjs';
export const name = 'strata-tool-archive';
export const inject = ['tools', 'toolResultPruner', 'tokenMeter'];
export function apply(ctx, config) {
  const archive = new ToolArchive(config.root);
  const warn = () => { try { ctx.logger?.warn?.('strata-tool-archive: could not preserve a result; keeping its full inline content'); } catch {} };
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision;
    // Preserve the accepted content. Other policies may redact or spill it; their authority is retained.
    const content = decision.content ?? result.content;
    if (!Array.isArray(content) || !content.some(b => b.type === 'text' && b.text)) return decision;
    try {
      const receipt = archive.save(exec.agent?.session?.id ?? exec.agent?.session?.header?.id, exec.callId, exec.name, content, config);
      // Respect other post-policies (including redaction or spills), and keep errors inline.
      if (decision.content || result.isError) return decision;
      // Avoid recursive previews when the model explicitly reads or searches the archive.
      const readName = exec.name === 'tool_dispatch' ? exec.arguments?.name : exec.name;
      const readArgs = exec.name === 'tool_dispatch' ? exec.arguments?.arguments : exec.arguments;
      const archiveRead = ['read', 'grep'].includes(readName) && Object.values(readArgs ?? {}).some(v => typeof v === 'string' && v.startsWith(archive.root + '/'));
      if (archiveRead) return { ...decision, content };
      if (content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 0), 0) <= (config.inlineChars ?? 6000)) return decision;
      return { ...decision, content: previewArchived(content, receipt, config.inlineChars ?? 6000) };
    } catch { warn(); return decision; }
  }, { prepend: true });
  // The native pruner discards middles. Replace that policy only in this opt-in preset scope.
  const original = ctx.toolResultPruner.pruneSession;
  ctx.toolResultPruner.pruneSession = session => pruneArchivedResults(session, ctx.tokenMeter, archive, config);
  ctx.on('dispose', () => { ctx.toolResultPruner.pruneSession = original; });
}
