import type { PlaylistRuntime, Scene } from '../types'

export const PLAYLIST_TRANSITION_TIMEOUT_MS = 15_000
export const PLAYLIST_ACTIVATION_LEAD_MS = 1_500
export const PLAYLIST_NORMAL_POLL_MS = 4_000
export const PLAYLIST_TRANSITION_POLL_MS = 400
export const PLAYLIST_FADE_MS = 350

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
