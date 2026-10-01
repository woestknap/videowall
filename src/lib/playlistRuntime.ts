import type { PlaylistRuntime, Scene } from '../types'

export const PLAYLIST_TRANSITION_TIMEOUT_MS = 15_000
export const PLAYLIST_ACTIVATION_LEAD_MS = 2_000
export const PLAYLIST_LOADING_LEAD_MS = 1_500
export const PLAYLIST_NORMAL_POLL_MS = 4_000
export const PLAYLIST_TRANSITION_POLL_MS = 400
export const PLAYLIST_FADE_MS = 350

export type PlaylistTimingDiagnostics = { loaderSkewMs?: number; activationSkewMs?: number; clockRoundTripMs?: number; pollRoundTripMs?: number }

/** The presentation timestamp is already expressed in the calibrated server-time basis. */
export function playlistPresentationSkewMs(actualServerNowMs: number, intendedServerAtMs: number) {
  if (!Number.isFinite(actualServerNowMs) || !Number.isFinite(intendedServerAtMs)) return null
  return Math.round(actualServerNowMs - intendedServerAtMs)
}

export type PlaylistLoadingOverlayState = { mounted: boolean; opacity: number; phase: 'HIDDEN' | 'WAITING' | 'FADING_IN' | 'VISIBLE' | 'FADING_OUT'; nextAtMs: number | null; animate: boolean }

export function playlistLoadingOverlayState(runtime: PlaylistRuntime | null, serverNowMs: number, reducedMotion = false): PlaylistLoadingOverlayState {
  if (!runtime || runtime.status === 'STOPPED' || !runtime.loading_at) return { mounted: false, opacity: 0, phase: 'HIDDEN', nextAtMs: null, animate: false }
  const loadingAt = Date.parse(runtime.loading_at)
  const activationAt = runtime.activation_at ? Date.parse(runtime.activation_at) : NaN
  if (!Number.isFinite(loadingAt)) return { mounted: false, opacity: 0, phase: 'HIDDEN', nextAtMs: null, animate: false }
  const transitionActive = runtime.phase === 'PREPARING' || runtime.phase === 'ARMED'
  const fadingAfterActivation = runtime.phase === 'DISPLAYING' && Number.isFinite(activationAt) && serverNowMs < activationAt + (reducedMotion ? 0 : PLAYLIST_FADE_MS)
  if (!transitionActive && !fadingAfterActivation) return { mounted: false, opacity: 0, phase: 'HIDDEN', nextAtMs: null, animate: false }
  if (serverNowMs < loadingAt) return { mounted: true, opacity: 0, phase: 'WAITING', nextAtMs: loadingAt, animate: false }
  if (reducedMotion) {
    if (Number.isFinite(activationAt) && serverNowMs >= activationAt) return { mounted: false, opacity: 0, phase: 'HIDDEN', nextAtMs: null, animate: false }
    return { mounted: true, opacity: 1, phase: 'VISIBLE', nextAtMs: Number.isFinite(activationAt) ? activationAt : null, animate: false }
  }
  const fadeInEnds = loadingAt + PLAYLIST_FADE_MS
  if (serverNowMs < fadeInEnds) return { mounted: true, opacity: Math.max(0, Math.min(1, (serverNowMs - loadingAt) / PLAYLIST_FADE_MS)), phase: 'FADING_IN', nextAtMs: fadeInEnds, animate: true }
  if (!Number.isFinite(activationAt) || serverNowMs < activationAt) return { mounted: true, opacity: 1, phase: 'VISIBLE', nextAtMs: Number.isFinite(activationAt) ? activationAt : null, animate: false }
  const fadeOutEnds = activationAt + PLAYLIST_FADE_MS
  if (serverNowMs < fadeOutEnds) return { mounted: true, opacity: Math.max(0, Math.min(1, 1 - (serverNowMs - activationAt) / PLAYLIST_FADE_MS)), phase: 'FADING_OUT', nextAtMs: fadeOutEnds, animate: true }
  return { mounted: false, opacity: 0, phase: 'HIDDEN', nextAtMs: null, animate: false }
}

export function playlistPollIntervalMs(runtime: PlaylistRuntime | null) {
  return runtime && (runtime.phase === 'PREPARING' || runtime.phase === 'ARMED') ? PLAYLIST_TRANSITION_POLL_MS : PLAYLIST_NORMAL_POLL_MS
}

export function playlistActivationRemainingMs(runtime: PlaylistRuntime | null, serverNowMs: number) {
  if (!runtime || runtime.phase !== 'ARMED' || !runtime.activation_at) return null
  const activationAt = Date.parse(runtime.activation_at)
  return Number.isFinite(activationAt) ? Math.max(0, activationAt - serverNowMs) : null
}

export function formatPlaylistActivationRemaining(milliseconds: number | null) {
  return milliseconds === null ? '—' : `00:${(milliseconds / 1000).toFixed(1).padStart(4, '0')}`
}

export function playlistRemainingMs(runtime: PlaylistRuntime | null, nowMs = Date.now()) {
  if (!runtime || runtime.status === 'STOPPED') return null
  if (runtime.status === 'PAUSED') return Math.max(0, runtime.paused_remaining_ms ?? 0)
  if (runtime.phase !== 'DISPLAYING' || !runtime.next_transition_at) return null
  const deadline = Date.parse(runtime.next_transition_at)
  return Number.isFinite(deadline) ? Math.max(0, deadline - nowMs) : null
}

export function formatPlaylistRemaining(milliseconds: number | null) {
  if (milliseconds === null) return '—'
  const seconds = Math.ceil(milliseconds / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export function playlistRuntimeLabel(runtime: PlaylistRuntime | null) {
  if (!runtime) return 'STOPPED'
  if (runtime.phase === 'PREPARING') return runtime.status === 'PAUSED' ? 'PAUSED · PREPARING' : 'PREPARING'
  if (runtime.phase === 'ARMED') return runtime.status === 'PAUSED' ? 'PAUSED · ARMED' : 'ARMED'
  return runtime.status
}

function waitForImage(url: string) {
  return new Promise<void>((resolve, reject) => {
    const image = new Image()
    image.onload = () => { image.decode?.().catch(() => undefined).finally(resolve) }
    image.onerror = () => reject(new Error('image-load-failed'))
    image.src = url
  })
}

function waitForVideo(url: string) {
  return new Promise<void>((resolve, reject) => {
    const video = document.createElement('video')
    let settled = false
    const done = (error?: Error) => { if (settled) return; settled = true; video.removeEventListener('loadeddata', ready); video.removeEventListener('error', failed); video.removeAttribute('src'); video.load(); error ? reject(error) : resolve() }
    const ready = () => { if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) done() }
    const failed = () => done(new Error('video-first-frame-failed'))
    video.preload = 'auto'; video.muted = true; video.playsInline = true
    video.addEventListener('loadeddata', ready)
    video.addEventListener('error', failed)
    video.src = url; video.load()
  })
}

/** Prepares static media without mounting or playing hidden scene runtimes. */
export async function preparePlaylistScene(scene: Scene, videosDisabled = false) {
  const tasks = scene.layers.flatMap(layer => {
    const url = layer.content.url?.trim()
    if (!url || layer.type === 'live') return []
    if (layer.type === 'image') return [waitForImage(url)]
    if (layer.type === 'video' && !videosDisabled) return [waitForVideo(url)]
    return []
  })
  await Promise.all(tasks)
}
