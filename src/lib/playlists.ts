import type { Playlist, PlaylistItem, Scene, Wall } from '../types'

export const DEFAULT_PLAYLIST_DURATION_SECONDS = 30

export function playlistsForWall(playlists: readonly Playlist[], wallId: string) {
  return playlists.filter(playlist => playlist.wall_id === wallId)
}

export function scenesForWall(scenes: readonly Scene[], wallId: string) {
  return scenes.filter(scene => scene.wall_id === wallId)
}

export function sortPlaylistItems(items: readonly PlaylistItem[]) {
  return [...items].sort((left, right) => left.position - right.position || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
}

export function nextPlaylistPosition(items: readonly PlaylistItem[]) {
  return items.length ? Math.max(...items.map(item => item.position)) + 1 : 0
}

export function isValidPlaylistDuration(value: number) {
  return Number.isInteger(value) && value > 0
}

export function durationParts(durationSeconds: number) {
  const safeDuration = isValidPlaylistDuration(durationSeconds) ? durationSeconds : DEFAULT_PLAYLIST_DURATION_SECONDS
  return { minutes: Math.floor(safeDuration / 60), seconds: safeDuration % 60 }
}

export function durationSecondsFromParts(minutes: number, seconds: number) {
  if (!Number.isInteger(minutes) || !Number.isInteger(seconds) || minutes < 0 || seconds < 0) return null
  const total = minutes * 60 + seconds
  return isValidPlaylistDuration(total) ? total : null
}

export function movePlaylistItemToIndex(items: readonly PlaylistItem[], itemId: string, requestedIndex: number) {
  const ordered = sortPlaylistItems(items)
  const currentIndex = ordered.findIndex(item => item.id === itemId)
  if (currentIndex < 0 || !ordered.length) return ordered
  const targetIndex = Math.max(0, Math.min(ordered.length - 1, requestedIndex))
  if (targetIndex === currentIndex) return ordered
  const [moved] = ordered.splice(currentIndex, 1)
  ordered.splice(targetIndex, 0, moved)
  return ordered.map((item, position) => ({ ...item, position }))
}

export function movePlaylistItem(items: readonly PlaylistItem[], itemId: string, direction: -1 | 1) {
  const ordered = sortPlaylistItems(items)
  const currentIndex = ordered.findIndex(item => item.id === itemId)
  return currentIndex < 0 ? ordered : movePlaylistItemToIndex(ordered, itemId, currentIndex + direction)
}

export function selectedSceneIdForWall(scenes: readonly Scene[], wallId: string, selectedSceneId: string) {
  const wallScenes = scenesForWall(scenes, wallId)
  return wallScenes.some(scene => scene.id === selectedSceneId) ? selectedSceneId : wallScenes[0]?.id ?? ''
}

export function sceneBelongsToPlaylist(scene: Scene, playlist: Playlist) {
  return Boolean(scene.wall_id && scene.wall_id === playlist.wall_id)
}

export function isValidLoadingScene(wall: Wall, scene: Scene | null) {
  return scene === null || scene.wall_id === wall.id
}
