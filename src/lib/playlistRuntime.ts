import type { PlaylistRuntime, Scene } from '../types'

export const PLAYLIST_TRANSITION_TIMEOUT_MS = 15_000

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
    const done = (error?: Error) => { video.removeAttribute('src'); video.load(); error ? reject(error) : resolve() }
    video.preload = 'metadata'; video.muted = true
    video.addEventListener('loadedmetadata', () => done(), { once: true })
    video.addEventListener('error', () => done(new Error('video-metadata-failed')), { once: true })
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
