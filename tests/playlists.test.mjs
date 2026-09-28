import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  DEFAULT_PLAYLIST_DURATION_SECONDS,
  durationParts,
  durationSecondsFromParts,
  isValidLoadingScene,
  isValidPlaylistDuration,
  movePlaylistItem,
  movePlaylistItemToIndex,
  nextPlaylistPosition,
  playlistsForWall,
  sceneBelongsToPlaylist,
  scenesForWall,
  selectedSceneIdForWall,
  sortPlaylistItems,
} from '../src/lib/playlists.ts'

const playlistA = { id: 'playlist-a', wall_id: 'wall-a', name: 'Morning', loop: true, created_at: '2026-09-28T10:00:00Z', updated_at: '2026-09-28T10:00:00Z' }
const playlistB = { ...playlistA, id: 'playlist-b', wall_id: 'wall-b', name: 'Evening' }
const sceneA = { id: 'scene-a', name: 'Welcome', wall_id: 'wall-a', layers: [], duration_seconds: 60 }
const sceneA2 = { ...sceneA, id: 'scene-a-2', name: 'Information' }
const sceneB = { ...sceneA, id: 'scene-b', wall_id: 'wall-b', name: 'Other wall' }

test('playlist and loading-scene candidates follow the selected wall', () => {
  assert.deepEqual(playlistsForWall([playlistA, playlistB], 'wall-a').map(item => item.id), ['playlist-a'])
  assert.deepEqual(playlistsForWall([playlistA, playlistB], 'wall-b').map(item => item.id), ['playlist-b'])
  assert.deepEqual(scenesForWall([sceneA, sceneA2, sceneB], 'wall-a').map(item => item.id), ['scene-a', 'scene-a-2'])
  assert.deepEqual(scenesForWall([sceneA, sceneA2, sceneB], 'wall-b').map(item => item.id), ['scene-b'])
})

test('same-wall client validation accepts matching scenes and rejects cross-wall scenes', () => {
  assert.equal(sceneBelongsToPlaylist(sceneA, playlistA), true)
  assert.equal(sceneBelongsToPlaylist(sceneB, playlistA), false)
  assert.equal(isValidLoadingScene({ id: 'wall-a', name: 'A' }, null), true)
  assert.equal(isValidLoadingScene({ id: 'wall-a', name: 'A' }, sceneA), true)
  assert.equal(isValidLoadingScene({ id: 'wall-a', name: 'A' }, sceneB), false)
})

test('playlist items sort deterministically and duplicate scenes remain distinct entries', () => {
  const items = [
    { id: 'third', playlist_id: 'playlist-a', scene_id: 'scene-a', position: 2, duration_seconds: 30, created_at: '2026-09-28T10:00:02Z', updated_at: '' },
    { id: 'second', playlist_id: 'playlist-a', scene_id: 'scene-a-2', position: 1, duration_seconds: 60, created_at: '2026-09-28T10:00:01Z', updated_at: '' },
    { id: 'first', playlist_id: 'playlist-a', scene_id: 'scene-a', position: 0, duration_seconds: 30, created_at: '2026-09-28T10:00:00Z', updated_at: '' },
  ]
  assert.deepEqual(sortPlaylistItems(items).map(item => item.id), ['first', 'second', 'third'])
  assert.equal(sortPlaylistItems(items).filter(item => item.scene_id === 'scene-a').length, 2)
  assert.equal(nextPlaylistPosition(items), 3)
  assert.equal(nextPlaylistPosition([]), 0)
})

test('playlist duration contract defaults to 30 and only accepts positive integers', () => {
  assert.equal(DEFAULT_PLAYLIST_DURATION_SECONDS, 30)
  assert.equal(isValidPlaylistDuration(30), true)
  assert.equal(isValidPlaylistDuration(1), true)
  assert.equal(isValidPlaylistDuration(0), false)
  assert.equal(isValidPlaylistDuration(-1), false)
  assert.equal(isValidPlaylistDuration(1.5), false)
})

test('minute and second duration controls normalize positive and long durations', () => {
  assert.deepEqual(durationParts(10), { minutes: 0, seconds: 10 })
  assert.deepEqual(durationParts(90), { minutes: 1, seconds: 30 })
  assert.deepEqual(durationParts(1200), { minutes: 20, seconds: 0 })
  assert.equal(durationSecondsFromParts(1, 30), 90)
  assert.equal(durationSecondsFromParts(0, 90), 90)
  assert.equal(durationSecondsFromParts(20, 0), 1200)
  assert.equal(durationSecondsFromParts(0, 0), null)
  assert.equal(durationSecondsFromParts(1.5, 0), null)
})

test('move controls preserve deterministic positions, boundaries, duplicates, and durations', () => {
  const items = [
    { id: 'first', playlist_id: 'playlist-a', scene_id: 'scene-a', position: 0, duration_seconds: 10, created_at: '1', updated_at: '' },
    { id: 'second', playlist_id: 'playlist-a', scene_id: 'scene-b', position: 1, duration_seconds: 90, created_at: '2', updated_at: '' },
    { id: 'third', playlist_id: 'playlist-a', scene_id: 'scene-a', position: 2, duration_seconds: 1200, created_at: '3', updated_at: '' },
  ]
  assert.deepEqual(movePlaylistItem(items, 'first', -1).map(item => item.id), ['first', 'second', 'third'])
  assert.deepEqual(movePlaylistItem(items, 'third', 1).map(item => item.id), ['first', 'second', 'third'])
  const moved = movePlaylistItem(items, 'third', -1)
  assert.deepEqual(moved.map(item => [item.id, item.position]), [['first', 0], ['third', 1], ['second', 2]])
  assert.equal(moved.find(item => item.id === 'third').duration_seconds, 1200)
  assert.equal(moved.filter(item => item.scene_id === 'scene-a').length, 2)
  assert.deepEqual(movePlaylistItemToIndex(items, 'first', 2).map(item => item.id), ['second', 'third', 'first'])
})

test('wall-scoped scene selection excludes legacy scenes and clears foreign selection', () => {
  const legacy = { ...sceneA, id: 'legacy', wall_id: null }
  assert.deepEqual(scenesForWall([sceneA, sceneB, legacy], 'wall-a').map(scene => scene.id), ['scene-a'])
  assert.equal(selectedSceneIdForWall([sceneA, sceneB, legacy], 'wall-a', 'scene-a'), 'scene-a')
  assert.equal(selectedSceneIdForWall([sceneA, sceneB, legacy], 'wall-b', 'scene-a'), 'scene-b')
  assert.equal(selectedSceneIdForWall([legacy], 'wall-a', 'legacy'), '')
})

test('dashboard scene-card body selection is wired separately from wall state', async () => {
  const source = await readFile(new URL('../src/admin/Admin.tsx', import.meta.url), 'utf8')
  assert.match(source, /function selectPreviewScene\(sceneId: string\)\s*\{\s*setSelectedSceneId\(sceneId\)\s*\}/)
  assert.match(source, /const selectedScene = selectedWallScenes\.find\(\(scene\) => scene\.id === selectedSceneId\) \?\? starterScene/)
  assert.match(source, /const selected = scene\.id === selectedSceneId/)
  assert.match(source, /onClick=\{\(\) => selectPreviewScene\(scene\.id\)\}/)
  assert.match(source, /dashboard-scene-actions" onClick=\{\(event\) => event\.stopPropagation\(\)\}/)
  assert.match(source, /wall_state[\s\S]*setLiveSceneId/)
  assert.match(source, /<ScenePreview key=\{selectedScene\.id\} scene=\{selectedScene\}/)
})

test('migration encodes playlist defaults, same-wall guards, and safe scene deletion', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260928130000_playlist_foundation.sql', import.meta.url), 'utf8')
  assert.match(sql, /loop boolean not null default true/i)
  assert.match(sql, /duration_seconds integer not null default 30 check \(duration_seconds > 0\)/i)
  assert.match(sql, /unique \(playlist_id, position\)/i)
  assert.doesNotMatch(sql, /unique \(playlist_id, scene_id\)/i)
  assert.match(sql, /scene_id uuid not null references public\.scenes\(id\) on delete cascade/i)
  assert.match(sql, /loading_scene_id uuid references public\.scenes\(id\) on delete set null/i)
  assert.match(sql, /playlist_items_same_wall/i)
  assert.match(sql, /walls_loading_scene_same_wall/i)
  assert.match(sql, /scenes_same_wall_after_wall_change/i)
  assert.match(sql, /enable row level security/i)
  assert.match(sql, /to authenticated/i)
})

test('empty playlists are valid in the normalized schema', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260928130000_playlist_foundation.sql', import.meta.url), 'utf8')
  assert.match(sql, /playlist_id uuid not null references public\.playlists\(id\) on delete cascade/i)
  assert.doesNotMatch(sql, /playlist_items_count|minimum_items|items_required/i)
})

test('PLAYLIST-02 migrates loading scenes to playlists and retires the wall field', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260928140000_playlist_editor_refinement.sql', import.meta.url), 'utf8')
  assert.match(sql, /alter table public\.playlists\s+add column loading_scene_id uuid references public\.scenes\(id\) on delete set null/i)
  assert.match(sql, /update public\.playlists playlist[\s\S]*set loading_scene_id = wall\.loading_scene_id[\s\S]*scene\.wall_id = wall\.id/i)
  assert.match(sql, /playlists_loading_scene_same_wall/i)
  assert.match(sql, /playlist\.loading_scene_id = new\.id/i)
  assert.match(sql, /drop trigger if exists walls_loading_scene_same_wall/i)
  assert.match(sql, /alter table public\.walls drop column loading_scene_id/i)
})

test('reorder RPC validates the complete item set and persists collision-safe positions', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260928140000_playlist_editor_refinement.sql', import.meta.url), 'utf8')
  assert.match(sql, /reorder_playlist_items\(requested_playlist_id uuid, ordered_item_ids uuid\[\]\)/i)
  assert.match(sql, /for update/i)
  assert.match(sql, /set position = position \+ temporary_offset/i)
  assert.match(sql, /set position = ordering\.ordinality::integer - 1/i)
  assert.match(sql, /every playlist item exactly once/i)
})

test('dashboard selection is preview-only and both activation entry points use Go live', async () => {
  const source = await readFile(new URL('../src/admin/Admin.tsx', import.meta.url), 'utf8')
  assert.match(source, /dashboard-scene-card[\s\S]*onClick=\{\(\) => selectPreviewScene\(scene\.id\)\}/)
  assert.equal((source.match(/onClick=\{\(\) => void goLive\(/g) ?? []).length, 2)
  assert.equal((source.match(/>Go live<\/button>/g) ?? []).length, 2)
  assert.doesNotMatch(source, /Publish to wall|Publishing will replace/)
})
