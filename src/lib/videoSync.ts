export const VIDEO_SYNC_INTERVAL_MS = 600
export const VIDEO_SYNC_SETTLED_DRIFT_SECONDS = .1
export const VIDEO_SYNC_GENTLE_DRIFT_SECONDS = .5
export const VIDEO_SYNC_HARD_SEEK_DRIFT_SECONDS = 1
export const VIDEO_SYNC_HARD_SEEK_COOLDOWN_MS = 5_000

export type VideoSyncDecision = { playbackRate: number; hardSeek: boolean }
export type VideoSyncDiagnostics = { driftMs: number; playbackRate: number; hardSeekCount: number; lastHardSeekAtMs?: number }

export function wrappedVideoDrift(expected: number, current: number, duration: number, loop: boolean) {
  let drift = expected - current
  if (loop && Math.abs(drift) > duration / 2) drift -= Math.sign(drift) * duration
  return drift
}

export function videoSyncDecision(driftSeconds: number, nowMs: number, lastHardSeekAtMs: number | null): VideoSyncDecision {
  const magnitude = Math.abs(driftSeconds)
  if (magnitude <= VIDEO_SYNC_SETTLED_DRIFT_SECONDS) return { playbackRate: 1, hardSeek: false }
  if (magnitude > VIDEO_SYNC_HARD_SEEK_DRIFT_SECONDS && (lastHardSeekAtMs === null || nowMs - lastHardSeekAtMs >= VIDEO_SYNC_HARD_SEEK_COOLDOWN_MS)) return { playbackRate: 1, hardSeek: true }
  if (magnitude <= VIDEO_SYNC_GENTLE_DRIFT_SECONDS) return { playbackRate: Math.max(.97, Math.min(1.03, 1 + driftSeconds * .075)), hardSeek: false }
  const correction = .03 + Math.min(.02, (magnitude - VIDEO_SYNC_GENTLE_DRIFT_SECONDS) * .04)
  return { playbackRate: 1 + Math.sign(driftSeconds) * correction, hardSeek: false }
}
