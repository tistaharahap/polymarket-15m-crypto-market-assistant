export function get15mWindowTiming(nowMs = Date.now()) {
  const windowMs = 15 * 60_000;
  const startMs = Math.floor(nowMs / windowMs) * windowMs;
  const endMs = startMs + windowMs;
  return {
    startMs,
    endMs,
    elapsedMinutes: (nowMs - startMs) / 60_000,
    remainingMinutes: (endMs - nowMs) / 60_000
  };
}
