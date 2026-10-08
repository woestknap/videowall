import type { ManualSceneRuntime } from '../types'
import { PLAYLIST_NORMAL_POLL_MS, PLAYLIST_TRANSITION_POLL_MS } from './playlistRuntime.ts'

export function manualScenePollIntervalMs(runtime: ManualSceneRuntime | null) {
  return runtime ? PLAYLIST_TRANSITION_POLL_MS : PLAYLIST_NORMAL_POLL_MS
}

export function manualSceneActivationRemainingMs(runtime: ManualSceneRuntime | null, serverNowMs: number) {
  if (!runtime || runtime.status !== 'ARMED' || !runtime.activation_at) return null
  const activationAt = Date.parse(runtime.activation_at)
  return Number.isFinite(activationAt) ? Math.max(0, activationAt - serverNowMs) : null
}

export function manualSceneIsReadyForActivation(runtime: ManualSceneRuntime | null, sceneId: string) {
  return runtime?.target_scene_id === sceneId && runtime.status === 'READY'
}
