import { useSyncExternalStore } from 'react';
import { tr } from './i18n';

/**
 * The one transient line under the newest message while the model works (frames from the host: `status`, see notes-split-agent3.md).
 * Only the LATEST frame of a turn is kept; it is removed on `idle`, on `done` and `error`, and when the stream ends, so the line can never
 * show something that stopped being true.
 */
export interface StatusFrame {
  seq: number;
  phase: string;
  code: string;
  text: string;
  args?: Record<string, unknown>;
  tokens?: number;
  elapsedMs: number;
  /** When this page received the frame; elapsed time keeps counting from it between frames. */
  receivedAt: number;
}

const frames = new Map<string, StatusFrame>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());

/** Take a status frame for a chat. An older frame (lower `seq`) never replaces a newer one. Returns whether the line changed. */
export function applyStatusFrame(sessionId: string, raw: Record<string, unknown>, now = Date.now()): boolean {
  const seq = Number(raw.seq);
  const phase = String(raw.phase ?? '');
  const current = frames.get(sessionId);
  if (Number.isFinite(seq) && current && seq < current.seq) return false;
  if (phase === 'idle' || !phase) { const had = frames.delete(sessionId); if (had) emit(); return had; }
  frames.set(sessionId, {
    seq: Number.isFinite(seq) ? seq : (current?.seq ?? 0) + 1,
    phase, code: String(raw.code ?? phase), text: String(raw.text ?? ''),
    args: raw.args && typeof raw.args === 'object' ? raw.args as Record<string, unknown> : undefined,
    tokens: typeof raw.tokens === 'number' ? raw.tokens : undefined,
    elapsedMs: Number(raw.elapsedMs) || 0, receivedAt: now,
  });
  emit();
  return true;
}

export function clearStatus(sessionId: string) { if (frames.delete(sessionId)) emit(); }
export const statusOf = (sessionId: string | null | undefined): StatusFrame | null => (sessionId ? frames.get(sessionId) ?? null : null);

export function useLiveStatus(sessionId: string | null | undefined): StatusFrame | null {
  return useSyncExternalStore(
    fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => statusOf(sessionId),
    () => null,
  );
}

/** Only engine facts from the local model are used here; a cloud model has no local prompt progress. */
export interface PromptActivity {
  phase: string;
  prompt?: { done: number; total: number };
  generated?: number;
}

/** The native monitor is shared by all chats. Show its progress only for a request started by this turn. */
export function nativeActivityForTurn(metrics: { time?: number; live?: Record<string, unknown> } | null | undefined, startedAt: number): PromptActivity | null {
  const live = metrics?.live;
  if (!live || !['reading', 'generating'].includes(String(live.state))) return null;
  const elapsed = Number(live.elapsed_s), sampled = Number(metrics?.time);
  if (!Number.isFinite(elapsed) || !Number.isFinite(sampled)) return null;
  if (sampled * 1000 - elapsed * 1000 < startedAt - 5000) return { phase: 'busy-other' };
  return { phase: String(live.state), prompt: { done: Number(live.prompt_read) || 0, total: Number(live.prompt_total) || 0 }, generated: Number(live.generated) || 0 };
}

/** Describe observed work. Never rotate invented descriptions while a model request is running. */
export function statusWords(frame: StatusFrame, engine?: PromptActivity | null): string {
  if (['starting', 'waiting', 'thinking'].includes(frame.phase) && engine?.phase === 'busy-other') return tr('Local model busy with another request…');
  if (['starting', 'waiting', 'thinking'].includes(frame.phase) && engine?.phase === 'reading') {
    const done = Number(engine.prompt?.done), total = Number(engine.prompt?.total);
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0)
      return `${tr('Reading prompt')} · ${Math.min(total, Math.max(0, Math.round(done))).toLocaleString()} / ${Math.round(total).toLocaleString()} ${tr('tokens')}`;
    return `${tr('Reading prompt')}…`;
  }
  if (['starting', 'waiting', 'thinking'].includes(frame.phase) && engine?.phase === 'generating') {
    const generated = Number(engine.generated);
    return Number.isFinite(generated) && generated > 0 ? `${tr('Generating model output…')} · ${Math.round(generated).toLocaleString()} ${tr('tokens')}` : tr('Generating model output…');
  }
  if (frame.phase === 'thinking') return tr('Generating reasoning…');
  const a = frame.args ?? {};
  const target = typeof a.target === 'string' && a.target ? a.target : '';
  switch (frame.code) {
    case 'starting': return tr('Starting…');
    case 'reading-prompt': return tr('Reading your message…');
    case 'model-working': return tr('Waiting for model output…');
    case 'answering': return tr('Writing the answer…');
    case 'preparing-tool': case 'tool': {
      const verb = typeof a.verb === 'string' && a.verb ? tr(a.verb) : '';
      return verb ? `${verb}${target ? ` · ${target}` : ''}…` : tr(frame.text);
    }
    case 'waiting-approval': return tr('Waiting for your answer…');
    case 'helpers': return tr('Helpers are working ({0})…', [Number(a.n) || 1]);
    case 'goal-step': return tr('Working on the goal…');
    default: return tr(frame.text);
  }
}

/** "14s", "1m 04s": how long the turn has been going. */
export function elapsedText(startedAt: number, now: number): string {
  const total = Math.max(0, Math.round((now - startedAt) / 1000));
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}
