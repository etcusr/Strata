import { useEffect, useState } from 'react';
import { tr } from '../lib/i18n';
import { elapsedText, nativeActivityForTurn, statusWords, useLiveStatus } from '../lib/live-status';
import { useStore } from '../lib/store';
import { useNative } from '../lib/native';

/**
 * The line under the newest message while the model works: a small pulse, what it is doing (a playful word while it only thinks,
 * the real action once a tool runs), how long, and how many tokens. It shows the latest status frame only and nothing older.
 */
export function StatusLine({ sessionId, startedAt, tokens, remoteModel, activeTool }: { sessionId: string | null; startedAt: number; tokens?: number; remoteModel?: boolean; activeTool?: string }) {
  const frame = useLiveStatus(sessionId);
  const monitor = useStore(s => s.monitor);
  const activeChats = useStore(s => s.sessions.filter(chat => chat.messages.some(message => message.streaming)).length);
  const native = useNative();
  const nativeMetrics = native?.instances.find(i => i.id === native.defaultId)?.metrics;
  const engine = activeChats > 1 ? null : nativeActivityForTurn(nativeMetrics, startedAt) ?? monitor;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!frame) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [!!frame]);
  if (!frame) return null;
  const count = frame.tokens ?? tokens;
  const reading = !remoteModel && engine?.phase === 'reading' && ['starting', 'waiting', 'thinking'].includes(frame.phase);
  const words = statusWords(frame, remoteModel ? null : engine);
  return <div className="live-status" data-phase={frame.phase} aria-live="off">
    <span className="live-status__pulse" aria-hidden="true"><i/><i/></span>
    <span className="live-status__verb" key={frame.code + String(frame.args?.target ?? '')} title={words}>{words}{activeTool ? <span className="live-status__tool"> · {activeTool}</span> : null}</span>
    <span className="live-status__time">{elapsedText(startedAt, now)}</span>
    <span className="live-status__tokens">{!reading && count ? tr('{0} tokens', [count.toLocaleString()]) : ''}</span>
  </div>;
}
