export const VIDEO_SYNC_INTERVAL_MS = 500
export const VIDEO_SYNC_SETTLED_DRIFT_SECONDS = .06
export const VIDEO_SYNC_GENTLE_DRIFT_SECONDS = .3
export const VIDEO_SYNC_STRONG_DRIFT_SECONDS = .7
export const VIDEO_SYNC_HARD_SEEK_DRIFT_SECONDS = .95
export const VIDEO_SYNC_HARD_SEEK_COOLDOWN_MS = 5_000

export type VideoSyncBand = 'SYNCED' | 'GENTLE' | 'STRONG' | 'RECOVERY'
export type VideoSyncDecision = { playbackRate: number; hardSeek: boolean; band: VideoSyncBand }
export type VideoSyncDiagnostics = { driftMs: number; playbackRate: number; band: VideoSyncBand; hardSeekCount: number; lastHardSeekAtMs?: number }

export function wrappedVideoDrift(expected: number, current: number, duration: number, loop: boolean) {
  let drift = expected - current
  if (loop && Math.abs(drift) > duration / 2) drift -= Math.sign(drift) * duration
  return drift
}

export function videoSyncDecision(driftSeconds: number, nowMs: number, lastHardSeekAtMs: number | null): VideoSyncDecision {
  const magnitude = Math.abs(driftSeconds)
  if (magnitude <= VIDEO_SYNC_SETTLED_DRIFT_SECONDS) return { playbackRate: 1, hardSeek: false, band: 'SYNCED' }
  if (magnitude > VIDEO_SYNC_HARD_SEEK_DRIFT_SECONDS && (lastHardSeekAtMs === null || nowMs - lastHardSeekAtMs >= VIDEO_SYNC_HARD_SEEK_COOLDOWN_MS)) return { playbackRate: 1, hardSeek: true, band: 'RECOVERY' }
  // Interpolate continuously at both band edges so Pi 3 players do not jump
  // between rate corrections while their clocks hover near a threshold.
  const correction = magnitude <= VIDEO_SYNC_GENTLE_DRIFT_SECONDS
    ? .02 * (magnitude - VIDEO_SYNC_SETTLED_DRIFT_SECONDS) / (VIDEO_SYNC_GENTLE_DRIFT_SECONDS - VIDEO_SYNC_SETTLED_DRIFT_SECONDS)
    : .02 + .04 * Math.min(1, (magnitude - VIDEO_SYNC_GENTLE_DRIFT_SECONDS) / (VIDEO_SYNC_STRONG_DRIFT_SECONDS - VIDEO_SYNC_GENTLE_DRIFT_SECONDS))
  const band: VideoSyncBand = magnitude <= VIDEO_SYNC_GENTLE_DRIFT_SECONDS ? 'GENTLE' : magnitude <= VIDEO_SYNC_STRONG_DRIFT_SECONDS ? 'STRONG' : 'RECOVERY'
  return { playbackRate: 1 + Math.sign(driftSeconds) * correction, hardSeek: false, band }
}
