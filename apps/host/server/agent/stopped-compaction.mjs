/** Loop guards are not evidence that a summary is needed. Unknown pressure defers to the next request's normal checks. */
export function shouldCompactStoppedTurn({ tokens, threshold }) {
  return Number.isFinite(tokens) && Number.isFinite(threshold) && threshold > 0 && tokens >= threshold;
}
